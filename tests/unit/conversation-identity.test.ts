import { describe, expect, it } from 'vitest';
import { messageFingerprint, storedFingerprintParts } from '../../src/shared/fingerprint';
import { conversationLabel, type ConversationIdentity, type ConversationRecord, type StoredMessage } from '../../src/shared/types';
import {
  cleanDisplayName,
  combineConversations,
  decideConversation,
  mergeTitleHistories,
  noteTitle,
  rekeyMessage,
  titleHistoryOf,
  withConversationAliases,
  type MessageOverlap,
} from '../../src/storage/conversation-identity';
import { createStoredMessage } from '../../src/storage/merge';
import { message } from '../helpers/messages';

const ctx = { sessionId: 's1', nowIso: '2024-01-15T12:00:00.000Z' };
const OLD = 'title:old name';
const NEW = 'title:new name';

function record(conversationKey: string, overrides: Partial<ConversationRecord> = {}): ConversationRecord {
  return {
    conversationKey,
    threadId: null,
    title: conversationKey.replace(/^title:/, ''),
    type: 'unknown',
    keySource: 'title',
    typeSource: 'unknown',
    participants: [],
    messageCount: 0,
    oldestSortKey: null,
    newestSortKey: null,
    coverage: [],
    firstExtractedAt: '2024-01-01T00:00:00.000Z',
    lastExtractedAt: '2024-01-02T00:00:00.000Z',
    lastSessionId: null,
    schemaVersion: 3,
    ...overrides,
  };
}

function titled(title: string, threadId: string | null = null): ConversationIdentity {
  return {
    conversationKey: threadId ? `teams:${threadId}` : `title:${title.toLowerCase()}`,
    threadId,
    title,
    type: threadId ? 'group' : 'unknown',
    keySource: threadId ? 'dom' : 'title',
    typeSource: threadId ? 'thread-id' : 'unknown',
  };
}

const overlap = (entry: ConversationRecord, ids: number, sameContent = ids): MessageOverlap => ({ record: entry, ids, sameContent });

describe('title history', () => {
  it('seeds the history of an entry archived before titles were recorded', () => {
    expect(titleHistoryOf(record(OLD, { title: 'Old name' }))).toEqual([{ title: 'Old name', firstSeenAt: '2024-01-01T00:00:00.000Z', lastSeenAt: '2024-01-02T00:00:00.000Z' }]);
    expect(titleHistoryOf(record(OLD, { title: null }))).toEqual([]);
  });

  it('records each title once, with when it was first and last seen, oldest first', () => {
    let history = noteTitle([], 'Old name', '2024-01-01T00:00:00.000Z');
    history = noteTitle(history, 'New name', '2024-02-01T00:00:00.000Z');
    history = noteTitle(history, 'Old name', '2024-03-01T00:00:00.000Z');
    history = noteTitle(history, null, '2024-04-01T00:00:00.000Z');
    expect(history).toEqual([
      { title: 'Old name', firstSeenAt: '2024-01-01T00:00:00.000Z', lastSeenAt: '2024-03-01T00:00:00.000Z' },
      { title: 'New name', firstSeenAt: '2024-02-01T00:00:00.000Z', lastSeenAt: '2024-02-01T00:00:00.000Z' },
    ]);
  });

  it('keeps the 50 most recently seen titles', () => {
    const many = Array.from({ length: 60 }, (_, i) => ({ title: `T${i}`, firstSeenAt: `2024-01-01T00:00:${String(i).padStart(2, '0')}.000Z`, lastSeenAt: `2024-01-01T00:00:${String(i).padStart(2, '0')}.000Z` }));
    const kept = mergeTitleHistories(many, []);
    expect(kept).toHaveLength(50);
    expect(kept[0]?.title).toBe('T10');
    expect(kept.at(-1)?.title).toBe('T59');
  });
});

describe('names and aliases', () => {
  it('tidies a name given in the archive and falls back to the Teams title', () => {
    expect(cleanDisplayName('  Budget   2024 ')).toBe('Budget 2024');
    expect(cleanDisplayName('   ')).toBeNull();
    expect(cleanDisplayName(null)).toBeNull();
    expect(conversationLabel(record(OLD, { title: 'Old name', displayName: 'Budget' }))).toBe('Budget');
    expect(conversationLabel(record(OLD, { title: 'Old name', displayName: null }))).toBe('Old name');
    expect(conversationLabel(record(OLD, { title: null }))).toBe(OLD);
  });

  it('adds aliases once and never the entry’s own key', () => {
    expect(withConversationAliases(record(OLD, { aliases: [NEW] }), [NEW, OLD, 'teams:19:a@thread.v2', null, ''])).toEqual([NEW, 'teams:19:a@thread.v2']);
  });
});

describe('decideConversation', () => {
  const old = record(OLD, { title: 'Old name' });
  const sameTitle = record(NEW, { title: 'New name' });
  const none = new Set<string>();

  it('continues the entry under the detected key when nothing contradicts it', () => {
    expect(decideConversation({ identity: titled('Old name'), direct: old, aliased: [], overlaps: [], contradicted: none })).toMatchObject({ conversationKey: OLD, reason: 'key' });
    expect(decideConversation({ identity: titled('Old name'), direct: old, aliased: [], overlaps: [overlap(old, 3)], contradicted: none })).toMatchObject({ conversationKey: OLD, reason: 'key' });
  });

  it('finds a renamed chat by the messages shown, even if another chat has the new title', () => {
    expect(decideConversation({ identity: titled('New name'), direct: null, aliased: [], overlaps: [overlap(old, 2, 0)], contradicted: none })).toMatchObject({
      conversationKey: OLD,
      reason: 'overlap',
      alsoMatching: [],
    });
    expect(decideConversation({ identity: titled('New name'), direct: sameTitle, aliased: [], overlaps: [overlap(old, 4)], contradicted: none })).toMatchObject({ conversationKey: OLD, reason: 'overlap' });
  });

  it('does not count a single shared message id with different content', () => {
    expect(decideConversation({ identity: titled('New name'), direct: null, aliased: [], overlaps: [overlap(old, 1, 0)], contradicted: none })).toMatchObject({ conversationKey: NEW, reason: 'new' });
    expect(decideConversation({ identity: titled('New name'), direct: null, aliased: [], overlaps: [overlap(old, 1, 1)], contradicted: none })).toMatchObject({ conversationKey: OLD, reason: 'overlap' });
  });

  it('gives a chat its own entry when the entry with its title holds other messages', () => {
    const decided = decideConversation({ identity: titled('New name'), direct: sameTitle, aliased: [], overlaps: [], contradicted: new Set([NEW]) });
    expect(decided).toEqual({ conversationKey: null, reason: 'separate', record: null, alsoMatching: [] });
  });

  it('finds such a chat again under the alias of its own entry', () => {
    const own = record('local:abc', { title: 'New name', aliases: [NEW] });
    expect(decideConversation({ identity: titled('New name'), direct: sameTitle, aliased: [own], overlaps: [overlap(own, 5)], contradicted: new Set([NEW]) })).toMatchObject({ conversationKey: 'local:abc', reason: 'alias' });
    expect(decideConversation({ identity: titled('New name'), direct: sameTitle, aliased: [own], overlaps: [], contradicted: new Set([NEW]) })).toMatchObject({ conversationKey: 'local:abc', reason: 'alias' });
    // Every entry known by the title holds other messages: a third chat with that title.
    expect(decideConversation({ identity: titled('New name'), direct: sameTitle, aliased: [own], overlaps: [], contradicted: new Set([NEW, 'local:abc']) })).toMatchObject({ conversationKey: null, reason: 'separate' });
  });

  it('never reuses a key that was merged away for a different chat', () => {
    const owner = record('title:other', { aliases: [NEW], mergedFrom: [NEW] });
    expect(decideConversation({ identity: titled('New name'), direct: null, aliased: [owner], overlaps: [], contradicted: new Set(['title:other']) })).toMatchObject({ reason: 'separate' });
  });

  it('trusts a Teams chat id over titles and messages', () => {
    const threadId = '19:abc@thread.v2';
    const byThread = record(`teams:${threadId}`, { threadId });
    expect(decideConversation({ identity: titled('Old name', threadId), direct: byThread, aliased: [], overlaps: [overlap(old, 5)], contradicted: new Set([byThread.conversationKey]) })).toMatchObject({
      conversationKey: byThread.conversationKey,
      reason: 'key',
      alsoMatching: [OLD],
    });
    // Archived by title before the chat id was readable: found by its messages.
    expect(decideConversation({ identity: titled('Old name', threadId), direct: null, aliased: [], overlaps: [overlap(old, 2)], contradicted: none })).toMatchObject({ conversationKey: OLD, reason: 'overlap' });
    // An entry with another chat id is another chat, whatever messages it shares.
    const other = record('title:other', { threadId: '19:zzz@thread.v2' });
    expect(decideConversation({ identity: titled('Old name', threadId), direct: null, aliased: [], overlaps: [overlap(other, 9)], contradicted: none })).toMatchObject({ conversationKey: `teams:${threadId}`, reason: 'new' });
  });

  it('keeps the entry archived under the chat’s title when the chat id first shows', () => {
    const threadId = '19:abc@thread.v2';
    const withId = titled('Old name', threadId);
    // None of its messages on screen (an update after many new messages): the title still finds it.
    expect(decideConversation({ identity: withId, direct: null, aliased: [], titled: [old], overlaps: [], contradicted: none })).toMatchObject({ conversationKey: OLD, reason: 'title', record: old });
    // Messages shown decide first, as for a chat without id.
    expect(decideConversation({ identity: withId, direct: null, aliased: [], titled: [old], overlaps: [overlap(sameTitle, 3)], contradicted: none })).toMatchObject({ conversationKey: NEW, reason: 'overlap' });
    // Not when its messages say it is another chat, or it already belongs to another chat id.
    expect(decideConversation({ identity: withId, direct: null, aliased: [], titled: [old], overlaps: [], contradicted: new Set([OLD]) })).toMatchObject({ reason: 'new' });
    const taken = record(OLD, { threadId: '19:zzz@thread.v2' });
    expect(decideConversation({ identity: withId, direct: null, aliased: [], titled: [taken], overlaps: [], contradicted: none })).toMatchObject({ reason: 'new' });
    // An entry stored under the chat id wins over the title.
    const byThread = record(`teams:${threadId}`, { threadId });
    expect(decideConversation({ identity: withId, direct: byThread, aliased: [], titled: [old], overlaps: [], contradicted: none })).toMatchObject({ conversationKey: byThread.conversationKey, reason: 'key' });
  });
});

describe('rekeyMessage', () => {
  const stored = (overrides: Parameters<typeof message>[0]): StoredMessage => createStoredMessage(message({ conversationKey: OLD, ...overrides }), ctx);

  it('moves a message with a Teams id and makes its fingerprint the one the parser makes in the new entry', () => {
    const moved = rekeyMessage(stored({ id: '1705314600000', text: 'Hello' }), OLD, NEW);
    expect(moved).toMatchObject({ key: `${NEW}#1705314600000`, conversationKey: NEW, aliases: [] });
    expect(moved.fingerprint).toBe(message({ conversationKey: NEW, id: '1705314600000', text: 'Hello' }).fingerprint);
  });

  it('recomputes the key of a message without id but with an exact time, keeping its occurrence number', () => {
    const time = '2024-01-15T10:30:00.000Z';
    const original = stored({ id: null, text: 'ok', timestamp: time, timestampSource: 'datetime-attr', fingerprintStrong: true });
    const parts = storedFingerprintParts(original);
    expect(parts).not.toBeNull();
    const oldFingerprint = messageFingerprint(OLD, parts!);
    const second = { ...original, key: `${OLD}#fp:${oldFingerprint}~2`, fingerprint: oldFingerprint };
    const moved = rekeyMessage(second, OLD, NEW);
    const newFingerprint = messageFingerprint(NEW, parts!);
    expect(moved).toMatchObject({ key: `${NEW}#fp:${newFingerprint}~2`, fingerprint: newFingerprint, fingerprintStrong: true });
    expect(moved.aliases).toEqual([`${NEW}#fp:${oldFingerprint}~2`]);
  });

  it('keeps the fingerprint of a message with neither id nor exact time, under the new prefix', () => {
    const original = { ...stored({ id: null, text: 'weak', fingerprint: 'abc', fingerprintStrong: false }), key: `${OLD}#fp:abc`, aliases: [`${OLD}#fp:def`] };
    expect(rekeyMessage(original, OLD, NEW)).toMatchObject({ key: `${NEW}#fp:abc`, fingerprint: 'abc', aliases: [`${NEW}#fp:def`] });
  });

  it('points replies at the moved messages, or leaves them to be matched again by content', () => {
    const byId = stored({ id: '1705314660000', replyTo: { messageId: '1705314600000', senderName: null, timestampRaw: null, preview: 'Hi', resolvedKey: `${OLD}#1705314600000`, resolution: 'message-id' } });
    expect(rekeyMessage(byId, OLD, NEW).replyTo).toMatchObject({ resolvedKey: `${NEW}#1705314600000`, resolution: 'message-id' });
    const byContent = stored({ id: '1705314720000', replyTo: { messageId: null, senderName: null, timestampRaw: null, preview: 'Hi', resolvedKey: `${OLD}#fp:abc`, resolution: 'content-match' } });
    expect(rekeyMessage(byContent, OLD, NEW).replyTo).toMatchObject({ resolvedKey: null, resolution: 'unresolved' });
  });
});

describe('combineConversations', () => {
  it('unites what both entries know, keeping the target’s key and name', () => {
    const target = record(NEW, {
      title: 'New name',
      participants: ['Bob'],
      coverage: [{ oldest: 300, newest: 400, reachedBeginning: false }],
      oldestSortKey: 300,
      newestSortKey: 400,
      firstExtractedAt: '2024-02-01T00:00:00.000Z',
      lastExtractedAt: '2024-03-01T00:00:00.000Z',
      lastSessionId: 'late',
      titleHistory: [{ title: 'New name', firstSeenAt: '2024-02-01T00:00:00.000Z', lastSeenAt: '2024-03-01T00:00:00.000Z' }],
      aliases: [OLD],
      displayName: 'Budget',
    });
    const source = record(OLD, {
      title: 'Old name',
      threadId: '19:abc@thread.v2',
      type: 'group',
      typeSource: 'thread-id',
      participants: ['Alice', 'Bob'],
      coverage: [{ oldest: 100, newest: 300, reachedBeginning: true }],
      oldestSortKey: 100,
      newestSortKey: 300,
      firstExtractedAt: '2024-01-01T00:00:00.000Z',
      lastExtractedAt: '2024-01-15T00:00:00.000Z',
      lastSessionId: 'early',
      aliases: ['title:older name'],
      mergedFrom: ['title:older name'],
      mergedInto: NEW,
    });
    expect(combineConversations(target, source)).toMatchObject({
      conversationKey: NEW,
      threadId: '19:abc@thread.v2',
      title: 'New name',
      type: 'group',
      typeSource: 'thread-id',
      participants: ['Alice', 'Bob'],
      coverage: [{ oldest: 100, newest: 400, reachedBeginning: true }],
      oldestSortKey: 100,
      newestSortKey: 400,
      firstExtractedAt: '2024-01-01T00:00:00.000Z',
      lastExtractedAt: '2024-03-01T00:00:00.000Z',
      lastSessionId: 'late',
      aliases: [OLD, 'title:older name'],
      mergedFrom: ['title:older name', OLD],
      mergedInto: null,
      titleHistory: [
        { title: 'Old name', firstSeenAt: '2024-01-01T00:00:00.000Z', lastSeenAt: '2024-01-15T00:00:00.000Z' },
        { title: 'New name', firstSeenAt: '2024-02-01T00:00:00.000Z', lastSeenAt: '2024-03-01T00:00:00.000Z' },
      ],
      displayName: 'Budget',
    });
  });
});

describe('combineConversations and updates', () => {
  it('keeps the last update that reached the newer message', () => {
    const early = { sessionId: 'early', mode: 'full' as const, at: '2024-01-15T00:00:00.000Z', newestSortKey: 300 };
    const late = { sessionId: 'late', mode: 'incremental' as const, at: '2024-03-01T00:00:00.000Z', newestSortKey: 400 };
    expect(combineConversations(record(NEW, { lastUpdate: early }), record(OLD, { lastUpdate: late })).lastUpdate).toEqual(late);
    expect(combineConversations(record(NEW, { lastUpdate: late }), record(OLD, { lastUpdate: early })).lastUpdate).toEqual(late);
    expect(combineConversations(record(NEW), record(OLD, { lastUpdate: early })).lastUpdate).toEqual(early);
    expect(combineConversations(record(NEW), record(OLD)).lastUpdate).toBeNull();
  });
});
