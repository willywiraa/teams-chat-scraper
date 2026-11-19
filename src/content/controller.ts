/**
 * Runs inside the Teams tab: answers popup commands and drives the scraping engine,
 * forwarding captured batches to the background worker. Chrome APIs are injected,
 * which keeps this class testable end-to-end.
 */
import { detectConversation } from '../extractor/conversation';
import { runDiagnostics, type DiagnosticsReport } from '../extractor/diagnostics';
import { findMessageList, parseRenderedConversation } from '../extractor/page-parser';
import { buildSelectorProfile, type SelectorProfile } from '../extractor/selectors';
import { ScrapeControl, sleep } from '../scraper/control';
import { runScrape, type EngineProgress, type EngineResult, type EngineSink } from '../scraper/engine';
import type { ImageReader, ImageSaveResult } from '../scraper/images';
import { findScrollContainer } from '../scraper/scroll-driver';
import {
  HEARTBEAT_INTERVAL_MS,
  IMAGE_REQUEST_CHARS,
  type ActiveSessionInfo,
  type BackgroundRequest,
  type ContentStatus,
  type FinishedSessionInfo,
  type SessionBatchResponse,
  type SessionBeginResponse,
  type SessionImagePartResponse,
  type SessionImagesResponse,
} from '../shared/protocol';
import type { ScrapeSettings } from '../shared/settings';
import { resolveDateOrder } from '../shared/time';
import { emptyCounters, type CapturedImage, type ScrapeMode } from '../shared/types';

export interface ContentControllerDeps {
  doc: Document;
  getHref: () => string;
  /** Sends a request to the background worker; rejects with the reported error. */
  send: <T>(request: BackgroundRequest) => Promise<T>;
  loadSettings: () => Promise<ScrapeSettings>;
  locale?: string;
  now?: () => number;
  heartbeatMs?: number;
  /** Delays between retries of failed background calls (ms). */
  retryDelaysMs?: number[];
  /** Reads displayed images; without it no images are saved. */
  imageReader?: ImageReader;
  /** Most base64 characters per image request (larger images are sent in parts). */
  imageRequestChars?: number;
}

export interface StartCommand {
  mode: ScrapeMode;
  rescan: boolean;
  resumeOf: string | null;
}

const DEFAULT_RETRY_DELAYS = [250, 750, 2000, 4000];

function isPermanentError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /context invalidated|Invalid request|Unknown session|does not match|does not belong/i.test(message);
}

export class ContentController {
  private control: ScrapeControl | null = null;
  private session: ActiveSessionInfo | null = null;
  private progress: EngineProgress | null = null;
  private lastResult: FinishedSessionInfo | null = null;
  private running: Promise<void> | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private readonly now: () => number;

  constructor(private readonly deps: ContentControllerDeps) {
    this.now = deps.now ?? (() => Date.now());
  }

  private profileFrom(settings: ScrapeSettings): SelectorProfile {
    return buildSelectorProfile(settings.selectorOverrides);
  }

  async status(): Promise<ContentStatus> {
    let conversation = this.session?.conversation ?? null;
    let conversationError: string | null = null;
    let visibleMessages: number | null = null;
    if (!this.control) {
      try {
        const settings = await this.deps.loadSettings();
        const profile = this.profileFrom(settings);
        conversation = detectConversation(this.deps.doc, this.deps.getHref(), profile);
        if (conversation) {
          visibleMessages = parseRenderedConversation(this.deps.doc, {
            profile,
            conversation,
            selfDisplayName: settings.selfDisplayName || null,
            referenceMs: this.now(),
            dateOrder: resolveDateOrder(settings.dateOrder, this.deps.locale),
          }).messages.length;
        }
      } catch (error) {
        conversationError = error instanceof Error ? error.message : String(error);
      }
    }
    return {
      state: this.control ? (this.control.state === 'stopping' ? 'stopping' : this.control.state) : 'idle',
      conversation,
      conversationError,
      visibleMessages,
      session: this.session,
      progress: this.progress,
      lastResult: this.lastResult,
    };
  }

  async start(command: StartCommand): Promise<{ sessionId: string }> {
    if (this.control) throw new Error('An extraction is already running in this tab.');
    const settings = await this.deps.loadSettings();
    const profile = this.profileFrom(settings);
    const doc = this.deps.doc;
    const conversation = detectConversation(doc, this.deps.getHref(), profile);
    if (!conversation) throw new Error('No conversation detected. Open a chat in Teams first.');
    if (!findMessageList(doc, profile)) throw new Error('The message list was not found on this page. Run Diagnostics from the popup.');

    const control = new ScrapeControl();
    this.control = control;
    this.progress = null;
    let begin: SessionBeginResponse;
    try {
      begin = await this.sendWithRetry<SessionBeginResponse>({
        type: 'session/begin',
        conversation,
        mode: command.mode,
        rescan: command.rescan,
        resumeOf: command.resumeOf,
      });
    } catch (error) {
      this.control = null;
      throw error;
    }
    const { sessionId } = begin;
    this.session = { sessionId, mode: command.mode, rescan: command.rescan, startedAt: new Date(this.now()).toISOString(), conversation };

    const sink: EngineSink = {
      write: async (batch) => {
        const response = await this.sendWithRetry<SessionBatchResponse>({
          type: 'session/batch',
          sessionId,
          conversation,
          messages: batch.messages,
          segments: batch.segments,
          counters: batch.counters,
          warnings: this.progress?.warnings ?? [],
        });
        return response.statuses;
      },
      saveImages: (images) => this.sendImages(sessionId, conversation.conversationKey, images),
    };

    this.startHeartbeat(sessionId, control);
    this.running = runScrape({
      doc,
      profile,
      settings,
      mode: command.mode,
      rescan: command.rescan,
      conversation,
      coverage: begin.coverage,
      sink,
      control,
      dateOrder: resolveDateOrder(settings.dateOrder, this.deps.locale),
      selfDisplayName: settings.selfDisplayName || null,
      detectConversation: () => detectConversation(doc, this.deps.getHref(), profile),
      imageReader: this.deps.imageReader,
      now: this.now,
      onProgress: (progress) => {
        this.progress = progress;
      },
    })
      .catch((error: unknown): EngineResult => ({
        status: 'failed',
        stopReason: 'error',
        error: error instanceof Error ? error.message : String(error),
        counters: this.progress?.counters ?? emptyCounters(),
        segments: [],
        warnings: this.progress?.warnings ?? [],
      }))
      .then((result) => this.finishSession(sessionId, command.mode, conversation.conversationKey, result))
      .finally(() => {
        this.stopHeartbeat();
        this.control = null;
        this.session = null;
      });
    return { sessionId };
  }

  pause(): boolean {
    return this.control?.pause() ?? false;
  }

  resume(): boolean {
    return this.control?.resume() ?? false;
  }

  stop(): boolean {
    if (!this.control) return false;
    this.control.stop();
    return true;
  }

  /** Resolves when the current run (if any) has finished and been recorded. */
  async whenIdle(): Promise<FinishedSessionInfo | null> {
    await this.running;
    return this.lastResult;
  }

  async diagnostics(): Promise<DiagnosticsReport> {
    const settings = await this.deps.loadSettings();
    const profile = this.profileFrom(settings);
    const doc = this.deps.doc;
    const conversation = detectConversation(doc, this.deps.getHref(), profile);
    const list = findMessageList(doc, profile);
    return runDiagnostics(doc, {
      profile,
      conversation,
      href: this.deps.getHref(),
      selfDisplayName: settings.selfDisplayName || null,
      dateOrder: resolveDateOrder(settings.dateOrder, this.deps.locale),
      referenceMs: this.now(),
      scrollContainer: list ? findScrollContainer(doc, profile, list) : null,
    });
  }

  private async finishSession(sessionId: string, mode: ScrapeMode, conversationKey: string, result: EngineResult): Promise<void> {
    // No heartbeat may follow the end report (the background also ignores late ones).
    this.stopHeartbeat();
    this.lastResult = { ...result, sessionId, mode, conversationKey, endedAt: new Date(this.now()).toISOString() };
    try {
      await this.sendWithRetry({
        type: 'session/end',
        sessionId,
        conversationKey,
        status: result.status,
        stopReason: result.stopReason,
        error: result.error,
        counters: result.counters,
        segments: result.segments,
        warnings: result.warnings,
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.lastResult = { ...this.lastResult, error: this.lastResult.error ?? `The session end could not be recorded: ${reason}` };
    }
  }

  /**
   * Sends images to the background: small ones together, up to the request size, and each image
   * too large for one request in parts. A request that fails marks its images as not saved.
   */
  private async sendImages(sessionId: string, conversationKey: string, images: CapturedImage[]): Promise<ImageSaveResult> {
    const budget = Math.max(4, this.deps.imageRequestChars ?? IMAGE_REQUEST_CHARS);
    const result: ImageSaveResult = { saved: [], rejected: {} };
    let group: CapturedImage[] = [];
    let groupChars = 0;
    const flush = async () => {
      if (group.length === 0) return;
      const sending = group;
      group = [];
      groupChars = 0;
      try {
        const response = await this.sendWithRetry<SessionImagesResponse>({ type: 'session/images', sessionId, conversationKey, images: sending });
        result.saved.push(...Object.keys(response.statuses));
        Object.assign(result.rejected, response.rejected);
      } catch (error) {
        for (const image of sending) result.rejected[image.imageId] = error instanceof Error ? error.message : String(error);
      }
    };
    for (const image of images) {
      if (image.dataBase64.length > budget) {
        await flush();
        const outcome = await this.sendImageInParts(sessionId, conversationKey, image, budget);
        if (outcome === null) result.saved.push(image.imageId);
        else result.rejected[image.imageId] = outcome;
        continue;
      }
      if (groupChars + image.dataBase64.length > budget) await flush();
      group.push(image);
      groupChars += image.dataBase64.length;
    }
    await flush();
    return result;
  }

  /** Sends one image in parts; resolves to null when stored, else to the reason it was not. */
  private async sendImageInParts(sessionId: string, conversationKey: string, image: CapturedImage, budget: number): Promise<string | null> {
    const { dataBase64, ...info } = image;
    const partChars = budget - (budget % 4);
    const count = Math.ceil(dataBase64.length / partChars);
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        let restart = false;
        for (let index = 0; index < count && !restart; index++) {
          const response = await this.sendWithRetry<SessionImagePartResponse>({
            type: 'session/image-part',
            sessionId,
            conversationKey,
            image: info,
            index,
            count,
            dataBase64: dataBase64.slice(index * partChars, (index + 1) * partChars),
          });
          if (response.status === 'inserted' || response.status === 'unchanged') return null;
          if (response.status === 'rejected') return response.reason ?? 'refused by the archive';
          restart = response.status === 'restart';
        }
        if (!restart) break;
      }
      return 'the upload was interrupted';
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  private startHeartbeat(sessionId: string, control: ScrapeControl): void {
    this.stopHeartbeat();
    this.heartbeat = setInterval(() => {
      if (control.state === 'stopping') return;
      this.deps
        .send({
          type: 'session/heartbeat',
          sessionId,
          status: control.state === 'paused' ? 'paused' : 'running',
          counters: this.progress?.counters ?? emptyCounters(),
        })
        .catch(() => undefined);
    }, this.deps.heartbeatMs ?? HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeat !== null) clearInterval(this.heartbeat);
    this.heartbeat = null;
  }

  private async sendWithRetry<T>(request: BackgroundRequest): Promise<T> {
    const delays = this.deps.retryDelaysMs ?? DEFAULT_RETRY_DELAYS;
    let lastError: unknown;
    for (let attempt = 0; attempt <= delays.length; attempt++) {
      try {
        return await this.deps.send<T>(request);
      } catch (error) {
        lastError = error;
        if (isPermanentError(error) || attempt === delays.length) break;
        await sleep(delays[attempt] as number);
      }
    }
    const message = lastError instanceof Error ? lastError.message : String(lastError);
    if (/context invalidated/i.test(message)) {
      throw new Error('The extension was reloaded or updated. Reload this Teams tab to continue (progress so far is saved).');
    }
    throw lastError instanceof Error ? lastError : new Error(message);
  }
}
