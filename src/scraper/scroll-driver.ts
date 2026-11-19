/**
 * Thin abstraction over the scrollable message viewport. Works for regular containers and
 * for `flex-direction: column-reverse` ones (where scrollTop is <= 0): "up" always means
 * towards older messages, and a scroll that does not move signals the top of the list.
 */
import { safeQueryAll } from '../extractor/dom';
import type { SelectorProfile } from '../extractor/selectors';

export interface ScrollState {
  top: number;
  height: number;
  client: number;
}

export interface ScrollMove {
  before: number;
  after: number;
  moved: boolean;
}

export interface ScrollDriver {
  readonly element: HTMLElement;
  state(): ScrollState;
  viewportHeight(): number;
  scrollUp(px: number): ScrollMove;
  scrollDown(px: number): ScrollMove;
  scrollToBottom(): void;
  isAtBottom(): boolean;
  /** True when the viewport shows the oldest loaded content. */
  isAtTop(): boolean;
}

function computed(element: Element): CSSStyleDeclaration | null {
  try {
    return (element.ownerDocument.defaultView ?? window).getComputedStyle(element);
  } catch {
    return null;
  }
}

export function createScrollDriver(element: HTMLElement): ScrollDriver {
  const reversed = computed(element)?.flexDirection === 'column-reverse';

  const setTop = (value: number) => {
    const style = computed(element);
    if (style?.scrollBehavior === 'smooth' && typeof element.scrollTo === 'function') {
      element.scrollTo({ top: value, behavior: 'instant' as ScrollBehavior });
    } else {
      element.scrollTop = value;
    }
  };

  const move = (delta: number): ScrollMove => {
    const before = element.scrollTop;
    setTop(before + delta);
    const after = element.scrollTop;
    return { before, after, moved: Math.abs(after - before) >= 1 };
  };

  return {
    element,
    state: () => ({ top: element.scrollTop, height: element.scrollHeight, client: element.clientHeight }),
    viewportHeight: () => element.clientHeight || element.getBoundingClientRect().height || 600,
    scrollUp: (px) => move(-Math.abs(px)),
    scrollDown: (px) => move(Math.abs(px)),
    scrollToBottom: () => setTop(reversed ? 0 : element.scrollHeight),
    isAtBottom: () =>
      reversed ? Math.abs(element.scrollTop) <= 2 : element.scrollTop + element.clientHeight >= element.scrollHeight - 2,
    isAtTop: () =>
      reversed ? element.scrollTop <= -(element.scrollHeight - element.clientHeight) + 2 : element.scrollTop <= 2,
  };
}

/** Locates the scrollable viewport that contains the message list. */
export function findScrollContainer(doc: Document, profile: SelectorProfile, list: Element): HTMLElement {
  for (const selector of profile.scrollContainer) {
    for (const el of safeQueryAll(doc, selector)) {
      if (el === list || el.contains(list)) return el as HTMLElement;
    }
  }
  const scrollable = (el: Element) => /(auto|scroll|overlay)/.test(computed(el)?.overflowY ?? '');
  for (let node: Element | null = list; node && node !== doc.documentElement; node = node.parentElement) {
    if (scrollable(node) && node.scrollHeight > node.clientHeight) return node as HTMLElement;
  }
  for (let node: Element | null = list; node && node !== doc.documentElement; node = node.parentElement) {
    if (scrollable(node)) return node as HTMLElement;
  }
  return list as HTMLElement;
}
