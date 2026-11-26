/**
 * What the archive page and the popup show, worked out without a page: routes, the conversation
 * list's search, filter and sorting, summary lines, the archive's totals, the message view and
 * its pages; the backup line; the scrolling speed presets; the theme choice; the popup's run
 * progress; the save form's formats, lines and fixed content; and repeated clicks.
 */
import { describe, expect, it, vi } from 'vitest';
import { FULL_CONTENT, SAVE_FORMATS, type SaveChoices } from '../../src/export/options';
import { timeFormat } from '../../src/export/render';
import {
  DEFAULT_SETTINGS,
  normalizeSettings,
  SETTING_LIMITS,
  settingsForStorage,
  SPEED_KEYS,
  SPEED_PRESETS,
  speedOf,
  withSpeed,
  type ScrollSpeed,
} from '../../src/shared/settings';
import type { ConversationRecord } from '../../src/shared/types';
import { guarded, type AppContext } from '../../src/ui/archive/context';
import { countOf, formatDateTime, formatDay, formatDayTime, formatNumber } from '../../src/ui/common';
import { parseLastBackup } from '../../src/ui/last-backup';
import { parseLastSave } from '../../src/ui/last-save';
import { CONTENT_FIELDS, fileNoun, fileShortName, FORMAT_NAMES, formatLine, SAVE_CHOICES_KEY, SaveForm, SHORT_FORMAT_NAMES } from '../../src/ui/save-form';
import { applyTheme, nextTheme, normalizeTheme, readTheme, saveTheme, THEME_STORAGE_KEY, themeLabel } from '../../src/ui/theme';
import {
  archiveTotals,
  archivedPeriod,
  backupLine,
  conversationDetails,
  earlierPage,
  filterConversations,
  historyExtent,
  historyLabel,
  historyLine,
  historySummary,
  messageView,
  parseRoute,
  pictureBox,
  reachShare,
  routeHash,
  timeline,
  updatedText,
  type Route,
} from '../../src/ui/view-models';
import { memoryReader } from '../helpers/export';
import { at, exportFixture, FIXTURE_NOW } from '../helpers/export-fixture';


function record(overrides: Partial<ConversationRecord> = {}): ConversationRecord {
  const key = overrides.conversationKey ?? 'teams:19:alpha@thread.v2';
  return {
    conversationKey: key,
    threadId: null,
    title: 'Project Alpha',
    type: 'group',
    keySource: 'dom',
    typeSource: 'thread-id',
    participants: [],
    messageCount: 10,
    oldestSortKey: at(1, 9, 0),
    newestSortKey: at(20, 9, 0),
    coverage: [{ oldest: at(1, 9, 0), newest: at(20, 9, 0), reachedBeginning: true }],
    firstExtractedAt: '2024-01-20T10:00:00.000Z',
    lastExtractedAt: '2024-01-20T10:00:00.000Z',
    lastSessionId: 's1',
    schemaVersion: 3,
    aliases: [],
    mergedFrom: [],
    mergedInto: null,
    titleHistory: [],
    displayName: null,
    lastUpdate: null,
    ...overrides,
  };
}

// ------------------------------------------------------------------ routes

describe('routes of the archive page', () => {
  it('round-trip through the address', () => {
    const routes: Route[] = [
      { view: 'home', section: 'conversations' },
      { view: 'home', section: 'backup' },
      { view: 'home', section: 'settings' },
      { view: 'home', section: 'advanced' },
      { view: 'conversation', key: 'teams:19:abc@thread.v2' },
      { view: 'conversation', key: 'title:design review/2 #1' },
    ];
    for (const route of routes) expect(parseRoute(routeHash(route))).toEqual(route);
    expect(routeHash({ view: 'conversation', key: 'title:a/b' })).toBe('#conversation/title%3Aa%2Fb');
    expect(routeHash({ view: 'home', section: null })).toBe('#conversations');
    expect(routeHash({ view: 'home', section: 'advanced' })).toBe('#settings/advanced');
  });

  it('show the page for an empty or unknown address, and the list for a conversation without key', () => {
    expect(parseRoute('')).toEqual({ view: 'home', section: null });
    expect(parseRoute('#')).toEqual({ view: 'home', section: null });
    expect(parseRoute('#nonsense')).toEqual({ view: 'home', section: null });
    expect(parseRoute('#conversation/')).toEqual({ view: 'home', section: 'conversations' });
    expect(parseRoute('#conversation/%E0%A4%A')).toEqual({ view: 'home', section: 'conversations' });
  });

  it('lead the addresses of the earlier sections to their place on the page', () => {
    expect(parseRoute('#overview')).toEqual({ view: 'home', section: 'backup' });
    expect(parseRoute('#export')).toEqual({ view: 'home', section: 'backup' });
    expect(parseRoute('#export/title%3Aa%2Fb')).toEqual({ view: 'conversation', key: 'title:a/b' });
    expect(parseRoute('#export/%E0%A4%A')).toEqual({ view: 'home', section: 'backup' });
    expect(parseRoute('#settings/storage')).toEqual({ view: 'home', section: 'settings' });
    expect(parseRoute('#settings/troubleshooting/42')).toEqual({ view: 'home', section: 'settings' });
    expect(parseRoute('#settings/advanced')).toEqual({ view: 'home', section: 'advanced' });
  });
});

describe('conversation list', () => {
  const alpha = record({ conversationKey: 'teams:19:alpha', title: 'Project Alpha', messageCount: 50, lastExtractedAt: '2024-01-10T00:00:00.000Z' });
  const design = record({
    conversationKey: 'title:design review',
    title: 'Design review',
    type: 'meeting',
    messageCount: 5,
    lastExtractedAt: '2024-01-01T00:00:00.000Z',
    lastUpdate: { sessionId: 's2', mode: 'incremental', at: '2024-01-15T00:00:00.000Z', newestSortKey: at(15, 0, 0) },
    titleHistory: [{ title: 'UX sync', firstSeenAt: '2023-12-01T00:00:00.000Z', lastSeenAt: '2023-12-20T00:00:00.000Z' }],
  });
  const bob = record({ conversationKey: 'teams:19:bob', title: 'Bob Brown', type: 'one-on-one', displayName: 'Bob (old team)', messageCount: 50, lastExtractedAt: '2024-01-05T00:00:00.000Z', aliases: ['title:bob brown'] });
  const all = [alpha, design, bob];

  it('finds a chat by any word of its names, earlier titles, keys and other names', () => {
    const keys = (query: string) => filterConversations(all, { query }).map((r) => r.conversationKey);
    expect(keys('alpha')).toEqual(['teams:19:alpha']);
    expect(keys('ux')).toEqual(['title:design review']);
    expect(keys('OLD  team')).toEqual(['teams:19:bob']);
    expect(keys('title:bob')).toEqual(['teams:19:bob']);
    expect(keys('review sync')).toEqual(['title:design review']);
    expect(keys('review alpha')).toEqual([]);
    expect(keys('   ')).toHaveLength(3);
  });

  it('filters by type', () => {
    expect(filterConversations(all, { type: 'meeting' })).toEqual([design]);
    expect(filterConversations(all, { type: 'channel' })).toEqual([]);
    expect(filterConversations(all, { type: 'all' })).toHaveLength(3);
  });

  it('sorts by the last activity (an update counts), by name, or by size with the name breaking ties', () => {
    expect(filterConversations(all, { sort: 'recent' })).toEqual([design, alpha, bob]);
    expect(filterConversations(all, { sort: 'name' })).toEqual([bob, design, alpha]);
    expect(filterConversations(all, { sort: 'messages' })).toEqual([bob, alpha, design]);
  });

  it('does not reorder the records it was given', () => {
    const given = [...all];
    filterConversations(given, { sort: 'name' });
    expect(given).toEqual(all);
  });

  it('tells what else a chat was called', () => {
    expect(conversationDetails(design)).toBe('Earlier: UX sync');
    expect(conversationDetails(bob)).toBe('In Teams: Bob Brown');
    expect(conversationDetails(alpha)).toBe('');
    expect(conversationDetails(record({ mergedInto: 'teams:19:other' }))).toBe('Being merged into another conversation');
  });
});

// ----------------------------------------------------------- summary lines

describe('summary lines', () => {
  const now = Date.parse('2024-01-23T10:00:00.000Z');

  it('say how much is archived and when it was updated, then the period and how much of the history that is', () => {
    const complete = record({ messageCount: 1234, lastUpdate: { sessionId: 's', mode: 'incremental', at: '2024-01-20T10:00:00.000Z', newestSortKey: at(20, 9, 0) } });
    const period = archivedPeriod(complete);
    expect(historySummary(complete, now)).toBe(`${formatNumber(1234)} messages · updated 3 days ago`);
    expect(historyExtent(complete)).toBe(`${period} · complete history`);
    expect(historyLine(complete, now)).toBe(`${formatNumber(1234)} messages · ${period} · complete history · updated 3 days ago`);
    expect(historyLabel(complete)).toBe('Complete');
  });

  it('call a history not back to the start partial, and give the last run when nothing brought it up to date', () => {
    const partial = record({ messageCount: 1, coverage: [{ oldest: at(10, 9, 0), newest: at(20, 9, 0), reachedBeginning: false }], oldestSortKey: at(10, 9, 0) });
    expect(historyLabel(partial)).toBe('Partial');
    expect(updatedText(partial, now)).toBe('last run 3 days ago');
    expect(historySummary(partial, now)).toBe('1 message · last run 3 days ago');
    expect(historyExtent(partial)).toBe(`${archivedPeriod(partial)} · partial history`);
  });

  it('use the same words in the list and the summary lines when no capture covered a stretch', () => {
    const unchecked = record({ messageCount: 2, coverage: [] });
    expect(historyLabel(unchecked)).toBe('Not checked');
    expect(historyExtent(unchecked)).toBe(`${archivedPeriod(unchecked)} · history not checked`);
  });

  it('write the period with a shared month and year once, and one day as one date', () => {
    // en-GB puts thin spaces around the dash.
    const range = (from: number, to: number) => archivedPeriod({ oldestSortKey: from, newestSortKey: to }, 'en-GB').replace(/\u2009/g, ' ');
    expect(range(at(10, 9, 0), at(20, 9, 0))).toBe('10 – 20 Jan 2024');
    expect(range(at(3, 9, 0), Date.UTC(2024, 2, 5, 9))).toBe('3 Jan – 5 Mar 2024');
    expect(range(Date.UTC(2023, 0, 3, 9), Date.UTC(2024, 2, 5, 9))).toBe('3 Jan 2023 – 5 Mar 2024');
    expect(range(at(5, 9, 0), at(5, 10, 0))).toBe('5 Jan 2024');
    expect(archivedPeriod(record({ oldestSortKey: null, newestSortKey: null }))).toBe('');
  });

  it('say "Not archived yet" for a chat without messages, with no period under it', () => {
    const empty = record({ messageCount: 0, oldestSortKey: null, newestSortKey: null, coverage: [] });
    expect(historySummary(null, now)).toBe('Not archived yet');
    expect(historySummary(empty, now)).toBe('Not archived yet');
    expect(historyExtent(empty)).toBe('');
    expect(historyLine(null, now)).toBe('Not archived yet');
    expect(historyLine(empty, now)).toBe('Not archived yet');
  });

  it('add up the archive’s totals', () => {
    const partial = record({ coverage: [{ oldest: at(10, 9, 0), newest: at(20, 9, 0), reachedBeginning: false }] });
    const empty = record({ messageCount: 0, oldestSortKey: null, newestSortKey: null, coverage: [] });
    expect(archiveTotals([record(), partial, empty], [3, 0])).toEqual({ conversations: 3, messages: 20, images: 3, complete: 1, partial: 1 });
    expect(archiveTotals([], [])).toEqual({ conversations: 0, messages: 0, images: 0, complete: 0, partial: 0 });
  });
});

// ------------------------------------------------------------ message view

describe('message view', () => {
  const time = timeFormat('UTC', 'en-GB');

  it('puts a day heading before the first message of each day', async () => {
    const { messages } = await exportFixture();
    const items = timeline(messages, time);
    expect(items.map((item) => item.kind)).toEqual(['day', 'message', 'message', 'message', 'message', 'day', 'message']);
    const days = items.filter((item) => item.kind === 'day').map((item) => (item.kind === 'day' ? item.label : ''));
    expect(new Set(days).size).toBe(2);
    expect(days[0]).toMatch(/15/);
    expect(days[1]).toMatch(/16/);
  });

  it('shows replies, pictures in place, other attachments, edits and earlier versions', async () => {
    const { messages, photoId } = await exportFixture();
    const items = timeline(messages, time);
    const views = items.flatMap((item) => (item.kind === 'message' ? [item.message] : []));
    const [first, joined, edited, formula, nextDay] = views;
    expect(first?.sender).toBe('Alice Andersen');
    expect(first?.text).toContain('<b>the</b>');
    expect(joined?.system).toBe(true);
    expect(edited).toMatchObject({
      sender: 'Bob Brown',
      edited: true,
      deleted: false,
      // The reply only named its target by key: the target is among the messages.
      reply: { who: 'Alice Andersen', text: '# Agenda' },
      pictures: [{ imageId: photoId, name: 'image' }],
      attachments: [
        { label: 'File', name: 'agenda_v2.docx', href: 'https://example.invalid/agenda_v2.docx' },
        // Not a web link, so not a link.
        { label: 'Picture not saved', name: 'lost.png', href: null },
      ],
      history: [{ replaced: time.dateTime('2024-01-15T09:12:00.000Z'), text: 'Looks fine' }],
      reactions: '👍 2 · 🎉 1 (yours: 👍)',
    });
    expect(first?.reactions).toBe('');
    expect(formula?.pictures).toHaveLength(2);
    expect(formula?.attachments).toEqual([]);
    expect(nextDay).toMatchObject({ self: true, sender: 'Me' });
    expect(edited?.time).toMatch(/09:10/);
  });

  it('shows the sender once for a run of their messages within five minutes', async () => {
    const { messages } = await exportFixture();
    const alice = messages[0]!;
    const copy = (key: string, timestamp: string, name = 'Alice Andersen') => ({ ...alice, key, timestamp, sender: { ...alice.sender, name } });
    const run = [
      copy('a1', '2024-01-15T09:00:00.000Z'),
      copy('a2', '2024-01-15T09:04:00.000Z'),
      copy('a3', '2024-01-15T09:20:00.000Z'),
      copy('b1', '2024-01-15T09:21:00.000Z', 'Bob Brown'),
      copy('b2', '2024-01-15T09:22:00.000Z', 'Bob Brown'),
    ];
    const continued = timeline(run, time).flatMap((item) => (item.kind === 'message' ? [item.continued] : []));
    expect(continued).toEqual([false, true, false, false, true]);
    // A system message between two messages of one sender ends the run.
    const { messages: fixture } = await exportFixture();
    const items = timeline(fixture, time).flatMap((item) => (item.kind === 'message' ? [item] : []));
    expect(items.filter((item) => item.message.system).every((item) => !item.continued)).toBe(true);
  });

  it('names a reply target it cannot see vaguely', async () => {
    const { messages } = await exportFixture();
    expect(messageView(messages[2]!, time).reply).toEqual({ who: 'an earlier message', text: '' });
  });

  it('pages back through the keys, newest page first', () => {
    const keys = Array.from({ length: 450 }, (_, i) => `k${i}`);
    const newest = earlierPage(keys, keys.length, 200);
    expect(newest.from).toBe(250);
    expect(newest.keys).toEqual(keys.slice(250));
    const middle = earlierPage(keys, newest.from, 200);
    expect(middle).toEqual({ keys: keys.slice(50, 250), from: 50 });
    const oldest = earlierPage(keys, middle.from, 200);
    expect(oldest).toEqual({ keys: keys.slice(0, 50), from: 0 });
    expect(earlierPage(keys, 0, 200)).toEqual({ keys: [], from: 0 });
    expect(earlierPage([], 0, 200)).toEqual({ keys: [], from: 0 });
  });

  it('reserves each picture\'s space: its own size scaled to fit, or nothing when not recorded', () => {
    expect(pictureBox(1920, 1080)).toEqual({ width: 420, height: 236 });
    expect(pictureBox(600, 1200)).toEqual({ width: 160, height: 320 });
    expect(pictureBox(40, 30)).toEqual({ width: 40, height: 30 });
    expect(pictureBox(null, 300)).toBeNull();
    expect(pictureBox(0, 0)).toBeNull();
  });

  it('counts in the singular for one', () => {
    expect(countOf(1, 'message')).toBe('1 message');
    expect(countOf(0, 'message')).toBe('0 messages');
    expect(countOf(1234, 'saved image')).toBe(`${formatNumber(1234)} saved images`);
  });
});

// ------------------------------------------------------------------ backup

describe('last full backup', () => {
  const now = Date.parse('2026-11-22T12:00:00Z');

  it('says when there is nothing to back up, or no backup yet', () => {
    expect(backupLine(null, 0, now)).toBe('Nothing to back up yet.');
    expect(backupLine(null, 2, now)).toBe('No full backup has been made from this browser profile yet.');
  });

  it('says how long ago the last one was made and what it held', () => {
    const at = '2026-11-19T12:00:00Z';
    const line = backupLine({ at, conversations: 1, messages: 452 }, 2, now);
    expect(line).toContain(`(${formatDateTime(at)})`);
    expect(line).toMatch(/^Last full backup .+: 1 conversation, 452 messages\.$/);
    // Older than 30 days: the date, said once.
    const old = '2026-09-01T12:00:00Z';
    expect(backupLine({ at: old, conversations: 2, messages: 1 }, 2, now)).toBe(`Last full backup on ${formatDateTime(old)}: 2 conversations, 1 message.`);
  });

  it('reads only a well-formed stored record', () => {
    expect(parseLastBackup({ at: '2026-11-19T12:00:00Z', conversations: 2, messages: 452 })).toEqual({ at: '2026-11-19T12:00:00Z', conversations: 2, messages: 452 });
    expect(parseLastBackup(undefined)).toBeNull();
    expect(parseLastBackup({ at: 'yesterday', conversations: 2, messages: 452 })).toBeNull();
    expect(parseLastBackup({ at: '2026-11-19T12:00:00Z', conversations: -1, messages: 452 })).toBeNull();
    expect(parseLastBackup({ at: '2026-11-19T12:00:00Z', conversations: 2 })).toBeNull();
  });
});

// ----------------------------------------------------------- repeated clicks

describe('button actions', () => {
  it('ignore a click while the same action is still running, then run again', async () => {
    const notify = vi.fn();
    const app = { notify } as unknown as AppContext;
    let release: () => void = () => undefined;
    const action = vi.fn(() => new Promise<void>((resolve) => (release = resolve)));
    const click = guarded(app, action);
    click();
    click();
    expect(action).toHaveBeenCalledTimes(1);
    release();
    await vi.waitFor(() => {
      click();
      expect(action).toHaveBeenCalledTimes(2);
    });
    expect(notify).not.toHaveBeenCalled();
  });

  it('show an action\'s error in the status line, and run again after it', async () => {
    const notify = vi.fn();
    const action = vi.fn(async () => {
      throw new Error('The archive could not be read');
    });
    const click = guarded({ notify } as unknown as AppContext, action);
    click();
    await vi.waitFor(() => expect(notify).toHaveBeenCalledWith('The archive could not be read', 'error'));
    await vi.waitFor(() => {
      click();
      expect(action).toHaveBeenCalledTimes(2);
    });
  });
});

// ----------------------------------------------------------- scroll speed

describe('scrolling speed presets', () => {
  it('describe the default settings as Normal', () => {
    expect(speedOf(DEFAULT_SETTINGS)).toBe('normal');
  });

  it('set every scrolling value, and are recognised again from the stored values', () => {
    for (const speed of Object.keys(SPEED_PRESETS) as ScrollSpeed[]) {
      const settings = withSpeed(DEFAULT_SETTINGS, speed);
      expect(speedOf(settings)).toBe(speed);
      // A preset survives being stored and read back.
      expect(speedOf(normalizeSettings(JSON.parse(JSON.stringify(settingsForStorage(settings)))))).toBe(speed);
      // Gentle is not an old default, so it survives even without the revision.
      expect(speedOf(normalizeSettings(JSON.parse(JSON.stringify(settings))))).toBe(speed);
      // Other settings are left alone.
      expect(settings.maxDurationMinutes).toBe(DEFAULT_SETTINGS.maxDurationMinutes);
    }
  });

  it('stay within the safety limits', () => {
    for (const values of Object.values(SPEED_PRESETS)) {
      for (const key of SPEED_KEYS) {
        const [min, max] = SETTING_LIMITS[key];
        expect(values[key], key).toBeGreaterThanOrEqual(min);
        expect(values[key], key).toBeLessThanOrEqual(max);
      }
      expect(values.scrollIntervalMs).toBeGreaterThanOrEqual(250);
    }
  });

  it('show Custom when one value differs from every preset', () => {
    expect(speedOf({ ...DEFAULT_SETTINGS, scrollIntervalMs: 700 })).toBe('custom');
    expect(speedOf({ ...withSpeed(DEFAULT_SETTINGS, 'fast'), settleTimeoutMs: 5001 })).toBe('custom');
  });

  it('keep "re-read by default" off unless it was turned on', () => {
    expect(normalizeSettings({}).rescanByDefault).toBe(false);
    expect(normalizeSettings({ rescanByDefault: 'yes' }).rescanByDefault).toBe(false);
    expect(normalizeSettings({ rescanByDefault: true }).rescanByDefault).toBe(true);
  });
});

// ------------------------------------------------------------------ theme

describe('theme', () => {
  function memoryStorage(): Storage {
    const values = new Map<string, string>();
    return {
      get length() {
        return values.size;
      },
      clear: () => values.clear(),
      getItem: (key) => values.get(key) ?? null,
      key: (i) => [...values.keys()][i] ?? null,
      removeItem: (key) => void values.delete(key),
      setItem: (key, value) => void values.set(key, String(value)),
    };
  }

  it('follows the system unless Light or Dark was chosen', () => {
    expect(normalizeTheme(undefined)).toBe('system');
    expect(normalizeTheme('purple')).toBe('system');
    expect(normalizeTheme('dark')).toBe('dark');
    expect(readTheme(memoryStorage())).toBe('system');
    expect(readTheme({ getItem: () => { throw new Error('blocked'); } })).toBe('system');
  });

  it('is stored and applied to the page at once', () => {
    const storage = memoryStorage();
    saveTheme('dark', storage);
    expect(storage.getItem(THEME_STORAGE_KEY)).toBe('dark');
    expect(readTheme(storage)).toBe('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
    saveTheme('system', storage);
    expect(document.documentElement.dataset.theme).toBeUndefined();
  });

  it('steps through Same as Windows, Light and Dark for the popup\'s theme button', () => {
    expect(nextTheme('system')).toBe('light');
    expect(nextTheme('light')).toBe('dark');
    expect(nextTheme('dark')).toBe('system');
    expect(themeLabel('system')).toBe('Same as Windows');
    expect(themeLabel('dark')).toBe('Dark');
  });

  it('sets data-theme only for an explicit choice', () => {
    const root = document.createElement('html');
    applyTheme('light', root);
    expect(root.getAttribute('data-theme')).toBe('light');
    applyTheme('system', root);
    expect(root.hasAttribute('data-theme')).toBe(false);
  });
});


// ------------------------------------------------------------ export panel

describe('run progress in the popup', () => {
  const start = '2026-11-23T12:00:00.000Z';
  const startMs = Date.parse(start);
  const DAY = 86_400_000;
  const back = (days: number) => new Date(startMs - days * DAY).toISOString();

  it('is the share of the way back to the start date that the run has reached', () => {
    expect(reachShare(start, startMs - 10 * DAY, back(4))).toBeCloseTo(0.4);
    expect(reachShare(start, startMs - 10 * DAY, null)).toBe(0);
    expect(reachShare(start, startMs - 10 * DAY, back(12))).toBe(1);
    expect(reachShare(start, startMs - 10 * DAY, back(-1))).toBe(0);
  });

  it('is unknown without a start date before the run started', () => {
    expect(reachShare(start, null, back(4))).toBeNull();
    expect(reachShare(start, undefined, back(4))).toBeNull();
    expect(reachShare(start, startMs, back(4))).toBeNull();
    expect(reachShare('not a date', startMs - DAY, back(4))).toBeNull();
  });

  it('writes the days in its lines short: the year only when it is not this one, and no time at midnight', () => {
    const now = new Date(2026, 10, 26, 10, 0).getTime();
    const morning = new Date(2026, 10, 22, 8, 47).getTime();
    const chosenDay = new Date(2026, 10, 21).getTime();
    const lastYear = new Date(2025, 10, 22, 8, 47).getTime();
    expect(formatDay(morning, now)).toBe(new Date(morning).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }));
    expect(formatDay(morning, now)).not.toContain('2026');
    expect(formatDay(lastYear, now)).toContain('2025');
    expect(formatDayTime(morning, now)).toBe(new Date(morning).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }));
    expect(formatDayTime(chosenDay, now)).toBe(formatDay(chosenDay, now));
    expect(formatDayTime(lastYear, now)).toContain('2025');
    expect(formatDay(null, now)).toBe('–');
    expect(formatDayTime('not a date', now)).toBe('–');
  });
});

describe('saving a file', () => {
  it('offers four formats, PDF first, each with a short name and a line saying what it makes', () => {
    expect(SAVE_FORMATS).toEqual(['pdf', 'text', 'json', 'package']);
    expect(SAVE_FORMATS.map((format) => FORMAT_NAMES[format])).toEqual(['PDF', 'Text', 'JSON', 'ZIP package']);
    for (const format of SAVE_FORMATS) expect(formatLine({ format, content: FULL_CONTENT }).length, format).toBeLessThanOrEqual(90);
    expect(formatLine({ format: 'pdf', content: FULL_CONTENT })).toBe('Opens the print dialog to save a PDF.');
    expect(formatLine({ format: 'text', content: FULL_CONTENT })).toMatch(/ZIP/);
    expect(formatLine({ format: 'text', content: { ...FULL_CONTENT, images: false } })).toBe('One plain-text file.');
  });

  it('names the file in the buttons that save it', () => {
    expect(fileNoun({ format: 'pdf', content: FULL_CONTENT })).toBe('a PDF');
    expect(fileNoun({ format: 'text', content: FULL_CONTENT })).toBe('the text and pictures (ZIP)');
    expect(fileNoun({ format: 'text', content: { ...FULL_CONTENT, images: false } })).toBe('a text file');
    expect(fileNoun({ format: 'json', content: FULL_CONTENT })).toBe('a JSON file');
    expect(fileNoun({ format: 'package', content: FULL_CONTENT })).toBe('a ZIP package');
  });

  it('names the file shorter in the popup, where the button reads "Capture new messages · save PDF"', () => {
    expect(fileShortName({ format: 'pdf', content: FULL_CONTENT })).toBe('PDF');
    expect(fileShortName({ format: 'text', content: FULL_CONTENT })).toBe('text (ZIP)');
    expect(fileShortName({ format: 'text', content: { ...FULL_CONTENT, images: false } })).toBe('text');
    expect(fileShortName({ format: 'json', content: FULL_CONTENT })).toBe('JSON');
    expect(fileShortName({ format: 'package', content: FULL_CONTENT })).toBe('ZIP');
    expect(SHORT_FORMAT_NAMES).toEqual({ ...FORMAT_NAMES, package: 'ZIP' });
  });

  it('keeps the content a format fixes ticked and disabled, with the note, and remembers the rest', () => {
    const stored: unknown[] = [];
    vi.stubGlobal('chrome', { storage: { local: { set: async (value: unknown) => void stored.push(value) } } });
    try {
      const root = document.createElement('div');
      document.body.append(root);
      const changes: SaveChoices[] = [];
      const form = new SaveForm(root, (choices) => changes.push(choices));
      form.set({ format: 'pdf', content: { ...FULL_CONTENT, attachments: false } });
      const box = (key: string) => root.querySelector<HTMLInputElement>(`#save-include-${key}`)!;
      const note = root.querySelector<HTMLElement>('[data-part="note"]')!;
      expect(CONTENT_FIELDS.map(({ label }) => label)).toEqual(['Pictures', 'File attachments', 'Reply context', 'Reactions', 'System messages', 'Edit history']);
      expect([box('attachments').checked, box('attachments').disabled, note.hidden]).toEqual([false, false, true]);

      root.querySelector<HTMLInputElement>('#save-format-json')!.click();
      expect([box('attachments').checked, box('attachments').disabled, note.hidden]).toEqual([true, true, false]);
      expect(root.querySelector('[data-part="line"]')!.textContent).toMatch(/Import archive/);
      // The fixed box does not change what was chosen for the other formats.
      expect(changes.at(-1)).toEqual({ format: 'json', content: { ...FULL_CONTENT, attachments: false } });
      expect(stored.at(-1)).toEqual({ [SAVE_CHOICES_KEY]: { format: 'json', content: { ...FULL_CONTENT, attachments: false } } });

      box('reactions').click();
      expect(form.value).toEqual({ format: 'json', content: { ...FULL_CONTENT, attachments: false, reactions: false } });

      // The popup redraws on "input", which comes before "change": the click still counts.
      const page = document.createElement('div');
      document.body.append(page);
      page.append(root);
      page.addEventListener('input', () => {
        form.setDisabled(true);
        form.setDisabled(false);
      });
      root.querySelector<HTMLLabelElement>('label[for="save-format-text"]')!.click();
      expect(form.value.format).toBe('text');
      expect(root.querySelector<HTMLInputElement>('#save-format-text')!.checked).toBe(true);
      page.remove();
      form.setDisabled(true);
      expect(root.querySelectorAll('input:not(:disabled)')).toHaveLength(0);
      root.remove();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('reads back what the save page did for a capture', () => {
    expect(parseLastSave({ sessionId: 's1', fileName: 'Design-review.txt', problem: null })).toEqual({ sessionId: 's1', fileName: 'Design-review.txt', problem: null });
    expect(parseLastSave({ sessionId: 's1' })).toEqual({ sessionId: 's1', fileName: null, problem: null });
    expect(parseLastSave({ fileName: 'x' })).toBeNull();
    expect(parseLastSave(null)).toBeNull();
  });
});
