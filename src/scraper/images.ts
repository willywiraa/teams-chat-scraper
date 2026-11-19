/**
 * Saving the images displayed in messages. The engine hands every rendered image to
 * `ImageCapture`, which reads it once per session (through an injected `ImageReader`, so this
 * module never touches `chrome.*` and tests can fake the page), names it by the SHA-256 of its
 * bytes, has it stored, and sets `attachment.imageId` before the message batch is written.
 */
import type { RenderedImage } from '../extractor/page-parser';
import { BYTES_PER_MB, bytesToBase64, isImageMimeType, sha256Hex } from '../shared/images';
import type { Attachment, CapturedImage, ExtractedMessage, ImageCaptureMethod, SessionCounters } from '../shared/types';

export interface ReadImage {
  bytes: Uint8Array;
  mimeType: string;
  width: number | null;
  height: number | null;
  method: ImageCaptureMethod;
}

export type ImageReadOutcome =
  | { status: 'ok'; image: ReadImage }
  /** Not loaded (yet): tried again in a later pass. */
  | { status: 'pending' }
  | { status: 'too-large'; byteLength: number | null }
  | { status: 'failed'; reason: string };

export interface ImageReader {
  /** Reads the bytes of a displayed image (normally the copy already in the browser cache). */
  read(element: Element, options: { maxBytes: number }): Promise<ImageReadOutcome>;
}

export interface ImageSaveResult {
  /** Image ids now in the archive (newly stored or already there). */
  saved: string[];
  /** Image ids that could not be stored, with the reason. */
  rejected: Record<string, string>;
}

export interface ImageCaptureOptions {
  reader: ImageReader;
  maxBytes: number;
  /** Stores captured images; must resolve before messages referring to them are written. */
  save: (images: CapturedImage[]) => Promise<ImageSaveResult>;
  /** The session counters; `imagesSaved` and `imagesFailed` are updated in place. */
  counters: SessionCounters;
  warn: (message: string) => void;
}

/** Passes an image may stay unloaded before it counts as failed. */
export const MAX_PENDING_ATTEMPTS = 3;
const READ_CONCURRENCY = 3;

type SourceState = { state: 'saved'; imageId: string } | { state: 'failed' } | { state: 'pending'; attempts: number };

interface Target {
  element: Element;
  attachments: Attachment[];
}

/** The address an image was displayed from (the session cache key). */
export function imageSource(element: Element): string {
  const current = (element as Partial<HTMLImageElement>).currentSrc;
  if (typeof current === 'string' && current) return current;
  return element.getAttribute('src')?.trim() ?? '';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function forEachLimited<T>(items: readonly T[], limit: number, task: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const item = items[next++] as T;
      await task(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

export class ImageCapture {
  private readonly sources = new Map<string, SourceState>();
  private readonly savedIds = new Set<string>();
  private warnedRead = false;
  private warnedSave = false;

  constructor(private readonly options: ImageCaptureOptions) {}

  /**
   * Reads the images of one pass that were not read before, stores them, and sets `imageId` on
   * the attachments of every saved image (also those saved in earlier passes).
   */
  async capture(messages: readonly ExtractedMessage[], images: readonly RenderedImage[]): Promise<void> {
    const byKey = new Map(messages.map((message) => [message.key, message]));
    const targets = new Map<string, Target>();
    for (const image of images) {
      const attachment = byKey.get(image.messageKey)?.attachments[image.attachmentIndex];
      if (!attachment || attachment.kind !== 'image') continue;
      const src = imageSource(image.element);
      if (!src) continue;
      const known = this.sources.get(src);
      if (known?.state === 'saved') {
        attachment.imageId = known.imageId;
        continue;
      }
      if (known?.state === 'failed') continue;
      const target = targets.get(src);
      if (target) target.attachments.push(attachment);
      else targets.set(src, { element: image.element, attachments: [attachment] });
    }
    if (targets.size === 0) return;

    // Images are read in parallel, then handled in page order, so they are stored in a stable order.
    const sources = [...targets.keys()];
    const reads = new Map<string, { outcome: ImageReadOutcome; imageId: string | null }>();
    await forEachLimited(sources, READ_CONCURRENCY, async (src) => {
      const outcome = await this.read((targets.get(src) as Target).element);
      reads.set(src, { outcome, imageId: outcome.status === 'ok' ? await sha256Hex(outcome.image.bytes) : null });
    });

    const uploads = new Map<string, { image: CapturedImage; sources: string[] }>();
    for (const src of sources) {
      const { outcome, imageId } = reads.get(src) as { outcome: ImageReadOutcome; imageId: string | null };
      if (outcome.status === 'pending') {
        const previous = this.sources.get(src);
        const attempts = (previous?.state === 'pending' ? previous.attempts : 0) + 1;
        if (attempts >= MAX_PENDING_ATTEMPTS) this.fail(src, 'the image did not finish loading');
        else this.sources.set(src, { state: 'pending', attempts });
        continue;
      }
      if (outcome.status === 'too-large') {
        this.fail(src, null);
        this.options.warn(`Images larger than ${Math.round((this.options.maxBytes / BYTES_PER_MB) * 10) / 10} MB were not saved (their name and link are kept).`);
        continue;
      }
      if (outcome.status === 'failed' || imageId === null) {
        this.fail(src, outcome.status === 'failed' ? outcome.reason : null);
        continue;
      }
      const { bytes, ...info } = outcome.image;
      if (this.savedIds.has(imageId)) {
        this.markSaved(src, imageId, targets);
        continue;
      }
      const upload = uploads.get(imageId);
      if (upload) upload.sources.push(src);
      else uploads.set(imageId, { image: { imageId, ...info, byteLength: bytes.byteLength, dataBase64: bytesToBase64(bytes) }, sources: [src] });
    }
    if (uploads.size === 0) return;

    let result: ImageSaveResult;
    try {
      result = await this.options.save([...uploads.values()].map((upload) => upload.image));
    } catch (error) {
      result = { saved: [], rejected: Object.fromEntries([...uploads.keys()].map((imageId) => [imageId, errorMessage(error)])) };
    }
    const saved = new Set(result.saved);
    for (const [imageId, upload] of uploads) {
      if (saved.has(imageId)) {
        this.savedIds.add(imageId);
        this.options.counters.imagesSaved++;
        for (const src of upload.sources) this.markSaved(src, imageId, targets);
      } else {
        for (const src of upload.sources) this.fail(src, null);
        if (!this.warnedSave) {
          this.warnedSave = true;
          this.options.warn(`Some images could not be stored in the archive: ${result.rejected[imageId] ?? 'no reason given'}.`);
        }
      }
    }
  }

  /** Images still waiting to load when the session ends count as failed. */
  abandonPending(): void {
    for (const [src, state] of this.sources) {
      if (state.state === 'pending') this.fail(src, null);
    }
  }

  private markSaved(src: string, imageId: string, targets: Map<string, Target>): void {
    this.sources.set(src, { state: 'saved', imageId });
    for (const attachment of targets.get(src)?.attachments ?? []) attachment.imageId = imageId;
  }

  private fail(src: string, reason: string | null): void {
    this.sources.set(src, { state: 'failed' });
    this.options.counters.imagesFailed++;
    if (reason && !this.warnedRead) {
      this.warnedRead = true;
      this.options.warn(`Some displayed images could not be read and were not saved (for example: ${reason}). Their name and link are kept.`);
    }
  }

  private async read(element: Element): Promise<ImageReadOutcome> {
    const maxBytes = this.options.maxBytes;
    try {
      const outcome = await this.options.reader.read(element, { maxBytes });
      if (outcome.status !== 'ok') return outcome;
      const { bytes, mimeType } = outcome.image;
      if (bytes.byteLength > maxBytes) return { status: 'too-large', byteLength: bytes.byteLength };
      if (bytes.byteLength === 0) return { status: 'failed', reason: 'the image is empty' };
      if (!isImageMimeType(mimeType)) return { status: 'failed', reason: `the data is not an image (${mimeType || 'no type'})` };
      return outcome;
    } catch (error) {
      return { status: 'failed', reason: errorMessage(error) };
    }
  }
}
