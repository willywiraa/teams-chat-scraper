/**
 * The export model: which conversations, in which format, over which period and with which
 * content. The archive page's export dialog edits `ExportChoices` (and remembers the last ones);
 * `resolveExport` turns them into what the export pipeline runs.
 */
import { DAY_MS } from '../shared/capture';
import type { CoverageRange, StoredMessage } from '../shared/types';

export type ExportFormat = 'html' | 'pdf' | 'markdown' | 'text' | 'csv' | 'json' | 'package';

/** One file, or a ZIP with the pictures as files next to the transcript. */
export type Packaging = 'file' | 'zip';

export type RangeChoice = 'all' | 'last-24h' | 'last-7d' | 'last-30d' | 'custom';

export interface ExportContent {
  /** Saved pictures, in place in transcripts and as data in JSON and packages. */
  images: boolean;
  /** File attachments, link previews and cards (names and links). */
  attachments: boolean;
  /** The quoted message a reply refers to. */
  replies: boolean;
  /** Reactions under messages (emoji and counts). Added in 1.7; on when not stored. */
  reactions: boolean;
  /** Events such as "X added Y to the chat". */
  systemMessages: boolean;
  /** Earlier versions of edited and deleted messages. */
  editHistory: boolean;
}

/** By message time (`sortKey`, epoch ms): `from` inclusive, `to` exclusive; null is open. */
export interface TimeRange {
  from: number | null;
  to: number | null;
}

export interface ExportChoices {
  format: ExportFormat;
  packaging: Packaging;
  range: RangeChoice;
  /** Custom range, as `datetime-local` values (local time); empty is open. */
  from: string;
  to: string;
  content: ExportContent;
}

export const FULL_CONTENT: Readonly<ExportContent> = Object.freeze({ images: true, attachments: true, replies: true, reactions: true, systemMessages: true, editHistory: true });

/** First use: one HTML page with everything (not JSON). */
export const DEFAULT_EXPORT_CHOICES: Readonly<ExportChoices> = Object.freeze({ format: 'html', packaging: 'file', range: 'all', from: '', to: '', content: { ...FULL_CONTENT } });

export type ExportPreset = 'knowledge' | 'backup';

/**
 * Knowledge system: the package with pictures, attachments, reply context, reactions and edit
 * history, without system messages. Backup: the package with everything.
 */
export function presetChoices(preset: ExportPreset): ExportChoices {
  return {
    format: 'package',
    packaging: 'zip',
    range: 'all',
    from: '',
    to: '',
    content: { ...FULL_CONTENT, systemMessages: preset !== 'knowledge' },
  };
}

export interface FormatInfo {
  label: string;
  /** File extension of a single-file export. */
  extension: string;
  mimeType: string;
  /** Pictures can be part of the file itself (embedded, or base64 data). */
  embedsPictures: boolean;
  /** Writes archive records that **Import archive…** reads back. */
  importable: boolean;
}

export const FORMATS: Readonly<Record<ExportFormat, FormatInfo>> = {
  html: { label: 'HTML page', extension: 'html', mimeType: 'text/html', embedsPictures: true, importable: false },
  pdf: { label: 'PDF (print)', extension: 'pdf', mimeType: 'application/pdf', embedsPictures: true, importable: false },
  markdown: { label: 'Markdown', extension: 'md', mimeType: 'text/markdown', embedsPictures: false, importable: false },
  text: { label: 'Plain text', extension: 'txt', mimeType: 'text/plain', embedsPictures: false, importable: false },
  csv: { label: 'CSV (spreadsheet)', extension: 'csv', mimeType: 'text/csv', embedsPictures: false, importable: false },
  json: { label: 'JSON (complete records)', extension: 'json', mimeType: 'application/json', embedsPictures: true, importable: true },
  package: { label: 'Knowledge package (ZIP)', extension: 'zip', mimeType: 'application/zip', embedsPictures: true, importable: true },
};

export const EXPORT_FORMATS = Object.keys(FORMATS) as ExportFormat[];

/**
 * The packagings a format offers. Pictures go into a ZIP when the format can't hold them; an
 * HTML page can embed them or link them as files. JSON is one file, the package always a ZIP.
 */
export function packagingsFor(format: ExportFormat, content: Pick<ExportContent, 'images'>): Packaging[] {
  switch (format) {
    case 'html':
      return content.images ? ['file', 'zip'] : ['file'];
    case 'markdown':
    case 'text':
    case 'csv':
      return content.images ? ['zip'] : ['file'];
    case 'package':
      return ['zip'];
    default:
      return ['file'];
  }
}

/**
 * Content a format always keeps. Records (JSON, package) keep attachments and reply context:
 * they are part of a message's content and of its `contentHash`, so a record without them would
 * not match the message in Teams any more.
 */
export function fixedContent(format: ExportFormat): Partial<ExportContent> {
  return FORMATS[format].importable ? { attachments: true, replies: true } : {};
}

export function effectiveContent(format: ExportFormat, content: ExportContent): ExportContent {
  return { ...content, ...fixedContent(format) };
}

/**
 * True when an export is a full backup: an importable format, every archived conversation, the
 * whole period and all content. Overview shows when the last one was made.
 */
export function isFullBackup(
  request: { conversations: readonly string[] | 'all'; format: ExportFormat; range: TimeRange; content: ExportContent },
  archivedKeys: readonly string[],
): boolean {
  if (!FORMATS[request.format].importable) return false;
  if (request.range.from !== null || request.range.to !== null) return false;
  if (!Object.values(effectiveContent(request.format, request.content)).every(Boolean)) return false;
  if (request.conversations === 'all') return true;
  const chosen = new Set(request.conversations);
  return archivedKeys.length > 0 && archivedKeys.every((key) => chosen.has(key));
}

/** Parses a `datetime-local` value (local time) to epoch ms; empty or invalid is null. */
export function parseLocalDateTime(value: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?)?$/.test(value)) return null;
  const ms = new Date(value.includes('T') ? value : `${value}T00:00`).getTime();
  return Number.isFinite(ms) ? ms : null;
}

/** The period of a range choice at `nowMs`, or the reason it can't be used. */
export function rangeFor(choices: Pick<ExportChoices, 'range' | 'from' | 'to'>, nowMs: number): { range: TimeRange } | { error: string } {
  switch (choices.range) {
    case 'all':
      return { range: { from: null, to: null } };
    case 'last-24h':
      return { range: { from: nowMs - DAY_MS, to: null } };
    case 'last-7d':
      return { range: { from: nowMs - 7 * DAY_MS, to: null } };
    case 'last-30d':
      return { range: { from: nowMs - 30 * DAY_MS, to: null } };
    case 'custom': {
      const from = choices.from ? parseLocalDateTime(choices.from) : null;
      const to = choices.to ? parseLocalDateTime(choices.to) : null;
      if (choices.from && from === null) return { error: 'The "From" date is not valid.' };
      if (choices.to && to === null) return { error: 'The "Before" date is not valid.' };
      if (from === null && to === null) return { error: 'Choose a "From" date, a "Before" date, or both.' };
      if (from !== null && to !== null && from >= to) return { error: '"From" must be earlier than "Before".' };
      return { range: { from, to } };
    }
  }
}

export function isOpenRange(range: TimeRange): boolean {
  return range.from === null && range.to === null;
}

export function inRange(message: Pick<StoredMessage, 'sortKey'>, range: TimeRange): boolean {
  return (range.from === null || message.sortKey >= range.from) && (range.to === null || message.sortKey < range.to);
}

/**
 * Coverage limited to the range: what an export of that range holds without a gap. A range
 * keeps `reachedBeginning` only when the export still starts at its beginning.
 */
export function clipCoverage(ranges: readonly CoverageRange[], range: TimeRange): CoverageRange[] {
  const clipped: CoverageRange[] = [];
  for (const covered of ranges) {
    const oldest = range.from === null ? covered.oldest : Math.max(covered.oldest, range.from);
    const newest = range.to === null ? covered.newest : Math.min(covered.newest, range.to);
    if (oldest > newest) continue;
    clipped.push({ oldest, newest, reachedBeginning: covered.reachedBeginning && oldest === covered.oldest });
  }
  return clipped;
}

const RANGE_CHOICES: readonly RangeChoice[] = ['all', 'last-24h', 'last-7d', 'last-30d', 'custom'];

/** Choices as stored (possibly by an older version, or damaged), made whole and consistent. */
export function normalizeChoices(raw: unknown): ExportChoices {
  const value = (raw && typeof raw === 'object' ? raw : {}) as Partial<Record<keyof ExportChoices, unknown>>;
  const format = EXPORT_FORMATS.includes(value.format as ExportFormat) ? (value.format as ExportFormat) : DEFAULT_EXPORT_CHOICES.format;
  const storedContent = (value.content && typeof value.content === 'object' ? value.content : {}) as Partial<Record<keyof ExportContent, unknown>>;
  const content = { ...FULL_CONTENT };
  for (const key of Object.keys(content) as Array<keyof ExportContent>) {
    if (typeof storedContent[key] === 'boolean') content[key] = storedContent[key] as boolean;
  }
  const packagings = packagingsFor(format, content);
  const packaging = packagings.includes(value.packaging as Packaging) ? (value.packaging as Packaging) : (packagings[0] as Packaging);
  return {
    format,
    packaging,
    range: RANGE_CHOICES.includes(value.range as RangeChoice) ? (value.range as RangeChoice) : 'all',
    from: typeof value.from === 'string' && parseLocalDateTime(value.from) !== null ? value.from : '',
    to: typeof value.to === 'string' && parseLocalDateTime(value.to) !== null ? value.to : '',
    content,
  };
}
