/**
 * Parses one rendered list item into a raw message, a date divider, or nothing.
 * Pure DOM reading: no side effects, no Chrome APIs.
 */
import type { DateOrder } from '../shared/time';
import { parseHumanDateTime, parseIsoTimestamp } from '../shared/time';
import { MAX_REACTION_NAME, MAX_REACTIONS } from '../shared/reactions';
import type { Attachment, MessageKind, Reaction, ReplyReference, TimestampSource } from '../shared/types';
import { findUserId, serializeContent, type InlineImage, type SerializedContent } from './content-serializer';
import {
  firstMatch,
  isInsideExcluded,
  matchesAny,
  outermost,
  readIdByRules,
  safeQueryAll,
  safeUrl,
  textOf,
  textOutside,
  unionMatches,
} from './dom';
import type { SelectorProfile } from './selectors';

export interface ItemParseContext {
  profile: SelectorProfile;
  /** "Now", used to resolve relative day labels. */
  referenceMs: number;
  dateOrder: DateOrder;
  /** Text of the closest date divider above this item. */
  dateContext: string | null;
}

export interface RawMessage {
  element: Element;
  messageId: string | null;
  kind: MessageKind;
  authorName: string | null;
  authorId: string | null;
  isSelf: boolean;
  timestampMs: number | null;
  timestampSource: TimestampSource;
  timestampRaw: string | null;
  content: SerializedContent;
  attachments: Attachment[];
  /** Aligned with `attachments`: the element displaying each image attachment, else null. */
  imageElements: Array<Element | null>;
  replyTo: ReplyReference | null;
  /** Reactions under the message, in the order shown; empty when none are shown. */
  reactions: Reaction[];
  isEdited: boolean;
  isDeleted: boolean;
  /** True when no body element matched and the whole item was serialised instead. */
  usedBodyFallback: boolean;
}

export type ParsedItem =
  | { type: 'message'; message: RawMessage }
  | { type: 'divider'; text: string }
  | { type: 'skip'; reason: string };

const MAX_NAME_LENGTH = 300;
const MAX_PREVIEW_LENGTH = 500;

interface ParsedTime {
  ms: number | null;
  source: TimestampSource;
  raw: string | null;
}

export function parseTimestampElement(element: Element | null, ctx: ItemParseContext): ParsedTime {
  if (!element) return { ms: null, source: 'none', raw: null };
  const options = { referenceMs: ctx.referenceMs, dateOrder: ctx.dateOrder, contextDate: ctx.dateContext };
  const datetimeEl = element.hasAttribute('datetime') ? element : element.querySelector('[datetime]');
  const datetime = datetimeEl?.getAttribute('datetime')?.trim() || null;
  if (datetime) {
    const ms = parseIsoTimestamp(datetime) ?? parseHumanDateTime(datetime, options);
    if (ms !== null) return { ms, source: 'datetime-attr', raw: datetime };
  }
  const title = element.getAttribute('title')?.trim() || null;
  if (title) {
    const ms = parseHumanDateTime(title, options);
    if (ms !== null) return { ms, source: 'title-attr', raw: title };
  }
  const aria = element.getAttribute('aria-label')?.trim() || null;
  if (aria) {
    const ms = parseHumanDateTime(aria, options);
    if (ms !== null) return { ms, source: 'aria-label', raw: aria };
  }
  const text = textOf(element) || null;
  if (text) {
    const ms = parseHumanDateTime(text, options);
    if (ms !== null) return { ms, source: 'visible-text', raw: text };
  }
  return { ms: null, source: 'none', raw: datetime ?? title ?? aria ?? text };
}

export function parseReply(item: Element, profile: SelectorProfile): ReplyReference | null {
  const container = outermost(unionMatches(item, profile.reply.container))[0];
  if (!container) return null;
  const messageId = readIdByRules(container, profile.reply.idRules, { includeSelf: true });
  const authorEl = firstMatch(container, profile.reply.author);
  const timeEl = firstMatch(container, profile.reply.time);
  const previewEl = firstMatch(container, profile.reply.preview);
  const senderName = textOf(authorEl).slice(0, MAX_NAME_LENGTH) || null;
  const timestampRaw = (timeEl?.getAttribute('datetime') ?? '').trim() || textOf(timeEl) || null;
  let preview = previewEl ? textOf(previewEl) : textOutside(container, [...profile.reply.author, ...profile.reply.time]);
  preview = preview.slice(0, MAX_PREVIEW_LENGTH);
  return {
    messageId,
    senderName,
    timestampRaw,
    preview: preview || null,
    resolvedKey: null,
    resolution: messageId ? 'message-id' : 'unresolved',
  };
}

/** One emoji: a flag, a keycap, or a pictograph with its variation, skin tone and joined parts. */
const EMOJI =
  /\p{Regional_Indicator}{2}|[#*0-9]\uFE0F?\u20E3|\p{Extended_Pictographic}(?:\uFE0F|\p{Emoji_Modifier})*(?:\u200D\p{Extended_Pictographic}(?:\uFE0F|\p{Emoji_Modifier})*)*/u;
const EMOJI_ALL = new RegExp(EMOJI.source, 'gu');
/** Buttons near the reactions that are not reactions. */
const NOT_A_REACTION = /\badd (?:a )?reaction|\bmore reactions|\bsee (?:all|who)/i;

function countIn(text: string): number | null {
  const match = text.match(/\b(\d{1,6})\b/);
  return match ? Math.max(1, Number(match[1])) : null;
}

/** Attributes that mark a reaction pill as chosen by you. */
const PRESSED_ATTRIBUTES = ['aria-pressed', 'aria-checked', 'aria-selected'] as const;

/** One pill as read, with where each part came from: Diagnostics reports the sources, never the values. */
export interface ReactionRead {
  /** Null when the pill is another button (Add reaction) or shows no emoji. */
  reaction: Reaction | null;
  emojiFrom: 'picture' | 'text' | 'label' | 'label-name' | 'none';
  countFrom: 'text' | 'label' | 'none';
  /** The first of aria-pressed, aria-checked and aria-selected the pill has, whatever its value. */
  pressedAttribute: (typeof PRESSED_ATTRIBUTES)[number] | null;
}

/**
 * Reads one reaction pill. The emoji comes from a picture's alt text, the pill's text or its
 * accessible name, in that order; failing those, from a name in the accessible name such as
 * "Like reaction". The count is the number in the pill's text (1 when it shows none), and it is
 * yours when the pill is pressed.
 */
export function readReaction(pill: Element): ReactionRead {
  const pressedAttribute = PRESSED_ATTRIBUTES.find((name) => pill.hasAttribute(name)) ?? null;
  const label = (pill.getAttribute('aria-label') ?? pill.getAttribute('title') ?? '').replace(/\s+/g, ' ').trim();
  const none: ReactionRead = { reaction: null, emojiFrom: 'none', countFrom: 'none', pressedAttribute };
  if (NOT_A_REACTION.test(label)) return none;
  const text = textOf(pill);
  const image = pill.matches('img[alt]') ? pill : pill.querySelector('img[alt]');
  const alt = image?.getAttribute('alt')?.replace(/\s+/g, ' ').trim() ?? '';
  const named = label.match(/^([^\d,.;:()]{1,40}?)\s+reactions?\b/i)?.[1]?.trim() ?? '';
  const sources: Array<[ReactionRead['emojiFrom'], string | undefined]> = [
    ['picture', alt.match(EMOJI)?.[0]],
    ['text', text.match(EMOJI)?.[0]],
    ['label', label.match(EMOJI)?.[0]],
    ['picture', alt || undefined],
    ['label-name', named || undefined],
  ];
  const [emojiFrom, emoji] = sources.find(([, value]) => value) ?? ['none', undefined];
  if (!emoji) return none;
  const fromText = countIn(text.replace(EMOJI_ALL, ' '));
  const fromLabel = fromText === null ? countIn(label.replace(EMOJI_ALL, ' ')) : null;
  const pressed = PRESSED_ATTRIBUTES.some((name) => pill.getAttribute(name) === 'true');
  return {
    reaction: { emoji: emoji.slice(0, MAX_REACTION_NAME), count: fromText ?? fromLabel ?? 1, mine: pressed },
    emojiFrom,
    countFrom: fromText !== null ? 'text' : fromLabel !== null ? 'label' : 'none',
    pressedAttribute,
  };
}

/**
 * The pills a message's reactions are read from: outside a quoted reply (those belong to the
 * quoted message), and of nested matches the innermost.
 */
export function reactionPills(scope: Element, selectors: readonly string[], profile: SelectorProfile): Element[] {
  const pills = unionMatches(scope, selectors, { exclude: profile.reply.container });
  return pills.filter((pill) => !pills.some((other) => other !== pill && pill.contains(other)));
}

/** The reactions under a message, in the order shown, each emoji once. */
export function parseReactions(item: Element, profile: SelectorProfile): Reaction[] {
  const reactions: Reaction[] = [];
  for (const pill of reactionPills(item, profile.reaction, profile)) {
    const { reaction } = readReaction(pill);
    if (!reaction || reactions.some((seen) => seen.emoji === reaction.emoji)) continue;
    reactions.push(reaction);
    if (reactions.length >= MAX_REACTIONS) break;
  }
  return reactions;
}

function attachmentName(element: Element, nameSelectors: readonly string[]): string | null {
  const nameEl = firstMatch(element, nameSelectors);
  const candidates = [
    textOf(nameEl),
    element.getAttribute('title') ?? '',
    element.querySelector('[title]')?.getAttribute('title') ?? '',
    element.getAttribute('aria-label') ?? '',
    textOf(element),
  ];
  const name = candidates.map((value) => value.replace(/\s+/g, ' ').trim()).find((value) => value.length > 0);
  return name ? name.slice(0, MAX_NAME_LENGTH) : null;
}

function firstLinkUrl(element: Element): string | null {
  const anchor = element.matches('a[href]') ? element : element.querySelector('a[href]');
  return safeUrl(anchor?.getAttribute('href'));
}

export interface ParsedAttachments {
  attachments: Attachment[];
  /** Aligned with `attachments`: the element displaying each image attachment, else null. */
  imageElements: Array<Element | null>;
}

interface FoundAttachment {
  attachment: Attachment;
  element: Element | null;
}

/**
 * Removes attachments found twice (an image in the body is found both as an inline image and by
 * the image selectors). Images are compared by element and source, never by name: Teams names
 * most pasted pictures just "image".
 */
function dedupeAttachments(found: FoundAttachment[]): FoundAttachment[] {
  const seenKeys = new Set<string>();
  const seenElements = new Set<Element>();
  return found.filter(({ attachment, element }) => {
    if (element) {
      if (seenElements.has(element)) return false;
      seenElements.add(element);
      const src = element.getAttribute('src')?.trim();
      if (!src) return true;
      const key = `image-src|${src}`;
      if (seenKeys.has(key)) return false;
      seenKeys.add(key);
      return true;
    }
    const key = `${attachment.kind}|${attachment.name ?? ''}|${attachment.url ?? ''}`;
    if (seenKeys.has(key)) return false;
    seenKeys.add(key);
    return true;
  });
}

export function parseAttachments(item: Element, profile: SelectorProfile, inlineImages: InlineImage[]): ParsedAttachments {
  const config = profile.attachments;
  // Reaction pills can hold emoji pictures; they are not attachments.
  const exclude = [...profile.reply.container, ...profile.reaction];
  const found: FoundAttachment[] = [];
  const containers = outermost(unionMatches(item, config.container, { exclude }));
  const insideContainer = (el: Element) => containers.some((container) => container.contains(el));

  for (const container of containers) {
    if (matchesAny(container, config.card) || matchesAny(container, config.linkPreview)) continue;
    let entries = outermost(unionMatches(container, config.item));
    if (entries.length === 0) entries = [container];
    for (const entry of entries) {
      const image = matchesAny(entry, config.image) ? entry : firstMatch(entry, config.image);
      const name = attachmentName(entry, config.name) ?? image?.getAttribute('alt') ?? null;
      const isImage = image !== null && !firstMatch(entry, config.name);
      found.push({
        attachment: {
          kind: isImage ? 'image' : 'file',
          name,
          url: firstLinkUrl(entry) ?? safeUrl(image?.getAttribute('src'), ['http:', 'https:']),
        },
        element: isImage ? image : null,
      });
    }
  }

  for (const img of unionMatches(item, config.image, { exclude })) {
    if (insideContainer(img) || matchesAny(img, config.emojiImage)) continue;
    found.push({
      attachment: {
        kind: 'image',
        name: img.getAttribute('alt') || img.getAttribute('title') || null,
        url: safeUrl(img.getAttribute('src'), ['http:', 'https:']),
      },
      element: img,
    });
  }

  for (const card of outermost(unionMatches(item, config.card, { exclude }))) {
    const heading = card.querySelector('h1, h2, h3, [role="heading"], strong');
    found.push({
      attachment: { kind: 'card', name: (textOf(heading) || textOf(card)).slice(0, 120) || null, url: firstLinkUrl(card) },
      element: null,
    });
  }

  for (const preview of outermost(unionMatches(item, config.linkPreview, { exclude }))) {
    const heading = preview.querySelector('h1, h2, h3, [role="heading"], strong, a');
    found.push({
      attachment: { kind: 'link-preview', name: (textOf(heading) || textOf(preview)).slice(0, 200) || null, url: firstLinkUrl(preview) },
      element: null,
    });
  }

  for (const image of inlineImages) found.push({ attachment: image.attachment, element: image.element });
  const unique = dedupeAttachments(found);
  return { attachments: unique.map((entry) => entry.attachment), imageElements: unique.map((entry) => entry.element) };
}

function hasEditedMarker(item: Element, profile: SelectorProfile, exclude: readonly string[], body: Element | null): boolean {
  if (firstMatch(item, profile.edited, { exclude })) return true;
  // Fallback: a standalone "Edited" label outside the message body.
  return safeQueryAll(item, 'span, div, p').some(
    (el) =>
      el.childElementCount === 0 &&
      /^\(?edited\)?$/i.test(textOf(el)) &&
      !(body && body.contains(el)) &&
      !isInsideExcluded(el, item, exclude),
  );
}

function isDeletedText(text: string, patterns: readonly string[]): boolean {
  const normalized = text.trim();
  if (!normalized) return false;
  return patterns.some((pattern) => {
    try {
      return new RegExp(pattern, 'i').test(normalized);
    } catch {
      return false;
    }
  });
}

/** Parses a single message-list item. */
export function parseItem(item: Element, ctx: ItemParseContext): ParsedItem {
  const profile = ctx.profile;
  const replyExclude = profile.reply.container;

  const messageId = readIdByRules(item, profile.messageId, { includeSelf: true, exclude: replyExclude });
  const authorEl = firstMatch(item, profile.author, { exclude: replyExclude });
  const bodyEl = firstMatch(item, profile.body, { exclude: replyExclude });
  const systemEl = matchesAny(item, profile.systemMessage) ? item : firstMatch(item, profile.systemMessage, { exclude: replyExclude });
  const dividerEl = matchesAny(item, profile.dateDivider) ? item : firstMatch(item, profile.dateDivider, { exclude: replyExclude });

  if (!messageId && !authorEl && !bodyEl && !systemEl) {
    if (dividerEl) return { type: 'divider', text: textOf(dividerEl) };
    return { type: 'skip', reason: 'no-message-structure' };
  }

  const kind: MessageKind = systemEl && !authorEl ? 'system' : 'message';
  const isSelf =
    kind === 'message' &&
    (matchesAny(item, profile.selfMessage) || firstMatch(item, profile.selfMessage, { exclude: replyExclude }) !== null);
  const timeEl = firstMatch(item, profile.timestamp, { exclude: replyExclude });
  const time = parseTimestampElement(timeEl, ctx);

  const bodyExclude = [
    ...profile.excludeFromBody,
    ...profile.reply.container,
    ...profile.attachments.container,
    ...profile.attachments.card,
    ...profile.attachments.linkPreview,
    ...profile.author,
    ...profile.timestamp,
  ];
  let contentRoot: Element = item;
  let usedBodyFallback = false;
  if (kind === 'system') {
    contentRoot = bodyEl ?? systemEl ?? item;
  } else if (bodyEl) {
    contentRoot = bodyEl;
  } else {
    usedBodyFallback = true;
    bodyExclude.push(...profile.dateDivider, ...profile.edited);
  }
  const content = serializeContent(contentRoot, {
    exclude: bodyExclude,
    mentionSelectors: profile.mention,
    emojiImageSelectors: profile.attachments.emojiImage,
  });

  const { attachments, imageElements } =
    kind === 'system' ? { attachments: [], imageElements: [] } : parseAttachments(item, profile, content.images);
  const replyTo = kind === 'system' ? null : parseReply(item, profile);
  const reactions = kind === 'system' ? [] : parseReactions(item, profile);

  if (!messageId && kind === 'message' && !content.text && attachments.length === 0 && !authorEl) {
    return { type: 'skip', reason: 'empty' };
  }

  return {
    type: 'message',
    message: {
      element: item,
      messageId,
      kind,
      authorName: kind === 'message' ? textOf(authorEl).slice(0, MAX_NAME_LENGTH) || null : null,
      authorId: authorEl ? findUserId(authorEl) : null,
      isSelf,
      timestampMs: time.ms,
      timestampSource: time.source,
      timestampRaw: time.raw,
      content,
      attachments,
      imageElements,
      replyTo,
      reactions,
      isEdited: kind === 'message' && hasEditedMarker(item, profile, replyExclude, bodyEl),
      isDeleted: isDeletedText(content.text, profile.deletedPatterns),
      usedBodyFallback,
    },
  };
}
