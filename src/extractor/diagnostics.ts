/**
 * Selector health report for the current Teams page. The report contains counts and a
 * redacted structural skeleton only (no message text, names or ids), so it is safe to
 * share when tuning selector overrides after a Teams UI change.
 */
import type { DateOrder } from '../shared/time';
import type { ConversationIdentity, ExtractedMessage } from '../shared/types';
import { safeQueryAll } from './dom';
import { collectItems, findMessageList, parseRenderedConversation } from './page-parser';
import type { AttributeIdRule, SelectorProfile } from './selectors';

export interface SelectorHit {
  selector: string;
  count: number;
}

export interface DiagnosticsReport {
  generatedAt: string;
  page: { origin: string; path: string; visibility: string };
  conversation: {
    detected: boolean;
    keySource: string | null;
    type: string | null;
    hasThreadId: boolean;
    titleLength: number;
  };
  messageList: { found: boolean; selector: string | null };
  scrollContainer: { found: boolean; scrollTop: number; scrollHeight: number; clientHeight: number } | null;
  hits: Record<string, SelectorHit[]>;
  parse: {
    items: number;
    messages: number;
    skipped: number;
    dividers: number;
    withMessageId: number;
    senderExplicit: number;
    senderSelf: number;
    senderInferred: number;
    senderUnknown: number;
    timestampSources: Record<string, number>;
    withText: number;
    withAttachments: number;
    withReply: number;
    system: number;
    edited: number;
    deleted: number;
  };
  samples: Array<{
    position: number;
    hasMessageId: boolean;
    kind: string;
    senderSource: string;
    timestampSource: string;
    sortKeySource: string | null;
    textLength: number;
    paragraphs: number;
    attachments: string[];
    reply: string | null;
  }>;
  skeleton: string | null;
  warnings: string[];
}

const THREAD_PATTERN = /19:[A-Za-z0-9._-]+@/g;

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Removes thread ids (also URL-encoded ones) and long numbers such as message ids. */
function redact(value: string): string {
  return safeDecode(value).replace(THREAD_PATTERN, '19:<id>@').replace(/\d{4,}/g, '<n>');
}

/** Redacted outline of an element: tags, test ids, roles and Fluent class names only. */
export function skeletonOf(root: Element, maxNodes = 150, maxDepth = 14): string {
  const lines: string[] = [];
  let budget = maxNodes;
  const visit = (el: Element, depth: number): void => {
    if (budget-- <= 0) {
      if (budget === -1) lines.push(`${'  '.repeat(depth)}…`);
      return;
    }
    const parts = [el.localName];
    for (const name of ['data-tid', 'role', 'itemprop', 'itemtype', 'aria-selected', 'aria-current']) {
      const value = el.getAttribute(name);
      if (value !== null) parts.push(`${name}="${redact(value)}"`);
    }
    if (el.id) parts.push(`id="${redact(el.id)}"`);
    const classes = Array.from(el.classList).filter((cls) => /^(fui-|ac-)/.test(cls));
    if (classes.length) parts.push(`class="${classes.join(' ')}"`);
    const otherAttributes = Array.from(el.attributes)
      .map((attr) => attr.name)
      .filter((name) => !['data-tid', 'role', 'itemprop', 'itemtype', 'aria-selected', 'aria-current', 'id', 'class', 'style'].includes(name));
    if (otherAttributes.length) parts.push(`[${otherAttributes.join(' ')}]`);
    const ownText = Array.from(el.childNodes)
      .filter((node) => node.nodeType === 3)
      .map((node) => node.nodeValue ?? '')
      .join('')
      .trim();
    lines.push(`${'  '.repeat(depth)}<${parts.join(' ')}>${ownText ? ` [text ${ownText.length}]` : ''}`);
    if (depth >= maxDepth) return;
    Array.from(el.children).forEach((child) => visit(child, depth + 1));
  };
  visit(root, 0);
  return lines.join('\n');
}

function countHits(scope: ParentNode, selectors: readonly string[]): SelectorHit[] {
  return selectors.map((selector) => ({ selector, count: safeQueryAll(scope, selector).length }));
}

function ruleHits(scope: ParentNode, rules: readonly AttributeIdRule[]): SelectorHit[] {
  return rules.map((rule) => ({ selector: `${rule.selector} @${rule.attribute}`, count: safeQueryAll(scope, rule.selector).length }));
}

function paragraphCount(message: ExtractedMessage): number {
  return message.text ? message.text.split(/\n{2,}/).length : 0;
}

export interface DiagnosticsOptions {
  profile: SelectorProfile;
  conversation: ConversationIdentity | null;
  href: string;
  selfDisplayName: string | null;
  dateOrder: DateOrder;
  referenceMs: number;
  scrollContainer?: HTMLElement | null;
}

export function runDiagnostics(doc: Document, options: DiagnosticsOptions): DiagnosticsReport {
  const { profile, conversation } = options;
  const warnings: string[] = [];
  let origin = '';
  let path = '';
  try {
    const url = new URL(options.href);
    origin = url.origin;
    path = redact(url.pathname);
  } catch {
    // Leave empty for non-URL inputs.
  }

  const list = findMessageList(doc, profile);
  const listSelector = list ? profile.messageList.find((selector) => safeQueryAll(doc, selector).includes(list)) ?? null : null;
  const scope: ParentNode = list ?? doc;

  const hits: Record<string, SelectorHit[]> = {
    messageList: countHits(doc, profile.messageList),
    scrollContainer: countHits(doc, profile.scrollContainer),
    chatTitle: countHits(doc, profile.chatTitle),
    selectedChatItem: countHits(doc, profile.selectedChatItem),
    messageItem: countHits(scope, profile.messageItem),
    messageId: ruleHits(scope, profile.messageId),
    author: countHits(scope, profile.author),
    timestamp: countHits(scope, profile.timestamp),
    body: countHits(scope, profile.body),
    selfMessage: countHits(scope, profile.selfMessage),
    systemMessage: countHits(scope, profile.systemMessage),
    dateDivider: countHits(scope, profile.dateDivider),
    'reply.container': countHits(scope, profile.reply.container),
    'attachments.container': countHits(scope, profile.attachments.container),
    'attachments.image': countHits(scope, profile.attachments.image),
    mention: countHits(scope, profile.mention),
    edited: countHits(scope, profile.edited),
    loadingIndicator: countHits(doc, profile.loadingIndicator),
  };

  const parse: DiagnosticsReport['parse'] = {
    items: 0,
    messages: 0,
    skipped: 0,
    dividers: 0,
    withMessageId: 0,
    senderExplicit: 0,
    senderSelf: 0,
    senderInferred: 0,
    senderUnknown: 0,
    timestampSources: {},
    withText: 0,
    withAttachments: 0,
    withReply: 0,
    system: 0,
    edited: 0,
    deleted: 0,
  };
  const samples: DiagnosticsReport['samples'] = [];
  let skeleton: string | null = null;

  if (!list) warnings.push('Message list not found: open a chat, or override "messageList".');
  if (!conversation) warnings.push('Conversation could not be identified: override "selectedChatItem" or "chatTitle".');
  else if (!conversation.threadId) warnings.push('No Teams thread id found; the chat title is used as the archive key.');

  if (list && conversation) {
    const result = parseRenderedConversation(doc, {
      profile,
      conversation,
      selfDisplayName: options.selfDisplayName,
      referenceMs: options.referenceMs,
      dateOrder: options.dateOrder,
      listElement: list,
    });
    warnings.push(...result.warnings);
    parse.items = result.itemCount;
    parse.messages = result.messages.length;
    parse.skipped = result.skipped;
    parse.dividers = result.dividers;
    for (const message of result.messages) {
      if (message.messageId) parse.withMessageId++;
      if (message.sender.source === 'explicit') parse.senderExplicit++;
      else if (message.sender.source === 'self') parse.senderSelf++;
      else if (message.sender.source === 'group-inferred') parse.senderInferred++;
      else if (message.kind === 'message') parse.senderUnknown++;
      parse.timestampSources[message.timestampSource] = (parse.timestampSources[message.timestampSource] ?? 0) + 1;
      if (message.text) parse.withText++;
      if (message.attachments.length) parse.withAttachments++;
      if (message.replyTo) parse.withReply++;
      if (message.kind === 'system') parse.system++;
      if (message.isEdited) parse.edited++;
      if (message.isDeleted) parse.deleted++;
    }
    const picked = result.messages.length <= 10 ? result.messages : [...result.messages.slice(0, 5), ...result.messages.slice(-5)];
    for (const message of picked) {
      samples.push({
        position: result.messages.indexOf(message),
        hasMessageId: message.messageId !== null,
        kind: message.kind,
        senderSource: message.sender.source,
        timestampSource: message.timestampSource,
        sortKeySource: message.sortKeySource,
        textLength: message.text.length,
        paragraphs: paragraphCount(message),
        attachments: message.attachments.map((att) => att.kind),
        reply: message.replyTo ? message.replyTo.resolution : null,
      });
    }
    if (parse.messages > 0 && parse.withMessageId === 0) warnings.push('No Teams message ids found: duplicate detection falls back to content fingerprints.');
    if (parse.messages > 0 && (parse.timestampSources.none ?? 0) === parse.messages) warnings.push('No timestamps found: override "timestamp".');
    if (parse.messages === 0) warnings.push('No messages parsed: override "messageItem" / "body".');

    const items = collectItems(list, profile);
    const representative = items.find((item) => item.textContent && item.textContent.trim().length > 0) ?? items[0] ?? null;
    skeleton = representative ? skeletonOf(representative) : skeletonOf(list, 60, 6);
  }

  const scroller = options.scrollContainer ?? null;
  return {
    generatedAt: new Date(options.referenceMs).toISOString(),
    page: { origin, path, visibility: doc.visibilityState ?? 'unknown' },
    conversation: {
      detected: conversation !== null,
      keySource: conversation?.keySource ?? null,
      type: conversation?.type ?? null,
      hasThreadId: Boolean(conversation?.threadId),
      titleLength: conversation?.title?.length ?? 0,
    },
    messageList: { found: list !== null, selector: listSelector },
    scrollContainer: scroller
      ? { found: true, scrollTop: Math.round(scroller.scrollTop), scrollHeight: scroller.scrollHeight, clientHeight: scroller.clientHeight }
      : null,
    hits,
    parse,
    samples,
    skeleton,
    warnings,
  };
}
