/**
 * What the app page and the popup show, worked out without a page: routes, the conversation
 * list's search, filter and sorting, summary lines, overview totals, the message view and its
 * pages; the backup line; the scrolling speed presets; the theme choice; the popup's run progress;
 * the export panel's explanation, button, presets, file name and conversation lines; and repeated
 * clicks.
 */
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_EXPORT_CHOICES, EXPORT_FORMATS, FULL_CONTENT, normalizeChoices, packagingsFor, presetChoices } from '../../src/export/options';
import { runExport } from '../../src/export/pipeline';
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
import { countOf, formatDate, formatDateTime, formatNumber } from '../../src/ui/common';
import { conversationFacts, explainChoices, exportButtonLabel, FORMAT_TILES, plannedFileName, presetInUse } from '../../src/ui/export-panel';
import { parseLastBackup } from '../../src/ui/last-backup';
import { applyTheme, nextTheme, normalizeTheme, readTheme, saveTheme, THEME_STORAGE_KEY, themeLabel } from '../../src/ui/theme';
import {
  archivedPeriod,
  backupLine,
  conversationDetails,
  earlierPage,
  filterConversations,
  historyLabel,
  historyLine,
  latestActivity,
  messageView,
  navOf,
  overviewTotals,
  parseRoute,
  pictureBox,
  reachShare,
  routeHash,
  timeline,
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

describe('routes of the app page', () => {
  it('round-trip through the address', () => {
    const routes: Route[] = [
      { view: 'overview' },
      { view: 'conversations' },
      { view: 'conversation', key: 'teams:19:abc@thread.v2' },
      { view: 'conversation', key: 'title:design review/2 #1' },
      { view: 'export' },
      { view: 'export', key: 'title:design review' },
      { view: 'settings', section: null, tabId: null },
      { view: 'settings', section: 'advanced', tabId: null },
      { view: 'settings', section: 'storage', tabId: null },
      { view: 'settings', section: 'troubleshooting', tabId: null },
      { view: 'settings', section: 'troubleshooting', tabId: 42 },
    ];
    for (const route of routes) expect(parseRoute(routeHash(route))).toEqual(route);
    expect(routeHash({ view: 'settings', section: 'troubleshooting', tabId: 42 })).toBe('#settings/troubleshooting/42');
    expect(routeHash({ view: 'conversation', key: 'title:a/b' })).toBe('#conversation/title%3Aa%2Fb');
    // The popup's Export this chat… names the chat; Export without one is the plain address.
    expect(routeHash({ view: 'export', key: 'title:a/b' })).toBe('#export/title%3Aa%2Fb');
    expect(parseRoute('#export/')).toEqual({ view: 'export' });
    expect(parseRoute('#export/%E0%A4%A')).toEqual({ view: 'export' });
    expect(navOf({ view: 'export', key: 'k' })).toBe('export');
  });

  it('show the overview for an empty or unknown address, and the list for a conversation without key', () => {
    expect(parseRoute('')).toEqual({ view: 'overview' });
    expect(parseRoute('#')).toEqual({ view: 'overview' });
    expect(parseRoute('#nonsense')).toEqual({ view: 'overview' });
    expect(parseRoute('#conversation/')).toEqual({ view: 'conversations' });
    expect(parseRoute('#conversation/%E0%A4%A')).toEqual({ view: 'conversations' });
  });

  it('ignore unknown settings sections and tab ids outside Troubleshooting', () => {
    expect(parseRoute('#settings/colours')).toEqual({ view: 'settings', section: null, tabId: null });
    expect(parseRoute('#settings/storage/7')).toEqual({ view: 'settings', section: 'storage', tabId: null });
    expect(parseRoute('#settings/troubleshooting/x7')).toEqual({ view: 'settings', section: 'troubleshooting', tabId: null });
  });

  it('mark Conversations in the navigation for a single conversation', () => {
    expect(navOf({ view: 'conversation', key: 'k' })).toBe('conversations');
    expect(navOf({ view: 'settings', section: 'storage', tabId: null })).toBe('settings');
  });
});

// ------------------------------------------------------- conversation list

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
    expect(latestActivity(all, 2)).toEqual([design, alpha]);
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

  it('say how much is archived, how far back, and when it was updated, on one line', () => {
    const complete = record({ messageCount: 1234, lastUpdate: { sessionId: 's', mode: 'incremental', at: '2024-01-20T10:00:00.000Z', newestSortKey: at(20, 9, 0) } });
    expect(historyLine(complete, now)).toBe(`${formatNumber(1234)} messages · complete back to ${formatDate(at(1, 9, 0))} · updated 3 days ago`);
    expect(historyLabel(complete)).toBe('Complete');
  });

  it('give the period of a history not back to the start, and the last run when nothing brought it up to date', () => {
    const partial = record({ messageCount: 1, coverage: [{ oldest: at(10, 9, 0), newest: at(20, 9, 0), reachedBeginning: false }], oldestSortKey: at(10, 9, 0) });
    const period = `${formatDate(at(10, 9, 0))} – ${formatDate(at(20, 9, 0))}`;
    expect(archivedPeriod(partial)).toBe(period);
    expect(historyLine(partial, now)).toBe(`1 message · ${period}, not back to the start · last run 3 days ago`);
    expect(historyLabel(partial)).toBe('Not back to the start');
  });

  it('use the same words in the list and the summary line when no capture covered a stretch', () => {
    const unchecked = record({ messageCount: 2, coverage: [] });
    expect(historyLabel(unchecked)).toBe('Not checked');
    expect(historyLine(unchecked, now)).toBe(`2 messages · ${formatDate(at(1, 9, 0))} – ${formatDate(at(20, 9, 0))}, history not checked · last run 3 days ago`);
    expect(archivedPeriod(record({ oldestSortKey: null, newestSortKey: null }))).toBe('');
    expect(archivedPeriod(record({ oldestSortKey: at(5, 9, 0), newestSortKey: at(5, 10, 0) }))).toBe(formatDate(at(5, 9, 0)));
  });

  it('say "Not archived yet" for a chat without messages', () => {
    expect(historyLine(null, now)).toBe('Not archived yet');
    expect(historyLine(record({ messageCount: 0, oldestSortKey: null, newestSortKey: null, coverage: [] }), now)).toBe('Not archived yet');
  });

  it('add up the overview totals', () => {
    const partial = record({ coverage: [{ oldest: at(10, 9, 0), newest: at(20, 9, 0), reachedBeginning: false }] });
    const empty = record({ messageCount: 0, oldestSortKey: null, newestSortKey: null, coverage: [] });
    expect(overviewTotals([record(), partial, empty], [3, 0])).toEqual({ conversations: 3, messages: 20, images: 3, complete: 1, partial: 1 });
    expect(overviewTotals([], [])).toEqual({ conversations: 0, messages: 0, images: 0, complete: 0, partial: 0 });
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
});

describe('export panel', () => {
  it('shows a preset as in use only while the choices are its own', () => {
    const backup = normalizeChoices(presetChoices('backup'));
    expect(presetInUse(normalizeChoices(presetChoices('knowledge')))).toBe('knowledge');
    expect(presetInUse(backup)).toBe('backup');
    expect(presetInUse(normalizeChoices(DEFAULT_EXPORT_CHOICES))).toBeNull();
    expect(presetInUse({ ...backup, range: 'last-7d' })).toBeNull();
    expect(presetInUse({ ...backup, content: { ...backup.content, editHistory: false } })).toBeNull();
    // The package always keeps attachments and reply context, as its ticked, disabled boxes show.
    expect(presetInUse({ ...backup, content: { ...backup.content, attachments: false } })).toBe('backup');
  });

  it('names the file as the export names it, for every format and packaging', async () => {
    const alpha = await exportFixture();
    const beta = await exportFixture('teams:19:beta', 'Design review', 2);
    const reader = memoryReader([alpha, beta]);
    expect(plannedFileName({ format: 'pdf', packaging: 'file' }, [alpha.record], FIXTURE_NOW)).toBeNull();
    let compared = 0;
    for (const format of EXPORT_FORMATS.filter((value) => value !== 'pdf')) {
      for (const images of [true, false]) {
        for (const packaging of packagingsFor(format, { images })) {
          for (const records of [[alpha.record], [alpha.record, beta.record]]) {
            const outcome = await runExport(reader, {
              conversations: records.map((one) => one.conversationKey),
              format,
              packaging,
              range: { from: null, to: null },
              content: { ...FULL_CONTENT, images },
              now: FIXTURE_NOW,
            });
            expect(plannedFileName({ format, packaging }, records, FIXTURE_NOW), `${format} ${packaging}`).toBe(outcome.fileName);
            compared++;
          }
        }
      }
    }
    expect(compared).toBeGreaterThanOrEqual(20);
  });

  it('sums a conversation up after its name in the list', () => {
    const now = Date.parse('2024-01-20T13:00:00.000Z');
    expect(conversationFacts(record({ messageCount: 451 }), now)).toBe('Group chat · 451 messages · updated 3 hours ago');
    expect(conversationFacts(record({ type: 'one-on-one', messageCount: 1 }), now)).toMatch(/^1:1 chat · 1 message · updated /);
  });

  it('gives every format a tile with a short name and a line', () => {
    for (const format of EXPORT_FORMATS) {
      expect(FORMAT_TILES[format].name.length, format).toBeGreaterThan(0);
      expect(FORMAT_TILES[format].line.length, format).toBeLessThanOrEqual(45);
    }
  });

  it('names what the Export button writes', () => {
    expect(exportButtonLabel({ format: 'package', packaging: 'zip' }, 2)).toBe('Export 2 conversations (ZIP)');
    expect(exportButtonLabel({ format: 'html', packaging: 'file' }, 1)).toBe('Export 1 conversation (HTML)');
    expect(exportButtonLabel({ format: 'csv', packaging: 'zip' }, 3)).toBe('Export 3 conversations (ZIP)');
    expect(exportButtonLabel({ format: 'json', packaging: 'file' }, 1)).toBe('Export 1 conversation (JSON)');
    expect(exportButtonLabel({ format: 'pdf', packaging: 'file' }, 2)).toBe('Open the print dialog');
    expect(exportButtonLabel({ format: 'markdown', packaging: 'file' }, 0)).toBe('Export');
  });

  it('explains the package in plain words, and lists the files inside apart', () => {
    const backup = explainChoices(normalizeChoices(presetChoices('backup')), 2);
    expect(backup.text).not.toMatch(/jsonl|SHA-256|manifest/);
    expect(backup.text).toMatch(/Import archive/);
    expect(backup.inside).toMatch(/messages\.jsonl/);
    expect(explainChoices(normalizeChoices(DEFAULT_EXPORT_CHOICES), 1)).toEqual({ text: expect.stringMatching(/^One HTML page/), inside: '' });
  });
});
