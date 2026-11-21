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

/**
 * What an export holds when it was made with a date range or content options (added in 1.4).
 * Absent in older exports, which hold everything (images unless made without them).
 */
export interface ExportSelectionV1 {
  /** Message time range, `from` inclusive and `to` exclusive (ISO, UTC); null is open. */
  from: string | null;
  to: string | null;
  images: boolean;
  systemMessages: boolean;
  editHistory: boolean;
}

export interface ExportGeneratorV1 {
  name: string;
  version: string;
  extractorVersion: string;
  schemaVersion: number;
}

export interface ArchiveExportV1 {
  format: typeof EXPORT_FORMAT;
  formatVersion: typeof EXPORT_FORMAT_VERSION;
  exportedAt: string;
  generator: ExportGeneratorV1;
  selection?: ExportSelectionV1;
  conversations: ExportedConversationV1[];
}

export function exportGenerator(version: string = EXTRACTOR_VERSION): ExportGeneratorV1 {
  return { name: 'teams-chat-extractor', version, extractorVersion: EXTRACTOR_VERSION, schemaVersion: ARCHIVE_SCHEMA_VERSION };
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
    generator: exportGenerator(options.generatorVersion),
    conversations,
  };
}

/** The whole export as one JSON text, for small archives and tests (the archive page writes JSON in parts). */
export function toJson(archive: ArchiveExportV1): string {
  return `${JSON.stringify(archive, null, 2)}\n`;
}

export class ImportValidationError extends Error {}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new ImportValidationError(message);
}

/** Checks the format fields of an export (or of the records of a knowledge package). */
export function validateExportHeader(header: { format?: unknown; formatVersion?: unknown }): void {
  assert(header.format === EXPORT_FORMAT, `Unsupported format "${String(header.format)}"`);
  assert(header.formatVersion === EXPORT_FORMAT_VERSION, `Unsupported format version ${String(header.formatVersion)}`);
}

/** Checks the fields of an exported conversation, apart from its messages and images. */
export function validateConversationFields(value: unknown, where: string): asserts value is ConversationRecord {
  assert(value && typeof value === 'object' && !Array.isArray(value), `${where} must be an object`);
  const conversation = value as Partial<ExportedConversationV1>;
  assert(typeof conversation.conversationKey === 'string' && conversation.conversationKey, `${where}.conversationKey is required`);
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
    // Added in extension 1.3.
    const update = conversation.lastUpdate;
    assert(
      update == null ||
        (typeof update === 'object' && typeof update.sessionId === 'string' && typeof update.at === 'string' && typeof update.newestSortKey === 'number' && Number.isFinite(update.newestSortKey)),
      `${where}.lastUpdate must be null or {sessionId, mode, at, newestSortKey}`,
  );
}

/**
 * Checks an exported message. `conversationKey` is its conversation's key; null skips that check
 * (when reading in parts, it is made once the conversation's key is known).
 */
export function validateMessage(value: unknown, conversationKey: string | null, at: string): asserts value is StoredMessage {
  assert(value && typeof value === 'object' && !Array.isArray(value), `${at} must be an object`);
  const message = value as Partial<StoredMessage>;
  assert(typeof message.key === 'string' && message.key, `${at}.key is required`);
  assert(conversationKey === null || message.conversationKey === conversationKey, `${at}.conversationKey does not match its conversation`);
  assert(typeof message.sortKey === 'number' && Number.isFinite(message.sortKey), `${at}.sortKey must be a finite number`);
  assert(typeof message.text === 'string', `${at}.text must be a string`);
  assert(typeof message.contentHash === 'string', `${at}.contentHash must be a string`);
  assert(typeof message.fingerprint === 'string', `${at}.fingerprint must be a string`);
  assert(typeof message.firstSeenAt === 'string' && typeof message.lastSeenAt === 'string', `${at} needs firstSeenAt/lastSeenAt`);
}

/** Checks the descriptive fields of an exported image (`withData`: and that it has `dataBase64`). */
export function validateImageFields(value: unknown, conversationKey: string, at: string, withData = true): asserts value is Omit<ExportedImageV1, 'dataBase64'> {
  const problem = imageMetadataError(withData || !value || typeof value !== 'object' ? value : { dataBase64: '', ...value });
  assert(problem === null, `${at}: ${problem}`);
  const image = value as Partial<ExportedImageV1>;
  assert(image.conversationKey === undefined || image.conversationKey === conversationKey, `${at}.conversationKey does not match its conversation`);
  assert(image.key === undefined || image.key === imageKey(conversationKey, image.imageId as string), `${at}.key does not match its image id`);
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
  validateExportHeader(archive);
  assert(Array.isArray(archive.conversations), '"conversations" must be an array');
  archive.conversations.forEach((conversation, ci) => {
    const where = `conversations[${ci}]`;
    validateConversationFields(conversation, where);
    assert(Array.isArray(conversation.messages), `${where}.messages must be an array`);
    conversation.messages.forEach((message, mi) => validateMessage(message, conversation.conversationKey, `${where}.messages[${mi}]`));
    // Exports made before extractor 1.1 have no images.
    assert(conversation.images === undefined || Array.isArray(conversation.images), `${where}.images must be an array`);
    (conversation.images ?? []).forEach((image, ii) => validateImageFields(image, conversation.conversationKey, `${where}.images[${ii}]`));
  });
  return archive as ArchiveExportV1;
}
