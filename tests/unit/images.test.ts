import { afterEach, describe, expect, it } from 'vitest';
import { createPageImageReader } from '../../src/content/image-reader';
import { messageSignature } from '../../src/scraper/engine';
import {
  base64ToBytes,
  bytesToBase64,
  decodeImagePayload,
  imageFileName,
  imageKey,
  normalizeImageMimeType,
  sha256Hex,
  sniffImageMimeType,
} from '../../src/shared/images';
import type { CapturedImage } from '../../src/shared/types';
import { fakeImageBytes } from '../helpers/images';
import { message } from '../helpers/messages';

afterEach(() => {
  document.body.innerHTML = '';
});

async function payload(bytes: Uint8Array, overrides: Partial<CapturedImage> = {}): Promise<CapturedImage> {
  return {
    imageId: await sha256Hex(bytes),
    mimeType: 'image/png',
    byteLength: bytes.byteLength,
    width: 10,
    height: 5,
    method: 'fetch',
    dataBase64: bytesToBase64(bytes),
    ...overrides,
  };
}

describe('image helpers', () => {
  it('hashes with SHA-256 and round-trips base64 of any length', async () => {
    expect(await sha256Hex(new TextEncoder().encode('abc'))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    for (const size of [0, 1, 2, 3, 4, 100, 70_000]) {
      const bytes = fakeImageBytes(`x${size}`, size).subarray(0, size);
      const encoded = bytesToBase64(bytes);
      expect(encoded).toBe(Buffer.from(bytes).toString('base64'));
      expect(base64ToBytes(encoded)).toEqual(new Uint8Array(bytes));
    }
    expect(() => base64ToBytes('abc')).toThrow(/Invalid base64/);
    expect(() => base64ToBytes('ab$=')).toThrow(/Invalid base64/);
  });

  it('recognises image types and names saved image files', () => {
    expect(sniffImageMimeType(fakeImageBytes('a'))).toBe('image/png');
    expect(sniffImageMimeType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0]))).toBe('image/jpeg');
    expect(sniffImageMimeType(new TextEncoder().encode('GIF89a......'))).toBe('image/gif');
    expect(sniffImageMimeType(new TextEncoder().encode('RIFF\0\0\0\0WEBPVP8 '))).toBe('image/webp');
    expect(sniffImageMimeType(new TextEncoder().encode('<!doctype html>'))).toBeNull();
    expect(normalizeImageMimeType('Image/PNG; charset=binary')).toBe('image/png');
    expect(normalizeImageMimeType('text/html')).toBeNull();
    expect(normalizeImageMimeType(null)).toBeNull();
    expect(imageFileName({ imageId: 'ab12', mimeType: 'image/jpeg' })).toBe('ab12.jpg');
    expect(imageFileName({ imageId: 'ab12', mimeType: 'image/x-unknown' })).toBe('ab12.img');
    expect(imageKey('teams:19:x@thread.v2', 'ab12')).toBe('teams:19:x@thread.v2#img:ab12');
  });

  it('accepts only well-formed images whose bytes match their id', async () => {
    const bytes = fakeImageBytes('photo', 300);
    const valid = await payload(bytes);
    const decoded = await decodeImagePayload(valid);
    expect(decoded.ok && Array.from(decoded.bytes)).toEqual(Array.from(bytes));

    const other = await sha256Hex(fakeImageBytes('other'));
    const problems = await Promise.all([
      decodeImagePayload({ ...valid, imageId: other }),
      decodeImagePayload({ ...valid, imageId: 'ABC' }),
      decodeImagePayload({ ...valid, mimeType: 'text/html' }),
      decodeImagePayload({ ...valid, byteLength: 299 }),
      decodeImagePayload({ ...valid, dataBase64: '!!!!' }),
      decodeImagePayload({ ...valid, method: 'screenshot' as never }),
      decodeImagePayload({ ...valid, width: -1 }),
      decodeImagePayload(valid, 200),
      decodeImagePayload(null),
    ]);
    expect(problems.map((result) => (result.ok ? 'ok' : result.error))).toEqual([
      'imageId does not match the SHA-256 of the data',
      'imageId must be a lower-case SHA-256 hex string',
      'mimeType "text/html" is not an image type',
      'byteLength 299 does not match the data (300 bytes)',
      'dataBase64 is not valid base64',
      'method must be "fetch" or "canvas"',
      'width and height must be positive integers or null',
      'the image (300 bytes) is larger than 200 bytes',
      'image must be an object',
    ]);
  });

  it('sends a message again once the id of one of its images is known', () => {
    const observed = message({ attachments: [{ kind: 'image', name: 'image', url: null }] });
    const saved = { ...observed, attachments: [{ kind: 'image' as const, name: 'image', url: null, imageId: 'a'.repeat(64) }] };
    expect(messageSignature(saved)).not.toBe(messageSignature(observed));
    expect(messageSignature(structuredClone(saved))).toBe(messageSignature(saved));
  });
});

// ------------------------------------------------------------- page reader

function displayedImage(src: string, size: { width: number; height: number } | null = { width: 40, height: 20 }): HTMLImageElement {
  const img = document.createElement('img');
  img.setAttribute('src', src);
  document.body.append(img);
  Object.defineProperty(img, 'complete', { configurable: true, get: () => size !== null });
  Object.defineProperty(img, 'naturalWidth', { configurable: true, get: () => size?.width ?? 0 });
  Object.defineProperty(img, 'naturalHeight', { configurable: true, get: () => size?.height ?? 0 });
  Object.defineProperty(img, 'currentSrc', { configurable: true, get: () => src });
  return img;
}

function fakeCanvas(behaviour: 'ok' | 'tainted') {
  const drawn: unknown[] = [];
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => ({ drawImage: (image: unknown) => drawn.push(image) }),
    toBlob: (callback: (blob: Blob | null) => void, type: string) => {
      if (behaviour === 'tainted') throw new DOMException('Tainted canvases may not be exported.', 'SecurityError');
      callback(new Blob([fakeImageBytes('canvas', 50)], { type }));
    },
  };
  return { canvas, drawn };
}

describe('page image reader', () => {
  const ORIGIN = 'https://teams.microsoft.com';

  it('fetches blob: images (the copy Teams displays) and keeps their type and size', async () => {
    const bytes = fakeImageBytes('blob-image', 120);
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const reader = createPageImageReader({
      origin: ORIGIN,
      fetch: async (url, init) => {
        requests.push({ url, init });
        return new Response(bytes, { headers: { 'content-type': 'image/jpeg' } });
      },
    });
    const outcome = await reader.read(displayedImage('blob:https://teams.microsoft.com/1234'), { maxBytes: 1000 });
    expect(outcome).toEqual({ status: 'ok', image: { bytes: new Uint8Array(bytes), mimeType: 'image/jpeg', width: 40, height: 20, method: 'fetch' } });
    expect(requests).toEqual([{ url: 'blob:https://teams.microsoft.com/1234', init: { cache: 'force-cache' } }]);
  });

  it('retries other sites without cookies, sniffs untyped responses and enforces the size limit', async () => {
    const bytes = fakeImageBytes('cdn', 64);
    const credentials: Array<RequestCredentials | undefined> = [];
    const reader = createPageImageReader({
      origin: ORIGIN,
      fetch: async (_url, init) => {
        credentials.push(init?.credentials);
        if (init?.credentials === 'include') throw new TypeError('Failed to fetch');
        return new Response(bytes, { headers: { 'content-type': 'application/octet-stream' } });
      },
    });
    const outcome = await reader.read(displayedImage('https://cdn.example.invalid/a'), { maxBytes: 1000 });
    expect(outcome).toMatchObject({ status: 'ok', image: { mimeType: 'image/png', method: 'fetch' } });
    expect(credentials).toEqual(['include', 'omit']);

    const big = createPageImageReader({ origin: ORIGIN, fetch: async () => new Response(bytes, { headers: { 'content-length': '5000' } }) });
    expect(await big.read(displayedImage('https://cdn.example.invalid/b'), { maxBytes: 1000 })).toEqual({ status: 'too-large', byteLength: 5000 });
  });

  it('draws the displayed picture on a canvas when it cannot be fetched, unless the canvas is tainted', async () => {
    const offline = async () => {
      throw new TypeError('Failed to fetch');
    };
    const ok = fakeCanvas('ok');
    const reader = createPageImageReader({ origin: ORIGIN, fetch: offline, createCanvas: () => ok.canvas as unknown as HTMLCanvasElement });
    const img = displayedImage('https://cdn.example.invalid/c');
    const outcome = await reader.read(img, { maxBytes: 1000 });
    expect(outcome).toMatchObject({ status: 'ok', image: { mimeType: 'image/png', width: 40, height: 20, method: 'canvas' } });
    expect(ok.drawn).toEqual([img]);
    expect(ok.canvas).toMatchObject({ width: 40, height: 20 });

    const tainted = fakeCanvas('tainted');
    const blocked = createPageImageReader({ origin: ORIGIN, fetch: offline, createCanvas: () => tainted.canvas as unknown as HTMLCanvasElement });
    expect(await blocked.read(displayedImage('https://cdn.example.invalid/d'), { maxBytes: 1000 })).toEqual({
      status: 'failed',
      reason: 'the browser does not allow reading this image (it comes from another site)',
    });
  });

  it('reports images that have not loaded as pending', async () => {
    const reader = createPageImageReader({ origin: ORIGIN, loadTimeoutMs: 10, fetch: async () => new Response(fakeImageBytes('x')) });
    expect(await reader.read(displayedImage('https://cdn.example.invalid/e', null), { maxBytes: 1000 })).toEqual({ status: 'pending' });
    expect(await reader.read(document.createElement('div'), { maxBytes: 1000 })).toMatchObject({ status: 'failed' });
  });
});
