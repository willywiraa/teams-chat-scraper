/**
 * What the app page and the popup show, worked out without a page: routes, the conversation
 * list's search, filter and sorting, summary lines, overview totals, the message view and its
 * pages; the scrolling speed presets; and the theme choice.
 */
import { describe, expect, it } from 'vitest';
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
import { formatDate, formatNumber } from '../../src/ui/common';
import { applyTheme, normalizeTheme, readTheme, saveTheme, THEME_STORAGE_KEY } from '../../src/ui/theme';
import {
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
  routeHash,
  timeline,
  type Route,
} from '../../src/ui/view-models';
import { at, exportFixture } from '../helpers/export-fixture';


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
      { view: 'settings', section: null, tabId: null },
      { view: 'settings', section: 'advanced', tabId: null },
      { view: 'settings', section: 'storage', tabId: null },
      { view: 'settings', section: 'troubleshooting', tabId: null },
      { view: 'settings', section: 'troubleshooting', tabId: 42 },
    ];
    for (const route of routes) expect(parseRoute(routeHash(route))).toEqual(route);
    expect(routeHash({ view: 'settings', section: 'troubleshooting', tabId: 42 })).toBe('#settings/troubleshooting/42');
    expect(routeHash({ view: 'conversation', key: 'title:a/b' })).toBe('#conversation/title%3Aa%2Fb');
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

  it('give the period of a partial history, and the last run when nothing brought it up to date', () => {
    const partial = record({ messageCount: 1, coverage: [{ oldest: at(10, 9, 0), newest: at(20, 9, 0), reachedBeginning: false }], oldestSortKey: at(10, 9, 0) });
    expect(historyLine(partial, now)).toBe(`1 message · partial, ${formatDate(at(10, 9, 0))} – ${formatDate(at(20, 9, 0))} · last run 3 days ago`);
    expect(historyLabel(partial)).toBe('Partial');
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
    });
    expect(formula?.pictures).toHaveLength(2);
    expect(formula?.attachments).toEqual([]);
    expect(nextDay).toMatchObject({ self: true, sender: 'Me' });
    expect(edited?.time).toMatch(/09:10/);
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

  it('sets data-theme only for an explicit choice', () => {
    const root = document.createElement('html');
    applyTheme('light', root);
    expect(root.getAttribute('data-theme')).toBe('light');
    applyTheme('system', root);
    expect(root.hasAttribute('data-theme')).toBe(false);
  });
});

