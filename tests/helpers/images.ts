/** A fake image reader for tests: serves deterministic bytes per image address. */
import { imageSource, type ImageReader, type ImageReadOutcome } from '../../src/scraper/images';
import { sha256Hex } from '../../src/shared/images';

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** PNG-looking bytes that differ per address (`size` bytes long). */
export function fakeImageBytes(src: string, size = 64): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(Math.max(size, PNG_SIGNATURE.length + 1));
  bytes.set(PNG_SIGNATURE);
  // FNV-1a of the address seeds an xorshift generator (every bit of the seed affects every byte).
  let state = 2166136261;
  for (const ch of src) state = Math.imul(state ^ ch.charCodeAt(0), 16777619);
  state = state >>> 0 || 1;
  for (let i = PNG_SIGNATURE.length; i < bytes.length; i++) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    bytes[i] = state & 0xff;
  }
  return bytes;
}

export function imageIdOf(src: string, size?: number): Promise<string> {
  return sha256Hex(fakeImageBytes(src, size));
}

export type FakeBehaviour = (src: string, attempt: number) => ImageReadOutcome | Promise<ImageReadOutcome>;

export function okImage(src: string, size?: number): ImageReadOutcome {
  return { status: 'ok', image: { bytes: fakeImageBytes(src, size), mimeType: 'image/png', width: 32, height: 16, method: 'fetch' } };
}

export class FakeImageReader implements ImageReader {
  /** Number of reads per image address. */
  readonly reads = new Map<string, number>();

  constructor(private readonly behaviour: FakeBehaviour = (src) => okImage(src)) {}

  get totalReads(): number {
    return [...this.reads.values()].reduce((sum, count) => sum + count, 0);
  }

  async read(element: Element): Promise<ImageReadOutcome> {
    const src = imageSource(element);
    const attempt = (this.reads.get(src) ?? 0) + 1;
    this.reads.set(src, attempt);
    return this.behaviour(src, attempt);
  }
}
