import { describe, expect, it } from 'vitest';
import { hashParts, normalizeForHash, stableHash } from '../../src/shared/hash';
import type { StoredMessage } from '../../src/shared/types';
import { createStoredMessage, mergeImported, mergeObservation, normalizeStoredMessage, unionAttachments } from '../../src/storage/merge';
import { findReplyTarget, normalizeForMatch, type ReplyCandidate } from '../../src/storage/reply-resolver';
import { message } from '../helpers/messages';

const ctx = (sessionId = 's1', nowIso = '2024-01-15T12:00:00.000Z') => ({ sessionId, nowIso });

describe('mergeObservation', () => {
  it('counts identical observations without changing the record', () => {
    const record = createStoredMessage(message(), ctx());
    const { record: next, status } = mergeObservation(record, message(), ctx('s2', '2024-01-15T13:00:00.000Z'));
    expect(status).toBe('unchanged');
    expect(next).toMatchObject({ observationCount: 2, lastSessionId: 's2', lastSeenAt: '2024-01-15T13:00:00.000Z', firstSessionId: 's1' });
  });

  it('accepts a renamed author but does not overwrite an author with a weaker guess', () => {
    const record = createStoredMessage(message({ sender: { name: 'Alice A.', id: null, isSelf: false, source: 'explicit' } }), ctx());
    const renamed = mergeObservation(record, message({ sender: { name: 'Alice Andersen', id: null, isSelf: false, source: 'explicit' } }), ctx());
    expect(renamed.status).toBe('updated');
    expect(renamed.record.sender.name).toBe('Alice Andersen');
    const guess = mergeObservation(renamed.record, message({ sender: { name: 'Bob Brown', id: null, isSelf: false, source: 'group-inferred' } }), ctx());
    expect(guess.record.sender.name).toBe('Alice Andersen');
  });

  it('does not flag a message as edited when only the extractor changed', () => {
    const record: StoredMessage = { ...createStoredMessage(message({ text: 'Hello  world' }), ctx()), extractorVersion: '0.9.0' };
    const { record: next, status } = mergeObservation(record, message({ text: 'Hello world!' }), ctx());
    expect(status).toBe('updated');
    expect(next.isEdited).toBe(false);
    expect(next.previousVersions).toHaveLength(1);
  });

  it('upgrades quoted replies, kinds and attachments', () => {
    const record = createStoredMessage(
      message({
        kind: 'system',
        replyTo: { messageId: null, senderName: 'Bob Brown', timestampRaw: null, preview: 'Hi', resolvedKey: null, resolution: 'unresolved' },
        attachments: [{ kind: 'file', name: 'a.pdf', url: null }],
      }),
      ctx(),
    );
    const { record: next } = mergeObservation(
      record,
      message({
        replyTo: { messageId: '1705314500000', senderName: 'Bob Brown', timestampRaw: null, preview: 'Hi', resolvedKey: 'k#1705314500000', resolution: 'message-id' },
        attachments: [{ kind: 'file', name: 'a.pdf', url: 'https://example.invalid/a.pdf' }],
      }),
      ctx(),
    );
    expect(next.kind).toBe('message');
    expect(next.replyTo).toMatchObject({ messageId: '1705314500000', resolution: 'message-id' });
    expect(next.attachments).toEqual([{ kind: 'file', name: 'a.pdf', url: 'https://example.invalid/a.pdf' }]);
  });

  it('remembers the other keys a message without id was seen under', () => {
    const observed = message({ id: null, key: 'k#fp:one', alternateKeys: ['k#fp:two'], fingerprintStrong: false, sortKey: 5, sortKeySource: 'interpolated' });
    const record = createStoredMessage(observed, ctx());
    expect(record.aliases).toEqual(['k#fp:two']);
    expect('alternateKeys' in record).toBe(false);
    const { record: next, status } = mergeObservation(record, { ...observed, key: 'k#fp:three', alternateKeys: [] }, ctx());
    expect(status).toBe('updated');
    expect(next.aliases).toEqual(['k#fp:two', 'k#fp:three']);
  });
});

describe('attachments', () => {
  it('counts the same file once, preferring the copy with a link', () => {
    expect(
      unionAttachments(
        [{ kind: 'file', name: 'report.pdf', url: null }, { kind: 'image', name: 'chart.png', url: 'https://x/c.png' }],
        [{ kind: 'file', name: 'report.pdf', url: 'https://x/r.pdf' }],
      ),
    ).toEqual([
      { kind: 'file', name: 'report.pdf', url: 'https://x/r.pdf' },
      { kind: 'image', name: 'chart.png', url: 'https://x/c.png' },
    ]);
  });
});

describe('saved images', () => {
  const ID_A = 'a'.repeat(64);
  const ID_B = 'b'.repeat(64);
  const image = (imageId?: string, url: string | null = null) => ({ kind: 'image' as const, name: 'image', url, ...(imageId ? { imageId } : {}) });

  it('keeps the image id, whichever copy has it', () => {
    expect(unionAttachments([image()], [image(ID_A)])).toEqual([image(ID_A)]);
    expect(unionAttachments([image(ID_A)], [image(undefined, 'https://x/i.png')])).toEqual([image(ID_A, 'https://x/i.png')]);
    // An image already linked keeps its id when a later capture produced a different copy.
    expect(unionAttachments([image(ID_A)], [image(ID_B)])).toEqual([image(ID_A)]);
  });

  it('keeps several pictures that Teams named "image" apart', () => {
    expect(unionAttachments([image(ID_A), image(ID_B)], [image(), image()])).toEqual([image(ID_A), image(ID_B)]);
    expect(unionAttachments([image()], [image(ID_A), image(ID_B)])).toEqual([image(ID_A), image(ID_B)]);
  });

  it('updates a record when an image is saved later, and never drops its id', () => {
    const record = createStoredMessage(message({ attachments: [image(), image()] }), ctx());
    const saved = mergeObservation(record, message({ attachments: [image(ID_A), image(ID_B)] }), ctx('s2'));
    expect(saved.status).toBe('updated');
    expect(saved.record.attachments).toEqual([image(ID_A), image(ID_B)]);
    const later = mergeObservation(saved.record, message({ attachments: [image(), image()] }), ctx('s3'));
    expect(later.status).toBe('unchanged');
    expect(later.record.attachments).toEqual([image(ID_A), image(ID_B)]);
    expect(mergeImported(later.record, createStoredMessage(message({ attachments: [image(), image()] }), ctx('s0', '2024-01-01T00:00:00.000Z'))).record.attachments).toEqual([
      image(ID_A),
      image(ID_B),
    ]);
  });
});

describe('importing records', () => {
  it('lets the more recently seen copy win and keeps the other content as a previous version', () => {
    const older = { ...createStoredMessage(message({ text: 'Draft' }), ctx('a', '2024-01-01T00:00:00.000Z')), observationCount: 4, aliases: ['k#fp:x'] };
    const newer = { ...createStoredMessage(message({ text: 'Final' }), ctx('b', '2024-02-01T00:00:00.000Z')), observationCount: 2 };
    const { record, status } = mergeImported(older, newer);
    expect(status).toBe('updated');
    expect(record).toMatchObject({ text: 'Final', observationCount: 4, aliases: ['k#fp:x'], firstSeenAt: '2024-01-01T00:00:00.000Z' });
    expect(record.previousVersions.map((version) => version.text)).toEqual(['Draft']);
    expect(mergeImported(record, structuredClone(record)).status).toBe('unchanged');
  });

  it('fills defaults for records from older or hand-edited exports', () => {
    const minimal = { key: 'k#1', conversationKey: 'k', sortKey: 1, text: 'Hi', contentHash: 'h', fingerprint: 'f', firstSeenAt: 'x', lastSeenAt: 'x' } as unknown as StoredMessage;
    expect(normalizeStoredMessage(minimal)).toMatchObject({
      messageId: null,
      idSource: 'fingerprint',
      kind: 'message',
      sender: { name: null, id: null, isSelf: false, source: 'unknown' },
      timestampSource: 'none',
      attachments: [],
      previousVersions: [],
      aliases: [],
      sortKeySource: 'observed-order',
      observationCount: 1,
    });
  });
});

describe('hashing', () => {
  it('produces stable, distinct 28-character keys', () => {
    expect(stableHash('hello')).toBe(stableHash('hello'));
    expect(stableHash('hello')).toMatch(/^[0-9a-f]{28}$/);
    expect(stableHash('hello')).not.toBe(stableHash('hellp'));
    expect(hashParts(['a', null, 1])).toBe(hashParts(['a', undefined, '1']));
    expect(hashParts(['ab', 'c'])).not.toBe(hashParts(['a', 'bc']));
    expect(normalizeForHash('  two\n\nlines \t here ')).toBe('two lines here');
  });
});

describe('reply matching', () => {
  const candidates: ReplyCandidate[] = [
    { key: 'k#1', senderName: 'Alice Andersen', sortKey: 1, textNorm: normalizeForMatch('Can we move the meeting to Friday?') },
    { key: 'k#2', senderName: 'Bob Brown', sortKey: 2, textNorm: normalizeForMatch('Can we move the meeting to Friday? Asking for Bob') },
    { key: 'k#3', senderName: 'Alice Andersen', sortKey: 3, textNorm: normalizeForMatch('Can we move the meeting to Friday? (again)') },
    { key: 'k#5', senderName: 'Alice Andersen', sortKey: 5, textNorm: normalizeForMatch('Can we move the meeting to Friday?') },
  ];
  const reply = (preview: string, senderName: string | null = 'Alice Andersen') => ({
    messageId: null,
    senderName,
    timestampRaw: null,
    preview,
    resolvedKey: null,
    resolution: 'unresolved' as const,
  });

  it('picks the closest earlier message from the quoted sender that starts with the preview', () => {
    expect(findReplyTarget(reply('Can we move the meeting…'), 'k#4', 4, candidates)).toBe('k#3');
    expect(findReplyTarget(reply('Can we move the meeting', 'Bob Brown'), 'k#4', 4, candidates)).toBe('k#2');
    expect(findReplyTarget(reply('Can we move the meeting', null), 'k#4', 4, candidates)).toBe('k#3');
  });

  it('does not match later messages, other senders or tiny previews', () => {
    expect(findReplyTarget(reply('Can we move'), 'k#0', 0.5, candidates)).toBeNull();
    expect(findReplyTarget(reply('Can we move', 'Carol Chen'), 'k#4', 4, candidates)).toBeNull();
    expect(findReplyTarget(reply('C'), 'k#4', 4, candidates)).toBeNull();
  });
});
