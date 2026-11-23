/**
 * The export model. A file is saved in one of four formats (`SaveFormat`), with the content the
 * user includes (`SaveChoices`, remembered by the popup and the archive page). The pipeline also
 * writes an HTML page (the printed page behind a PDF) and Markdown (the package's transcript),
 * which are not offered as files of their own.
 */
import type { CoverageRange, SessionRecord, StoredMessage } from '../shared/types';

export type ExportFormat = 'html' | 'pdf' | 'markdown' | 'text' | 'json' | 'package';

/** The formats offered for saving a file. */
export type SaveFormat = 'pdf' | 'text' | 'json' | 'package';

export const SAVE_FORMATS: readonly SaveFormat[] = ['pdf', 'text', 'json', 'package'];

/** One file, or a ZIP with the pictures as files next to the transcript. */
export type Packaging = 'file' | 'zip';

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

/** The file to save: its format and what it includes. Also carried by a capture that saves one (`SessionRecord.save`). */
export interface SaveChoices {
  format: SaveFormat;
  content: ExportContent;
}

export const FULL_CONTENT: Readonly<ExportContent> = Object.freeze({ images: true, attachments: true, replies: true, reactions: true, systemMessages: true, editHistory: true });

/** First use: a PDF with everything (never JSON). */
export const DEFAULT_SAVE_CHOICES: Readonly<SaveChoices> = Object.freeze({ format: 'pdf', content: { ...FULL_CONTENT } });

export interface FormatInfo {
  /** File extension of a single-file export. */
  extension: string;
  mimeType: string;
  /** Pictures can be part of the file itself (embedded, or base64 data). */
  embedsPictures: boolean;
  /** Writes archive records that **Import archive…** reads back. */
  importable: boolean;
}

export const FORMATS: Readonly<Record<ExportFormat, FormatInfo>> = {
  html: { extension: 'html', mimeType: 'text/html', embedsPictures: true, importable: false },
  pdf: { extension: 'pdf', mimeType: 'application/pdf', embedsPictures: true, importable: false },
  markdown: { extension: 'md', mimeType: 'text/markdown', embedsPictures: false, importable: false },
  text: { extension: 'txt', mimeType: 'text/plain', embedsPictures: false, importable: false },
  json: { extension: 'json', mimeType: 'application/json', embedsPictures: true, importable: true },
  package: { extension: 'zip', mimeType: 'application/zip', embedsPictures: true, importable: true },
};

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
      return content.images ? ['zip'] : ['file'];
    case 'package':
      return ['zip'];
    default:
      return ['file'];
  }
}

/** How a saved file is packaged: text with pictures is a ZIP, everything else as its format says. */
export function packagingOf(choices: SaveChoices): Packaging {
  return packagingsFor(choices.format, effectiveContent(choices.format, choices.content))[0] as Packaging;
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
 * whole period and all content. The archive page shows when the last one was made.
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

/**
 * Choices as stored (possibly by an older version, or damaged), made whole. Formats that are no
 * longer offered (HTML page, Markdown, CSV) become PDF.
 */
export function normalizeSaveChoices(raw: unknown): SaveChoices {
  const value = (raw && typeof raw === 'object' ? raw : {}) as Partial<Record<keyof SaveChoices, unknown>>;
  const format = SAVE_FORMATS.includes(value.format as SaveFormat) ? (value.format as SaveFormat) : DEFAULT_SAVE_CHOICES.format;
  const storedContent = (value.content && typeof value.content === 'object' ? value.content : {}) as Partial<Record<keyof ExportContent, unknown>>;
  const content = { ...FULL_CONTENT };
  for (const key of Object.keys(content) as Array<keyof ExportContent>) {
    if (typeof storedContent[key] === 'boolean') content[key] = storedContent[key] as boolean;
  }
  return { format, content };
}

/**
 * The messages a capture's file holds: the period it captured, the messages it found on screen,
 * or (for an update or the full history) everything archived of the chat.
 */
export function sessionSaveRange(session: Pick<SessionRecord, 'mode' | 'captureFrom' | 'counters'>): TimeRange {
  if (session.mode === 'visible') {
    const { oldestSortKey, newestSortKey } = session.counters;
    return { from: oldestSortKey ?? null, to: newestSortKey === null || newestSortKey === undefined ? null : newestSortKey + 1 };
  }
  if (session.mode === 'full' && typeof session.captureFrom === 'number') return { from: session.captureFrom, to: null };
  return { from: null, to: null };
}

// ------------------------------------------------------------ save page

/** What the save page (`save.html`) saves: the file of a finished capture, one chat, or every chat. */
export type SaveTarget =
  | { kind: 'session'; sessionId: string }
  | { kind: 'conversation'; conversationKey: string; choices: SaveChoices; range: TimeRange }
  | { kind: 'all'; choices: SaveChoices };

const CONTENT_KEYS = Object.keys(FULL_CONTENT) as Array<keyof ExportContent>;

/** The save page's address part (after `save.html`). */
export function saveTargetHash(target: SaveTarget): string {
  const params = new URLSearchParams();
  if (target.kind === 'session') {
    params.set('session', target.sessionId);
    return `#${params.toString()}`;
  }
  if (target.kind === 'conversation') params.set('chat', target.conversationKey);
  else params.set('all', '1');
  params.set('format', target.choices.format);
  params.set('include', CONTENT_KEYS.filter((key) => target.choices.content[key]).join(','));
  if (target.kind === 'conversation') {
    if (target.range.from !== null) params.set('from', String(target.range.from));
    if (target.range.to !== null) params.set('to', String(target.range.to));
  }
  return `#${params.toString()}`;
}

/** Reads the save page's address part; null when it names nothing to save. */
export function parseSaveTarget(hash: string): SaveTarget | null {
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  const session = params.get('session');
  if (session) return { kind: 'session', sessionId: session };
  const included = new Set((params.get('include') ?? '').split(','));
  const content = Object.fromEntries(CONTENT_KEYS.map((key) => [key, included.has(key)])) as unknown as ExportContent;
  const choices = normalizeSaveChoices({ format: params.get('format'), content });
  if (params.get('all') === '1') return { kind: 'all', choices };
  const chat = params.get('chat');
  if (!chat) return null;
  const time = (name: string): number | null => {
    const value = params.get(name);
    if (value === null || !/^-?\d+$/.test(value)) return null;
    return Number(value);
  };
  return { kind: 'conversation', conversationKey: chat, choices, range: { from: time('from'), to: time('to') } };
}
