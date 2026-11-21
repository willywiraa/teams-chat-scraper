/**
 * Pure rules for conversation identity: which archive entry an open chat belongs to, the titles
 * Teams showed for it, the other keys an entry is known by, and how records move when two
 * entries are merged.
 *
 * Why this is needed: when Teams shows no chat id, a chat is keyed by its title. Renaming the
 * chat changes that key, and two different chats can have the same title. The messages shown
 * in the chat settle it: Teams message ids are kept when a chat is renamed, and two chats do
 * not share messages.
 */
import { messageFingerprint, storedFingerprintParts } from '../shared/fingerprint';
import { imageKey } from '../shared/images';
import type { ConversationIdentity, ConversationRecord, StoredImage, StoredMessage, TitleSighting } from '../shared/types';
import { mergeAllCoverage } from './coverage';

export const MAX_TITLE_HISTORY = 50;
export const MAX_CONVERSATION_ALIASES = 200;
export const MAX_DISPLAY_NAME = 200;

// ------------------------------------------------------------------ titles

/** Titles Teams showed for an entry; an entry archived before schema 3 has only its current title. */
export function titleHistoryOf(record: ConversationRecord): TitleSighting[] {
  if (record.titleHistory) return record.titleHistory.map((sighting) => ({ ...sighting }));
  return record.title ? [{ title: record.title, firstSeenAt: record.firstExtractedAt, lastSeenAt: record.lastExtractedAt }] : [];
}

/** Notes that Teams showed `title` at `seenAt`. */
export function noteTitle(history: readonly TitleSighting[], title: string | null, seenAt: string): TitleSighting[] {
  return mergeTitleHistories(history, title ? [{ title, firstSeenAt: seenAt, lastSeenAt: seenAt }] : []);
}

/** Union of two title histories, oldest first; keeps the most recently seen titles. */
export function mergeTitleHistories(a: readonly TitleSighting[], b: readonly TitleSighting[]): TitleSighting[] {
  const byTitle = new Map<string, TitleSighting>();
  for (const sighting of [...a, ...b]) {
    const known = byTitle.get(sighting.title);
    if (!known) {
      byTitle.set(sighting.title, { ...sighting });
      continue;
    }
    if (sighting.firstSeenAt < known.firstSeenAt) known.firstSeenAt = sighting.firstSeenAt;
    if (sighting.lastSeenAt > known.lastSeenAt) known.lastSeenAt = sighting.lastSeenAt;
  }
  const kept = Array.from(byTitle.values())
    .sort((x, y) => y.lastSeenAt.localeCompare(x.lastSeenAt))
    .slice(0, MAX_TITLE_HISTORY);
  return kept.sort((x, y) => x.firstSeenAt.localeCompare(y.firstSeenAt) || x.lastSeenAt.localeCompare(y.lastSeenAt));
}

/** A name given in the archive, tidied; null (use the Teams title) when empty. */
export function cleanDisplayName(name: string | null | undefined): string | null {
  const cleaned = (name ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_DISPLAY_NAME);
  return cleaned || null;
}

// ---------------------------------------------------------------- aliases

function unique(keys: Iterable<string>): string[] {
  return Array.from(new Set(keys));
}

/** The entry's aliases with `keys` added; never lists the entry's own key. */
export function withConversationAliases(record: Pick<ConversationRecord, 'conversationKey' | 'aliases'>, keys: ReadonlyArray<string | null | undefined>): string[] {
  const added = keys.filter((key): key is string => typeof key === 'string' && key.length > 0);
  return unique([...(record.aliases ?? []), ...added])
    .filter((key) => key !== record.conversationKey)
    .slice(-MAX_CONVERSATION_ALIASES);
}

// -------------------------------------------------------------- resolution

/**
 * How an open chat was matched to an archive entry:
 *  - `key`: the entry stored under the key detected in Teams;
 *  - `alias`: an entry known by that key (the chat was renamed, or its entry was merged);
 *  - `overlap`: an entry holding messages shown in the chat, under another key (a renamed chat);
 *  - `new`: nothing archived yet, the detected key is used;
 *  - `separate`: the detected key belongs to a different chat (same title, other messages), so
 *    this chat needs an entry of its own under a new key.
 */
export type ResolutionReason = 'key' | 'alias' | 'overlap' | 'new' | 'separate';

export interface ConversationResolution {
  /** The entry the chat belongs to; null when it needs a new entry under a fresh key (`separate`). */
  conversationKey: string | null;
  reason: ResolutionReason;
  record: ConversationRecord | null;
  /** Other entries holding messages shown in the chat: candidates for merging. */
  alsoMatching: string[];
}

/** How many messages shown in the chat an archive entry holds. */
export interface MessageOverlap {
  record: ConversationRecord;
  /** Messages with the same Teams message id. */
  ids: number;
  /** Of those, messages with the same content. */
  sameContent: number;
}

export interface ResolutionInput {
  identity: ConversationIdentity;
  /** The entry stored under the detected key (after following merges), if any. */
  direct: ConversationRecord | null;
  /** Entries known by the detected key (after following merges), without `direct`. */
  aliased: ConversationRecord[];
  overlaps: MessageOverlap[];
  /** Keys of `direct` and `aliased` entries whose archived messages contradict those shown. */
  contradicted: ReadonlySet<string>;
}

/**
 * Two shared message ids, or one with the same content, identify a chat: Teams message ids are
 * creation times in milliseconds, so two chats rarely share one and practically never two.
 */
export function isStrongOverlap(overlap: Pick<MessageOverlap, 'ids' | 'sameContent'>): boolean {
  return overlap.ids >= 2 || (overlap.ids >= 1 && overlap.sameContent >= 1);
}

function byRecency(a: ConversationRecord, b: ConversationRecord): number {
  return b.lastExtractedAt.localeCompare(a.lastExtractedAt);
}

/**
 * Picks the archive entry for an open chat. A Teams chat id settles it; without one the messages
 * shown decide, and the title only counts when the archived messages do not contradict it.
 */
export function decideConversation(input: ResolutionInput): ConversationResolution {
  const { identity, direct, aliased, contradicted } = input;
  const detectedKey = identity.conversationKey;
  const compatible = (record: ConversationRecord) => !identity.threadId || !record.threadId || record.threadId === identity.threadId;
  const isDirect = (record: ConversationRecord) => record.conversationKey === direct?.conversationKey;
  const strong = input.overlaps
    .filter((overlap) => isStrongOverlap(overlap) && compatible(overlap.record))
    .sort((a, b) => b.ids - a.ids || b.sameContent - a.sameContent || Number(isDirect(b.record)) - Number(isDirect(a.record)) || byRecency(a.record, b.record));
  const reasonFor = (record: ConversationRecord): ResolutionReason => {
    if (record.conversationKey === detectedKey) return 'key';
    return isDirect(record) || aliased.some((entry) => entry.conversationKey === record.conversationKey) ? 'alias' : 'overlap';
  };
  const found = (record: ConversationRecord, reason: ResolutionReason = reasonFor(record)): ConversationResolution => ({
    conversationKey: record.conversationKey,
    reason,
    record,
    alsoMatching: strong.map((overlap) => overlap.record.conversationKey).filter((key) => key !== record.conversationKey),
  });
  const unarchived = (reason: 'new' | 'separate'): ConversationResolution => ({
    conversationKey: reason === 'new' ? detectedKey : null,
    reason,
    record: null,
    alsoMatching: strong.map((overlap) => overlap.record.conversationKey),
  });

  if (identity.threadId) {
    if (direct) return found(direct);
    const sameThread = aliased.find((record) => record.threadId === identity.threadId);
    if (sameThread) return found(sameThread);
    return strong[0] ? found(strong[0].record) : unarchived('new');
  }
  if (strong[0]) return found(strong[0].record);
  if (direct && !contradicted.has(direct.conversationKey)) return found(direct);
  const fitting = aliased.filter((record) => !contradicted.has(record.conversationKey)).sort(byRecency);
  if (fitting[0]) return found(fitting[0]);
  // The detected key is taken by (or was used for) a chat with other messages.
  return direct || aliased.length > 0 ? unarchived('separate') : unarchived('new');
}

// ------------------------------------------------------------------ merging

/**
 * A message of entry `sourceKey` moved to entry `targetKey`. Its key and fingerprint are made
 * the way the page parser makes them in the target entry, so a later extraction finds it.
 * A message with neither a Teams id nor an exact time keeps its fingerprint under the new prefix;
 * the parser also looks for those (see ConversationIdentity.mergedKeys).
 */
export function rekeyMessage(message: StoredMessage, sourceKey: string, targetKey: string): StoredMessage {
  const prefix = `${sourceKey}#`;
  const move = (key: string) => (key.startsWith(prefix) ? `${targetKey}#${key.slice(prefix.length)}` : key);
  const next = structuredClone(message);
  next.conversationKey = targetKey;
  const parts = storedFingerprintParts(message);
  if (parts) {
    next.fingerprint = messageFingerprint(targetKey, parts);
    next.fingerprintStrong = parts.strongTime !== null;
  }
  if (message.messageId && message.key === `${prefix}${message.messageId}`) {
    next.key = `${targetKey}#${message.messageId}`;
  } else if (parts && message.idSource === 'fingerprint') {
    next.key = `${targetKey}#fp:${next.fingerprint}${/~\d+$/.exec(message.key)?.[0] ?? ''}`;
  } else {
    next.key = move(message.key);
  }
  next.aliases = unique([...message.aliases.map(move), move(message.key)]).filter((key) => key !== next.key);
  const resolvedKey = message.replyTo?.resolvedKey;
  if (next.replyTo && resolvedKey?.startsWith(prefix)) {
    const target = resolvedKey.slice(prefix.length);
    // A reply to a message without id is matched again by content once the merge is done.
    next.replyTo = target.startsWith('fp:')
      ? { ...next.replyTo, resolvedKey: null, resolution: 'unresolved' }
      : { ...next.replyTo, resolvedKey: `${targetKey}#${target}` };
  }
  return next;
}

/** An image of one entry moved to entry `targetKey` (images are keyed by their content hash). */
export function rekeyImage(image: StoredImage, targetKey: string): StoredImage {
  return { ...image, key: imageKey(targetKey, image.imageId), conversationKey: targetKey };
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

/** The record of `target` once `source` is merged into it; the caller recounts `messageCount`. */
export function combineConversations(target: ConversationRecord, source: ConversationRecord): ConversationRecord {
  const sourceIsNewer = source.lastExtractedAt > target.lastExtractedAt;
  const typeFromSource = target.type === 'unknown' || (target.typeSource !== 'thread-id' && source.typeSource === 'thread-id');
  return {
    ...target,
    threadId: target.threadId ?? source.threadId,
    title: sourceIsNewer ? (source.title ?? target.title) : (target.title ?? source.title),
    type: typeFromSource ? source.type : target.type,
    typeSource: typeFromSource ? source.typeSource : target.typeSource,
    participants: unique([...target.participants, ...source.participants]).sort((a, b) => a.localeCompare(b)),
    oldestSortKey: minOrNull(target.oldestSortKey, source.oldestSortKey),
    newestSortKey: maxOrNull(target.newestSortKey, source.newestSortKey),
    coverage: mergeAllCoverage(target.coverage, source.coverage),
    firstExtractedAt: source.firstExtractedAt < target.firstExtractedAt ? source.firstExtractedAt : target.firstExtractedAt,
    lastExtractedAt: sourceIsNewer ? source.lastExtractedAt : target.lastExtractedAt,
    lastSessionId: sourceIsNewer ? (source.lastSessionId ?? target.lastSessionId) : (target.lastSessionId ?? source.lastSessionId),
    aliases: withConversationAliases(target, [source.conversationKey, ...(source.aliases ?? [])]),
    mergedFrom: unique([...(target.mergedFrom ?? []), ...(source.mergedFrom ?? []), source.conversationKey]).filter((key) => key !== target.conversationKey),
    mergedInto: null,
    titleHistory: mergeTitleHistories(titleHistoryOf(target), titleHistoryOf(source)),
    displayName: target.displayName ?? source.displayName ?? null,
  };
}
