/**
 * The scraping loop: parse what is rendered, persist it, scroll up, wait for Teams to
 * render, repeat, until the beginning of the conversation (or another stop condition).
 *
 * Reliability measures:
 *  - every pass is persisted before scrolling further, so an interruption loses at most one step;
 *  - each pass must overlap the previous one ("contiguity"); otherwise the step is halved and the
 *    view scrolled back, so virtualised lists can never silently skip messages;
 *  - the open conversation is re-identified before and after every pass;
 *  - hard caps (steps, duration, stalled passes) prevent endless loops.
 */
import { safeQueryAll } from '../extractor/dom';
import { findMessageList, parseRenderedConversation, type GroupLink } from '../extractor/page-parser';
import type { SelectorProfile } from '../extractor/selectors';
import { hashParts } from '../shared/hash';
import type { ScrapeSettings } from '../shared/settings';
import type { DateOrder } from '../shared/time';
import { toIso } from '../shared/time';
import {
  emptyCounters,
  type ConversationIdentity,
  type CoverageRange,
  type ExtractedMessage,
  type ScrapeMode,
  type SessionCounters,
  type StopReason,
  type UpsertStatus,
} from '../shared/types';
import { sleep, type ScrapeControl } from './control';
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
  /** Full mode only: re-read already archived ranges at normal speed instead of skipping through them. */
  rescan?: boolean;
  conversation: ConversationIdentity;
  /** Archive coverage of this conversation when the session started. */
  coverage: CoverageRange[];
  sink: EngineSink;
  control: ScrapeControl;
  dateOrder: DateOrder;
  selfDisplayName: string | null;
  /** Re-identifies the open conversation; the run stops when it changes. */
  detectConversation: () => ConversationIdentity | null;
  now?: () => number;
  onProgress?: (progress: EngineProgress) => void;
}

type Connection = 'first' | 'connected' | 'gap' | 'ahead' | 'empty';

const MAX_GAP_RETRIES = 4;
const MIN_STEP_RATIO = 0.15;
const STEP_RECOVERY_PASSES = 10;
const BOTTOM_ATTEMPTS = 4;
const MAX_WARNINGS = 50;
const NUDGE_DELAY_MS = 60;

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
  private anchor: { key: string; sortKey: number | null } | null = null;
  private readonly warnings: string[] = [];
  private readonly overlapRanges: CoverageRange[];
  /** Archived messages (inside the overlap ranges) seen again in this session. */
  private readonly overlapKeys = new Set<string>();
  private stepRatio: number;
  private connectedStreak = 0;
  private lastPassMessages = 0;
  private inCovered = false;
  private phase: EnginePhase = 'starting';
  private readonly now: () => number;
  private readonly startedAt: number;

  constructor(private readonly options: EngineOptions) {
    this.now = options.now ?? (() => Date.now());
    this.startedAt = this.now();
    this.stepRatio = options.settings.scrollStepRatio;
    const coverage = options.coverage ?? [];
    this.overlapRanges =
      options.mode === 'incremental'
        ? coverage
        : options.mode === 'full' && !options.rescan
          ? coverage.filter((range) => range.reachedBeginning)
          : [];
  }

  async run(): Promise<EngineResult> {
    const o = this.options;
    try {
      let list = findMessageList(o.doc, o.profile);
      if (!list) {
        return this.finish('failed', 'container-lost', 'Message list not found. Open a chat in Teams Web, then run Diagnostics from the popup.');
      }
      let driver = createScrollDriver(findScrollContainer(o.doc, o.profile, list));
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
          driver = createScrollDriver(findScrollContainer(o.doc, o.profile, list));
        }

        const { messages, groupLinks } = this.parsePass(list);
        if (!this.conversationUnchanged()) {
          return this.finish('stopped', 'conversation-changed', 'A different conversation was opened during extraction.');
        }
        this.counters.passes++;
        this.lastPassMessages = messages.length;
        const connection = this.updateContiguity(messages);
        const senderUpdates = this.propagateSenders(messages, groupLinks);
        const newKeys = await this.store(messages, senderUpdates);
        this.inCovered = this.isInCoveredRange(messages);
        if (this.inCovered && o.mode !== 'visible') this.counters.seekPasses++;
        this.emit();

        if (o.mode === 'visible') return this.finish('completed', 'visible-complete');
        if (this.overlapReached(connection)) {
          return this.finish('completed', o.mode === 'incremental' ? 'overlap-reached' : 'history-complete');
        }
        if (this.counters.passes >= o.settings.maxSteps) return this.finish('stopped', 'max-steps');
        if (this.now() - this.startedAt >= o.settings.maxDurationMinutes * 60_000) return this.finish('stopped', 'max-duration');

        if (connection === 'gap') {
          this.counters.gapsDetected++;
          if (gapRetries < MAX_GAP_RETRIES && lastUpStep > 0) {
            // We scrolled past unseen messages: go back down part of the way with a smaller step.
            gapRetries++;
            backStep = Math.max(20, Math.round((backStep || lastUpStep) / 2));
            this.stepRatio = Math.max(MIN_STEP_RATIO, this.stepRatio / 2);
            this.connectedStreak = 0;
            driver.scrollDown(backStep);
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
        const ratio = connection === 'ahead' ? Math.max(this.stepRatio, 1.5) : this.stepRatio;
        const step = Math.max(40, Math.round(viewport * ratio));
        const stepStarted = this.now();
        const move = driver.scrollUp(step);
        lastUpStep = Math.abs(move.after - move.before);
        previousMoved = move.moved;
        previousAtTop = !move.moved && driver.isAtTop();
        if (previousAtTop) {
          await this.nudge(driver, viewport);
          await this.settleAfterScroll(driver, false);
        } else {
          // Moved normally, or the list refuses to scroll (counted as a stall, never as the top).
          await this.settleAfterScroll(driver, true);
        }
        const interval = this.inCovered && !o.rescan ? o.settings.seekIntervalMs : o.settings.scrollIntervalMs;
        const remaining = interval - (this.now() - stepStarted);
        if (remaining > 0) await sleep(remaining, o.control.signal);
      }
    } catch (error) {
      return this.finish('failed', 'error', errorMessage(error));
    }
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
    const down = driver.scrollDown(distance);
    if (!down.moved) return;
    await sleep(NUDGE_DELAY_MS, this.options.control.signal);
    driver.scrollUp(distance + 50);
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

  private parsePass(list: Element): { messages: ExtractedMessage[]; groupLinks: GroupLink[] } {
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
    return { messages: result.messages, groupLinks: result.groupLinks };
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
      this.anchor = { key: oldest.key, sortKey: oldest.sortKey };
      this.extendSegment(messages);
      return 'first';
    }
    const anchor = this.anchor;
    let connection: Connection;
    if (messages.some((message) => message.key === anchor.key)) {
      connection = 'connected';
    } else if (anchor.sortKey !== null && oldest.sortKey !== null && newest.sortKey !== null) {
      if (oldest.sortKey <= anchor.sortKey && anchor.sortKey <= newest.sortKey) connection = 'connected';
      else if (newest.sortKey < anchor.sortKey) connection = 'gap';
      else connection = 'ahead';
    } else {
      connection = 'gap';
    }
    if (connection === 'connected') {
      if (oldest.sortKey === null || anchor.sortKey === null || oldest.sortKey <= anchor.sortKey) {
        this.anchor = { key: oldest.key, sortKey: oldest.sortKey };
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
    this.anchor = oldest ? { key: oldest.key, sortKey: oldest.sortKey } : null;
    this.extendSegment(messages);
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
    if (this.stepRatio < target && this.connectedStreak >= STEP_RECOVERY_PASSES) {
      this.stepRatio = Math.min(target, this.stepRatio * 1.5);
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
    return (
      this.overlapRanges.length > 0 &&
      this.overlapKeys.size >= this.options.settings.incrementalOverlap &&
      (connection === 'connected' || connection === 'first')
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
