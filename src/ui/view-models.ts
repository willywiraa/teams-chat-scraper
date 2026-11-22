/**
 * What the screens show, worked out from archive records without touching the page: routes of
 * the app page, the conversation list's search and filters, summary lines, overview totals and
 * the message view. The screens draw these; the tests check them.
 */
import { attachmentPrefix, replyTargetOf, senderLabel, timeLabel, webLink, type ReplyTarget, type TimeFormat } from '../export/render';
import { reactionsText } from '../shared/reactions';
import { conversationLabel, type ConversationRecord, type ConversationType, type StoredMessage } from '../shared/types';
import { titleHistoryOf } from '../storage/conversation-identity';
import { coverageStatus } from '../storage/coverage';
import { countOf, formatAgo, formatDate, formatDateTime, formatNumber } from './common';

// ------------------------------------------------------------------ routes

export type SettingsSection = 'general' | 'advanced' | 'storage' | 'troubleshooting';

export type Route =
  | { view: 'overview' }
  | { view: 'conversations' }
  | { view: 'conversation'; key: string }
  | { view: 'export' }
  | { view: 'settings'; section: SettingsSection | null; tabId: number | null };

const SETTINGS_SECTIONS: readonly SettingsSection[] = ['general', 'advanced', 'storage', 'troubleshooting'];

/**
 * The app page's routes: `#overview`, `#conversations`, `#conversation/<key>`, `#export`,
 * `#settings`, `#settings/<section>` and `#settings/troubleshooting/<tab id>` (diagnostics of
 * that Teams tab). Anything else is the overview.
 */
export function parseRoute(hash: string): Route {
  const [view = '', ...rest] = hash.replace(/^#\/?/, '').split('/');
  switch (view) {
    case 'conversations':
      return { view: 'conversations' };
    case 'conversation': {
      let key = '';
      try {
        key = decodeURIComponent(rest.join('/'));
      } catch {
        key = '';
      }
      return key ? { view: 'conversation', key } : { view: 'conversations' };
    }
    case 'export':
      return { view: 'export' };
    case 'settings': {
      const section = SETTINGS_SECTIONS.includes(rest[0] as SettingsSection) ? (rest[0] as SettingsSection) : null;
      const tab = section === 'troubleshooting' && rest[1] && /^\d+$/.test(rest[1]) ? Number(rest[1]) : null;
      return { view: 'settings', section, tabId: tab };
    }
    default:
      return { view: 'overview' };
  }
}

export function routeHash(route: Route): string {
  switch (route.view) {
    case 'conversation':
      return `#conversation/${encodeURIComponent(route.key)}`;
    case 'settings':
      return `#settings${route.section ? `/${route.section}` : ''}${route.section === 'troubleshooting' && route.tabId !== null ? `/${route.tabId}` : ''}`;
    default:
      return `#${route.view}`;
  }
}

/** The navigation entry a route belongs to. */
export function navOf(route: Route): 'overview' | 'conversations' | 'export' | 'settings' {
  return route.view === 'conversation' ? 'conversations' : route.view;
}

// ------------------------------------------------------- conversation list

export type TypeFilter = 'all' | ConversationType;
export type ConversationSort = 'recent' | 'name' | 'messages';

export const TYPE_FILTERS: ReadonlyArray<{ value: TypeFilter; label: string }> = [
  { value: 'all', label: 'All types' },
  { value: 'one-on-one', label: '1:1 chats' },
  { value: 'group', label: 'Group chats' },
  { value: 'meeting', label: 'Meeting chats' },
  { value: 'channel', label: 'Channels' },
  { value: 'unknown', label: 'Other' },
];

export const CONVERSATION_SORTS: ReadonlyArray<{ value: ConversationSort; label: string }> = [
  { value: 'recent', label: 'Recently archived' },
  { value: 'name', label: 'Name' },
  { value: 'messages', label: 'Most messages' },
];

const normalize = (text: string): string => text.toLocaleLowerCase().replace(/\s+/g, ' ').trim();

/** Everything a search can find a conversation by: its names, earlier titles and keys. */
export function searchTextOf(record: ConversationRecord): string {
  const names = [record.displayName, record.title, ...titleHistoryOf(record).map((seen) => seen.title), record.conversationKey, ...(record.aliases ?? [])];
  return normalize(names.filter(Boolean).join('\n'));
}

/** When a conversation was last archived: its last update, else its last run. */
export function lastActivityOf(record: ConversationRecord): string {
  const update = record.lastUpdate?.at ?? '';
  return update > record.lastExtractedAt ? update : record.lastExtractedAt;
}

export function filterConversations(records: readonly ConversationRecord[], options: { query?: string; type?: TypeFilter; sort?: ConversationSort } = {}): ConversationRecord[] {
  const words = normalize(options.query ?? '').split(' ').filter(Boolean);
  const type = options.type ?? 'all';
  const found = records.filter((record) => {
    if (type !== 'all' && record.type !== type) return false;
    if (words.length === 0) return true;
    const text = searchTextOf(record);
    return words.every((word) => text.includes(word));
  });
  const byName = (a: ConversationRecord, b: ConversationRecord) => conversationLabel(a).localeCompare(conversationLabel(b), undefined, { sensitivity: 'base' });
  switch (options.sort ?? 'recent') {
    case 'name':
      return found.sort(byName);
    case 'messages':
      return found.sort((a, b) => b.messageCount - a.messageCount || byName(a, b));
    default:
      return found.sort((a, b) => lastActivityOf(b).localeCompare(lastActivityOf(a)) || byName(a, b));
  }
}

/** What else a chat was called, and whether it is being merged: shown under its name. */
export function conversationDetails(record: ConversationRecord): string {
  const label = conversationLabel(record);
  const details: string[] = [];
  if (record.displayName && record.title) details.push(`In Teams: ${record.title}`);
  const earlier = titleHistoryOf(record)
    .map((seen) => seen.title)
    .filter((title) => title !== label && title !== record.title)
    .reverse();
  if (earlier.length > 0) details.push(`Earlier: ${earlier.slice(0, 3).join(', ')}${earlier.length > 3 ? ', …' : ''}`);
  if (record.mergedInto) details.push('Being merged into another conversation');
  return details.join(' · ');
}

// ---------------------------------------------------------- summary lines

/** "Complete", "Partial" or "–". */
export function historyLabel(record: ConversationRecord): string {
  const status = coverageStatus(record.coverage, record.newestSortKey);
  return status === 'complete' ? 'Complete' : status === 'partial' ? 'Partial' : '–';
}

/**
 * One line about a chat's archive: "1,234 messages · complete back to 3 Jan 2023 · updated 3 days ago".
 * A partial history gives its period instead; a chat without messages is "Not archived yet".
 */
export function historyLine(record: ConversationRecord | null | undefined, nowMs: number = Date.now()): string {
  if (!record || record.messageCount === 0) return 'Not archived yet';
  const parts = [`${formatNumber(record.messageCount)} ${record.messageCount === 1 ? 'message' : 'messages'}`];
  const status = coverageStatus(record.coverage, record.newestSortKey);
  if (record.oldestSortKey !== null) {
    parts.push(status === 'complete' ? `complete back to ${formatDate(record.oldestSortKey)}` : `partial, ${formatDate(record.oldestSortKey)} – ${formatDate(record.newestSortKey)}`);
  }
  parts.push(record.lastUpdate ? `updated ${formatAgo(record.lastUpdate.at, nowMs)}` : `last run ${formatAgo(record.lastExtractedAt, nowMs)}`);
  return parts.join(' · ');
}

// ---------------------------------------------------------------- overview

export interface OverviewTotals {
  conversations: number;
  messages: number;
  images: number;
  complete: number;
  partial: number;
}

export function overviewTotals(records: readonly ConversationRecord[], imageCounts: readonly number[]): OverviewTotals {
  const totals: OverviewTotals = { conversations: records.length, messages: 0, images: 0, complete: 0, partial: 0 };
  records.forEach((record, i) => {
    totals.messages += record.messageCount;
    totals.images += imageCounts[i] ?? 0;
    const status = coverageStatus(record.coverage, record.newestSortKey);
    if (status === 'complete') totals.complete++;
    else if (status === 'partial') totals.partial++;
  });
  return totals;
}

/** The chats archived most recently. */
export function latestActivity(records: readonly ConversationRecord[], limit = 5): ConversationRecord[] {
  return filterConversations(records, { sort: 'recent' }).slice(0, limit);
}

// ------------------------------------------------------------ message view

export interface PictureView {
  imageId: string;
  name: string;
}

export interface AttachmentView {
  /** "File", "Link", "Card", "Picture not saved" … */
  label: string;
  name: string;
  /** A web link to it, when it has one. */
  href: string | null;
}

export interface MessageView {
  key: string;
  system: boolean;
  self: boolean;
  sender: string;
  /** Local time of day, or "time unknown". */
  time: string;
  /** The day heading it belongs under, or null when its date is unknown. */
  day: string | null;
  text: string;
  edited: boolean;
  deleted: boolean;
  reply: { who: string; text: string } | null;
  /** Saved pictures, shown in place. */
  pictures: PictureView[];
  attachments: AttachmentView[];
  /** "👍 2 · ❤️ 1 (yours: 👍)", or '' when it has none. */
  reactions: string;
  /** Earlier versions, oldest first. */
  history: Array<{ replaced: string; text: string }>;
}

export function messageView(message: StoredMessage, time: TimeFormat, replyTarget: (key: string) => ReplyTarget | undefined = () => undefined): MessageView {
  const { day, time: clock } = timeLabel(message, time);
  let reply: MessageView['reply'] = null;
  if (message.replyTo) {
    const target = message.replyTo.resolvedKey ? replyTarget(message.replyTo.resolvedKey) : undefined;
    reply = {
      who: message.replyTo.senderName ?? target?.sender ?? 'an earlier message',
      text: (message.replyTo.preview ?? target?.preview ?? '').split('\n')[0]?.slice(0, 200) ?? '',
    };
  }
  const pictures: PictureView[] = [];
  const attachments: AttachmentView[] = [];
  for (const att of message.attachments) {
    const name = att.name ?? att.kind;
    if (att.kind === 'image' && att.imageId) pictures.push({ imageId: att.imageId, name });
    else attachments.push({ label: att.kind === 'image' ? 'Picture not saved' : attachmentPrefix(att.kind), name, href: webLink(att.url) });
  }
  return {
    key: message.key,
    system: message.kind === 'system',
    self: message.sender.isSelf,
    sender: senderLabel(message),
    time: clock,
    day,
    text: message.text,
    edited: message.isEdited,
    deleted: message.isDeleted,
    reply,
    pictures,
    attachments,
    reactions: reactionsText(message.reactions),
    history: (message.previousVersions ?? []).map((version) => ({ replaced: time.dateTime(version.replacedAt), text: version.text })),
  };
}

export type TimelineItem = { kind: 'day'; label: string } | { kind: 'message'; message: MessageView };

/**
 * Messages in timeline order, with a day heading before the first message of each day. A reply
 * that only names its target by key shows that target when it is among the messages.
 */
export function timeline(messages: readonly StoredMessage[], time: TimeFormat): TimelineItem[] {
  const targets = new Map(messages.map((message) => [message.key, message] as const));
  const replyTarget = (key: string) => {
    const target = targets.get(key);
    return target ? replyTargetOf(target) : undefined;
  };
  const items: TimelineItem[] = [];
  let currentDay: string | null = null;
  for (const message of messages) {
    const view = messageView(message, time, replyTarget);
    if (view.day && view.day !== currentDay) {
      currentDay = view.day;
      items.push({ kind: 'day', label: view.day });
    }
    items.push({ kind: 'message', message: view });
  }
  return items;
}

/** The keys of the page before the messages shown: the `size` keys just before `shownFrom`. */
export function earlierPage(keys: readonly string[], shownFrom: number, size: number): { keys: string[]; from: number } {
  const from = Math.max(0, shownFrom - size);
  return { keys: keys.slice(from, shownFrom), from };
}

/** The box a picture is drawn in before its size is known. */
export const PICTURE_PLACEHOLDER = Object.freeze({ width: 240, height: 160 });

/**
 * The size to draw a saved picture at in the message view: its own size, scaled down to fit
 * `max`, so the space is reserved before it loads. Null when the size was not recorded.
 */
export function pictureBox(width: number | null, height: number | null, max: { width: number; height: number } = { width: 420, height: 320 }): { width: number; height: number } | null {
  if (!width || !height || width <= 0 || height <= 0) return null;
  const scale = Math.min(1, max.width / width, max.height / height);
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

// ------------------------------------------------------------------ backup

/** The last full backup made from this browser profile. */
export interface LastBackup {
  /** ISO time the export finished. */
  at: string;
  conversations: number;
  messages: number;
}

/** Overview's line about the last full backup. */
export function backupLine(last: LastBackup | null, archived: number, nowMs: number = Date.now()): string {
  if (archived === 0) return 'Nothing to back up yet.';
  if (!last) return 'No full backup has been made from this browser profile yet.';
  // Older than 30 days, formatAgo already gives the date.
  const ago = formatAgo(last.at, nowMs);
  const when = ago === formatDate(last.at) ? `on ${formatDateTime(last.at)}` : `${ago} (${formatDateTime(last.at)})`;
  return `Last full backup ${when}: ${countOf(last.conversations, 'conversation')}, ${countOf(last.messages, 'message')}.`;
}
