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
  conversationLabel,
  isReliableSortSource,
  type ArchivedImages,
  type ConversationIdentity,
  type ConversationRecord,
  type CoverageRange,
  type ExtractedMessage,
  type IdentityEvidence,
  type ImageSaveStatus,
  type LastUpdate,
  type ScrapeMode,
  type SessionRecord,
  type SessionStatus,
  type StoredImage,
  type StoredMessage,
  type UpsertStatus,
} from '../shared/types';
import { imageKey } from '../shared/images';
import { normalizeTitleKey } from '../extractor/conversation';
import {
  cleanDisplayName,
  cleanLastUpdate,
  combineConversations,
  decideConversation,
  laterUpdate,
  mergeTitleHistories,
  noteTitle,
  rekeyImage,
  rekeyMessage,
  titleHistoryOf,
  withConversationAliases,
  type ConversationResolution,
  type MessageOverlap,
} from './conversation-identity';
import { caughtUp, mergeAllCoverage } from './coverage';
import { openDatabase, prefixRange, readLast, requestToPromise, transactionDone } from './idb';
import { absorbDuplicate, mergeImported, mergeObservation } from './merge';
import { CANDIDATE_TEXT_LIMIT, findReplyTarget, normalizeForMatch, type ReplyCandidate } from './reply-resolver';
import { DB_NAME, DB_VERSION, INDEXES, STORES, upgradeArchiveDb } from './schema';

export interface UpsertBatchInput {
  conversation: ConversationIdentity;
  messages: ExtractedMessage[];
  sessionId: string;
  /** Contiguous ranges captured by the session so far; merged into the conversation coverage. */
  segments?: CoverageRange[];
  /** Other keys the conversation is known by, such as the key detected in Teams when it differs. */
  aliases?: string[];
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

/** The end of a run, as far as the conversation's last update is concerned. */
export interface RunEnd {
  sessionId: string;
  mode: ScrapeMode;
  /** When the run ended. */
  at: string;
  /** Newest message the run reached (sort key), or null. */
  newestSortKey: number | null;
  /** Where the archive was up to date when the run started (see SessionRecord.continuesFrom). */
  continuesFrom: number | null;
}

export interface ImportResult {
  inserted: number;
  updated: number;
  unchanged: number;
}

export interface MergeOptions {
  now?: Date;
  /** A session of the entry being merged that reported within this time is still running (ms). */
  staleSessionMs?: number;
  /** Messages moved per transaction. */
  messageChunk?: number;
  /** Images moved per transaction. */
  imageChunk?: number;
  /** Called after each step. Throwing interrupts the merge; resumePendingMerges() finishes it. */
  onProgress?: (progress: MergeProgress) => void | Promise<void>;
}

export interface MergeProgress {
  sourceKey: string;
  targetKey: string;
  messagesMoved: number;
  imagesMoved: number;
  sessionsMoved: number;
}

export interface MergeOutcome extends MergeProgress {
  /** The entry the other one was merged into, as it is now. */
  target: ConversationRecord;
}

/** Another archive entry that holds some of the same messages as the entry asked about. */
export interface SharedMessages {
  conversationKey: string;
  /** Messages with a Teams id that both entries hold, among those compared. */
  shared: number;
}

/** Kept in the meta store while a merge runs, so an interrupted merge can be finished. */
export interface MergeJournal {
  key: string;
  sourceKey: string;
  targetKey: string;
  startedAt: string;
}

const IMPORT_CHUNK = 500;
/** Messages read at a time by `messagePages` (exports). */
const MESSAGE_PAGE = 500;
const MERGE_MESSAGE_CHUNK = 200;
const MERGE_IMAGE_CHUNK = 20;
const MERGE_SESSION_CHUNK = 200;
const DEFAULT_STALE_SESSION_MS = 90_000;
const MERGE_JOURNAL_PREFIX = 'merge:';
/** Merged entries point to the entry they went into; a chain longer than this is broken. */
const MAX_MERGE_HOPS = 16;
/** Messages shown in a chat that are compared with the archive to identify it. */
const MAX_EVIDENCE_MESSAGES = 60;
/** Messages from each end of an entry's timeline compared with other entries, to suggest merges. */
const SHARED_MESSAGES_PER_END = 100;
/** Archived messages read to check whether an entry contradicts the messages shown. */
const MAX_CONTRADICTION_READ = 400;
const ACTIVE_STATUSES = ['running', 'paused'] as const;
/** Final statuses reported by the tab itself (unlike 'interrupted', which the background infers). */
const ENDED_STATUSES: readonly SessionStatus[] = ['completed', 'stopped', 'failed'];

const journalKey = (sourceKey: string) => `${MERGE_JOURNAL_PREFIX}${sourceKey}`;
const journalRange = () => IDBKeyRange.bound(MERGE_JOURNAL_PREFIX, `${MERGE_JOURNAL_PREFIX}￿`);

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
    aliases: [],
    mergedFrom: [],
    mergedInto: null,
    titleHistory: [],
    displayName: null,
    lastUpdate: null,
  };
}

function applyIdentity(existing: ConversationRecord | undefined, identity: ConversationIdentity, nowIso: string, aliases: readonly string[] = []): ConversationRecord {
  const next: ConversationRecord = existing
    ? { ...existing, coverage: existing.coverage.map((r) => ({ ...r })), participants: [...existing.participants] }
    : newConversationRecord(identity, nowIso);
  if (existing) {
    if (identity.title) next.title = identity.title;
    if (identity.threadId && !next.threadId) next.threadId = identity.threadId;
    if (identity.typeSource === 'thread-id' || next.type === 'unknown') {
      next.type = identity.type;
      next.typeSource = identity.typeSource;
    }
  }
  next.titleHistory = noteTitle(existing ? titleHistoryOf(existing) : [], identity.title, nowIso);
  next.aliases = withConversationAliases(next, aliases);
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

type ShownMessage = IdentityEvidence['messages'][number];

/** Well-formed messages of the evidence, one per Teams id (at most MAX_EVIDENCE_MESSAGES, newest kept). */
function evidenceMessages(evidence: IdentityEvidence | null): ShownMessage[] {
  const byId = new Map<string, ShownMessage>();
  for (const item of Array.isArray(evidence?.messages) ? evidence.messages : []) {
    if (!item || typeof item.messageId !== 'string' || !item.messageId || typeof item.contentHash !== 'string') continue;
    const sortKey = typeof item.sortKey === 'number' && Number.isFinite(item.sortKey) ? item.sortKey : null;
    byId.set(item.messageId, { messageId: item.messageId, contentHash: item.contentHash, sortKey });
  }
  return Array.from(byId.values()).slice(-MAX_EVIDENCE_MESSAGES);
}

/**
 * True when entry `conversationKey` holds at least two messages with Teams ids from the time span
 * of the messages shown, and not one of them is shown: the chat shows every message of that
 * span, so the entry is a different chat. Ids only: two chats often both contain an "ok".
 */
async function contradicts(messages: IDBObjectStore, conversationKey: string, shown: ShownMessage[]): Promise<boolean> {
  const times = shown.map((item) => item.sortKey).filter((time): time is number => time !== null);
  if (times.length < 2) return false;
  const span = IDBKeyRange.bound([conversationKey, Math.min(...times)], [conversationKey, Math.max(...times)]);
  const archived = (await requestToPromise(messages.index(INDEXES.messagesBySort).getAll(span, MAX_CONTRADICTION_READ))) as StoredMessage[];
  const archivedIds = archived.map((message) => message.messageId).filter((messageId): messageId is string => messageId !== null);
  if (archivedIds.length < 2) return false;
  const ids = new Set(shown.map((item) => item.messageId));
  return !archivedIds.some((messageId) => ids.has(messageId));
}

export class ArchiveRepository {
  private constructor(private readonly db: IDBDatabase) {}

  static async open(factory: IDBFactory = indexedDB, name: string = DB_NAME): Promise<ArchiveRepository> {
    const db = await openDatabase(factory, name, DB_VERSION, upgradeArchiveDb);
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
      if (existingConversation?.mergedInto) {
        throw new Error(`This chat's archive entry was merged into ${existingConversation.mergedInto}. Start the extraction again.`);
      }
      const conversation = applyIdentity(existingConversation, input.conversation, nowIso, input.aliases);
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

  /**
   * Messages of a conversation in timeline order, in pages, limited to a sort-key range (`from`
   * inclusive, `to` exclusive; null is open). Only the keys are read up front, so a large
   * conversation is never held whole.
   */
  async *messagePages(conversationKey: string, range: { from: number | null; to: number | null } = { from: null, to: null }, pageSize = MESSAGE_PAGE): AsyncGenerator<StoredMessage[]> {
    const span = IDBKeyRange.bound([conversationKey, range.from ?? -Infinity], range.to === null ? [conversationKey, []] : [conversationKey, range.to], false, range.to !== null);
    const keysTx = this.db.transaction(STORES.messages, 'readonly');
    const keys = (await requestToPromise(keysTx.objectStore(STORES.messages).index(INDEXES.messagesBySort).getAllKeys(span))) as string[];
    for (let start = 0; start < keys.length; start += pageSize) {
      const tx = this.db.transaction(STORES.messages, 'readonly');
      const store = tx.objectStore(STORES.messages);
      const page = await Promise.all(keys.slice(start, start + pageSize).map((key) => requestToPromise(store.get(key)) as Promise<StoredMessage | undefined>));
      // A message merged away or deleted since the keys were read is left out.
      yield page.filter((message): message is StoredMessage => message !== undefined && message.conversationKey === conversationKey);
    }
  }

  /** Keys of a conversation's messages in timeline order: a view pages through them without holding the messages. */
  async messageKeys(conversationKey: string): Promise<string[]> {
    const tx = this.db.transaction(STORES.messages, 'readonly');
    return (await requestToPromise(tx.objectStore(STORES.messages).index(INDEXES.messagesBySort).getAllKeys(prefixRange(conversationKey)))) as string[];
  }

  /** The messages with these keys, in the order given; keys no longer archived are left out. */
  async getMessagesByKey(keys: readonly string[]): Promise<StoredMessage[]> {
    const tx = this.db.transaction(STORES.messages, 'readonly');
    const store = tx.objectStore(STORES.messages);
    const messages = await Promise.all(keys.map((key) => requestToPromise(store.get(key)) as Promise<StoredMessage | undefined>));
    return messages.filter((message): message is StoredMessage => message !== undefined);
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

  /**
   * Notes the end of a run: when the archive is now gap-free from where it was up to date to
   * the newest message the run reached (see coverage.ts `caughtUp`), the run becomes the
   * conversation's last update. Visible-only runs never do. Returns the last update as it is now.
   */
  async recordRunEnd(conversationKey: string, run: RunEnd): Promise<LastUpdate | null> {
    const tx = this.db.transaction(STORES.conversations, 'readwrite');
    const done = transactionDone(tx);
    const store = tx.objectStore(STORES.conversations);
    const conversation = (await requestToPromise(store.get(conversationKey))) as ConversationRecord | undefined;
    if (!conversation || conversation.mergedInto) {
      await done;
      return null;
    }
    const current = cleanLastUpdate(conversation.lastUpdate);
    if (run.mode === 'visible' || run.newestSortKey === null || !caughtUp(conversation.coverage, run.newestSortKey, run.continuesFrom)) {
      await done;
      return current;
    }
    const next = laterUpdate(current, { sessionId: run.sessionId, mode: run.mode, at: run.at, newestSortKey: run.newestSortKey });
    if (next !== current) await requestToPromise(store.put({ ...conversation, lastUpdate: next } satisfies ConversationRecord));
    await done;
    return next;
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

  /**
   * Finds the archive entry an open chat belongs to (see conversation-identity.ts). `evidence`
   * holds messages shown in the chat; without it only the detected key and aliases count.
   * Reads only: the entry learns the detected key as an alias with the next batch.
   */
  async resolveConversation(identity: ConversationIdentity, evidence: IdentityEvidence | null = null): Promise<ConversationResolution> {
    const tx = this.db.transaction([STORES.conversations, STORES.messages], 'readonly');
    const conversations = tx.objectStore(STORES.conversations);
    const messages = tx.objectStore(STORES.messages);
    const live = this.liveRecordReader(conversations);

    const detectedKey = identity.conversationKey;
    const direct = await live(detectedKey);
    const aliased: ConversationRecord[] = [];
    for (const record of (await requestToPromise(conversations.index(INDEXES.conversationsByAlias).getAll(detectedKey))) as ConversationRecord[]) {
      const current = await live(record.conversationKey);
      if (current && current.conversationKey !== direct?.conversationKey && !aliased.some((entry) => entry.conversationKey === current.conversationKey)) {
        aliased.push(current);
      }
    }

    // A chat archived by its title before Teams showed its id (see decideConversation).
    const titled: ConversationRecord[] = [];
    if (identity.threadId && identity.title) {
      const titleKey = `title:${normalizeTitleKey(identity.title)}`;
      const known = (await requestToPromise(conversations.index(INDEXES.conversationsByAlias).getAll(titleKey))) as ConversationRecord[];
      for (const key of [titleKey, ...known.map((record) => record.conversationKey)]) {
        const current = await live(key);
        if (!current || current.conversationKey === direct?.conversationKey) continue;
        if ([...aliased, ...titled].some((entry) => entry.conversationKey === current.conversationKey)) continue;
        titled.push(current);
      }
    }

    const shown = evidenceMessages(evidence);
    const overlaps = new Map<string, MessageOverlap>();
    const byMessageId = messages.index(INDEXES.messagesByMessageId);
    for (const item of shown) {
      for (const stored of (await requestToPromise(byMessageId.getAll(item.messageId))) as StoredMessage[]) {
        const record = await live(stored.conversationKey);
        if (!record) continue;
        const overlap = overlaps.get(record.conversationKey) ?? { record, ids: 0, sameContent: 0 };
        overlap.ids++;
        if (stored.contentHash === item.contentHash) overlap.sameContent++;
        overlaps.set(record.conversationKey, overlap);
      }
    }

    const contradicted = new Set<string>();
    for (const candidate of [direct, ...aliased, ...titled]) {
      if (candidate && (await contradicts(messages, candidate.conversationKey, shown))) contradicted.add(candidate.conversationKey);
    }
    return decideConversation({ identity, direct, aliased, titled, overlaps: Array.from(overlaps.values()), contradicted });
  }

  /**
   * The other entries that hold some of the same messages as entry `conversationKey`, matched by
   * Teams message id, most shared first. Two entries of one chat (say, before and after Teams
   * renamed it) share the messages both runs saw; two different chats practically never share an
   * id. Compares the oldest and newest messages of the entry, where two such entries overlap.
   */
  async entriesSharingMessages(conversationKey: string, perEnd: number = SHARED_MESSAGES_PER_END): Promise<SharedMessages[]> {
    const tx = this.db.transaction([STORES.conversations, STORES.messages], 'readonly');
    const live = this.liveRecordReader(tx.objectStore(STORES.conversations));
    const messages = tx.objectStore(STORES.messages);
    const timeline = messages.index(INDEXES.messagesBySort);
    const own = (await live(conversationKey))?.conversationKey ?? conversationKey;
    const oldest = (await requestToPromise(timeline.getAll(prefixRange(conversationKey), perEnd))) as StoredMessage[];
    const newest = await readLast<StoredMessage>(timeline, prefixRange(conversationKey), perEnd);
    const ids = new Set([...oldest, ...newest].map((message) => message.messageId).filter((messageId): messageId is string => Boolean(messageId)));

    const counts = new Map<string, number>();
    const byMessageId = messages.index(INDEXES.messagesByMessageId);
    for (const messageId of ids) {
      const holders = new Set<string>();
      for (const stored of (await requestToPromise(byMessageId.getAll(messageId))) as StoredMessage[]) {
        const record = await live(stored.conversationKey);
        if (record && record.conversationKey !== own) holders.add(record.conversationKey);
      }
      for (const holder of holders) counts.set(holder, (counts.get(holder) ?? 0) + 1);
    }
    return Array.from(counts, ([key, shared]) => ({ conversationKey: key, shared })).sort((a, b) => b.shared - a.shared || a.conversationKey.localeCompare(b.conversationKey));
  }

  /** Reads conversation records, following entries that were merged into another one. */
  private liveRecordReader(conversations: IDBObjectStore): (key: string) => Promise<ConversationRecord | null> {
    const cache = new Map<string, ConversationRecord | null>();
    return async (key) => {
      const cached = cache.get(key);
      if (cached !== undefined) return cached;
      let record = (await requestToPromise(conversations.get(key))) as ConversationRecord | undefined;
      for (let hops = 0; record?.mergedInto && hops < MAX_MERGE_HOPS; hops++) {
        record = (await requestToPromise(conversations.get(record.mergedInto))) as ConversationRecord | undefined;
      }
      const live = record && !record.mergedInto ? record : null;
      cache.set(key, live);
      return live;
    };
  }

  /** Sets the name shown for an entry in the archive and exports; null shows the Teams title. */
  async renameConversation(conversationKey: string, name: string | null): Promise<ConversationRecord> {
    const tx = this.db.transaction(STORES.conversations, 'readwrite');
    const done = transactionDone(tx);
    const store = tx.objectStore(STORES.conversations);
    const record = (await requestToPromise(store.get(conversationKey))) as ConversationRecord | undefined;
    if (!record) {
      await done;
      throw new Error(`No archived conversation ${conversationKey}`);
    }
    record.displayName = cleanDisplayName(name);
    await requestToPromise(store.put(record));
    await done;
    return record;
  }

  /**
   * Moves every message, image and session of entry `sourceKey` into entry `targetKey` and
   * removes the source entry; its key and aliases become aliases of the target. Runs in small
   * transactions; if it is interrupted, resumePendingMerges() finishes it. Refused for two
   * chats with different Teams ids and while the source is being extracted.
   */
  async mergeConversations(sourceKey: string, targetKey: string, options: MergeOptions = {}): Promise<MergeOutcome> {
    await this.beginMerge(sourceKey, targetKey, options);
    return this.continueMerge(sourceKey, targetKey, options);
  }

  /** Merges that were started but not finished (the page closed, the browser stopped). */
  async pendingMerges(): Promise<MergeJournal[]> {
    const tx = this.db.transaction(STORES.meta, 'readonly');
    return (await requestToPromise(tx.objectStore(STORES.meta).getAll(journalRange()))) as MergeJournal[];
  }

  /** Finishes interrupted merges; returns how many were finished. */
  async resumePendingMerges(options: MergeOptions = {}): Promise<number> {
    const journals = await this.pendingMerges();
    for (const journal of journals) await this.continueMerge(journal.sourceKey, journal.targetKey, options);
    return journals.length;
  }

  private async beginMerge(sourceKey: string, targetKey: string, options: MergeOptions): Promise<void> {
    const now = options.now ?? new Date();
    const staleMs = options.staleSessionMs ?? DEFAULT_STALE_SESSION_MS;
    const tx = this.db.transaction([STORES.conversations, STORES.sessions, STORES.meta], 'readwrite');
    const done = transactionDone(tx);
    const conversations = tx.objectStore(STORES.conversations);
    const meta = tx.objectStore(STORES.meta);
    const fail = async (message: string): Promise<never> => {
      tx.abort();
      await done.catch(() => undefined);
      throw new Error(message);
    };
    if (sourceKey === targetKey) return fail('A conversation cannot be merged into itself.');
    const source = (await requestToPromise(conversations.get(sourceKey))) as ConversationRecord | undefined;
    const target = (await requestToPromise(conversations.get(targetKey))) as ConversationRecord | undefined;
    if (!source || !target) return fail('Both conversations must be in the archive.');
    if (target.mergedInto) return fail(`“${conversationLabel(target)}” is being merged into another conversation.`);
    if (source.mergedInto && source.mergedInto !== targetKey) return fail(`“${conversationLabel(source)}” is already being merged into another conversation.`);
    if (source.threadId && target.threadId && source.threadId !== target.threadId) {
      return fail('These are two different Teams chats: their Teams chat ids differ.');
    }
    const journals = (await requestToPromise(meta.getAll(journalRange()))) as MergeJournal[];
    if (journals.some((journal) => journal.targetKey === sourceKey)) {
      return fail(`Another conversation is still being merged into “${conversationLabel(source)}”. Try again when that merge is done.`);
    }
    const sessions = (await requestToPromise(tx.objectStore(STORES.sessions).index(INDEXES.sessionsByConversation).getAll(prefixRange(sourceKey)))) as SessionRecord[];
    const running = sessions.some((session) => (ACTIVE_STATUSES as readonly string[]).includes(session.status) && Date.parse(session.updatedAt) > now.getTime() - staleMs);
    if (running) return fail(`An extraction of “${conversationLabel(source)}” is running. Stop it first.`);

    if (!source.mergedInto) {
      await requestToPromise(conversations.put({ ...source, mergedInto: targetKey } satisfies ConversationRecord));
    }
    // Lookups of the source's keys find the target from now on.
    await requestToPromise(conversations.put({ ...target, aliases: withConversationAliases(target, [sourceKey, ...(source.aliases ?? [])]) } satisfies ConversationRecord));
    const existing = await requestToPromise(meta.get(journalKey(sourceKey)));
    if (!existing) {
      await requestToPromise(meta.put({ key: journalKey(sourceKey), sourceKey, targetKey, startedAt: now.toISOString() } satisfies MergeJournal));
    }
    await done;
  }

  private async continueMerge(sourceKey: string, targetKey: string, options: MergeOptions): Promise<MergeOutcome> {
    const progress: MergeProgress = { sourceKey, targetKey, messagesMoved: 0, imagesMoved: 0, sessionsMoved: 0 };
    const report = async () => options.onProgress?.({ ...progress });
    for (;;) {
      for (let moved = -1; moved !== 0; ) {
        moved = await this.moveMessages(sourceKey, targetKey, options.messageChunk ?? MERGE_MESSAGE_CHUNK);
        progress.messagesMoved += moved;
        if (moved > 0) await report();
      }
      for (let moved = -1; moved !== 0; ) {
        moved = await this.moveImages(sourceKey, targetKey, options.imageChunk ?? MERGE_IMAGE_CHUNK);
        progress.imagesMoved += moved;
        if (moved > 0) await report();
      }
      for (let moved = -1; moved !== 0; ) {
        moved = await this.moveSessions(sourceKey, targetKey, MERGE_SESSION_CHUNK);
        progress.sessionsMoved += moved;
      }
      const finished = await this.finishMerge(sourceKey, targetKey);
      if (finished === 'retry') continue;
      await this.resolveReplies(targetKey);
      await report();
      const target = (await this.getConversation(targetKey)) ?? finished;
      if (!target) throw new Error('The conversation the other one was merged into is no longer in the archive.');
      return { ...progress, target };
    }
  }

  /** Moves up to `limit` messages of the source entry; returns how many were moved. */
  private async moveMessages(sourceKey: string, targetKey: string, limit: number): Promise<number> {
    const tx = this.db.transaction(STORES.messages, 'readwrite');
    const done = transactionDone(tx);
    const store = tx.objectStore(STORES.messages);
    const batch = (await requestToPromise(store.index(INDEXES.messagesBySort).getAll(prefixRange(sourceKey), limit))) as StoredMessage[];
    for (const message of batch) {
      await this.placeMovedMessage(store, rekeyMessage(message, sourceKey, targetKey), targetKey);
      await requestToPromise(store.delete(message.key));
    }
    await done;
    return batch.length;
  }

  /** Stores a moved message, folding it into a copy of the same message the target already has. */
  private async placeMovedMessage(store: IDBObjectStore, moved: StoredMessage, targetKey: string): Promise<void> {
    const foldInto = async (existing: StoredMessage) => {
      const merged = mergeImported(existing, { ...moved, key: existing.key, aliases: [...moved.aliases, moved.key] });
      await requestToPromise(store.put(merged.record));
    };
    const sameKey = (await requestToPromise(store.get(moved.key))) as StoredMessage | undefined;
    if (sameKey) return foldInto(sameKey);
    if (moved.fingerprintStrong) {
      const sameFingerprint = (await requestToPromise(store.index(INDEXES.messagesByFingerprint).getAll([targetKey, moved.fingerprint]))) as StoredMessage[];
      if (moved.idSource === 'fingerprint') {
        const match = sameFingerprint.find((m) => m.idSource === 'dom') ?? sameFingerprint[0];
        if (match) return foldInto(match);
      } else {
        const duplicate = sameFingerprint.find((m) => m.idSource === 'fingerprint');
        if (duplicate) {
          await requestToPromise(store.delete(duplicate.key));
          await requestToPromise(store.put(absorbDuplicate(moved, duplicate)));
          return;
        }
      }
    } else if (moved.idSource === 'fingerprint') {
      for (const candidate of [moved.key, ...moved.aliases]) {
        const aliased = ((await requestToPromise(store.index(INDEXES.messagesByAlias).getAll(candidate))) as StoredMessage[]).find((m) => m.conversationKey === targetKey);
        if (aliased) return foldInto(aliased);
      }
    }
    await requestToPromise(store.put(moved));
  }

  private async moveImages(sourceKey: string, targetKey: string, limit: number): Promise<number> {
    const tx = this.db.transaction(STORES.images, 'readwrite');
    const done = transactionDone(tx);
    const store = tx.objectStore(STORES.images);
    const batch = (await requestToPromise(store.index(INDEXES.imagesByConversation).getAll(prefixRange(sourceKey), limit))) as StoredImage[];
    for (const image of batch) {
      const moved = rekeyImage(image, targetKey);
      // Images are keyed by their content hash: one the target already has is the same picture.
      if ((await requestToPromise(store.getKey(moved.key))) === undefined) await requestToPromise(store.put(moved));
      await requestToPromise(store.delete(image.key));
    }
    await done;
    return batch.length;
  }

  private async moveSessions(sourceKey: string, targetKey: string, limit: number): Promise<number> {
    const tx = this.db.transaction(STORES.sessions, 'readwrite');
    const done = transactionDone(tx);
    const store = tx.objectStore(STORES.sessions);
    const batch = (await requestToPromise(store.index(INDEXES.sessionsByConversation).getAll(prefixRange(sourceKey), limit))) as SessionRecord[];
    for (const session of batch) {
      await requestToPromise(store.put({ ...session, conversationKey: targetKey, detectedKey: session.detectedKey ?? sourceKey } satisfies SessionRecord));
    }
    await done;
    return batch.length;
  }

  /**
   * Combines the two records and removes the source entry and the journal, once nothing is left
   * under the source key ('retry' otherwise). Null when another run already finished the merge.
   */
  private async finishMerge(sourceKey: string, targetKey: string): Promise<ConversationRecord | null | 'retry'> {
    const tx = this.db.transaction([STORES.conversations, STORES.messages, STORES.images, STORES.meta], 'readwrite');
    const done = transactionDone(tx);
    const conversations = tx.objectStore(STORES.conversations);
    const meta = tx.objectStore(STORES.meta);
    const messages = tx.objectStore(STORES.messages).index(INDEXES.messagesBySort);
    const journal = await requestToPromise(meta.get(journalKey(sourceKey)));
    if (!journal) {
      await done;
      return null;
    }
    const left = (await requestToPromise(messages.count(prefixRange(sourceKey)))) + (await requestToPromise(tx.objectStore(STORES.images).index(INDEXES.imagesByConversation).count(prefixRange(sourceKey))));
    if (left > 0) {
      await done;
      return 'retry';
    }
    const source = (await requestToPromise(conversations.get(sourceKey))) as ConversationRecord | undefined;
    const target = (await requestToPromise(conversations.get(targetKey))) as ConversationRecord | undefined;
    const base = target ?? (source ? { ...source, conversationKey: targetKey, mergedInto: null } : null);
    if (!base) {
      await requestToPromise(meta.delete(journalKey(sourceKey)));
      await done;
      return null;
    }
    const next = source && target ? combineConversations(target, source) : { ...base };
    next.schemaVersion = ARCHIVE_SCHEMA_VERSION;
    next.messageCount = await requestToPromise(messages.count(prefixRange(targetKey)));
    await requestToPromise(conversations.put(next));
    if (source) await requestToPromise(conversations.delete(sourceKey));
    await requestToPromise(meta.delete(journalKey(sourceKey)));
    await done;
    return next;
  }

  /** Deletes a conversation with all its messages, images and sessions. */
  async deleteConversation(conversationKey: string): Promise<{ messages: number; images: number; sessions: number }> {
    const tx = this.db.transaction([STORES.messages, STORES.images, STORES.sessions, STORES.conversations, STORES.meta], 'readwrite');
    const done = transactionDone(tx);
    const journals = (await requestToPromise(tx.objectStore(STORES.meta).getAll(journalRange()))) as MergeJournal[];
    if (journals.some((journal) => journal.sourceKey === conversationKey || journal.targetKey === conversationKey)) {
      tx.abort();
      await done.catch(() => undefined);
      throw new Error('This conversation is being merged with another one. Try again when the merge is done.');
    }
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
    const images = await deleteVia(tx.objectStore(STORES.images).index(INDEXES.imagesByConversation));
    const sessions = await deleteVia(tx.objectStore(STORES.sessions).index(INDEXES.sessionsByConversation));
    await requestToPromise(tx.objectStore(STORES.conversations).delete(conversationKey));
    await done;
    return { messages, images, sessions };
  }

  // ------------------------------------------------------------------ images

  /**
   * Stores images of one conversation in one transaction. Idempotent: an image id is the hash of
   * its bytes, so an image that is already archived is left as it is (`unchanged`).
   * Returns the outcome per image id.
   */
  /**
   * The saved images of archived messages, by message key: messages of the conversation that
   * have at least one attachment with a saved image. A run then need not read those images again.
   */
  async archivedImages(conversationKey: string, keys: readonly string[]): Promise<Record<string, ArchivedImages>> {
    const tx = this.db.transaction([STORES.messages, STORES.images], 'readonly');
    const store = tx.objectStore(STORES.messages);
    const images = tx.objectStore(STORES.images);
    const found: Record<string, ArchivedImages> = {};
    for (const key of new Set(keys)) {
      const message = (await requestToPromise(store.get(key))) as StoredMessage | undefined;
      if (!message || message.conversationKey !== conversationKey) continue;
      // Only images that are stored (an interrupted import may have written a message before its images).
      const imageIds: Array<string | null> = [];
      for (const attachment of message.attachments) {
        const imageId = attachment.kind === 'image' ? attachment.imageId : null;
        imageIds.push(imageId && (await requestToPromise(images.getKey(imageKey(conversationKey, imageId)))) !== undefined ? imageId : null);
      }
      if (imageIds.some((imageId) => imageId !== null)) found[key] = { contentHash: message.contentHash, imageIds };
    }
    return found;
  }

  async putImages(conversationKey: string, images: readonly StoredImage[]): Promise<Record<string, ImageSaveStatus>> {
    const statuses: Record<string, ImageSaveStatus> = {};
    if (images.length === 0) return statuses;
    const tx = this.db.transaction(STORES.images, 'readwrite');
    const done = transactionDone(tx);
    const store = tx.objectStore(STORES.images);
    try {
      for (const image of images) {
        if (image.conversationKey !== conversationKey) throw new Error(`Image ${image.key} does not belong to conversation ${conversationKey}`);
        if (image.key !== imageKey(conversationKey, image.imageId)) throw new Error(`Image key ${image.key} does not match its image id`);
        const existing = (await requestToPromise(store.getKey(image.key))) !== undefined;
        if (!existing) await requestToPromise(store.put(image));
        statuses[image.imageId] = existing ? 'unchanged' : 'inserted';
      }
      await done;
      return statuses;
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

  async getImage(conversationKey: string, imageId: string): Promise<StoredImage | undefined> {
    const tx = this.db.transaction(STORES.images, 'readonly');
    return (await requestToPromise(tx.objectStore(STORES.images).get(imageKey(conversationKey, imageId)))) as StoredImage | undefined;
  }

  /** All saved images of a conversation (with their bytes), ordered by image id. */
  async getImages(conversationKey: string): Promise<StoredImage[]> {
    const tx = this.db.transaction(STORES.images, 'readonly');
    const index = tx.objectStore(STORES.images).index(INDEXES.imagesByConversation);
    return (await requestToPromise(index.getAll(prefixRange(conversationKey)))) as StoredImage[];
  }

  /** The saved images of a conversation without their bytes, oldest first (read one at a time). */
  async imageCatalog(conversationKey: string): Promise<Array<Omit<StoredImage, 'data'>>> {
    const tx = this.db.transaction(STORES.images, 'readonly');
    const done = transactionDone(tx);
    const request = tx.objectStore(STORES.images).index(INDEXES.imagesByConversation).openCursor(prefixRange(conversationKey));
    const found: Array<Omit<StoredImage, 'data'>> = [];
    await new Promise<void>((resolve, reject) => {
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) {
          resolve();
          return;
        }
        const { data: _data, ...info } = cursor.value as StoredImage;
        found.push(info);
        cursor.continue();
      };
      request.onerror = () => reject(request.error);
    });
    await done;
    return found.sort((a, b) => a.firstSavedAt.localeCompare(b.firstSavedAt) || a.imageId.localeCompare(b.imageId));
  }

  async countImages(conversationKey: string): Promise<number> {
    const tx = this.db.transaction(STORES.images, 'readonly');
    return requestToPromise(tx.objectStore(STORES.images).index(INDEXES.imagesByConversation).count(prefixRange(conversationKey)));
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

  /** Whether a capture is running: a session that is running (not paused) with a recent heartbeat. */
  async hasRunningSession(nowMs: number, staleMs: number): Promise<boolean> {
    const tx = this.db.transaction(STORES.sessions, 'readonly');
    const sessions = (await requestToPromise(tx.objectStore(STORES.sessions).index(INDEXES.sessionsByStatus).getAll('running'))) as SessionRecord[];
    return sessions.some((session) => Date.parse(session.updatedAt) > nowMs - staleMs);
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

  /**
   * Merges an exported conversation (see export/format.ts) into the archive. Idempotent. The same
   * as `beginImport`, `importMessages` and `finishImport` in turn.
   */
  async importConversation(incoming: ConversationRecord, messages: StoredMessage[]): Promise<ImportResult> {
    await this.beginImport(incoming);
    const result = await this.importMessages(incoming.conversationKey, messages);
    await this.finishImport(incoming);
    return result;
  }

  /**
   * Starts importing a conversation: makes its entry when there is none yet, so the messages
   * written next always belong to a visible entry. The entry gets its identity (title, name,
   * aliases) but no coverage and no last update: those are merged by `finishImport`, once every
   * message is stored. An interrupted import so leaves a partial entry that importing again
   * completes, never messages without an entry or coverage without messages.
   */
  async beginImport(incoming: ConversationRecord): Promise<void> {
    const tx = this.db.transaction(STORES.conversations, 'readwrite');
    const done = transactionDone(tx);
    const conversations = tx.objectStore(STORES.conversations);
    const existing = (await requestToPromise(conversations.get(incoming.conversationKey))) as ConversationRecord | undefined;
    if (!existing) {
      // A merge that was running when the export was made is not continued here.
      const { mergedInto: _mergedInto, ...fields } = incoming;
      const entry: ConversationRecord = {
        ...fields,
        participants: [],
        coverage: [],
        messageCount: 0,
        oldestSortKey: null,
        newestSortKey: null,
        aliases: withConversationAliases({ conversationKey: incoming.conversationKey, aliases: [] }, Array.isArray(incoming.aliases) ? incoming.aliases : []),
        mergedFrom: [],
        mergedInto: null,
        titleHistory: titleHistoryOf(incoming),
        displayName: cleanDisplayName(incoming.displayName),
        lastUpdate: null,
        schemaVersion: ARCHIVE_SCHEMA_VERSION,
      };
      await requestToPromise(conversations.put(entry));
    }
    await done;
  }

  /** Writes imported messages into the entry `beginImport` made, in chunks, keeping its message count. */
  async importMessages(conversationKey: string, messages: readonly StoredMessage[]): Promise<ImportResult> {
    const result: ImportResult = { inserted: 0, updated: 0, unchanged: 0 };
    for (const message of messages) {
      if (message.conversationKey !== conversationKey) throw new Error(`Imported message ${message.key} does not belong to ${conversationKey}`);
    }
    for (let start = 0; start < messages.length; start += IMPORT_CHUNK) {
      const chunk = messages.slice(start, start + IMPORT_CHUNK);
      const tx = this.db.transaction([STORES.messages, STORES.conversations], 'readwrite');
      const done = transactionDone(tx);
      const store = tx.objectStore(STORES.messages);
      const conversations = tx.objectStore(STORES.conversations);
      try {
        const entry = (await requestToPromise(conversations.get(conversationKey))) as ConversationRecord | undefined;
        if (!entry) throw new Error(`There is no archive entry ${conversationKey} to import into`);
        let inserted = 0;
        for (const message of chunk) {
          const existing = (await requestToPromise(store.get(message.key))) as StoredMessage | undefined;
          const merged = mergeImported(existing, message);
          if (merged.status !== 'unchanged') await requestToPromise(store.put(merged.record));
          if (merged.status === 'inserted') inserted++;
          result[merged.status]++;
        }
        if (inserted > 0) await requestToPromise(conversations.put({ ...entry, messageCount: entry.messageCount + inserted }));
        await done;
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
    return result;
  }

  /** Finishes an import: merges the entry's fields, coverage and last update, and recounts its messages. */
  async finishImport(incoming: ConversationRecord): Promise<void> {
    const key = incoming.conversationKey;
    const tx = this.db.transaction([STORES.messages, STORES.conversations], 'readwrite');
    const done = transactionDone(tx);
    const conversations = tx.objectStore(STORES.conversations);
    const existing = (await requestToPromise(conversations.get(key))) as ConversationRecord | undefined;
    // A merge that was running when the export was made is not continued here.
    const { mergedInto: _mergedInto, ...fields } = incoming;
    const base: ConversationRecord = existing
      ? { ...existing }
      : { ...fields, participants: [], coverage: [], messageCount: 0, oldestSortKey: null, newestSortKey: null, aliases: [], mergedFrom: [], mergedInto: null, titleHistory: [], displayName: null, lastUpdate: null };
    if (!existing || incoming.lastExtractedAt > existing.lastExtractedAt) {
      base.title = incoming.title ?? base.title;
      base.lastSessionId = incoming.lastSessionId ?? base.lastSessionId;
    }
    base.aliases = withConversationAliases(base, Array.isArray(incoming.aliases) ? incoming.aliases : []);
    base.mergedFrom = Array.from(new Set([...(base.mergedFrom ?? []), ...(Array.isArray(incoming.mergedFrom) ? incoming.mergedFrom : [])])).filter((other) => other !== key);
    base.titleHistory = mergeTitleHistories(existing ? titleHistoryOf(existing) : [], titleHistoryOf(incoming));
    base.displayName = base.displayName ?? cleanDisplayName(incoming.displayName);
    base.lastUpdate = laterUpdate(existing?.lastUpdate, incoming.lastUpdate);
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
  }
}
