/**
 * What a capture run covers: the whole history, the messages since a point in time, or the new
 * messages since the last update (see docs/ARCHITECTURE.md, "Capture ranges and updates").
 */
import type { ConversationRecord, ScrapeMode } from './types';

export const DAY_MS = 86_400_000;

/** The choices offered in the popup. */
export type CaptureChoice = 'update' | 'last-24h' | 'last-7d' | 'last-30d' | 'from-date' | 'everything';

export const CAPTURE_CHOICES: readonly CaptureChoice[] = ['update', 'last-24h', 'last-7d', 'last-30d', 'from-date', 'everything'];

export interface CapturePlan {
  mode: ScrapeMode;
  /** Full mode: capture back to this message time (epoch ms); null for the whole history. */
  rangeStart: number | null;
}

const LAST_DAYS: Partial<Record<CaptureChoice, number>> = { 'last-24h': 1, 'last-7d': 7, 'last-30d': 30 };

/** Midnight at the start of a date field's value (`YYYY-MM-DD`) in the local time zone, or null. */
export function localDayStart(value: string | null | undefined): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value ?? '');
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(year, month - 1, day);
  // new Date() rolls 31 February over into March: such a value is not a date.
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null;
  return date.getTime();
}

/**
 * The run for a choice. "From a date" takes `fromDate` (a date field's value) from midnight local
 * time, and is null without a valid date that is not in the future.
 */
export function capturePlan(choice: CaptureChoice, nowMs: number, fromDate?: string | null): CapturePlan | null {
  if (choice === 'update') return { mode: 'incremental', rangeStart: null };
  if (choice === 'everything') return { mode: 'full', rangeStart: null };
  const days = LAST_DAYS[choice];
  if (days !== undefined) return { mode: 'full', rangeStart: nowMs - days * DAY_MS };
  const start = localDayStart(fromDate);
  return start !== null && start <= nowMs ? { mode: 'full', rangeStart: start } : null;
}

/**
 * Where a conversation's archive was last brought up to date: the newest message of its last
 * update, else (archives from before 1.3, or never updated) the newest archived message. Null
 * when nothing is archived.
 */
export function updateAnchor(record: Pick<ConversationRecord, 'lastUpdate' | 'newestSortKey'> | null | undefined): number | null {
  const fromUpdate = record?.lastUpdate?.newestSortKey;
  if (typeof fromUpdate === 'number' && Number.isFinite(fromUpdate)) return fromUpdate;
  return record?.newestSortKey ?? null;
}

/** The oldest message time an update re-reads: the anchor minus the overlap window. */
export function updateStart(anchor: number | null, overlapDays: number): number | null {
  if (anchor === null) return null;
  const days = Number.isFinite(overlapDays) ? Math.min(30, Math.max(0, overlapDays)) : 0;
  return anchor - days * DAY_MS;
}
