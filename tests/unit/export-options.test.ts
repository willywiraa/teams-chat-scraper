/** The export model: periods, packagings, remembered choices, full backups and the save page's address. */
import { describe, expect, it } from 'vitest';
import { DAY_MS } from '../../src/shared/capture';
import {
  clipCoverage,
  DEFAULT_SAVE_CHOICES,
  effectiveContent,
  FULL_CONTENT,
  inRange,
  isFullBackup,
  normalizeSaveChoices,
  packagingOf,
  packagingsFor,
  parseSaveTarget,
  saveTargetHash,
  sessionSaveRange,
  type SaveTarget,
} from '../../src/export/options';
import { emptyCounters } from '../../src/shared/types';

const NOW = Date.UTC(2026, 10, 21, 12, 0);

describe('export periods', () => {
  it('keeps messages from the start (included) to the end (not included)', () => {
    const from = new Date(2026, 10, 1, 0, 0).getTime();
    const to = new Date(2026, 10, 8, 0, 0).getTime();
    expect(inRange({ sortKey: from }, { from, to })).toBe(true);
    expect(inRange({ sortKey: to - 1 }, { from, to })).toBe(true);
    expect(inRange({ sortKey: to }, { from, to })).toBe(false);
    expect(inRange({ sortKey: from - 1 }, { from, to })).toBe(false);
  });

  it('limits coverage to the period, keeping the beginning only when the period starts there', () => {
    const coverage = [
      { oldest: 100, newest: 200, reachedBeginning: true },
      { oldest: 300, newest: 400, reachedBeginning: false },
    ];
    expect(clipCoverage(coverage, { from: null, to: null })).toEqual(coverage);
    expect(clipCoverage(coverage, { from: 50, to: 350 })).toEqual([
      { oldest: 100, newest: 200, reachedBeginning: true },
      { oldest: 300, newest: 350, reachedBeginning: false },
    ]);
    expect(clipCoverage(coverage, { from: 150, to: null })).toEqual([
      { oldest: 150, newest: 200, reachedBeginning: false },
      { oldest: 300, newest: 400, reachedBeginning: false },
    ]);
    expect(clipCoverage(coverage, { from: 210, to: 290 })).toEqual([]);
  });

  it('saves the period a capture covered, the messages it found on screen, or everything archived', () => {
    const counters = { ...emptyCounters(), oldestSortKey: 1_000, newestSortKey: 2_000 };
    expect(sessionSaveRange({ mode: 'full', captureFrom: NOW - 7 * DAY_MS, counters })).toEqual({ from: NOW - 7 * DAY_MS, to: null });
    expect(sessionSaveRange({ mode: 'full', captureFrom: null, counters })).toEqual({ from: null, to: null });
    expect(sessionSaveRange({ mode: 'incremental', captureFrom: NOW - DAY_MS, counters })).toEqual({ from: null, to: null });
    expect(sessionSaveRange({ mode: 'visible', captureFrom: null, counters })).toEqual({ from: 1_000, to: 2_001 });
  });
});

describe('formats and packaging', () => {
  it('puts pictures in a ZIP for formats that can not hold them', () => {
    expect(packagingsFor('html', { images: true })).toEqual(['file', 'zip']);
    expect(packagingsFor('html', { images: false })).toEqual(['file']);
    for (const format of ['markdown', 'text'] as const) {
      expect(packagingsFor(format, { images: true })).toEqual(['zip']);
      expect(packagingsFor(format, { images: false })).toEqual(['file']);
    }
    expect(packagingsFor('json', { images: true })).toEqual(['file']);
    expect(packagingsFor('package', { images: false })).toEqual(['zip']);
    expect(packagingOf({ format: 'text', content: FULL_CONTENT })).toBe('zip');
    expect(packagingOf({ format: 'text', content: { ...FULL_CONTENT, images: false } })).toBe('file');
    expect(packagingOf({ format: 'pdf', content: FULL_CONTENT })).toBe('file');
  });

  it('always keeps attachments and replies in records', () => {
    const none = { images: false, attachments: false, replies: false, reactions: false, systemMessages: false, editHistory: false };
    expect(effectiveContent('json', none)).toEqual({ ...none, attachments: true, replies: true });
    expect(effectiveContent('package', none)).toEqual({ ...none, attachments: true, replies: true });
    expect(effectiveContent('text', none)).toEqual(none);
  });

  it('starts with a PDF, and repairs remembered choices', () => {
    expect(normalizeSaveChoices(undefined)).toEqual(DEFAULT_SAVE_CHOICES);
    expect(DEFAULT_SAVE_CHOICES.format).toBe('pdf');
    expect(normalizeSaveChoices({ format: 'json', content: { images: false } })).toEqual({ format: 'json', content: { ...FULL_CONTENT, images: false } });
    expect(normalizeSaveChoices({ format: 'nope', range: 'forever', from: 'x', content: { replies: 'yes', editHistory: false } })).toEqual({
      ...DEFAULT_SAVE_CHOICES,
      content: { ...FULL_CONTENT, editHistory: false },
    });
    // Formats no longer offered become PDF; the content chosen with them is kept.
    for (const format of ['html', 'markdown', 'csv']) {
      expect(normalizeSaveChoices({ format, packaging: 'zip', range: 'all', content: { systemMessages: false } })).toEqual({
        format: 'pdf',
        content: { ...FULL_CONTENT, systemMessages: false },
      });
    }
    // Choices remembered before reactions could be chosen include them.
    const older = { format: 'text', packaging: 'file', range: 'all', from: '', to: '', content: { images: true, attachments: true, replies: true, systemMessages: true, editHistory: true } };
    expect(normalizeSaveChoices(older).content.reactions).toBe(true);
    expect(normalizeSaveChoices({ ...older, content: { ...older.content, reactions: false } }).content.reactions).toBe(false);
  });
});

describe('full backups', () => {
  const archived = ['title:design review', 'title:alice andersen'];
  const backup = { conversations: archived, format: 'package' as const, range: { from: null, to: null }, content: { ...FULL_CONTENT } };

  it('counts an importable export of every chat, the whole period and all content', () => {
    expect(isFullBackup(backup, archived)).toBe(true);
    expect(isFullBackup({ ...backup, conversations: 'all' }, archived)).toBe(true);
    expect(isFullBackup({ ...backup, format: 'json' }, archived)).toBe(true);
    // Attachments and reply context are always kept in importable formats.
    expect(isFullBackup({ ...backup, content: { ...FULL_CONTENT, attachments: false, replies: false } }, archived)).toBe(true);
  });

  it('does not count part of the archive, a period, missing content or a format that cannot be imported', () => {
    expect(isFullBackup({ ...backup, conversations: archived.slice(0, 1) }, archived)).toBe(false);
    expect(isFullBackup({ ...backup, range: { from: NOW - DAY_MS, to: null } }, archived)).toBe(false);
    expect(isFullBackup({ ...backup, content: { ...FULL_CONTENT, systemMessages: false } }, archived)).toBe(false);
    expect(isFullBackup({ ...backup, content: { ...FULL_CONTENT, images: false } }, archived)).toBe(false);
    expect(isFullBackup({ ...backup, format: 'pdf' }, archived)).toBe(false);
    expect(isFullBackup({ ...backup, conversations: [] }, [])).toBe(false);
  });
});

describe('the save page’s address', () => {
  const choices = { format: 'text' as const, content: { ...FULL_CONTENT, reactions: false } };

  it('names a capture, a chat with its period, or every chat, and reads back what it names', () => {
    const targets: SaveTarget[] = [
      { kind: 'session', sessionId: 'abc-123' },
      { kind: 'conversation', conversationKey: 'teams:19:abc@thread.v2', choices, range: { from: NOW - DAY_MS, to: null } },
      { kind: 'conversation', conversationKey: 'title:design review', choices, range: { from: null, to: null } },
      { kind: 'all', choices: { format: 'package', content: FULL_CONTENT } },
    ];
    for (const target of targets) expect(parseSaveTarget(saveTargetHash(target))).toEqual(target);
    expect(saveTargetHash(targets[1]!)).toContain('chat=teams%3A19%3Aabc%40thread.v2');
  });

  it('names nothing without a capture, a chat or every chat, and repairs the rest', () => {
    expect(parseSaveTarget('')).toBeNull();
    expect(parseSaveTarget('#format=pdf')).toBeNull();
    expect(parseSaveTarget('#chat=x&format=csv&include=images,nope&from=soon')).toEqual({
      kind: 'conversation',
      conversationKey: 'x',
      choices: { format: 'pdf', content: { images: true, attachments: false, replies: false, reactions: false, systemMessages: false, editHistory: false } },
      range: { from: null, to: null },
    });
  });
});
