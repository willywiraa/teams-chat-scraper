/**
 * Identifies the conversation currently open in Teams Web.
 *
 * Preferred source is the Teams thread id (`19:...@thread.v2`, `19:..._...@unq.gbl.spaces`),
 * read from the highlighted chat-list entry, then from the URL, then from other page hints such
 * as the chat header. If no thread id is available the normalised chat title is used as a weaker
 * key; an entry archived under it is found again once the id shows (see conversation-identity.ts).
 */
import type { ConversationIdentity, ConversationType } from '../shared/types';
import { safeQueryAll, textOf } from './dom';
import type { SelectorProfile } from './selectors';

const THREAD_ID_PATTERN = /19:[A-Za-z0-9._-]+@(?:thread\.v2|thread\.tacv2|thread\.skype|unq\.gbl\.spaces|p2p\.thread\.skype)|48:notes/i;
const MAX_SCAN_NODES = 200;

function safeDecode(value: string): string {
  if (!/%[0-9a-f]{2}/i.test(value)) return value;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function extractThreadId(value: string | null | undefined): string | null {
  if (!value) return null;
  const match = THREAD_ID_PATTERN.exec(safeDecode(value));
  return match ? match[0] : null;
}

/** Scans the attributes of an element and its descendants for a thread id. */
export function scanForThreadId(root: Element, maxNodes = MAX_SCAN_NODES): string | null {
  const queue: Element[] = [root];
  let visited = 0;
  while (queue.length > 0 && visited < maxNodes) {
    const el = queue.shift() as Element;
    visited++;
    for (const attr of Array.from(el.attributes)) {
      const id = extractThreadId(attr.value);
      if (id) return id;
    }
    queue.push(...Array.from(el.children));
  }
  return null;
}

export function conversationTypeFromThreadId(threadId: string): ConversationType {
  if (/^48:notes$/i.test(threadId)) return 'one-on-one';
  if (/@(unq\.gbl\.spaces|p2p\.thread\.skype)$/i.test(threadId)) return 'one-on-one';
  if (/^19:meeting_/i.test(threadId)) return 'meeting';
  if (/@thread\.(tacv2|skype)$/i.test(threadId)) return 'channel';
  if (/@thread\.v2$/i.test(threadId)) return 'group';
  return 'unknown';
}

export function normalizeTitleKey(title: string): string {
  return title.normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim();
}

function titleFromDocumentTitle(docTitle: string): string | null {
  const parts = docTitle
    .replace(/^\(\d+\)\s*/, '')
    .split('|')
    .map((part) => part.trim())
    .filter((part) => part && !/^microsoft teams$/i.test(part) && !/^(chat|teams|activity)$/i.test(part));
  return parts[0] ?? null;
}

function firstSelected(doc: Document, profile: SelectorProfile): Element | null {
  for (const selector of profile.selectedChatItem) {
    const found = safeQueryAll(doc, selector);
    if (found.length > 0) return found[0] as Element;
  }
  return null;
}

export function detectConversation(doc: Document, href: string, profile: SelectorProfile): ConversationIdentity | null {
  let threadId: string | null = null;
  let keySource: ConversationIdentity['keySource'] = 'title';

  for (const selector of profile.selectedChatItem) {
    for (const el of safeQueryAll(doc, selector)) {
      threadId = scanForThreadId(el);
      if (threadId) break;
    }
    if (threadId) break;
  }
  if (threadId) keySource = 'dom';

  if (!threadId) {
    threadId = extractThreadId(href);
    if (threadId) keySource = 'url';
  }
  if (!threadId) {
    for (const selector of profile.threadIdHints) {
      for (const el of safeQueryAll(doc, selector)) {
        threadId = scanForThreadId(el, 50);
        if (threadId) break;
      }
      if (threadId) break;
    }
    if (threadId) keySource = 'dom';
  }

  let title: string | null = null;
  for (const selector of profile.chatTitle) {
    const text = safeQueryAll(doc, selector).map((el) => textOf(el)).find((value) => value.length > 0);
    if (text) {
      title = text;
      break;
    }
  }
  if (!title) {
    const selected = firstSelected(doc, profile);
    const label = selected?.getAttribute('aria-label')?.trim() || textOf(selected);
    title = label ? (label.split('\n')[0] as string).trim() : null;
  }
  if (!title) title = titleFromDocumentTitle(doc.title ?? '');
  if (title) title = title.slice(0, 300);

  if (!threadId && !title) return null;
  return {
    conversationKey: threadId ? `teams:${threadId}` : `title:${normalizeTitleKey(title as string)}`,
    threadId,
    title,
    type: threadId ? conversationTypeFromThreadId(threadId) : 'unknown',
    keySource: threadId ? keySource : 'title',
    typeSource: threadId ? 'thread-id' : 'unknown',
  };
}
