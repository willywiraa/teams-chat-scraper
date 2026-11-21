import { describe, expect, it } from 'vitest';
import { capturePlan, DAY_MS, localDayStart, updateAnchor, updateStart } from '../../src/shared/capture';
import { DEFAULT_SETTINGS, normalizeSettings } from '../../src/shared/settings';
import type { LastUpdate } from '../../src/shared/types';
import { cleanLastUpdate, laterUpdate } from '../../src/storage/conversation-identity';
import { caughtUp } from '../../src/storage/coverage';

const NOW = Date.UTC(2026, 10, 21, 12, 0, 0);

describe('capture choices', () => {
  it('turns each choice into a run', () => {
    expect(capturePlan('update', NOW)).toEqual({ mode: 'incremental', rangeStart: null });
    expect(capturePlan('everything', NOW)).toEqual({ mode: 'full', rangeStart: null });
    expect(capturePlan('last-24h', NOW)).toEqual({ mode: 'full', rangeStart: NOW - DAY_MS });
    expect(capturePlan('last-7d', NOW)).toEqual({ mode: 'full', rangeStart: NOW - 7 * DAY_MS });
    expect(capturePlan('last-30d', NOW)).toEqual({ mode: 'full', rangeStart: NOW - 30 * DAY_MS });
  });

  it('starts "from a date" at local midnight, and refuses dates that are invalid or in the future', () => {
    expect(capturePlan('from-date', NOW, '2026-11-02')).toEqual({ mode: 'full', rangeStart: new Date(2026, 10, 2).getTime() });
    expect(localDayStart('2026-11-02')).toBe(new Date(2026, 10, 2, 0, 0, 0, 0).getTime());
    expect(capturePlan('from-date', NOW, '')).toBeNull();
    expect(capturePlan('from-date', NOW, null)).toBeNull();
    expect(capturePlan('from-date', NOW, '2026-02-31')).toBeNull();
    expect(capturePlan('from-date', NOW, '02/11/2026')).toBeNull();
    expect(capturePlan('from-date', NOW, '2027-01-01')).toBeNull();
  });
});

describe('updates', () => {
  const update = (newestSortKey: number, at = '2026-11-20T10:00:00.000Z', sessionId = 's1'): LastUpdate => ({ sessionId, mode: 'incremental', at, newestSortKey });

  it('continue from the last update, else from the newest archived message', () => {
    expect(updateAnchor({ lastUpdate: update(5_000), newestSortKey: 9_000 })).toBe(5_000);
    expect(updateAnchor({ lastUpdate: null, newestSortKey: 9_000 })).toBe(9_000);
    expect(updateAnchor({ newestSortKey: null })).toBeNull();
    expect(updateAnchor(null)).toBeNull();
  });

  it('re-read the overlap window before that point, 0 to 30 days', () => {
    expect(updateStart(NOW, 2)).toBe(NOW - 2 * DAY_MS);
    expect(updateStart(NOW, 0)).toBe(NOW);
    expect(updateStart(NOW, 90)).toBe(NOW - 30 * DAY_MS);
    expect(updateStart(NOW, -1)).toBe(NOW);
    expect(updateStart(null, 2)).toBeNull();
  });

  it('bring the archive up to date only when it is gap-free from the previous update to the newest message reached', () => {
    const ranges = [
      { oldest: 100, newest: 400, reachedBeginning: false },
      { oldest: 600, newest: 900, reachedBeginning: false },
    ];
    expect(caughtUp(ranges, 900, 700)).toBe(true);
    expect(caughtUp(ranges, 900, 600)).toBe(true);
    // The previous update is before a gap: the stretch reached does not join it.
    expect(caughtUp(ranges, 900, 300)).toBe(false);
    expect(caughtUp(ranges, 400, 300)).toBe(true);
    // Nothing was archived before: any gap-free stretch counts.
    expect(caughtUp(ranges, 900, null)).toBe(true);
    // Reaching the beginning of the chat counts as well.
    expect(caughtUp([{ oldest: 50, newest: 900, reachedBeginning: true }], 900, 20)).toBe(true);
    // A run that did not get past the previous update, or reached nothing archived.
    expect(caughtUp(ranges, 700, 800)).toBe(false);
    expect(caughtUp(ranges, 500, null)).toBe(false);
    expect(caughtUp(ranges, null, null)).toBe(false);
  });

  it('keep the one that reached the newer message when entries are merged or imported', () => {
    const early = update(5_000, '2026-11-01T10:00:00.000Z', 'early');
    const late = update(9_000, '2026-11-10T10:00:00.000Z', 'late');
    expect(laterUpdate(early, late)).toEqual(late);
    expect(laterUpdate(late, early)).toEqual(late);
    expect(laterUpdate(null, early)).toEqual(early);
    expect(laterUpdate(undefined, undefined)).toBeNull();
    const again = update(9_000, '2026-11-12T10:00:00.000Z', 'again');
    expect(laterUpdate(late, again)).toEqual(again);
  });

  it('read a last update from an export only when it is well-formed', () => {
    expect(cleanLastUpdate({ sessionId: 's', mode: 'full', at: '2026-11-01T00:00:00.000Z', newestSortKey: 1 })).toEqual({
      sessionId: 's',
      mode: 'full',
      at: '2026-11-01T00:00:00.000Z',
      newestSortKey: 1,
    });
    expect(cleanLastUpdate({ sessionId: 's', at: '2026-11-01T00:00:00.000Z', newestSortKey: 1, extra: true })).toMatchObject({ mode: 'full' });
    expect(cleanLastUpdate({ sessionId: 's', mode: 'full', at: '2026-11-01T00:00:00.000Z', newestSortKey: Number.NaN })).toBeNull();
    expect(cleanLastUpdate({ sessionId: 1, mode: 'full', at: 'x', newestSortKey: 1 })).toBeNull();
    expect(cleanLastUpdate('2026-11-01')).toBeNull();
    expect(cleanLastUpdate(null)).toBeNull();
  });
});

describe('update overlap setting', () => {
  it('defaults to 2 days and keeps whole days from 0 to 30', () => {
    expect(DEFAULT_SETTINGS.updateOverlapDays).toBe(2);
    expect(normalizeSettings({}).updateOverlapDays).toBe(2);
    expect(normalizeSettings({ updateOverlapDays: 0 }).updateOverlapDays).toBe(0);
    expect(normalizeSettings({ updateOverlapDays: '7' }).updateOverlapDays).toBe(7);
    expect(normalizeSettings({ updateOverlapDays: 2.6 }).updateOverlapDays).toBe(3);
    expect(normalizeSettings({ updateOverlapDays: 45 }).updateOverlapDays).toBe(30);
    expect(normalizeSettings({ updateOverlapDays: -3 }).updateOverlapDays).toBe(0);
    expect(normalizeSettings({ updateOverlapDays: 'soon' }).updateOverlapDays).toBe(2);
  });
});
