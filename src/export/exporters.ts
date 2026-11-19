/**
 * Serialisers for the archive export: JSON (canonical, lossless), NDJSON (streaming-friendly
 * for ingestion pipelines) and Markdown (human-readable transcript).
 */
import { coverageStatus } from '../storage/coverage';
import type { StoredMessage } from '../shared/types';
import type { ArchiveExportV1, ExportedConversationV1 } from './format';

export type ExportFormat = 'json' | 'ndjson' | 'markdown';

export function toJson(archive: ArchiveExportV1): string {
  return `${JSON.stringify(archive, null, 2)}\n`;
}

/**
 * One JSON object per line, discriminated by `record`: a `header` line, then per conversation
 * a `conversation` line followed by its `message` lines. (`record` is used rather than `type`
 * because conversations already have a `type` field.)
 */
export function toNdjson(archive: ArchiveExportV1): string {
  const lines: string[] = [
    JSON.stringify({ record: 'header', format: archive.format, formatVersion: archive.formatVersion, exportedAt: archive.exportedAt, generator: archive.generator }),
  ];
  for (const conversation of archive.conversations) {
    const { messages, ...meta } = conversation;
    lines.push(JSON.stringify({ record: 'conversation', ...meta }));
    for (const message of messages) lines.push(JSON.stringify({ record: 'message', ...message }));
  }
  return `${lines.join('\n')}\n`;
}

export interface MarkdownOptions {
  /** IANA time zone for displayed times; defaults to the runtime's zone. */
  timeZone?: string;
  locale?: string;
}

function escapeMarkdownLine(line: string): string {
  return line.replace(/^(\s*)([#>]|[-+*](?=\s)|\d+[.)](?=\s)|`{3}|-{3,}|={3,})/, '$1\\$2');
}

function escapeInline(text: string): string {
  return text.replace(/([\\*_`[\]])/g, '\\$1');
}

function formatParts(iso: string, options: MarkdownOptions): { day: string; time: string } {
  const date = new Date(iso);
  const day = new Intl.DateTimeFormat(options.locale ?? 'en-GB', {
    timeZone: options.timeZone,
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  }).format(date);
  const time = new Intl.DateTimeFormat(options.locale ?? 'en-GB', {
    timeZone: options.timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
  return { day, time };
}

function senderLabel(message: StoredMessage): string {
  if (message.sender.name) return message.sender.name;
  if (message.sender.isSelf) return 'Me';
  return 'Unknown sender';
}

function attachmentLine(message: StoredMessage): string | null {
  if (message.attachments.length === 0) return null;
  const parts = message.attachments.map((att) => {
    const label = escapeInline(att.name ?? att.kind);
    const prefix = att.kind === 'image' ? 'Image' : att.kind === 'card' ? 'Card' : att.kind === 'link-preview' ? 'Link' : 'File';
    return att.url ? `${prefix}: [${label}](${att.url})` : `${prefix}: ${label}`;
  });
  return `_Attachments:_ ${parts.join(' · ')}`;
}

function conversationToMarkdown(conversation: ExportedConversationV1, byKey: Map<string, StoredMessage>, options: MarkdownOptions): string {
  const lines: string[] = [];
  const zone = options.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  lines.push(`# ${escapeInline(conversation.title ?? conversation.conversationKey)}`, '');
  lines.push(`- Type: ${conversation.type}`);
  if (conversation.participants.length) lines.push(`- Participants: ${conversation.participants.map(escapeInline).join(', ')}`);
  lines.push(`- Messages: ${conversation.messages.length}`);
  const status = coverageStatus(conversation.coverage, conversation.newestSortKey);
  lines.push(`- Archive coverage: ${status === 'complete' ? 'complete history' : status === 'partial' ? 'partial history' : 'unknown'}`);
  lines.push(`- Times shown in: ${zone}`, '', '---', '');

  let currentDay = '';
  for (const message of conversation.messages) {
    const when = message.timestamp ? formatParts(message.timestamp, options) : null;
    if (when && when.day !== currentDay) {
      currentDay = when.day;
      lines.push(`## ${when.day}`, '');
    }
    const time = when ? when.time : 'time unknown';
    if (message.kind === 'system') {
      lines.push(`_${escapeInline(message.text || 'System event')}_ · ${time}`, '');
      continue;
    }
    const flags = [message.isEdited ? 'edited' : '', message.isDeleted ? 'deleted' : ''].filter(Boolean);
    lines.push(`**${escapeInline(senderLabel(message))}** · ${time}${flags.length ? ` _(${flags.join(', ')})_` : ''}`);
    if (message.replyTo) {
      const target = message.replyTo.resolvedKey ? byKey.get(message.replyTo.resolvedKey) : undefined;
      const who = message.replyTo.senderName ?? (target ? senderLabel(target) : 'unknown');
      const preview = (message.replyTo.preview ?? target?.text ?? '').split('\n')[0]?.slice(0, 200) ?? '';
      lines.push(`> Replying to **${escapeInline(who)}**: ${escapeInline(preview)}`);
    }
    lines.push('');
    if (message.text) {
      for (const line of message.text.split('\n')) lines.push(escapeMarkdownLine(line));
      lines.push('');
    }
    const attachments = attachmentLine(message);
    if (attachments) lines.push(attachments, '');
  }
  return lines.join('\n');
}

export function toMarkdown(archive: ArchiveExportV1, options: MarkdownOptions = {}): string {
  const byKey = new Map<string, StoredMessage>();
  for (const conversation of archive.conversations) for (const message of conversation.messages) byKey.set(message.key, message);
  return `${archive.conversations.map((conversation) => conversationToMarkdown(conversation, byKey, options)).join('\n\n')}\n`;
}

export function serializeArchive(archive: ArchiveExportV1, format: ExportFormat, options: MarkdownOptions = {}): string {
  switch (format) {
    case 'json':
      return toJson(archive);
    case 'ndjson':
      return toNdjson(archive);
    case 'markdown':
      return toMarkdown(archive, options);
    default:
      throw new Error(`Unknown export format ${String(format)}`);
  }
}

export function exportFileName(archive: ArchiveExportV1, format: ExportFormat): string {
  const stamp = archive.exportedAt.replace(/[:]/g, '-').replace(/\..+$/, '');
  const single = archive.conversations.length === 1 ? archive.conversations[0] : undefined;
  const base = single ? (single.title ?? 'conversation').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '').slice(0, 60) || 'conversation' : 'teams-archive';
  const extension = format === 'markdown' ? 'md' : format;
  return `${base}-${stamp}.${extension}`;
}
