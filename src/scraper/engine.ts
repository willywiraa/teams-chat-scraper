/**
 * The scraping loop: parse what is rendered, persist it, scroll up, wait for Teams to
 * render, repeat, until the beginning of the conversation (or another stop condition).
 *
 * Reliability measures:
 *  - every pass is persisted before scrolling further, so an interruption loses at most one step;
 *  - each pass must overlap the previous one ("contiguity"); otherwise the step is halved and the
 *    view scrolled back, so virtualised lists can never silently skip messages. Inside parts that
 *    are already archived the run takes larger steps: a skipped stretch that the archive already
 *    holds without a gap does not count as a gap ("bridged");
 *  - the open conversation is re-identified before and after every pass;
 *  - hard caps (steps, duration, stalled passes) prevent endless loops.
 */
import { safeQueryAll } from '../extractor/dom';
import { findMessageList, parseRenderedConversation, type GroupLink, type RenderedImage } from '../extractor/page-parser';
import type { SelectorProfile } from '../extractor/selectors';
import { hashParts } from '../shared/hash';
import { BYTES_PER_MB } from '../shared/images';
import type { ScrapeSettings } from '../shared/settings';
import type { DateOrder } from '../shared/time';
import { toIso } from '../shared/time';
import {
  emptyCounters,
  type ArchivedImages,
  type CapturedImage,
  type ConversationIdentity,
  type CoverageRange,
  type ExtractedMessage,
  type ScrapeMode,
  type SessionCounters,
  type StopReason,
  type UpsertStatus,
} from '../shared/types';
import { sleep, type ScrapeControl } from './control';
import { ImageCapture, type ImageReader, type ImageSaveResult } from './images';
import { createScrollDriver, findScrollContainer, type ScrollDriver } from './scroll-driver';
import { waitForSettle } from './settle';
import { assignSortKeys, isReliable, type AssignedSortKey } from './sort-keys';

export interface EngineBatch {
  messages: ExtractedMessage[];
  /** Contiguous ranges captured so far in this session (in sort-key space). */
  segments: CoverageRange[];
  counters: SessionCounters;
}

export interface EngineSink {
  /** Persists observations; resolves to the storage outcome per message key. */
  write(batch: EngineBatch): Promise<Record<string, UpsertStatus>>;
  /**
   * Stores images read from the page. Called before the batch whose messages refer to them.
   * Without it (or without an image reader, or with `settings.saveImages` off) no image is read.
   */
  saveImages?(images: CapturedImage[]): Promise<ImageSaveResult>;
  /**
   * The saved images of archived messages, by message key. Images of a message shown unchanged
   * are taken from here instead of being read again. Without it every image is read.
   */
  archivedImages?(keys: string[]): Promise<Record<string, ArchivedImages>>;
}

export type EnginePhase = 'starting' | 'running' | 'paused' | 'waiting-visible' | 'done';

export interface EngineProgress {
  phase: EnginePhase;
  counters: SessionCounters;
  lastPassMessages: number;
  inCoveredRange: boolean;
  stepRatio: number;
  oldestReached: string | null;
  newestReached: string | null;
  warnings: string[];
}

export interface EngineResult {
  status: 'completed' | 'stopped' | 'failed';
  stopReason: StopReason;
  error: string | null;
  counters: SessionCounters;
  segments: CoverageRange[];
  warnings: string[];
}

export interface EngineOptions {
  doc: Document;
  profile: SelectorProfile;
  settings: ScrapeSettings;
  mode: ScrapeMode;
  /**
   * Re-read already archived ranges at normal speed (and their images) instead of passing
   * through them quickly.
   */
  rescan?: boolean;
  /**
   * Oldest message time (epoch ms) the run has to reach. A full run stops once its gap-free
   * stretch reaches it ('range-reached'), or once it joins an archived stretch that does; an
   * update stops only after re-reading back to it. Null or absent: the whole history (full), or
   * only the count of archived messages seen again (incremental).
   */
  since?: number | null;
  conversation: ConversationIdentity;
  /** Archive coverage of this conversation when the session started. */
  coverage: CoverageRange[];
  sink: EngineSink;
  control: ScrapeControl;
  dateOrder: DateOrder;
  selfDisplayName: string | null;
  /** Re-identifies the open conversation; the run stops when it changes. */
  detectConversation: () => ConversationIdentity | null;
  /** Reads displayed images (see scraper/images.ts); needed to save images. */
  imageReader?: ImageReader;
  now?: () => number;
  onProgress?: (progress: EngineProgress) => void;
}

type Connection = 'first' | 'connected' | 'gap' | 'ahead' | 'empty';

interface Anchor {
  key: string;
  sortKey: number | null;
  /** The sort key is a real position (exact or interpolated), not just the order of observation. */
  placed: boolean;
}

function anchorOf(message: ExtractedMessage): Anchor {
  return { key: message.key, sortKey: message.sortKey, placed: message.sortKey !== null && message.sortKeySource !== 'observed-order' };
}

const MAX_GAP_RETRIES = 4;
const MIN_STEP_RATIO = 0.15;
const STEP_RECOVERY_PASSES = 10;
const BOTTOM_ATTEMPTS = 4;
const MAX_WARNINGS = 50;
const NUDGE_DELAY_MS = 60;
/** Longest scroll animation while passing through already-archived parts (keeps seeking quick). */
const SEEK_ANIMATION_MS = 120;
/** Scroll step (in viewport heights) while passing through already-archived parts. */
export const SEEK_STEP_RATIO = 2;

export function messageSignature(message: ExtractedMessage): string {
  return hashParts([
    message.contentHash,
    message.kind,
    message.sender.name,
    message.sender.source,
    message.timestamp,
    message.timestampSource,
    message.sortKeySource,
    message.replyTo?.messageId,
    message.replyTo?.preview,
    message.attachments.length,
    // A message is sent again once one of its images has been saved.
    message.attachments.map((attachment) => attachment.imageId ?? '').join(','),
    (message.reactions ?? []).map((reaction) => `${reaction.emoji}:${reaction.count}:${reaction.mine ? 1 : 0}`).join(','),
    message.isEdited,
    message.isDeleted,
  ]);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function waitUntilVisible(doc: Document, signal: AbortSignal): Promise<void> {
  if (doc.visibilityState !== 'hidden' || signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      doc.removeEventListener('visibilitychange', onChange);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const onChange = () => {
      if (doc.visibilityState !== 'hidden') done();
    };
    doc.addEventListener('visibilitychange', onChange);
    signal.addEventListener('abort', done, { once: true });
  });
}

class ScrapeEngine {
  private readonly counters = emptyCounters();
  private readonly seen = new Map<string, string>();
  private readonly sessionSortKeys = new Map<string, AssignedSortKey>();
  /** Message key → key of the message rendered directly below it without an author header. */
  private readonly groupSuccessor = new Map<string, string>();
  /** Continuation messages whose sender is not known yet (their group header was never rendered with them). */
  private readonly unknownSenders = new Map<string, ExtractedMessage>();
  private readonly closedSegments: CoverageRange[] = [];
  /** Segments as of the last successful write to storage. */
  private persistedSegments: CoverageRange[] = [];
  private current: { oldest: number | null; newest: number | null; reachedBeginning: boolean } = {
    oldest: null,
    newest: null,
    reachedBeginning: false,
  };
  /** Oldest message of the last connected pass; `placed` when its sort key is a real position. */
  private anchor: Anchor | null = null;
  private readonly warnings: string[] = [];
  private readonly overlapRanges: CoverageRange[];
  /** Archived messages (inside the overlap ranges) seen again in this session. */
  private readonly overlapKeys = new Set<string>();
  private stepRatio: number;
  /** Step while passing through archived parts; halved when a step overshoots an archived stretch. */
  private seekRatio: number;
  private lastStepWasSeek = false;
  private readonly since: number | null;
  /** Saved images of archived messages, looked up once per message key in a session. */
  private readonly archivedImageIds = new Map<string, ArchivedImages | null>();
  private connectedStreak = 0;
  private lastPassMessages = 0;
  private inCovered = false;
  private phase: EnginePhase = 'starting';
  private readonly now: () => number;
  private readonly startedAt: number;
  private readonly images: ImageCapture | null;

  constructor(private readonly options: EngineOptions) {
    this.now = options.now ?? (() => Date.now());
    this.startedAt = this.now();
    this.stepRatio = options.settings.scrollStepRatio;
    this.seekRatio = Math.max(options.settings.scrollStepRatio, SEEK_STEP_RATIO);
    this.since = options.mode !== 'visible' && typeof options.since === 'number' && Number.isFinite(options.since) ? options.since : null;
    const sink = options.sink;
    this.images =
      options.settings.saveImages && options.imageReader && sink.saveImages
        ? new ImageCapture({
            reader: options.imageReader,
            maxBytes: options.settings.maxImageMB * BYTES_PER_MB,
            save: (images) => (sink.saveImages as NonNullable<EngineSink['saveImages']>).call(sink, images),
            counters: this.counters,
            warn: (message) => this.warn(message),
          })
        : null;
    const coverage = options.coverage ?? [];
    // Archived stretches that, once joined, finish the run: for an update any of them (with the
    // overlap window still to re-read); for a full run those that already reach back far enough.
    const since = this.since;
    this.overlapRanges =
      options.mode === 'incremental'
        ? coverage
        : options.mode === 'full' && !options.rescan
          ? coverage.filter((range) => range.reachedBeginning || (since !== null && range.oldest <= since))
          : [];
  }

  async run(): Promise<EngineResult> {
    const o = this.options;
    try {
      let list = findMessageList(o.doc, o.profile);
      if (!list) {
        return this.finish('failed', 'container-lost', 'Message list not found. Open a chat in Teams Web, then run Diagnostics from the popup.');
      }
      let driver = this.driverFor(list);
      if (o.mode !== 'visible') await this.scrollToBottom(driver);

      let previousMoved: boolean | null = null;
      let previousAtTop = false;
      let atTopStreak = 0;
      let stallPasses = 0;
      let gapRetries = 0;
      let backStep = 0;
      let lastUpStep = 0;

      for (;;) {
        if ((await this.gate()) === 'stop') return this.finish('stopped', 'user-stop');
        if (!this.conversationUnchanged()) {
          return this.finish('stopped', 'conversation-changed', 'A different conversation was opened during extraction.');
        }
        if (!list.isConnected) {
          list = findMessageList(o.doc, o.profile);
          if (!list) return this.finish('failed', 'container-lost', 'The message list disappeared from the page.');
          driver = this.driverFor(list);
        }

        const { messages, groupLinks, images } = this.parsePass(list);
        if (!this.conversationUnchanged()) {
          return this.finish('stopped', 'conversation-changed', 'A different conversation was opened during extraction.');
        }
        this.counters.passes++;
        this.lastPassMessages = messages.length;
        const connection = this.updateContiguity(messages);
        const senderUpdates = this.propagateSenders(messages, groupLinks);
        // Images are stored first, so a stored message never refers to an image that is missing.
        if (this.images && images.length > 0) {
          await this.applyArchivedImages(messages, images);
          await this.images.capture(messages, images);
        }
        const newKeys = await this.store(messages, senderUpdates);
        this.inCovered = this.isInCoveredRange(messages);
        if (this.inCovered && o.mode !== 'visible') this.counters.seekPasses++;
        this.emit();

        if (o.mode === 'visible') return this.finish('completed', 'visible-complete');
        if (this.overlapReached(connection)) {
          return this.finish('completed', o.mode === 'incremental' ? 'overlap-reached' : 'history-complete');
        }
        if (o.mode === 'full' && this.reachedSince(connection)) return this.finish('completed', 'range-reached');
        if (this.counters.passes >= o.settings.maxSteps) return this.finish('stopped', 'max-steps');
        if (this.now() - this.startedAt >= o.settings.maxDurationMinutes * 60_000) return this.finish('stopped', 'max-duration');

        if (connection === 'gap') {
          this.counters.gapsDetected++;
          if (gapRetries < MAX_GAP_RETRIES && lastUpStep > 0) {
            // We scrolled past unseen messages: go back down part of the way with a smaller step.
            gapRetries++;
            backStep = Math.max(20, Math.round((backStep || lastUpStep) / 2));
            // A large step through archived parts that went past their end: only seeking slows down.
            if (this.lastStepWasSeek) this.seekRatio = Math.max(this.options.settings.scrollStepRatio, this.seekRatio / 2);
            else this.stepRatio = Math.max(MIN_STEP_RATIO, this.stepRatio / 2);
            this.connectedStreak = 0;
            await driver.scrollDown(backStep, o.settings.scrollAnimationMs);
            await this.settleAfterScroll(driver, true);
            previousMoved = null;
            continue;
          }
          this.counters.gapsUnrecovered++;
          this.restartSegment(messages);
          this.warn('A gap in the message list could not be closed; archive coverage was split at this point.');
        }
        if (connection === 'connected' || connection === 'first') {
          gapRetries = 0;
          backStep = 0;
          this.recoverStepRatio();
        }

        // "Top reached" needs: scrolling up had no effect, the position really is the top, and
        // nothing new appeared even after waiting for Teams to load older history.
        if (previousMoved === false && previousAtTop && newKeys === 0) atTopStreak++;
        else if (newKeys > 0 || previousMoved === true) atTopStreak = 0;
        if (atTopStreak >= o.settings.maxNoProgressPasses && connection !== 'gap') {
          return this.finish('completed', 'reached-top');
        }

        if (connection !== 'ahead') stallPasses = newKeys === 0 ? stallPasses + 1 : 0;
        if (stallPasses >= o.settings.maxStallPasses) {
          return this.finish('stopped', 'no-progress', 'No new messages appeared after repeated scrolling.');
        }

        const viewport = driver.viewportHeight();
        const seeking = this.inCovered && !o.rescan;
        // Only a full run may step over archived messages; an update reads each one of its window.
        const jumping = seeking && o.mode === 'full';
        const ratio = connection === 'ahead' ? Math.max(this.stepRatio, 1.5) : jumping ? this.seekRatio : this.stepRatio;
        this.lastStepWasSeek = jumping && connection !== 'ahead';
        const step = Math.max(40, Math.round(viewport * ratio));
        const animation = seeking ? Math.min(o.settings.scrollAnimationMs, SEEK_ANIMATION_MS) : o.settings.scrollAnimationMs;
        const stepStarted = this.now();
        const move = await driver.scrollUp(step, animation);
        lastUpStep = move.distance;
        previousMoved = move.moved;
        previousAtTop = !move.moved && driver.isAtTop();
        if (previousAtTop) {
          await this.nudge(driver, viewport);
          await this.settleAfterScroll(driver, false);
        } else {
          // Moved normally, or the list refuses to scroll (counted as a stall, never as the top).
          await this.settleAfterScroll(driver, true);
        }
        const interval = seeking ? o.settings.seekIntervalMs : o.settings.scrollIntervalMs;
        const remaining = interval - (this.now() - stepStarted);
        if (remaining > 0) await sleep(remaining, o.control.signal);
      }
    } catch (error) {
      return this.finish('failed', 'error', errorMessage(error));
    }
  }

  private driverFor(list: Element): ScrollDriver {
    return createScrollDriver(findScrollContainer(this.options.doc, this.options.profile, list), { signal: this.options.control.signal });
  }

  private conversationUnchanged(): boolean {
    let current: ConversationIdentity | null = null;
    try {
      current = this.options.detectConversation();
    } catch {
      current = null;
    }
    return current !== null && current.conversationKey === this.options.conversation.conversationKey;
  }

  private async gate(): Promise<'continue' | 'stop'> {
    const o = this.options;
    if (o.control.state === 'paused') {
      this.phase = 'paused';
      this.emit();
    }
    if ((await o.control.checkpoint()) === 'stop') return 'stop';
    if (o.settings.pauseWhenHidden && o.doc.visibilityState === 'hidden') {
      this.phase = 'waiting-visible';
      this.emit();
      await waitUntilVisible(o.doc, o.control.signal);
      if ((await o.control.checkpoint()) === 'stop') return 'stop';
    }
    if (this.phase !== 'running') {
      this.phase = 'running';
      this.emit();
    }
    return 'continue';
  }

  private isLoading(driver: ScrollDriver): boolean {
    const scope = driver.element.parentElement ?? driver.element;
    return this.options.profile.loadingIndicator.some((selector) => safeQueryAll(scope, selector).length > 0);
  }

  private settleAfterScroll(driver: ScrollDriver, moved: boolean) {
    const s = this.options.settings;
    const target = driver.element.parentElement ?? driver.element;
    return waitForSettle(target, {
      quietMs: s.settleQuietMs,
      timeoutMs: moved ? s.settleTimeoutMs : s.topLoadTimeoutMs,
      requireMutation: !moved,
      isLoading: () => this.isLoading(driver),
      signal: this.options.control.signal,
      now: this.now,
    });
  }

  /** At the top: scroll down a little and back up so Teams' history loader is triggered again. */
  private async nudge(driver: ScrollDriver, viewport: number): Promise<void> {
    const distance = Math.max(30, Math.round(viewport * 0.25));
    const down = await driver.scrollDown(distance);
    if (!down.moved) return;
    await sleep(NUDGE_DELAY_MS, this.options.control.signal);
    await driver.scrollUp(distance + 50);
    await waitForSettle(driver.element.parentElement ?? driver.element, {
      quietMs: this.options.settings.settleQuietMs,
      timeoutMs: this.options.settings.settleTimeoutMs,
      signal: this.options.control.signal,
      now: this.now,
    });
  }

  private async scrollToBottom(driver: ScrollDriver): Promise<void> {
    for (let attempt = 0; attempt < BOTTOM_ATTEMPTS; attempt++) {
      const before = driver.state().height;
      driver.scrollToBottom();
      await this.settleAfterScroll(driver, true);
      if (this.options.control.signal.aborted) return;
      if (driver.state().height === before && driver.isAtBottom()) return;
    }
  }

  private parsePass(list: Element): { messages: ExtractedMessage[]; groupLinks: GroupLink[]; images: RenderedImage[] } {
    const o = this.options;
    const result = parseRenderedConversation(o.doc, {
      profile: o.profile,
      conversation: o.conversation,
      selfDisplayName: o.selfDisplayName,
      referenceMs: this.now(),
      dateOrder: o.dateOrder,
      listElement: list,
    });
    for (const warning of result.warnings) {
      if (warning.startsWith('duplicate-message-id')) this.warn(`Teams rendered the same message twice (${warning.split(':')[1]}); kept the first copy.`);
    }
    assignSortKeys(result.messages, this.sessionSortKeys, this.now());
    return { messages: result.messages, groupLinks: result.groupLinks, images: result.images };
  }

  /**
   * Teams shows the author only on the first message of a run from one person. When a run is
   * longer than the rendered window, its lower messages were captured (in earlier passes) before
   * the header scrolled into view. Once a message with a known sender is seen, the sender is
   * passed down the chain of continuation messages linked to it. Returns updated earlier messages.
   */
  private propagateSenders(messages: ExtractedMessage[], links: GroupLink[]): ExtractedMessage[] {
    for (const link of links) this.groupSuccessor.set(link.previous, link.next);
    for (const message of messages) {
      if (message.kind === 'message' && !message.sender.isSelf && message.sender.source === 'unknown') this.unknownSenders.set(message.key, message);
      else this.unknownSenders.delete(message.key);
    }
    if (this.unknownSenders.size === 0) return [];

    const inPass = new Set(messages);
    const updates: ExtractedMessage[] = [];
    for (const message of messages) {
      if (message.kind !== 'message' || message.sender.isSelf || !message.sender.name) continue;
      let source = message;
      let nextKey = this.groupSuccessor.get(source.key);
      while (nextKey !== undefined) {
        const pending = this.unknownSenders.get(nextKey);
        if (!pending) break;
        pending.sender = { name: source.sender.name, id: source.sender.id, isSelf: false, source: 'group-inferred' };
        this.unknownSenders.delete(nextKey);
        if (!inPass.has(pending)) updates.push(pending);
        source = pending;
        nextKey = this.groupSuccessor.get(source.key);
      }
    }
    return updates;
  }

  private updateContiguity(messages: ExtractedMessage[]): Connection {
    if (messages.length === 0) return 'empty';
    const oldest = messages[0] as ExtractedMessage;
    const newest = messages[messages.length - 1] as ExtractedMessage;
    if (!this.anchor) {
      this.anchor = anchorOf(oldest);
      this.extendSegment(messages);
      return 'first';
    }
    const anchor = this.anchor;
    let connection: Connection;
    if (messages.some((message) => message.key === anchor.key)) {
      connection = 'connected';
    } else if (anchor.sortKey !== null && oldest.sortKey !== null && newest.sortKey !== null) {
      if (oldest.sortKey <= anchor.sortKey && anchor.sortKey <= newest.sortKey) connection = 'connected';
      else if (newest.sortKey < anchor.sortKey) connection = this.bridgedByArchive(messages, anchor) ? 'connected' : 'gap';
      else connection = 'ahead';
    } else {
      connection = 'gap';
    }
    if (connection === 'connected') {
      if (oldest.sortKey === null || anchor.sortKey === null || oldest.sortKey <= anchor.sortKey) {
        this.anchor = anchorOf(oldest);
      }
      this.extendSegment(messages);
    }
    return connection;
  }

  private extendSegment(messages: ExtractedMessage[]): void {
    const keys = messages.filter(isReliable).map((message) => message.sortKey as number);
    if (keys.length === 0) return;
    const min = Math.min(...keys);
    const max = Math.max(...keys);
    this.current.oldest = this.current.oldest === null ? min : Math.min(this.current.oldest, min);
    this.current.newest = this.current.newest === null ? max : Math.max(this.current.newest, max);
  }

  private restartSegment(messages: ExtractedMessage[]): void {
    if (this.current.oldest !== null && this.current.newest !== null) {
      this.closedSegments.push({ oldest: this.current.oldest, newest: this.current.newest, reachedBeginning: false });
    }
    this.current = { oldest: null, newest: null, reachedBeginning: false };
    const oldest = messages[0];
    this.anchor = oldest ? anchorOf(oldest) : null;
    this.extendSegment(messages);
  }

  /**
   * A pass below the previous one that does not overlap it is still connected when everything
   * between them was archived without a gap before the run: the pass's newest exact message and
   * the previous pass's oldest message lie in one archived stretch.
   */
  private bridgedByArchive(messages: ExtractedMessage[], anchor: Anchor): boolean {
    if (this.options.mode !== 'full' || this.options.rescan || !anchor.placed || anchor.sortKey === null) return false;
    const keys = messages.filter(isReliable).map((message) => message.sortKey as number);
    if (keys.length === 0) return false;
    const newest = Math.max(...keys);
    const top = anchor.sortKey;
    return (this.options.coverage ?? []).some((range) => range.oldest <= newest && top <= range.newest);
  }

  /**
   * Takes the image ids of archived messages that are shown unchanged from the archive, so their
   * images are not read again. Looked up once per message in a session; on failure the images
   * are simply read.
   */
  private async applyArchivedImages(messages: ExtractedMessage[], images: RenderedImage[]): Promise<void> {
    const sink = this.options.sink;
    if (this.options.rescan || !sink.archivedImages) return;
    const keys = [...new Set(images.map((image) => image.messageKey))].filter((key) => !this.archivedImageIds.has(key));
    if (keys.length > 0) {
      let found: Record<string, ArchivedImages> = {};
      try {
        found = await sink.archivedImages(keys);
      } catch {
        found = {};
      }
      for (const key of keys) this.archivedImageIds.set(key, found[key] ?? null);
    }
    for (const message of messages) {
      const archived = this.archivedImageIds.get(message.key);
      if (!archived || archived.contentHash !== message.contentHash || archived.imageIds.length !== message.attachments.length) continue;
      message.attachments.forEach((attachment, index) => {
        const imageId = archived.imageIds[index];
        if (attachment.kind === 'image' && imageId) attachment.imageId = imageId;
      });
    }
  }

  private segments(): CoverageRange[] {
    const all = [...this.closedSegments];
    if (this.current.oldest !== null && this.current.newest !== null) {
      all.push({ oldest: this.current.oldest, newest: this.current.newest, reachedBeginning: this.current.reachedBeginning });
    }
    return all.map((range) => ({ ...range }));
  }

  private recoverStepRatio(): void {
    this.connectedStreak++;
    const target = this.options.settings.scrollStepRatio;
    if (this.connectedStreak < STEP_RECOVERY_PASSES) return;
    const seekTarget = Math.max(target, SEEK_STEP_RATIO);
    if (this.stepRatio < target || this.seekRatio < seekTarget) {
      this.stepRatio = Math.min(target, this.stepRatio * 1.5);
      this.seekRatio = Math.min(seekTarget, this.seekRatio * 1.5);
      this.connectedStreak = 0;
    }
  }

  /**
   * Sends new or changed observations (plus sender corrections for earlier messages) to storage.
   * Returns how many keys were new to the session.
   */
  private async store(messages: ExtractedMessage[], senderUpdates: ExtractedMessage[] = []): Promise<number> {
    const toSend: ExtractedMessage[] = senderUpdates.filter((message) => this.seen.get(message.key) !== messageSignature(message));
    let newKeys = 0;
    for (const message of messages) {
      const signature = messageSignature(message);
      const previous = this.seen.get(message.key);
      if (previous === undefined) {
        newKeys++;
        this.counters.uniqueSeen++;
        toSend.push(message);
      } else if (previous !== signature) {
        toSend.push(message);
      } else {
        this.counters.reobserved++;
      }
      if (isReliable(message)) {
        const key = message.sortKey as number;
        this.counters.oldestSortKey = this.counters.oldestSortKey === null ? key : Math.min(this.counters.oldestSortKey, key);
        this.counters.newestSortKey = this.counters.newestSortKey === null ? key : Math.max(this.counters.newestSortKey, key);
      }
    }
    const segments = this.segments();
    if (toSend.length === 0) {
      this.persistedSegments = segments;
      return newKeys;
    }

    const statuses = await this.options.sink.write({ messages: toSend, segments, counters: { ...this.counters } });
    this.persistedSegments = segments;
    for (const message of toSend) {
      const status = statuses[message.key];
      if (status === 'inserted') this.counters.inserted++;
      else if (status === 'updated') this.counters.updated++;
      else if (status === 'unchanged') this.counters.unchanged++;
      if (
        status !== undefined &&
        status !== 'inserted' &&
        isReliable(message) &&
        this.overlapRanges.some((range) => (message.sortKey as number) >= range.oldest && (message.sortKey as number) <= range.newest)
      ) {
        this.overlapKeys.add(message.key);
      }
      this.seen.set(message.key, messageSignature(message));
    }
    return newKeys;
  }

  private overlapReached(connection: Connection): boolean {
    if (this.overlapRanges.length === 0 || this.overlapKeys.size < this.options.settings.incrementalOverlap) return false;
    if (connection !== 'connected' && connection !== 'first') return false;
    // An update also re-reads the archived messages back to `since` (late edits and replies).
    return this.options.mode !== 'incremental' || this.since === null || this.reachedSince(connection);
  }

  /** The current gap-free stretch reaches back to `since`. */
  private reachedSince(connection: Connection): boolean {
    return (
      this.since !== null &&
      (connection === 'connected' || connection === 'first') &&
      this.current.oldest !== null &&
      this.current.oldest <= this.since
    );
  }

  private isInCoveredRange(messages: ExtractedMessage[]): boolean {
    if (this.options.rescan) return false;
    const keys = messages.filter(isReliable).map((message) => message.sortKey as number);
    if (keys.length === 0) return false;
    const min = Math.min(...keys);
    const max = Math.max(...keys);
    return (this.options.coverage ?? []).some((range) => min >= range.oldest && max <= range.newest);
  }

  private warn(message: string): void {
    if (this.warnings.includes(message) || this.warnings.length >= MAX_WARNINGS) return;
    this.warnings.push(message);
  }

  private emit(): void {
    this.options.onProgress?.({
      phase: this.phase,
      counters: { ...this.counters },
      lastPassMessages: this.lastPassMessages,
      inCoveredRange: this.inCovered,
      stepRatio: this.stepRatio,
      oldestReached: toIso(this.counters.oldestSortKey),
      newestReached: toIso(this.counters.newestSortKey),
      warnings: [...this.warnings],
    });
  }

  private finish(status: EngineResult['status'], stopReason: StopReason, error?: string): EngineResult {
    if (stopReason === 'reached-top') this.current.reachedBeginning = true;
    this.images?.abandonPending();
    this.phase = 'done';
    this.emit();
    // After a failure (typically a failed write) only report what is known to be stored.
    const segments = status === 'failed' ? this.persistedSegments.map((range) => ({ ...range })) : this.segments();
    return { status, stopReason, error: error ?? null, counters: { ...this.counters }, segments, warnings: [...this.warnings] };
  }
}

export function runScrape(options: EngineOptions): Promise<EngineResult> {
  return new ScrapeEngine(options).run();
}
