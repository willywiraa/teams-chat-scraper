/**
 * Upgrading an archive created by an earlier version of the extension keeps everything in it:
 * version 1 (extension 1.0) gains the image store, versions 1 and 2 (extension 1.1) gain the
 * indexes that let a chat be found again after a rename or a merge.
 */
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, describe, expect, it } from 'vitest';
import { bytesToBase64, sha256Hex } from '../../src/shared/images';
import type { ConversationRecord, SessionRecord, StoredImage, StoredMessage } from '../../src/shared/types';
import { saveCapturedImages } from '../../src/storage/images';
import { openDatabase, requestToPromise, transactionDone } from '../../src/storage/idb';
import { createStoredMessage } from '../../src/storage/merge';
import { ArchiveRepository } from '../../src/storage/repository';
import { DB_VERSION, INDEXES, STORES } from '../../src/storage/schema';
import { fakeImageBytes } from '../helpers/images';
import { CK, CONVERSATION, message, session } from '../helpers/messages';

/** The schema exactly as released in version 1 (a frozen copy: the code may only add steps). */
function createVersion1Schema(db: IDBDatabase): void {
  db.createObjectStore('conversations', { keyPath: 'conversationKey' });
  const messages = db.createObjectStore('messages', { keyPath: 'key' });
  messages.createIndex('byConversationSort', ['conversationKey', 'sortKey'], { unique: false });
  messages.createIndex('byConversationFingerprint', ['conversationKey', 'fingerprint'], { unique: false });
  messages.createIndex('byAlias', 'aliases', { unique: false, multiEntry: true });
  const sessions = db.createObjectStore('sessions', { keyPath: 'sessionId' });
  sessions.createIndex('byConversationStarted', ['conversationKey', 'startedAt'], { unique: false });
  sessions.createIndex('byStatus', 'status', { unique: false });
  db.createObjectStore('meta', { keyPath: 'key' });
}

/** The schema exactly as released in version 2 (extension 1.1): version 1 plus the image store. */
function createVersion2Schema(db: IDBDatabase): void {
  createVersion1Schema(db);
  const images = db.createObjectStore('images', { keyPath: 'key' });
  images.createIndex('byConversationImage', ['conversationKey', 'imageId'], { unique: true });
}

/** Indexes of every store after the upgrade to the current version. */
const CURRENT_INDEXES: Record<string, string[]> = {
  conversations: ['byAlias'],
  images: ['byConversationImage'],
  messages: ['byAlias', 'byConversationFingerprint', 'byConversationSort', 'byMessageId'],
  meta: [],
  sessions: ['byConversationStarted', 'byStatus'],
};

/** Opens the upgraded database without the repository and checks its version, stores and indexes. */
async function expectCurrentSchema(factory: IDBFactory, name: string): Promise<IDBDatabase> {
  const upgraded = await openDatabase(factory, name, DB_VERSION, () => {
    throw new Error('no further upgrade expected');
  });
  expect(upgraded.version).toBe(3);
  expect(Array.from(upgraded.objectStoreNames).sort()).toEqual(Object.keys(CURRENT_INDEXES));
  const read = upgraded.transaction(Object.keys(CURRENT_INDEXES), 'readonly');
  for (const [store, indexes] of Object.entries(CURRENT_INDEXES)) {
    expect(Array.from(read.objectStore(store).indexNames).sort(), store).toEqual(indexes);
  }
  return upgraded;
}

const ctx = { sessionId: 'old-session', nowIso: '2024-01-15T12:00:00.000Z' };

/** Records as version 1.0 wrote them (schema version 1, no image ids). */
function version1Records() {
  const asV1 = (record: StoredMessage): StoredMessage => ({ ...record, extractorVersion: '1.0.0', schemaVersion: 1 });
  const messages = [
    asV1(createStoredMessage(message({ id: '1705314600000', text: 'Before the upgrade', attachments: [{ kind: 'image', name: 'image', url: 'https://example.invalid/a.png' }] }), ctx)),
    asV1({ ...createStoredMessage(message({ id: '1705314660000', text: 'Known by an alias' }), ctx), aliases: [`${CK}#fp:legacy`] }),
  ];
  const conversation: ConversationRecord = {
    conversationKey: CK,
    threadId: CONVERSATION.threadId,
    title: CONVERSATION.title,
    type: 'group',
    keySource: 'dom',
    typeSource: 'thread-id',
    participants: ['Alice Andersen'],
    messageCount: 2,
    oldestSortKey: 1705314600000,
    newestSortKey: 1705314660000,
    coverage: [{ oldest: 1705314600000, newest: 1705314660000, reachedBeginning: true }],
    firstExtractedAt: ctx.nowIso,
    lastExtractedAt: ctx.nowIso,
    lastSessionId: 'old-session',
    schemaVersion: 1,
  };
  // Sessions recorded before 1.1 have no image counters.
  const { imagesSaved: _saved, imagesFailed: _failed, ...oldCounters } = session().counters;
  const oldSession = { ...session({ sessionId: 'old-session', status: 'completed', stopReason: 'reached-top' }), counters: oldCounters } as SessionRecord;
  return { messages, conversation, oldSession };
}

let repository: ArchiveRepository | null = null;
afterEach(() => {
  repository?.close();
  repository = null;
});

describe('database upgrade from version 1', () => {
  it('keeps conversations, messages, sessions and meta data, and adds the image store', async () => {
    const factory = new IDBFactory();
    const name = 'archive-v1';
    const v1 = version1Records();
    const db = await openDatabase(factory, name, 1, (database) => createVersion1Schema(database));
    const tx = db.transaction(['conversations', 'messages', 'sessions', 'meta'], 'readwrite');
    const written = transactionDone(tx);
    tx.objectStore('conversations').put(v1.conversation);
    for (const record of v1.messages) tx.objectStore('messages').put(record);
    tx.objectStore('sessions').put(v1.oldSession);
    tx.objectStore('meta').put({ key: 'note', value: 'written by 1.0' });
    await written;
    db.close();

    repository = await ArchiveRepository.open(factory, name);
    expect(await repository.getConversation(CK)).toEqual(v1.conversation);
    expect(await repository.getMessages(CK)).toEqual(v1.messages);
    expect(await repository.getSession('old-session')).toEqual(v1.oldSession);
    expect(await repository.countImages(CK)).toBe(0);

    // The old indexes still work: an observation under the alias key finds the old record.
    const viaAlias = await repository.upsertObservations({
      conversation: CONVERSATION,
      messages: [message({ id: null, key: `${CK}#fp:legacy`, text: 'Known by an alias', fingerprintStrong: false })],
      sessionId: 'new-session',
    });
    expect(viaAlias.inserted).toBe(0);
    expect(await repository.countMessages(CK)).toBe(2);

    // Images can be saved and linked to a message archived before the upgrade.
    const bytes = fakeImageBytes('https://example.invalid/a.png');
    const imageId = await sha256Hex(bytes);
    const stored = await saveCapturedImages(
      repository,
      CK,
      [{ imageId, mimeType: 'image/png', byteLength: bytes.byteLength, width: 4, height: 4, method: 'fetch', dataBase64: bytesToBase64(bytes) }],
      { sessionId: 'new-session', nowIso: '2024-03-01T00:00:00.000Z' },
    );
    expect(stored).toEqual({ statuses: { [imageId]: 'inserted' }, rejected: {} });
    const linked = await repository.upsertObservations({
      conversation: CONVERSATION,
      messages: [message({ id: '1705314600000', text: 'Before the upgrade', attachments: [{ kind: 'image', name: 'image', url: 'https://example.invalid/a.png', imageId }] })],
      sessionId: 'new-session',
    });
    expect(linked.updated).toBe(1);
    expect((await repository.getMessage(`${CK}#1705314600000`))?.attachments).toEqual([{ kind: 'image', name: 'image', url: 'https://example.invalid/a.png', imageId }]);
    repository.close();
    repository = null;

    // Raw view of the upgraded database: version, stores, indexes and the untouched meta record.
    const upgraded = await expectCurrentSchema(factory, name);
    try {
      const read = upgraded.transaction(STORES.meta, 'readonly');
      expect(await requestToPromise(read.objectStore(STORES.meta).get('note'))).toEqual({ key: 'note', value: 'written by 1.0' });
    } finally {
      upgraded.close();
    }
  });

  it('creates a fresh database at the current version', async () => {
    const factory = new IDBFactory();
    repository = await ArchiveRepository.open(factory, 'fresh');
    expect(await repository.listConversations()).toEqual([]);
    expect(await repository.countImages(CK)).toBe(0);
    repository.close();
    repository = null;
    (await expectCurrentSchema(factory, 'fresh')).close();
  });
});

describe('database upgrade from version 2', () => {
  it('keeps every record and indexes archived messages and conversations for identification', async () => {
    const factory = new IDBFactory();
    const name = 'archive-v2';
    const v1 = version1Records();
    const conversation: ConversationRecord = { ...v1.conversation, schemaVersion: 2 };
    const withoutId: StoredMessage = { ...createStoredMessage(message({ id: null, text: 'No id' }), ctx), schemaVersion: 2 };
    const bytes = fakeImageBytes('https://example.invalid/b.png');
    const imageId = await sha256Hex(bytes);
    const image: StoredImage = {
      key: `${CK}#img:${imageId}`,
      conversationKey: CK,
      imageId,
      mimeType: 'image/png',
      byteLength: bytes.byteLength,
      width: 4,
      height: 4,
      method: 'fetch',
      data: bytes.slice().buffer as ArrayBuffer,
      firstSavedAt: ctx.nowIso,
      sessionId: 'old-session',
      schemaVersion: 2,
    };
    const db = await openDatabase(factory, name, 2, (database) => createVersion2Schema(database));
    const tx = db.transaction(['conversations', 'messages', 'sessions', 'meta', 'images'], 'readwrite');
    const written = transactionDone(tx);
    tx.objectStore('conversations').put(conversation);
    for (const record of [...v1.messages, withoutId]) tx.objectStore('messages').put(record);
    tx.objectStore('sessions').put(v1.oldSession);
    tx.objectStore('meta').put({ key: 'note', value: 'written by 1.1' });
    tx.objectStore('images').put(image);
    await written;
    db.close();

    repository = await ArchiveRepository.open(factory, name);
    expect(await repository.getConversation(CK)).toEqual(conversation);
    expect(await repository.getMessages(CK)).toEqual(expect.arrayContaining([...v1.messages, withoutId]));
    expect(await repository.countMessages(CK)).toBe(3);
    expect(await repository.getSession('old-session')).toEqual(v1.oldSession);
    expect(await repository.getImage(CK, imageId)).toEqual(image);
    repository.close();
    repository = null;

    const upgraded = await expectCurrentSchema(factory, name);
    try {
      const read = upgraded.transaction([STORES.messages, STORES.conversations, STORES.meta], 'readonly');
      // The message id index covers messages archived before the upgrade; messages without an id are left out.
      const byMessageId = read.objectStore(STORES.messages).index(INDEXES.messagesByMessageId);
      const found = (await requestToPromise(byMessageId.getAll('1705314660000'))) as StoredMessage[];
      expect(found.map((record) => record.key)).toEqual([`${CK}#1705314660000`]);
      expect(await requestToPromise(byMessageId.count())).toBe(2);
      // Conversations archived before the upgrade have no aliases yet.
      expect(await requestToPromise(read.objectStore(STORES.conversations).index(INDEXES.conversationsByAlias).count())).toBe(0);
      expect(await requestToPromise(read.objectStore(STORES.meta).get('note'))).toEqual({ key: 'note', value: 'written by 1.1' });
    } finally {
      upgraded.close();
    }
  });
});
