/** The streaming reader for JSON exports: same values as JSON.parse, whatever the chunk boundaries. */
import { describe, expect, it } from 'vitest';
import { ArchiveJsonScanner, type ArchiveJsonEvent, type ScanOptions } from '../../src/export/json-scanner';

const archive = {
  format: 'teams-chat-archive',
  formatVersion: 1,
  exportedAt: '2024-02-01T10:20:30.456Z',
  generator: { name: 'x', nested: [1, [2, { three: '3' }]] },
  conversations: [
    {
      conversationKey: 'teams:19:a@thread.v2',
      title: 'Tricky "quotes" \\ backslashes ]} and {[ brackets',
      coverage: [{ oldest: 1, newest: 2.5, reachedBeginning: true }],
      messages: [
        { key: 'a#1', text: 'Line\nbreak, émoji 🎉,   separator, escaped \\" quote', n: -1.5e3, ok: true, none: null, list: [[], {}] },
        { key: 'a#2', text: '' },
      ],
      images: [{ imageId: 'f'.repeat(64), dataBase64: 'QUJD'.repeat(50) }],
      after: 'fields after the arrays',
    },
    { conversationKey: 'title:empty', messages: [] },
  ],
  trailing: { at: 'the end' },
};

function scan(text: string, chunk: number, options?: ScanOptions): ArchiveJsonEvent[] {
  const scanner = new ArchiveJsonScanner(options);
  const events: ArchiveJsonEvent[] = [];
  for (let i = 0; i < text.length; i += chunk) events.push(...scanner.feed(text.slice(i, i + chunk)));
  events.push(...scanner.end());
  return events;
}

/** Puts the archive back together from the events. */
function rebuild(events: ArchiveJsonEvent[]): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  const conversations: Array<Record<string, unknown>> = [];
  for (const event of events) {
    if (event.type === 'root') root[event.key] = event.value;
    else if (event.type === 'conversations') root.conversations = conversations;
    else if (event.type === 'conversation-start') conversations[event.index] = {};
    else if (event.type === 'field') (conversations[event.index] as Record<string, unknown>)[event.key] = event.value;
    else if (event.type === 'message' || event.type === 'image') {
      const conversation = conversations[event.index] as Record<string, unknown[]>;
      const list = (conversation[event.type === 'message' ? 'messages' : 'images'] ??= []);
      list[event.position] = event.value;
    } else if (event.type === 'conversation-end') {
      const conversation = conversations[event.index] as Record<string, unknown>;
      if (event.sawMessages) conversation.messages ??= [];
    }
  }
  return root;
}

describe('streaming JSON reader', () => {
  for (const [name, text] of [
    ['compact', JSON.stringify(archive)],
    ['indented', JSON.stringify(archive, null, 2)],
    ['with a byte order mark and CRLF', `﻿${JSON.stringify(archive, null, '\t').replace(/\n/g, '\r\n')}\r\n`],
  ] as const) {
    it(`reads ${name} JSON the same in chunks of any size`, () => {
      for (const chunk of [1, 2, 3, 7, 64, 1000, text.length]) {
        const rebuilt = rebuild(scan(text, chunk));
        expect(rebuilt).toEqual(archive);
        // Keys keep the conversation's order of appearance.
        expect(Object.keys(rebuilt.conversations as object[])).toEqual(['0', '1']);
      }
    });
  }

  it('counts messages and images it is told to pass over, without handing them over', () => {
    const events = scan(JSON.stringify(archive), 5, { skip: { messages: true, images: true } });
    expect(events.some((event) => event.type === 'message' || event.type === 'image')).toBe(false);
    expect(events.filter((event) => event.type === 'conversation-end')).toEqual([
      { type: 'conversation-end', index: 0, messages: 2, images: 1, sawMessages: true },
      { type: 'conversation-end', index: 1, messages: 0, images: 0, sawMessages: true },
    ]);
  });

  it('hands over messages and images that are not arrays as fields, for validation to reject', () => {
    const events = scan(JSON.stringify({ conversations: [{ conversationKey: 'k', messages: 'x', images: 5 }] }), 4);
    expect(events).toContainEqual({ type: 'field', index: 0, key: 'messages', value: 'x' });
    expect(events).toContainEqual({ type: 'field', index: 0, key: 'images', value: 5 });
    expect(events).toContainEqual({ type: 'conversation-end', index: 0, messages: 0, images: 0, sawMessages: false });
  });

  it('rejects what is not a complete archive object', () => {
    expect(() => scan('[1, 2]', 3)).toThrow(/Archive must be a JSON object/);
    expect(() => scan('', 3)).toThrow(/empty/);
    expect(() => scan(JSON.stringify(archive).slice(0, -5), 3)).toThrow(/ends early/);
    expect(() => scan(`${JSON.stringify(archive)} x`, 3)).toThrow(/after the end/);
    expect(() => scan('{"conversations": {}}', 3)).toThrow(/"conversations" must be an array/);
    expect(() => scan('{"conversations": [1]}', 3)).toThrow(/conversations\[0\] must be an object/);
    expect(() => scan('{"a" 1}', 2)).toThrow(/expected ":"/);
    expect(() => scan('{"a": 1 "b": 2}', 2)).toThrow(/expected "," or "}"/);
    expect(() => scan('{"conversations": [{"messages": [{"key": nope}]}]}', 4)).toThrow(/Not valid JSON/);
    expect(() => scan('{"a": tru}', 4)).toThrow(/Not valid JSON/);
  });
});
