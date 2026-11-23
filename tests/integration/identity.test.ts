/**
 * Finding a chat in the archive when Teams shows no chat id, and merging archive entries:
 * a renamed chat continues its entry, a different chat with the same title gets its own, and a
 * merge keeps every message once, also through an interruption and a later re-import.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildArchiveExport } from '../../src/export/format';
import { importArchive } from '../../src/export/import';
import { identityEvidence } from '../../src/extractor/page-parser';
import { messageFingerprint } from '../../src/shared/fingerprint';
import { bytesToBase64, sha256Hex } from '../../src/shared/images';
import type { ConversationIdentity, CoverageRange, ExtractedMessage } from '../../src/shared/types';
import { saveCapturedImages } from '../../src/storage/images';
import type { ArchiveRepository } from '../../src/storage/repository';
import { openTestRepository } from '../helpers/fixtures';
import { fakeImageBytes } from '../helpers/images';
import { message, session } from '../helpers/messages';

const OLD = 'title:old name';
const NEW = 'title:new name';
const T0 = 1705314600000;
const MINUTE = 60_000;
const id = (minute: number) => String(T0 + minute * MINUTE);

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

/** Messages with Teams ids, sent at the given minutes, archived under `conversationKey`. */
function chat(conversationKey: string, minutes: number[], text = (minute: number) => `Message ${minute}`): ExtractedMessage[] {
  return minutes.map((minute) => message({ conversationKey, id: id(minute), text: text(minute) }));
}

/** A message without id but with an exact time, as the page parser keys it. */
function exactTimeWithoutId(conversationKey: string, minute: number, text: string): ExtractedMessage {
  const ms = T0 + minute * MINUTE;
  const timestamp = new Date(ms).toISOString();
  const fingerprint = messageFingerprint(conversationKey, { kind: 'message', isSelf: false, strongTime: timestamp, normalizedText: text, attachments: '', replyPreview: undefined, anchor: null });
  return message({ conversationKey, id: null, text, timestamp, timestampSource: 'datetime-attr', sortKey: ms, sortKeySource: 'timestamp', fingerprint, fingerprintStrong: true });
}

const weakFingerprint = (namespace: string, anchor: string, text: string) =>
  messageFingerprint(namespace, { kind: 'message', isSelf: false, strongTime: null, normalizedText: text, attachments: '', replyPreview: undefined, anchor });

/** A message with neither id nor exact time, keyed by its text and the message below it. */
function withoutIdOrTime(conversationKey: string, anchor: string, text: string): ExtractedMessage {
  return message({ conversationKey, id: null, text, timestamp: null, timestampSource: 'none', sortKey: null, sortKeySource: null, fingerprint: weakFingerprint(conversationKey, anchor, text), fingerprintStrong: false });
}

let repository: ArchiveRepository;
beforeEach(async () => {
  repository = await openTestRepository();
});
afterEach(() => {
  repository.close();
});

async function archive(identity: ConversationIdentity, messages: ExtractedMessage[], options: { aliases?: string[]; segments?: CoverageRange[]; now?: string; sessionId?: string } = {}) {
  return repository.upsertObservations({
    conversation: identity,
    messages,
    sessionId: options.sessionId ?? 's1',
    aliases: options.aliases,
    segments: options.segments,
    now: options.now ? new Date(options.now) : undefined,
  });
}

async function saveImage(conversationKey: string, src: string): Promise<void> {
  const bytes = fakeImageBytes(src);
  const imageId = await sha256Hex(bytes);
  await saveCapturedImages(repository, conversationKey, [{ imageId, mimeType: 'image/png', byteLength: bytes.byteLength, width: 4, height: 4, method: 'fetch', dataBase64: bytesToBase64(bytes) }], {
    sessionId: 's1',
    nowIso: '2024-01-20T00:00:00.000Z',
  });
}

describe('finding a chat that Teams shows without a chat id', () => {
  it('continues a renamed chat in its entry and records the new title', async () => {
    await archive(titled('Old name'), chat(OLD, [0, 1, 2, 3]), { now: '2024-01-20T00:00:00.000Z' });
    const renamed = titled('New name');

    expect(await repository.resolveConversation(renamed, identityEvidence(chat(NEW, [2, 3, 4])))).toMatchObject({ conversationKey: OLD, reason: 'overlap', alsoMatching: [] });

    // The tab writes under the entry's key; the key detected in Teams becomes an alias.
    await archive({ ...renamed, conversationKey: OLD }, chat(OLD, [4]), { aliases: [NEW], now: '2024-02-01T00:00:00.000Z' });
    const entry = await repository.getConversation(OLD);
    expect(entry).toMatchObject({ title: 'New name', aliases: [NEW], messageCount: 5 });
    expect(entry?.titleHistory).toEqual([
      { title: 'Old name', firstSeenAt: '2024-01-20T00:00:00.000Z', lastSeenAt: '2024-01-20T00:00:00.000Z' },
      { title: 'New name', firstSeenAt: '2024-02-01T00:00:00.000Z', lastSeenAt: '2024-02-01T00:00:00.000Z' },
    ]);
    expect(await repository.getConversation(NEW)).toBeUndefined();

    // From now on the alias finds it, also when no messages with ids are shown.
    expect(await repository.resolveConversation(renamed)).toMatchObject({ conversationKey: OLD, reason: 'alias' });
  });

  it('gives a different chat with the same title an entry of its own', async () => {
    const alice = titled('Alice Andersen');
    const key = alice.conversationKey;
    await archive(alice, chat(key, [0, 2, 4, 6]));
    const otherChat = (minutes: number[]) => chat(key, minutes, (minute) => `Other chat ${minute}`);

    // Another chat with this title shows other messages from the same hours.
    expect(await repository.resolveConversation(alice, identityEvidence(otherChat([1, 3, 5])))).toEqual({ conversationKey: null, reason: 'separate', record: null, alsoMatching: [] });
    // Messages newer than everything archived may be new messages of the archived chat.
    expect(await repository.resolveConversation(alice, identityEvidence(otherChat([10, 11])))).toMatchObject({ conversationKey: key, reason: 'key' });
    // With nothing to compare, the title decides, as before.
    expect(await repository.resolveConversation(alice)).toMatchObject({ conversationKey: key, reason: 'key' });

    // Archived under a key of its own, each chat is found by its messages.
    const ownKey = 'local:second-alice';
    await archive({ ...alice, conversationKey: ownKey }, chat(ownKey, [1, 3, 5], (minute) => `Other chat ${minute}`), { aliases: [key] });
    expect(await repository.resolveConversation(alice, identityEvidence(otherChat([3, 5])))).toMatchObject({ conversationKey: ownKey, reason: 'alias' });
    expect(await repository.resolveConversation(alice, identityEvidence(chat(key, [4, 6])))).toMatchObject({ conversationKey: key, reason: 'key' });
  });

  it('links a Teams chat id that becomes readable to the entry archived by title', async () => {
    const byTitle = 'title:project alpha';
    const threadId = '19:aaaabbbbccccdddd@thread.v2';
    await archive(titled('Project Alpha'), chat(byTitle, [0, 1, 2]));
    const withId = titled('Project Alpha', threadId);

    expect(await repository.resolveConversation(withId, identityEvidence(chat('any', [1, 2])))).toMatchObject({ conversationKey: byTitle, reason: 'overlap' });
    await archive({ ...withId, conversationKey: byTitle }, chat(byTitle, [3]), { aliases: [withId.conversationKey] });
    expect(await repository.getConversation(byTitle)).toMatchObject({ threadId, type: 'group', aliases: [withId.conversationKey] });
    expect(await repository.resolveConversation(withId)).toMatchObject({ conversationKey: byTitle, reason: 'alias' });

    // A chat with another chat id is another chat, whatever it shows.
    expect(await repository.resolveConversation(titled('Project Alpha', '19:eeeeffff00001111@thread.v2'), identityEvidence(chat('any', [1, 2])))).toMatchObject({ reason: 'new' });
  });

  it('continues the entry archived by title when the chat id shows with none of its messages', async () => {
    const byTitle = 'title:project alpha';
    const threadId = '19:aaaabbbbccccdddd@thread.v2';
    await archive(titled('Project Alpha'), chat(byTitle, [0, 2, 4, 6]));
    const withId = titled('Project Alpha', threadId);

    // Only messages newer than the archive are on screen, or none with ids: the title finds it.
    expect(await repository.resolveConversation(withId, identityEvidence(chat('any', [10, 11])))).toMatchObject({ conversationKey: byTitle, reason: 'title' });
    expect(await repository.resolveConversation(withId)).toMatchObject({ conversationKey: byTitle, reason: 'title' });
    // Other messages from the same hours: a different chat with that title.
    expect(await repository.resolveConversation(withId, identityEvidence(chat('any', [1, 3, 5], (minute) => `Other chat ${minute}`)))).toMatchObject({ conversationKey: withId.conversationKey, reason: 'new' });

    // A renamed chat is found under the title it is known by.
    const renamed = 'title:project alpha (old)';
    await archive({ ...titled('Project Alpha (old)'), conversationKey: renamed }, chat(renamed, [20, 21]), { aliases: ['title:project beta'] });
    expect(await repository.resolveConversation(titled('Project Beta', '19:9999888877776666@thread.v2'))).toMatchObject({ conversationKey: renamed, reason: 'title' });

    // Once the run writes there, the entry has the chat id and is found by it.
    await archive({ ...withId, conversationKey: byTitle }, chat(byTitle, [10]), { aliases: [withId.conversationKey] });
    expect(await repository.getConversation(byTitle)).toMatchObject({ threadId, type: 'group', messageCount: 5 });
    expect(await repository.resolveConversation(withId)).toMatchObject({ conversationKey: byTitle, reason: 'alias' });
    expect(await repository.resolveConversation(titled('Project Alpha', '19:eeeeffff00001111@thread.v2'))).toMatchObject({ reason: 'new' });
  });
});

describe('renaming an entry in the archive', () => {
  it('shows the given name instead of the Teams title until it is cleared', async () => {
    await archive(titled('Old name'), chat(OLD, [0]));
    expect(await repository.renameConversation(OLD, '  Budget   2024 ')).toMatchObject({ displayName: 'Budget 2024', title: 'Old name' });
    await archive(titled('Old name'), chat(OLD, [1]));
    expect(await repository.getConversation(OLD)).toMatchObject({ displayName: 'Budget 2024', title: 'Old name', messageCount: 2 });
    expect((await repository.renameConversation(OLD, '')).displayName).toBeNull();
    await expect(repository.renameConversation('title:missing', 'x')).rejects.toThrow(/No archived conversation/);
  });
});

describe('merging two entries of one chat', () => {
  /**
   * The chat was archived as "Old name" and, after Teams renamed it (before this version), again
   * as "New name": one message with id and one with an exact time are in both entries.
   */
  async function twoEntries(): Promise<void> {
    await archive(titled('Old name'), [...chat(OLD, [0, 1, 2]), exactTimeWithoutId(OLD, 3, 'Exact time'), withoutIdOrTime(OLD, `n:${id(4)}:1`, 'No time')], {
      segments: [{ oldest: T0, newest: T0 + 3 * MINUTE, reachedBeginning: true }],
      now: '2024-01-20T00:00:00.000Z',
    });
    await archive(titled('New name'), [...chat(NEW, [2, 4]), exactTimeWithoutId(NEW, 3, 'Exact time')], {
      sessionId: 's2',
      segments: [{ oldest: T0 + 2 * MINUTE, newest: T0 + 4 * MINUTE, reachedBeginning: false }],
      now: '2024-02-01T00:00:00.000Z',
    });
    await repository.createSession(session({ sessionId: 's1', conversationKey: OLD, status: 'completed', updatedAt: '2024-01-20T00:00:00.000Z' }));
    await saveImage(OLD, 'https://example.invalid/shared.png');
    await saveImage(NEW, 'https://example.invalid/shared.png');
    await saveImage(OLD, 'https://example.invalid/only-old.png');
  }

  it('moves every message, picture and run into one entry, once each', async () => {
    await twoEntries();
    const outcome = await repository.mergeConversations(OLD, NEW);

    expect(outcome).toMatchObject({ sourceKey: OLD, targetKey: NEW, messagesMoved: 5, imagesMoved: 2, sessionsMoved: 1 });
    expect(await repository.getConversation(OLD)).toBeUndefined();
    expect(outcome.target).toMatchObject({
      conversationKey: NEW,
      title: 'New name',
      messageCount: 6,
      aliases: [OLD],
      mergedFrom: [OLD],
      mergedInto: null,
      coverage: [{ oldest: T0, newest: T0 + 4 * MINUTE, reachedBeginning: true }],
    });
    expect(outcome.target.titleHistory?.map((seen) => seen.title)).toEqual(['Old name', 'New name']);
    expect((await repository.getMessages(NEW)).map((m) => m.text).sort()).toEqual(['Exact time', 'Message 0', 'Message 1', 'Message 2', 'Message 4', 'No time']);
    expect(await repository.countMessages(OLD)).toBe(0);
    expect(await repository.getMessage(`${NEW}#${id(2)}`)).toMatchObject({ aliases: [] });
    expect(await repository.countImages(NEW)).toBe(2);
    expect(await repository.countImages(OLD)).toBe(0);
    expect(await repository.getSession('s1')).toMatchObject({ conversationKey: NEW, detectedKey: OLD });
    expect(await repository.pendingMerges()).toEqual([]);

    // The old title now finds the merged entry.
    expect(await repository.resolveConversation(titled('Old name'))).toMatchObject({ conversationKey: NEW, reason: 'alias' });
  });

  it('recognises the moved messages when the chat is extracted again', async () => {
    await twoEntries();
    await repository.mergeConversations(OLD, NEW);
    // What the page parser sends for the chat now (see ConversationIdentity.mergedKeys).
    const noTime = withoutIdOrTime(NEW, `n:${id(4)}:1`, 'No time');
    noTime.alternateKeys = [`${NEW}#fp:${weakFingerprint(OLD, `n:${id(4)}:1`, 'No time')}`];
    const again = await archive(titled('New name'), [...chat(NEW, [0, 1, 2, 4]), exactTimeWithoutId(NEW, 3, 'Exact time'), noTime]);

    expect(again.inserted).toBe(0);
    expect(await repository.countMessages(NEW)).toBe(6);
  });

  it('finishes an interrupted merge, and meanwhile sends the chat to the entry it goes into', async () => {
    await twoEntries();
    let steps = 0;
    const interrupted = repository.mergeConversations(OLD, NEW, {
      messageChunk: 2,
      onProgress: () => {
        steps++;
        if (steps === 1) throw new Error('page closed');
      },
    });
    await expect(interrupted).rejects.toThrow('page closed');
    expect(await repository.pendingMerges()).toEqual([expect.objectContaining({ sourceKey: OLD, targetKey: NEW })]);
    expect(await repository.getConversation(OLD)).toMatchObject({ mergedInto: NEW });
    expect(await repository.countMessages(OLD)).toBe(3);

    expect(await repository.resolveConversation(titled('Old name'), identityEvidence(chat(OLD, [1, 2])))).toMatchObject({ conversationKey: NEW });
    await expect(archive(titled('Old name'), chat(OLD, [5]))).rejects.toThrow(/merged into/);
    await expect(repository.deleteConversation(NEW)).rejects.toThrow(/being merged/);

    expect(await repository.resumePendingMerges()).toBe(1);
    expect(await repository.getConversation(OLD)).toBeUndefined();
    expect(await repository.getConversation(NEW)).toMatchObject({ messageCount: 6, mergedFrom: [OLD] });
    expect(await repository.countImages(NEW)).toBe(2);
    expect(await repository.pendingMerges()).toEqual([]);
    expect(await repository.resumePendingMerges()).toBe(0);
  });

  it('refuses merges that would mix two chats or disturb a running extraction', async () => {
    await twoEntries();
    await expect(repository.mergeConversations(OLD, OLD)).rejects.toThrow(/into itself/);
    await expect(repository.mergeConversations(OLD, 'title:missing')).rejects.toThrow(/must be in the archive/);

    await repository.createSession(session({ sessionId: 'live', conversationKey: OLD, status: 'running', updatedAt: new Date().toISOString() }));
    await expect(repository.mergeConversations(OLD, NEW)).rejects.toThrow(/is running/);
    expect(await repository.getConversation(OLD)).toMatchObject({ mergedInto: null });
    expect(await repository.pendingMerges()).toEqual([]);

    const a = titled('Chat', '19:aaaa1111@thread.v2');
    const b = titled('Chat', '19:bbbb2222@thread.v2');
    await archive(a, chat(a.conversationKey, [0]));
    await archive(b, chat(b.conversationKey, [0]));
    await expect(repository.mergeConversations(a.conversationKey, b.conversationKey)).rejects.toThrow(/different Teams chats/);

    // A run that stopped reporting long ago does not block a merge.
    await repository.updateSession('live', { updatedAt: '2024-01-01T00:00:00.000Z' });
    await expect(repository.mergeConversations(OLD, NEW)).resolves.toMatchObject({ messagesMoved: 5 });
  });

  it('finds the entries that hold some of the same messages, to suggest them first', async () => {
    await twoEntries();
    const third = titled('Third copy');
    await archive(third, chat(third.conversationKey, [0, 1, 4]));
    await archive(titled('Another chat'), chat('title:another chat', [10, 11]));

    expect(await repository.entriesSharingMessages(OLD)).toEqual([
      { conversationKey: third.conversationKey, shared: 2 },
      { conversationKey: NEW, shared: 1 },
    ]);
    // Only the oldest and newest messages of the entry are compared.
    expect(await repository.entriesSharingMessages(OLD, 1)).toEqual([{ conversationKey: third.conversationKey, shared: 1 }]);
    expect(await repository.entriesSharingMessages('title:another chat')).toEqual([]);

    // Messages of an entry that was merged count for the entry they went into.
    await repository.mergeConversations(NEW, OLD);
    expect(await repository.entriesSharingMessages(third.conversationKey)).toEqual([{ conversationKey: OLD, shared: 3 }]);
  });
});

describe('importing entries that were renamed or merged', () => {
  it('keeps names, titles and aliases, and merges an earlier copy of a merged entry again', async () => {
    await archive(titled('Old name'), chat(OLD, [0, 1, 2]), { now: '2024-01-20T00:00:00.000Z' });
    await archive(titled('New name'), chat(NEW, [2, 3]), { now: '2024-02-01T00:00:00.000Z' });
    await repository.renameConversation(NEW, 'Budget');
    const beforeMerge = JSON.parse(JSON.stringify(await buildArchiveExport(repository, 'all')));
    await repository.mergeConversations(OLD, NEW);
    const afterMerge = JSON.parse(JSON.stringify(await buildArchiveExport(repository, 'all')));

    // The backup made before the merge does not bring the old entry back.
    const summary = await importArchive(repository, beforeMerge);
    expect(summary).toMatchObject({ conversations: 2, joinedExisting: 1, keptSeparate: 0, inserted: 0 });
    expect(await repository.getConversation(OLD)).toBeUndefined();
    expect(await repository.getConversation(NEW)).toMatchObject({ messageCount: 4, displayName: 'Budget', mergedFrom: [OLD] });

    // In another browser, the export made after the merge restores the entry with its history.
    const elsewhere = await openTestRepository();
    try {
      await importArchive(elsewhere, afterMerge);
      expect(await elsewhere.getConversation(NEW)).toMatchObject({ messageCount: 4, aliases: [OLD], mergedFrom: [OLD], displayName: 'Budget' });
      expect((await elsewhere.getConversation(NEW))?.titleHistory?.map((seen) => seen.title)).toEqual(['Old name', 'New name']);
      expect(await elsewhere.resolveConversation(titled('Old name'))).toMatchObject({ conversationKey: NEW, reason: 'alias' });
      expect(await importArchive(elsewhere, afterMerge)).toMatchObject({ inserted: 0, joinedExisting: 0, keptSeparate: 0 });
    } finally {
      elsewhere.close();
    }
  });

  it('finds the entry of an imported chat by its messages, and keeps another chat with its title apart', async () => {
    // Here, "Old name" is another chat, with other messages from the same hours.
    await archive(titled('Old name'), chat(OLD, [0.5, 1.5], (minute) => `Unrelated ${minute}`));
    const source = await openTestRepository();
    let exported: unknown;
    try {
      await source.upsertObservations({ conversation: titled('Old name'), messages: chat(OLD, [0, 1, 2]), sessionId: 'x' });
      exported = JSON.parse(JSON.stringify(await buildArchiveExport(source, 'all')));
    } finally {
      source.close();
    }

    const summary = await importArchive(repository, exported, { newId: () => 'imported' });
    expect(summary).toMatchObject({ conversations: 1, inserted: 3, keptSeparate: 1, joinedExisting: 0 });
    expect(await repository.getConversation(OLD)).toMatchObject({ messageCount: 2 });
    expect(await repository.getConversation('local:imported')).toMatchObject({ title: 'Old name', aliases: [OLD], messageCount: 3 });
    expect(await repository.getMessage(`local:imported#${id(1)}`)).toMatchObject({ conversationKey: 'local:imported', text: 'Message 1' });

    // Importing the file again finds that entry: nothing is added twice.
    expect(await importArchive(repository, exported, { newId: () => 'twice' })).toMatchObject({ inserted: 0, joinedExisting: 1, keptSeparate: 0 });
    expect(await repository.getConversation('local:twice')).toBeUndefined();
    expect(await repository.countMessages('local:imported')).toBe(3);
  });

  it('imports an export made during a merge into one entry, with no merge left pending', async () => {
    await archive(titled('Old name'), chat(OLD, [0, 1, 2]), { now: '2024-01-20T00:00:00.000Z' });
    await archive(titled('New name'), chat(NEW, [3]), { now: '2024-02-01T00:00:00.000Z' });
    await expect(
      repository.mergeConversations(OLD, NEW, {
        messageChunk: 1,
        onProgress: () => {
          throw new Error('stopped');
        },
      }),
    ).rejects.toThrow('stopped');
    const midway = JSON.parse(JSON.stringify(await buildArchiveExport(repository, 'all')));

    expect(midway.conversations.map((c: { conversationKey: string; mergedInto?: string | null }) => [c.conversationKey, c.mergedInto])).toEqual([
      [NEW, null],
      [OLD, NEW],
    ]);

    const elsewhere = await openTestRepository();
    try {
      // The old entry's key is already an alias of the new one, so it joins it there.
      expect(await importArchive(elsewhere, midway)).toMatchObject({ conversations: 2, joinedExisting: 1 });
      expect(await elsewhere.getConversation(OLD)).toBeUndefined();
      expect(await elsewhere.getConversation(NEW)).toMatchObject({ mergedInto: null, messageCount: 4 });
      expect((await elsewhere.listConversations()).filter((record) => record.mergedInto)).toEqual([]);
      expect(await elsewhere.pendingMerges()).toEqual([]);
    } finally {
      elsewhere.close();
    }
  });
});
