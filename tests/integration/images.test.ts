/**
 * Saving displayed images during extraction: the engine reads each image once (through a fake
 * reader), stores it before the messages that refer to it, and links it from the attachment.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { BYTES_PER_MB } from '../../src/shared/images';
import { ARCHIVE_SCHEMA_VERSION, type StoredMessage } from '../../src/shared/types';
import type { ArchiveRepository } from '../../src/storage/repository';
import { ChatSimulator, generateConversation } from '../helpers/chat-simulator';
import { detect, openTestRepository, repositorySink, runEngine } from '../helpers/fixtures';
import { FakeImageReader, fakeImageBytes, imageIdOf, okImage } from '../helpers/images';
import { renderStaticChat, type FixtureMessage } from '../helpers/teams-dom';

const A = 'https://example.invalid/img/a.png';
const B = 'https://example.invalid/img/b.png';
const DIAGRAM = 'https://example.invalid/img/diagram.png';
const EMOJI = 'https://example.invalid/emoji/smile.png';

const CHAT: FixtureMessage[] = [
  {
    id: '1705314600000',
    author: 'Alice Andersen',
    time: '2024-01-15T10:30:00.000Z',
    paragraphs: ['Two screenshots'],
    attachments: [
      { name: 'image', kind: 'image', url: A },
      { name: 'image', kind: 'image', url: B },
    ],
  },
  {
    id: '1705314660000',
    author: 'Bob Brown',
    time: '2024-01-15T10:31:00.000Z',
    html: `<p>See <img src="${DIAGRAM}" alt="diagram.png"> <img itemtype="http://schema.skype.com/Emoji" src="${EMOJI}" alt="😀"></p>`,
    attachments: [{ name: 'report.pdf', url: 'https://example.invalid/report.pdf' }],
  },
  { id: '1705314720000', author: 'Alice Andersen', time: '2024-01-15T10:32:00.000Z', paragraphs: ['No pictures here'] },
];

let archive: ArchiveRepository | null = null;
let simulator: ChatSimulator | null = null;

afterEach(() => {
  simulator?.dispose();
  simulator = null;
  archive?.close();
  archive = null;
  document.body.innerHTML = '';
});

async function staticChat(): Promise<{ repository: ArchiveRepository; conversationKey: string }> {
  renderStaticChat(CHAT);
  archive = await openTestRepository();
  return { repository: archive, conversationKey: detect().conversationKey };
}

function images(stored: StoredMessage[]) {
  return stored.map((message) => message.attachments.map((attachment) => ({ kind: attachment.kind, name: attachment.name, imageId: attachment.imageId ?? null })));
}

describe('saving displayed images', () => {
  it('stores every displayed image once and links it from its attachment', async () => {
    const { repository, conversationKey } = await staticChat();
    const reader = new FakeImageReader();
    const result = await runEngine({ repository, mode: 'visible', imageReader: reader });

    expect(result).toMatchObject({ status: 'completed', warnings: [] });
    expect(result.counters).toMatchObject({ inserted: 3, imagesSaved: 3, imagesFailed: 0 });
    // Emoji are text, not images; every other image is read exactly once.
    expect(Object.fromEntries(reader.reads)).toEqual({ [A]: 1, [B]: 1, [DIAGRAM]: 1 });

    const stored = await repository.getMessages(conversationKey);
    expect(images(stored)).toEqual([
      [
        { kind: 'image', name: 'image', imageId: await imageIdOf(A) },
        { kind: 'image', name: 'image', imageId: await imageIdOf(B) },
      ],
      [
        { kind: 'file', name: 'report.pdf', imageId: null },
        { kind: 'image', name: 'diagram.png', imageId: await imageIdOf(DIAGRAM) },
      ],
      [],
    ]);
    const saved = await repository.getImages(conversationKey);
    expect(saved).toHaveLength(3);
    const diagram = await repository.getImage(conversationKey, await imageIdOf(DIAGRAM));
    expect(diagram).toMatchObject({ key: `${conversationKey}#img:${await imageIdOf(DIAGRAM)}`, conversationKey, mimeType: 'image/png', byteLength: 64, width: 32, height: 16, method: 'fetch', schemaVersion: ARCHIVE_SCHEMA_VERSION });
    expect(new Uint8Array(diagram!.data)).toEqual(fakeImageBytes(DIAGRAM));
    expect(await repository.countImages(conversationKey)).toBe(3);
  });

  it('stores a picture shown at two addresses once, as the same image', async () => {
    const { repository, conversationKey } = await staticChat();
    // Teams can show the same picture under different addresses (for example after a re-render).
    const reader = new FakeImageReader((src) => okImage(src === B ? A : src));
    const result = await runEngine({ repository, mode: 'visible', imageReader: reader });

    expect(result.counters).toMatchObject({ imagesSaved: 2, imagesFailed: 0 });
    const [first] = await repository.getMessages(conversationKey);
    expect(first?.attachments.map((attachment) => attachment.imageId)).toEqual([await imageIdOf(A), await imageIdOf(A)]);
    expect(await repository.countImages(conversationKey)).toBe(2);
  });

  it('reads nothing when saving images is switched off', async () => {
    const { repository, conversationKey } = await staticChat();
    const reader = new FakeImageReader();
    const result = await runEngine({ repository, mode: 'visible', imageReader: reader, settings: { saveImages: false } });

    expect(result.counters).toMatchObject({ inserted: 3, imagesSaved: 0, imagesFailed: 0 });
    expect(reader.totalReads).toBe(0);
    expect(await repository.countImages(conversationKey)).toBe(0);
    expect(images(await repository.getMessages(conversationKey)).flat().every((attachment) => attachment.imageId === null)).toBe(true);
  });

  it('skips images above the size limit and images that cannot be read, keeping their name and link', async () => {
    const { repository, conversationKey } = await staticChat();
    const reader = new FakeImageReader((src) => {
      if (src === B) return okImage(src, 2 * BYTES_PER_MB);
      if (src === DIAGRAM) return { status: 'failed', reason: 'the browser does not allow reading this image' };
      return okImage(src);
    });
    const result = await runEngine({ repository, mode: 'visible', imageReader: reader, settings: { maxImageMB: 1 } });

    expect(result.counters).toMatchObject({ inserted: 3, imagesSaved: 1, imagesFailed: 2 });
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        'Images larger than 1 MB were not saved (their name and link are kept).',
        'Some displayed images could not be read and were not saved (for example: the browser does not allow reading this image). Their name and link are kept.',
      ]),
    );
    const [first, second] = await repository.getMessages(conversationKey);
    expect(first?.attachments).toEqual([
      { kind: 'image', name: 'image', url: A, imageId: await imageIdOf(A) },
      { kind: 'image', name: 'image', url: B },
    ]);
    expect(second?.attachments[1]).toEqual({ kind: 'image', name: 'diagram.png', url: DIAGRAM });
    expect(await repository.countImages(conversationKey)).toBe(1);
  });

  it('counts images that never finished loading as not saved', async () => {
    const { repository } = await staticChat();
    const reader = new FakeImageReader(() => ({ status: 'pending' }));
    const result = await runEngine({ repository, mode: 'visible', imageReader: reader });
    expect(result.counters).toMatchObject({ imagesSaved: 0, imagesFailed: 3 });
  });

  it('sends a message again once its image has loaded', async () => {
    // A short chat fits on screen, so a full run parses the same messages several times.
    simulator = new ChatSimulator({ items: CHAT });
    archive = await openTestRepository();
    const conversation = detect();
    const reader = new FakeImageReader((src, attempt) => (attempt === 1 ? { status: 'pending' } : okImage(src)));
    const sink = repositorySink(archive, conversation, 'session-1');
    const result = await runEngine({ repository: archive, mode: 'full', sink, imageReader: reader });

    expect(result).toMatchObject({ status: 'completed', stopReason: 'reached-top' });
    expect(result.counters).toMatchObject({ inserted: 3, updated: 2, imagesSaved: 3, imagesFailed: 0 });
    const ids = sink.batches.map((batch) => batch.map((message) => message.messageId));
    expect(ids).toEqual([['1705314600000', '1705314660000', '1705314720000'], ['1705314600000', '1705314660000']]);
    // The images were stored before the batch that refers to them.
    expect(sink.imageBatches).toEqual([[await imageIdOf(A), await imageIdOf(B), await imageIdOf(DIAGRAM)]]);
    expect(images(await archive.getMessages(conversation.conversationKey)).flat().filter((attachment) => attachment.kind === 'image').every((attachment) => attachment.imageId)).toBe(true);
  });

  it('reads each image only once during a long, virtualised full-history run', async () => {
    const { items, expected } = generateConversation({ count: 90, participants: ['Alice Andersen', 'Bob Brown'], selfName: 'Me', seed: 9, withImagesEvery: 7, dividerEvery: 30 });
    simulator = new ChatSimulator({ items });
    archive = await openTestRepository();
    const conversationKey = detect().conversationKey;
    const reader = new FakeImageReader();
    const result = await runEngine({ repository: archive, mode: 'full', imageReader: reader });

    const expectedImages = expected.flatMap((message) => message.attachments.filter((name) => name === 'image')).length;
    expect(expectedImages).toBe(24);
    expect(result).toMatchObject({ status: 'completed', stopReason: 'reached-top' });
    expect(result.counters).toMatchObject({ imagesSaved: expectedImages, imagesFailed: 0 });
    expect(reader.reads.size).toBe(expectedImages);
    expect([...reader.reads.values()].every((count) => count === 1)).toBe(true);

    const stored = await archive.getMessages(conversationKey);
    expect(stored.map((message) => message.attachments.map((attachment) => attachment.name))).toEqual(expected.map((message) => message.attachments));
    const attachments = stored.flatMap((message) => message.attachments);
    expect(attachments.every((attachment) => attachment.imageId)).toBe(true);
    expect(new Set(attachments.map((attachment) => attachment.imageId)).size).toBe(expectedImages);
    expect(await archive.countImages(conversationKey)).toBe(expectedImages);
  });

  it('does not read the images of archived messages again, unless archived parts are re-read', async () => {
    const { items } = generateConversation({ count: 90, participants: ['Alice Andersen', 'Bob Brown'], selfName: 'Me', seed: 9, withImagesEvery: 7, dividerEvery: 30 });
    simulator = new ChatSimulator({ items });
    archive = await openTestRepository();
    const conversationKey = detect().conversationKey;
    const first = new FakeImageReader();
    await runEngine({ repository: archive, mode: 'full', imageReader: first });
    expect(first.reads.size).toBe(24);
    const archived = images(await archive.getMessages(conversationKey));

    // An update re-reads 30 archived messages, several of them with pictures.
    const update = new FakeImageReader();
    const updated = await runEngine({ repository: archive, mode: 'incremental', imageReader: update, settings: { incrementalOverlap: 30 } });
    expect(updated).toMatchObject({ status: 'completed', stopReason: 'overlap-reached' });
    expect(updated.counters.unchanged).toBeGreaterThanOrEqual(30);
    expect(update.totalReads).toBe(0);
    expect(updated.counters).toMatchObject({ imagesSaved: 0, imagesFailed: 0, updated: 0 });

    // A message edited since keeps no image id from the archive: its pictures are read.
    const index = simulator.items.findIndex((item) => item.attachments?.some((attachment) => attachment.kind === 'image'));
    simulator.replaceItem(index, { ...simulator.items[index]!, paragraphs: ['Edited, same pictures'], edited: true });
    const rescan = new FakeImageReader();
    const reread = await runEngine({ repository: archive, mode: 'full', rescan: true, imageReader: rescan });
    expect(reread).toMatchObject({ status: 'completed', stopReason: 'reached-top' });
    expect(rescan.reads.size).toBe(24);
    expect(images(await archive.getMessages(conversationKey))).toEqual(archived);
    expect(await archive.countImages(conversationKey)).toBe(24);
  });

  it('reads the pictures of an archived message that was edited, even without re-reading', async () => {
    const { items } = generateConversation({ count: 40, participants: ['Alice Andersen', 'Bob Brown'], seed: 4, withImagesEvery: 5 });
    simulator = new ChatSimulator({ items });
    archive = await openTestRepository();
    const conversationKey = detect().conversationKey;
    await runEngine({ repository: archive, mode: 'full', imageReader: new FakeImageReader() });
    const last = simulator.items.map((item, i) => ({ item, i })).filter(({ item }) => item.attachments?.some((attachment) => attachment.kind === 'image')).pop()!;
    simulator.replaceItem(last.i, { ...last.item, paragraphs: ['Edited, same pictures'], edited: true });

    const reader = new FakeImageReader();
    const updated = await runEngine({ repository: archive, mode: 'incremental', imageReader: reader, settings: { incrementalOverlap: 20 } });
    expect(updated.status).toBe('completed');
    expect(reader.reads.size).toBe(2);
    const edited = await archive.getMessage(`${conversationKey}#${last.item.id}`);
    expect(edited?.text).toBe('Edited, same pictures');
    expect(edited?.attachments.filter((attachment) => attachment.kind === 'image').every((attachment) => attachment.imageId)).toBe(true);
  });
});
