/**
 * A made-up conversation for export tests, with what every format has to handle: escaping, a
 * system event, a reply that only names its target by key, an edited message, file and image
 * attachments (one picture shown twice, one not saved), a formula-like text, a second day, and a
 * saved picture no message shows any more.
 */
import { sha256Hex, toArrayBuffer } from '../../src/shared/images';
import type { ConversationRecord, StoredImage, StoredMessage } from '../../src/shared/types';
import { createStoredMessage } from '../../src/storage/merge';
import { fakeImageBytes } from './images';
import { CK, message } from './messages';

export const FIXTURE_NOW = new Date('2024-02-01T10:20:30.456Z');
const ctx = { sessionId: 's1', nowIso: '2024-01-16T09:00:00.000Z' };
export const at = (day: number, hour: number, minute: number) => Date.UTC(2024, 0, day, hour, minute);

export interface ExportFixture {
  record: ConversationRecord;
  messages: StoredMessage[];
  images: StoredImage[];
  photo: Uint8Array;
  chart: Uint8Array;
  photoId: string;
  chartId: string;
  oldId: string;
}

function stored(conversationKey: string, imageId: string, bytes: Uint8Array, mimeType: string, savedAt: string): StoredImage {
  return { key: `${conversationKey}#img:${imageId}`, conversationKey, imageId, mimeType, byteLength: bytes.byteLength, width: 4, height: 2, method: 'fetch', data: toArrayBuffer(bytes), firstSavedAt: savedAt, sessionId: 's1', schemaVersion: 3 };
}

/** `shiftDays` moves every message (and so its Teams id) for a second, unrelated chat. */
export async function exportFixture(conversationKey = CK, title = 'Project Alpha', shiftDays = 0): Promise<ExportFixture> {
  const when = (day: number, hour: number, minute: number) => at(day + shiftDays, hour, minute);
  const photo = fakeImageBytes('https://example.invalid/photo.jpg', 50);
  const chart = fakeImageBytes('https://example.invalid/chart.png', 40);
  const old = fakeImageBytes('https://example.invalid/old.gif', 30);
  const [photoId, chartId, oldId] = await Promise.all([sha256Hex(photo), sha256Hex(chart), sha256Hex(old)]);
  const id = (day: number, hour: number, minute: number) => String(when(day, hour, minute));
  const first = createStoredMessage(message({ conversationKey, id: id(15, 9, 0), text: '# Agenda\nHere is <b>the</b> plan & more\n\n- not a list' }), ctx);
  const edited: StoredMessage = {
    ...createStoredMessage(
      message({
        conversationKey,
        id: id(15, 9, 10),
        text: 'Looks good *to me*',
        sender: { name: 'Bob Brown', id: '8:orgid:bob', isSelf: false, source: 'explicit' },
        attachments: [
          { kind: 'file', name: 'agenda_v2.docx', url: 'https://example.invalid/agenda_v2.docx' },
          { kind: 'image', name: 'image', url: null, imageId: photoId },
          { kind: 'image', name: 'lost.png', url: 'javascript:alert(1)', imageId: null },
        ],
        replyTo: { messageId: id(15, 9, 0), senderName: null, timestampRaw: null, preview: null, resolvedKey: `${conversationKey}#${id(15, 9, 0)}`, resolution: 'message-id' },
        reactions: [
          { emoji: '👍', count: 2, mine: true },
          { emoji: '🎉', count: 1, mine: false },
        ],
      }),
      ctx,
    ),
    isEdited: true,
    previousVersions: [{ text: 'Looks fine', html: '<p>Looks fine</p>', contentHash: 'h0', replacedAt: '2024-01-15T09:12:00.000Z' }],
  };
  const messages: StoredMessage[] = [
    first,
    createStoredMessage(message({ conversationKey, id: id(15, 9, 5), kind: 'system', text: 'Bob Brown joined the chat.', sender: { name: null, id: null, isSelf: false, source: 'unknown' } }), ctx),
    edited,
    createStoredMessage(
      message({
        conversationKey,
        id: id(15, 9, 20),
        text: '=1+1, "quoted"',
        attachments: [
          { kind: 'image', name: 'chart.png', url: null, imageId: chartId },
          { kind: 'image', name: 'image', url: null, imageId: photoId },
        ],
      }),
      ctx,
    ),
    createStoredMessage(message({ conversationKey, id: id(16, 8, 30), text: 'Next day', sender: { name: null, id: null, isSelf: true, source: 'self' } }), ctx),
  ];
  const record: ConversationRecord = {
    conversationKey,
    threadId: conversationKey.startsWith('teams:') ? conversationKey.slice('teams:'.length) : null,
    title,
    type: 'group',
    keySource: 'dom',
    typeSource: 'thread-id',
    participants: ['Alice Andersen', 'Bob Brown'],
    messageCount: messages.length,
    oldestSortKey: when(15, 9, 0),
    newestSortKey: when(16, 8, 30),
    coverage: [{ oldest: when(15, 9, 0), newest: when(16, 8, 30), reachedBeginning: true }],
    firstExtractedAt: ctx.nowIso,
    lastExtractedAt: ctx.nowIso,
    lastSessionId: 's1',
    schemaVersion: 3,
    aliases: [],
    mergedFrom: [],
    mergedInto: null,
    titleHistory: [{ title, firstSeenAt: ctx.nowIso, lastSeenAt: ctx.nowIso }],
    displayName: null,
    lastUpdate: { sessionId: 's1', mode: 'full', at: ctx.nowIso, newestSortKey: when(16, 8, 30) },
  };
  const images = [
    stored(conversationKey, oldId, old, 'image/gif', '2024-01-14T09:00:00.000Z'),
    stored(conversationKey, photoId, photo, 'image/jpeg', '2024-01-15T09:10:00.000Z'),
    stored(conversationKey, chartId, chart, 'image/png', '2024-01-15T09:20:00.000Z'),
  ];
  return { record, messages, images, photo, chart, photoId, chartId, oldId };
}
