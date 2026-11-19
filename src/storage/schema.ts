/**
 * IndexedDB layout (database "teams-chat-archive", owned by the extension origin).
 *
 *  conversations  key: conversationKey
 *  messages       key: key (`<conversationKey>#<messageId>` or `#fp:<fingerprint>`)
 *                 byConversationSort         [conversationKey, sortKey]      ordered reads, counts
 *                 byConversationFingerprint  [conversationKey, fingerprint]  duplicate detection without ids
 *                 byAlias                    aliases (multi-entry)            other keys a message is known by
 *  sessions       key: sessionId
 *                 byConversationStarted      [conversationKey, startedAt]
 *                 byStatus                   status
 *  meta           key: key (free-form key/value, e.g. schema info)
 *  images         key: key (`<conversationKey>#img:<imageId>`), since version 2
 *                 byConversationImage        [conversationKey, imageId]       images of a conversation
 *
 * Add migrations to `upgradeArchiveDb` and bump DB_VERSION; never edit a released step.
 */
export const DB_NAME = 'teams-chat-archive';
export const DB_VERSION = 2;

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
} as const;

export function upgradeArchiveDb(db: IDBDatabase, oldVersion: number): void {
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
}
