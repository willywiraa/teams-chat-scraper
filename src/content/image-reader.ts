/**
 * Reads the bytes of an image displayed in the Teams tab: first by fetching its address again
 * (`blob:` and `data:` addresses, or the browser cache for web addresses), then, if that is not
 * possible, by drawing the displayed picture on a canvas. A canvas cannot be read when the image
 * came from another site without permission (a "tainted" canvas); such images are reported as
 * failed. Uses DOM APIs only; fetch and canvas are injectable for tests.
 */
import type { ImageReader, ImageReadOutcome, ReadImage } from '../scraper/images';
import { normalizeImageMimeType, sniffImageMimeType } from '../shared/images';

export interface PageImageReaderOptions {
  fetch?: (input: string, init?: RequestInit) => Promise<Response>;
  createCanvas?: () => HTMLCanvasElement;
  /** Origin of the Teams page (requests to it send cookies). Default: `location.origin`. */
  origin?: string;
  /** How long to wait for an image that is still loading (ms). */
  loadTimeoutMs?: number;
}

const DEFAULT_LOAD_TIMEOUT_MS = 4000;
/** Larger pictures are not drawn on a canvas (memory). */
const MAX_CANVAS_PIXELS = 50_000_000;
const SUPPORTED_PROTOCOLS = new Set(['http:', 'https:', 'blob:', 'data:']);

type FetchResult = ImageReadOutcome | { status: 'unavailable' };

function waitForLoad(img: HTMLImageElement, timeoutMs: number): Promise<boolean> {
  if (img.complete) return Promise.resolve(img.naturalWidth > 0);
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      img.removeEventListener('load', done);
      img.removeEventListener('error', done);
      resolve(img.complete && img.naturalWidth > 0);
    };
    const timer = setTimeout(done, timeoutMs);
    img.addEventListener('load', done);
    img.addEventListener('error', done);
  });
}

function isSecurityError(error: unknown): boolean {
  return (error as { name?: unknown } | null)?.name === 'SecurityError';
}

export function createPageImageReader(options: PageImageReaderOptions = {}): ImageReader {
  const doFetch = options.fetch ?? ((input: string, init?: RequestInit) => fetch(input, init));
  const createCanvas = options.createCanvas ?? (() => document.createElement('canvas'));
  const loadTimeoutMs = options.loadTimeoutMs ?? DEFAULT_LOAD_TIMEOUT_MS;

  async function fetchImage(src: string, maxBytes: number, size: Pick<ReadImage, 'width' | 'height'>): Promise<FetchResult> {
    let url: URL;
    try {
      url = new URL(src);
    } catch {
      return { status: 'unavailable' };
    }
    if (!SUPPORTED_PROTOCOLS.has(url.protocol)) return { status: 'failed', reason: `unsupported image address (${url.protocol})` };
    const origin = options.origin ?? globalThis.location?.origin;
    const local = url.protocol === 'blob:' || url.protocol === 'data:' || url.origin === origin;
    // Prefer the cached copy the page already shows; for other sites try with, then without, cookies.
    const attempts: RequestInit[] = local
      ? [{ cache: 'force-cache' }]
      : [
          { cache: 'force-cache', credentials: 'include', mode: 'cors' },
          { cache: 'force-cache', credentials: 'omit', mode: 'cors' },
        ];
    for (const init of attempts) {
      let response: Response;
      try {
        response = await doFetch(src, init);
      } catch {
        continue;
      }
      if (!response.ok) continue;
      const declared = Number(response.headers.get('content-length') ?? '');
      if (Number.isFinite(declared) && declared > maxBytes) return { status: 'too-large', byteLength: declared };
      const blob = await response.blob();
      if (blob.size > maxBytes) return { status: 'too-large', byteLength: blob.size };
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const mimeType = normalizeImageMimeType(blob.type || response.headers.get('content-type')) ?? sniffImageMimeType(bytes);
      // Not an image (for example a sign-in page): draw the displayed picture instead.
      if (!mimeType || bytes.byteLength === 0) return { status: 'unavailable' };
      return { status: 'ok', image: { bytes, mimeType, ...size, method: 'fetch' } };
    }
    return { status: 'unavailable' };
  }

  async function drawImage(img: HTMLImageElement, maxBytes: number): Promise<ImageReadOutcome> {
    const width = img.naturalWidth;
    const height = img.naturalHeight;
    if (!width || !height) return { status: 'failed', reason: 'the image has no size' };
    if (width * height > MAX_CANVAS_PIXELS) return { status: 'failed', reason: 'the image is too large to copy from the page' };
    try {
      const canvas = createCanvas();
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext('2d');
      if (!context) return { status: 'failed', reason: 'no canvas available' };
      context.drawImage(img, 0, 0);
      const blob = await new Promise<Blob | null>((resolve, reject) => {
        try {
          canvas.toBlob(resolve, 'image/png');
        } catch (error) {
          reject(error);
        }
      });
      if (!blob) return { status: 'failed', reason: 'the image could not be encoded' };
      if (blob.size > maxBytes) return { status: 'too-large', byteLength: blob.size };
      return { status: 'ok', image: { bytes: new Uint8Array(await blob.arrayBuffer()), mimeType: 'image/png', width, height, method: 'canvas' } };
    } catch (error) {
      if (isSecurityError(error)) return { status: 'failed', reason: 'the browser does not allow reading this image (it comes from another site)' };
      return { status: 'failed', reason: error instanceof Error ? error.message : String(error) };
    }
  }

  return {
    async read(element, { maxBytes }) {
      if (element.localName !== 'img') return { status: 'failed', reason: 'not an <img> element' };
      const img = element as HTMLImageElement;
      if (!(await waitForLoad(img, loadTimeoutMs))) return { status: 'pending' };
      const src = img.currentSrc || img.src;
      if (!src) return { status: 'pending' };
      const size = { width: img.naturalWidth || null, height: img.naturalHeight || null };
      const fetched = await fetchImage(src, maxBytes, size);
      if (fetched.status !== 'unavailable') return fetched;
      return drawImage(img, maxBytes);
    },
  };
}
