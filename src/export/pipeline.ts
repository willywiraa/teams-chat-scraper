/**
 * The export pipeline: reads the chosen conversations page by page and writes them in the
 * chosen format, into a Blob (or, for printing, into a page). Nothing is held whole: messages
 * are read in pages, pictures one at a time, and the output is written in parts.
 *
 * Each conversation is read twice: a first pass counts what the export will hold (messages,
 * pictures, the messages replies point to), so headers and records can say so up front.
 */
import { bytesToBase64, imageFileName, sha256Hex } from '../shared/images';
import { conversationLabel, isReliableSortSource, type ConversationRecord, type StoredImage, type StoredMessage } from '../shared/types';
import { EXPORT_FORMAT, EXPORT_FORMAT_VERSION, exportGenerator, toExportedImage, type ExportSelectionV1 } from './format';
import {
  clipCoverage,
  effectiveContent,
  FORMATS,
  isOpenRange,
  packagingsFor,
  type ExportContent,
  type ExportFormat,
  type Packaging,
  type TimeRange,
} from './options';
import {
  csvMessage,
  csvStart,
  htmlConversationEnd,
  htmlConversationStart,
  htmlDay,
  htmlDocumentEnd,
  htmlDocumentStart,
  htmlIndex,
  htmlMessage,
  markdownConversationStart,
  markdownDay,
  markdownMessage,
  replyTargetOf,
  textConversationStart,
  textDay,
  textMessage,
  timeFormat,
  timeLabel,
  type ConversationSummary,
  type PictureRef,
  type RenderContext,
  type ReplyTarget,
  type TimeFormat,
} from './render';
import { BlobSink, type TextSink } from './sink';
import { ZipWriter, type ZipFileWriter } from './zip';

/** A saved image without its bytes. */
export type ImageInfo = Omit<StoredImage, 'data'>;

/** What the pipeline reads; `ArchiveRepository` provides it. */
export interface ExportReader {
  getConversation(conversationKey: string): Promise<ConversationRecord | undefined>;
  listConversations(): Promise<ConversationRecord[]>;
  /** Messages in timeline order, in pages, limited to the range (by `sortKey`). */
  messagePages(conversationKey: string, range: TimeRange): AsyncIterable<StoredMessage[]>;
  /** The saved images of a conversation without their bytes, oldest first. */
  imageCatalog(conversationKey: string): Promise<ImageInfo[]>;
  getImage(conversationKey: string, imageId: string): Promise<StoredImage | undefined>;
}

export interface ExportRequest {
  conversations: string[] | 'all';
  format: ExportFormat;
  packaging: Packaging;
  range: TimeRange;
  content: ExportContent;
  /** IANA time zone for displayed times; defaults to the runtime's zone. */
  timeZone?: string;
  locale?: string;
  now?: Date;
  /** Extension version, recorded in JSON exports and packages. */
  generatorVersion?: string;
}

export interface ExportProgress {
  /** 1-based number of the conversation being written. */
  conversation: number;
  conversations: number;
  messages: number;
}

export interface ExportTotals {
  conversations: number;
  messages: number;
  pictures: number;
}

export interface ExportOutcome extends ExportTotals {
  blob: Blob;
  fileName: string;
}

type Progress = (progress: ExportProgress) => void;

export const PACKAGE_FORMAT = 'teams-chat-archive-package';
export const PACKAGE_FORMAT_VERSION = 1;

/** The manifest of a knowledge package (`manifest.json`). */
export interface PackageManifestV1 {
  format: typeof PACKAGE_FORMAT;
  formatVersion: typeof PACKAGE_FORMAT_VERSION;
  exportedAt: string;
  generator: ReturnType<typeof exportGenerator>;
  /** The record format of `conversation.json`, `messages.jsonl` and `images.jsonl`. */
  records: { format: typeof EXPORT_FORMAT; formatVersion: typeof EXPORT_FORMAT_VERSION };
  selection: ExportSelectionV1;
  /** Time zone of the times shown in the transcripts. */
  timeZone: string;
  conversations: PackageConversationV1[];
}

export interface PackageConversationV1 {
  conversationKey: string;
  /** Name shown for the chat (its name in the archive, else its Teams title). */
  name: string;
  /** Folder of the conversation's files, from the package root. */
  folder: string;
  messages: number;
  images: number;
}

/** One line of a package's `images.jsonl`: the image record without its data, and its file. */
export type PackageImageV1 = ImageInfo & { file: string };

// ------------------------------------------------------------- preparing

interface Plan extends Required<Omit<ExportRequest, 'timeZone' | 'locale' | 'conversations'>> {
  time: TimeFormat;
}

function plan(request: ExportRequest): Plan {
  let content = effectiveContent(request.format, request.content);
  const packagings = packagingsFor(request.format, content);
  const packaging = packagings.includes(request.packaging) ? request.packaging : (packagings[0] as Packaging);
  // A single file of a format that can't hold pictures has none.
  if (packaging === 'file' && !FORMATS[request.format].embedsPictures) content = { ...content, images: false };
  return {
    format: request.format,
    packaging,
    range: request.range,
    content,
    now: request.now ?? new Date(),
    generatorVersion: request.generatorVersion ?? exportGenerator().version,
    time: timeFormat(request.timeZone, request.locale),
  };
}

export function selectionOf(range: TimeRange, content: ExportContent): ExportSelectionV1 {
  return {
    from: range.from === null ? null : new Date(range.from).toISOString(),
    to: range.to === null ? null : new Date(range.to).toISOString(),
    images: content.images,
    systemMessages: content.systemMessages,
    editHistory: content.editHistory,
  };
}

async function recordsOf(reader: ExportReader, keys: string[] | 'all'): Promise<ConversationRecord[]> {
  if (keys === 'all') return reader.listConversations();
  const records = await Promise.all(keys.map((key) => reader.getConversation(key)));
  return records.filter((record): record is ConversationRecord => record !== undefined);
}

function keeps(content: ExportContent): (message: StoredMessage) => boolean {
  return (message) => content.systemMessages || message.kind !== 'system';
}

/** A message as an export's records hold it. */
export function exportedMessage(message: StoredMessage, content: ExportContent): StoredMessage {
  return content.editHistory || (message.previousVersions ?? []).length === 0 ? message : { ...message, previousVersions: [] };
}

/** What a conversation's export holds, from the first pass. */
interface Survey {
  messages: number;
  oldest: number | null;
  newest: number | null;
  /** Saved pictures the exported messages show, in the order they first appear. */
  pictureIds: string[];
  /** Messages that replies point to without quoting them. */
  replyTargets: Set<string>;
  catalog: Map<string, ImageInfo>;
}

async function survey(reader: ExportReader, record: ConversationRecord, plan: Plan): Promise<Survey> {
  const catalog = new Map((plan.content.images ? await reader.imageCatalog(record.conversationKey) : []).map((image) => [image.imageId, image]));
  const result: Survey = { messages: 0, oldest: null, newest: null, pictureIds: [], replyTargets: new Set(), catalog };
  const seen = new Set<string>();
  const keep = keeps(plan.content);
  for await (const page of reader.messagePages(record.conversationKey, plan.range)) {
    for (const message of page) {
      if (!keep(message)) continue;
      result.messages++;
      if (isReliableSortSource(message.sortKeySource)) {
        result.oldest = result.oldest === null ? message.sortKey : Math.min(result.oldest, message.sortKey);
        result.newest = result.newest === null ? message.sortKey : Math.max(result.newest, message.sortKey);
      }
      for (const att of message.attachments) {
        if (att.kind === 'image' && att.imageId && catalog.has(att.imageId) && !seen.has(att.imageId)) {
          seen.add(att.imageId);
          result.pictureIds.push(att.imageId);
        }
      }
      const reply = message.replyTo;
      if (plan.content.replies && reply?.resolvedKey && (reply.preview === null || reply.senderName === null)) result.replyTargets.add(reply.resolvedKey);
    }
  }
  return result;
}

/**
 * The conversation record as an export of a part of it holds it: counts and the reliable
 * message range of what is exported, coverage limited to the range, and the last update only
 * when the export reaches the newest messages.
 */
export function exportedRecord(record: ConversationRecord, part: { messages: number; oldest: number | null; newest: number | null }, range: TimeRange, content: ExportContent): ConversationRecord {
  if (isOpenRange(range) && content.systemMessages) return record;
  return {
    ...record,
    messageCount: part.messages,
    oldestSortKey: part.oldest,
    newestSortKey: part.newest,
    coverage: clipCoverage(record.coverage, range),
    lastUpdate: range.to === null ? (record.lastUpdate ?? null) : null,
  };
}

function slug(text: string | null | undefined, fallback: string): string {
  return (text ?? '').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '').slice(0, 60) || fallback;
}

/** File name of an export: after the conversation when there is one, with the export time. */
export function exportFileNameFor(records: readonly ConversationRecord[], now: Date, extension: string, kind = ''): string {
  const stamp = now.toISOString().replace(/[:]/g, '-').replace(/\..+$/, '');
  const single = records.length === 1 ? records[0] : undefined;
  const base = single ? slug(single.displayName || single.title, 'conversation') : 'teams-archive';
  return `${base}${kind ? `-${kind}` : ''}-${stamp}.${extension}`;
}

/** Folder names for several conversations in one ZIP: after their names, made unique. */
function uniqueFolders(records: readonly ConversationRecord[]): string[] {
  const used = new Set<string>();
  return records.map((record) => {
    const base = slug(record.displayName || record.title, 'conversation');
    let folder = base;
    for (let n = 2; used.has(folder.toLowerCase()); n++) folder = `${base}-${n}`;
    used.add(folder.toLowerCase());
    return folder;
  });
}

/** Keeps the messages that replies point to, as they are written. */
class ReplyIndex {
  private readonly targets = new Map<string, ReplyTarget>();
  constructor(private readonly wanted: Set<string>) {}
  note(message: StoredMessage): void {
    if (this.wanted.has(message.key)) this.targets.set(message.key, replyTargetOf(message));
  }
  get(key: string): ReplyTarget | undefined {
    return this.targets.get(key);
  }
}

function extensionOf(image: { imageId: string; mimeType: string }): string {
  return imageFileName(image).split('.').pop() as string;
}

/** How the pictures of the messages being written are shown. */
interface PictureSource {
  /** Prepares the pictures of a page of messages. */
  prepare(page: readonly StoredMessage[]): Promise<void>;
  get(imageId: string): PictureRef | undefined;
}

function imageIdsOf(page: readonly StoredMessage[], catalog: ReadonlyMap<string, ImageInfo>): string[] {
  const ids: string[] = [];
  for (const message of page) for (const att of message.attachments) if (att.kind === 'image' && att.imageId && catalog.has(att.imageId)) ids.push(att.imageId);
  return ids;
}

const noPictures: PictureSource = { prepare: async () => undefined, get: () => undefined };

/** Pictures embedded as data URIs, read again for each page (so only one page's are held). */
function embeddedPictures(reader: ExportReader, conversationKey: string, catalog: ReadonlyMap<string, ImageInfo>): PictureSource {
  let current = new Map<string, PictureRef>();
  return {
    async prepare(page) {
      current = new Map();
      for (const imageId of imageIdsOf(page, catalog)) {
        if (current.has(imageId)) continue;
        const image = await reader.getImage(conversationKey, imageId);
        if (image) current.set(imageId, { src: `data:${image.mimeType};base64,${bytesToBase64(new Uint8Array(image.data))}`, width: image.width, height: image.height });
      }
    },
    get: (imageId) => current.get(imageId),
  };
}

/** Pictures shown from addresses the caller makes (object URLs for printing). */
function linkedPictures(reader: ExportReader, conversationKey: string, catalog: ReadonlyMap<string, ImageInfo>, address: (image: StoredImage) => string): PictureSource {
  const known = new Map<string, PictureRef>();
  return {
    async prepare(page) {
      for (const imageId of imageIdsOf(page, catalog)) {
        if (known.has(imageId)) continue;
        const image = await reader.getImage(conversationKey, imageId);
        if (image) known.set(imageId, { src: address(image), width: image.width, height: image.height });
      }
    },
    get: (imageId) => known.get(imageId),
  };
}

/** Pictures written as files into a ZIP, each once, the first time a message shows it. */
function filedPictures(
  reader: ExportReader,
  conversationKey: string,
  catalog: ReadonlyMap<string, ImageInfo>,
  zip: ZipWriter,
  folder: string,
  name: (image: ImageInfo, message: StoredMessage) => string,
): PictureSource & { written: ImageInfo[]; files: Map<string, string>; add(image: StoredImage, file: string): void } {
  const known = new Map<string, PictureRef>();
  const files = new Map<string, string>();
  const written: ImageInfo[] = [];
  const add = (image: StoredImage, file: string) => {
    zip.add(`${folder}${file}`, new Uint8Array(image.data));
    const { data: _data, ...info } = image;
    written.push(info);
    files.set(image.imageId, file);
    known.set(image.imageId, { src: file, file: file.split('/').pop(), width: image.width, height: image.height });
  };
  return {
    written,
    files,
    add,
    async prepare(page) {
      for (const message of page) {
        for (const att of message.attachments) {
          const info = att.kind === 'image' && att.imageId ? catalog.get(att.imageId) : undefined;
          if (!info || known.has(info.imageId)) continue;
          const image = await reader.getImage(conversationKey, info.imageId);
          if (image) add(image, `images/${name(info, message)}`);
        }
      }
    },
    get: (imageId) => known.get(imageId),
  };
}

/** `001_2024-01-15_0930.png`: number in order of appearance, then the time of the first message showing it. */
function numberedName(time: TimeFormat, total: number): (image: ImageInfo, message: StoredMessage) => string {
  const width = Math.max(3, String(total).length);
  let next = 1;
  return (image, message) => `${String(next++).padStart(width, '0')}_${message.timestamp ? time.fileStamp(message.timestamp) : 'unknown-time'}.${extensionOf(image)}`;
}

// --------------------------------------------------------- transcripts

type TranscriptFormat = 'html' | 'markdown' | 'text' | 'csv';

interface TranscriptRenderer {
  file: string;
  start(title: string, content: ExportContent): string;
  conversation(record: ConversationRecord, summary: ConversationSummary, time: TimeFormat, first: boolean): string;
  day(day: string): string;
  message(record: ConversationRecord, message: StoredMessage, ctx: RenderContext): string;
  endConversation(): string;
  end(): string;
}

const RENDERERS: Record<TranscriptFormat, TranscriptRenderer> = {
  html: {
    file: 'chat.html',
    start: (title) => htmlDocumentStart(title),
    conversation: (record, summary, time) => htmlConversationStart(record, summary, time),
    day: htmlDay,
    message: (_record, message, ctx) => htmlMessage(message, ctx),
    endConversation: htmlConversationEnd,
    end: htmlDocumentEnd,
  },
  markdown: {
    file: 'chat.md',
    start: () => '',
    conversation: (record, summary, time, first) => `${first ? '' : '\n'}${markdownConversationStart(record, summary, time)}`,
    day: markdownDay,
    message: (_record, message, ctx) => markdownMessage(message, ctx),
    endConversation: () => '',
    end: () => '',
  },
  text: {
    file: 'chat.txt',
    start: () => '',
    conversation: (record, summary, time, first) => `${first ? '' : '\n'}${textConversationStart(record, summary, time)}`,
    day: textDay,
    message: (_record, message, ctx) => textMessage(message, ctx),
    endConversation: () => '',
    end: () => '',
  },
  csv: {
    file: 'messages.csv',
    start: (_title, content) => csvStart(content),
    conversation: () => '',
    day: () => '',
    message: (record, message, ctx) => csvMessage(record, message, ctx),
    endConversation: () => '',
    end: () => '',
  },
};

interface Writing {
  reader: ExportReader;
  plan: Plan;
  onProgress?: Progress;
  totals: ExportTotals;
  index: number;
  count: number;
}

/** Writes one conversation with a renderer: its header, then its messages page by page. */
async function writeConversation(
  w: Writing,
  record: ConversationRecord,
  facts: Survey,
  renderer: TranscriptRenderer,
  write: TextSink,
  pictures: PictureSource,
  first: boolean,
  picturesIn?: ConversationSummary['picturesIn'],
): Promise<void> {
  const { plan } = w;
  const shown = plan.content.images && pictures !== noPictures ? facts.pictureIds.length : 0;
  write(renderer.conversation(record, { messages: facts.messages, pictures: shown, picturesIn, range: plan.range }, plan.time, first));
  const replies = new ReplyIndex(facts.replyTargets);
  const ctx: RenderContext = { content: plan.content, time: plan.time, picture: (id) => pictures.get(id), replyTarget: (key) => replies.get(key) };
  const keep = keeps(plan.content);
  let currentDay: string | null = null;
  for await (const page of w.reader.messagePages(record.conversationKey, plan.range)) {
    const kept = page.filter(keep);
    await pictures.prepare(kept);
    let text = '';
    for (const message of kept) {
      const { day } = timeLabel(message, plan.time);
      if (day && day !== currentDay) {
        currentDay = day;
        text += renderer.day(day);
      }
      text += renderer.message(record, message, ctx);
      replies.note(message);
    }
    write(text);
    w.totals.messages += kept.length;
    w.onProgress?.({ conversation: w.index + 1, conversations: w.count, messages: w.totals.messages });
  }
  write(renderer.endConversation());
  w.totals.pictures += shown;
}

async function writeTranscripts(w: Writing, records: ConversationRecord[], format: TranscriptFormat, output: { sink: TextSink } | { zip: ZipWriter }, address?: (image: StoredImage) => string): Promise<void> {
  const renderer = RENDERERS[format];
  const { plan } = w;
  const title = records.length === 1 ? conversationLabel(records[0] as ConversationRecord) : 'Teams chats';
  if ('sink' in output) {
    output.sink(renderer.start(title, plan.content));
    for (const [i, record] of records.entries()) {
      w.index = i;
      const facts = await survey(w.reader, record, plan);
      const pictures = !plan.content.images
        ? noPictures
        : address
          ? linkedPictures(w.reader, record.conversationKey, facts.catalog, address)
          : embeddedPictures(w.reader, record.conversationKey, facts.catalog);
      await writeConversation(w, record, facts, renderer, output.sink, pictures, i === 0);
      w.totals.conversations++;
    }
    output.sink(renderer.end());
    return;
  }
  const { zip } = output;
  const folders = records.length === 1 ? [''] : uniqueFolders(records);
  const index: Array<{ folder: string; label: string; messages: number; pictures: number }> = [];
  for (const [i, record] of records.entries()) {
    w.index = i;
    const folder = folders[i] ? `${folders[i]}/` : '';
    const facts = await survey(w.reader, record, plan);
    const file: ZipFileWriter = zip.open(`${folder}${renderer.file}`);
    const pictures = plan.content.images ? filedPictures(w.reader, record.conversationKey, facts.catalog, zip, folder, numberedName(plan.time, facts.pictureIds.length)) : noPictures;
    const write: TextSink = (text) => file.write(text);
    write(renderer.start(conversationLabel(record), plan.content));
    const before = w.totals.pictures;
    await writeConversation(w, record, facts, renderer, write, pictures, true, 'folder');
    write(renderer.end());
    file.close();
    w.totals.conversations++;
    index.push({ folder: folders[i] as string, label: conversationLabel(record), messages: facts.messages, pictures: w.totals.pictures - before });
  }
  if (format === 'html' && records.length > 1) zip.add('index.html', htmlIndex(index));
}

// ---------------------------------------------------------------- JSON

function jsonFields(value: object, indent: string): string {
  return Object.entries(value)
    .filter(([, field]) => field !== undefined)
    .map(([key, field]) => `${indent}${JSON.stringify(key)}: ${JSON.stringify(field)}`)
    .join(',\n');
}

/** Images a record export holds: every saved one for an export without a date range, else the ones shown. */
function exportedImageIds(facts: Survey, plan: Plan): string[] {
  if (!plan.content.images) return [];
  if (isOpenRange(plan.range)) return [...facts.catalog.keys()];
  const shown = new Set(facts.pictureIds);
  return [...facts.catalog.keys()].filter((id) => shown.has(id));
}

async function writeJson(w: Writing, records: ConversationRecord[], write: TextSink): Promise<void> {
  const { plan } = w;
  const header = {
    format: EXPORT_FORMAT,
    formatVersion: EXPORT_FORMAT_VERSION,
    exportedAt: plan.now.toISOString(),
    generator: exportGenerator(plan.generatorVersion),
    selection: selectionOf(plan.range, plan.content),
  };
  write(`{\n${jsonFields(header, '  ')},\n  "conversations": [`);
  const keep = keeps(plan.content);
  for (const [i, record] of records.entries()) {
    w.index = i;
    const facts = await survey(w.reader, record, plan);
    const { messages: _m, images: _i, ...fields } = exportedRecord(record, facts, plan.range, plan.content) as ConversationRecord & { messages?: unknown; images?: unknown };
    write(`${i > 0 ? ',' : ''}\n    {\n${jsonFields(fields, '      ')},\n      "messages": [`);
    let count = 0;
    for await (const page of w.reader.messagePages(record.conversationKey, plan.range)) {
      let text = '';
      for (const message of page) {
        if (!keep(message)) continue;
        text += `${count++ > 0 ? ',' : ''}\n        ${JSON.stringify(exportedMessage(message, plan.content))}`;
      }
      write(text);
      w.onProgress?.({ conversation: i + 1, conversations: records.length, messages: w.totals.messages + count });
    }
    w.totals.messages += count;
    write(`${count > 0 ? '\n      ' : ''}]`);
    if (plan.content.images) {
      write(',\n      "images": [');
      let written = 0;
      for (const imageId of exportedImageIds(facts, plan)) {
        const image = await w.reader.getImage(record.conversationKey, imageId);
        if (!image) continue;
        write(`${written++ > 0 ? ',' : ''}\n        ${JSON.stringify(toExportedImage(image))}`);
      }
      write(`${written > 0 ? '\n      ' : ''}]`);
      w.totals.pictures += written;
    }
    write('\n    }');
    w.totals.conversations++;
  }
  write(`${records.length > 0 ? '\n  ' : ''}]\n}\n`);
}

// ------------------------------------------------------------- package

async function packageFolder(record: ConversationRecord, used: Set<string>): Promise<string> {
  const hash = (await sha256Hex(new TextEncoder().encode(record.conversationKey))).slice(0, 8);
  let folder = `conversations/${slug(record.displayName || record.title, 'conversation')}-${hash}`;
  for (let n = 2; used.has(folder.toLowerCase()); n++) folder = `conversations/${slug(record.displayName || record.title, 'conversation')}-${hash}-${n}`;
  used.add(folder.toLowerCase());
  return folder;
}

async function writePackage(w: Writing, records: ConversationRecord[], zip: ZipWriter): Promise<void> {
  const { plan } = w;
  const used = new Set<string>();
  const listed: PackageConversationV1[] = [];
  const keep = keeps(plan.content);
  const markdown = RENDERERS.markdown;
  for (const [i, record] of records.entries()) {
    w.index = i;
    const folder = await packageFolder(record, used);
    const facts = await survey(w.reader, record, plan);
    const messagesFile = zip.open(`${folder}/messages.jsonl`);
    const transcript = zip.open(`${folder}/transcript.md`);
    const pictures = plan.content.images ? filedPictures(w.reader, record.conversationKey, facts.catalog, zip, `${folder}/`, (image) => imageFileName(image)) : null;
    transcript.write(markdown.conversation(record, { messages: facts.messages, pictures: pictures ? facts.pictureIds.length : 0, picturesIn: 'folder', range: plan.range }, plan.time, true));
    const replies = new ReplyIndex(facts.replyTargets);
    const ctx: RenderContext = { content: plan.content, time: plan.time, picture: (id) => pictures?.get(id), replyTarget: (key) => replies.get(key) };
    let currentDay: string | null = null;
    let count = 0;
    for await (const page of w.reader.messagePages(record.conversationKey, plan.range)) {
      const kept = page.filter(keep);
      await pictures?.prepare(kept);
      let lines = '';
      let text = '';
      for (const message of kept) {
        lines += `${JSON.stringify(exportedMessage(message, plan.content))}\n`;
        const { day } = timeLabel(message, plan.time);
        if (day && day !== currentDay) {
          currentDay = day;
          text += markdown.day(day);
        }
        text += markdown.message(record, message, ctx);
        replies.note(message);
      }
      messagesFile.write(lines);
      transcript.write(text);
      count += kept.length;
      w.onProgress?.({ conversation: i + 1, conversations: records.length, messages: w.totals.messages + count });
    }
    messagesFile.close();
    transcript.close();
    w.totals.messages += count;

    let images = 0;
    if (pictures) {
      // Without a date range the package holds every saved image, also those no message shows any more.
      for (const imageId of exportedImageIds(facts, plan)) {
        if (pictures.files.has(imageId)) continue;
        const image = await w.reader.getImage(record.conversationKey, imageId);
        if (image) pictures.add(image, `images/${imageFileName(image)}`);
      }
      const order = new Map([...facts.catalog.keys()].map((id, n) => [id, n]));
      const lines = [...pictures.written]
        .sort((a, b) => (order.get(a.imageId) ?? 0) - (order.get(b.imageId) ?? 0))
        .map((info) => `${JSON.stringify({ ...info, file: pictures.files.get(info.imageId) as string } satisfies PackageImageV1)}\n`);
      zip.add(`${folder}/images.jsonl`, lines.join(''));
      images = lines.length;
      w.totals.pictures += images;
    }
    const exported = exportedRecord(record, facts, plan.range, plan.content);
    zip.add(`${folder}/conversation.json`, `${JSON.stringify(exported, null, 2)}\n`);
    listed.push({ conversationKey: record.conversationKey, name: conversationLabel(record), folder, messages: count, images });
    w.totals.conversations++;
  }
  const manifest: PackageManifestV1 = {
    format: PACKAGE_FORMAT,
    formatVersion: PACKAGE_FORMAT_VERSION,
    exportedAt: plan.now.toISOString(),
    generator: exportGenerator(plan.generatorVersion),
    records: { format: EXPORT_FORMAT, formatVersion: EXPORT_FORMAT_VERSION },
    selection: selectionOf(plan.range, plan.content),
    timeZone: plan.time.zone,
    conversations: listed,
  };
  zip.add('manifest.json', `${JSON.stringify(manifest, null, 2)}\n`);
}

// ----------------------------------------------------------------- entry

/** Runs an export into a file (PDF is printed instead, with `writePrintable`). */
export async function runExport(reader: ExportReader, request: ExportRequest, onProgress?: Progress): Promise<ExportOutcome> {
  if (request.format === 'pdf') throw new Error('PDF is printed from a page: use writePrintable');
  const p = plan(request);
  const records = await recordsOf(reader, request.conversations);
  const w: Writing = { reader, plan: p, onProgress, totals: { conversations: 0, messages: 0, pictures: 0 }, index: 0, count: records.length };
  const info = FORMATS[p.format];
  if (p.format === 'package') {
    const zip = new ZipWriter(p.now);
    await writePackage(w, records, zip);
    return { ...w.totals, blob: zip.finish(), fileName: exportFileNameFor(records, p.now, 'zip', 'package') };
  }
  if (p.format === 'json') {
    const sink = new BlobSink();
    await writeJson(w, records, sink.text);
    return { ...w.totals, blob: sink.toBlob(info.mimeType), fileName: exportFileNameFor(records, p.now, 'json') };
  }
  const format = p.format as TranscriptFormat;
  if (p.packaging === 'zip') {
    const zip = new ZipWriter(p.now);
    await writeTranscripts(w, records, format, { zip });
    return { ...w.totals, blob: zip.finish(), fileName: exportFileNameFor(records, p.now, 'zip') };
  }
  const sink = new BlobSink();
  await writeTranscripts(w, records, format, { sink: sink.text });
  return { ...w.totals, blob: sink.toBlob(`${info.mimeType};charset=utf-8`), fileName: exportFileNameFor(records, p.now, info.extension) };
}

/**
 * Writes the printable page (the HTML transcript) for "Save as PDF". Pictures are shown from
 * the addresses `address` makes (object URLs), so the page holds no picture data itself.
 */
export async function writePrintable(reader: ExportReader, request: ExportRequest, write: TextSink, address: (image: StoredImage) => string, onProgress?: Progress): Promise<ExportTotals> {
  const p = plan({ ...request, format: 'html', packaging: 'file' });
  const records = await recordsOf(reader, request.conversations);
  const w: Writing = { reader, plan: p, onProgress, totals: { conversations: 0, messages: 0, pictures: 0 }, index: 0, count: records.length };
  await writeTranscripts(w, records, 'html', { sink: write }, address);
  return w.totals;
}
