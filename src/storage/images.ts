/** Turning validated image payloads (from the Teams tab or an import) into archive records. */
import { decodeImagePayload, IMAGE_ID_PATTERN, imageKey, MAX_IMAGE_BYTES, toArrayBuffer } from '../shared/images';
import { ARCHIVE_SCHEMA_VERSION, type CapturedImage, type ImageSaveStatus, type StoredImage } from '../shared/types';
import type { ArchiveRepository } from './repository';

export interface ImageRecordContext {
  sessionId: string | null;
  nowIso: string;
}

export function toStoredImage(
  conversationKey: string,
  image: Omit<CapturedImage, 'dataBase64'>,
  bytes: Uint8Array,
  ctx: ImageRecordContext,
): StoredImage {
  return {
    key: imageKey(conversationKey, image.imageId),
    conversationKey,
    imageId: image.imageId,
    mimeType: image.mimeType,
    byteLength: bytes.byteLength,
    width: image.width ?? null,
    height: image.height ?? null,
    method: image.method,
    data: toArrayBuffer(bytes),
    firstSavedAt: ctx.nowIso,
    sessionId: ctx.sessionId,
    schemaVersion: ARCHIVE_SCHEMA_VERSION,
  };
}

export interface SaveCapturedImagesResult {
  statuses: Record<string, ImageSaveStatus>;
  /** Image id (or `images[<index>]` when the id itself is invalid) → reason. */
  rejected: Record<string, string>;
}

/**
 * Validates captured images (well-formed, `image/*`, within the size limit, SHA-256 equal to
 * the id) and stores the valid ones. Invalid images are reported, never thrown, so one bad
 * image cannot stop an extraction run.
 */
export async function saveCapturedImages(
  repository: ArchiveRepository,
  conversationKey: string,
  images: readonly unknown[],
  ctx: ImageRecordContext & { maxBytes?: number },
): Promise<SaveCapturedImagesResult> {
  const rejected: Record<string, string> = {};
  const records: StoredImage[] = [];
  const maxBytes = Math.min(ctx.maxBytes ?? MAX_IMAGE_BYTES, MAX_IMAGE_BYTES);
  for (const [index, image] of images.entries()) {
    const decoded = await decodeImagePayload(image, maxBytes);
    const imageId = (image as { imageId?: unknown } | null)?.imageId;
    const id = typeof imageId === 'string' && IMAGE_ID_PATTERN.test(imageId) ? imageId : `images[${index}]`;
    if (!decoded.ok) rejected[id] = decoded.error;
    else records.push(toStoredImage(conversationKey, image as CapturedImage, decoded.bytes, ctx));
  }
  const statuses = await repository.putImages(conversationKey, records);
  return { statuses, rejected };
}
