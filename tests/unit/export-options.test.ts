/** The export model: periods, packagings, presets and remembered choices. */
import { describe, expect, it } from 'vitest';
import { DAY_MS } from '../../src/shared/capture';
import {
  clipCoverage,
  DEFAULT_EXPORT_CHOICES,
  effectiveContent,
  FULL_CONTENT,
  inRange,
  isFullBackup,
  normalizeChoices,
  packagingsFor,
  parseLocalDateTime,
  presetChoices,
  rangeFor,
} from '../../src/export/options';

const NOW = Date.UTC(2026, 10, 21, 12, 0);

describe('export periods', () => {
  it('maps the period choices to message-time ranges', () => {
    expect(rangeFor({ range: 'all', from: '', to: '' }, NOW)).toEqual({ range: { from: null, to: null } });
    expect(rangeFor({ range: 'last-24h', from: '', to: '' }, NOW)).toEqual({ range: { from: NOW - DAY_MS, to: null } });
    expect(rangeFor({ range: 'last-7d', from: '', to: '' }, NOW)).toEqual({ range: { from: NOW - 7 * DAY_MS, to: null } });
    expect(rangeFor({ range: 'last-30d', from: '', to: '' }, NOW)).toEqual({ range: { from: NOW - 30 * DAY_MS, to: null } });
  });

  it('reads a custom period in local time, From included and Before not', () => {
    const from = new Date(2026, 10, 1, 0, 0).getTime();
    const to = new Date(2026, 10, 8, 0, 0).getTime();
    expect(rangeFor({ range: 'custom', from: '2026-11-01T00:00', to: '2026-11-08T00:00' }, NOW)).toEqual({ range: { from, to } });
    expect(rangeFor({ range: 'custom', from: '', to: '2026-11-08T00:00' }, NOW)).toEqual({ range: { from: null, to } });
    expect(inRange({ sortKey: from }, { from, to })).toBe(true);
    expect(inRange({ sortKey: to - 1 }, { from, to })).toBe(true);
    expect(inRange({ sortKey: to }, { from, to })).toBe(false);
    expect(inRange({ sortKey: from - 1 }, { from, to })).toBe(false);
  });

  it('explains a custom period it can not use', () => {
    expect(rangeFor({ range: 'custom', from: '', to: '' }, NOW)).toEqual({ error: expect.stringMatching(/Choose/) });
    expect(rangeFor({ range: 'custom', from: '2026-11-08T00:00', to: '2026-11-01T00:00' }, NOW)).toEqual({ error: expect.stringMatching(/earlier/) });
    expect(rangeFor({ range: 'custom', from: 'soon', to: '' }, NOW)).toEqual({ error: expect.stringMatching(/From/) });
    expect(parseLocalDateTime('2026-11-01')).toBe(new Date(2026, 10, 1).getTime());
    expect(parseLocalDateTime('11/01/2026')).toBeNull();
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
});

describe('formats and packaging', () => {
  it('puts pictures in a ZIP for formats that can not hold them', () => {
    expect(packagingsFor('html', { images: true })).toEqual(['file', 'zip']);
    expect(packagingsFor('html', { images: false })).toEqual(['file']);
    for (const format of ['markdown', 'text', 'csv'] as const) {
      expect(packagingsFor(format, { images: true })).toEqual(['zip']);
      expect(packagingsFor(format, { images: false })).toEqual(['file']);
    }
    expect(packagingsFor('json', { images: true })).toEqual(['file']);
    expect(packagingsFor('package', { images: false })).toEqual(['zip']);
  });

  it('always keeps attachments and replies in records', () => {
    const none = { images: false, attachments: false, replies: false, systemMessages: false, editHistory: false };
    expect(effectiveContent('json', none)).toEqual({ ...none, attachments: true, replies: true });
    expect(effectiveContent('package', none)).toEqual({ ...none, attachments: true, replies: true });
    expect(effectiveContent('csv', none)).toEqual(none);
  });

  it('offers the knowledge system and backup presets', () => {
    expect(presetChoices('knowledge')).toMatchObject({ format: 'package', packaging: 'zip', range: 'all', content: { ...FULL_CONTENT, systemMessages: false } });
    expect(presetChoices('backup')).toMatchObject({ format: 'package', content: FULL_CONTENT });
  });

  it('starts with an HTML page, and repairs remembered choices', () => {
    expect(normalizeChoices(undefined)).toEqual(DEFAULT_EXPORT_CHOICES);
    expect(DEFAULT_EXPORT_CHOICES.format).toBe('html');
    expect(normalizeChoices({ format: 'markdown', packaging: 'file', content: { images: true } })).toMatchObject({ format: 'markdown', packaging: 'zip' });
    expect(normalizeChoices({ format: 'nope', range: 'forever', from: 'x', content: { replies: 'yes', editHistory: false } })).toEqual({
      ...DEFAULT_EXPORT_CHOICES,
      content: { ...FULL_CONTENT, editHistory: false },
    });
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
    expect(isFullBackup({ ...backup, format: 'html' }, archived)).toBe(false);
    expect(isFullBackup({ ...backup, conversations: [] }, [])).toBe(false);
  });
});
