/**
 * Converts a rendered message body into normalised plain text (paragraphs preserved)
 * and a compact, sanitised HTML string, collecting mentions, links and inline images.
 *
 * Deliberately independent of layout APIs such as innerText so that results are
 * deterministic and identical in the browser and in unit tests.
 */
import type { Attachment, Link, Mention } from '../shared/types';
import { matchesAny, safeUrl, textOf } from './dom';

export interface SerializeOptions {
  /** Subtrees to drop entirely (quoted replies, attachment cards, UI chrome). */
  exclude: readonly string[];
  mentionSelectors: readonly string[];
  emojiImageSelectors: readonly string[];
  maxTextLength?: number;
  maxHtmlLength?: number;
}

export interface SerializedContent {
  text: string;
  html: string;
  mentions: Mention[];
  links: Link[];
  /** Non-emoji inline images found in the body, with the element that displays each. */
  images: InlineImage[];
}

const DROP_TAGS = new Set([
  'script', 'style', 'svg', 'template', 'button', 'iframe', 'object', 'embed', 'input',
  'textarea', 'select', 'noscript', 'canvas', 'video', 'audio', 'head', 'link', 'meta',
]);
const PARAGRAPH_BLOCKS = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'pre', 'ul', 'ol', 'table', 'hr', 'figure']);
const LINE_BLOCKS = new Set([
  'div', 'li', 'tr', 'dt', 'dd', 'section', 'article', 'header', 'footer', 'aside', 'nav', 'main',
  'address', 'details', 'summary', 'figcaption', 'dl', 'fieldset', 'form', 'thead', 'tbody', 'tfoot', 'caption',
]);
const ALLOWED_TAGS = new Set([
  'p', 'br', 'div', 'span', 'strong', 'b', 'em', 'i', 'u', 's', 'strike', 'del', 'ins', 'code', 'pre',
  'blockquote', 'ul', 'ol', 'li', 'a', 'img', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'table', 'thead',
  'tbody', 'tfoot', 'tr', 'td', 'th', 'hr', 'sub', 'sup', 'mark', 'small',
]);
const VOID_TAGS = new Set(['br', 'img', 'hr']);
const USER_ID_PATTERN = /\b8:(?:orgid|live|teamsvisitor|gid|sfb|acs):[A-Za-z0-9._-]+/;
const EMOJI_PATTERN = /\p{Extended_Pictographic}/u;

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Finds a Teams user id (MRI) in the attributes of an element. */
export function findUserId(element: Element): string | null {
  for (const attr of Array.from(element.attributes)) {
    const match = USER_ID_PATTERN.exec(attr.value);
    if (match) return match[0];
  }
  return null;
}

class TextBuilder {
  private out = '';
  private pendingBreaks = 0;

  requireBreak(count: number): void {
    if (this.out.length > 0) this.pendingBreaks = Math.max(this.pendingBreaks, count);
  }

  private flushBreaks(): void {
    if (this.pendingBreaks === 0) return;
    this.out = this.out.replace(/[ \t]+$/, '');
    const trailing = (/\n*$/.exec(this.out)?.[0] ?? '').length;
    if (this.pendingBreaks > trailing) this.out += '\n'.repeat(this.pendingBreaks - trailing);
    this.pendingBreaks = 0;
  }

  appendText(raw: string, preserveWhitespace: boolean): void {
    let text = raw;
    if (!preserveWhitespace) {
      text = text.replace(/[\s ]+/g, ' ');
      const atLineStart = this.out.length === 0 || this.out.endsWith('\n') || this.pendingBreaks > 0;
      if (atLineStart) text = text.replace(/^ +/, '');
      else if (this.out.endsWith(' ') && text.startsWith(' ')) text = text.slice(1);
      if (text.length === 0) return;
    }
    this.flushBreaks();
    this.out += text;
  }

  lineBreak(): void {
    this.flushBreaks();
    this.out = this.out.replace(/[ \t]+$/, '') + '\n';
  }

  toString(): string {
    return this.out
      .split('\n')
      .map((line) => line.replace(/[ \t ]+$/, ''))
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }
}

function isHidden(element: Element): boolean {
  if (element.hasAttribute('hidden')) return true;
  const style = (element.getAttribute('style') ?? '').replace(/\s+/g, '').toLowerCase();
  return style.includes('display:none') || style.includes('visibility:hidden');
}

function isEmojiImage(img: Element, emojiSelectors: readonly string[]): boolean {
  if (matchesAny(img, emojiSelectors)) return true;
  const alt = img.getAttribute('alt') ?? '';
  return (alt.length > 0 && alt.length <= 8 && EMOJI_PATTERN.test(alt)) || /^\([a-z0-9_]+\)$/i.test(alt);
}

function allowedAttributes(element: Element, tag: string): string {
  const attrs: string[] = [];
  const add = (name: string, value: string | null) => {
    if (value !== null && value !== '') attrs.push(` ${name}="${escapeHtml(value)}"`);
  };
  switch (tag) {
    case 'a':
      add('href', safeUrl(element.getAttribute('href')));
      add('title', element.getAttribute('title'));
      break;
    case 'img':
      add('src', safeUrl(element.getAttribute('src'), ['http:', 'https:']));
      add('alt', element.getAttribute('alt'));
      add('title', element.getAttribute('title'));
      break;
    case 'td':
    case 'th':
      for (const name of ['colspan', 'rowspan']) {
        const value = element.getAttribute(name);
        if (value && /^\d{1,3}$/.test(value)) add(name, value);
      }
      break;
    case 'ol': {
      const start = element.getAttribute('start');
      if (start && /^\d{1,6}$/.test(start)) add('start', start);
      break;
    }
    case 'span': {
      const itemtype = element.getAttribute('itemtype');
      if (itemtype && itemtype.startsWith('http://schema.skype.com/')) {
        add('itemtype', itemtype);
        add('itemid', element.getAttribute('itemid'));
      }
      break;
    }
    default:
      break;
  }
  return attrs.join('');
}

export interface InlineImage {
  attachment: Attachment;
  element: Element;
}

export function serializeContent(root: Element, options: SerializeOptions): SerializedContent {
  const maxText = options.maxTextLength ?? 200_000;
  const maxHtml = options.maxHtmlLength ?? 150_000;
  const text = new TextBuilder();
  const htmlParts: string[] = [];
  const mentions: Mention[] = [];
  const links: Link[] = [];
  const images: InlineImage[] = [];

  const listStack: Array<{ ordered: boolean; index: number }> = [];
  let preDepth = 0;

  const walk = (node: Node, isRoot: boolean): void => {
    if (node.nodeType === 3 /* TEXT_NODE */) {
      const value = node.nodeValue ?? '';
      text.appendText(value, preDepth > 0);
      htmlParts.push(escapeHtml(preDepth > 0 ? value : value.replace(/[ \t\n\r\f]+/g, ' ')));
      return;
    }
    if (node.nodeType !== 1 /* ELEMENT_NODE */) return;
    const el = node as Element;
    const tag = el.localName.toLowerCase();
    if (!isRoot) {
      if (DROP_TAGS.has(tag) || isHidden(el) || matchesAny(el, options.exclude)) return;
    }

    if (!isRoot && matchesAny(el, options.mentionSelectors)) {
      const name = textOf(el).replace(/^@/, '');
      if (name) mentions.push({ name, id: findUserId(el) });
    }

    if (tag === 'br') {
      text.lineBreak();
      htmlParts.push('<br>');
      return;
    }
    if (tag === 'img') {
      const alt = el.getAttribute('alt') ?? '';
      if (isEmojiImage(el, options.emojiImageSelectors)) {
        text.appendText(alt, false);
        htmlParts.push(escapeHtml(alt));
      } else {
        images.push({
          attachment: { kind: 'image', name: alt || el.getAttribute('title') || null, url: safeUrl(el.getAttribute('src'), ['http:', 'https:']) },
          element: el,
        });
        htmlParts.push(`<img${allowedAttributes(el, 'img')}>`);
      }
      return;
    }
    if (tag === 'hr') {
      text.requireBreak(2);
      htmlParts.push('<hr>');
      return;
    }

    const insideListItem = listStack.length > 0;
    const isList = tag === 'ul' || tag === 'ol';
    const breaks = !isRoot && (PARAGRAPH_BLOCKS.has(tag) ? (isList && insideListItem ? 1 : 2) : LINE_BLOCKS.has(tag) ? 1 : 0);
    if (breaks) text.requireBreak(breaks);

    const keepTag = !isRoot && ALLOWED_TAGS.has(tag);
    if (keepTag) htmlParts.push(`<${tag}${allowedAttributes(el, tag)}>`);

    if (tag === 'pre') preDepth++;
    if (isList) listStack.push({ ordered: tag === 'ol', index: Number(el.getAttribute('start') ?? '1') || 1 });
    if (tag === 'li') {
      const list = listStack[listStack.length - 1];
      const indent = '  '.repeat(Math.max(0, listStack.length - 1));
      const marker = list?.ordered ? `${list.index++}. ` : '- ';
      text.appendText(indent + marker, true);
    }
    if ((tag === 'td' || tag === 'th') && el.previousElementSibling) text.appendText(' | ', true);

    el.childNodes.forEach((child) => walk(child, false));

    if (tag === 'a') {
      const href = safeUrl(el.getAttribute('href'));
      if (href) links.push({ href, text: textOf(el) });
    }
    if (isList) listStack.pop();
    if (tag === 'pre') preDepth--;
    if (keepTag && !VOID_TAGS.has(tag)) htmlParts.push(`</${tag}>`);
    if (breaks) text.requireBreak(breaks);
  };

  walk(root, true);

  let plain = text.toString();
  if (plain.length > maxText) plain = `${plain.slice(0, maxText)}…`;
  let html = htmlParts.join('').trim();
  if (html.length > maxHtml) html = `<p>${escapeHtml(plain.slice(0, maxHtml))}</p>`;

  return { text: plain, html, mentions: dedupeBy(mentions, (m) => `${m.name}|${m.id ?? ''}`), links: dedupeBy(links, (l) => `${l.href}|${l.text}`), images };
}

export function dedupeBy<T>(items: T[], keyOf: (item: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = keyOf(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
