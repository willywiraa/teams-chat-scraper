/**
 * Thin abstraction over the scrollable message viewport. Works for regular containers and
 * for `flex-direction: column-reverse` ones (where scrollTop is <= 0): "up" always means
 * towards older messages, and a scroll that does not move signals the top of the list.
 *
 * Steps can be animated (smooth scrolling). The distance is then applied frame by frame as
 * small moves relative to the current position, so a correction Teams makes itself during
 * the animation (keeping the view in place when it prepends older messages) is kept, not undone.
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
  /** How far this step scrolled (px). Position changes the page made itself are not counted. */
  distance: number;
  moved: boolean;
}

export interface ScrollDriver {
  readonly element: HTMLElement;
  state(): ScrollState;
  viewportHeight(): number;
  /** Scrolls towards older messages, animated over `animateMs` when it is above 0 and the tab is visible. */
  scrollUp(px: number, animateMs?: number): Promise<ScrollMove>;
  scrollDown(px: number, animateMs?: number): Promise<ScrollMove>;
  scrollToBottom(): void;
  isAtBottom(): boolean;
  /** True when the viewport shows the oldest loaded content. */
  isAtTop(): boolean;
}

export interface ScrollDriverOptions {
  /** Ends a running animation early; the list stays where it is. */
  signal?: AbortSignal;
}

/** Slow start, quick middle, slow end. */
const ease = (t: number): number => (1 - Math.cos(Math.PI * t)) / 2;
/** Hidden tabs get no animation frames: a step still running this long after its duration is finished at once. */
const FRAME_GRACE_MS = 250;

function computed(element: Element): CSSStyleDeclaration | null {
  try {
    return (element.ownerDocument.defaultView ?? window).getComputedStyle(element);
  } catch {
    return null;
  }
}

export function createScrollDriver(element: HTMLElement, options: ScrollDriverOptions = {}): ScrollDriver {
  const doc = element.ownerDocument;
  const view = doc.defaultView;
  const reversed = computed(element)?.flexDirection === 'column-reverse';

  const setTop = (value: number) => {
    const style = computed(element);
    if (style?.scrollBehavior === 'smooth' && typeof element.scrollTo === 'function') {
      element.scrollTo({ top: value, behavior: 'instant' as ScrollBehavior });
    } else {
      element.scrollTop = value;
    }
  };

  const isAtTop = () =>
    reversed ? element.scrollTop <= -(element.scrollHeight - element.clientHeight) + 2 : element.scrollTop <= 2;
  const isAtBottom = () =>
    reversed ? Math.abs(element.scrollTop) <= 2 : element.scrollTop + element.clientHeight >= element.scrollHeight - 2;

  const jump = (delta: number): ScrollMove => {
    const before = element.scrollTop;
    setTop(before + delta);
    const after = element.scrollTop;
    const distance = Math.abs(after - before);
    return { before, after, distance, moved: distance >= 1 };
  };

  const canAnimate = (durationMs: number) =>
    durationMs > 0 && typeof view?.requestAnimationFrame === 'function' && doc.visibilityState !== 'hidden' && !options.signal?.aborted;

  const glide = (delta: number, durationMs: number): Promise<ScrollMove> => {
    if (Math.abs(delta) < 2 || !view || !canAnimate(durationMs)) return Promise.resolve(jump(delta));
    const win = view;
    const now = () => win.performance.now();
    const atEnd = delta < 0 ? isAtTop : isAtBottom;
    const before = element.scrollTop;

    return new Promise<ScrollMove>((resolve) => {
      const started = now();
      let planned = 0; // part of `delta` applied so far
      let travelled = 0; // how far the list actually moved for it
      let done = false;
      let guard: ReturnType<typeof setTimeout> | undefined;

      /** Scrolls to `target` px along the step. False once the end of the list stops it. */
      const advance = (target: number): boolean => {
        const step = target - planned;
        planned = target;
        if (step === 0) return true;
        const from = element.scrollTop;
        setTop(from + step);
        const moved = element.scrollTop - from;
        travelled += moved;
        return Math.abs(moved) >= 0.5 || !atEnd();
      };
      const finish = () => {
        if (done) return;
        done = true;
        if (guard !== undefined) clearTimeout(guard);
        options.signal?.removeEventListener('abort', finish);
        const distance = Math.abs(travelled);
        resolve({ before, after: element.scrollTop, distance, moved: distance >= 1 });
      };
      const frame = () => {
        if (done) return;
        const progress = Math.min(1, (now() - started) / durationMs);
        if (!advance(Math.round(delta * ease(progress))) || progress >= 1) finish();
        else win.requestAnimationFrame(frame);
      };

      guard = setTimeout(() => {
        if (done) return;
        advance(delta);
        finish();
      }, durationMs + FRAME_GRACE_MS);
      options.signal?.addEventListener('abort', finish, { once: true });
      win.requestAnimationFrame(frame);
    });
  };

  return {
    element,
    state: () => ({ top: element.scrollTop, height: element.scrollHeight, client: element.clientHeight }),
    viewportHeight: () => element.clientHeight || element.getBoundingClientRect().height || 600,
    scrollUp: (px, animateMs = 0) => glide(-Math.abs(px), animateMs),
    scrollDown: (px, animateMs = 0) => glide(Math.abs(px), animateMs),
    scrollToBottom: () => setTop(reversed ? 0 : element.scrollHeight),
    isAtBottom,
    isAtTop,
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
