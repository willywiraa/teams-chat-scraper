/**
 * Timestamp helpers. Teams Web normally exposes exact times in <time datetime="...">;
 * the human-readable parsers here are fallbacks for when it does not.
 */
import type { DateOrderSetting } from './settings';

export const DAY_MS = 86_400_000;
/** Earliest instant accepted as a real message time (Teams launched in 2017). */
export const MIN_PLAUSIBLE_MS = Date.UTC(2014, 0, 1);

export type DateOrder = 'MDY' | 'DMY' | 'YMD';

export function isPlausibleEpochMs(ms: number, nowMs: number = Date.now()): boolean {
  return Number.isFinite(ms) && ms >= MIN_PLAUSIBLE_MS && ms <= nowMs + 2 * DAY_MS;
}

/**
 * Teams chat message ids are the server arrival time in epoch milliseconds
 * (for example `1705314612345`). Returns that instant when the id looks like one.
 */
export function epochFromMessageId(messageId: string | null | undefined, nowMs: number = Date.now()): number | null {
  if (!messageId || !/^\d{12,14}$/.test(messageId)) return null;
  const ms = Number(messageId);
  return isPlausibleEpochMs(ms, nowMs) ? ms : null;
}

/** Parses ISO-8601 strings such as `2024-01-15T10:30:12.345Z`; rejects anything else. */
export function parseIsoTimestamp(value: string | null | undefined): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(trimmed)) return null;
  const ms = Date.parse(trimmed.replace(' ', 'T'));
  return Number.isFinite(ms) ? ms : null;
}

export function toIso(ms: number | null): string | null {
  return ms === null || !Number.isFinite(ms) ? null : new Date(ms).toISOString();
}

/** Determines the order of day, month and year in numeric dates for a locale. */
export function resolveDateOrder(setting: DateOrderSetting, locale?: string): DateOrder {
  if (setting !== 'auto') return setting;
  try {
    const parts = new Intl.DateTimeFormat(locale, { year: 'numeric', month: '2-digit', day: '2-digit' })
      .formatToParts(new Date(2020, 11, 31))
      .map((part) => part.type)
      .filter((type) => type === 'day' || type === 'month' || type === 'year');
    const order = parts.join(',');
    if (order === 'day,month,year') return 'DMY';
    if (order === 'year,month,day') return 'YMD';
  } catch {
    // Unknown locale: fall through to the default.
  }
  return 'MDY';
}

const MONTHS = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
];
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

function monthIndex(token: string): number | null {
  const clean = token.replace(/\./g, '');
  if (clean.length < 3) return null;
  const index = MONTHS.findIndex((month) => month === clean || (clean.length >= 3 && month.startsWith(clean)));
  return index >= 0 ? index : null;
}

function weekdayIndex(token: string): number | null {
  const clean = token.replace(/\./g, '');
  if (clean.length < 3) return null;
  const index = WEEKDAYS.findIndex((day) => day === clean || day.startsWith(clean));
  return index >= 0 ? index : null;
}

interface TimeOfDay {
  hours: number;
  minutes: number;
  seconds: number;
  rest: string;
}

function parseTimeOfDay(value: string): TimeOfDay | null {
  const match = /(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\s*([AaPp])\.?\s?[Mm]\.?)?/.exec(value);
  if (!match) return null;
  let hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = match[3] ? Number(match[3]) : 0;
  const meridiem = match[4]?.toLowerCase();
  if (meridiem) {
    if (hours < 1 || hours > 12) return null;
    hours = (hours % 12) + (meridiem === 'p' ? 12 : 0);
  }
  if (hours > 23 || minutes > 59 || seconds > 59) return null;
  const rest = value.slice(0, match.index) + ' ' + value.slice(match.index + match[0].length);
  return { hours, minutes, seconds, rest };
}

interface CalendarDate {
  year: number;
  month: number;
  day: number;
}

function fromMs(ms: number): CalendarDate {
  const date = new Date(ms);
  return { year: date.getFullYear(), month: date.getMonth(), day: date.getDate() };
}

function isValidDate({ year, month, day }: CalendarDate): boolean {
  if (month < 0 || month > 11 || day < 1 || day > 31) return false;
  const date = new Date(year, month, day);
  return date.getFullYear() === year && date.getMonth() === month && date.getDate() === day;
}

/** Fills in a missing year: the most recent occurrence not later than the reference date (+1 day). */
function withInferredYear(month: number, day: number, referenceMs: number): CalendarDate {
  const ref = new Date(referenceMs);
  let year = ref.getFullYear();
  if (new Date(year, month, day).getTime() > referenceMs + DAY_MS) year -= 1;
  return { year, month, day };
}

function normalizeYear(raw: number): number {
  return raw < 100 ? 2000 + raw : raw;
}

/**
 * Parses the date portion of a human-readable label: `Today`, `Yesterday`, weekday names,
 * `January 15, 2024`, `15 Jan`, `1/15/2024`, `15.01.2024`, `2024-01-15`.
 * Returns `'none'` when the text holds no date at all, and null when it holds an unrecognised one.
 */
function parseCalendarDate(value: string, referenceMs: number, order: DateOrder): CalendarDate | 'none' | null {
  const clean = value
    .toLowerCase()
    .replace(/\b(at|on)\b/g, ' ')
    .replace(/,/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (clean === '') return 'none';
  if (clean === 'today') return fromMs(referenceMs);
  if (clean === 'yesterday') return fromMs(referenceMs - DAY_MS);

  let tokens = clean.split(' ');
  const weekdayTokens = tokens.filter((token) => weekdayIndex(token) !== null);
  tokens = tokens.filter((token) => weekdayIndex(token) === null);
  if (tokens.length === 0 && weekdayTokens.length === 1) {
    const target = weekdayIndex(weekdayTokens[0] as string) as number;
    const refDay = new Date(referenceMs).getDay();
    const daysBack = (refDay - target + 7) % 7 || 7;
    return fromMs(referenceMs - daysBack * DAY_MS);
  }

  const monthTokenIndex = tokens.findIndex((token) => monthIndex(token) !== null);
  if (monthTokenIndex >= 0) {
    const month = monthIndex(tokens[monthTokenIndex] as string) as number;
    const numbers = tokens
      .filter((_, index) => index !== monthTokenIndex)
      .map((token) => token.replace(/(st|nd|rd|th|\.)$/, ''))
      .filter((token) => /^\d{1,4}$/.test(token))
      .map(Number);
    const year = numbers.find((num) => num >= 1000);
    const day = numbers.find((num) => num >= 1 && num <= 31);
    if (day === undefined) return null;
    const date = year !== undefined ? { year, month, day } : withInferredYear(month, day, referenceMs);
    return isValidDate(date) ? date : null;
  }

  const numeric = tokens.map((token) => /^(\d{1,4})[/.-](\d{1,2})(?:[/.-](\d{1,4}))?\.?$/.exec(token)).find(Boolean);
  if (numeric) {
    const [, aRaw, bRaw, cRaw] = numeric;
    const a = Number(aRaw);
    const b = Number(bRaw);
    let date: CalendarDate;
    if ((aRaw as string).length === 4) {
      date = { year: a, month: b - 1, day: Number(cRaw ?? NaN) };
    } else if (cRaw !== undefined) {
      const c = normalizeYear(Number(cRaw));
      date = order === 'DMY' ? { year: c, month: b - 1, day: a } : { year: c, month: a - 1, day: b };
    } else {
      date = order === 'DMY' ? withInferredYear(b - 1, a, referenceMs) : withInferredYear(a - 1, b, referenceMs);
    }
    return isValidDate(date) ? date : null;
  }
  return null;
}

export interface HumanDateOptions {
  /** "Now" used to resolve Today/Yesterday/weekday labels and missing years. */
  referenceMs: number;
  dateOrder: DateOrder;
  /** Text of the nearest date divider above the message, used when the label only has a time. */
  contextDate?: string | null;
}

/**
 * Parses labels such as `Monday, January 15, 2024 at 10:30 AM`, `Yesterday 3:15 PM`,
 * `15/01/2024 14:05` or a bare `10:30 AM` combined with a date divider.
 * Interprets the result in the browser's local time zone, as Teams does. Returns null when unsure.
 */
export function parseHumanDateTime(value: string | null | undefined, options: HumanDateOptions): number | null {
  if (!value) return null;
  const iso = parseIsoTimestamp(value);
  if (iso !== null) return iso;

  const time = parseTimeOfDay(value);
  if (!time) return null;
  let date = parseCalendarDate(time.rest, options.referenceMs, options.dateOrder);
  if (date === null) return null;
  if (date === 'none') {
    if (!options.contextDate) return null;
    const context = parseCalendarDate(options.contextDate, options.referenceMs, options.dateOrder);
    if (context === null || context === 'none') return null;
    date = context;
  }
  const ms = new Date(date.year, date.month, date.day, time.hours, time.minutes, time.seconds).getTime();
  return Number.isFinite(ms) ? ms : null;
}
