/** Small helpers shared by the popup / side panel and the archive page. */
import type { ConversationType, ScrapeMode, SessionStatus, StopReason } from '../shared/types';

export function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing element #${id}`);
  return element as T;
}

export function setText(id: string, text: string): void {
  byId(id).textContent = text;
}

export function setHidden(id: string, hidden: boolean): void {
  byId(id).hidden = hidden;
}

type Child = Node | string | null | undefined | false;

/** Creates an element; text is always assigned via text nodes (never parsed as HTML). */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<Record<string, string | boolean | ((event: Event) => void)>> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  for (const [name, value] of Object.entries(props)) {
    if (value === undefined || value === false) continue;
    if (typeof value === 'function') element.addEventListener(name.replace(/^on/, '').toLowerCase(), value);
    else if (name === 'className') element.className = String(value);
    else if (value === true) element.setAttribute(name, '');
    else element.setAttribute(name, value);
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    element.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return element;
}

export function formatNumber(value: number | null | undefined): string {
  return value === null || value === undefined ? '–' : value.toLocaleString();
}

/** "1 message", "451 messages": the number and the word, singular for one. */
export function countOf(value: number, singular: string, plural = `${singular}s`): string {
  return `${formatNumber(value)} ${value === 1 ? singular : plural}`;
}

export function formatDateTime(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === '') return '–';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '–';
  return date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export function formatDate(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === '') return '–';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '–';
  return date.toLocaleDateString(undefined, { dateStyle: 'medium' });
}

/** A point in time: the date alone when it is midnight local time (a chosen day), else date and time. */
export function formatMoment(value: number): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '–';
  const midnight = date.getHours() === 0 && date.getMinutes() === 0 && date.getSeconds() === 0 && date.getMilliseconds() === 0;
  return midnight ? formatDate(value) : formatDateTime(value);
}

export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}m`;
  if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
  return `${seconds}s`;
}

export const STOP_REASON_LABELS: Record<StopReason, string> = {
  'visible-complete': 'Captured the messages on screen',
  'reached-top': 'Reached the beginning of the conversation',
  'history-complete': 'Caught up with the archived history',
  'overlap-reached': 'Caught up with previously archived messages',
  'range-reached': 'Reached the start of the chosen period',
  'user-stop': 'Stopped by you',
  'max-steps': 'Stopped at the scroll-step limit',
  'max-duration': 'Stopped at the time limit',
  'no-progress': 'Stopped because no new messages appeared',
  'conversation-changed': 'Stopped because a different chat was opened',
  'container-lost': 'Stopped because the message list was not found',
  error: 'Failed with an error',
  interrupted: 'Interrupted (tab closed, reloaded or browser closed)',
};

export const MODE_LABELS: Record<ScrapeMode, string> = {
  visible: 'On screen',
  incremental: 'Update',
  full: 'Full history',
};

/** What a run captured: "Update", "Full history", "Since 14 Nov 2026" or "On screen". */
export function captureLabel(mode: ScrapeMode, captureFrom: number | null | undefined): string {
  if (mode === 'full' && typeof captureFrom === 'number') return `Since ${formatDate(captureFrom)}`;
  return MODE_LABELS[mode];
}

/** A run as the subject of a sentence: "The update", "The capture since 3 Nov 2026", "The full-history run". */
export function runSubject(mode: ScrapeMode, captureFrom: number | null | undefined): string {
  if (mode === 'incremental') return 'The update';
  if (mode === 'visible') return 'The capture of the messages on screen';
  return typeof captureFrom === 'number' ? `The capture since ${formatMoment(captureFrom)}` : 'The full-history run';
}

/** "Stopped by you", or "Completed: Reached the beginning of the conversation". */
export function outcomeText(status: SessionStatus, stopReason: StopReason): string {
  const statusLabel = STATUS_LABELS[status];
  const reason = STOP_REASON_LABELS[stopReason];
  return reason.toLowerCase().startsWith(statusLabel.toLowerCase()) ? reason : `${statusLabel}: ${reason}`;
}

/** "just now", "5 minutes ago", "3 days ago"; older than 30 days: the date. */
export function formatAgo(value: string | number | null | undefined, nowMs: number = Date.now()): string {
  if (value === null || value === undefined || value === '') return '–';
  const time = new Date(value).getTime();
  if (Number.isNaN(time)) return '–';
  const seconds = Math.round((nowMs - time) / 1000);
  if (seconds < 60) return 'just now';
  const format = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  if (seconds < 3600) return format.format(-Math.floor(seconds / 60), 'minute');
  if (seconds < 86_400) return format.format(-Math.floor(seconds / 3600), 'hour');
  if (seconds < 30 * 86_400) return format.format(-Math.floor(seconds / 86_400), 'day');
  return formatDate(time);
}

export const STATUS_LABELS: Record<SessionStatus, string> = {
  running: 'Running',
  paused: 'Paused',
  completed: 'Completed',
  stopped: 'Stopped',
  interrupted: 'Interrupted',
  failed: 'Failed',
};

export const TYPE_LABELS: Record<ConversationType, string> = {
  'one-on-one': '1:1 chat',
  group: 'Group chat',
  meeting: 'Meeting chat',
  channel: 'Channel',
  unknown: 'Chat',
};

export function downloadText(filename: string, text: string, mime: string): void {
  downloadBlob(filename, new Blob([text], { type: mime }));
}

export function downloadBlob(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const anchor = el('a', { href: url, download: filename });
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
