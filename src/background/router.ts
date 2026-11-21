/**
 * Handles requests from content scripts. Kept free of Chrome APIs so it can be tested
 * end-to-end against a real (fake-indexeddb backed) repository.
 */
import { updateAnchor, updateStart } from '../shared/capture';
import { imageMetadataError, MAX_IMAGE_BYTES } from '../shared/images';
import {
  MAX_ARCHIVED_IMAGE_KEYS,
  type BackgroundRequest,
  type CapturedImageInfo,
  type SessionArchivedImagesResponse,
  type SessionBatchResponse,
  type SessionBeginResponse,
  type SessionEndResponse,
  type SessionImagePartResponse,
  type SessionImagesResponse,
} from '../shared/protocol';
import { DEFAULT_SETTINGS } from '../shared/settings';
import { EXTRACTOR_VERSION, emptyCounters, type SessionRecord } from '../shared/types';
import { saveCapturedImages } from '../storage/images';
import type { ArchiveRepository } from '../storage/repository';

export interface RouterDeps {
  getRepository: () => Promise<ArchiveRepository>;
  now: () => Date;
  newId: () => string;
  staleSessionMs: number;
  /** Parts of large images being received; defaults to one buffer per worker. */
  imageUploads?: ImageUploads;
  /** Largest image accepted (bytes); defaults to and is capped at MAX_IMAGE_BYTES. */
  maxImageBytes?: number;
}

export interface RequestContext {
  /** Tab the request came from (null for extension pages). */
  tabId: number | null;
}

const MAX_SESSION_WARNINGS = 50;

interface PendingUpload {
  info: string;
  count: number;
  parts: string[];
  chars: number;
  touchedAt: number;
}

export type UploadOutcome =
  | { status: 'partial' }
  | { status: 'restart' }
  | { status: 'rejected'; reason: string }
  | { status: 'complete'; dataBase64: string };

/**
 * Parts of images too large for one extension message, kept in memory until the last part
 * arrives. If the worker restarts in between, the next part gets `restart` and the tab sends
 * the image again from the first part.
 */
export class ImageUploads {
  private readonly uploads = new Map<string, PendingUpload>();

  constructor(
    private readonly ttlMs = 120_000,
    private readonly maxUploads = 4,
  ) {}

  get size(): number {
    return this.uploads.size;
  }

  add(key: string, part: { info: CapturedImageInfo; index: number; count: number; dataBase64: string }, nowMs: number, maxChars: number): UploadOutcome {
    for (const [pendingKey, upload] of this.uploads) {
      if (nowMs - upload.touchedAt > this.ttlMs) this.uploads.delete(pendingKey);
    }
    const info = JSON.stringify(part.info);
    if (part.index === 0) {
      this.uploads.delete(key);
      while (this.uploads.size >= this.maxUploads) this.uploads.delete(this.uploads.keys().next().value as string);
      this.uploads.set(key, { info, count: part.count, parts: [], chars: 0, touchedAt: nowMs });
    }
    const upload = this.uploads.get(key);
    if (!upload || upload.info !== info || upload.count !== part.count || upload.parts.length !== part.index) {
      this.uploads.delete(key);
      return { status: 'restart' };
    }
    upload.chars += part.dataBase64.length;
    if (upload.chars > maxChars) {
      this.uploads.delete(key);
      return { status: 'rejected', reason: 'the image is larger than its stated size' };
    }
    upload.parts.push(part.dataBase64);
    upload.touchedAt = nowMs;
    if (upload.parts.length < upload.count) return { status: 'partial' };
    this.uploads.delete(key);
    return { status: 'complete', dataBase64: upload.parts.join('') };
  }
}

const defaultUploads = new ImageUploads();

function requireString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`Invalid request: ${name} is required`);
  return value;
}

function requireArray<T>(value: unknown, name: string): T[] {
  if (!Array.isArray(value)) throw new Error(`Invalid request: ${name} must be an array`);
  return value as T[];
}

/** A message time (epoch ms) from a request, or null. */
function optionalTime(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** The session an image request belongs to; it must exist and be for the same conversation. */
async function requireSession(repository: ArchiveRepository, sessionId: unknown, conversationKey: unknown): Promise<SessionRecord> {
  const id = requireString(sessionId, 'sessionId');
  const session = await repository.getSession(id);
  if (!session) throw new Error(`Unknown session ${id}`);
  if (session.conversationKey !== conversationKey) throw new Error('Image conversation does not match the session conversation');
  return session;
}

export async function handleBackgroundRequest(
  request: BackgroundRequest,
  context: RequestContext,
  deps: RouterDeps,
): Promise<
  SessionBeginResponse | SessionBatchResponse | SessionImagesResponse | SessionImagePartResponse | SessionArchivedImagesResponse | SessionEndResponse | { recorded: boolean }
> {
  const repository = await deps.getRepository();
  const now = deps.now();
  const nowIso = now.toISOString();
  const maxImageBytes = Math.min(deps.maxImageBytes ?? MAX_IMAGE_BYTES, MAX_IMAGE_BYTES);

  switch (request.type) {
    case 'session/begin': {
      const detectedKey = requireString(request.conversation?.conversationKey, 'conversation.conversationKey');
      await repository.markStaleSessions(now.getTime(), deps.staleSessionMs);
      // A new session from a tab means any earlier session of that tab is no longer running.
      if (context.tabId !== null) await repository.markStaleSessions(now.getTime(), 0, context.tabId);
      // The archive entry of this chat, which can have another key (a renamed chat), or a new
      // one (a different chat with the title of an archived one).
      const resolution = await repository.resolveConversation(request.conversation, request.evidence ?? null);
      const conversationKey = resolution.conversationKey ?? `local:${deps.newId()}`;
      const conversation = resolution.record;
      // A full run with a range stops at its start; an update re-reads the overlap window
      // before the point the archive was last brought up to date.
      const continuesFrom = updateAnchor(conversation);
      const overlapDays = typeof request.updateOverlapDays === 'number' ? request.updateOverlapDays : DEFAULT_SETTINGS.updateOverlapDays;
      const captureFrom =
        request.mode === 'full' ? optionalTime(request.rangeStart) : request.mode === 'incremental' ? updateStart(continuesFrom, overlapDays) : null;
      const session: SessionRecord = {
        sessionId: deps.newId(),
        conversationKey,
        detectedKey: conversationKey === detectedKey ? null : detectedKey,
        conversationTitle: request.conversation.title,
        mode: request.mode,
        rescan: Boolean(request.rescan),
        status: 'running',
        stopReason: null,
        error: null,
        resumeOf: request.resumeOf ?? null,
        captureFrom,
        continuesFrom,
        tabId: context.tabId,
        startedAt: nowIso,
        updatedAt: nowIso,
        endedAt: null,
        counters: emptyCounters(),
        warnings: [],
        extractorVersion: EXTRACTOR_VERSION,
      };
      await repository.createSession(session);
      return {
        sessionId: session.sessionId,
        conversationKey,
        resolution: resolution.reason,
        coverage: conversation?.coverage ?? [],
        conversation,
        alsoMatching: resolution.alsoMatching,
        captureFrom,
        continuesFrom,
      } satisfies SessionBeginResponse;
    }

    case 'session/batch': {
      const sessionId = requireString(request.sessionId, 'sessionId');
      const messages = requireArray(request.messages, 'messages');
      const session = await repository.getSession(sessionId);
      if (!session) throw new Error(`Unknown session ${sessionId}`);
      if (session.conversationKey !== request.conversation?.conversationKey) {
        throw new Error('Batch conversation does not match the session conversation');
      }
      const result = await repository.upsertObservations({
        conversation: request.conversation,
        messages: messages as never,
        sessionId,
        segments: requireArray(request.segments ?? [], 'segments'),
        // The key detected in Teams finds this entry again next time.
        aliases: session.detectedKey ? [session.detectedKey] : [],
        now,
      });
      // A session wrongly marked as interrupted (e.g. after the computer slept) is revived here;
      // one that its tab already reported as ended keeps its final status.
      await repository.updateSession(
        sessionId,
        {
          status: 'running',
          stopReason: null,
          endedAt: null,
          updatedAt: nowIso,
          counters: request.counters,
          warnings: (request.warnings ?? []).slice(0, MAX_SESSION_WARNINGS),
        },
        { skipIfEnded: true },
      );
      return { statuses: result.statuses };
    }

    case 'session/images': {
      const session = await requireSession(repository, request.sessionId, request.conversationKey);
      const images = requireArray(request.images, 'images');
      return saveCapturedImages(repository, session.conversationKey, images, { sessionId: session.sessionId, nowIso, maxBytes: maxImageBytes });
    }

    case 'session/image-part': {
      const session = await requireSession(repository, request.sessionId, request.conversationKey);
      const { index, count, dataBase64 } = request;
      if (!Number.isInteger(index) || !Number.isInteger(count) || index < 0 || count < 1 || index >= count || typeof dataBase64 !== 'string') {
        throw new Error('Invalid request: index, count and dataBase64 do not describe an image part');
      }
      const info = (request.image && typeof request.image === 'object' ? request.image : {}) as CapturedImageInfo;
      const problem = imageMetadataError({ ...info, dataBase64: '' }, maxImageBytes);
      if (problem) return { status: 'rejected', reason: problem } satisfies SessionImagePartResponse;
      const maxChars = 4 * Math.ceil(maxImageBytes / 3);
      const uploads = deps.imageUploads ?? defaultUploads;
      const outcome = uploads.add(`${session.sessionId}|${info.imageId}`, { info, index, count, dataBase64 }, now.getTime(), maxChars);
      if (outcome.status !== 'complete') return outcome satisfies SessionImagePartResponse;
      const saved = await saveCapturedImages(repository, session.conversationKey, [{ ...info, dataBase64: outcome.dataBase64 }], {
        sessionId: session.sessionId,
        nowIso,
        maxBytes: maxImageBytes,
      });
      const reason = Object.values(saved.rejected)[0];
      if (reason !== undefined) return { status: 'rejected', reason } satisfies SessionImagePartResponse;
      return { status: saved.statuses[info.imageId] ?? 'inserted' } satisfies SessionImagePartResponse;
    }

    case 'session/archived-images': {
      const session = await requireSession(repository, request.sessionId, request.conversationKey);
      const keys = requireArray<unknown>(request.keys, 'keys')
        .filter((key): key is string => typeof key === 'string')
        .slice(0, MAX_ARCHIVED_IMAGE_KEYS);
      return { messages: await repository.archivedImages(session.conversationKey, keys) } satisfies SessionArchivedImagesResponse;
    }

    case 'session/heartbeat': {
      const sessionId = requireString(request.sessionId, 'sessionId');
      // A heartbeat still in flight when the session ended must not reopen it.
      const updated = await repository.updateSession(
        sessionId,
        {
          status: request.status === 'paused' ? 'paused' : 'running',
          stopReason: null,
          endedAt: null,
          updatedAt: nowIso,
          counters: request.counters,
        },
        { skipIfEnded: true },
      );
      return { recorded: updated !== null };
    }

    case 'session/end': {
      const sessionId = requireString(request.sessionId, 'sessionId');
      const conversationKey = requireString(request.conversationKey, 'conversationKey');
      const segments = requireArray(request.segments ?? [], 'segments');
      if (segments.length > 0) await repository.mergeCoverage(conversationKey, segments as never);
      const replies = await repository.resolveReplies(conversationKey);
      // Sessions begun before 1.3 did not note where the archive was up to date: they are not counted.
      const session = await repository.getSession(sessionId);
      if (session && session.conversationKey === conversationKey && session.continuesFrom !== undefined) {
        await repository.recordRunEnd(conversationKey, {
          sessionId,
          mode: session.mode,
          at: nowIso,
          newestSortKey: optionalTime(request.counters?.newestSortKey),
          continuesFrom: session.continuesFrom,
        });
      }
      await repository.updateSession(sessionId, {
        status: request.status,
        stopReason: request.stopReason,
        error: request.error,
        counters: request.counters,
        warnings: (request.warnings ?? []).slice(0, MAX_SESSION_WARNINGS),
        updatedAt: nowIso,
        endedAt: nowIso,
      });
      return { replies };
    }

    default:
      throw new Error(`Unknown request type ${(request as { type?: string }).type}`);
  }
}
