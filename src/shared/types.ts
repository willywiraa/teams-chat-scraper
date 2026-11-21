/**
 * Domain model shared by the extractor, the scraping engine, storage and exporters.
 *
 * Everything here is plain JSON-serialisable data so it can cross the
 * content-script/background boundary and be written to IndexedDB unchanged.
 */

/** Bumped whenever the stored record shape changes (see storage/schema.ts for migrations). */
export const ARCHIVE_SCHEMA_VERSION = 3;

/** Bumped whenever DOM parsing rules change in a way that can alter extracted values. */
export const EXTRACTOR_VERSION = '1.1.0';

export type ConversationType = 'one-on-one' | 'group' | 'meeting' | 'channel' | 'unknown';

/** Identity of the conversation currently open in Teams Web. */
export interface ConversationIdentity {
  /** Stable archive key: `teams:<threadId>` when the Teams thread id is known, else `title:<normalised title>`. */
  conversationKey: string;
  /** Teams thread id such as `19:...@thread.v2` or `19:..._...@unq.gbl.spaces`. */
  threadId: string | null;
  title: string | null;
  type: ConversationType;
  keySource: 'dom' | 'url' | 'title';
  typeSource: 'thread-id' | 'unknown';
  /**
   * Keys of archive entries that were merged into this conversation's entry. A message with
   * neither a Teams id nor an exact time keeps the fingerprint made under such a key, so the
   * page parser also looks for it under those. Only set while an extraction runs.
   */
  mergedKeys?: string[];
}

export type TimestampSource =
  | 'datetime-attr'
  | 'title-attr'
  | 'aria-label'
  | 'visible-text'
  | 'message-id'
  | 'none';

export type SenderSource = 'explicit' | 'self' | 'group-inferred' | 'unknown';

/** How a message's position in the conversation timeline was determined (best first). */
export type SortKeySource = 'message-id' | 'timestamp' | 'interpolated' | 'observed-order';

/** Sort keys derived from a Teams message id or a displayed timestamp are absolute and comparable across sessions. */
export function isReliableSortSource(source: SortKeySource | null | undefined): boolean {
  return source === 'message-id' || source === 'timestamp';
}

export type MessageKind = 'message' | 'system';

export interface Sender {
  name: string | null;
  /** Teams user id (MRI such as `8:orgid:<guid>`) when present in the DOM. */
  id: string | null;
  isSelf: boolean;
  source: SenderSource;
}

export type AttachmentKind = 'file' | 'image' | 'link-preview' | 'card' | 'other';

export interface Attachment {
  kind: AttachmentKind;
  name: string | null;
  url: string | null;
  /**
   * Images only: SHA-256 (hex) of the saved image. The image itself is in the archive's image
   * store and in exports, under this id. Absent or null when the image was not saved.
   */
  imageId?: string | null;
}

/** How a saved image was read from the page. */
export type ImageCaptureMethod = 'fetch' | 'canvas';

/** An image as captured in the Teams tab and sent to the background (bytes as base64). */
export interface CapturedImage {
  imageId: string;
  mimeType: string;
  byteLength: number;
  width: number | null;
  height: number | null;
  method: ImageCaptureMethod;
  dataBase64: string;
}

/** An image displayed in a conversation, saved in the archive's image store. */
export interface StoredImage {
  /** `<conversationKey>#img:<imageId>`. */
  key: string;
  conversationKey: string;
  /** SHA-256 (hex) of the bytes; message attachments refer to it. */
  imageId: string;
  mimeType: string;
  byteLength: number;
  width: number | null;
  height: number | null;
  method: ImageCaptureMethod;
  data: ArrayBuffer;
  firstSavedAt: string;
  sessionId: string | null;
  schemaVersion: number;
}

/** Outcome of storing an image: images are immutable (keyed by hash), so a repeat is `unchanged`. */
export type ImageSaveStatus = 'inserted' | 'unchanged';

export interface Mention {
  name: string;
  id: string | null;
}

export interface Link {
  href: string;
  text: string;
}

export type ReplyResolution = 'message-id' | 'content-match' | 'unresolved';

/** A quoted reply ("Reply" in Teams chats) pointing at an earlier message. */
export interface ReplyReference {
  messageId: string | null;
  senderName: string | null;
  timestampRaw: string | null;
  preview: string | null;
  /** Archive key of the referenced message, once known. */
  resolvedKey: string | null;
  resolution: ReplyResolution;
}

/** One observation of a rendered message, produced by the DOM extractor. */
export interface ExtractedMessage {
  /** Archive primary key: `<conversationKey>#<messageId>` or `<conversationKey>#fp:<fingerprint>`. */
  key: string;
  conversationKey: string;
  messageId: string | null;
  idSource: 'dom' | 'fingerprint';
  kind: MessageKind;
  sender: Sender;
  /** ISO-8601 UTC timestamp, or null when it could not be determined. */
  timestamp: string | null;
  timestampSource: TimestampSource;
  timestampRaw: string | null;
  /** Position in the timeline in epoch milliseconds (possibly fractional when interpolated). */
  sortKey: number | null;
  sortKeySource: SortKeySource | null;
  /** Plain text with paragraphs separated by blank lines. */
  text: string;
  /** Sanitised HTML of the message body (safe tags and attributes only). */
  html: string;
  mentions: Mention[];
  links: Link[];
  attachments: Attachment[];
  replyTo: ReplyReference | null;
  isEdited: boolean;
  isDeleted: boolean;
  /** Hash of the visible content; changes when a message is edited. */
  contentHash: string;
  /** Hash of stable content attributes, used to de-duplicate messages without a Teams id. */
  fingerprint: string;
  /** True when the fingerprint includes an exact timestamp and is safe for cross-record matching. */
  fingerprintStrong: boolean;
  /**
   * Other keys this message may already be archived under. Only set for messages without a
   * Teams id or exact timestamp, whose fingerprint depends on which neighbours were rendered.
   */
  alternateKeys: string[];
}

export interface MessageVersion {
  text: string;
  html: string;
  contentHash: string;
  replacedAt: string;
}

/** A message as persisted in the archive (merged from one or more observations). */
export interface StoredMessage extends Omit<ExtractedMessage, 'sortKey' | 'sortKeySource' | 'alternateKeys'> {
  sortKey: number;
  sortKeySource: SortKeySource;
  firstSeenAt: string;
  lastSeenAt: string;
  firstSessionId: string;
  lastSessionId: string;
  observationCount: number;
  /** Earlier contents, kept when an edit or deletion is detected. */
  previousVersions: MessageVersion[];
  /**
   * Other keys this message is known by (indexed): a fingerprint key later matched to a Teams
   * id, or the alternative fingerprint keys of a message without id or exact timestamp.
   */
  aliases: string[];
  extractorVersion: string;
  schemaVersion: number;
}

/**
 * A contiguous stretch of the timeline that has been captured without gaps,
 * in sort-key space. `reachedBeginning` means nothing older exists in Teams.
 */
export interface CoverageRange {
  oldest: number;
  newest: number;
  reachedBeginning: boolean;
}

/** A title Teams showed for a conversation, and when. */
export interface TitleSighting {
  title: string;
  firstSeenAt: string;
  lastSeenAt: string;
}

export interface ConversationRecord {
  conversationKey: string;
  threadId: string | null;
  /** The title Teams showed most recently. */
  title: string | null;
  type: ConversationType;
  keySource: ConversationIdentity['keySource'];
  typeSource: ConversationIdentity['typeSource'];
  participants: string[];
  messageCount: number;
  oldestSortKey: number | null;
  newestSortKey: number | null;
  coverage: CoverageRange[];
  firstExtractedAt: string;
  lastExtractedAt: string;
  lastSessionId: string | null;
  schemaVersion: number;
  /**
   * Other keys this conversation is known by (indexed): the key detected after the chat was
   * renamed, the keys of archive entries merged into it, a thread id key learned later.
   * The conversation key itself never changes. Since schema 3; absent in older records.
   */
  aliases?: string[];
  /** Keys of the archive entries that were merged into this one. Since schema 3. */
  mergedFrom?: string[];
  /** Set on an entry that is being merged into another one: that entry's key. Since schema 3. */
  mergedInto?: string | null;
  /** Titles Teams showed for this conversation, oldest first. Since schema 3. */
  titleHistory?: TitleSighting[];
  /** Name given in the archive; shown instead of the Teams title. Since schema 3. */
  displayName?: string | null;
}

/** Name shown for an archive entry: the name given in the archive, else the Teams title. */
export function conversationLabel(record: Pick<ConversationRecord, 'conversationKey' | 'title' | 'displayName'>): string {
  return record.displayName || record.title || record.conversationKey;
}

/**
 * Messages shown in the open chat that have a Teams message id. Identifies the chat in the
 * archive when Teams shows no chat id: a renamed chat still shows its archived messages.
 */
export interface IdentityEvidence {
  messages: Array<{ messageId: string; contentHash: string; sortKey: number | null }>;
}

export type ScrapeMode = 'visible' | 'incremental' | 'full';

export type SessionStatus = 'running' | 'paused' | 'completed' | 'stopped' | 'interrupted' | 'failed';

export type StopReason =
  | 'visible-complete'
  | 'reached-top'
  | 'history-complete'
  | 'overlap-reached'
  | 'user-stop'
  | 'max-steps'
  | 'max-duration'
  | 'no-progress'
  | 'conversation-changed'
  | 'container-lost'
  | 'error'
  | 'interrupted';

export interface SessionCounters {
  /** Extraction passes (one per scroll step). */
  passes: number;
  /** Distinct messages observed during the session. */
  uniqueSeen: number;
  /** Messages that were new to the archive. */
  inserted: number;
  /** Archived messages whose data improved or changed (edits, filled-in metadata). */
  updated: number;
  /** Archived messages observed again with identical data (duplicates prevented). */
  unchanged: number;
  /** Repeat observations within the session that were skipped before storage. */
  reobserved: number;
  /** Passes that resumed through already-archived ranges at the faster seek interval. */
  seekPasses: number;
  gapsDetected: number;
  gapsUnrecovered: number;
  /** Oldest / newest reliable sort keys reached by the session. */
  oldestSortKey: number | null;
  newestSortKey: number | null;
  /** Displayed images saved during the session (missing in sessions recorded before version 1.1). */
  imagesSaved: number;
  /** Displayed images that could not be read or were too large. */
  imagesFailed: number;
}

export interface SessionRecord {
  sessionId: string;
  /** The archive entry the session writes to. */
  conversationKey: string;
  /**
   * The key detected in Teams, when it differs from `conversationKey` (a renamed chat, or a chat
   * with the same title as another one). Recorded as an alias of the entry. Since schema 3.
   */
  detectedKey?: string | null;
  conversationTitle: string | null;
  mode: ScrapeMode;
  rescan: boolean;
  status: SessionStatus;
  stopReason: StopReason | null;
  error: string | null;
  /** Session this one continues, when the user resumed an interrupted extraction. */
  resumeOf: string | null;
  tabId: number | null;
  startedAt: string;
  updatedAt: string;
  endedAt: string | null;
  counters: SessionCounters;
  warnings: string[];
  extractorVersion: string;
}

export type UpsertStatus = 'inserted' | 'updated' | 'unchanged';

export function emptyCounters(): SessionCounters {
  return {
    passes: 0,
    uniqueSeen: 0,
    inserted: 0,
    updated: 0,
    unchanged: 0,
    reobserved: 0,
    seekPasses: 0,
    gapsDetected: 0,
    gapsUnrecovered: 0,
    oldestSortKey: null,
    newestSortKey: null,
    imagesSaved: 0,
    imagesFailed: 0,
  };
}
