import { afterEach, describe, expect, it } from 'vitest';
import { detectConversation } from '../../src/extractor/conversation';
import { parseRenderedConversation } from '../../src/extractor/page-parser';
import { buildSelectorProfile } from '../../src/extractor/selectors';
import type { ExtractedMessage } from '../../src/shared/types';
import { renderStaticChat, type FixtureMessage } from '../helpers/teams-dom';

const profile = buildSelectorProfile();
const URL = 'https://teams.microsoft.com/v2/';

function parseResult(messages: FixtureMessage[], threadId?: string | null, selfDisplayName: string | null = null) {
  renderStaticChat(messages, { threadId });
  const conversation = detectConversation(document, URL, profile);
  if (!conversation) throw new Error('no conversation');
  return parseRenderedConversation(document, {
    profile,
    conversation,
    selfDisplayName,
    referenceMs: new Date(2024, 0, 17, 12).getTime(),
    dateOrder: 'MDY',
  });
}

function parse(messages: FixtureMessage[], threadId?: string | null, selfDisplayName: string | null = null): ExtractedMessage[] {
  return parseResult(messages, threadId, selfDisplayName).messages;
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('parseRenderedConversation', () => {
  it('parses an individual (1:1) conversation', () => {
    const messages = parse(
      [
        { id: '1705314600000', author: 'Alice', time: '2024-01-15T10:30:00Z', paragraphs: ['Hi!'] },
        { id: '1705314660000', self: true, time: '2024-01-15T10:31:00Z', paragraphs: ['Hello Alice'] },
      ],
      '19:aaaa-1111_bbbb-2222@unq.gbl.spaces',
      'Me Myself',
    );
    expect(messages.map((m) => m.key)).toEqual([
      'teams:19:aaaa-1111_bbbb-2222@unq.gbl.spaces#1705314600000',
      'teams:19:aaaa-1111_bbbb-2222@unq.gbl.spaces#1705314660000',
    ]);
    expect(messages[0]?.sender).toEqual({ name: 'Alice', id: null, isSelf: false, source: 'explicit' });
    expect(messages[1]?.sender).toEqual({ name: 'Me Myself', id: null, isSelf: true, source: 'self' });
    expect(messages[0]?.sortKeySource).toBe('message-id');
    expect(messages[0]?.sortKey).toBe(1705314600000);
  });

  it('infers senders of grouped messages in a group conversation and resets at dividers', () => {
    const messages = parse([
      { id: '1705314600000', author: 'Alice', time: '2024-01-15T10:30:00Z', paragraphs: ['one'] },
      { id: '1705314610000', time: '2024-01-15T10:30:10Z', paragraphs: ['two'] },
      { id: '1705314620000', author: 'Bob', time: '2024-01-15T10:30:20Z', paragraphs: ['three'] },
      { id: '1705314630000', time: '2024-01-15T10:30:30Z', paragraphs: ['four'] },
      { divider: 'Today' },
      { id: '1705400000000', time: '2024-01-16T10:13:20Z', paragraphs: ['after divider, no header'] },
    ]);
    expect(messages.map((m) => [m.sender.name, m.sender.source])).toEqual([
      ['Alice', 'explicit'],
      ['Alice', 'group-inferred'],
      ['Bob', 'explicit'],
      ['Bob', 'group-inferred'],
      [null, 'unknown'],
    ]);
  });

  it('leaves the sender unknown when the group header is outside the rendered window', () => {
    const messages = parse([{ id: '1705314610000', time: '2024-01-15T10:30:10Z', paragraphs: ['continuation'] }]);
    expect(messages[0]?.sender.source).toBe('unknown');
  });

  it('derives timestamp and order from the message id when no time element is rendered', () => {
    const [message] = parse([{ id: '1705314612345', author: 'Alice', time: null, paragraphs: ['x'] }]);
    expect(message?.timestamp).toBe(new Date(1705314612345).toISOString());
    expect(message?.timestampSource).toBe('message-id');
    expect(message?.sortKeySource).toBe('message-id');
  });

  it('keys messages without ids by fingerprint, distinguishing identical repeats', () => {
    const messages = parse([
      { id: null, author: 'Alice', time: null, paragraphs: ['ok'] },
      { id: null, time: null, paragraphs: ['ok'] },
      { id: '1705314612345', author: 'Bob', time: '2024-01-15T10:30:12Z', paragraphs: ['next'] },
    ]);
    expect(messages[0]?.key).toMatch(/#fp:[0-9a-f]{28}$/);
    expect(messages[0]?.idSource).toBe('fingerprint');
    expect(new Set(messages.map((m) => m.key)).size).toBe(3);
    expect(messages[0]?.sortKey).toBeNull();
  });

  it('produces the same fingerprint keys from different render windows', () => {
    const all: FixtureMessage[] = [
      { id: '1705314600000', author: 'Alice', time: '2024-01-15T10:30:00Z', paragraphs: ['a'] },
      { id: null, time: null, paragraphs: ['no id one'] },
      { id: null, author: 'Bob', time: null, paragraphs: ['no id two'] },
      { id: '1705314640000', author: 'Carol', time: '2024-01-15T10:30:40Z', paragraphs: ['b'] },
      { id: null, author: 'Dan', time: '2024-01-15T10:30:50Z', paragraphs: ['strong fingerprint'] },
      { id: '1705314660000', author: 'Erin', time: '2024-01-15T10:31:00Z', paragraphs: ['c'] },
    ];
    const windowA = parse(all.slice(0, 5));
    const windowB = parse(all.slice(1, 6));
    const keysA = new Map(windowA.map((m) => [m.text, m.key]));
    const keysB = new Map(windowB.map((m) => [m.text, m.key]));
    for (const text of ['no id one', 'no id two', 'strong fingerprint']) expect(keysB.get(text)).toBe(keysA.get(text));
    expect(windowB.find((m) => m.text === 'strong fingerprint')?.fingerprintStrong).toBe(true);
  });

  it('gives messages without id or timestamp the same key in every window and lists the alternative', () => {
    const fixtures: FixtureMessage[] = [
      { id: '1705314600000', author: 'Alice', time: '2024-01-15T10:30:00Z', paragraphs: ['before'] },
      { id: null, time: null, paragraphs: ['weak'] },
      { id: '1705314660000', author: 'Bob', time: '2024-01-15T10:31:00Z', paragraphs: ['after'] },
    ];
    const weak = (window: FixtureMessage[]) => parse(window).find((m) => m.text === 'weak') as ExtractedMessage;
    const both = weak(fixtures);
    const newerOnly = weak(fixtures.slice(1));
    const olderOnly = weak(fixtures.slice(0, 2));
    expect(both.key).toBe(newerOnly.key);
    expect(both.alternateKeys).toEqual([olderOnly.key]);
    expect(olderOnly.key).not.toBe(newerOnly.key);
    expect(newerOnly.alternateKeys).toEqual([]);
    expect(parse(fixtures).filter((m) => m.text !== 'weak').every((m) => m.alternateKeys.length === 0)).toBe(true);
  });

  it('links messages shown without an author to the message they continue', () => {
    const result = parseResult([
      { id: '1705314600000', author: 'Alice', time: '2024-01-15T10:30:00Z', paragraphs: ['a1'] },
      { id: '1705314610000', time: '2024-01-15T10:30:10Z', paragraphs: ['a2'] },
      { id: '1705314620000', self: true, time: '2024-01-15T10:30:20Z', paragraphs: ['mine'] },
      { id: '1705314630000', time: '2024-01-15T10:30:30Z', paragraphs: ['after self'] },
      { id: '1705314640000', author: 'Bob', time: '2024-01-15T10:30:40Z', paragraphs: ['b1'] },
      { divider: 'Today' },
      { id: '1705400000000', time: '2024-01-16T10:13:20Z', paragraphs: ['after divider'] },
      { system: 'Carol joined the chat.' },
      { id: '1705400060000', time: '2024-01-16T10:14:20Z', paragraphs: ['after system'] },
    ]);
    const key = (text: string) => result.messages.find((m) => m.text === text)?.key;
    expect(result.groupLinks).toEqual([{ previous: key('a1'), next: key('a2') }]);
  });

  it('keeps only the first copy when Teams renders the same id twice', () => {
    const messages = parse([
      { id: '1705314600000', author: 'Alice', time: '2024-01-15T10:30:00Z', paragraphs: ['a'] },
      { id: '1705314600000', author: 'Alice', time: '2024-01-15T10:30:00Z', paragraphs: ['a'] },
    ]);
    expect(messages).toHaveLength(1);
  });

  it('resolves reply keys from quoted message ids', () => {
    const messages = parse([
      { id: '1705314600000', author: 'Alice', time: '2024-01-15T10:30:00Z', paragraphs: ['Question?'] },
      { id: '1705314660000', author: 'Bob', time: '2024-01-15T10:31:00Z', reply: { id: '1705314600000', author: 'Alice', preview: 'Question?' }, paragraphs: ['Answer.'] },
    ]);
    expect(messages[1]?.replyTo?.resolvedKey).toBe(messages[0]?.key);
  });

  it('reports the displayed images with the attachment each belongs to', () => {
    const result = parseResult([
      {
        id: '1705314600000',
        author: 'Alice',
        time: '2024-01-15T10:30:00Z',
        html: '<p>Look <img src="https://x/inline.png" alt="inline.png"> <img itemtype="http://schema.skype.com/Emoji" src="https://x/emoji.png" alt="🙂"></p>',
        attachments: [
          { name: 'plan.pdf', url: 'https://x/plan.pdf' },
          { name: 'image', kind: 'image', url: 'https://x/1.png' },
          { name: 'image', kind: 'image', url: 'https://x/2.png' },
        ],
      },
      { id: '1705314660000', author: 'Bob', time: '2024-01-15T10:31:00Z', paragraphs: ['Nothing to see'] },
    ]);
    const [first] = result.messages;
    expect(first?.attachments.map((attachment) => `${attachment.kind}:${attachment.name}`)).toEqual(['file:plan.pdf', 'image:image', 'image:image', 'image:inline.png']);
    expect(result.images.map((image) => ({ key: image.messageKey, index: image.attachmentIndex, src: image.element.getAttribute('src') }))).toEqual([
      { key: first?.key, index: 1, src: 'https://x/1.png' },
      { key: first?.key, index: 2, src: 'https://x/2.png' },
      { key: first?.key, index: 3, src: 'https://x/inline.png' },
    ]);
    // Emoji stay text and are never treated as images.
    expect(first?.text).toContain('🙂');
  });

  it('parses a large rendered list quickly', () => {
    const fixtures: FixtureMessage[] = Array.from({ length: 2000 }, (_, i) => ({
      id: String(1705314600000 + i * 1000),
      author: i % 3 === 0 ? `User ${i % 7}` : undefined,
      time: new Date(1705314600000 + i * 1000).toISOString(),
      paragraphs: [`Message ${i}`, 'Second paragraph'],
    }));
    const started = performance.now();
    const messages = parse(fixtures);
    const elapsed = performance.now() - started;
    expect(messages).toHaveLength(2000);
    expect(new Set(messages.map((m) => m.key)).size).toBe(2000);
    expect(elapsed).toBeLessThan(15000);
  });
});
