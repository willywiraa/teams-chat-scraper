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
  'history-complete': 'Caught up with the complete archive',
  'overlap-reached': 'Caught up with previously archived messages',
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
  visible: 'Visible only',
  incremental: 'Update',
  full: 'Full history',
};

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
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const anchor = el('a', { href: url, download: filename });
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
