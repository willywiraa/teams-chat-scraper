import { IDBFactory } from 'fake-indexeddb';
import { detectConversation } from '../../src/extractor/conversation';
import { buildSelectorProfile, type SelectorProfile } from '../../src/extractor/selectors';
import { ScrapeControl } from '../../src/scraper/control';
import { runScrape, type EngineOptions, type EngineResult, type EngineSink } from '../../src/scraper/engine';
import type { ImageReader } from '../../src/scraper/images';
import { DEFAULT_SETTINGS, type ScrapeSettings } from '../../src/shared/settings';
import type { ConversationIdentity, CoverageRange, ExtractedMessage, ScrapeMode } from '../../src/shared/types';
import { saveCapturedImages } from '../../src/storage/images';
import { ArchiveRepository } from '../../src/storage/repository';

export const TEAMS_URL = 'https://teams.microsoft.com/v2/';

/** Settings with tiny delays so integration tests run in milliseconds per step. */
export function fastSettings(overrides: Partial<ScrapeSettings> = {}): ScrapeSettings {
  return {
    ...DEFAULT_SETTINGS,
    scrollIntervalMs: 0,
    seekIntervalMs: 0,
    scrollAnimationMs: 0,
    settleQuietMs: 8,
    settleTimeoutMs: 200,
    topLoadTimeoutMs: 60,
    maxNoProgressPasses: 2,
    maxStallPasses: 30,
    pauseWhenHidden: false,
    ...overrides,
  };
}

export async function openTestRepository(): Promise<ArchiveRepository> {
  return ArchiveRepository.open(new IDBFactory(), `test-${Math.random().toString(36).slice(2)}`);
}

export function profile(): SelectorProfile {
  return buildSelectorProfile();
}

export function detect(): ConversationIdentity {
  const conversation = detectConversation(document, TEAMS_URL, profile());
  if (!conversation) throw new Error('conversation not detected in fixture');
  return conversation;
}

export function repositorySink(
  repository: ArchiveRepository,
  conversation: ConversationIdentity,
  sessionId: string,
): EngineSink & { batches: ExtractedMessage[][]; imageBatches: string[][] } {
  const batches: ExtractedMessage[][] = [];
  const imageBatches: string[][] = [];
  return {
    batches,
    imageBatches,
    write: async (batch) => {
      batches.push(batch.messages);
      const result = await repository.upsertObservations({ conversation, messages: structuredClone(batch.messages), sessionId, segments: batch.segments });
      return result.statuses;
    },
    // What the background does with a `session/images` request.
    saveImages: async (images) => {
      imageBatches.push(images.map((image) => image.imageId));
      const result = await saveCapturedImages(repository, conversation.conversationKey, structuredClone(images), { sessionId, nowIso: new Date().toISOString() });
      return { saved: Object.keys(result.statuses), rejected: result.rejected };
    },
    // What the background answers to a `session/archived-images` request.
    archivedImages: (keys) => repository.archivedImages(conversation.conversationKey, keys),
  };
}

export interface RunOptions {
  repository: ArchiveRepository;
  mode: ScrapeMode;
  settings?: Partial<ScrapeSettings>;
  rescan?: boolean;
  /** Oldest message time the run has to reach (see EngineOptions.since). */
  since?: number | null;
  coverage?: CoverageRange[];
  control?: ScrapeControl;
  sink?: EngineSink;
  sessionId?: string;
  onProgress?: EngineOptions['onProgress'];
  imageReader?: ImageReader;
  /** The run's clock (Date.now by default). */
  now?: () => number;
}

/**
 * Runs the engine against the current document, persisting into the repository. Like the
 * background worker at the end of a session, it then merges the final coverage and resolves replies.
 */
export async function runEngine(options: RunOptions): Promise<EngineResult> {
  const conversation = detect();
  const sessionId = options.sessionId ?? `session-${Math.random().toString(36).slice(2)}`;
  const coverage = options.coverage ?? (await options.repository.getConversation(conversation.conversationKey))?.coverage ?? [];
  const result = await runScrape({
    doc: document,
    profile: profile(),
    settings: fastSettings(options.settings),
    mode: options.mode,
    rescan: options.rescan,
    since: options.since,
    conversation,
    coverage,
    sink: options.sink ?? repositorySink(options.repository, conversation, sessionId),
    control: options.control ?? new ScrapeControl(),
    dateOrder: 'MDY',
    selfDisplayName: null,
    detectConversation: () => detectConversation(document, TEAMS_URL, profile()),
    onProgress: options.onProgress,
    imageReader: options.imageReader,
    now: options.now,
  });
  if (result.segments.length > 0) await options.repository.mergeCoverage(conversation.conversationKey, result.segments);
  await options.repository.resolveReplies(conversation.conversationKey);
  return result;
}

/** Waits until `condition` holds (polling), failing after `timeoutMs`. */
export async function waitFor(condition: () => boolean, timeoutMs = 10_000, label = 'condition'): Promise<void> {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
