/**
 * Archive export format v1 — the hand-off contract for downstream systems
 * (for example a knowledge management system). It is lossless: importing an export
 * restores the archive exactly, and re-importing is idempotent.
 *
 * Stability promise: fields are only ever added in v1; renames/removals require formatVersion 2.
 * See docs/EXPORT_FORMAT.md for field documentation.
 */
import type { ConversationRecord, StoredMessage } from '../shared/types';
import { ARCHIVE_SCHEMA_VERSION, EXTRACTOR_VERSION } from '../shared/types';

export const EXPORT_FORMAT = 'teams-chat-archive';
export const EXPORT_FORMAT_VERSION = 1;

export interface ExportedConversationV1 extends ConversationRecord {
  /** Messages in timeline order (sortKey ascending). */
  messages: StoredMessage[];
}

export interface ArchiveExportV1 {
  format: typeof EXPORT_FORMAT;
  formatVersion: typeof EXPORT_FORMAT_VERSION;
  exportedAt: string;
  generator: { name: string; version: string; extractorVersion: string; schemaVersion: number };
  conversations: ExportedConversationV1[];
}

export interface ExportSource {
  getConversation(conversationKey: string): Promise<ConversationRecord | undefined>;
  listConversations(): Promise<ConversationRecord[]>;
  getMessages(conversationKey: string): Promise<StoredMessage[]>;
}

export async function buildArchiveExport(
  source: ExportSource,
  conversationKeys: string[] | 'all',
  options: { now?: Date; generatorVersion?: string } = {},
): Promise<ArchiveExportV1> {
  const records =
    conversationKeys === 'all'
      ? await source.listConversations()
      : (await Promise.all(conversationKeys.map((key) => source.getConversation(key)))).filter(
          (record): record is ConversationRecord => record !== undefined,
        );
  const conversations: ExportedConversationV1[] = [];
  for (const record of records) {
    conversations.push({ ...record, messages: await source.getMessages(record.conversationKey) });
  }
  return {
    format: EXPORT_FORMAT,
    formatVersion: EXPORT_FORMAT_VERSION,
    exportedAt: (options.now ?? new Date()).toISOString(),
    generator: {
      name: 'teams-chat-extractor',
      version: options.generatorVersion ?? EXTRACTOR_VERSION,
      extractorVersion: EXTRACTOR_VERSION,
      schemaVersion: ARCHIVE_SCHEMA_VERSION,
    },
    conversations,
  };
}

export class ImportValidationError extends Error {}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new ImportValidationError(message);
}

/** Parses and validates an exported archive (JSON text or an already parsed object). */
export function parseArchiveExport(input: string | unknown): ArchiveExportV1 {
  let data: unknown = input;
  if (typeof input === 'string') {
    try {
      data = JSON.parse(input);
    } catch (error) {
      throw new ImportValidationError(`Not valid JSON: ${(error as Error).message}`);
    }
  }
  assert(data && typeof data === 'object', 'Archive must be a JSON object');
  const archive = data as Partial<ArchiveExportV1>;
  assert(archive.format === EXPORT_FORMAT, `Unsupported format "${String(archive.format)}"`);
  assert(archive.formatVersion === EXPORT_FORMAT_VERSION, `Unsupported format version ${String(archive.formatVersion)}`);
  assert(Array.isArray(archive.conversations), '"conversations" must be an array');
  archive.conversations.forEach((conversation, ci) => {
    const where = `conversations[${ci}]`;
    assert(conversation && typeof conversation === 'object', `${where} must be an object`);
    assert(typeof conversation.conversationKey === 'string' && conversation.conversationKey, `${where}.conversationKey is required`);
    assert(Array.isArray(conversation.messages), `${where}.messages must be an array`);
    assert(Array.isArray(conversation.coverage ?? []), `${where}.coverage must be an array`);
    conversation.messages.forEach((message, mi) => {
      const at = `${where}.messages[${mi}]`;
      assert(message && typeof message === 'object', `${at} must be an object`);
      assert(typeof message.key === 'string' && message.key, `${at}.key is required`);
      assert(message.conversationKey === conversation.conversationKey, `${at}.conversationKey does not match its conversation`);
      assert(typeof message.sortKey === 'number' && Number.isFinite(message.sortKey), `${at}.sortKey must be a finite number`);
      assert(typeof message.text === 'string', `${at}.text must be a string`);
      assert(typeof message.contentHash === 'string', `${at}.contentHash must be a string`);
      assert(typeof message.fingerprint === 'string', `${at}.fingerprint must be a string`);
      assert(typeof message.firstSeenAt === 'string' && typeof message.lastSeenAt === 'string', `${at} needs firstSeenAt/lastSeenAt`);
    });
  });
  return archive as ArchiveExportV1;
}
