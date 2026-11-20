import { describe, expect, it } from 'vitest';
import { exportFileName, toJson, toMarkdown } from '../../src/export/exporters';
import { buildArchiveExport, EXPORT_FORMAT, EXPORT_FORMAT_VERSION, parseArchiveExport, type ArchiveExportV1, type ExportSource } from '../../src/export/format';
import { ARCHIVE_SCHEMA_VERSION, EXTRACTOR_VERSION, type ConversationRecord, type StoredMessage } from '../../src/shared/types';
import { sha256Hex, toArrayBuffer } from '../../src/shared/images';
import { createStoredMessage } from '../../src/storage/merge';
import { fakeImageBytes } from '../helpers/images';
import { CK, message } from '../helpers/messages';

const ctx = { sessionId: 's1', nowIso: '2024-01-15T12:00:00.000Z' };

const conversation: ConversationRecord = {
  conversationKey: CK,
  threadId: '19:abcdef0123456789@thread.v2',
  title: 'Project Alpha',
  type: 'group',
  keySource: 'dom',
  typeSource: 'thread-id',
  participants: ['Alice Andersen', 'Bob Brown'],
  messageCount: 4,
  oldestSortKey: Date.UTC(2024, 0, 15, 9, 0),
  newestSortKey: Date.UTC(2024, 0, 16, 8, 30),
  coverage: [{ oldest: Date.UTC(2024, 0, 15, 9, 0), newest: Date.UTC(2024, 0, 16, 8, 30), reachedBeginning: true }],
  firstExtractedAt: '2024-01-16T09:00:00.000Z',
  lastExtractedAt: '2024-01-16T09:00:00.000Z',
  lastSessionId: 's1',
  schemaVersion: 1,
};

const messages: StoredMessage[] = [
  createStoredMessage(message({ id: String(Date.UTC(2024, 0, 15, 9, 0)), text: '# Agenda\nItem one\n\n- not a list' }), ctx),
  { ...createStoredMessage(message({ id: String(Date.UTC(2024, 0, 15, 9, 5)), kind: 'system', text: 'Bob Brown joined the chat.', sender: { name: null, id: null, isSelf: false, source: 'unknown' } }), ctx) },
  {
    ...createStoredMessage(
      message({
        id: String(Date.UTC(2024, 0, 15, 9, 10)),
        text: 'Looks good *to me*',
        sender: { name: 'Bob Brown', id: null, isSelf: false, source: 'explicit' },
        attachments: [{ kind: 'file', name: 'agenda_v2.docx', url: 'https://example.invalid/agenda_v2.docx' }],
        replyTo: { messageId: String(Date.UTC(2024, 0, 15, 9, 0)), senderName: 'Alice Andersen', timestampRaw: null, preview: '# Agenda Item one', resolvedKey: `${CK}#${Date.UTC(2024, 0, 15, 9, 0)}`, resolution: 'message-id' },
      }),
      ctx,
    ),
    isEdited: true,
  },
  createStoredMessage(message({ id: String(Date.UTC(2024, 0, 16, 8, 30)), text: 'Next day', sender: { name: null, id: null, isSelf: true, source: 'self' } }), ctx),
];

const source: ExportSource = {
  getConversation: async (key) => (key === CK ? conversation : undefined),
  listConversations: async () => [conversation],
  getMessages: async () => messages,
};

async function archive(): Promise<ArchiveExportV1> {
  return buildArchiveExport(source, [CK, 'teams:missing'], { now: new Date('2024-02-01T10:20:30.456Z') });
}

describe('archive export', () => {
  it('builds a versioned, self-describing export', async () => {
    const exported = await archive();
    expect(exported).toMatchObject({
      format: EXPORT_FORMAT,
      formatVersion: EXPORT_FORMAT_VERSION,
      exportedAt: '2024-02-01T10:20:30.456Z',
      generator: { name: 'teams-chat-extractor', extractorVersion: EXTRACTOR_VERSION, schemaVersion: ARCHIVE_SCHEMA_VERSION },
    });
    expect(exported.conversations).toHaveLength(1);
    expect(exported.conversations[0]).toMatchObject({ conversationKey: CK, title: 'Project Alpha', messages });
  });

  it('serialises JSON that parses back to the same archive', async () => {
    const exported = await archive();
    const json = toJson(exported);
    expect(json.endsWith('\n')).toBe(true);
    expect(parseArchiveExport(json)).toEqual(exported);
  });

  it('renders a readable Markdown transcript', async () => {
    const markdown = toMarkdown(await archive(), { timeZone: 'UTC', locale: 'en-GB' });
    expect(markdown).toContain('# Project Alpha');
    expect(markdown).toContain('- Participants: Alice Andersen, Bob Brown');
    expect(markdown).toContain('- Archive coverage: complete history');
    // The exact date wording depends on the ICU version shipped with the browser / Node.
    expect(markdown).toMatch(/## Monday,? 15 January 2024/);
    expect(markdown).toContain('**Alice Andersen** · 09:00');
    expect(markdown).toContain('\\# Agenda\nItem one\n\n\\- not a list');
    expect(markdown).toContain('_Bob Brown joined the chat._ · 09:05');
    expect(markdown).toContain('**Bob Brown** · 09:10 _(edited)_');
    expect(markdown).toContain('> Replying to **Alice Andersen**: # Agenda Item one');
    // Message text is kept verbatim apart from line-start markers (JSON is the lossless format).
    expect(markdown).toContain('Looks good *to me*');
    expect(markdown).toContain('_Attachments:_ File: [agenda\\_v2.docx](https://example.invalid/agenda_v2.docx)');
    expect(markdown).toMatch(/## Tuesday,? 16 January 2024/);
    expect(markdown).toContain('**Me** · 08:30');
  });

  it('names export files after the conversation', async () => {
    const exported = await archive();
    expect(exportFileName(exported, 'json')).toBe('Project-Alpha-2024-02-01T10-20-30.json');
    expect(exportFileName({ ...exported, conversations: [] }, 'zip')).toBe('teams-archive-2024-02-01T10-20-30.zip');
  });
});

describe('images in exports', () => {
  async function withImage() {
    const bytes = fakeImageBytes('https://example.invalid/chart.png', 40);
    const imageId = await sha256Hex(bytes);
    const pictured = createStoredMessage(
      message({ id: String(Date.UTC(2024, 0, 15, 9, 20)), text: 'Chart', attachments: [{ kind: 'image', name: 'chart.png', url: 'https://example.invalid/chart.png', imageId }, { kind: 'image', name: 'image', url: null, imageId: 'f'.repeat(64) }] }),
      ctx,
    );
    const withImages: ExportSource = {
      ...source,
      getMessages: async () => [...messages, pictured],
      getImages: async () => [
        { key: `${CK}#img:${imageId}`, conversationKey: CK, imageId, mimeType: 'image/png', byteLength: 40, width: 4, height: 2, method: 'fetch', data: toArrayBuffer(bytes), firstSavedAt: ctx.nowIso, sessionId: 's1', schemaVersion: 2 },
      ],
    };
    return { exported: await buildArchiveExport(withImages, [CK], { now: new Date('2024-02-01T10:20:30.456Z') }), imageId };
  }

  it('adds the images of each conversation as base64', async () => {
    const { exported, imageId } = await withImage();
    expect(exported.conversations[0]?.images).toEqual([
      { key: `${CK}#img:${imageId}`, conversationKey: CK, imageId, mimeType: 'image/png', byteLength: 40, width: 4, height: 2, method: 'fetch', firstSavedAt: ctx.nowIso, sessionId: 's1', schemaVersion: 2, dataBase64: Buffer.from(fakeImageBytes('https://example.invalid/chart.png', 40)).toString('base64') },
    ]);
    expect(parseArchiveExport(toJson(exported))).toEqual(exported);
  });

  it('names saved images in the Markdown transcript', async () => {
    const { exported, imageId } = await withImage();
    const markdown = toMarkdown(exported, { timeZone: 'UTC', locale: 'en-GB' });
    expect(markdown).toContain('- Saved images: 1 (in the JSON export, named here by file name)');
    expect(markdown).toContain(`_Attachments:_ Image: [chart.png](https://example.invalid/chart.png) (saved as \`${imageId}.png\`) · Image: image (saved image \`${'f'.repeat(64)}\`)`);
  });

  it('rejects malformed images and accepts exports without any', async () => {
    const { exported } = await withImage();
    const broken = (mutate: (copy: ArchiveExportV1) => void) => {
      const copy = structuredClone(exported);
      mutate(copy);
      return () => parseArchiveExport(copy);
    };
    expect(broken((copy) => ((copy.conversations[0] as { images: unknown }).images = {}))).toThrow(/conversations\[0\]\.images must be an array/);
    expect(broken((copy) => (copy.conversations[0]!.images![0]!.mimeType = 'text/html'))).toThrow(/images\[0\]: mimeType "text\/html" is not an image type/);
    expect(broken((copy) => (copy.conversations[0]!.images![0]!.imageId = 'nope'))).toThrow(/imageId must be/);
    expect(broken((copy) => (copy.conversations[0]!.images![0]!.conversationKey = 'teams:other'))).toThrow(/does not match its conversation/);
    expect(broken((copy) => (copy.conversations[0]!.images![0]!.key = 'teams:other#img:x'))).toThrow(/key does not match its image id/);
    expect(broken((copy) => delete copy.conversations[0]!.images)).not.toThrow();
  });
});

describe('import validation', () => {
  it('rejects anything that is not a valid v1 export', async () => {
    const exported = await archive();
    const broken = (mutate: (copy: ArchiveExportV1) => void) => {
      const copy = structuredClone(exported);
      mutate(copy);
      return () => parseArchiveExport(copy);
    };
    expect(broken((copy) => ((copy as { format: string }).format = 'other'))).toThrow(/Unsupported format/);
    expect(broken((copy) => ((copy as { formatVersion: number }).formatVersion = 2))).toThrow(/Unsupported format version 2/);
    expect(broken((copy) => (copy.conversations[0]!.messages[0]!.conversationKey = 'teams:other'))).toThrow(/does not match/);
    expect(broken((copy) => (copy.conversations[0]!.messages[1]!.sortKey = Number.NaN))).toThrow(/messages\[1\]\.sortKey/);
    expect(broken((copy) => ((copy.conversations[0] as { messages: unknown }).messages = 'x'))).toThrow(/messages must be an array/);
    expect(() => parseArchiveExport(null)).toThrow(/JSON object/);
  });
});
