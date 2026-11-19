/**
 * The transcript exports: the ZIP writer, the HTML page with pictures in place (also used for
 * printing to PDF) and the ZIP export with chat.html, chat.md and the images folder.
 */
import { describe, expect, it } from 'vitest';
import { buildArchiveExport, type ArchiveExportV1, type ExportSource } from '../../src/export/format';
import { buildTranscriptZip, pictureFileNames, transcriptHtml, transcriptZipEntries, type TranscriptImageSource } from '../../src/export/transcript';
import { crc32, createZip } from '../../src/export/zip';
import { sha256Hex, toArrayBuffer } from '../../src/shared/images';
import type { ConversationRecord, StoredMessage } from '../../src/shared/types';
import { createStoredMessage } from '../../src/storage/merge';
import { fakeImageBytes } from '../helpers/images';
import { CK, message } from '../helpers/messages';

/** Reads a stored (uncompressed) ZIP archive through its central directory, checking each CRC. */
function readZip(parts: Uint8Array[]): Map<string, Uint8Array> {
  const bytes = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    bytes.set(part, at);
    at += part.length;
  }
  const view = new DataView(bytes.buffer);
  const end = bytes.length - 22;
  expect(view.getUint32(end, true)).toBe(0x06054b50);
  const count = view.getUint16(end + 10, true);
  let pos = view.getUint32(end + 16, true);
  const files = new Map<string, Uint8Array>();
  const decoder = new TextDecoder();
  for (let i = 0; i < count; i++) {
    expect(view.getUint32(pos, true)).toBe(0x02014b50);
    expect(view.getUint16(pos + 8, true) & 0x0800).toBe(0x0800);
    expect(view.getUint16(pos + 10, true)).toBe(0);
    const crc = view.getUint32(pos + 16, true);
    const size = view.getUint32(pos + 24, true);
    const nameLength = view.getUint16(pos + 28, true);
    const offset = view.getUint32(pos + 42, true);
    const name = decoder.decode(bytes.subarray(pos + 46, pos + 46 + nameLength));
    expect(view.getUint32(offset, true)).toBe(0x04034b50);
    const dataStart = offset + 30 + view.getUint16(offset + 26, true) + view.getUint16(offset + 28, true);
    const data = bytes.slice(dataStart, dataStart + size);
    expect(crc32(data)).toBe(crc);
    files.set(name, data);
    pos += 46 + nameLength;
  }
  return files;
}

const text = (data: Uint8Array | undefined) => new TextDecoder().decode(data);

describe('ZIP writer', () => {
  it('computes the standard CRC-32', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array())).toBe(0);
  });

  it('stores files, including UTF-8 names, so they read back unchanged', () => {
    const picture = fakeImageBytes('https://example.invalid/a.png', 300);
    const files = readZip(createZip([
      { path: 'chat.html', data: '<p>héllo</p>' },
      { path: 'Café-chat/images/001.png', data: picture },
    ], new Date(2024, 0, 15, 9, 30, 10)));
    expect([...files.keys()]).toEqual(['chat.html', 'Café-chat/images/001.png']);
    expect(text(files.get('chat.html'))).toBe('<p>héllo</p>');
    expect(files.get('Café-chat/images/001.png')).toEqual(picture);
  });

  it('refuses unsafe and duplicate paths', () => {
    expect(() => createZip([{ path: '../evil.txt', data: 'x' }])).toThrow(/Invalid path/);
    expect(() => createZip([{ path: '/abs.txt', data: 'x' }])).toThrow(/Invalid path/);
    expect(() => createZip([{ path: 'a\\b.txt', data: 'x' }])).toThrow(/Invalid path/);
    expect(() => createZip([{ path: 'a.txt', data: 'x' }, { path: 'a.txt', data: 'y' }])).toThrow(/Duplicate path/);
  });
});

const ctx = { sessionId: 's1', nowIso: '2024-01-15T12:00:00.000Z' };

function conversationRecord(conversationKey: string, title: string): ConversationRecord {
  return {
    conversationKey,
    threadId: null,
    title,
    type: 'group',
    keySource: 'dom',
    typeSource: 'thread-id',
    participants: ['Alice Andersen', 'Bob Brown'],
    messageCount: 3,
    oldestSortKey: Date.UTC(2024, 0, 15, 9, 0),
    newestSortKey: Date.UTC(2024, 0, 15, 9, 20),
    coverage: [{ oldest: Date.UTC(2024, 0, 15, 9, 0), newest: Date.UTC(2024, 0, 15, 9, 20), reachedBeginning: true }],
    firstExtractedAt: ctx.nowIso,
    lastExtractedAt: ctx.nowIso,
    lastSessionId: 's1',
    schemaVersion: 1,
  };
}

async function fixture(conversationKey = CK, title = 'Project Alpha') {
  const chart = fakeImageBytes('https://example.invalid/chart.png', 40);
  const photo = fakeImageBytes('https://example.invalid/photo.jpg', 50);
  const chartId = await sha256Hex(chart);
  const photoId = await sha256Hex(photo);
  const at = (minute: number) => String(Date.UTC(2024, 0, 15, 9, minute));
  const messages: StoredMessage[] = [
    createStoredMessage(message({ conversationKey, id: at(0), text: 'Here is <b>the</b> plan & more' }), ctx),
    createStoredMessage(
      message({
        conversationKey,
        id: at(10),
        text: 'Two pictures',
        sender: { name: 'Bob Brown', id: null, isSelf: true, source: 'self' },
        attachments: [
          { kind: 'image', name: 'image', url: null, imageId: photoId },
          { kind: 'image', name: 'lost.png', url: 'javascript:alert(1)', imageId: null },
          { kind: 'file', name: 'notes.docx', url: 'https://example.invalid/notes.docx' },
        ],
      }),
      ctx,
    ),
    createStoredMessage(message({ conversationKey, id: at(20), text: '', attachments: [{ kind: 'image', name: 'chart.png', url: null, imageId: chartId }, { kind: 'image', name: 'image', url: null, imageId: photoId }] }), ctx),
  ];
  const stored = (imageId: string, bytes: Uint8Array, mimeType: string): TranscriptImageSource => ({ imageId, mimeType, width: 4, height: 2, firstSavedAt: ctx.nowIso, data: toArrayBuffer(bytes) });
  const unreferenced = fakeImageBytes('https://example.invalid/old.gif', 30);
  const images = [stored(chartId, chart, 'image/png'), stored(photoId, photo, 'image/jpeg'), stored(await sha256Hex(unreferenced), unreferenced, 'image/gif')];
  return { record: conversationRecord(conversationKey, title), messages, images, chart, photo, chartId, photoId };
}

async function exportOf(conversations: Array<{ record: ConversationRecord; messages: StoredMessage[] }>): Promise<ArchiveExportV1> {
  const source: ExportSource = {
    getConversation: async (key) => conversations.find((c) => c.record.conversationKey === key)?.record,
    listConversations: async () => conversations.map((c) => c.record),
    getMessages: async (key) => conversations.find((c) => c.record.conversationKey === key)?.messages ?? [],
  };
  return buildArchiveExport(source, 'all', { now: new Date('2024-02-01T10:20:30.456Z'), includeImages: false });
}

describe('transcript with pictures', () => {
  it('names the pictures messages show, in that order, by message time; others are left out', async () => {
    const { messages, images, chartId, photoId } = await fixture();
    const names = pictureFileNames(messages, images, { timeZone: 'UTC' });
    expect([...names]).toEqual([
      [photoId, '001_2024-01-15_0910.jpg'],
      [chartId, '002_2024-01-15_0920.png'],
    ]);
  });

  it('renders each message with its pictures in place and escapes everything', async () => {
    const { record, messages, photoId } = await fixture();
    const html = transcriptHtml([{ conversation: { ...record, messages }, images: new Map([[photoId, { src: 'blob:x/1', width: 4, height: 2 }]]) }], { timeZone: 'UTC', locale: 'en-GB' });
    expect(html).toMatch(/^<!doctype html>/);
    expect(html).toContain('<title>Project Alpha</title>');
    expect(html).toContain('Here is &lt;b&gt;the&lt;/b&gt; plan &amp; more');
    expect(html).not.toContain('<b>the</b>');
    expect(html).toContain('<article class="msg self"><div class="meta"><span class="who">Bob Brown</span>09:10</div><div class="text">Two pictures</div>');
    expect(html).toContain('<figure><a href="blob:x/1" target="_blank"><img src="blob:x/1" alt="image" width="4" height="2"></a></figure>');
    // A picture that was not saved is listed by name; a script address is not made a link.
    expect(html).toContain('<li class="missing">Picture not saved: lost.png</li>');
    expect(html).not.toContain('javascript:');
    expect(html).toContain('<li>File: <a href="https://example.invalid/notes.docx">notes.docx</a></li>');
    expect(html).toContain('Pictures: 1');
    expect(html).not.toContain('<script');
  });

  it('exports one conversation as chat.html, chat.md and its images folder', async () => {
    const { record, messages, images, chart, photo } = await fixture();
    const archive = await exportOf([{ record, messages }]);
    const files = readZip(buildTranscriptZip(archive, new Map([[CK, images]]), { timeZone: 'UTC', locale: 'en-GB' }));
    expect([...files.keys()].sort()).toEqual(['chat.html', 'chat.md', 'images/001_2024-01-15_0910.jpg', 'images/002_2024-01-15_0920.png']);
    expect(files.get('images/001_2024-01-15_0910.jpg')).toEqual(photo);
    expect(files.get('images/002_2024-01-15_0920.png')).toEqual(chart);
    const html = text(files.get('chat.html'));
    expect(html).toContain('<img src="images/002_2024-01-15_0920.png" alt="chart.png" width="4" height="2">');
    expect(html).toContain('<figcaption>chart.png</figcaption>');
    expect(html.match(/<img src="images\/001_2024-01-15_0910\.jpg"/g)).toHaveLength(2);
    const markdown = text(files.get('chat.md'));
    expect(markdown).toContain('- Pictures: 2 (in the images folder, shown in place below)');
    expect(markdown).toContain('![image](images/001_2024-01-15_0910.jpg)');
    expect(markdown).toContain('![chart.png](images/002_2024-01-15_0920.png)');
    expect(markdown).toContain('_Attachments:_ Image: lost.png · File: [notes.docx](https://example.invalid/notes.docx)');
  });

  it('puts several conversations in their own folders, with an index page', async () => {
    const first = await fixture(CK, 'Project Alpha');
    const second = await fixture('teams:19:other@thread.v2', 'Project Alpha');
    const archive = await exportOf([first, second].map(({ record, messages }) => ({ record, messages })));
    const entries = transcriptZipEntries(archive, new Map([[CK, first.images]]), { timeZone: 'UTC' });
    const paths = entries.map((entry) => entry.path);
    expect(paths).toContain('Project-Alpha/chat.html');
    expect(paths).toContain('Project-Alpha/images/001_2024-01-15_0910.jpg');
    expect(paths).toContain('Project-Alpha-2/chat.md');
    expect(paths.filter((path) => path.startsWith('Project-Alpha-2/images/'))).toEqual([]);
    const index = entries.find((entry) => entry.path === 'index.html')?.data as string;
    expect(index).toContain('<a href="Project-Alpha/chat.html">Project Alpha</a> · 3 messages, 2 pictures');
    expect(index).toContain('<a href="Project-Alpha-2/chat.html">Project Alpha</a> · 3 messages</li>');
  });
});
