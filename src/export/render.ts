/**
 * Renders conversations and messages for the readable export formats: HTML (also printed to
 * PDF), Markdown, plain text and CSV. Each piece is rendered on its own, so the export pipeline
 * can write a conversation message by message.
 *
 * Message text is rendered from the plain-text field and escaped for the format; the captured
 * HTML is not reused, so nothing in an archive (which may come from an import) can run code or
 * load remote content. Only `http`/`https` links are made links.
 */
import { conversationLabel, type ConversationRecord, type StoredMessage } from '../shared/types';
import { coverageStatus } from '../storage/coverage';
import { FULL_CONTENT, type ExportContent, type TimeRange } from './options';

// ------------------------------------------------------------------ shared

/** Web links only; anything else (javascript:, data:, file:, for example from an import) is not linked. */
export function webLink(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.href : null;
  } catch {
    return null;
  }
}

export function senderLabel(message: Pick<StoredMessage, 'sender'>): string {
  if (message.sender.name) return message.sender.name;
  if (message.sender.isSelf) return 'Me';
  return 'Unknown sender';
}

/** Dates and times in one time zone and locale (formatters are created once). */
export class TimeFormat {
  readonly zone: string;
  private readonly dayFormat: Intl.DateTimeFormat;
  private readonly timeFormat: Intl.DateTimeFormat;
  private readonly dateTimeFormat: Intl.DateTimeFormat;
  private readonly partsFormat: Intl.DateTimeFormat;

  constructor(timeZone?: string, locale = 'en-GB') {
    this.zone = timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
    this.dayFormat = new Intl.DateTimeFormat(locale, { timeZone, weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    this.timeFormat = new Intl.DateTimeFormat(locale, { timeZone, hour: '2-digit', minute: '2-digit', hour12: false });
    this.dateTimeFormat = new Intl.DateTimeFormat(locale, { timeZone, day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
    this.partsFormat = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  }

  day(at: string | number): string {
    return this.dayFormat.format(new Date(at));
  }

  time(at: string | number): string {
    return this.timeFormat.format(new Date(at));
  }

  dateTime(at: string | number): string {
    return this.dateTimeFormat.format(new Date(at));
  }

  private parts(at: string | number): Record<string, string> {
    return Object.fromEntries(this.partsFormat.formatToParts(new Date(at)).map((part) => [part.type, part.value]));
  }

  /** `2024-01-15 09:30:05`, which spreadsheets read as a date and time. */
  stamp(at: string | number): string {
    const p = this.parts(at);
    return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
  }

  /** `2024-01-15_0930`, for picture file names. */
  fileStamp(at: string | number): string {
    const p = this.parts(at);
    return `${p.year}-${p.month}-${p.day}_${p.hour}${p.minute}`;
  }
}

const formats = new Map<string, TimeFormat>();

export function timeFormat(timeZone?: string, locale?: string): TimeFormat {
  const id = `${locale ?? ''}|${timeZone ?? ''}`;
  let format = formats.get(id);
  if (!format) {
    format = new TimeFormat(timeZone, locale);
    formats.set(id, format);
  }
  return format;
}

/** A saved picture as an export shows it. */
export interface PictureRef {
  /** Address to show it from (relative path, data URI or object URL); absent when it is only named. */
  src?: string;
  /** File name it is saved under, for formats that name pictures instead of showing them. */
  file?: string;
  width: number | null;
  height: number | null;
}

/** What a reply points to, when the reply itself doesn't say. */
export interface ReplyTarget {
  sender: string;
  preview: string;
}

export interface RenderContext {
  content: ExportContent;
  time: TimeFormat;
  /** A saved picture of the conversation, or undefined when it is not part of this export. */
  picture(imageId: string): PictureRef | undefined;
  /** An earlier message of the conversation, by key. */
  replyTarget(key: string): ReplyTarget | undefined;
}

/** What the header of a conversation says about it. */
export interface ConversationSummary {
  messages: number;
  /** Pictures shown in place (0 when the export shows none). */
  pictures: number;
  /** Where the pictures are, for formats that name them: `folder` (next to the file) or `json`. */
  picturesIn?: 'folder' | 'json';
  range: TimeRange;
}

export function timeLabel(message: StoredMessage, time: TimeFormat): { day: string | null; time: string } {
  if (!message.timestamp) return { day: null, time: 'time unknown' };
  return { day: time.day(message.timestamp), time: time.time(message.timestamp) };
}

function replyOf(message: StoredMessage, ctx: RenderContext): { who: string; preview: string } | null {
  if (!ctx.content.replies || !message.replyTo) return null;
  const target = message.replyTo.resolvedKey ? ctx.replyTarget(message.replyTo.resolvedKey) : undefined;
  const who = message.replyTo.senderName ?? target?.sender ?? 'unknown';
  const preview = (message.replyTo.preview ?? target?.preview ?? '').split('\n')[0]?.slice(0, 200) ?? '';
  return { who, preview };
}

/** First line of a message, as a reply to it shows it. */
export function replyTargetOf(message: StoredMessage): ReplyTarget {
  return { sender: senderLabel(message), preview: (message.text.split('\n')[0] ?? '').slice(0, 200) };
}

function attachmentPrefix(kind: string): string {
  return kind === 'image' ? 'Image' : kind === 'card' ? 'Card' : kind === 'link-preview' ? 'Link' : 'File';
}

function flagsOf(message: StoredMessage): string[] {
  return [message.isEdited ? 'edited' : '', message.isDeleted ? 'deleted' : ''].filter(Boolean);
}

function historyOf(message: StoredMessage, ctx: RenderContext): StoredMessage['previousVersions'] {
  return ctx.content.editHistory ? (message.previousVersions ?? []) : [];
}

function periodText(range: TimeRange, time: TimeFormat): string | null {
  if (range.from === null && range.to === null) return null;
  if (range.to === null) return `from ${time.dateTime(range.from as number)}`;
  if (range.from === null) return `before ${time.dateTime(range.to)}`;
  return `from ${time.dateTime(range.from)}, before ${time.dateTime(range.to)}`;
}

function historyStatus(record: ConversationRecord): string {
  const status = coverageStatus(record.coverage, record.newestSortKey);
  return status === 'complete' ? 'complete' : status === 'partial' ? 'partial' : 'unknown';
}

// -------------------------------------------------------------------- HTML

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch] as string);
}

export const HTML_STYLE = `
:root { color-scheme: light; }
* { box-sizing: border-box; }
body { margin: 0 auto; max-width: 880px; padding: 24px 16px 48px; background: #fff; color: #1f1f1f;
  font: 15px/1.5 "Segoe UI", system-ui, -apple-system, sans-serif; }
h1 { font-size: 22px; line-height: 1.3; margin: 0 0 8px; overflow-wrap: anywhere; }
.summary { list-style: none; margin: 0 0 20px; padding: 0; color: #555; font-size: 13px; }
.day { margin: 28px 0 12px; padding-bottom: 4px; border-bottom: 1px solid #e3e3e3; color: #555; font-size: 13px; font-weight: 600; }
.msg { margin: 0 48px 10px 0; padding: 8px 12px; border: 1px solid #e3e3e3; border-radius: 8px; background: #f7f7f7; break-inside: avoid; }
.msg.self { margin: 0 0 10px 48px; background: #eef0fb; border-color: #d9ddf5; }
.meta { margin-bottom: 2px; color: #616161; font-size: 12px; }
.who { margin-right: 8px; color: #1f1f1f; font-weight: 600; }
.flags { margin-left: 6px; font-style: italic; }
.text { white-space: pre-wrap; overflow-wrap: anywhere; }
.reply { margin: 2px 0 6px; padding: 2px 10px; border-left: 3px solid #b8b8b8; color: #555; font-size: 13px; overflow-wrap: anywhere; }
.history { margin: 6px 0 0; padding: 2px 10px; border-left: 3px dashed #c8c8c8; color: #555; font-size: 13px; }
.history .text { color: #555; }
figure { margin: 8px 0 2px; }
figure img { display: block; width: auto; height: auto; max-width: 100%; max-height: 640px; border: 1px solid #ddd; border-radius: 4px; background: #fff; }
figcaption { color: #616161; font-size: 12px; }
.att { margin: 6px 0 0; padding-left: 18px; color: #444; font-size: 13px; overflow-wrap: anywhere; }
.missing { color: #8a5300; }
.system { margin: 8px 0; color: #666; font-size: 13px; text-align: center; }
section + section { margin-top: 48px; break-before: page; }
a { color: #4f52b2; }
@media print {
  body { max-width: none; padding: 0; font-size: 11pt; }
  .msg, .msg.self { margin-left: 0; margin-right: 0; }
  figure img { max-height: 20cm; }
  a { color: inherit; text-decoration: none; }
}
`;

export function htmlDocumentStart(title: string): string {
  return [
    '<!doctype html>',
    '<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(title)}</title><style>${HTML_STYLE}</style></head><body>`,
    '',
  ].join('\n');
}

export function htmlDocumentEnd(): string {
  return '</body></html>\n';
}

export function htmlConversationStart(record: ConversationRecord, summary: ConversationSummary, time: TimeFormat): string {
  const period = periodText(summary.range, time);
  const lines = [
    record.participants.length ? `Participants: ${record.participants.join(', ')}` : '',
    `Messages: ${summary.messages}${summary.pictures ? ` · Pictures: ${summary.pictures}` : ''}`,
    period ? `Period: ${period}` : '',
    `Archived history: ${historyStatus(record)} · Times shown in ${time.zone}`,
  ].filter(Boolean);
  return `<section><h1>${escapeHtml(conversationLabel(record))}</h1>\n<ul class="summary">${lines.map((line) => `<li>${escapeHtml(line)}</li>`).join('')}</ul>\n`;
}

export function htmlDay(day: string): string {
  return `<h2 class="day">${escapeHtml(day)}</h2>\n`;
}

export function htmlConversationEnd(): string {
  return '</section>\n';
}

function htmlAttachments(message: StoredMessage, ctx: RenderContext): string {
  const figures: string[] = [];
  const others: string[] = [];
  for (const att of message.attachments) {
    const name = att.name ?? att.kind;
    const link = webLink(att.url);
    const label = link ? `<a href="${escapeHtml(link)}">${escapeHtml(name)}</a>` : escapeHtml(name);
    if (att.kind === 'image') {
      if (!ctx.content.images) {
        if (ctx.content.attachments) others.push(`<li>Picture: ${label}</li>`);
        continue;
      }
      const picture = att.imageId ? ctx.picture(att.imageId) : undefined;
      if (picture?.src) {
        const size = picture.width && picture.height ? ` width="${picture.width}" height="${picture.height}"` : '';
        const src = escapeHtml(picture.src);
        const caption = att.name && att.name.toLowerCase() !== 'image' ? `<figcaption>${escapeHtml(att.name)}</figcaption>` : '';
        const img = `<img src="${src}" alt="${escapeHtml(name)}"${size}>`;
        // Browsers don't open data: addresses from a link, so an embedded picture isn't linked.
        figures.push(`<figure>${picture.src.startsWith('data:') ? img : `<a href="${src}" target="_blank">${img}</a>`}${caption}</figure>`);
      } else {
        others.push(`<li class="missing">Picture not saved: ${label}</li>`);
      }
      continue;
    }
    if (ctx.content.attachments) others.push(`<li>${attachmentPrefix(att.kind)}: ${label}</li>`);
  }
  return figures.join('') + (others.length ? `<ul class="att">${others.join('')}</ul>` : '');
}

export function htmlMessage(message: StoredMessage, ctx: RenderContext): string {
  const { time } = timeLabel(message, ctx.time);
  if (message.kind === 'system') return `<p class="system">${escapeHtml(message.text || 'System event')} · ${escapeHtml(time)}</p>\n`;
  const flags = flagsOf(message);
  const parts = [
    `<div class="meta"><span class="who">${escapeHtml(senderLabel(message))}</span>${escapeHtml(time)}${flags.length ? `<span class="flags">(${flags.join(', ')})</span>` : ''}</div>`,
  ];
  const reply = replyOf(message, ctx);
  if (reply) parts.push(`<blockquote class="reply">Replying to <b>${escapeHtml(reply.who)}</b>: ${escapeHtml(reply.preview)}</blockquote>`);
  if (message.text) parts.push(`<div class="text">${escapeHtml(message.text)}</div>`);
  parts.push(htmlAttachments(message, ctx));
  for (const version of historyOf(message, ctx)) {
    parts.push(`<div class="history"><div class="meta">Earlier version, replaced ${escapeHtml(ctx.time.dateTime(version.replacedAt))}</div><div class="text">${escapeHtml(version.text || '(empty)')}</div></div>`);
  }
  return `<article class="msg${message.sender.isSelf ? ' self' : ''}">${parts.join('')}</article>\n`;
}

/** The page linking the conversations of a ZIP export. */
export function htmlIndex(entries: ReadonlyArray<{ folder: string; label: string; messages: number; pictures: number }>): string {
  const items = entries.map(
    (entry) =>
      `<li><a href="${escapeHtml(encodeURIComponent(entry.folder))}/chat.html">${escapeHtml(entry.label)}</a> · ${entry.messages} messages${entry.pictures ? `, ${entry.pictures} pictures` : ''}</li>`,
  );
  return `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><title>Teams chats</title><style>${HTML_STYLE}</style></head><body><h1>Teams chats</h1><ul>${items.join('')}</ul></body></html>\n`;
}

// ---------------------------------------------------------------- Markdown

/**
 * A line of message text: line-start markers are escaped so the text keeps its shape, and `<`
 * so nothing in it becomes HTML in a Markdown viewer. Emphasis and links are left as written.
 */
function escapeMarkdownLine(line: string): string {
  return line.replace(/^(\s*)([#>]|[-+*](?=\s)|\d+[.)](?=\s)|`{3}|-{3,}|={3,})/, '$1\\$2').replace(/</g, '\\<');
}

function escapeInline(text: string): string {
  return text.replace(/([\\*_`[\]<])/g, '\\$1');
}

export function markdownConversationStart(record: ConversationRecord, summary: ConversationSummary, time: TimeFormat): string {
  const lines: string[] = [`# ${escapeInline(conversationLabel(record))}`, ''];
  if (record.displayName && record.title) lines.push(`- Title in Teams: ${escapeInline(record.title)}`);
  lines.push(`- Type: ${record.type}`);
  if (record.participants.length) lines.push(`- Participants: ${record.participants.map(escapeInline).join(', ')}`);
  lines.push(`- Messages: ${summary.messages}`);
  if (summary.pictures > 0 && summary.picturesIn === 'folder') lines.push(`- Pictures: ${summary.pictures} (in the images folder, shown in place below)`);
  else if (summary.pictures > 0 && summary.picturesIn === 'json') lines.push(`- Saved images: ${summary.pictures} (in the JSON export, named here by file name)`);
  const period = periodText(summary.range, time);
  if (period) lines.push(`- Period: ${period}`);
  const status = historyStatus(record);
  lines.push(`- Archive coverage: ${status === 'complete' ? 'complete history' : status === 'partial' ? 'partial history' : 'unknown'}`);
  lines.push(`- Times shown in: ${time.zone}`, '', '---', '', '');
  return lines.join('\n');
}

export function markdownDay(day: string): string {
  return `## ${day}\n\n`;
}

function markdownAttachments(message: StoredMessage, ctx: RenderContext): string[] {
  const lines: string[] = [];
  const parts: string[] = [];
  for (const att of message.attachments) {
    const label = escapeInline(att.name ?? att.kind);
    const link = webLink(att.url);
    const named = link ? `[${label}](${link})` : label;
    if (att.kind === 'image') {
      if (!ctx.content.images) {
        if (ctx.content.attachments) parts.push(`Image: ${named}`);
        continue;
      }
      const picture = att.imageId ? ctx.picture(att.imageId) : undefined;
      if (picture?.src) {
        lines.push(`![${label}](${picture.src})`);
        continue;
      }
      let text = `Image: ${named}`;
      if (picture?.file) text += ` (saved as \`${picture.file}\`)`;
      else if (att.imageId) text += ' (not saved)';
      parts.push(text);
      continue;
    }
    if (ctx.content.attachments) parts.push(`${attachmentPrefix(att.kind)}: ${named}`);
  }
  if (parts.length > 0) lines.push(`_Attachments:_ ${parts.join(' · ')}`);
  return lines;
}

export function markdownMessage(message: StoredMessage, ctx: RenderContext): string {
  const { time } = timeLabel(message, ctx.time);
  if (message.kind === 'system') return `_${escapeInline(message.text || 'System event')}_ · ${time}\n\n`;
  const flags = flagsOf(message);
  const lines: string[] = [`**${escapeInline(senderLabel(message))}** · ${time}${flags.length ? ` _(${flags.join(', ')})_` : ''}`];
  const reply = replyOf(message, ctx);
  if (reply) lines.push(`> Replying to **${escapeInline(reply.who)}**: ${escapeInline(reply.preview)}`);
  lines.push('');
  if (message.text) {
    for (const line of message.text.split('\n')) lines.push(escapeMarkdownLine(line));
    lines.push('');
  }
  for (const line of markdownAttachments(message, ctx)) lines.push(line, '');
  for (const version of historyOf(message, ctx)) {
    lines.push(`_Earlier version, replaced ${ctx.time.dateTime(version.replacedAt)}:_`, '');
    for (const line of (version.text || '(empty)').split('\n')) lines.push(`> ${escapeMarkdownLine(line)}`);
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

// -------------------------------------------------------------- plain text

export function textConversationStart(record: ConversationRecord, summary: ConversationSummary, time: TimeFormat): string {
  const title = conversationLabel(record);
  const lines = [title, '='.repeat(Math.min(Math.max(title.length, 3), 80))];
  if (record.displayName && record.title) lines.push(`Title in Teams: ${record.title}`);
  lines.push(`Type: ${record.type}`);
  if (record.participants.length) lines.push(`Participants: ${record.participants.join(', ')}`);
  lines.push(`Messages: ${summary.messages}${summary.pictures > 0 && summary.picturesIn === 'folder' ? ` · Pictures: ${summary.pictures} (in the images folder)` : ''}`);
  const period = periodText(summary.range, time);
  if (period) lines.push(`Period: ${period}`);
  lines.push(`Archived history: ${historyStatus(record)}`, `Times shown in: ${time.zone}`, '', '');
  return lines.join('\n');
}

export function textDay(day: string): string {
  return `${day}\n${'-'.repeat(Math.min(day.length, 80))}\n\n`;
}

function indent(text: string, prefix: string): string[] {
  return text.split('\n').map((line) => (line ? `${prefix}${line}` : ''));
}

export function textMessage(message: StoredMessage, ctx: RenderContext): string {
  const { time } = timeLabel(message, ctx.time);
  if (message.kind === 'system') return `${time} · ${message.text || 'System event'}\n\n`;
  const flags = flagsOf(message);
  const lines = [`${time} ${senderLabel(message)}${flags.length ? ` (${flags.join(', ')})` : ''}`];
  const reply = replyOf(message, ctx);
  if (reply) lines.push(`  > Replying to ${reply.who}: ${reply.preview}`);
  if (message.text) lines.push(...indent(message.text, '  '));
  for (const att of message.attachments) {
    const name = att.name ?? att.kind;
    const link = webLink(att.url);
    const named = link ? `${name} <${link}>` : name;
    if (att.kind === 'image') {
      const picture = ctx.content.images && att.imageId ? ctx.picture(att.imageId) : undefined;
      if (picture?.src) lines.push(`  Picture: ${picture.src}${att.name && att.name.toLowerCase() !== 'image' ? ` (${att.name})` : ''}`);
      else if (ctx.content.images) lines.push(`  Picture not saved: ${named}`);
      else if (ctx.content.attachments) lines.push(`  Picture: ${named}`);
      continue;
    }
    if (ctx.content.attachments) lines.push(`  ${attachmentPrefix(att.kind)}: ${named}`);
  }
  for (const version of historyOf(message, ctx)) {
    lines.push(`  Earlier version, replaced ${ctx.time.dateTime(version.replacedAt)}:`, ...indent(version.text || '(empty)', '    '));
  }
  return `${lines.join('\n')}\n\n`;
}

// --------------------------------------------------------------------- CSV

/**
 * One CSV cell. A value a spreadsheet would run as a formula (starting with `=`, `+`, `-`, `@`,
 * a tab or a carriage return, or their full-width forms) is prefixed with `'` so it stays text.
 * Cells with a comma, quote or line break are quoted, with quotes doubled.
 */
export function csvCell(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined) return '';
  let text = typeof value === 'boolean' ? (value ? 'yes' : 'no') : String(value);
  if (typeof value === 'string' && /^[=+\-@\t\r＝＋－＠]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function csvRow(values: ReadonlyArray<string | number | boolean | null | undefined>): string {
  return `${values.map(csvCell).join(',')}\r\n`;
}

export function csvColumns(content: ExportContent): string[] {
  return [
    'conversation',
    'conversation_key',
    'message_key',
    'message_id',
    'time',
    'time_utc',
    'sender',
    'sender_id',
    'from_me',
    'kind',
    'text',
    ...(content.replies ? ['reply_to_sender', 'reply_to_text', 'reply_to_key'] : []),
    ...(content.attachments ? ['attachments'] : []),
    ...(content.images ? ['pictures'] : []),
    'edited',
    'deleted',
    ...(content.editHistory ? ['earlier_versions'] : []),
  ];
}

/** The UTF-8 byte order mark and header row; Excel needs the mark to read UTF-8. */
export function csvStart(content: ExportContent): string {
  return `﻿${csvRow(csvColumns(content))}`;
}

export function csvMessage(record: ConversationRecord, message: StoredMessage, ctx: RenderContext): string {
  const { content } = ctx;
  const values: Array<string | number | boolean | null> = [
    conversationLabel(record),
    record.conversationKey,
    message.key,
    message.messageId,
    message.timestamp ? ctx.time.stamp(message.timestamp) : '',
    message.timestamp ?? '',
    message.kind === 'system' ? '' : senderLabel(message),
    message.sender.id,
    message.sender.isSelf,
    message.kind,
    message.text,
  ];
  if (content.replies) {
    const reply = replyOf(message, ctx);
    values.push(reply?.who ?? '', reply?.preview ?? '', message.replyTo?.resolvedKey ?? '');
  }
  const pictures: string[] = [];
  if (content.attachments) {
    const lines: string[] = [];
    for (const att of message.attachments) {
      if (att.kind === 'image' && content.images && att.imageId && ctx.picture(att.imageId)?.src) continue;
      const name = att.name ?? att.kind;
      const link = webLink(att.url);
      lines.push(`${att.kind === 'image' ? 'Picture' : attachmentPrefix(att.kind)}: ${name}${link ? ` <${link}>` : ''}`);
    }
    values.push(lines.join('\n'));
  }
  if (content.images) {
    for (const att of message.attachments) {
      const picture = att.kind === 'image' && att.imageId ? ctx.picture(att.imageId) : undefined;
      if (picture?.src) pictures.push(picture.src);
    }
    values.push(pictures.join('\n'));
  }
  values.push(message.isEdited, message.isDeleted);
  if (content.editHistory) {
    values.push(historyOf(message, ctx).map((version) => `[replaced ${ctx.time.stamp(version.replacedAt)}] ${version.text}`).join('\n---\n'));
  }
  return csvRow(values);
}

/** A context for rendering without pictures or reply lookups (all content shown). */
export function plainContext(time: TimeFormat, content: ExportContent = FULL_CONTENT): RenderContext {
  return { content, time, picture: () => undefined, replyTarget: () => undefined };
}
