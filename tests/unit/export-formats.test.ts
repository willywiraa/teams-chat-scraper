/**
 * The export formats, written by the pipeline from an in-memory archive: golden files per
 * format, pictures, content options, date ranges, CSV safety and the knowledge package layout.
 * Set UPDATE_GOLDEN=1 to rewrite the golden files after an intended change.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseArchiveExport } from '../../src/export/format';
import { FULL_CONTENT, type ExportContent, type ExportFormat, type Packaging, type TimeRange } from '../../src/export/options';
import { exportFileNameFor, runExport, writePrintable, type ExportReader, type PackageImageV1, type PackageManifestV1 } from '../../src/export/pipeline';
import { csvCell } from '../../src/export/render';
import { CK } from '../helpers/messages';
import { at, exportFixture, FIXTURE_NOW, type ExportFixture } from '../helpers/export-fixture';
import { blobText, icuNeutral, memoryReader, unzip, utf8 } from '../helpers/export';

const GOLDEN = join(__dirname, '..', 'golden');
const OPEN: TimeRange = { from: null, to: null };

interface Options {
  format: ExportFormat;
  packaging?: Packaging;
  range?: TimeRange;
  content?: Partial<ExportContent>;
  conversations?: string[] | 'all';
}

async function exportWith(reader: ExportReader, options: Options) {
  return runExport(reader, {
    conversations: options.conversations ?? 'all',
    format: options.format,
    packaging: options.packaging ?? 'file',
    range: options.range ?? OPEN,
    content: { ...FULL_CONTENT, ...options.content },
    timeZone: 'UTC',
    locale: 'en-GB',
    now: FIXTURE_NOW,
    generatorVersion: '1.4.0',
  });
}

async function readerOf(...fixtures: ExportFixture[]): Promise<ExportReader> {
  return memoryReader(fixtures.map(({ record, messages, images }) => ({ record, messages, images })));
}

function golden(name: string, actual: string): void {
  const path = join(GOLDEN, name);
  if (process.env.UPDATE_GOLDEN || !existsSync(path)) {
    mkdirSync(GOLDEN, { recursive: true });
    writeFileSync(path, actual);
  }
  expect(icuNeutral(actual)).toBe(icuNeutral(readFileSync(path, 'utf8')));
}

describe('golden files', () => {
  it('HTML page with the pictures embedded', async () => {
    const outcome = await exportWith(await readerOf(await exportFixture()), { format: 'html' });
    expect(outcome.fileName).toBe('Project-Alpha-2024-02-01T10-20-30.html');
    golden('chat.html', await blobText(outcome.blob));
  });

  it('Markdown, plain text and CSV with their images folders', async () => {
    const reader = await readerOf(await exportFixture());
    for (const [format, file] of [['markdown', 'chat.md'], ['text', 'chat.txt'], ['csv', 'messages.csv']] as const) {
      const files = await unzip((await exportWith(reader, { format, packaging: 'zip' })).blob);
      golden(file, utf8(files.get(file)));
    }
  });

  it('JSON records', async () => {
    const outcome = await exportWith(await readerOf(await exportFixture()), { format: 'json' });
    golden('export.json', await blobText(outcome.blob));
  });

  it('knowledge package manifest and transcript', async () => {
    const files = await unzip((await exportWith(await readerOf(await exportFixture()), { format: 'package', content: { systemMessages: false } })).blob);
    golden('package-manifest.json', utf8(files.get('manifest.json')));
    const folder = [...files.keys()].find((path) => path.endsWith('/transcript.md'))!.replace(/\/transcript\.md$/, '');
    golden('package-transcript.md', utf8(files.get(`${folder}/transcript.md`)));
  });
});

describe('HTML', () => {
  it('embeds each picture in its message and escapes everything', async () => {
    const fixture = await exportFixture();
    const html = await blobText((await exportWith(await readerOf(fixture), { format: 'html' })).blob);
    const photo = `data:image/jpeg;base64,${Buffer.from(fixture.photo).toString('base64')}`;
    expect(html.match(new RegExp(`<img src="${photo.replace(/[+/]/g, '\\$&')}"`, 'g'))).toHaveLength(2);
    expect(html).toContain(`<img src="data:image/png;base64,${Buffer.from(fixture.chart).toString('base64')}" alt="chart.png" width="4" height="2">`);
    expect(html).toContain('Here is &lt;b&gt;the&lt;/b&gt; plan &amp; more');
    expect(html).not.toContain('<b>the</b>');
    expect(html).toContain('<li class="missing">Picture not saved: lost.png</li>');
    expect(html).not.toContain('javascript:');
    expect(html).not.toContain('<script');
    expect(html).toContain('Messages: 5 · Pictures: 2');
    // The reply names its target only by key: the target's first line is shown.
    expect(html).toContain('Replying to <b>Alice Andersen</b>: # Agenda');
    expect(html).toContain('Earlier version, replaced');
    expect(html).toContain('Looks fine');
  });

  it('as a ZIP: chat.html with the pictures as numbered files', async () => {
    const fixture = await exportFixture();
    const outcome = await exportWith(await readerOf(fixture), { format: 'html', packaging: 'zip' });
    expect(outcome.fileName).toBe('Project-Alpha-2024-02-01T10-20-30.zip');
    expect(outcome).toMatchObject({ conversations: 1, messages: 5, pictures: 2 });
    const files = await unzip(outcome.blob);
    expect([...files.keys()].sort()).toEqual(['chat.html', 'images/001_2024-01-15_0910.jpg', 'images/002_2024-01-15_0920.png']);
    expect(files.get('images/001_2024-01-15_0910.jpg')).toEqual(fixture.photo);
    const html = utf8(files.get('chat.html'));
    expect(html.match(/<img src="images\/001_2024-01-15_0910\.jpg"/g)).toHaveLength(2);
    expect(html).toContain('<figcaption>chart.png</figcaption>');
  });

  it('puts several conversations in their own folders, with an index page', async () => {
    const first = await exportFixture(CK, 'Project Alpha');
    const second = await exportFixture('teams:19:other@thread.v2', 'Project Alpha');
    const outcome = await exportWith(memoryReader([first, { ...second, images: [] }]), { format: 'html', packaging: 'zip' });
    expect(outcome.fileName).toBe('teams-archive-2024-02-01T10-20-30.zip');
    const files = await unzip(outcome.blob);
    expect([...files.keys()]).toEqual(expect.arrayContaining(['Project-Alpha/chat.html', 'Project-Alpha/images/001_2024-01-15_0910.jpg', 'Project-Alpha-2/chat.html', 'index.html']));
    expect([...files.keys()].filter((path) => path.startsWith('Project-Alpha-2/images/'))).toEqual([]);
    const index = utf8(files.get('index.html'));
    expect(index).toContain('<a href="Project-Alpha/chat.html">Project Alpha</a> · 5 messages, 2 pictures');
    expect(index).toContain('<a href="Project-Alpha-2/chat.html">Project Alpha</a> · 5 messages</li>');
  });

  it('prints from the addresses it is given, holding no picture data', async () => {
    const parts: string[] = [];
    const totals = await writePrintable(
      await readerOf(await exportFixture()),
      { conversations: 'all', format: 'pdf', packaging: 'file', range: OPEN, content: FULL_CONTENT, timeZone: 'UTC' },
      (text) => parts.push(text),
      (image) => `blob:test/${image.imageId.slice(0, 6)}`,
    );
    expect(totals).toMatchObject({ conversations: 1, messages: 5, pictures: 2 });
    const html = parts.join('');
    expect(html).toMatch(/^<!doctype html>/);
    expect(html).toMatch(/<img src="blob:test\/[0-9a-f]{6}"/);
    expect(html).not.toContain('base64');
    expect(parts.length).toBeGreaterThan(3);
  });
});

describe('content options', () => {
  it('leaves out attachments, replies, system messages and edit history when asked', async () => {
    const reader = await readerOf(await exportFixture());
    const all = utf8((await unzip((await exportWith(reader, { format: 'markdown', packaging: 'zip' })).blob)).get('chat.md'));
    expect(all).toContain('_Bob Brown joined the chat._');
    expect(all).toContain('> Replying to **Alice Andersen**: # Agenda');
    expect(all).toContain('File: [agenda\\_v2.docx](https://example.invalid/agenda_v2.docx)');
    expect(all).toContain('_Earlier version, replaced');

    const outcome = await exportWith(reader, { format: 'markdown', content: { images: false, attachments: false, replies: false, systemMessages: false, editHistory: false } });
    expect(outcome.fileName).toBe('Project-Alpha-2024-02-01T10-20-30.md');
    const none = await blobText(outcome.blob);
    expect(outcome.messages).toBe(4);
    expect(none).toContain('- Messages: 4');
    for (const absent of ['joined the chat', 'Replying to', 'agenda', 'Earlier version', 'Image:', '![']) expect(none).not.toContain(absent);
  });

  it('lists pictures by name when they are left out but attachments are kept', async () => {
    const text = await blobText((await exportWith(await readerOf(await exportFixture()), { format: 'text', content: { images: false } })).blob);
    expect(text).toContain('  Picture: chart.png');
    expect(text).toContain('  File: agenda_v2.docx <https://example.invalid/agenda_v2.docx>');
    expect(text).not.toContain('images/');
  });

  it('keeps attachments and replies in records whatever is chosen', async () => {
    const json = JSON.parse(await blobText((await exportWith(await readerOf(await exportFixture()), { format: 'json', content: { attachments: false, replies: false, editHistory: false, images: false } })).blob));
    const edited = json.conversations[0].messages[2];
    expect(edited.attachments).toHaveLength(3);
    expect(edited.replyTo).not.toBeNull();
    expect(edited.previousVersions).toEqual([]);
    expect(json.conversations[0].images).toBeUndefined();
    expect(json.selection).toEqual({ from: null, to: null, images: false, systemMessages: true, editHistory: false });
  });
});

describe('date ranges', () => {
  it('exports only messages from the start (inclusive) to the end (exclusive)', async () => {
    const reader = await readerOf(await exportFixture());
    const range = { from: at(15, 9, 5), to: at(15, 9, 20) };
    const outcome = await exportWith(reader, { format: 'json', range });
    const json = parseArchiveExport(await blobText(outcome.blob));
    const conversation = json.conversations[0]!;
    expect(conversation.messages.map((message) => message.sortKey)).toEqual([at(15, 9, 5), at(15, 9, 10)]);
    expect(conversation).toMatchObject({ messageCount: 2, oldestSortKey: at(15, 9, 5), newestSortKey: at(15, 9, 10), lastUpdate: null });
    // Coverage only claims what the export holds.
    expect(conversation.coverage).toEqual([{ oldest: at(15, 9, 5), newest: at(15, 9, 20), reachedBeginning: false }]);
    // Only the pictures the exported messages show.
    expect(conversation.images?.map((image) => image.mimeType)).toEqual(['image/jpeg']);
    expect(json.selection).toMatchObject({ from: new Date(at(15, 9, 5)).toISOString(), to: new Date(at(15, 9, 20)).toISOString() });
  });

  it('keeps the last update when the period reaches the newest messages, and says the period in transcripts', async () => {
    const reader = await readerOf(await exportFixture());
    const json = parseArchiveExport(await blobText((await exportWith(reader, { format: 'json', range: { from: at(15, 9, 15), to: null } })).blob));
    expect(json.conversations[0]).toMatchObject({ messageCount: 2, lastUpdate: { sessionId: 's1' } });
    expect(json.conversations[0]!.coverage).toEqual([{ oldest: at(15, 9, 15), newest: at(16, 8, 30), reachedBeginning: false }]);
    const html = await blobText((await exportWith(reader, { format: 'html', range: { from: at(15, 9, 15), to: null } })).blob);
    expect(icuNeutral(html)).toContain('Period: from 15 Jan 2024, 09:15');
    expect(html).toContain('Messages: 2 · Pictures: 2');
  });

  it('keeps every record of an export without a range, including unreferenced pictures', async () => {
    const fixture = await exportFixture();
    const json = parseArchiveExport(await blobText((await exportWith(await readerOf(fixture), { format: 'json' })).blob));
    expect(json.conversations[0]).toMatchObject({ ...fixture.record });
    expect(json.conversations[0]!.messages).toEqual(fixture.messages);
    expect(json.conversations[0]!.images?.map((image) => image.imageId)).toEqual([fixture.oldId, fixture.photoId, fixture.chartId]);
  });
});

describe('CSV', () => {
  it('keeps formula-like values as text and quotes what needs quoting', () => {
    expect(csvCell('=1+1')).toBe("'=1+1");
    expect(csvCell('+49 30 1234')).toBe("'+49 30 1234");
    expect(csvCell('-5')).toBe("'-5");
    expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(csvCell('\tcmd')).toBe("'\tcmd");
    expect(csvCell('\rcmd')).toBe(`"'\rcmd"`);
    expect(csvCell('＝1+1')).toBe("'＝1+1");
    expect(csvCell('=HYPERLINK("https://example.invalid","x")')).toBe(`"'=HYPERLINK(""https://example.invalid"",""x"")"`);
    expect(csvCell('a, b')).toBe('"a, b"');
    expect(csvCell('line\nbreak')).toBe('"line\nbreak"');
    expect(csvCell('plain')).toBe('plain');
    expect(csvCell(-5)).toBe('-5');
    expect(csvCell(true)).toBe('yes');
    expect(csvCell(null)).toBe('');
  });

  it('writes one row per message, UTF-8 with a byte order mark and CRLF rows', async () => {
    const outcome = await exportWith(await readerOf(await exportFixture()), { format: 'csv', content: { images: false } });
    expect(outcome.fileName).toBe('Project-Alpha-2024-02-01T10-20-30.csv');
    const bytes = new Uint8Array(await outcome.blob.arrayBuffer());
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const text = new TextDecoder().decode(bytes);
    expect(text.split('\r\n')[0]).toBe(
      'conversation,conversation_key,message_key,message_id,time,time_utc,sender,sender_id,from_me,kind,text,reply_to_sender,reply_to_text,reply_to_key,attachments,edited,deleted,earlier_versions',
    );
    expect(text).toContain(`,"'=1+1, ""quoted""",`);
    expect(text).toContain('2024-01-15 09:10:00,2024-01-15T09:10:00.000Z,Bob Brown,8:orgid:bob,no,message,Looks good *to me*,Alice Andersen,# Agenda,');
    // Rows end with CRLF; line breaks inside a quoted cell are kept as they are.
    expect(text.trimEnd().split('\r\n')).toHaveLength(6);
  });
});

describe('knowledge package', () => {
  it('holds manifest.json and per conversation its records, transcript and pictures', async () => {
    const fixture = await exportFixture();
    const outcome = await exportWith(await readerOf(fixture), { format: 'package' });
    expect(outcome.fileName).toBe('Project-Alpha-package-2024-02-01T10-20-30.zip');
    const files = await unzip(outcome.blob);
    const manifest = JSON.parse(utf8(files.get('manifest.json'))) as PackageManifestV1;
    expect(manifest).toMatchObject({
      format: 'teams-chat-archive-package',
      formatVersion: 1,
      exportedAt: FIXTURE_NOW.toISOString(),
      records: { format: 'teams-chat-archive', formatVersion: 1 },
      selection: { from: null, to: null, images: true, systemMessages: true, editHistory: true },
      timeZone: 'UTC',
    });
    const [entry] = manifest.conversations;
    expect(entry).toMatchObject({ conversationKey: CK, name: 'Project Alpha', messages: 5, images: 3 });
    expect(entry!.folder).toMatch(/^conversations\/Project-Alpha-[0-9a-f]{8}$/);
    const folder = entry!.folder;
    expect([...files.keys()].sort()).toEqual(
      [
        'manifest.json',
        `${folder}/conversation.json`,
        `${folder}/messages.jsonl`,
        `${folder}/images.jsonl`,
        `${folder}/transcript.md`,
        `${folder}/images/${fixture.photoId}.jpg`,
        `${folder}/images/${fixture.chartId}.png`,
        `${folder}/images/${fixture.oldId}.gif`,
      ].sort(),
    );
    expect(JSON.parse(utf8(files.get(`${folder}/conversation.json`)))).toEqual(fixture.record);
    const lines = utf8(files.get(`${folder}/messages.jsonl`)).trimEnd().split('\n');
    expect(lines.map((line) => JSON.parse(line))).toEqual(fixture.messages);
    const images = utf8(files.get(`${folder}/images.jsonl`)).trimEnd().split('\n').map((line) => JSON.parse(line) as PackageImageV1);
    expect(images.map((image) => image.file)).toEqual([`images/${fixture.oldId}.gif`, `images/${fixture.photoId}.jpg`, `images/${fixture.chartId}.png`]);
    expect(images[1]).toEqual({ ...(({ data: _d, ...info }) => info)(fixture.images[1]!), file: `images/${fixture.photoId}.jpg` });
    expect(files.get(`${folder}/images/${fixture.photoId}.jpg`)).toEqual(fixture.photo);
    expect(utf8(files.get(`${folder}/transcript.md`))).toContain(`![chart.png](images/${fixture.chartId}.png)`);
  });

  it('with a period holds only the messages and pictures of that period', async () => {
    const fixture = await exportFixture();
    const files = await unzip((await exportWith(await readerOf(fixture), { format: 'package', range: { from: at(16, 0, 0), to: null } })).blob);
    const manifest = JSON.parse(utf8(files.get('manifest.json'))) as PackageManifestV1;
    expect(manifest.conversations[0]).toMatchObject({ messages: 1, images: 0 });
    expect([...files.keys()].some((path) => path.includes('/images/'))).toBe(false);
  });

  it('names files after the chat, or the archive for several', () => {
    const one = [{ displayName: 'Budget 2024', title: 'Project Alpha' }] as never;
    expect(exportFileNameFor(one, FIXTURE_NOW, 'zip', 'package')).toBe('Budget-2024-package-2024-02-01T10-20-30.zip');
    expect(exportFileNameFor([], FIXTURE_NOW, 'json')).toBe('teams-archive-2024-02-01T10-20-30.json');
  });
});
