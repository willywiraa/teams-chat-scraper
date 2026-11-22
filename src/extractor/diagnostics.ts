/**
 * Selector health report for the current Teams page. The report contains counts, redacted
 * structural skeletons and, for identifiers, only their kind and where they appear (no message
 * text, names or ids), so it is safe to share when tuning selector overrides after a Teams UI
 * change.
 */
import type { DateOrder } from '../shared/time';
import type { ConversationIdentity, ExtractedMessage } from '../shared/types';
import { safeQueryAll } from './dom';
import { probePage, redactIdentifiers, type IdentifierProbe, type ProbeRegion } from './id-probe';
import { collectItems, findMessageList, parseRenderedConversation } from './page-parser';
import type { AttributeIdRule, SelectorProfile } from './selectors';

export interface SelectorHit {
  selector: string;
  count: number;
}

/**
 * Version of the report layout; 2 added the identifier probe, the extra selector probes and the
 * skeletons; 3 the reaction selector, the count of messages with reactions and each sample's reactions.
 */
export const DIAGNOSTICS_REPORT_VERSION = 3;

export interface DiagnosticsReport {
  reportVersion: number;
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
    withReactions: number;
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
    /** Number of reactions read under the message. */
    reactions: number;
  }>;
  /** Outline of a representative message item. */
  skeleton: string | null;
  /** Where chat and person identifiers appear on the page (kinds and places only). */
  identifiers: IdentifierProbe;
  /** Counts for markup the selector profile does not use (yet), such as other reply forms. */
  probes: Record<string, SelectorHit[]>;
  /** Outlines of the chat header, the highlighted chat-list entry and the first quoted reply. */
  skeletons: { chatHeader: string | null; highlightedEntry: string | null; reply: string | null };
  warnings: string[];
}

/** An attribute value fit for a skeleton: identifiers and long numbers removed, free text elided. */
function redact(value: string): string {
  const redacted = redactIdentifiers(value);
  return /\s/.test(redacted.trim()) || redacted.length > 80 ? '<other>' : redacted;
}

/** Quoted-reply markup seen in new Teams that the default reply selectors do not cover. */
const REPLY_LEADS = ['[data-tid="referencePreview"]', '[role="group"][aria-label^="Begin Reference"]'];

/** Candidate selectors that are counted but not used for parsing. */
const PROBES: ReadonlyArray<{ name: string; scope: 'page' | 'list'; selectors: readonly string[] }> = [
  {
    name: 'conversation.header',
    scope: 'page',
    selectors: ['[id^="chat-header-"]', '[id^="chat-topic-person-"]', '[data-tid="chat-header"]', '[data-tid*="chat-header"]', '[data-tid*="chat-title"]', '[role="main"] h1', '[role="main"] h2'],
  },
  {
    name: 'conversation.list',
    scope: 'page',
    selectors: ['[data-tid="chat-list-item"]', '[data-tid*="chat-list"]', '[role="tree"]', '[role="treeitem"]', '[data-fui-tree-item-value]', '[aria-selected="true"]', '[aria-current]:not([aria-current="false"])'],
  },
  {
    name: 'message.author',
    scope: 'list',
    selectors: ['[id^="author-"]', '[data-tid="message-author-name"]', '[data-tid="message-avatar"]', '[data-tid="message-avatar"] img', 'img[src*="profilepicture"]', '.fui-Avatar'],
  },
  { name: 'message.reply', scope: 'list', selectors: [...REPLY_LEADS, '[data-tid*="reference"]', '[data-tid*="quote"]', '[itemtype*="Reply"]', 'blockquote'] },
  { name: 'message.reaction', scope: 'list', selectors: ['[data-tid="diverse-reaction-pill-button"]', '[data-tid*="reaction"]'] },
  { name: 'message.image', scope: 'list', selectors: ['img[data-tid="rich-file-preview-image"]', 'img[itemtype*="AMSImage"]', 'img[data-gallery-src]', 'img[src^="blob:"]', 'img'] },
  { name: 'message.file', scope: 'list', selectors: ['[data-tid="file-preview-root"]', '[data-tid*="file-preview"]', '[data-tid*="file-card"]', '[data-tid*="attachment"]'] },
];

const REGION_NAMES: Record<ProbeRegion, string> = {
  'selected-entry': 'selected chat entry',
  'chat-header': 'chat header',
  'message-list': 'message list',
  main: 'main area',
  elsewhere: 'rest of the page',
};

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

/** What the identifier probe says about a chat that the extension identifies by its title. */
function identifierWarnings(probe: IdentifierProbe): string[] {
  const warnings: string[] = [];
  const isThread = (kind: string): boolean => kind.startsWith('thread:');
  const near = probe.findings.filter((finding) => isThread(finding.kind) && (finding.region === 'chat-header' || finding.region === 'selected-entry'));
  if (near.length > 0) {
    const where = unique(near.map((finding) => REGION_NAMES[finding.region]));
    const attributes = unique(near.map((finding) => finding.attribute));
    warnings.push(`A Teams thread id is shown in the ${where.join(' and ')} (${attributes.join(', ')}), but it is not read from there yet.`);
  }
  const missed = probe.highlighted.find((item) => item.selectorIndex === null && item.region === 'elsewhere' && item.identifiers.some((id) => isThread(id.kind)));
  if (missed) {
    const attributes = unique(missed.identifiers.filter((id) => isThread(id.kind)).map((id) => id.attribute));
    warnings.push(`The highlighted chat-list entry (${missed.element}) has a thread id (${attributes.join(', ')}) but does not match the "selectedChatItem" selectors.`);
  }
  if (near.length === 0 && !missed && !probe.url.kinds.some(isThread)) warnings.push('No thread id for this chat is shown on the page.');
  return warnings;
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
    path = redactIdentifiers(url.pathname);
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
    reaction: countHits(scope, profile.reaction),
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
    withReactions: 0,
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
      if ((message.reactions ?? []).length > 0) parse.withReactions++;
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
        reactions: (message.reactions ?? []).length,
      });
    }
    if (parse.messages > 0 && parse.withMessageId === 0) warnings.push('No Teams message ids found: duplicate detection falls back to content fingerprints.');
    if (parse.messages > 0 && (parse.timestampSources.none ?? 0) === parse.messages) warnings.push('No timestamps found: override "timestamp".');
    if (parse.messages === 0) warnings.push('No messages parsed: override "messageItem" / "body".');

    const items = collectItems(list, profile);
    const representative = items.find((item) => item.textContent && item.textContent.trim().length > 0) ?? items[0] ?? null;
    skeleton = representative ? skeletonOf(representative) : skeletonOf(list, 60, 6);
  }

  const { probe, regions, entry } = probePage(doc, { profile, list, href: options.href });
  if (conversation && !conversation.threadId) warnings.push(...identifierWarnings(probe));

  const probes: Record<string, SelectorHit[]> = {};
  for (const { name, scope: where, selectors } of PROBES) probes[name] = countHits(where === 'list' ? scope : doc, selectors);
  const replyLeads = (probes['message.reply'] ?? []).filter((hit) => REPLY_LEADS.includes(hit.selector) && hit.count > 0);
  if (replyLeads.length > 0 && !hits['reply.container']?.some((hit) => hit.count > 0)) {
    warnings.push(`Quoted replies are shown as ${replyLeads.map((hit) => hit.selector).join(' or ')}, which the reply selectors do not recognise yet.`);
  }
  const reactionMarkup = (probes['message.reaction'] ?? []).filter((hit) => hit.count > 0);
  if (reactionMarkup.length > 0 && !hits.reaction?.some((hit) => hit.count > 0)) {
    warnings.push(`Reaction markup was found (${reactionMarkup.map((hit) => hit.selector).join(', ')}), but the reaction selectors match none of it.`);
  }
  let reply: Element | null = null;
  for (const selector of [...REPLY_LEADS, ...profile.reply.container]) {
    reply = safeQueryAll(scope, selector)[0] ?? null;
    if (reply) break;
  }

  const scroller = options.scrollContainer ?? null;
  return {
    reportVersion: DIAGNOSTICS_REPORT_VERSION,
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
    identifiers: probe,
    probes,
    skeletons: {
      chatHeader: regions.header ? skeletonOf(regions.header, 80, 10) : null,
      highlightedEntry: entry ? skeletonOf(entry, 40, 8) : null,
      reply: reply ? skeletonOf(reply, 40, 8) : null,
    },
    warnings,
  };
}
