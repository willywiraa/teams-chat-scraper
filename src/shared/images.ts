/**
 * Helpers for saved images: base64 transport encoding, SHA-256 ids, MIME types and the
 * validation applied to every image that enters the archive (from the Teams tab or an import).
 * Pure functions apart from `crypto.subtle`, which exists in extension pages, workers and tests.
 */
import { SETTING_LIMITS } from './settings';
import type { CapturedImage } from './types';

export const BYTES_PER_MB = 1024 * 1024;

/** Upper bound for any stored image, whatever the user's `maxImageMB` setting. */
export const MAX_IMAGE_BYTES = SETTING_LIMITS.maxImageMB[1] * BYTES_PER_MB;

export const IMAGE_ID_PATTERN = /^[0-9a-f]{64}$/;

const MIME_PATTERN = /^image\/[a-z0-9][a-z0-9.+-]*$/;

/** Archive key of a saved image: `<conversationKey>#img:<imageId>`. */
export function imageKey(conversationKey: string, imageId: string): string {
  return `${conversationKey}#img:${imageId}`;
}

export function isImageMimeType(value: unknown): value is string {
  return typeof value === 'string' && MIME_PATTERN.test(value);
}

/** `image/PNG; charset=x` → `image/png`; anything that is not an image type → null. */
export function normalizeImageMimeType(value: string | null | undefined): string | null {
  const type = (value ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  return isImageMimeType(type) ? type : null;
}

/** Recognises common image formats by their first bytes (for servers that send no image type). */
export function sniffImageMimeType(bytes: Uint8Array): string | null {
  const at = (index: number) => bytes[index] ?? -1;
  const ascii = (start: number, text: string) => Array.from(text).every((ch, i) => at(start + i) === ch.charCodeAt(0));
  if (at(0) === 0x89 && ascii(1, 'PNG\r\n')) return 'image/png';
  if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return 'image/jpeg';
  if (ascii(0, 'GIF87a') || ascii(0, 'GIF89a')) return 'image/gif';
  if (ascii(0, 'RIFF') && ascii(8, 'WEBP')) return 'image/webp';
  if (ascii(4, 'ftypavif') || ascii(4, 'ftypavis')) return 'image/avif';
  if (ascii(4, 'ftypheic') || ascii(4, 'ftypheix') || ascii(4, 'ftypmif1')) return 'image/heic';
  if (ascii(0, 'BM') && bytes.length > 26) return 'image/bmp';
  return null;
}

const EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'image/heic': 'heic',
  'image/bmp': 'bmp',
  'image/svg+xml': 'svg',
  'image/tiff': 'tiff',
  'image/x-icon': 'ico',
  'image/vnd.microsoft.icon': 'ico',
};

/** File name used when a saved image is downloaded, and in Markdown exports: `<imageId>.<ext>`. */
export function imageFileName(image: { imageId: string; mimeType: string }): string {
  return `${image.imageId}.${EXTENSIONS[image.mimeType.toLowerCase()] ?? 'img'}`;
}

export function bytesToBase64(bytes: Uint8Array): string {
  const native = (bytes as Uint8Array & { toBase64?: () => string }).toBase64;
  if (typeof native === 'function') return native.call(bytes);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;

/** Decodes standard (padded) base64; throws on anything else. */
export function base64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
  if (base64.length % 4 !== 0 || !BASE64_PATTERN.test(base64)) throw new Error('Invalid base64 data');
  const native = (Uint8Array as unknown as { fromBase64?: (text: string) => Uint8Array<ArrayBuffer> }).fromBase64;
  if (typeof native === 'function') return native(base64);
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** The bytes as a stand-alone ArrayBuffer (what IndexedDB stores). */
export function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  if (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength && bytes.buffer instanceof ArrayBuffer) return bytes.buffer;
  return bytes.slice().buffer as ArrayBuffer;
}

function isDimension(value: unknown): boolean {
  return value === null || value === undefined || (Number.isInteger(value) && (value as number) > 0);
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < BYTES_PER_MB / 10) return `${Math.round(bytes / 1024)} KB`;
  return `${Math.round((bytes / BYTES_PER_MB) * 10) / 10} MB`;
}

/** Checks the descriptive fields of an image payload; returns the problem, or null when valid. */
export function imageMetadataError(image: unknown, maxBytes: number = MAX_IMAGE_BYTES): string | null {
  if (!image || typeof image !== 'object') return 'image must be an object';
  const candidate = image as Partial<Record<keyof CapturedImage, unknown>>;
  if (typeof candidate.imageId !== 'string' || !IMAGE_ID_PATTERN.test(candidate.imageId)) return 'imageId must be a lower-case SHA-256 hex string';
  if (!isImageMimeType(candidate.mimeType)) return `mimeType "${String(candidate.mimeType).slice(0, 60)}" is not an image type`;
  if (!Number.isInteger(candidate.byteLength) || (candidate.byteLength as number) <= 0) return 'byteLength must be a positive integer';
  if ((candidate.byteLength as number) > maxBytes) return `the image (${formatSize(candidate.byteLength as number)}) is larger than ${formatSize(maxBytes)}`;
  if (!isDimension(candidate.width) || !isDimension(candidate.height)) return 'width and height must be positive integers or null';
  if (candidate.method !== 'fetch' && candidate.method !== 'canvas') return 'method must be "fetch" or "canvas"';
  if (typeof candidate.dataBase64 !== 'string') return 'dataBase64 must be a string';
  return null;
}

export type DecodedImage = { ok: true; bytes: Uint8Array<ArrayBuffer> } | { ok: false; error: string };

/** Checks that image bytes (read from a file) are what the image's fields say; returns the problem, or null. */
export async function imageBytesError(image: { imageId: string; byteLength: number }, bytes: Uint8Array): Promise<string | null> {
  if (bytes.byteLength !== image.byteLength) return `byteLength ${image.byteLength} does not match the data (${bytes.byteLength} bytes)`;
  if ((await sha256Hex(bytes)) !== image.imageId) return 'imageId does not match the SHA-256 of the data';
  return null;
}

/**
 * Validates an image sent as base64 and decodes it: the fields must be well formed, the data
 * must have the stated length, and its SHA-256 must equal `imageId`.
 */
export async function decodeImagePayload(image: unknown, maxBytes: number = MAX_IMAGE_BYTES): Promise<DecodedImage> {
  const error = imageMetadataError(image, maxBytes);
  if (error) return { ok: false, error };
  const payload = image as CapturedImage;
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = base64ToBytes(payload.dataBase64);
  } catch {
    return { ok: false, error: 'dataBase64 is not valid base64' };
  }
  if (bytes.byteLength !== payload.byteLength) {
    return { ok: false, error: `byteLength ${payload.byteLength} does not match the data (${bytes.byteLength} bytes)` };
  }
  if ((await sha256Hex(bytes)) !== payload.imageId) return { ok: false, error: 'imageId does not match the SHA-256 of the data' };
  return { ok: true, bytes };
}
