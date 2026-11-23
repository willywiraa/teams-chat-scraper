/**
 * What the screens show, worked out from archive records without touching the page: routes of
 * the archive page, the conversation list's search and filters, summary lines, the archive's
 * totals and the message view. The screens draw these; the tests check them.
 */
import { attachmentPrefix, replyTargetOf, senderLabel, timeLabel, webLink, type ReplyTarget, type TimeFormat } from '../export/render';
import { reactionsText } from '../shared/reactions';
import { conversationLabel, type ConversationRecord, type ConversationType, type StoredMessage } from '../shared/types';
import { titleHistoryOf } from '../storage/conversation-identity';
import { coverageStatus } from '../storage/coverage';
import { countOf, formatAgo, formatDate, formatDateTime, formatNumber } from './common';

// ------------------------------------------------------------------ routes

/** The parts of the archive page, one under the other. */
export type PageSection = 'conversations' | 'backup' | 'settings' | 'advanced';

export type Route = { view: 'home'; section: PageSection | null } | { view: 'conversation'; key: string };

/**
 * The archive page's routes: `#conversations`, `#backup`, `#settings` and `#settings/advanced`
 * (the page, at that part), and `#conversation/<key>` (one chat's messages). The addresses of
 * the earlier sections still lead somewhere: `#overview` and `#export` to Backup and import,
 * `#export/<key>` to that chat, any part of Settings to Settings. Anything else is the page.
 */
export function parseRoute(hash: string): Route {
  const [view = '', ...rest] = hash.replace(/^#\/?/, '').split('/');
  const key = (): string => {
    try {
      return decodeURIComponent(rest.join('/'));
    } catch {
      return '';
    }
  };
  switch (view) {
    case 'conversations':
      return { view: 'home', section: 'conversations' };
    case 'conversation': {
      const conversation = key();
      return conversation ? { view: 'conversation', key: conversation } : { view: 'home', section: 'conversations' };
    }
    case 'backup':
    case 'overview':
      return { view: 'home', section: 'backup' };
    case 'export': {
      const conversation = key();
      return conversation ? { view: 'conversation', key: conversation } : { view: 'home', section: 'backup' };
    }
    case 'settings':
      return { view: 'home', section: rest[0] === 'advanced' ? 'advanced' : 'settings' };
    default:
      return { view: 'home', section: null };
  }
}

export function routeHash(route: Route): string {
  if (route.view === 'conversation') return `#conversation/${encodeURIComponent(route.key)}`;
  if (route.section === 'advanced') return '#settings/advanced';
  return `#${route.section ?? 'conversations'}`;
}

// ------------------------------------------------------------ run progress

/**
 * How far a capture with a start date has got: the share of the time from the run's start back
 * to that date which the oldest message reached covers, 0 to 1. Null when there is no start date
 * (the full history) or it is not before the run's start.
 */
export function reachShare(startedAt: string, captureFrom: number | null | undefined, oldestReached: string | null | undefined): number | null {
  if (typeof captureFrom !== 'number' || !Number.isFinite(captureFrom)) return null;
  const start = Date.parse(startedAt);
  const span = start - captureFrom;
  if (!Number.isFinite(span) || span <= 0) return null;
  const reached = oldestReached ? Date.parse(oldestReached) : Number.NaN;
  if (Number.isNaN(reached)) return 0;
  return Math.min(1, Math.max(0, (start - reached) / span));
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

/** "Complete", "Not back to the start" or "Not checked". */
/**
 * How much of a chat's history is archived, in the same words everywhere: complete back to its
 * beginning, not back to the start, or not checked (no capture covered a stretch of it: only
 * messages on screen, for example).
 */
export function historyLabel(record: ConversationRecord): string {
  const status = coverageStatus(record.coverage, record.newestSortKey);
  return status === 'complete' ? 'Complete' : status === 'partial' ? 'Not back to the start' : 'Not checked';
}

/** "3 Jan 2023 – 5 Mar 2024", or '' when nothing is archived. */
export function archivedPeriod(record: Pick<ConversationRecord, 'oldestSortKey' | 'newestSortKey'>): string {
  if (record.oldestSortKey === null) return '';
  const from = formatDate(record.oldestSortKey);
  const to = formatDate(record.newestSortKey);
  // One day is one date, not "21 Nov – 21 Nov".
  return from === to ? from : `${from} – ${to}`;
}

/**
 * One line about a chat's archive: "1,234 messages · complete back to 3 Jan 2023 · updated 3 days ago".
 * Otherwise it gives the period and what is missing; a chat without messages is "Not archived yet".
 */
export function historyLine(record: ConversationRecord | null | undefined, nowMs: number = Date.now()): string {
  if (!record || record.messageCount === 0) return 'Not archived yet';
  const parts = [`${formatNumber(record.messageCount)} ${record.messageCount === 1 ? 'message' : 'messages'}`];
  const status = coverageStatus(record.coverage, record.newestSortKey);
  if (record.oldestSortKey !== null) {
    parts.push(
      status === 'complete'
        ? `complete back to ${formatDate(record.oldestSortKey)}`
        : `${archivedPeriod(record)}, ${status === 'partial' ? 'not back to the start' : 'history not checked'}`,
    );
  }
  parts.push(record.lastUpdate ? `updated ${formatAgo(record.lastUpdate.at, nowMs)}` : `last run ${formatAgo(record.lastExtractedAt, nowMs)}`);
  return parts.join(' · ');
}

// ------------------------------------------------------------ archive totals

export interface ArchiveTotals {
  conversations: number;
  messages: number;
  images: number;
  complete: number;
  partial: number;
}

export function archiveTotals(records: readonly ConversationRecord[], imageCounts: readonly number[]): ArchiveTotals {
  const totals: ArchiveTotals = { conversations: records.length, messages: 0, images: 0, complete: 0, partial: 0 };
  records.forEach((record, i) => {
    totals.messages += record.messageCount;
    totals.images += imageCounts[i] ?? 0;
    const status = coverageStatus(record.coverage, record.newestSortKey);
    if (status === 'complete') totals.complete++;
    else if (status === 'partial') totals.partial++;
  });
  return totals;
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

/**
 * A day heading, or a message. `continued` marks a message that follows one from the same sender
 * within {@link GROUP_GAP_MS} on the same day: its sender's name is not shown again.
 */
export type TimelineItem = { kind: 'day'; label: string } | { kind: 'message'; message: MessageView; continued: boolean };

/** Messages from one sender this close together read as one run. */
export const GROUP_GAP_MS = 5 * 60_000;

function messageTime(message: StoredMessage): number | null {
  const ms = message.timestamp ? Date.parse(message.timestamp) : Number.NaN;
  return Number.isFinite(ms) ? ms : null;
}

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
  let previous: { view: MessageView; at: number | null } | null = null;
  for (const message of messages) {
    const view = messageView(message, time, replyTarget);
    if (view.day && view.day !== currentDay) {
      currentDay = view.day;
      items.push({ kind: 'day', label: view.day });
      previous = null;
    }
    const at = messageTime(message);
    const continued =
      previous !== null &&
      !view.system &&
      !previous.view.system &&
      previous.view.sender === view.sender &&
      previous.view.self === view.self &&
      at !== null &&
      previous.at !== null &&
      at - previous.at >= 0 &&
      at - previous.at <= GROUP_GAP_MS;
    items.push({ kind: 'message', message: view, continued });
    previous = { view, at };
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

/** Backup and import's line about the last full backup. */
export function backupLine(last: LastBackup | null, archived: number, nowMs: number = Date.now()): string {
  if (archived === 0) return 'Nothing to back up yet.';
  if (!last) return 'No full backup has been made from this browser profile yet.';
  // Older than 30 days, formatAgo already gives the date.
  const ago = formatAgo(last.at, nowMs);
  const when = ago === formatDate(last.at) ? `on ${formatDateTime(last.at)}` : `${ago} (${formatDateTime(last.at)})`;
  return `Last full backup ${when}: ${countOf(last.conversations, 'conversation')}, ${countOf(last.messages, 'message')}.`;
}
