/**
 * Restores (merges) exported archives into the repository. Safe to run repeatedly.
 *
 * - `importArchive` takes a JSON export as text or as a parsed object.
 * - `importArchiveFile` takes a chosen file: a JSON export or a knowledge package (ZIP). It never
 *   reads the file whole. A first pass checks everything (records, and every picture against its
 *   SHA-256), so a damaged file changes nothing; a second pass writes, conversation by
 *   conversation, in chunks.
 */
import { identityEvidence, MAX_EVIDENCE_MESSAGES } from '../extractor/page-parser';
import { newId as randomId } from '../shared/ids';
import { decodeImagePayload, imageBytesError, MAX_IMAGE_BYTES } from '../shared/images';
import type { ConversationIdentity, ConversationRecord, IdentityEvidence, StoredImage, StoredMessage } from '../shared/types';
import { rekeyImage, rekeyMessage, withConversationAliases } from '../storage/conversation-identity';
import { toStoredImage } from '../storage/images';
import { normalizeStoredMessage } from '../storage/merge';
import type { ArchiveRepository, ImportResult } from '../storage/repository';
import { ImportValidationError, parseArchiveExport, validateConversationFields, validateExportHeader, validateImageFields, validateMessage, type ExportedImageV1 } from './format';
import { scanArchiveJson } from './json-scanner';
import { PACKAGE_FORMAT, PACKAGE_FORMAT_VERSION, type PackageImageV1, type PackageManifestV1 } from './pipeline';
import { checkZipPath } from './zip';
import { blobChunks, looksLikeZip, readBlobBytes, readZipDirectory, readZipFile, zipFileLines, type ZipFileInfo } from './zip-reader';

export interface ArchiveImportSummary extends ImportResult {
  conversations: number;
  /** Saved images added to the archive. */
  imagesInserted: number;
  /** Saved images that were already in the archive. */
  imagesUnchanged: number;
  /**
   * Imported conversations added to an archive entry with another key: the chat was renamed, or
   * its entry was merged into another one (for example in a backup made before the merge).
   */
  joinedExisting: number;
  /** Imported conversations given an entry of their own: the entry with their key holds another chat. */
  keptSeparate: number;
}

export interface ImportProgress {
  /** Checking reads the whole file first; nothing is written until it has passed. */
  phase: 'checking' | 'importing';
  conversations: number;
  messages: number;
}

export interface ImportOptions {
  /** Makes the key of an entry of its own (`local:<id>`). */
  newId?: () => string;
  onProgress?: (progress: ImportProgress) => void;
}

const WRITE_BATCH = 500;
const MAX_MANIFEST_BYTES = 64 * 1024 * 1024;

function emptySummary(): ArchiveImportSummary {
  return { conversations: 0, inserted: 0, updated: 0, unchanged: 0, imagesInserted: 0, imagesUnchanged: 0, joinedExisting: 0, keptSeparate: 0 };
}

/** The chat an exported entry was archived from, as the resolver sees an open chat. */
function identityOf(record: ConversationRecord): ConversationIdentity {
  return {
    conversationKey: record.conversationKey,
    threadId: record.threadId ?? null,
    title: record.title ?? null,
    type: record.type ?? 'unknown',
    keySource: record.keySource ?? 'title',
    typeSource: record.typeSource ?? 'unknown',
  };
}

/** The last messages with a Teams id, as identity evidence (what the resolver compares). */
class EvidenceBuffer {
  private readonly items: StoredMessage[] = [];
  add(message: StoredMessage): void {
    if (typeof message.messageId !== 'string' || !message.messageId) return;
    this.items.push(message);
    if (this.items.length > MAX_EVIDENCE_MESSAGES * 2) this.items.splice(0, this.items.length - MAX_EVIDENCE_MESSAGES);
  }
  evidence(): IdentityEvidence {
    return identityEvidence(this.items);
  }
}

/**
 * Writes one exported conversation into the archive: it goes where the same chat is archived
 * here, found the way an open chat is found, and otherwise gets an entry of its own.
 */
class ConversationImport {
  private constructor(
    private readonly repository: ArchiveRepository,
    private readonly summary: ArchiveImportSummary,
    private readonly entry: ConversationRecord,
    private readonly incomingKey: string,
  ) {}

  static async start(repository: ArchiveRepository, record: ConversationRecord, evidence: IdentityEvidence, summary: ArchiveImportSummary, options: ImportOptions): Promise<ConversationImport> {
    const { messages: _messages, images: _images, ...fields } = record as ConversationRecord & { messages?: unknown; images?: unknown };
    const incomingKey = fields.conversationKey;
    const resolution = await repository.resolveConversation(identityOf(fields), evidence);
    const key = resolution.conversationKey ?? `local:${(options.newId ?? randomId)()}`;
    let entry: ConversationRecord = fields;
    if (key !== incomingKey) {
      entry = { ...fields, conversationKey: key, aliases: withConversationAliases({ conversationKey: key, aliases: fields.aliases }, [incomingKey]) };
      if (resolution.conversationKey) summary.joinedExisting++;
      else summary.keptSeparate++;
    }
    await repository.beginImport(entry);
    return new ConversationImport(repository, summary, entry, incomingKey);
  }

  private get key(): string {
    return this.entry.conversationKey;
  }

  async images(images: StoredImage[]): Promise<void> {
    if (images.length === 0) return;
    const placed = this.key === this.incomingKey ? images : images.map((image) => rekeyImage(image, this.key));
    const statuses = await this.repository.putImages(this.key, placed);
    for (const status of Object.values(statuses)) {
      if (status === 'inserted') this.summary.imagesInserted++;
      else this.summary.imagesUnchanged++;
    }
  }

  async messages(messages: StoredMessage[]): Promise<void> {
    if (messages.length === 0) return;
    const placed = this.key === this.incomingKey ? messages : messages.map((message) => rekeyMessage(normalizeStoredMessage(message), this.incomingKey, this.key));
    const result = await this.repository.importMessages(this.key, placed);
    this.summary.inserted += result.inserted;
    this.summary.updated += result.updated;
    this.summary.unchanged += result.unchanged;
  }

  async finish(): Promise<void> {
    await this.repository.finishImport(this.entry);
    this.summary.conversations++;
  }
}

/** Imports a JSON export given as text or as a parsed object (held in memory whole). */
export async function importArchive(repository: ArchiveRepository, input: string | unknown, options: ImportOptions = {}): Promise<ArchiveImportSummary> {
  const archive = parseArchiveExport(input);
  // Decode and verify every image before writing anything, so a damaged file changes nothing.
  const imagesByConversation: StoredImage[][] = [];
  for (const [ci, conversation] of archive.conversations.entries()) {
    const records: StoredImage[] = [];
    for (const [ii, image] of (conversation.images ?? []).entries()) {
      records.push(await storedImageOf(conversation.conversationKey, image, archive.exportedAt, `conversations[${ci}].images[${ii}]`));
    }
    imagesByConversation.push(records);
  }

  const summary = emptySummary();
  for (const [ci, conversation] of archive.conversations.entries()) {
    const { messages, images: _images, ...record } = conversation;
    const writer = await ConversationImport.start(repository, record, identityEvidence(messages), summary, options);
    // Images first: imported messages may refer to them.
    await writer.images(imagesByConversation[ci] ?? []);
    for (let start = 0; start < messages.length; start += WRITE_BATCH) await writer.messages(messages.slice(start, start + WRITE_BATCH));
    await writer.finish();
  }
  return summary;
}

async function storedImageOf(conversationKey: string, image: ExportedImageV1, exportedAt: string, at: string): Promise<StoredImage> {
  const decoded = await decodeImagePayload(image);
  if (!decoded.ok) throw new ImportValidationError(`${at}: ${decoded.error}`);
  return toStoredImage(conversationKey, image, decoded.bytes, {
    sessionId: image.sessionId ?? null,
    nowIso: typeof image.firstSavedAt === 'string' ? image.firstSavedAt : exportedAt,
  });
}

/** Imports a chosen file: a JSON export or a knowledge package. */
export async function importArchiveFile(repository: ArchiveRepository, file: Blob, options: ImportOptions = {}): Promise<ArchiveImportSummary> {
  const head = await readBlobBytes(file, 0, Math.min(file.size, 4));
  return looksLikeZip(head) ? importPackage(repository, file, options) : importJsonFile(repository, file, options);
}

// ------------------------------------------------------------------ JSON

async function* textChunks(file: Blob): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  for await (const chunk of blobChunks(file)) yield decoder.decode(chunk, { stream: true });
  const rest = decoder.decode();
  if (rest) yield rest;
}

interface CheckedConversation {
  record: ConversationRecord;
  evidence: IdentityEvidence;
  messages: number;
}

/** First pass over a JSON export: checks every record and picture, without writing. */
async function checkJsonFile(file: Blob, options: ImportOptions): Promise<{ exportedAt: string; conversations: CheckedConversation[] }> {
  const root: Record<string, unknown> = {};
  let headerChecked = false;
  let sawConversations = false;
  const checked: CheckedConversation[] = [];
  let fields: Record<string, unknown> = {};
  let evidence = new EvidenceBuffer();
  let messageKeys = new Set<string>();
  let imageKeys: Array<{ value: unknown; at: string }> = [];
  let messages = 0;
  const checkHeader = () => {
    if (headerChecked) return;
    validateExportHeader(root);
    headerChecked = true;
  };

  for await (const event of scanArchiveJson(textChunks(file))) {
    switch (event.type) {
      case 'root':
        root[event.key] = event.value;
        break;
      case 'conversations':
        sawConversations = true;
        if ('format' in root && 'formatVersion' in root) checkHeader();
        break;
      case 'conversation-start':
        fields = {};
        evidence = new EvidenceBuffer();
        messageKeys = new Set();
        imageKeys = [];
        break;
      case 'field':
        fields[event.key] = event.value;
        break;
      case 'message': {
        const at = `conversations[${event.index}].messages[${event.position}]`;
        validateMessage(event.value, null, at);
        messageKeys.add(event.value.conversationKey);
        evidence.add(event.value);
        messages++;
        if (messages % 2000 === 0) options.onProgress?.({ phase: 'checking', conversations: checked.length, messages });
        break;
      }
      case 'image': {
        const at = `conversations[${event.index}].images[${event.position}]`;
        // The key is checked at the end of the conversation (its fields may come after the images).
        const value = event.value as ExportedImageV1;
        const decoded = await decodeImagePayload(value);
        if (!decoded.ok) throw new ImportValidationError(`${at}: ${decoded.error}`);
        imageKeys.push({ value: { ...value, dataBase64: '' }, at });
        break;
      }
      case 'conversation-end': {
        const where = `conversations[${event.index}]`;
        validateConversationFields(fields, where);
        if (!event.sawMessages || fields.messages !== undefined) throw new ImportValidationError(`${where}.messages must be an array`);
        if (fields.images !== undefined) throw new ImportValidationError(`${where}.images must be an array`);
        const key = fields.conversationKey as string;
        for (const messageKey of messageKeys) {
          if (messageKey !== key) throw new ImportValidationError(`${where}: a message's conversationKey does not match its conversation`);
        }
        for (const { value, at } of imageKeys) validateImageFields(value, key, at);
        checked.push({ record: fields as unknown as ConversationRecord, evidence: evidence.evidence(), messages: event.messages });
        break;
      }
    }
  }
  checkHeader();
  if (!sawConversations) throw new ImportValidationError('"conversations" must be an array');
  return { exportedAt: typeof root.exportedAt === 'string' ? root.exportedAt : new Date().toISOString(), conversations: checked };
}

async function importJsonFile(repository: ArchiveRepository, file: Blob, options: ImportOptions): Promise<ArchiveImportSummary> {
  const { exportedAt, conversations } = await checkJsonFile(file, options);
  const summary = emptySummary();
  let writer: ConversationImport | null = null;
  let batch: StoredMessage[] = [];
  let written = 0;
  const flush = async () => {
    if (!writer || batch.length === 0) return;
    const messages = batch;
    batch = [];
    await writer.messages(messages);
    written += messages.length;
    options.onProgress?.({ phase: 'importing', conversations: summary.conversations, messages: written });
  };
  for await (const event of scanArchiveJson(textChunks(file))) {
    switch (event.type) {
      case 'conversation-start': {
        const checked = conversations[event.index] as CheckedConversation;
        writer = await ConversationImport.start(repository, checked.record, checked.evidence, summary, options);
        break;
      }
      case 'message':
        batch.push(event.value as StoredMessage);
        if (batch.length >= WRITE_BATCH) await flush();
        break;
      case 'image': {
        const record = conversations[event.index]?.record as ConversationRecord;
        // Stored before the messages written after it; a message written earlier whose image is
        // not stored yet is treated as having no saved image until it is (see archivedImages).
        await flush();
        await writer?.images([await storedImageOf(record.conversationKey, event.value as ExportedImageV1, exportedAt, `conversations[${event.index}].images[${event.position}]`)]);
        break;
      }
      case 'conversation-end':
        await flush();
        await writer?.finish();
        writer = null;
        break;
      default:
        break;
    }
  }
  return summary;
}

// --------------------------------------------------------------- package

interface PackageFiles {
  file: Blob;
  files: Map<string, ZipFileInfo>;
  /** Folder holding manifest.json: '' or `<folder>/` when the package was zipped inside a folder. */
  root: string;
}

function packageError(problem: string): ImportValidationError {
  return new ImportValidationError(`Knowledge package: ${problem}`);
}

function fileIn(pkg: PackageFiles, path: string): ZipFileInfo | undefined {
  return pkg.files.get(`${pkg.root}${path}`);
}

async function readJsonFile(pkg: PackageFiles, path: string): Promise<unknown> {
  const info = fileIn(pkg, path);
  if (!info) throw packageError(`${path} is missing`);
  const text = new TextDecoder().decode(await readZipFile(pkg.file, info, MAX_MANIFEST_BYTES));
  try {
    return JSON.parse(text);
  } catch (error) {
    throw packageError(`${path} is not valid JSON (${(error as Error).message})`);
  }
}

/** Lines of a JSON Lines file, parsed, with their line numbers. */
async function* jsonLines(pkg: PackageFiles, path: string): AsyncGenerator<{ value: unknown; line: number }> {
  const info = fileIn(pkg, path);
  if (!info) throw packageError(`${path} is missing`);
  let line = 0;
  for await (const text of zipFileLines(pkg.file, info)) {
    line++;
    if (text.trim() === '') continue;
    try {
      yield { value: JSON.parse(text), line };
    } catch (error) {
      throw packageError(`${path} line ${line} is not valid JSON (${(error as Error).message})`);
    }
  }
}

function checkRelativePath(path: unknown, what: string): string {
  if (typeof path !== 'string') throw packageError(`${what} must be a path`);
  try {
    checkZipPath(path);
  } catch {
    throw packageError(`${what} "${path}" is not a safe path in the package`);
  }
  return path;
}

async function openPackage(file: Blob): Promise<{ pkg: PackageFiles; manifest: PackageManifestV1 }> {
  const files = await readZipDirectory(file);
  let root = '';
  if (!files.has('manifest.json')) {
    // A package unzipped and zipped again inside its folder.
    const nested = [...files.keys()].filter((path) => /^[^/]+\/manifest\.json$/.test(path));
    if (nested.length !== 1) throw new ImportValidationError('This ZIP is not a knowledge package (it has no manifest.json). Only JSON exports and knowledge packages can be imported.');
    root = (nested[0] as string).slice(0, -'manifest.json'.length);
  }
  const pkg: PackageFiles = { file, files, root };
  const manifest = (await readJsonFile(pkg, 'manifest.json')) as Partial<PackageManifestV1> | null;
  if (!manifest || typeof manifest !== 'object') throw packageError('manifest.json must be an object');
  if (manifest.format !== PACKAGE_FORMAT) throw packageError(`unsupported format "${String(manifest.format)}"`);
  if (manifest.formatVersion !== PACKAGE_FORMAT_VERSION) throw packageError(`unsupported format version ${String(manifest.formatVersion)}`);
  validateExportHeader(manifest.records ?? {});
  if (!Array.isArray(manifest.conversations)) throw packageError('"conversations" in manifest.json must be an array');
  manifest.conversations.forEach((entry, ci) => {
    if (!entry || typeof entry !== 'object' || typeof entry.conversationKey !== 'string' || !entry.conversationKey) throw packageError(`conversations[${ci}] in manifest.json needs a conversationKey`);
    checkRelativePath(entry.folder, `conversations[${ci}].folder`);
  });
  return { pkg, manifest: manifest as PackageManifestV1 };
}

/** The image lines of a conversation, each with its file read and checked against its SHA-256 name. */
async function* packageImages(pkg: PackageFiles, folder: string, conversationKey: string, exportedAt: string): AsyncGenerator<StoredImage> {
  const path = `${folder}/images.jsonl`;
  if (!fileIn(pkg, path)) return;
  for await (const { value, line } of jsonLines(pkg, path)) {
    const at = `${path} line ${line}`;
    validateImageFields(value, conversationKey, at, false);
    const image = value as PackageImageV1;
    const filePath = `${folder}/${checkRelativePath(image.file, `${at}: file`)}`;
    const info = fileIn(pkg, filePath);
    if (!info) throw packageError(`${at}: ${filePath} is missing`);
    const bytes = await readZipFile(pkg.file, info, MAX_IMAGE_BYTES);
    const problem = await imageBytesError(image, bytes);
    if (problem) throw packageError(`${filePath}: ${problem}`);
    yield toStoredImage(conversationKey, image, bytes, { sessionId: image.sessionId ?? null, nowIso: typeof image.firstSavedAt === 'string' ? image.firstSavedAt : exportedAt });
  }
}

async function* packageMessages(pkg: PackageFiles, folder: string, conversationKey: string): AsyncGenerator<StoredMessage> {
  const path = `${folder}/messages.jsonl`;
  for await (const { value, line } of jsonLines(pkg, path)) {
    validateMessage(value, conversationKey, `${path} line ${line}`);
    yield value;
  }
}

async function packageRecord(pkg: PackageFiles, folder: string, conversationKey: string): Promise<ConversationRecord> {
  const path = `${folder}/conversation.json`;
  const record = await readJsonFile(pkg, path);
  validateConversationFields(record, path);
  if (record.conversationKey !== conversationKey) throw packageError(`${path}: conversationKey does not match manifest.json`);
  return record;
}

async function importPackage(repository: ArchiveRepository, file: Blob, options: ImportOptions): Promise<ArchiveImportSummary> {
  const { pkg, manifest } = await openPackage(file);
  const exportedAt = typeof manifest.exportedAt === 'string' ? manifest.exportedAt : new Date().toISOString();

  // First pass: check every record and picture.
  const checked: CheckedConversation[] = [];
  let messages = 0;
  for (const entry of manifest.conversations) {
    const record = await packageRecord(pkg, entry.folder, entry.conversationKey);
    const evidence = new EvidenceBuffer();
    let count = 0;
    for await (const message of packageMessages(pkg, entry.folder, entry.conversationKey)) {
      evidence.add(message);
      count++;
      if (++messages % 2000 === 0) options.onProgress?.({ phase: 'checking', conversations: checked.length, messages });
    }
    for await (const _image of packageImages(pkg, entry.folder, entry.conversationKey, exportedAt)) {
      // Each picture is read and checked against its SHA-256.
    }
    checked.push({ record, evidence: evidence.evidence(), messages: count });
  }

  // Second pass: write.
  const summary = emptySummary();
  let written = 0;
  for (const [ci, entry] of manifest.conversations.entries()) {
    const { record, evidence } = checked[ci] as CheckedConversation;
    const writer = await ConversationImport.start(repository, record, evidence, summary, options);
    // Images first: imported messages may refer to them.
    for await (const image of packageImages(pkg, entry.folder, entry.conversationKey, exportedAt)) await writer.images([image]);
    let batch: StoredMessage[] = [];
    for await (const message of packageMessages(pkg, entry.folder, entry.conversationKey)) {
      batch.push(message);
      if (batch.length < WRITE_BATCH) continue;
      await writer.messages(batch);
      written += batch.length;
      batch = [];
      options.onProgress?.({ phase: 'importing', conversations: summary.conversations, messages: written });
    }
    await writer.messages(batch);
    written += batch.length;
    await writer.finish();
    options.onProgress?.({ phase: 'importing', conversations: summary.conversations, messages: written });
  }
  return summary;
}
