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
 *  - a full run that leaves a hole (a gap it could not close, typically the view jumping to a search
 *    result or a quoted message) goes back down to it and walks up through it before it finishes;
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
import { coverageGaps, mergeAllCoverage } from '../storage/coverage';
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
  /** The list has been at its top for a while, waiting for Teams to load older messages (or to show none come). */
  waitingForOlder: boolean;
  /** The run is scrolling back down to messages it passed without capturing them (a hole), to walk up through them. */
  fillingGap: boolean;
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
/**
 * The most that the time between two looks at the clock can add to a run's working time. A step
 * takes seconds (a minute or two with the longest waits); a longer gap is the computer asleep or
 * hibernating, which is not working time and must not end the run at its time limit.
 */
export const MAX_COUNTED_GAP_MS = 5 * 60_000;
/**
 * The longest the run waits at the top of the list for Teams to load older messages. While Teams
 * shows that it is loading, or has been slow to load in this run, the run waits longer than the
 * attempts at the top alone take, but never longer than this.
 */
export const MAX_TOP_WAIT_MS = 10 * 60_000;
/** At the top the run waits at least this many times as long as Teams' slowest load of older messages in the run. */
const SLOWEST_LOAD_FACTOR = 3;
/** Each nudge at the top scrolls further down (in viewport heights) before going back up, to trigger Teams' loader again. */
const NUDGE_RATIOS = [0.25, 0.75, 1.5];
/** The popup says the run is waiting for older messages once it has waited this long at the top. */
const WAITING_NOTICE_MS = 5_000;
/** How often a full run goes back to a hole it left before it finishes with the hole (see fillHole). */
const MAX_FILL_SWEEPS = 3;
/** Going down to a hole: attempts at the end of the list (waiting for Teams to add newer messages) before giving up. */
const DESCENT_WAITS = 3;
const SPLIT_WARNING = 'A gap in the message list could not be closed; archive coverage was split at this point.';

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
  /** Working time so far, for the time limit: pauses and the computer's sleep are left out (tick()). */
  private workedMs = 0;
  private lastTick: number;
  /** Working time when the list reached its top, while it stays there; null otherwise. */
  private topSince: number | null = null;
  /** The longest Teams took in this run to load older messages once the list was at its top (working time). */
  private slowestLoadMs = 0;
  /** Nudges since the list reached its top. */
  private nudges = 0;
  /**
   * The archive's coverage when the run started, plus the stretches this run closed (at a gap it
   * could not close, or before going back to a hole): what passes are sought through and bridged by.
   */
  private known: CoverageRange[];
  /** While walking up through a hole: the reason the run was about to finish with. */
  private fillingFor: StopReason | null = null;
  private fillSweeps = 0;
  private descending = false;
  private readonly images: ImageCapture | null;

  constructor(private readonly options: EngineOptions) {
    this.now = options.now ?? (() => Date.now());
    this.lastTick = this.now();
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
    this.known = coverage.map((range) => ({ ...range }));
    // Archived stretches that, once joined, finish the run: for an update any of them (with the
    // overlap window still to re-read); for a period those that already reach back to its start.
    // The full history always goes on to the top: a stretch marked as reaching the beginning may
    // have been marked too early (Teams too slow to load older messages), so it is passed quickly
    // and the beginning checked again.
    const since = this.since;
    this.overlapRanges =
      options.mode === 'incremental'
        ? coverage
        : options.mode === 'full' && !options.rescan && since !== null
          ? coverage.filter((range) => range.oldest <= since)
          : [];
  }

  async run(): Promise<EngineResult> {
    const o = this.options;
    try {
      const found = findMessageList(o.doc, o.profile);
      if (!found) {
        return this.finish('failed', 'container-lost', 'Message list not found. Open a chat in Teams Web and wait until its messages are shown.');
      }
      let list: Element = found;
      let driver = this.driverFor(list);
      if (o.mode !== 'visible') await this.scrollToBottom(driver);

      let previousMoved: boolean | null = null;
      let previousAtTop = false;
      let atTopStreak = 0;
      let stallPasses = 0;
      let gapRetries = 0;
      let backStep = 0;
      let lastUpStep = 0;

      /**
       * Where a full run would finish, it first goes back to a hole it left (see fillHole). Null while
       * it walks up through the hole (the walk starts afresh); otherwise the result.
       */
      const end = async (reason: StopReason): Promise<EngineResult | null> => {
        const fill = await this.fillHole(reason, driver, list);
        if (fill === 'stop') return this.finish('stopped', 'user-stop');
        if (fill === 'changed') return this.finish('stopped', 'conversation-changed', 'A different conversation was opened during extraction.');
        if (fill === 'limit') return this.finish('stopped', this.counters.passes >= o.settings.maxSteps ? 'max-steps' : 'max-duration');
        if (fill === 'finish') return this.finish('completed', reason);
        previousMoved = null;
        previousAtTop = false;
        atTopStreak = 0;
        stallPasses = 0;
        gapRetries = 0;
        backStep = 0;
        lastUpStep = 0;
        return null;
      };

      for (;;) {
        this.tick();
        if ((await this.gate()) === 'stop') return this.finish('stopped', 'user-stop');
        // Time spent paused, or waiting for the Teams tab to be shown, is not working time.
        this.lastTick = this.now();
        if (!this.conversationUnchanged()) {
          return this.finish('stopped', 'conversation-changed', 'A different conversation was opened during extraction.');
        }
        if (!list.isConnected) {
          const again = findMessageList(o.doc, o.profile);
          if (!again) return this.finish('failed', 'container-lost', 'The message list disappeared from the page.');
          list = again;
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
        if (this.fillingFor !== null) {
          // Walking up through a hole: done once it joins the stretch below the hole.
          if ((connection === 'connected' || connection === 'first') && this.holeToFill() === null) return this.finishFilled();
        } else if (this.overlapReached(connection)) {
          if (o.mode === 'incremental') return this.finish('completed', 'overlap-reached');
          const result = await end('history-complete');
          if (result) return result;
          continue;
        }
        if (o.mode === 'full' && this.reachedSince(connection)) {
          const result = await end('range-reached');
          if (result) return result;
          continue;
        }
        if (this.counters.passes >= o.settings.maxSteps) return this.finish('stopped', 'max-steps');
        this.tick();
        if (this.workedMs >= o.settings.maxDurationMinutes * 60_000) return this.finish('stopped', 'max-duration');

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
            this.topSince = null;
            await driver.scrollDown(backStep, o.settings.scrollAnimationMs);
            await this.settleAfterScroll(driver, true);
            previousMoved = null;
            continue;
          }
          this.counters.gapsUnrecovered++;
          this.restartSegment(messages);
          this.warn(SPLIT_WARNING);
        }
        if (connection === 'connected' || connection === 'first') {
          gapRetries = 0;
          backStep = 0;
          this.recoverStepRatio();
        }

        // "Top reached" needs: scrolling up had no effect, the position still is the top (Teams
        // keeps the view in place when it adds older messages above it), nothing new appeared, and
        // the run has waited long enough for Teams to load older history (see topWaitDone).
        const atTop = previousMoved === false && previousAtTop && driver.isAtTop();
        // An attempt while Teams shows that it is loading does not count, up to the longest wait.
        const loading = atTop && this.isLoading(driver) && this.topWaitedMs() < MAX_TOP_WAIT_MS;
        if (atTop && newKeys === 0 && !loading) atTopStreak++;
        else if (newKeys > 0 || previousMoved === true) atTopStreak = 0;
        if (atTopStreak >= o.settings.maxNoProgressPasses && connection !== 'gap' && this.topWaitDone()) {
          const result = await end('reached-top');
          if (result) return result;
          continue;
        }

        // Waiting at the top is not a stall: it ends at the top (above) within MAX_TOP_WAIT_MS.
        if (connection !== 'ahead' && !atTop) stallPasses = newKeys === 0 ? stallPasses + 1 : 0;
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
        const atTopNow = driver.isAtTop();
        previousAtTop = !move.moved && atTopNow;
        this.tick();
        if (move.moved && this.topSince !== null) {
          // Teams loaded older messages: how long it took since the list reached the top.
          this.slowestLoadMs = Math.max(this.slowestLoadMs, this.workedMs - this.topSince);
          this.topSince = null;
          this.nudges = 0;
        }
        // A step that ends at the top starts the wait for older messages, also when it moved there.
        if (atTopNow && this.topSince === null) this.topSince = this.workedMs;
        if (previousAtTop) {
          await this.nudge(driver, viewport, NUDGE_RATIOS[this.nudges++ % NUDGE_RATIOS.length] as number);
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

  /**
   * Before a full run finishes, it goes back to the newest hole it left (holeToFill): it closes its
   * current stretch (reaching the beginning when it finishes at the top), scrolls down until the
   * messages after the hole are shown, and walks up through the hole again. At most MAX_FILL_SWEEPS
   * times; then, or when it cannot get back there, it finishes with the hole (the archive says so).
   */
  private async fillHole(reason: StopReason, driver: ScrollDriver, list: Element): Promise<'filling' | 'finish' | 'stop' | 'changed' | 'limit'> {
    if (this.options.mode !== 'full' || this.fillSweeps >= MAX_FILL_SWEEPS) return 'finish';
    const target = this.holeToFill();
    if (target === null) return 'finish';
    this.fillSweeps++;
    this.fillingFor = reason;
    this.closeSegment(reason === 'reached-top');
    const outcome = await this.descendTo(driver, list, target);
    if (outcome === 'reached') {
      this.anchor = null;
      this.connectedStreak = 0;
      this.topSince = null;
      this.nudges = 0;
      this.lastStepWasSeek = false;
      return 'filling';
    }
    if (outcome === 'ended') {
      this.warn('The run could not get back to messages it had passed (Teams showed no newer ones). Reload the Teams tab and capture the full history again to fill the gap.');
      return 'finish';
    }
    return outcome;
  }

  /**
   * The hole a full run fills before it finishes, as the time of the oldest message after it (where
   * the walk up through it starts), or null. It is the newest stretch missing between the ranges
   * the archive and this run cover, among those newer than the oldest message the run reached
   * (older ones are history Teams no longer shows) and, for a period, newer than its start.
   */
  private holeToFill(): number | null {
    const own = this.segments();
    if (own.length === 0) return null;
    const reachedFrom = Math.min(...own.map((range) => range.oldest));
    const gaps = coverageGaps([...this.known, ...own]);
    for (let i = gaps.length - 1; i >= 0; i--) {
      const gap = gaps[i] as { after: number; before: number };
      if (gap.after >= reachedFrom && (this.since === null || gap.before > this.since)) return gap.before;
    }
    return null;
  }

  /** The walk up through a hole joined the stretch below it: the run finishes as it was about to. */
  private finishFilled(): EngineResult {
    const index = this.warnings.indexOf(SPLIT_WARNING);
    if (index >= 0) this.warnings.splice(index, 1);
    return this.finish('completed', this.fillingFor as StopReason, undefined, false);
  }

  /**
   * Scrolls down (towards newer messages) until a message at or after `target` is shown, quickly and
   * without storing anything: the walk up from there captures what lies below. At the end of the
   * list it waits for Teams to add newer messages (after a jump to a search result Teams shows a part
   * of the chat, and adds newer messages as one scrolls down).
   */
  private async descendTo(driver: ScrollDriver, list: Element, target: number): Promise<'reached' | 'ended' | 'stop' | 'changed' | 'limit'> {
    const o = this.options;
    let still = 0;
    this.descending = true;
    try {
      for (;;) {
        this.tick();
        if ((await this.gate()) === 'stop') return 'stop';
        this.lastTick = this.now();
        if (!this.conversationUnchanged()) return 'changed';
        if (!list.isConnected) return 'ended';
        const { messages } = this.parsePass(list);
        if (messages.some((message) => isReliable(message) && (message.sortKey as number) >= target)) return 'reached';
        this.counters.passes++;
        this.emit();
        this.tick();
        if (this.counters.passes >= o.settings.maxSteps || this.workedMs >= o.settings.maxDurationMinutes * 60_000) return 'limit';
        const move = await driver.scrollDown(Math.round(driver.viewportHeight() * SEEK_STEP_RATIO), Math.min(o.settings.scrollAnimationMs, SEEK_ANIMATION_MS));
        if (move.moved) still = 0;
        else if (++still > DESCENT_WAITS) return 'ended';
        // At the end of the list: wait (as at the top) for Teams to add newer messages.
        await this.settleAfterScroll(driver, move.moved);
        await sleep(o.settings.seekIntervalMs, o.control.signal);
      }
    } finally {
      this.descending = false;
    }
  }

  /** Working time spent at the top of the list since it got there (0 when it is not there). */
  private topWaitedMs(): number {
    if (this.topSince === null) return 0;
    this.tick();
    return this.workedMs - this.topSince;
  }

  /**
   * Whether the run has waited at the top long enough to take it for the beginning of the chat:
   * as long as the attempts at the top take with their full wait (`maxNoProgressPasses` times
   * `topLoadTimeoutMs`, even when changes elsewhere on the page end a wait early), and three
   * times as long as Teams' slowest load of older messages so far, but no longer than MAX_TOP_WAIT_MS.
   */
  private topWaitDone(): boolean {
    const s = this.options.settings;
    const needed = Math.min(MAX_TOP_WAIT_MS, Math.max(s.maxNoProgressPasses * s.topLoadTimeoutMs, SLOWEST_LOAD_FACTOR * this.slowestLoadMs));
    return this.topWaitedMs() >= needed;
  }

  /** Adds the time since the last tick to the working time, but no more than MAX_COUNTED_GAP_MS of it. */
  private tick(): void {
    const now = this.now();
    this.workedMs += Math.min(Math.max(0, now - this.lastTick), MAX_COUNTED_GAP_MS);
    this.lastTick = now;
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

  /** At the top: scroll down `ratio` viewport heights and back up so Teams' history loader is triggered again. */
  private async nudge(driver: ScrollDriver, viewport: number, ratio: number): Promise<void> {
    const distance = Math.max(30, Math.round(viewport * ratio));
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

  /** Ends the current stretch (keeping it with the run's segments and what passes can seek through). */
  private closeSegment(reachedBeginning: boolean): void {
    if (this.current.oldest !== null && this.current.newest !== null) {
      const range: CoverageRange = { oldest: this.current.oldest, newest: this.current.newest, reachedBeginning };
      this.closedSegments.push(range);
      this.known = mergeAllCoverage(this.known, [range]);
    }
    this.current = { oldest: null, newest: null, reachedBeginning: false };
  }

  private restartSegment(messages: ExtractedMessage[]): void {
    this.closeSegment(false);
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
    return this.known.some((range) => range.oldest <= newest && top <= range.newest);
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
    return this.known.some((range) => min >= range.oldest && max <= range.newest);
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
      waitingForOlder: this.topSince !== null && this.workedMs - this.topSince >= WAITING_NOTICE_MS,
      fillingGap: this.descending,
      stepRatio: this.stepRatio,
      oldestReached: toIso(this.counters.oldestSortKey),
      newestReached: toIso(this.counters.newestSortKey),
      warnings: [...this.warnings],
    });
  }

  /** `reachedBeginning`: the current stretch goes back to the beginning (a run that stops at the top). */
  private finish(status: EngineResult['status'], stopReason: StopReason, error?: string, reachedBeginning = stopReason === 'reached-top'): EngineResult {
    if (reachedBeginning) this.current.reachedBeginning = true;
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
