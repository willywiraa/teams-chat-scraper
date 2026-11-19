/**
 * Readable transcripts with the saved pictures shown in place, message by message:
 *
 * - `transcriptHtml` renders a self-contained HTML page (styles inline, no scripts). The archive
 *   page opens it for printing ("Save as PDF"), with the pictures as object URLs.
 * - `transcriptZipEntries` / `buildTranscriptZip` make the ZIP export: per conversation a
 *   `chat.html` and `chat.md` that show the pictures from the `images/` folder next to them.
 *
 * Message text is rendered from the plain-text field and escaped; the captured HTML is not reused,
 * so nothing in an archive (which may come from an import) can run code or load remote content.
 */
import { imageFileName } from '../shared/images';
import type { ConversationRecord, StoredImage, StoredMessage } from '../shared/types';
import { coverageStatus } from '../storage/coverage';
import { formatParts, senderLabel, toMarkdown, webLink, type MarkdownOptions } from './exporters';
import type { ArchiveExportV1 } from './format';
import { createZip, type ZipEntry } from './zip';

/** A picture as the page shows it: its address (relative path or object URL) and size. */
export interface TranscriptImage {
  src: string;
  width: number | null;
  height: number | null;
}

/** A saved image as read from the archive. */
export type TranscriptImageSource = Pick<StoredImage, 'imageId' | 'mimeType' | 'width' | 'height' | 'firstSavedAt' | 'data'>;

export interface TranscriptConversation {
  conversation: ConversationRecord & { messages: StoredMessage[] };
  /** Pictures by image id. Image attachments without an entry are listed as "not saved". */
  images: ReadonlyMap<string, TranscriptImage>;
}

export interface TranscriptOptions {
  /** IANA time zone for displayed times; defaults to the runtime's zone. */
  timeZone?: string;
  locale?: string;
  /** Page title; defaults to the title of the first conversation. */
  title?: string;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch] as string);
}

const STYLE = `
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

function timeLabel(message: StoredMessage, options: TranscriptOptions): { day: string | null; time: string } {
  if (!message.timestamp) return { day: null, time: 'time unknown' };
  const { day, time } = formatParts(message.timestamp, options);
  return { day, time };
}

function attachmentHtml(message: StoredMessage, images: ReadonlyMap<string, TranscriptImage>): string {
  const figures: string[] = [];
  const others: string[] = [];
  for (const att of message.attachments) {
    const name = att.name ?? att.kind;
    const image = att.kind === 'image' && att.imageId ? images.get(att.imageId) : undefined;
    if (image) {
      const size = image.width && image.height ? ` width="${image.width}" height="${image.height}"` : '';
      const src = escapeHtml(image.src);
      const caption = att.name && att.name.toLowerCase() !== 'image' ? `<figcaption>${escapeHtml(att.name)}</figcaption>` : '';
      figures.push(`<figure><a href="${src}" target="_blank"><img src="${src}" alt="${escapeHtml(name)}"${size}></a>${caption}</figure>`);
      continue;
    }
    const link = webLink(att.url);
    const label = link ? `<a href="${escapeHtml(link)}">${escapeHtml(name)}</a>` : escapeHtml(name);
    if (att.kind === 'image') others.push(`<li class="missing">Picture not saved: ${label}</li>`);
    else others.push(`<li>${att.kind === 'card' ? 'Card' : att.kind === 'link-preview' ? 'Link' : 'File'}: ${label}</li>`);
  }
  return figures.join('') + (others.length ? `<ul class="att">${others.join('')}</ul>` : '');
}

function messageHtml(message: StoredMessage, time: string, byKey: ReadonlyMap<string, StoredMessage>, images: ReadonlyMap<string, TranscriptImage>): string {
  if (message.kind === 'system') return `<p class="system">${escapeHtml(message.text || 'System event')} · ${escapeHtml(time)}</p>`;
  const flags = [message.isEdited ? 'edited' : '', message.isDeleted ? 'deleted' : ''].filter(Boolean);
  const parts = [
    `<div class="meta"><span class="who">${escapeHtml(senderLabel(message))}</span>${escapeHtml(time)}${flags.length ? `<span class="flags">(${flags.join(', ')})</span>` : ''}</div>`,
  ];
  if (message.replyTo) {
    const target = message.replyTo.resolvedKey ? byKey.get(message.replyTo.resolvedKey) : undefined;
    const who = message.replyTo.senderName ?? (target ? senderLabel(target) : 'unknown');
    const preview = (message.replyTo.preview ?? target?.text ?? '').split('\n')[0]?.slice(0, 200) ?? '';
    parts.push(`<blockquote class="reply">Replying to <b>${escapeHtml(who)}</b>: ${escapeHtml(preview)}</blockquote>`);
  }
  if (message.text) parts.push(`<div class="text">${escapeHtml(message.text)}</div>`);
  parts.push(attachmentHtml(message, images));
  return `<article class="msg${message.sender.isSelf ? ' self' : ''}">${parts.join('')}</article>`;
}

function conversationHtml(entry: TranscriptConversation, byKey: ReadonlyMap<string, StoredMessage>, options: TranscriptOptions): string {
  const { conversation, images } = entry;
  const zone = options.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const shown = new Set(conversation.messages.flatMap((m) => m.attachments.filter((a) => a.imageId && images.has(a.imageId)).map((a) => a.imageId)));
  const status = coverageStatus(conversation.coverage, conversation.newestSortKey);
  const summary = [
    conversation.participants.length ? `Participants: ${conversation.participants.join(', ')}` : '',
    `Messages: ${conversation.messages.length}${shown.size ? ` · Pictures: ${shown.size}` : ''}`,
    `Archived history: ${status === 'complete' ? 'complete' : status === 'partial' ? 'partial' : 'unknown'} · Times shown in ${zone}`,
  ].filter(Boolean);
  const lines = [
    `<section><h1>${escapeHtml(conversation.title ?? conversation.conversationKey)}</h1>`,
    `<ul class="summary">${summary.map((line) => `<li>${escapeHtml(line)}</li>`).join('')}</ul>`,
  ];
  let currentDay: string | null = null;
  for (const message of conversation.messages) {
    const { day, time } = timeLabel(message, options);
    if (day && day !== currentDay) {
      currentDay = day;
      lines.push(`<h2 class="day">${escapeHtml(day)}</h2>`);
    }
    lines.push(messageHtml(message, time, byKey, images));
  }
  lines.push('</section>');
  return lines.join('\n');
}

/** A complete HTML page showing the conversations message by message, pictures in place. */
export function transcriptHtml(entries: readonly TranscriptConversation[], options: TranscriptOptions = {}): string {
  const byKey = new Map<string, StoredMessage>();
  for (const { conversation } of entries) for (const message of conversation.messages) byKey.set(message.key, message);
  const title = options.title ?? entries[0]?.conversation.title ?? 'Teams chat';
  return [
    '<!doctype html>',
    '<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(title)}</title><style>${STYLE}</style></head><body>`,
    ...entries.map((entry) => conversationHtml(entry, byKey, options)),
    '</body></html>',
    '',
  ].join('\n');
}

/** "2024-01-15_0930" in the given zone, for picture file names. */
function fileStamp(iso: string, timeZone: string | undefined): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(new Date(iso))
      .map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}_${parts.hour}${parts.minute}`;
}

/**
 * File names for the pictures the messages of one conversation show, in that order:
 * `001_2024-01-15_0930.png` (number, then the date and time of the first message showing it).
 * Saved pictures no message shows (any more) get no name and are left out of the transcript.
 */
export function pictureFileNames(messages: readonly StoredMessage[], images: readonly TranscriptImageSource[], options: TranscriptOptions = {}): Map<string, string> {
  const byId = new Map(images.map((image) => [image.imageId, image]));
  const shown: Array<{ image: TranscriptImageSource; stamp: string }> = [];
  const seen = new Set<string>();
  for (const message of messages) {
    for (const att of message.attachments) {
      const image = att.imageId ? byId.get(att.imageId) : undefined;
      if (!image || seen.has(image.imageId)) continue;
      seen.add(image.imageId);
      shown.push({ image, stamp: message.timestamp ? fileStamp(message.timestamp, options.timeZone) : 'unknown-time' });
    }
  }
  const width = Math.max(3, String(shown.length).length);
  return new Map(shown.map(({ image, stamp }, i) => [image.imageId, `${String(i + 1).padStart(width, '0')}_${stamp}.${imageFileName(image).split('.').pop()}`]));
}

function folderName(title: string | null): string {
  return (title ?? 'conversation').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '').slice(0, 60) || 'conversation';
}

/**
 * Files of the ZIP export. One conversation: `chat.html`, `chat.md` and `images/` at the top.
 * Several: one folder per conversation with the same files, and an `index.html` linking them.
 */
export function transcriptZipEntries(
  archive: ArchiveExportV1,
  imagesByConversation: ReadonlyMap<string, readonly TranscriptImageSource[]>,
  options: TranscriptOptions = {},
): ZipEntry[] {
  const entries: ZipEntry[] = [];
  const single = archive.conversations.length === 1;
  const used = new Set<string>();
  const index: string[] = [];
  for (const conversation of archive.conversations) {
    let folder = '';
    if (!single) {
      const base = folderName(conversation.title);
      folder = base;
      for (let n = 2; used.has(folder.toLowerCase()); n++) folder = `${base}-${n}`;
      used.add(folder.toLowerCase());
    }
    const prefix = folder ? `${folder}/` : '';
    const images = imagesByConversation.get(conversation.conversationKey) ?? [];
    const names = pictureFileNames(conversation.messages, images, options);
    const shown = new Map<string, TranscriptImage>();
    for (const image of images) {
      const name = names.get(image.imageId);
      if (!name) continue;
      entries.push({ path: `${prefix}images/${name}`, data: new Uint8Array(image.data) });
      shown.set(image.imageId, { src: `images/${name}`, width: image.width, height: image.height });
    }
    const { images: _omitted, ...withoutImageData } = conversation;
    entries.push({ path: `${prefix}chat.html`, data: transcriptHtml([{ conversation: withoutImageData, images: shown }], options) });
    const markdownOptions: MarkdownOptions = { timeZone: options.timeZone, locale: options.locale, imagePaths: new Map([...names].map(([id, name]) => [id, `images/${name}`])) };
    entries.push({ path: `${prefix}chat.md`, data: toMarkdown({ ...archive, conversations: [withoutImageData] }, markdownOptions) });
    index.push(
      `<li><a href="${escapeHtml(encodeURIComponent(folder))}/chat.html">${escapeHtml(conversation.title ?? conversation.conversationKey)}</a> · ${conversation.messages.length} messages${shown.size ? `, ${shown.size} pictures` : ''}</li>`,
    );
  }
  if (!single && archive.conversations.length > 0) {
    entries.push({
      path: 'index.html',
      data: `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><title>Teams chats</title><style>${STYLE}</style></head><body><h1>Teams chats</h1><ul>${index.join('')}</ul></body></html>\n`,
    });
  }
  return entries;
}

/** The ZIP export as parts for `new Blob(parts, { type: 'application/zip' })`. */
export function buildTranscriptZip(
  archive: ArchiveExportV1,
  imagesByConversation: ReadonlyMap<string, readonly TranscriptImageSource[]>,
  options: TranscriptOptions = {},
): Uint8Array[] {
  return createZip(transcriptZipEntries(archive, imagesByConversation, options), new Date(archive.exportedAt));
}
