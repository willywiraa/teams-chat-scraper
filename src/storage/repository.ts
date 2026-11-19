/**
 * The archive: IndexedDB persistence with transactional, idempotent upserts.
 *
 * Duplicate prevention happens at three levels:
 *  1. the engine skips repeat observations within a session;
 *  2. records are keyed by Teams message id, so re-observations merge into one record;
 *  3. messages without an id are keyed by a content fingerprint, and a fingerprint-keyed
 *     record is folded into the id-keyed one if the same message later shows its id.
 */
import {
  ARCHIVE_SCHEMA_VERSION,
  isReliableSortSource,
  type ConversationIdentity,
  type ConversationRecord,
  type CoverageRange,
  type ExtractedMessage,
  type SessionRecord,
  type SessionStatus,
  type StoredMessage,
  type UpsertStatus,
} from '../shared/types';
import { mergeAllCoverage } from './coverage';
import { openDatabase, prefixRange, requestToPromise, transactionDone } from './idb';
import { absorbDuplicate, mergeImported, mergeObservation } from './merge';
import { CANDIDATE_TEXT_LIMIT, findReplyTarget, normalizeForMatch, type ReplyCandidate } from './reply-resolver';
import { DB_NAME, DB_VERSION, INDEXES, STORES, upgradeArchiveDb } from './schema';

export interface UpsertBatchInput {
  conversation: ConversationIdentity;
  messages: ExtractedMessage[];
  sessionId: string;
  /** Contiguous ranges captured by the session so far; merged into the conversation coverage. */
  segments?: CoverageRange[];
  now?: Date;
}

export interface UpsertBatchResult {
  statuses: Record<string, UpsertStatus>;
  inserted: number;
  updated: number;
  unchanged: number;
  /** Fingerprint-keyed duplicates folded into an id-keyed record. */
  merged: number;
  conversation: ConversationRecord;
}

export interface ImportResult {
  inserted: number;
  updated: number;
  unchanged: number;
}

const IMPORT_CHUNK = 500;
const ACTIVE_STATUSES = ['running', 'paused'] as const;
/** Final statuses reported by the tab itself (unlike 'interrupted', which the background infers). */
const ENDED_STATUSES: readonly SessionStatus[] = ['completed', 'stopped', 'failed'];

function newConversationRecord(identity: ConversationIdentity, nowIso: string): ConversationRecord {
  return {
    conversationKey: identity.conversationKey,
    threadId: identity.threadId,
    title: identity.title,
    type: identity.type,
    keySource: identity.keySource,
    typeSource: identity.typeSource,
    participants: [],
    messageCount: 0,
    oldestSortKey: null,
    newestSortKey: null,
    coverage: [],
    firstExtractedAt: nowIso,
    lastExtractedAt: nowIso,
    lastSessionId: null,
    schemaVersion: ARCHIVE_SCHEMA_VERSION,
  };
}

function applyIdentity(existing: ConversationRecord | undefined, identity: ConversationIdentity, nowIso: string): ConversationRecord {
  if (!existing) return newConversationRecord(identity, nowIso);
  const next: ConversationRecord = { ...existing, coverage: existing.coverage.map((r) => ({ ...r })), participants: [...existing.participants] };
  if (identity.title) next.title = identity.title;
  if (identity.threadId && !next.threadId) next.threadId = identity.threadId;
  if (identity.typeSource === 'thread-id' || next.type === 'unknown') {
    next.type = identity.type;
    next.typeSource = identity.typeSource;
  }
  return next;
}

function minOrNull(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.min(a, b);
}

function maxOrNull(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.max(a, b);
}

export class ArchiveRepository {
  private constructor(private readonly db: IDBDatabase) {}

  static async open(factory: IDBFactory = indexedDB, name: string = DB_NAME): Promise<ArchiveRepository> {
    const db = await openDatabase(factory, name, DB_VERSION, (database, oldVersion) => upgradeArchiveDb(database, oldVersion));
    return new ArchiveRepository(db);
  }

  close(): void {
    this.db.close();
  }

  // ---------------------------------------------------------------- messages

  /** Merges one pass of observations, atomically, and updates the conversation record. */
  async upsertObservations(input: UpsertBatchInput): Promise<UpsertBatchResult> {
    const nowIso = (input.now ?? new Date()).toISOString();
    const conversationKey = input.conversation.conversationKey;
    const ctx = { sessionId: input.sessionId, nowIso };
    const tx = this.db.transaction([STORES.messages, STORES.conversations], 'readwrite');
    const done = transactionDone(tx);
    const messages = tx.objectStore(STORES.messages);
    const conversations = tx.objectStore(STORES.conversations);
    const byFingerprint = messages.index(INDEXES.messagesByFingerprint);
    const byAlias = messages.index(INDEXES.messagesByAlias);

    /** A message without id or exact timestamp may be archived under one of its alternative keys. */
    const findByAlternateKeys = async (observation: ExtractedMessage): Promise<StoredMessage | undefined> => {
      for (const candidate of [observation.key, ...(observation.alternateKeys ?? [])]) {
        if (candidate !== observation.key) {
          const direct = (await requestToPromise(messages.get(candidate))) as StoredMessage | undefined;
          if (direct) return direct;
        }
        const aliased = (await requestToPromise(byAlias.getAll(candidate))) as StoredMessage[];
        const match = aliased.find((message) => message.conversationKey === conversationKey);
        if (match) return match;
      }
      return undefined;
    };

    try {
      const existingConversation = (await requestToPromise(conversations.get(conversationKey))) as ConversationRecord | undefined;
      const conversation = applyIdentity(existingConversation, input.conversation, nowIso);
      const participants = new Set(conversation.participants);
      const statuses: Record<string, UpsertStatus> = {};
      let inserted = 0;
      let updated = 0;
      let unchanged = 0;
      let merged = 0;

      for (const observation of input.messages) {
        if (observation.conversationKey !== conversationKey) {
          throw new Error(`Message ${observation.key} does not belong to conversation ${conversationKey}`);
        }
        let existing = (await requestToPromise(messages.get(observation.key))) as StoredMessage | undefined;
        let duplicate: StoredMessage | undefined;
        if (!existing && observation.fingerprintStrong) {
          const sameFingerprint = (await requestToPromise(byFingerprint.getAll([conversationKey, observation.fingerprint]))) as StoredMessage[];
          if (observation.idSource === 'fingerprint') {
            existing = sameFingerprint.find((m) => m.idSource === 'dom') ?? sameFingerprint[0];
          } else {
            duplicate = sameFingerprint.find((m) => m.idSource === 'fingerprint' && m.key !== observation.key);
          }
        } else if (!existing && observation.idSource === 'fingerprint') {
          existing = await findByAlternateKeys(observation);
        }

        const result = mergeObservation(existing, observation, ctx);
        let record = result.record;
        let status = result.status;
        if (duplicate) {
          record = absorbDuplicate(record, duplicate);
          await requestToPromise(messages.delete(duplicate.key));
          if (status === 'inserted') status = 'updated';
          merged++;
        }
        await requestToPromise(messages.put(record));
        statuses[observation.key] = status;
        if (status === 'inserted') inserted++;
        else if (status === 'updated') updated++;
        else unchanged++;

        if (record.kind === 'message' && record.sender.name) participants.add(record.sender.name);
        if (isReliableSortSource(record.sortKeySource)) {
          conversation.oldestSortKey = minOrNull(conversation.oldestSortKey, record.sortKey);
          conversation.newestSortKey = maxOrNull(conversation.newestSortKey, record.sortKey);
        }
      }

      conversation.participants = Array.from(participants).sort((a, b) => a.localeCompare(b));
      conversation.messageCount = await requestToPromise(messages.index(INDEXES.messagesBySort).count(prefixRange(conversationKey)));
      if (input.segments && input.segments.length > 0) conversation.coverage = mergeAllCoverage(conversation.coverage, input.segments);
      conversation.lastExtractedAt = nowIso;
      conversation.lastSessionId = input.sessionId;
      await requestToPromise(conversations.put(conversation));
      await done;
      return { statuses, inserted, updated, unchanged, merged, conversation };
    } catch (error) {
      try {
        tx.abort();
      } catch {
        // Already finished or aborted.
      }
      await done.catch(() => undefined);
      throw error;
    }
  }

  async getMessage(key: string): Promise<StoredMessage | undefined> {
    const tx = this.db.transaction(STORES.messages, 'readonly');
    return (await requestToPromise(tx.objectStore(STORES.messages).get(key))) as StoredMessage | undefined;
  }

  /** Messages of a conversation in timeline order. */
  async getMessages(conversationKey: string, limit?: number): Promise<StoredMessage[]> {
    const tx = this.db.transaction(STORES.messages, 'readonly');
    const index = tx.objectStore(STORES.messages).index(INDEXES.messagesBySort);
    return (await requestToPromise(index.getAll(prefixRange(conversationKey), limit))) as StoredMessage[];
  }

  async countMessages(conversationKey: string): Promise<number> {
    const tx = this.db.transaction(STORES.messages, 'readonly');
    return requestToPromise(tx.objectStore(STORES.messages).index(INDEXES.messagesBySort).count(prefixRange(conversationKey)));
  }

  /** Streams messages in timeline order without loading them all at once. The callback must be synchronous. */
  async forEachMessage(conversationKey: string, callback: (message: StoredMessage) => void): Promise<void> {
    const tx = this.db.transaction(STORES.messages, 'readonly');
    const done = transactionDone(tx);
    const request = tx.objectStore(STORES.messages).index(INDEXES.messagesBySort).openCursor(prefixRange(conversationKey));
    await new Promise<void>((resolve, reject) => {
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) {
          resolve();
          return;
        }
        try {
          callback(cursor.value as StoredMessage);
        } catch (error) {
          reject(error);
          return;
        }
        cursor.continue();
      };
      request.onerror = () => reject(request.error);
    });
    await done;
  }

  // ----------------------------------------------------------- conversations

  async getConversation(conversationKey: string): Promise<ConversationRecord | undefined> {
    const tx = this.db.transaction(STORES.conversations, 'readonly');
    return (await requestToPromise(tx.objectStore(STORES.conversations).get(conversationKey))) as ConversationRecord | undefined;
  }

  async listConversations(): Promise<ConversationRecord[]> {
    const tx = this.db.transaction(STORES.conversations, 'readonly');
    const all = (await requestToPromise(tx.objectStore(STORES.conversations).getAll())) as ConversationRecord[];
    return all.sort((a, b) => b.lastExtractedAt.localeCompare(a.lastExtractedAt));
  }

  async mergeCoverage(conversationKey: string, segments: CoverageRange[]): Promise<ConversationRecord | null> {
    if (segments.length === 0) return (await this.getConversation(conversationKey)) ?? null;
    const tx = this.db.transaction(STORES.conversations, 'readwrite');
    const done = transactionDone(tx);
    const store = tx.objectStore(STORES.conversations);
    const conversation = (await requestToPromise(store.get(conversationKey))) as ConversationRecord | undefined;
    if (!conversation) {
      await done;
      return null;
    }
    conversation.coverage = mergeAllCoverage(conversation.coverage, segments);
    await requestToPromise(store.put(conversation));
    await done;
    return conversation;
  }

  /** Deletes a conversation with all its messages and sessions. */
  async deleteConversation(conversationKey: string): Promise<{ messages: number; sessions: number }> {
    const tx = this.db.transaction([STORES.messages, STORES.sessions, STORES.conversations], 'readwrite');
    const done = transactionDone(tx);
    const deleteVia = (index: IDBIndex) =>
      new Promise<number>((resolve, reject) => {
        let count = 0;
        const request = index.openCursor(prefixRange(conversationKey));
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor) {
            resolve(count);
            return;
          }
          cursor.delete();
          count++;
          cursor.continue();
        };
        request.onerror = () => reject(request.error);
      });
    const messages = await deleteVia(tx.objectStore(STORES.messages).index(INDEXES.messagesBySort));
    const sessions = await deleteVia(tx.objectStore(STORES.sessions).index(INDEXES.sessionsByConversation));
    await requestToPromise(tx.objectStore(STORES.conversations).delete(conversationKey));
    await done;
    return { messages, sessions };
  }

  // ---------------------------------------------------------------- sessions

  async createSession(session: SessionRecord): Promise<void> {
    const tx = this.db.transaction(STORES.sessions, 'readwrite');
    const done = transactionDone(tx);
    await requestToPromise(tx.objectStore(STORES.sessions).put(session));
    await done;
  }

  async getSession(sessionId: string): Promise<SessionRecord | undefined> {
    const tx = this.db.transaction(STORES.sessions, 'readonly');
    return (await requestToPromise(tx.objectStore(STORES.sessions).get(sessionId))) as SessionRecord | undefined;
  }

  /**
   * Patches a session record. With `skipIfEnded`, a session that its tab already reported as
   * ended (completed, stopped or failed) is left untouched; the check and the write are atomic.
   * Returns null when nothing was written.
   */
  async updateSession(sessionId: string, patch: Partial<SessionRecord>, options: { skipIfEnded?: boolean } = {}): Promise<SessionRecord | null> {
    const tx = this.db.transaction(STORES.sessions, 'readwrite');
    const done = transactionDone(tx);
    const store = tx.objectStore(STORES.sessions);
    const session = (await requestToPromise(store.get(sessionId))) as SessionRecord | undefined;
    if (!session || (options.skipIfEnded && ENDED_STATUSES.includes(session.status))) {
      await done;
      return null;
    }
    const next: SessionRecord = { ...session, ...patch, sessionId };
    await requestToPromise(store.put(next));
    await done;
    return next;
  }

  /** Sessions newest first, optionally for one conversation. */
  async listSessions(options: { conversationKey?: string; limit?: number } = {}): Promise<SessionRecord[]> {
    const tx = this.db.transaction(STORES.sessions, 'readonly');
    const store = tx.objectStore(STORES.sessions);
    const all = options.conversationKey
      ? ((await requestToPromise(store.index(INDEXES.sessionsByConversation).getAll(prefixRange(options.conversationKey)))) as SessionRecord[])
      : ((await requestToPromise(store.getAll())) as SessionRecord[]);
    all.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    return options.limit ? all.slice(0, options.limit) : all;
  }

  async latestSession(conversationKey: string): Promise<SessionRecord | null> {
    return (await this.listSessions({ conversationKey, limit: 1 }))[0] ?? null;
  }

  /** The most recent session, if it ended before reaching its goal and can be continued. */
  async findResumableSession(conversationKey: string): Promise<SessionRecord | null> {
    const latest = await this.latestSession(conversationKey);
    if (!latest || latest.mode === 'visible') return null;
    return ['interrupted', 'stopped', 'failed'].includes(latest.status) ? latest : null;
  }

  /**
   * Marks running/paused sessions whose heartbeat is older than `staleMs` as interrupted
   * (tab closed, page reloaded, browser crashed). Optionally restricted to one tab.
   */
  async markStaleSessions(nowMs: number, staleMs: number, onlyTabId?: number): Promise<number> {
    const tx = this.db.transaction(STORES.sessions, 'readwrite');
    const done = transactionDone(tx);
    const store = tx.objectStore(STORES.sessions);
    let count = 0;
    for (const status of ACTIVE_STATUSES) {
      const sessions = (await requestToPromise(store.index(INDEXES.sessionsByStatus).getAll(status))) as SessionRecord[];
      for (const session of sessions) {
        const stale = Date.parse(session.updatedAt) <= nowMs - staleMs;
        const tabMatches = onlyTabId === undefined || session.tabId === onlyTabId;
        if (!tabMatches || (onlyTabId === undefined && !stale)) continue;
        await requestToPromise(
          store.put({ ...session, status: 'interrupted', stopReason: 'interrupted', endedAt: session.updatedAt } satisfies SessionRecord),
        );
        count++;
      }
    }
    await done;
    return count;
  }

  // ----------------------------------------------------------------- replies

  /** Resolves quoted replies that lack a target key by matching their preview text. */
  async resolveReplies(conversationKey: string): Promise<{ resolved: number; unresolved: number }> {
    const candidates: ReplyCandidate[] = [];
    const pending: Array<{ key: string; sortKey: number; message: StoredMessage }> = [];
    await this.forEachMessage(conversationKey, (message) => {
      candidates.push({
        key: message.key,
        senderName: message.sender.name,
        sortKey: message.sortKey,
        textNorm: normalizeForMatch(message.text).slice(0, CANDIDATE_TEXT_LIMIT),
      });
      if (message.replyTo && !message.replyTo.resolvedKey) pending.push({ key: message.key, sortKey: message.sortKey, message });
    });
    const updates: Array<{ key: string; resolvedKey: string }> = [];
    for (const item of pending) {
      const target = findReplyTarget(item.message.replyTo!, item.key, item.sortKey, candidates);
      if (target) updates.push({ key: item.key, resolvedKey: target });
    }
    if (updates.length > 0) {
      const tx = this.db.transaction(STORES.messages, 'readwrite');
      const done = transactionDone(tx);
      const store = tx.objectStore(STORES.messages);
      for (const update of updates) {
        const record = (await requestToPromise(store.get(update.key))) as StoredMessage | undefined;
        if (!record?.replyTo || record.replyTo.resolvedKey) continue;
        record.replyTo = { ...record.replyTo, resolvedKey: update.resolvedKey, resolution: 'content-match' };
        await requestToPromise(store.put(record));
      }
      await done;
    }
    return { resolved: updates.length, unresolved: pending.length - updates.length };
  }

  // ------------------------------------------------------------------ import

  /** Merges an exported conversation (see export/format.ts) into the archive. Idempotent. */
  async importConversation(incoming: ConversationRecord, messages: StoredMessage[]): Promise<ImportResult> {
    const result: ImportResult = { inserted: 0, updated: 0, unchanged: 0 };
    const key = incoming.conversationKey;
    for (let start = 0; start < messages.length; start += IMPORT_CHUNK) {
      const chunk = messages.slice(start, start + IMPORT_CHUNK);
      const tx = this.db.transaction(STORES.messages, 'readwrite');
      const done = transactionDone(tx);
      const store = tx.objectStore(STORES.messages);
      for (const message of chunk) {
        if (message.conversationKey !== key) throw new Error(`Imported message ${message.key} does not belong to ${key}`);
        const existing = (await requestToPromise(store.get(message.key))) as StoredMessage | undefined;
        const merged = mergeImported(existing, message);
        if (merged.status !== 'unchanged') await requestToPromise(store.put(merged.record));
        result[merged.status]++;
      }
      await done;
    }

    const tx = this.db.transaction([STORES.messages, STORES.conversations], 'readwrite');
    const done = transactionDone(tx);
    const conversations = tx.objectStore(STORES.conversations);
    const existing = (await requestToPromise(conversations.get(key))) as ConversationRecord | undefined;
    const base: ConversationRecord = existing
      ? { ...existing }
      : { ...incoming, participants: [], coverage: [], messageCount: 0, oldestSortKey: null, newestSortKey: null };
    if (!existing || incoming.lastExtractedAt > existing.lastExtractedAt) {
      base.title = incoming.title ?? base.title;
      base.lastSessionId = incoming.lastSessionId ?? base.lastSessionId;
    }
    base.threadId = base.threadId ?? incoming.threadId;
    if (base.type === 'unknown') {
      base.type = incoming.type;
      base.typeSource = incoming.typeSource;
    }
    base.participants = Array.from(new Set([...base.participants, ...(incoming.participants ?? [])])).sort((a, b) => a.localeCompare(b));
    base.coverage = mergeAllCoverage(base.coverage, incoming.coverage ?? []);
    base.oldestSortKey = minOrNull(base.oldestSortKey, incoming.oldestSortKey ?? null);
    base.newestSortKey = maxOrNull(base.newestSortKey, incoming.newestSortKey ?? null);
    base.firstExtractedAt = existing && existing.firstExtractedAt < incoming.firstExtractedAt ? existing.firstExtractedAt : incoming.firstExtractedAt;
    base.lastExtractedAt = existing && existing.lastExtractedAt > incoming.lastExtractedAt ? existing.lastExtractedAt : incoming.lastExtractedAt;
    base.schemaVersion = ARCHIVE_SCHEMA_VERSION;
    base.messageCount = await requestToPromise(tx.objectStore(STORES.messages).index(INDEXES.messagesBySort).count(prefixRange(key)));
    await requestToPromise(conversations.put(base));
    await done;
    return result;
  }
}
