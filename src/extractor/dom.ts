/**
 * Defensive DOM query helpers. Invalid selectors (for example from user overrides)
 * never throw; they simply match nothing.
 */
import type { AttributeIdRule } from './selectors';

export function safeQueryAll(root: ParentNode, selector: string): Element[] {
  try {
    return Array.from(root.querySelectorAll(selector));
  } catch {
    return [];
  }
}

export function safeMatches(element: Element, selector: string): boolean {
  try {
    return element.matches(selector);
  } catch {
    return false;
  }
}

export function matchesAny(element: Element, selectors: readonly string[]): boolean {
  return selectors.some((selector) => safeMatches(element, selector));
}

/**
 * True when `element` lies inside a subtree matching one of `excluded`, looking
 * only at `element` itself and its ancestors strictly below `boundary`.
 */
export function isInsideExcluded(element: Element, boundary: Element, excluded: readonly string[]): boolean {
  if (excluded.length === 0) return false;
  let node: Element | null = element;
  while (node && node !== boundary) {
    if (matchesAny(node, excluded)) return true;
    node = node.parentElement;
  }
  return false;
}

export interface QueryOptions {
  /** Also consider the scope element itself. */
  includeSelf?: boolean;
  /** Ignore matches located inside subtrees matching these selectors. */
  exclude?: readonly string[];
}

function candidatesFor(scope: Element, selector: string, options: QueryOptions): Element[] {
  const found = safeQueryAll(scope, selector);
  if (options.includeSelf && safeMatches(scope, selector)) found.unshift(scope);
  const exclude = options.exclude ?? [];
  return exclude.length === 0 ? found : found.filter((el) => el === scope || !isInsideExcluded(el, scope, exclude));
}

/** First element matching the highest-priority selector that matches anything. */
export function firstMatch(scope: Element, selectors: readonly string[], options: QueryOptions = {}): Element | null {
  for (const selector of selectors) {
    const found = candidatesFor(scope, selector, options);
    if (found.length > 0) return found[0] as Element;
  }
  return null;
}

/** All elements matching the highest-priority selector that matches anything. */
export function firstNonEmptyMatches(scope: ParentNode, selectors: readonly string[]): { selector: string | null; elements: Element[] } {
  for (const selector of selectors) {
    const elements = safeQueryAll(scope, selector);
    if (elements.length > 0) return { selector, elements };
  }
  return { selector: null, elements: [] };
}

/** Union of all matches of all selectors, in document order, without duplicates. */
export function unionMatches(scope: Element, selectors: readonly string[], options: QueryOptions = {}): Element[] {
  const set = new Set<Element>();
  for (const selector of selectors) {
    for (const el of candidatesFor(scope, selector, options)) set.add(el);
  }
  return sortInDocumentOrder(Array.from(set));
}

export function sortInDocumentOrder(elements: Element[]): Element[] {
  return elements.sort((a, b) => {
    if (a === b) return 0;
    const position = a.compareDocumentPosition(b);
    if (position & 4 /* DOCUMENT_POSITION_FOLLOWING */) return -1;
    if (position & 2 /* DOCUMENT_POSITION_PRECEDING */) return 1;
    return 0;
  });
}

/** Removes elements that are contained in another element of the list (result in document order). */
export function outermost(elements: Element[]): Element[] {
  const sorted = sortInDocumentOrder(Array.from(new Set(elements)));
  const result: Element[] = [];
  let lastKept: Element | null = null;
  for (const el of sorted) {
    // In document order, only the most recently kept element can contain a later one.
    if (lastKept && lastKept.contains(el)) continue;
    result.push(el);
    lastKept = el;
  }
  return result;
}

/** Collapsed, trimmed text content. */
export function textOf(element: Element | null | undefined): string {
  if (!element) return '';
  return (element.textContent ?? '').replace(/\s+/g, ' ').trim();
}

/** Text content excluding subtrees that match `exclude`. */
export function textOutside(element: Element, exclude: readonly string[]): string {
  if (exclude.length === 0) return textOf(element);
  const parts: string[] = [];
  const walk = (node: Node): void => {
    if (node.nodeType === 3 /* TEXT_NODE */) {
      parts.push(node.nodeValue ?? '');
      return;
    }
    if (node.nodeType !== 1 /* ELEMENT_NODE */) return;
    const el = node as Element;
    if (el !== element && matchesAny(el, exclude)) return;
    el.childNodes.forEach(walk);
  };
  walk(element);
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

/** Reads an id using the first rule that yields one. */
export function readIdByRules(scope: Element, rules: readonly AttributeIdRule[], options: QueryOptions = {}): string | null {
  for (const rule of rules) {
    let regex: RegExp | null = null;
    if (rule.pattern) {
      try {
        regex = new RegExp(rule.pattern);
      } catch {
        continue;
      }
    }
    for (const el of candidatesFor(scope, rule.selector, options)) {
      const value = el.getAttribute(rule.attribute)?.trim();
      if (!value) continue;
      if (!regex) return value;
      const match = regex.exec(value);
      if (match) return (match[1] ?? match[0]).trim();
    }
  }
  return null;
}

export function safeUrl(value: string | null | undefined, allowed: readonly string[] = ['http:', 'https:', 'mailto:', 'tel:']): string | null {
  if (!value) return null;
  try {
    const url = new URL(value, 'https://teams.microsoft.com/');
    return allowed.includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}
