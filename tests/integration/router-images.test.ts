/** Image requests at the background router: validation, storage and uploads in parts. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { handleBackgroundRequest, ImageUploads, type RouterDeps } from '../../src/background/router';
import { bytesToBase64, sha256Hex } from '../../src/shared/images';
import type { BackgroundRequest, CapturedImageInfo, SessionBeginResponse, SessionImagePartResponse, SessionImagesResponse } from '../../src/shared/protocol';
import type { CapturedImage } from '../../src/shared/types';
import type { ArchiveRepository } from '../../src/storage/repository';
import { openTestRepository } from '../helpers/fixtures';
import { fakeImageBytes } from '../helpers/images';
import { CK, CONVERSATION } from '../helpers/messages';

let repository: ArchiveRepository;
let deps: RouterDeps;
let sessionId: string;
let ids = 0;

beforeEach(async () => {
  repository = await openTestRepository();
  deps = {
    getRepository: async () => repository,
    now: () => new Date('2024-01-15T12:00:00.000Z'),
    newId: () => `session-${++ids}`,
    staleSessionMs: 90_000,
    imageUploads: new ImageUploads(),
    maxImageBytes: 1000,
  };
  sessionId = ((await send({ type: 'session/begin', conversation: CONVERSATION, mode: 'full', rescan: false, resumeOf: null })) as SessionBeginResponse).sessionId;
});

afterEach(() => repository.close());

/** Requests travel as JSON, like chrome.runtime messages. */
async function send(request: BackgroundRequest): Promise<unknown> {
  return JSON.parse(JSON.stringify(await handleBackgroundRequest(JSON.parse(JSON.stringify(request)), { tabId: 3 }, deps)));
}

async function captured(src: string, size = 120, overrides: Partial<CapturedImage> = {}): Promise<CapturedImage> {
  const bytes = fakeImageBytes(src, size);
  return { imageId: await sha256Hex(bytes), mimeType: 'image/png', byteLength: bytes.byteLength, width: 12, height: 10, method: 'canvas', dataBase64: bytesToBase64(bytes), ...overrides };
}

function part(image: CapturedImage, index: number, count: number, size: number): BackgroundRequest {
  const { dataBase64, ...info } = image;
  return { type: 'session/image-part', sessionId, conversationKey: CK, image: info as CapturedImageInfo, index, count, dataBase64: dataBase64.slice(index * size, (index + 1) * size) };
}

describe('session/images', () => {
  it('stores valid images idempotently and reports the invalid ones without failing', async () => {
    const good = await captured('good');
    const forged = { ...(await captured('forged')), imageId: (await captured('elsewhere')).imageId };
    const html = await captured('page', 120, { mimeType: 'text/html' });
    const big = await captured('big', 2000);
    const broken = { ...(await captured('broken')), dataBase64: '%%%%' };

    const response = (await send({ type: 'session/images', sessionId, conversationKey: CK, images: [good, forged, html, big, broken] })) as SessionImagesResponse;
    expect(response.statuses).toEqual({ [good.imageId]: 'inserted' });
    expect(response.rejected).toEqual({
      [forged.imageId]: 'imageId does not match the SHA-256 of the data',
      [html.imageId]: 'mimeType "text/html" is not an image type',
      [big.imageId]: 'the image (2 KB) is larger than 1000 bytes',
      [broken.imageId]: 'dataBase64 is not valid base64',
    });
    expect(await repository.getImage(CK, good.imageId)).toMatchObject({ sessionId, firstSavedAt: '2024-01-15T12:00:00.000Z', method: 'canvas', width: 12, height: 10 });

    const again = (await send({ type: 'session/images', sessionId, conversationKey: CK, images: [good] })) as SessionImagesResponse;
    expect(again).toEqual({ statuses: { [good.imageId]: 'unchanged' }, rejected: {} });
    expect(await repository.countImages(CK)).toBe(1);
  });

  it('refuses images for unknown sessions or another conversation', async () => {
    const image = await captured('x');
    await expect(send({ type: 'session/images', sessionId: 'nope', conversationKey: CK, images: [image] })).rejects.toThrow(/Unknown session nope/);
    await expect(send({ type: 'session/images', sessionId, conversationKey: 'teams:other', images: [image] })).rejects.toThrow(/does not match/);
    await expect(send({ type: 'session/images', sessionId, conversationKey: CK, images: 'x' as never })).rejects.toThrow(/images must be an array/);
    expect(await repository.countImages(CK)).toBe(0);
  });
});

describe('session/image-part', () => {
  it('assembles an image sent in parts and checks it once complete', async () => {
    const image = await captured('large', 600);
    const size = 200;
    const count = Math.ceil(image.dataBase64.length / size);
    expect(count).toBe(4);
    const statuses: string[] = [];
    for (let index = 0; index < count; index++) statuses.push(((await send(part(image, index, count, size))) as SessionImagePartResponse).status);
    expect(statuses).toEqual(['partial', 'partial', 'partial', 'inserted']);
    expect(new Uint8Array((await repository.getImage(CK, image.imageId))!.data)).toEqual(fakeImageBytes('large', 600));
    expect(deps.imageUploads?.size).toBe(0);
  });

  it('asks for a restart when a part is missing or the worker lost the upload', async () => {
    const image = await captured('restart', 600);
    expect(await send(part(image, 0, 4, 200))).toEqual({ status: 'partial' });
    expect(await send(part(image, 2, 4, 200))).toEqual({ status: 'restart' });
    // A restarted service worker has an empty upload buffer.
    deps.imageUploads = new ImageUploads();
    expect(await send(part(image, 1, 4, 200))).toEqual({ status: 'restart' });
    expect(await repository.countImages(CK)).toBe(0);
  });

  it('rejects parts of an image that is too large or does not match its id', async () => {
    const big = await captured('huge', 900, { byteLength: 5000 });
    expect(await send(part(big, 0, 4, 400))).toEqual({ status: 'rejected', reason: 'the image (5 KB) is larger than 1000 bytes' });
    const forged = { ...(await captured('forged', 300)), imageId: (await captured('other', 300)).imageId };
    expect(await send(part(forged, 0, 2, 200))).toEqual({ status: 'partial' });
    expect(await send(part(forged, 1, 2, 200))).toEqual({ status: 'rejected', reason: 'imageId does not match the SHA-256 of the data' });
    await expect(send({ ...part(forged, 0, 2, 200), index: 3 } as BackgroundRequest)).rejects.toThrow(/Invalid request/);
    expect(await repository.countImages(CK)).toBe(0);
  });
});
