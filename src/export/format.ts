/**
 * Archive export format v1 — the hand-off contract for downstream systems
 * (for example a knowledge management system). It is lossless: importing an export
 * restores the archive exactly, and re-importing is idempotent.
 *
 * Stability promise: fields are only ever added in v1; renames/removals require formatVersion 2.
 * See docs/EXPORT_FORMAT.md for field documentation.
 */
import { bytesToBase64, imageKey, imageMetadataError } from '../shared/images';
import type { ConversationRecord, StoredImage, StoredMessage } from '../shared/types';
import { ARCHIVE_SCHEMA_VERSION, EXTRACTOR_VERSION } from '../shared/types';

export const EXPORT_FORMAT = 'teams-chat-archive';
export const EXPORT_FORMAT_VERSION = 1;

/** A saved image: every stored field except the bytes, which are given as base64. */
export interface ExportedImageV1 extends Omit<StoredImage, 'data'> {
  dataBase64: string;
}

export interface ExportedConversationV1 extends ConversationRecord {
  /** Messages in timeline order (sortKey ascending). */
  messages: StoredMessage[];
  /**
   * Saved images that attachments refer to by `imageId`, ordered by `firstSavedAt`.
   * Added in extractor 1.1; absent in older exports and in exports made without images.
   */
  images?: ExportedImageV1[];
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
  /** Saved images of a conversation; without it the export contains no images. */
  getImages?(conversationKey: string): Promise<StoredImage[]>;
}

export interface BuildExportOptions {
  now?: Date;
  generatorVersion?: string;
  /** Include saved images (default true when the source provides them). */
  includeImages?: boolean;
}

export function toExportedImage(image: StoredImage): ExportedImageV1 {
  const { data, ...fields } = image;
  return { ...fields, dataBase64: bytesToBase64(new Uint8Array(data)) };
}

export async function buildArchiveExport(
  source: ExportSource,
  conversationKeys: string[] | 'all',
  options: BuildExportOptions = {},
): Promise<ArchiveExportV1> {
  const records =
    conversationKeys === 'all'
      ? await source.listConversations()
      : (await Promise.all(conversationKeys.map((key) => source.getConversation(key)))).filter(
          (record): record is ConversationRecord => record !== undefined,
        );
  const conversations: ExportedConversationV1[] = [];
  const includeImages = options.includeImages !== false;
  for (const record of records) {
    const conversation: ExportedConversationV1 = { ...record, messages: await source.getMessages(record.conversationKey) };
    if (includeImages && source.getImages) {
      const images = await source.getImages(record.conversationKey);
      images.sort((a, b) => a.firstSavedAt.localeCompare(b.firstSavedAt) || a.imageId.localeCompare(b.imageId));
      conversation.images = images.map(toExportedImage);
    }
    conversations.push(conversation);
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
    // Identity fields, added with schema 3 (extension 1.2); absent in older exports.
    const strings = (value: unknown) => Array.isArray(value) && value.every((item) => typeof item === 'string');
    assert(conversation.aliases === undefined || strings(conversation.aliases), `${where}.aliases must be an array of strings`);
    assert(conversation.mergedFrom === undefined || strings(conversation.mergedFrom), `${where}.mergedFrom must be an array of strings`);
    assert(conversation.displayName == null || typeof conversation.displayName === 'string', `${where}.displayName must be a string or null`);
    assert(
      conversation.titleHistory === undefined ||
        (Array.isArray(conversation.titleHistory) &&
          conversation.titleHistory.every((seen) => seen && typeof seen.title === 'string' && typeof seen.firstSeenAt === 'string' && typeof seen.lastSeenAt === 'string')),
      `${where}.titleHistory must be an array of {title, firstSeenAt, lastSeenAt}`,
    );
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
    // Exports made before extractor 1.1 have no images.
    assert(conversation.images === undefined || Array.isArray(conversation.images), `${where}.images must be an array`);
    (conversation.images ?? []).forEach((image, ii) => {
      const at = `${where}.images[${ii}]`;
      const problem = imageMetadataError(image);
      assert(problem === null, `${at}: ${problem}`);
      assert(image.conversationKey === undefined || image.conversationKey === conversation.conversationKey, `${at}.conversationKey does not match its conversation`);
      assert(image.key === undefined || image.key === imageKey(conversation.conversationKey, image.imageId), `${at}.key does not match its image id`);
    });
  });
  return archive as ArchiveExportV1;
}
