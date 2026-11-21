/**
 * Export and import through a real (fake-indexeddb) archive: the knowledge package and JSON
 * files round-trip without duplicates, periods import only what they hold, damaged files change
 * nothing, and an interrupted import leaves no hidden messages.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { importArchive, importArchiveFile } from '../../src/export/import';
import { FULL_CONTENT, type ExportContent, type ExportFormat, type Packaging, type TimeRange } from '../../src/export/options';
import { runExport } from '../../src/export/pipeline';
import type { ConversationRecord, StoredMessage } from '../../src/shared/types';
import { createStoredMessage } from '../../src/storage/merge';
import type { ArchiveRepository } from '../../src/storage/repository';
import { blobText, deflatedZip, unzip } from '../helpers/export';
import { at, exportFixture, FIXTURE_NOW, type ExportFixture } from '../helpers/export-fixture';
import { openTestRepository } from '../helpers/fixtures';
import { CK, message } from '../helpers/messages';

const OPEN: TimeRange = { from: null, to: null };
const repositories: ArchiveRepository[] = [];
let source: ArchiveRepository;
let fixture: ExportFixture;

async function fresh(): Promise<ArchiveRepository> {
  const repository = await openTestRepository();
  repositories.push(repository);
  return repository;
}

async function seed(repository: ArchiveRepository, data: ExportFixture): Promise<void> {
  await repository.putImages(data.record.conversationKey, data.images);
  await repository.importConversation(data.record, data.messages);
}

function exportOf(repository: ArchiveRepository, format: ExportFormat, options: { range?: TimeRange; content?: Partial<ExportContent>; packaging?: Packaging } = {}) {
  return runExport(repository, {
    conversations: 'all',
    format,
    packaging: options.packaging ?? (format === 'package' ? 'zip' : 'file'),
    range: options.range ?? OPEN,
    content: { ...FULL_CONTENT, ...options.content },
    timeZone: 'UTC',
    now: FIXTURE_NOW,
  });
}

/** What an archive holds, for comparing two archives. */
async function contents(repository: ArchiveRepository) {
  const conversations = (await repository.listConversations()).sort((a, b) => a.conversationKey.localeCompare(b.conversationKey));
  return Promise.all(
    conversations.map(async (record) => ({
      record: { ...record },
      messages: await repository.getMessages(record.conversationKey),
      images: await repository.getImages(record.conversationKey),
    })),
  );
}

beforeEach(async () => {
  source = await fresh();
  fixture = await exportFixture();
  await seed(source, fixture);
  // A second chat, keyed by its title.
  const other = await exportFixture('title:design review', 'Design review', 10);
  await seed(source, { ...other, images: [] });
});

afterEach(() => {
  for (const repository of repositories.splice(0)) repository.close();
});

describe('knowledge package and JSON files', () => {
  it('a package restores the archive exactly, and importing it again changes nothing', async () => {
    const outcome = await exportOf(source, 'package');
    expect(outcome).toMatchObject({ conversations: 2, messages: 10, pictures: 3 });
    const target = await fresh();
    const file = new File([outcome.blob], outcome.fileName, { type: 'application/zip' });
    expect(await importArchiveFile(target, file)).toEqual({ conversations: 2, inserted: 10, updated: 0, unchanged: 0, imagesInserted: 3, imagesUnchanged: 0, joinedExisting: 0, keptSeparate: 0 });
    expect(await contents(target)).toEqual(await contents(source));
    expect(await importArchiveFile(target, file)).toEqual({ conversations: 2, inserted: 0, updated: 0, unchanged: 10, imagesInserted: 0, imagesUnchanged: 3, joinedExisting: 0, keptSeparate: 0 });
    expect(await contents(target)).toEqual(await contents(source));
  });

  it('a JSON file is read in parts, with the same result as reading it whole', async () => {
    const outcome = await exportOf(source, 'json');
    const streamed = await fresh();
    const progress: string[] = [];
    await importArchiveFile(streamed, outcome.blob, { onProgress: (p) => progress.push(p.phase) });
    expect(await contents(streamed)).toEqual(await contents(source));
    expect(progress).toContain('importing');
    const whole = await fresh();
    await importArchive(whole, await blobText(outcome.blob));
    expect(await contents(whole)).toEqual(await contents(streamed));
  });

  it('a period adds only its messages and pictures, with coverage limited to it', async () => {
    const outcome = await exportOf(source, 'package', { range: { from: at(15, 9, 5), to: at(15, 9, 20) } });
    const target = await fresh();
    await importArchiveFile(target, outcome.blob);
    const record = (await target.getConversation(CK)) as ConversationRecord;
    expect((await target.getMessages(CK)).map((m) => m.sortKey)).toEqual([at(15, 9, 5), at(15, 9, 10)]);
    expect(record).toMatchObject({ messageCount: 2, lastUpdate: null, coverage: [{ oldest: at(15, 9, 5), newest: at(15, 9, 20), reachedBeginning: false }] });
    expect((await target.getImages(CK)).map((image) => image.imageId)).toEqual([fixture.photoId]);

    // Importing the whole package afterwards completes it.
    await importArchiveFile(target, (await exportOf(source, 'package')).blob);
    expect(await contents(target)).toEqual(await contents(source));
  });

  it('a package made without system messages or edit history imports without them', async () => {
    const target = await fresh();
    await importArchiveFile(target, (await exportOf(source, 'package', { content: { systemMessages: false, editHistory: false } })).blob);
    const messages = await target.getMessages(CK);
    expect(messages.map((m) => m.kind)).not.toContain('system');
    expect(messages.every((m) => m.previousVersions.length === 0)).toBe(true);
    expect(await target.countMessages(CK)).toBe(4);
  });

  it('a package zipped again inside a folder, compressed, can be imported', async () => {
    const files = await unzip((await exportOf(source, 'package')).blob);
    const rezipped = deflatedZip(Object.fromEntries([...files].map(([path, data]) => [`Teams export/${path}`, data])));
    const target = await fresh();
    await importArchiveFile(target, rezipped);
    expect(await contents(target)).toEqual(await contents(source));
  });

  it('refuses a ZIP that is not a knowledge package', async () => {
    const zip = await exportOf(source, 'html', { packaging: 'zip' });
    await expect(importArchiveFile(await fresh(), zip.blob)).rejects.toThrow(/not a knowledge package/);
  });
});

describe('damaged files change nothing', () => {
  it('a package with a changed picture or record is refused before anything is written', async () => {
    const files = await unzip((await exportOf(source, 'package')).blob);
    const picture = [...files.keys()].find((path) => path.endsWith(`${fixture.photoId}.jpg`)) as string;
    const changed = new Map(files);
    const bytes = (files.get(picture) as Uint8Array).slice();
    bytes[10] = (bytes[10] as number) ^ 0xff;
    changed.set(picture, bytes);
    const target = await fresh();
    await expect(importArchiveFile(target, deflatedZip(Object.fromEntries(changed)))).rejects.toThrow(/SHA-256/);
    expect(await target.listConversations()).toEqual([]);

    const lines = [...files.keys()].find((path) => path.endsWith('messages.jsonl')) as string;
    const broken = new Map(files);
    broken.set(lines, new TextEncoder().encode(`${new TextDecoder().decode(files.get(lines))}{"key": 5}\n`));
    await expect(importArchiveFile(target, deflatedZip(Object.fromEntries(broken)))).rejects.toThrow(/messages\.jsonl line \d+.*key is required/);
    expect(await target.listConversations()).toEqual([]);
  });

  it('a JSON file with a damaged picture or a cut-off end is refused before anything is written', async () => {
    const text = await blobText((await exportOf(source, 'json')).blob);
    const target = await fresh();
    const json = JSON.parse(text);
    json.conversations[0].images[1].dataBase64 = json.conversations[0].images[2].dataBase64;
    await expect(importArchiveFile(target, new Blob([JSON.stringify(json)]))).rejects.toThrow(/images\[1\]/);
    await expect(importArchiveFile(target, new Blob([text.slice(0, text.length - 40)]))).rejects.toThrow(/ends early/);
    await expect(importArchiveFile(target, new Blob([text.replace('"teams-chat-archive"', '"other"')]))).rejects.toThrow(/Unsupported format/);
    expect(await target.listConversations()).toEqual([]);
  });
});

describe('an interrupted import', () => {
  it('leaves a visible, partial entry without coverage, which importing again completes', async () => {
    const big = await fresh();
    const record: ConversationRecord = { ...fixture.record, messageCount: 1200, oldestSortKey: at(1, 0, 0), newestSortKey: at(1, 0, 0) + 1199 * 60_000, coverage: [{ oldest: at(1, 0, 0), newest: at(1, 0, 0) + 1199 * 60_000, reachedBeginning: true }] };
    const messages: StoredMessage[] = Array.from({ length: 1200 }, (_, i) => createStoredMessage(message({ id: String(at(1, 0, 0) + i * 60_000), text: `Message ${i}` }), { sessionId: 's1', nowIso: '2024-01-16T09:00:00.000Z' }));
    await big.importConversation(record, messages);
    const file = (await exportOf(big, 'package')).blob;

    const target = await fresh();
    let calls = 0;
    const failing = new Proxy(target, {
      get(repository, property) {
        if (property === 'importMessages') {
          return async (...args: Parameters<ArchiveRepository['importMessages']>) => {
            if (++calls === 2) throw new Error('The tab was closed');
            return repository.importMessages(...args);
          };
        }
        const value = Reflect.get(repository, property);
        return typeof value === 'function' ? value.bind(repository) : value;
      },
    });
    await expect(importArchiveFile(failing, file)).rejects.toThrow(/tab was closed/);
    const [partial] = await target.listConversations();
    expect(partial).toMatchObject({ conversationKey: CK, messageCount: 500, coverage: [], lastUpdate: null, oldestSortKey: null });
    expect(await target.countMessages(CK)).toBe(500);

    await importArchiveFile(target, file);
    expect(await target.getConversation(CK)).toMatchObject({ messageCount: 1200, coverage: record.coverage });
    expect(await target.getMessages(CK)).toEqual(await big.getMessages(CK));
  });

  it('offers only images that are stored when a run asks which images are archived', async () => {
    const target = await fresh();
    // A message written before its image (as after an import stopped between them).
    await target.importConversation(fixture.record, fixture.messages);
    const key = fixture.messages[2]!.key;
    expect((await target.archivedImages(CK, [key]))[key]).toBeUndefined();
    await target.putImages(CK, fixture.images);
    expect((await target.archivedImages(CK, [key]))[key]).toEqual({ contentHash: fixture.messages[2]!.contentHash, imageIds: [null, fixture.photoId, null] });
  });
});

describe('reading for exports', () => {
  it('reads a period in pages, and lists images without their bytes', async () => {
    const pages: StoredMessage[][] = [];
    for await (const page of source.messagePages(CK, { from: at(15, 9, 5), to: at(16, 8, 30) }, 2)) pages.push(page);
    expect(pages.map((page) => page.map((m) => m.sortKey))).toEqual([[at(15, 9, 5), at(15, 9, 10)], [at(15, 9, 20)]]);
    const all: number[] = [];
    for await (const page of source.messagePages(CK)) all.push(...page.map((m) => m.sortKey));
    expect(all).toHaveLength(5);
    const catalog = await source.imageCatalog(CK);
    expect(catalog.map((image) => image.imageId)).toEqual([fixture.oldId, fixture.photoId, fixture.chartId]);
    expect(catalog.every((image) => !('data' in image))).toBe(true);
  });
});
