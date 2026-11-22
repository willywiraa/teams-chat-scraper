/**
 * Parses every message currently rendered in the Teams message list (oldest first),
 * inferring senders of grouped messages, deriving timestamps and building
 * de-duplication keys.
 */
import { attachmentSignature, messageFingerprint, STRONG_TIMESTAMP_SOURCES, type FingerprintParts } from '../shared/fingerprint';
import { hashParts, normalizeForHash } from '../shared/hash';
import type { DateOrder } from '../shared/time';
import { epochFromMessageId, toIso } from '../shared/time';
import { isReliableSortSource, type ConversationIdentity, type ExtractedMessage, type IdentityEvidence, type Sender, type SortKeySource, type TimestampSource } from '../shared/types';
import { firstNonEmptyMatches, outermost, unionMatches } from './dom';
import { parseItem, type RawMessage } from './message-parser';
import type { SelectorProfile } from './selectors';

export interface PageParseOptions {
  profile: SelectorProfile;
  conversation: ConversationIdentity;
  /** Display name to record for the signed-in user's own messages. */
  selfDisplayName: string | null;
  referenceMs: number;
  dateOrder: DateOrder;
  /** Message list element, when already located by the caller. */
  listElement?: Element | null;
}

export interface PageParseResult {
  listElement: Element | null;
  itemCount: number;
  skipped: number;
  dividers: number;
  messages: ExtractedMessage[];
  /**
   * Pairs of keys where `next` is rendered directly below `previous` without an author header
   * of its own: `next` was sent by the same person. Lets the engine carry sender names across
   * passes when a long run of messages from one person does not fit into one rendered window.
   */
  groupLinks: GroupLink[];
  /** Images displayed in the parsed messages, with the attachment each belongs to. */
  images: RenderedImage[];
  warnings: string[];
}

export interface GroupLink {
  previous: string;
  next: string;
}

export interface RenderedImage {
  messageKey: string;
  /** Index into the message's `attachments`. */
  attachmentIndex: number;
  element: Element;
}

/** Max difference between a message-id time and a displayed time for both to be trusted together. */
const ID_TIME_TOLERANCE_MS = 36 * 3_600_000;

export function findMessageList(doc: Document, profile: SelectorProfile): Element | null {
  return firstNonEmptyMatches(doc, profile.messageList).elements[0] ?? null;
}

/** Message items plus any system messages / date dividers rendered outside them, in document order. */
export function collectItems(list: Element, profile: SelectorProfile): Element[] {
  const primary = firstNonEmptyMatches(list, profile.messageItem).elements;
  const extras = [...unionMatches(list, profile.systemMessage), ...unionMatches(list, profile.dateDivider)].filter(
    (el) => !primary.some((item) => item.contains(el) || el.contains(item)),
  );
  return outermost([...primary, ...extras]);
}

interface Draft {
  raw: RawMessage;
  /** Index of the draft this one may continue (null after a divider or system message). */
  previousIndex: number | null;
  sender: Sender;
  timestampMs: number | null;
  timestampSource: TimestampSource;
  sortKey: number | null;
  sortKeySource: SortKeySource | null;
}

function resolveSender(raw: RawMessage, previous: Draft | null, selfDisplayName: string | null): Sender {
  if (raw.kind === 'system') return { name: null, id: null, isSelf: false, source: 'unknown' };
  if (raw.isSelf) {
    return {
      name: raw.authorName ?? (selfDisplayName || null),
      id: raw.authorId,
      isSelf: true,
      source: raw.authorName ? 'explicit' : 'self',
    };
  }
  if (raw.authorName) return { name: raw.authorName, id: raw.authorId, isSelf: false, source: 'explicit' };
  // Teams omits the author on consecutive messages from the same person ("grouping").
  if (previous && previous.raw.kind === 'message' && !previous.sender.isSelf && previous.sender.name) {
    return { name: previous.sender.name, id: previous.sender.id, isSelf: false, source: 'group-inferred' };
  }
  return { name: null, id: null, isSelf: false, source: 'unknown' };
}

function resolveTime(raw: RawMessage, nowMs: number): Pick<Draft, 'timestampMs' | 'timestampSource' | 'sortKey' | 'sortKeySource'> {
  const idMs = epochFromMessageId(raw.messageId, nowMs);
  let timestampMs = raw.timestampMs;
  let timestampSource = raw.timestampSource;
  // A message id carries millisecond precision; prefer it over a parsed visible label.
  if (idMs !== null && (timestampMs === null || timestampSource === 'visible-text')) {
    timestampMs = idMs;
    timestampSource = 'message-id';
  }
  if (idMs !== null && (raw.timestampMs === null || Math.abs(idMs - raw.timestampMs) <= ID_TIME_TOLERANCE_MS)) {
    return { timestampMs, timestampSource, sortKey: idMs, sortKeySource: 'message-id' };
  }
  if (timestampMs !== null) return { timestampMs, timestampSource, sortKey: timestampMs, sortKeySource: 'timestamp' };
  return { timestampMs: null, timestampSource: 'none', sortKey: null, sortKeySource: null };
}

/**
 * Anchors for messages that have neither a Teams id nor an exact timestamp: the nearest newer
 * and the nearest older rendered message with an id. The newer one is preferred because it is
 * normally rendered when such a message first scrolls into view from the top. Which anchors
 * exist depends on the rendered window, so the alternative is kept as an alias key.
 */
function weakAnchors(drafts: Draft[], index: number): { newer: string | null; older: string | null } {
  let newer: string | null = null;
  let older: string | null = null;
  for (let j = index + 1; j < drafts.length && newer === null; j++) {
    const id = (drafts[j] as Draft).raw.messageId;
    if (id) newer = `n:${id}:${j - index}`;
  }
  for (let j = index - 1; j >= 0 && older === null; j--) {
    const id = (drafts[j] as Draft).raw.messageId;
    if (id) older = `p:${id}:${index - j}`;
  }
  return { newer, older };
}

export function parseRenderedConversation(doc: Document, options: PageParseOptions): PageParseResult {
  const { profile, conversation } = options;
  const conversationKey = conversation.conversationKey;
  const list = options.listElement ?? findMessageList(doc, profile);
  const warnings: string[] = [];
  if (!list) {
    return { listElement: null, itemCount: 0, skipped: 0, dividers: 0, messages: [], groupLinks: [], images: [], warnings: ['message-list-not-found'] };
  }

  const items = collectItems(list, profile);
  const drafts: Draft[] = [];
  let dateContext: string | null = null;
  let previous: Draft | null = null;
  let previousIndex: number | null = null;
  let skipped = 0;
  let dividers = 0;
  let bodyFallbacks = 0;

  for (const item of items) {
    const parsed = parseItem(item, { profile, referenceMs: options.referenceMs, dateOrder: options.dateOrder, dateContext });
    if (parsed.type === 'divider') {
      dividers++;
      if (parsed.text) dateContext = parsed.text;
      previous = null;
      previousIndex = null;
      continue;
    }
    if (parsed.type === 'skip') {
      skipped++;
      continue;
    }
    const raw = parsed.message;
    if (raw.usedBodyFallback) bodyFallbacks++;
    const draft: Draft = {
      raw,
      previousIndex,
      sender: resolveSender(raw, previous, options.selfDisplayName),
      ...resolveTime(raw, options.referenceMs),
    };
    drafts.push(draft);
    previous = raw.kind === 'system' ? null : draft;
    previousIndex = raw.kind === 'system' ? null : drafts.length - 1;
  }
  if (bodyFallbacks > 0) warnings.push(`body-selector-fallback:${bodyFallbacks}`);

  const messages: ExtractedMessage[] = [];
  const images: RenderedImage[] = [];
  const keyByDraft: Array<string | null> = drafts.map(() => null);
  const seenIds = new Set<string>();
  const fingerprintOccurrences = new Map<string, number>();

  drafts.forEach((draft, index) => {
    const { raw, sender } = draft;
    if (raw.messageId) {
      if (seenIds.has(raw.messageId)) {
        warnings.push(`duplicate-message-id:${raw.messageId}`);
        return;
      }
      seenIds.add(raw.messageId);
    }
    const strongTime = STRONG_TIMESTAMP_SOURCES.has(raw.timestampSource) ? toIso(raw.timestampMs) : null;
    const normalizedText = normalizeForHash(raw.content.text);
    const attachments = attachmentSignature(raw.attachments);
    const parts: Omit<FingerprintParts, 'anchor'> = { kind: raw.kind, isSelf: sender.isSelf, strongTime, normalizedText, attachments, replyPreview: raw.replyTo?.preview };
    const fingerprintWith = (anchor: string | null, namespace = conversationKey) => messageFingerprint(namespace, { ...parts, anchor });

    let key: string;
    let fingerprint: string;
    const alternateKeys: string[] = [];
    if (raw.messageId) {
      fingerprint = fingerprintWith(null);
      key = `${conversationKey}#${raw.messageId}`;
    } else if (strongTime) {
      fingerprint = fingerprintWith(null);
      key = occurrenceKey(conversationKey, fingerprint, fingerprintOccurrences);
    } else {
      const anchors = weakAnchors(drafts, index);
      const choices = anchors.newer && anchors.older ? [anchors.newer, anchors.older] : [anchors.newer ?? anchors.older];
      fingerprint = fingerprintWith(choices[0] ?? null);
      key = occurrenceKey(conversationKey, fingerprint, fingerprintOccurrences);
      for (const anchor of choices.slice(1)) alternateKeys.push(`${conversationKey}#fp:${fingerprintWith(anchor)}`);
      // Such a message merged in from another archive entry keeps the fingerprint made under that entry's key.
      for (const mergedKey of conversation.mergedKeys ?? []) {
        for (const anchor of choices) alternateKeys.push(`${conversationKey}#fp:${fingerprintWith(anchor, mergedKey)}`);
      }
    }
    keyByDraft[index] = key;

    const replyTo = raw.replyTo
      ? { ...raw.replyTo, resolvedKey: raw.replyTo.messageId ? `${conversationKey}#${raw.replyTo.messageId}` : null }
      : null;

    messages.push({
      key,
      conversationKey,
      messageId: raw.messageId,
      idSource: raw.messageId ? 'dom' : 'fingerprint',
      kind: raw.kind,
      sender,
      timestamp: toIso(draft.timestampMs),
      timestampSource: draft.timestampSource,
      timestampRaw: raw.timestampRaw,
      sortKey: draft.sortKey,
      sortKeySource: draft.sortKeySource,
      text: raw.content.text,
      html: raw.content.html,
      mentions: raw.content.mentions,
      links: raw.content.links,
      attachments: raw.attachments,
      replyTo,
      ...(raw.reactions.length > 0 ? { reactions: raw.reactions } : {}),
      isEdited: raw.isEdited,
      isDeleted: raw.isDeleted,
      // Reactions are left out: a new reaction is not an edit.
      contentHash: hashParts([normalizedText, attachments, raw.isDeleted ? 'deleted' : '']),
      fingerprint,
      fingerprintStrong: strongTime !== null,
      alternateKeys,
    });
    raw.imageElements.forEach((element, attachmentIndex) => {
      if (element) images.push({ messageKey: key, attachmentIndex, element });
    });
  });

  return { listElement: list, itemCount: items.length, skipped, dividers, messages, groupLinks: groupLinks(drafts, keyByDraft), images, warnings };
}

/** Most messages sent to the archive to identify a chat. */
export const MAX_EVIDENCE_MESSAGES = 60;

type EvidenceSource = Pick<ExtractedMessage, 'messageId' | 'contentHash' | 'sortKey' | 'sortKeySource'>;

/**
 * The messages with a Teams id (the newest ones, in timeline order), for finding the chat in
 * the archive. Carries ids, content hashes and times only, no content.
 */
export function identityEvidence(messages: readonly EvidenceSource[], limit = MAX_EVIDENCE_MESSAGES): IdentityEvidence {
  const withId = messages.filter((message): message is EvidenceSource & { messageId: string } => typeof message.messageId === 'string' && message.messageId.length > 0);
  return {
    messages: withId.slice(-limit).map((message) => ({
      messageId: message.messageId,
      contentHash: message.contentHash,
      sortKey: isReliableSortSource(message.sortKeySource) ? message.sortKey : null,
    })),
  };
}

/** Key for a message without a Teams id; identical messages within one pass are numbered. */
function occurrenceKey(conversationKey: string, fingerprint: string, occurrences: Map<string, number>): string {
  const occurrence = (occurrences.get(fingerprint) ?? 0) + 1;
  occurrences.set(fingerprint, occurrence);
  return `${conversationKey}#fp:${fingerprint}${occurrence > 1 ? `~${occurrence}` : ''}`;
}

/** Messages shown without an author header, linked to the message they continue. */
function groupLinks(drafts: Draft[], keyByDraft: Array<string | null>): GroupLink[] {
  const links: GroupLink[] = [];
  drafts.forEach((draft, index) => {
    const next = keyByDraft[index];
    if (!next || draft.previousIndex === null) return;
    if (draft.raw.kind !== 'message' || draft.raw.isSelf || draft.raw.authorName) return;
    const previousDraft = drafts[draft.previousIndex] as Draft;
    const previous = keyByDraft[draft.previousIndex];
    if (!previous || previousDraft.raw.kind !== 'message' || previousDraft.sender.isSelf) return;
    links.push({ previous, next });
  });
  return links;
}
