/**
 * Message contracts between the extension contexts:
 *   popup / side panel  --ContentCommand-->     content script (Teams tab)
 *   content script      --BackgroundRequest-->  background service worker (owns writes to IndexedDB)
 * Every handler answers with a Response envelope.
 */
import type { DiagnosticsReport } from '../extractor/diagnostics';
import type { EngineProgress, EngineResult } from '../scraper/engine';
import type {
  CapturedImage,
  ConversationIdentity,
  ConversationRecord,
  CoverageRange,
  ExtractedMessage,
  IdentityEvidence,
  ImageSaveStatus,
  ResolutionReason,
  ScrapeMode,
  SessionCounters,
  SessionStatus,
  StopReason,
  UpsertStatus,
} from './types';

export type Response<T> = { ok: true; data: T } | { ok: false; error: string };

/** Sessions without a heartbeat for this long are considered interrupted. */
export const STALE_SESSION_MS = 90_000;
export const HEARTBEAT_INTERVAL_MS = 15_000;

export const TEAMS_URL_PATTERN = /^https:\/\/(teams\.microsoft\.com|teams\.cloud\.microsoft|teams\.live\.com)\//;

// ------------------------------------------------------------- background

export type BackgroundRequest =
  | {
      type: 'session/begin';
      /** The conversation as detected in Teams. */
      conversation: ConversationIdentity;
      /** Messages shown in the chat, to find its archive entry when Teams shows no chat id. */
      evidence?: IdentityEvidence | null;
      mode: ScrapeMode;
      rescan: boolean;
      resumeOf: string | null;
    }
  | {
      type: 'session/batch';
      sessionId: string;
      conversation: ConversationIdentity;
      messages: ExtractedMessage[];
      segments: CoverageRange[];
      counters: SessionCounters;
      warnings: string[];
    }
  /** Images displayed in the next batch's messages, sent (and stored) before that batch. */
  | { type: 'session/images'; sessionId: string; conversationKey: string; images: CapturedImage[] }
  /** One part of an image too large for a single message (see IMAGE_REQUEST_CHARS). */
  | {
      type: 'session/image-part';
      sessionId: string;
      conversationKey: string;
      image: CapturedImageInfo;
      /** 0-based part number; parts are sent in order. */
      index: number;
      count: number;
      dataBase64: string;
    }
  | { type: 'session/heartbeat'; sessionId: string; status: 'running' | 'paused'; counters: SessionCounters }
  | {
      type: 'session/end';
      sessionId: string;
      conversationKey: string;
      status: SessionStatus;
      stopReason: StopReason;
      error: string | null;
      counters: SessionCounters;
      segments: CoverageRange[];
      warnings: string[];
    };

export interface SessionBeginResponse {
  sessionId: string;
  /**
   * Key of the archive entry the session writes to. Differs from the detected key when the chat
   * was renamed, or has the title of another archived chat; messages are keyed with it.
   */
  conversationKey: string;
  /** How the entry was chosen. */
  resolution: ResolutionReason;
  coverage: CoverageRange[];
  conversation: ConversationRecord | null;
  /** Other archive entries holding messages of this chat: candidates for merging. */
  alsoMatching: string[];
}

export interface SessionBatchResponse {
  statuses: Record<string, UpsertStatus>;
}

/** A captured image without its bytes. */
export type CapturedImageInfo = Omit<CapturedImage, 'dataBase64'>;

/**
 * Most base64 characters sent in one image request. Extension messages are JSON and limited to
 * 64 MiB, so larger images (above 12 MiB of bytes) are sent in parts of this size.
 */
export const IMAGE_REQUEST_CHARS = 16 * 1024 * 1024;

export interface SessionImagesResponse {
  /** Per image id: newly stored or already archived. */
  statuses: Record<string, ImageSaveStatus>;
  /** Per image id: why the image was refused (it is not stored). */
  rejected: Record<string, string>;
}

export interface SessionImagePartResponse {
  /** `partial`: send the next part; `restart`: the upload was lost, start again with part 0. */
  status: 'partial' | 'restart' | ImageSaveStatus | 'rejected';
  reason?: string;
}

export interface SessionEndResponse {
  replies: { resolved: number; unresolved: number };
}

const BACKGROUND_TYPES = new Set(['session/begin', 'session/batch', 'session/images', 'session/image-part', 'session/heartbeat', 'session/end']);

export function isBackgroundRequest(value: unknown): value is BackgroundRequest {
  return !!value && typeof value === 'object' && BACKGROUND_TYPES.has((value as { type?: unknown }).type as string);
}

// ---------------------------------------------------------- content script

export type ContentCommand =
  | { type: 'content/status' }
  | { type: 'content/start'; mode: ScrapeMode; rescan: boolean; resumeOf: string | null }
  | { type: 'content/pause' }
  | { type: 'content/resume' }
  | { type: 'content/stop' }
  | { type: 'content/diagnostics' };

const CONTENT_TYPES = new Set(['content/status', 'content/start', 'content/pause', 'content/resume', 'content/stop', 'content/diagnostics']);

export function isContentCommand(value: unknown): value is ContentCommand {
  return !!value && typeof value === 'object' && CONTENT_TYPES.has((value as { type?: unknown }).type as string);
}

export interface ActiveSessionInfo {
  sessionId: string;
  mode: ScrapeMode;
  rescan: boolean;
  startedAt: string;
  conversation: ConversationIdentity;
}

export interface FinishedSessionInfo extends EngineResult {
  sessionId: string;
  mode: ScrapeMode;
  conversationKey: string;
  endedAt: string;
}

export interface ContentStatus {
  state: 'idle' | 'running' | 'paused' | 'stopping';
  /** While idle the conversation as detected; while running the one the session writes to. */
  conversation: ConversationIdentity | null;
  conversationError: string | null;
  /** Messages currently rendered (only computed while idle). */
  visibleMessages: number | null;
  /** Messages shown, to find the chat's archive entry (only computed while idle). */
  evidence?: IdentityEvidence | null;
  session: ActiveSessionInfo | null;
  progress: EngineProgress | null;
  lastResult: FinishedSessionInfo | null;
}

export type ContentCommandResult = ContentStatus | { sessionId: string } | { accepted: boolean } | DiagnosticsReport;
