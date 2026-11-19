import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { serializeArchive } from '../../src/export/exporters';
import { buildArchiveExport, ImportValidationError } from '../../src/export/format';
import { importArchive } from '../../src/export/import';
import type { ArchiveRepository } from '../../src/storage/repository';
import { openTestRepository } from '../helpers/fixtures';
import { CK, CONVERSATION, message, session } from '../helpers/messages';

let repo: ArchiveRepository;

beforeEach(async () => {
  repo = await openTestRepository();
});

afterEach(() => {
  repo.close();
});

const upsert = (messages: ReturnType<typeof message>[], sessionId = 's1', conversation = CONVERSATION) =>
  repo.upsertObservations({ conversation, messages: structuredClone(messages), sessionId });

describe('upserts and duplicate prevention', () => {
  it('inserts new messages and treats identical re-observations as unchanged', async () => {
    const batch = [message({ id: '1705314600000' }), message({ id: '1705314660000', text: 'Second', sender: { name: 'Bob Brown', id: null, isSelf: false, source: 'explicit' } })];
    expect(await upsert(batch, 's1')).toMatchObject({ inserted: 2, updated: 0, unchanged: 0, merged: 0 });
    const again = await upsert(batch, 's2');
    expect(again).toMatchObject({ inserted: 0, updated: 0, unchanged: 2 });
    expect(again.statuses).toEqual({ [batch[0]!.key]: 'unchanged', [batch[1]!.key]: 'unchanged' });

    const stored = await repo.getMessages(CK);
    expect(stored.map((m) => m.text)).toEqual(['Message 1705314600000', 'Second']);
    expect(stored[0]).toMatchObject({ observationCount: 2, firstSessionId: 's1', lastSessionId: 's2', previousVersions: [], aliases: [] });
    expect(await repo.getConversation(CK)).toMatchObject({
      title: 'Project Alpha',
      type: 'group',
      messageCount: 2,
      participants: ['Alice Andersen', 'Bob Brown'],
      oldestSortKey: 1705314600000,
      newestSortKey: 1705314660000,
      lastSessionId: 's2',
    });
  });

  it('upgrades sender and timestamp from better observations but never downgrades them', async () => {
    const id = '1705314600000';
    await upsert([message({ id, sender: { name: null, id: null, isSelf: false, source: 'unknown' }, timestamp: '2024-01-15T10:30:00.000Z', timestampSource: 'visible-text', timestampRaw: '10:30' })]);
    const better = await upsert([message({ id, sender: { name: 'Alice Andersen', id: '8:orgid:1', isSelf: false, source: 'group-inferred' } })]);
    expect(better.updated).toBe(1);
    const worse = await upsert([message({ id, sender: { name: null, id: null, isSelf: false, source: 'unknown' }, timestamp: '2024-01-15T10:30:00.000Z', timestampSource: 'visible-text' })]);
    expect(worse.unchanged).toBe(1);

    const record = await repo.getMessage(`${CK}#${id}`);
    expect(record?.sender).toEqual({ name: 'Alice Andersen', id: '8:orgid:1', isSelf: false, source: 'group-inferred' });
    expect(record).toMatchObject({ timestamp: new Date(Number(id)).toISOString(), timestampSource: 'datetime-attr', timestampRaw: '10:30' });
  });

  it('keeps earlier versions when a message is edited and ignores partially rendered observations', async () => {
    const id = '1705314600000';
    await upsert([message({ id, text: 'Original text' })]);
    expect((await upsert([message({ id, text: 'Edited text' })])).updated).toBe(1);
    expect((await upsert([message({ id, text: '' })])).unchanged).toBe(1);
    const deleted = await upsert([message({ id, text: 'This message has been deleted.', isDeleted: true })]);
    expect(deleted.updated).toBe(1);

    const record = await repo.getMessage(`${CK}#${id}`);
    expect(record).toMatchObject({ text: 'This message has been deleted.', isDeleted: true, isEdited: true });
    expect(record?.previousVersions.map((version) => version.text)).toEqual(['Original text', 'Edited text']);
  });

  it('folds a fingerprint-keyed copy into the id-keyed record once the id is seen', async () => {
    const id = '1705314600000';
    const withoutId = message({ id: null, text: 'Hello', timestamp: new Date(Number(id)).toISOString(), timestampSource: 'datetime-attr', sortKey: Number(id), sortKeySource: 'timestamp', fingerprintStrong: true });
    const withId = message({ id, text: 'Hello', fingerprint: withoutId.fingerprint });
    expect((await upsert([withoutId])).inserted).toBe(1);

    const folded = await upsert([withId]);
    expect(folded).toMatchObject({ merged: 1, updated: 1, inserted: 0 });
    expect(await repo.countMessages(CK)).toBe(1);
    const record = await repo.getMessage(withId.key);
    expect(record).toMatchObject({ messageId: id, idSource: 'dom', observationCount: 2, aliases: [withoutId.key] });
    expect(await repo.getMessage(withoutId.key)).toBeUndefined();

    // A later render without the id still lands on the same record.
    const later = await upsert([withoutId]);
    expect(later.inserted).toBe(0);
    expect(await repo.countMessages(CK)).toBe(1);
  });

  it('stores a message without id or timestamp once, whichever neighbours were rendered', async () => {
    const weak = (key: string, alternateKeys: string[] = []) =>
      message({ id: null, text: 'ok', key, fingerprint: key.split('#fp:')[1]!, sortKey: 1705314630000, sortKeySource: 'interpolated', fingerprintStrong: false, alternateKeys });
    const keyNewer = `${CK}#fp:newer-anchor`;
    const keyOlder = `${CK}#fp:older-anchor`;

    // Scrolling up: first seen below its older neighbour's window edge, then with both, then at the bottom edge.
    expect((await upsert([weak(keyNewer)])).inserted).toBe(1);
    expect((await upsert([weak(keyNewer, [keyOlder])])).updated).toBe(1);
    const atBottomEdge = await upsert([weak(keyOlder)]);
    expect(atBottomEdge.inserted).toBe(0);
    expect(await repo.countMessages(CK)).toBe(1);
    expect((await repo.getMessage(keyNewer))?.aliases).toEqual([keyOlder]);

    // The newest message of a chat has no newer neighbour until someone replies.
    const otherKeyOlder = `${CK}#fp:older-anchor-2`;
    const otherKeyNewer = `${CK}#fp:newer-anchor-2`;
    const newest = (key: string, alternateKeys: string[] = []) => ({ ...weak(key, alternateKeys), text: 'newest', contentHash: 'other' });
    expect((await upsert([newest(otherKeyOlder)])).inserted).toBe(1);
    expect((await upsert([newest(otherKeyNewer, [otherKeyOlder])])).inserted).toBe(0);
    expect((await upsert([newest(otherKeyNewer)])).inserted).toBe(0);
    expect(await repo.countMessages(CK)).toBe(2);
  });

  it('applies a batch atomically', async () => {
    const foreign = message({ id: '1705314700000', conversationKey: 'teams:19:other@thread.v2' });
    await expect(upsert([message({ id: '1705314600000' }), foreign])).rejects.toThrow(/does not belong/);
    expect(await repo.countMessages(CK)).toBe(0);
    expect(await repo.getConversation(CK)).toBeUndefined();
  });

  it('merges coverage reported with each batch', async () => {
    await repo.upsertObservations({ conversation: CONVERSATION, messages: [message()], sessionId: 's1', segments: [{ oldest: 10, newest: 20, reachedBeginning: false }] });
    await repo.upsertObservations({ conversation: CONVERSATION, messages: [message()], sessionId: 's1', segments: [{ oldest: 5, newest: 12, reachedBeginning: true }] });
    await repo.mergeCoverage(CK, [{ oldest: 30, newest: 40, reachedBeginning: false }]);
    expect((await repo.getConversation(CK))?.coverage).toEqual([
      { oldest: 5, newest: 20, reachedBeginning: true },
      { oldest: 30, newest: 40, reachedBeginning: false },
    ]);
  });
});

describe('sessions', () => {
  it('marks stale sessions as interrupted and offers the latest one for resuming', async () => {
    const now = Date.parse('2024-01-15T12:00:00.000Z');
    await repo.createSession(session({ sessionId: 'old-done', startedAt: '2024-01-15T09:00:00.000Z', status: 'completed', tabId: 1 }));
    await repo.createSession(session({ sessionId: 'stale', startedAt: '2024-01-15T11:00:00.000Z', updatedAt: '2024-01-15T11:50:00.000Z', tabId: 2 }));
    await repo.createSession(session({ sessionId: 'alive', conversationKey: 'teams:19:other@thread.v2', startedAt: '2024-01-15T11:59:00.000Z', updatedAt: '2024-01-15T11:59:50.000Z', tabId: 3 }));

    expect(await repo.markStaleSessions(now, 90_000)).toBe(1);
    expect(await repo.getSession('stale')).toMatchObject({ status: 'interrupted', stopReason: 'interrupted', endedAt: '2024-01-15T11:50:00.000Z' });
    expect((await repo.getSession('alive'))?.status).toBe('running');

    // Closing tab 3 ends its session regardless of the heartbeat.
    expect(await repo.markStaleSessions(now, 0, 3)).toBe(1);
    expect((await repo.getSession('alive'))?.status).toBe('interrupted');

    expect((await repo.listSessions({ conversationKey: CK })).map((s) => s.sessionId)).toEqual(['stale', 'old-done']);
    expect((await repo.findResumableSession(CK))?.sessionId).toBe('stale');
    await repo.updateSession('stale', { status: 'completed' });
    expect(await repo.findResumableSession(CK)).toBeNull();
  });

  it('does not offer visible-only sessions for resuming', async () => {
    await repo.createSession(session({ sessionId: 'v', mode: 'visible', status: 'stopped' }));
    expect(await repo.findResumableSession(CK)).toBeNull();
  });
});

describe('replies, deletion, export and import', () => {
  it('resolves quoted replies without an id by matching the quoted text', async () => {
    const target = message({ id: '1705314600000', text: 'Lunch at noon? I booked a table at the usual place.' });
    const reply = message({
      id: '1705314660000',
      text: 'Count me in',
      sender: { name: 'Bob Brown', id: null, isSelf: false, source: 'explicit' },
      replyTo: { messageId: null, senderName: 'Alice Andersen', timestampRaw: null, preview: 'Lunch at noon? I booked a table…', resolvedKey: null, resolution: 'unresolved' },
    });
    const orphan = message({
      id: '1705314720000',
      text: 'Which one?',
      replyTo: { messageId: null, senderName: 'Carol Chen', timestampRaw: null, preview: 'Something never archived', resolvedKey: null, resolution: 'unresolved' },
    });
    await upsert([target, reply, orphan]);

    expect(await repo.resolveReplies(CK)).toEqual({ resolved: 1, unresolved: 1 });
    expect((await repo.getMessage(reply.key))?.replyTo).toMatchObject({ resolvedKey: target.key, resolution: 'content-match' });
    expect((await repo.getMessage(orphan.key))?.replyTo?.resolvedKey).toBeNull();
  });

  it('deletes a conversation with its messages and sessions only', async () => {
    const other = { ...CONVERSATION, conversationKey: 'teams:19:other@thread.v2', threadId: '19:other@thread.v2' };
    await upsert([message({ id: '1705314600000' }), message({ id: '1705314660000' })]);
    await upsert([message({ id: '1705314600000', conversationKey: other.conversationKey })], 's1', other);
    await repo.createSession(session({ sessionId: 'a' }));
    await repo.createSession(session({ sessionId: 'b', conversationKey: other.conversationKey }));

    expect(await repo.deleteConversation(CK)).toEqual({ messages: 2, sessions: 1 });
    expect(await repo.getConversation(CK)).toBeUndefined();
    expect(await repo.countMessages(other.conversationKey)).toBe(1);
    expect(await repo.getSession('b')).toBeDefined();
  });

  it('round-trips an export through import, idempotently', async () => {
    await repo.upsertObservations({
      conversation: CONVERSATION,
      messages: [
        message({ id: '1705314600000', text: 'First', attachments: [{ kind: 'file', name: 'plan.docx', url: 'https://example.invalid/plan.docx' }] }),
        message({ id: '1705314660000', text: 'Second' }),
        message({ id: null, text: 'No id', sortKey: 1705314630000, sortKeySource: 'interpolated', fingerprintStrong: false }),
      ],
      sessionId: 's1',
      segments: [{ oldest: 1705314600000, newest: 1705314660000, reachedBeginning: true }],
    });
    await upsert([message({ id: '1705314660000', text: 'Second (edited)' })], 's2');

    const exported = await buildArchiveExport(repo, 'all', { now: new Date('2024-02-01T00:00:00Z') });
    const json = serializeArchive(exported, 'json');
    const target = await openTestRepository();
    try {
      expect(await importArchive(target, json)).toEqual({ conversations: 1, inserted: 3, updated: 0, unchanged: 0 });
      expect(await importArchive(target, json)).toEqual({ conversations: 1, inserted: 0, updated: 0, unchanged: 3 });
      expect(await target.getMessages(CK)).toEqual(await repo.getMessages(CK));
      const restored = await target.getConversation(CK);
      const original = await repo.getConversation(CK);
      expect(restored).toMatchObject({
        title: original?.title,
        type: original?.type,
        participants: original?.participants,
        coverage: original?.coverage,
        messageCount: 3,
        oldestSortKey: original?.oldestSortKey,
        newestSortKey: original?.newestSortKey,
      });

      // Importing into an archive that already has some of the messages merges instead of duplicating.
      expect(await importArchive(repo, json)).toEqual({ conversations: 1, inserted: 0, updated: 0, unchanged: 3 });
    } finally {
      target.close();
    }
  });

  it('rejects files that are not archive exports', async () => {
    await expect(importArchive(repo, '{"format":"something-else"}')).rejects.toBeInstanceOf(ImportValidationError);
    await expect(importArchive(repo, 'not json')).rejects.toThrow(/Not valid JSON/);
    expect(await repo.listConversations()).toEqual([]);
  });
});
