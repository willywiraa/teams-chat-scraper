/**
 * IndexedDB layout (database "teams-chat-archive", owned by the extension origin).
 *
 *  conversations  key: conversationKey
 *                 byAlias                    aliases (multi-entry)            other keys a conversation is known by, since version 3
 *  messages       key: key (`<conversationKey>#<messageId>` or `#fp:<fingerprint>`)
 *                 byConversationSort         [conversationKey, sortKey]      ordered reads, counts
 *                 byConversationFingerprint  [conversationKey, fingerprint]  duplicate detection without ids
 *                 byAlias                    aliases (multi-entry)            other keys a message is known by
 *                 byMessageId                messageId                        which conversations hold a Teams message, since version 3
 *  sessions       key: sessionId
 *                 byConversationStarted      [conversationKey, startedAt]
 *                 byStatus                   status
 *  meta           key: key (free-form key/value: schema info, `merge:<conversationKey>` merge journals)
 *  images         key: key (`<conversationKey>#img:<imageId>`), since version 2
 *                 byConversationImage        [conversationKey, imageId]       images of a conversation
 *
 * Add migrations to `upgradeArchiveDb` and bump DB_VERSION; never edit a released step.
 */
export const DB_NAME = 'teams-chat-archive';
export const DB_VERSION = 3;

export const STORES = {
  conversations: 'conversations',
  messages: 'messages',
  sessions: 'sessions',
  meta: 'meta',
  images: 'images',
} as const;

export const INDEXES = {
  messagesBySort: 'byConversationSort',
  messagesByFingerprint: 'byConversationFingerprint',
  messagesByAlias: 'byAlias',
  sessionsByConversation: 'byConversationStarted',
  sessionsByStatus: 'byStatus',
  imagesByConversation: 'byConversationImage',
  conversationsByAlias: 'byAlias',
  messagesByMessageId: 'byMessageId',
} as const;

/**
 * Brings a database at `oldVersion` up to DB_VERSION. `tx` is the upgrade transaction, which
 * gives access to stores created by earlier versions.
 */
export function upgradeArchiveDb(db: IDBDatabase, oldVersion: number, tx: IDBTransaction): void {
  if (oldVersion < 1) {
    db.createObjectStore(STORES.conversations, { keyPath: 'conversationKey' });

    const messages = db.createObjectStore(STORES.messages, { keyPath: 'key' });
    messages.createIndex(INDEXES.messagesBySort, ['conversationKey', 'sortKey'], { unique: false });
    messages.createIndex(INDEXES.messagesByFingerprint, ['conversationKey', 'fingerprint'], { unique: false });
    messages.createIndex(INDEXES.messagesByAlias, 'aliases', { unique: false, multiEntry: true });

    const sessions = db.createObjectStore(STORES.sessions, { keyPath: 'sessionId' });
    sessions.createIndex(INDEXES.sessionsByConversation, ['conversationKey', 'startedAt'], { unique: false });
    sessions.createIndex(INDEXES.sessionsByStatus, 'status', { unique: false });

    db.createObjectStore(STORES.meta, { keyPath: 'key' });
  }
  if (oldVersion < 2) {
    // Version 2 (extractor 1.1): saved images. Existing stores and records are left untouched.
    const images = db.createObjectStore(STORES.images, { keyPath: 'key' });
    images.createIndex(INDEXES.imagesByConversation, ['conversationKey', 'imageId'], { unique: true });
  }
  if (oldVersion < 3) {
    // Version 3 (extension 1.2): conversation identity. Indexes only; records are left untouched
    // (the new conversation fields are optional). Messages without a Teams id are not indexed.
    tx.objectStore(STORES.conversations).createIndex(INDEXES.conversationsByAlias, 'aliases', { unique: false, multiEntry: true });
    tx.objectStore(STORES.messages).createIndex(INDEXES.messagesByMessageId, 'messageId', { unique: false });
  }
}
