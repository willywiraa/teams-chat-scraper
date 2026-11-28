import { describe, expect, it } from 'vitest';
import { assignSortKeys, type AssignedSortKey } from '../../src/scraper/sort-keys';
import type { ExtractedMessage } from '../../src/shared/types';
import { coverageStatus, findRange, mergeAllCoverage, mergeCoverage, normalizeCoverage } from '../../src/storage/coverage';
import { message } from '../helpers/messages';

const known = (key: string, sortKey: number) => message({ id: null, key, sortKey, sortKeySource: 'timestamp' });
const unknown = (key: string) => message({ id: null, key, sortKey: null, sortKeySource: null });
const keys = (messages: ExtractedMessage[]) => messages.map((m) => [m.sortKey, m.sortKeySource]);

describe('assignSortKeys', () => {
  it('interpolates messages without time between their rendered neighbours', () => {
    const messages = [known('a', 1000), unknown('b'), unknown('c'), known('d', 4000)];
    assignSortKeys(messages, new Map(), 99_999);
    expect(keys(messages)).toEqual([
      [1000, 'timestamp'],
      [2000, 'interpolated'],
      [3000, 'interpolated'],
      [4000, 'timestamp'],
    ]);
  });

  it('places messages at the edge of the window right next to the known neighbour', () => {
    const top = [unknown('a'), unknown('b'), known('c', 5000)];
    assignSortKeys(top, new Map(), 0);
    expect(top[0]?.sortKey).toBeCloseTo(4999.98, 6);
    expect(top[1]?.sortKey).toBeCloseTo(4999.99, 6);
    expect(top[1]?.sortKeySource).toBe('interpolated');

    const bottom = [known('a', 5000), unknown('b')];
    assignSortKeys(bottom, new Map(), 0);
    expect(bottom[1]?.sortKey).toBeCloseTo(5000.01, 6);
  });

  it('keeps DOM order when neighbours are out of order', () => {
    const messages = [known('a', 5000), unknown('b'), known('c', 4000)];
    assignSortKeys(messages, new Map(), 0);
    expect(messages[1]?.sortKey).toBeCloseTo(5000.01, 6);
  });

  it('orders by observation when nothing about the times is known', () => {
    const messages = [unknown('a'), unknown('b'), unknown('c')];
    assignSortKeys(messages, new Map(), 10_000);
    expect(keys(messages)).toEqual([
      [8000, 'observed-order'],
      [9000, 'observed-order'],
      [10_000, 'observed-order'],
    ]);
  });

  it('keeps the first position assigned to a message during a session', () => {
    const session = new Map<string, AssignedSortKey>();
    assignSortKeys([known('a', 1000), unknown('b'), known('c', 3000)], session, 0);
    const later = [unknown('b'), known('c', 3000)];
    assignSortKeys(later, session, 0);
    expect(later[0]).toMatchObject({ sortKey: 2000, sortKeySource: 'interpolated' });
  });
});

describe('coverage ranges', () => {
  it('merges overlapping and touching ranges and keeps disjoint ones in order', () => {
    let ranges = mergeCoverage([], { oldest: 50, newest: 60, reachedBeginning: false });
    ranges = mergeCoverage(ranges, { oldest: 10, newest: 20, reachedBeginning: true });
    ranges = mergeCoverage(ranges, { oldest: 20, newest: 30, reachedBeginning: false });
    expect(ranges).toEqual([
      { oldest: 10, newest: 30, reachedBeginning: true },
      { oldest: 50, newest: 60, reachedBeginning: false },
    ]);
    expect(mergeCoverage(ranges, { oldest: 25, newest: 55, reachedBeginning: false })).toEqual([{ oldest: 10, newest: 60, reachedBeginning: true }]);
  });

  it('drops a beginning mark once older messages join its range', () => {
    // A run took a slow Teams for the beginning of the chat at 50; a later run found older messages.
    const marked = [{ oldest: 50, newest: 100, reachedBeginning: true }];
    expect(mergeCoverage(marked, { oldest: 20, newest: 60, reachedBeginning: false })).toEqual([{ oldest: 20, newest: 100, reachedBeginning: false }]);
    expect(mergeCoverage(marked, { oldest: 10, newest: 100, reachedBeginning: true })).toEqual([{ oldest: 10, newest: 100, reachedBeginning: true }]);
    // The same beginning, or a newer stretch joining it, keeps the mark.
    expect(mergeCoverage(marked, { oldest: 50, newest: 70, reachedBeginning: false })).toEqual(marked);
    expect(mergeCoverage(marked, { oldest: 90, newest: 120, reachedBeginning: false })).toEqual([{ oldest: 50, newest: 120, reachedBeginning: true }]);
    expect(normalizeCoverage([{ oldest: 50, newest: 100, reachedBeginning: true }, { oldest: 20, newest: 60, reachedBeginning: false }])).toEqual([
      { oldest: 20, newest: 100, reachedBeginning: false },
    ]);
  });

  it('ignores invalid ranges', () => {
    expect(mergeCoverage([], { oldest: 5, newest: 1, reachedBeginning: false })).toEqual([]);
    expect(mergeAllCoverage([{ oldest: Number.NaN, newest: 1, reachedBeginning: false }], [{ oldest: 1, newest: 2, reachedBeginning: false }])).toEqual([
      { oldest: 1, newest: 2, reachedBeginning: false },
    ]);
    expect(normalizeCoverage([{ oldest: 3, newest: 4, reachedBeginning: false }, { oldest: 1, newest: 3, reachedBeginning: false }])).toEqual([
      { oldest: 1, newest: 4, reachedBeginning: false },
    ]);
  });

  it('says whether the archived history is complete', () => {
    expect(coverageStatus([], null)).toBe('empty');
    expect(coverageStatus([{ oldest: 1, newest: 100, reachedBeginning: false }], 100)).toBe('partial');
    expect(coverageStatus([{ oldest: 1, newest: 100, reachedBeginning: true }], 100)).toBe('complete');
    // New messages were archived after a gap: the beginning is known, but not everything in between.
    expect(coverageStatus([{ oldest: 1, newest: 100, reachedBeginning: true }, { oldest: 200, newest: 300, reachedBeginning: false }], 300)).toBe('partial');
    expect(findRange([{ oldest: 1, newest: 100, reachedBeginning: true }], 50)?.oldest).toBe(1);
    expect(findRange([{ oldest: 1, newest: 100, reachedBeginning: true }], 150)).toBeNull();
  });
});
