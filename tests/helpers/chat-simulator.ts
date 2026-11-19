/**
 * A virtualised, lazily loading chat list that behaves like Teams Web's message pane:
 *  - only items intersecting the viewport (plus overscan) exist in the DOM;
 *  - older history is fetched (asynchronously, with a spinner) when scrolled to the top,
 *    and the scroll position is kept anchored after the prepend;
 *  - grouped messages from the same sender omit the author header.
 * jsdom has no layout, so scroll geometry is simulated on the viewport element.
 */
import { messageItemHtml, shellHtml, type FixtureMessage } from './teams-dom';

export interface SimulatorOptions {
  /** Complete history, oldest first (may include dividers / system items). */
  items: FixtureMessage[];
  threadId?: string | null;
  title?: string;
  viewportHeight?: number;
  itemHeight?: number;
  overscan?: number;
  initialLoaded?: number;
  pageSize?: number;
  loadDelayMs?: number;
}

export class ChatSimulator {
  readonly viewport: HTMLElement;
  readonly runway: HTMLElement;
  readonly items: FixtureMessage[];
  readonly viewportHeight: number;
  readonly itemHeight: number;
  readonly overscan: number;
  readonly pageSize: number;
  readonly loadDelayMs: number;
  loadedStart: number;
  fetchCount = 0;
  /** When true, assignments to scrollTop are ignored (a stuck list). */
  frozen = false;
  /** When true, scrolling to the top never loads more history (a failing network). */
  historyBlocked = false;
  private scrollTopValue = 0;
  private loading = false;
  private readonly rendered = new Map<number, HTMLElement>();
  private spinner: HTMLElement | null = null;
  private timers = new Set<ReturnType<typeof setTimeout>>();

  constructor(options: SimulatorOptions) {
    this.items = [...options.items];
    this.viewportHeight = options.viewportHeight ?? 600;
    this.itemHeight = options.itemHeight ?? 60;
    this.overscan = options.overscan ?? 2;
    this.pageSize = options.pageSize ?? 25;
    this.loadDelayMs = options.loadDelayMs ?? 5;
    this.loadedStart = Math.max(0, this.items.length - (options.initialLoaded ?? 30));

    document.body.innerHTML = shellHtml({ threadId: options.threadId, title: options.title });
    this.viewport = document.querySelector('[data-tid="message-pane-list-viewport"]') as HTMLElement;
    this.runway = document.querySelector('[data-tid="message-pane-list-runway"]') as HTMLElement;

    Object.defineProperty(this.viewport, 'scrollTop', {
      configurable: true,
      get: () => this.scrollTopValue,
      set: (value: number) => this.setScrollTop(value),
    });
    Object.defineProperty(this.viewport, 'scrollHeight', { configurable: true, get: () => this.scrollHeight });
    Object.defineProperty(this.viewport, 'clientHeight', { configurable: true, get: () => this.viewportHeight });

    this.scrollTopValue = this.maxScrollTop;
    this.render();
  }

  get loadedCount(): number {
    return this.items.length - this.loadedStart;
  }

  get scrollHeight(): number {
    return this.loadedCount * this.itemHeight;
  }

  get maxScrollTop(): number {
    return Math.max(0, this.scrollHeight - this.viewportHeight);
  }

  get scrollTop(): number {
    return this.scrollTopValue;
  }

  /** Absolute indexes of the items currently in the DOM. */
  renderedIndexes(): number[] {
    return Array.from(this.rendered.keys()).sort((a, b) => a - b);
  }

  setScrollTop(value: number): void {
    if (this.frozen) return;
    this.scrollTopValue = Math.min(Math.max(0, Math.round(value)), this.maxScrollTop);
    this.render();
    if (this.scrollTopValue <= 0) this.maybeLoad();
  }

  /** Appends new messages at the bottom (someone posted while we were away). */
  appendItems(items: FixtureMessage[]): void {
    this.items.push(...items);
    this.render();
  }

  /** Replaces an item (e.g. an edit) and re-renders it if visible. */
  replaceItem(index: number, item: FixtureMessage): void {
    this.items[index] = item;
    const element = this.rendered.get(index);
    if (element) {
      const replacement = this.createElement(index);
      element.replaceWith(replacement);
      this.rendered.set(index, replacement);
    }
  }

  dispose(): void {
    this.timers.forEach((timer) => clearTimeout(timer));
    this.timers.clear();
  }

  private maybeLoad(): void {
    if (this.loading || this.loadedStart === 0 || this.historyBlocked) return;
    this.loading = true;
    this.spinner = document.createElement('div');
    this.spinner.setAttribute('role', 'progressbar');
    this.spinner.setAttribute('data-tid', 'message-pane-loading');
    this.viewport.prepend(this.spinner);
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      const count = Math.min(this.pageSize, this.loadedStart);
      this.loadedStart -= count;
      this.scrollTopValue += count * this.itemHeight; // keep the visible messages in place
      this.loading = false;
      this.fetchCount++;
      this.spinner?.remove();
      this.spinner = null;
      this.render();
    }, this.loadDelayMs);
    this.timers.add(timer);
  }

  private createElement(index: number): HTMLElement {
    const template = document.createElement('template');
    template.innerHTML = messageItemHtml(this.items[index] as FixtureMessage);
    return template.content.firstElementChild as HTMLElement;
  }

  private render(): void {
    const firstVisible = Math.floor(this.scrollTopValue / this.itemHeight);
    const lastVisible = Math.ceil((this.scrollTopValue + this.viewportHeight) / this.itemHeight) - 1;
    const first = Math.max(0, firstVisible - this.overscan);
    const last = Math.min(this.loadedCount - 1, lastVisible + this.overscan);
    const desired: number[] = [];
    for (let offset = first; offset <= last; offset++) desired.push(this.loadedStart + offset);
    const wanted = new Set(desired);

    for (const [index, element] of this.rendered) {
      if (!wanted.has(index)) {
        element.remove();
        this.rendered.delete(index);
      }
    }
    let reference: Element | null = this.runway.firstElementChild;
    for (const index of desired) {
      let element = this.rendered.get(index);
      if (!element) {
        element = this.createElement(index);
        this.rendered.set(index, element);
      }
      if (element === reference) {
        reference = reference.nextElementSibling;
      } else {
        this.runway.insertBefore(element, reference);
      }
    }
  }
}

/** Deterministic pseudo-random numbers. */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface ExpectedMessage {
  /** Teams id, or null when the generated item renders none. */
  id: string | null;
  kind: 'message' | 'system';
  /** True sender (also for grouped messages that render no author); null for system messages. */
  sender: string | null;
  self: boolean;
  text: string;
  time: string;
  attachments: string[];
  /** Index (into `expected`) of the quoted message, if this is a reply. */
  replyTo: number | null;
  /** Which metadata the rendered item lacks. */
  missing: 'none' | 'id' | 'time' | 'id-and-time';
}

export interface GeneratedConversation {
  /** Items as rendered (messages with grouping applied, plus date dividers and system messages). */
  items: FixtureMessage[];
  /** Ground truth for each message and system message, oldest first. */
  expected: ExpectedMessage[];
}

export interface GenerateOptions {
  count: number;
  participants: string[];
  selfName?: string;
  startMs?: number;
  seed?: number;
  /** Insert a date divider every N messages (0 = never). */
  dividerEvery?: number;
  /** Probability that a message continues the previous sender's group. */
  groupProbability?: number;
  withAttachmentsEvery?: number;
  withRepliesEvery?: number;
  /** Insert a system message ("X added Y") before every Nth message. */
  systemEvery?: number;
  /** Every Nth message renders no Teams id (it keeps its exact timestamp). */
  withoutIdEvery?: number;
  /** Every Nth message renders no time element (it keeps its id). */
  withoutTimeEvery?: number;
  /** Every Nth message renders neither an id nor a time element. */
  withoutIdAndTimeEvery?: number;
}

const every = (n: number | undefined, i: number) => Boolean(n) && i > 0 && i % (n as number) === 0;

export function generateConversation(options: GenerateOptions): GeneratedConversation {
  const random = mulberry32(options.seed ?? 42);
  const items: FixtureMessage[] = [];
  const expected: ExpectedMessage[] = [];
  let time = options.startMs ?? Date.UTC(2024, 0, 15, 9, 0, 0);
  let previousSender: string | null = null;
  const everyone = options.selfName ? [...options.participants, options.selfName] : options.participants;

  for (let i = 0; i < options.count; i++) {
    let groupBroken = false;
    if (every(options.dividerEvery, i)) {
      items.push({ divider: new Date(time).toDateString() });
      groupBroken = true;
    }
    if (every(options.systemEvery, i)) {
      time += 1_000;
      const text = `${everyone[i % everyone.length]} changed the chat name to "Topic ${i}".`;
      items.push({ system: text, id: String(time), time: new Date(time).toISOString() });
      expected.push({ id: String(time), kind: 'system', sender: null, self: false, text, time: new Date(time).toISOString(), attachments: [], replyTo: null, missing: 'none' });
      groupBroken = true;
    }
    time += 30_000 + Math.floor(random() * 90_000);
    const continues: boolean = previousSender !== null && random() < (options.groupProbability ?? 0.5);
    const sender: string = continues ? (previousSender as string) : (everyone[Math.floor(random() * everyone.length)] as string);
    const self = sender === options.selfName;
    const showAuthor = !self && (sender !== previousSender || groupBroken);
    const paragraphCount = 1 + Math.floor(random() * 3);
    const paragraphs = Array.from({ length: paragraphCount }, (_, p) => `Message ${i} from ${sender}, paragraph ${p + 1}.`);
    const withoutBoth = every(options.withoutIdAndTimeEvery, i);
    const id = withoutBoth || every(options.withoutIdEvery, i) ? null : String(time);
    const iso = new Date(time).toISOString();
    const message: FixtureMessage = {
      id,
      author: showAuthor ? sender : undefined,
      self,
      time: withoutBoth || every(options.withoutTimeEvery, i) ? null : iso,
      timeText: iso.slice(11, 16),
      paragraphs,
    };
    const attachments: string[] = [];
    if (options.withAttachmentsEvery && i % options.withAttachmentsEvery === 0) {
      message.attachments = [{ name: `file-${i}.pdf`, url: `https://example.invalid/files/${i}.pdf` }];
      attachments.push(`file-${i}.pdf`);
    }
    let replyTo: number | null = null;
    if (every(options.withRepliesEvery, i)) {
      const candidates = expected.map((entry, index) => ({ entry, index })).filter(({ entry }) => entry.kind === 'message');
      const target = candidates[Math.floor(random() * candidates.length)];
      if (target) {
        message.reply = { id: target.entry.id, author: target.entry.sender, preview: target.entry.text.slice(0, 40) };
        replyTo = target.index;
      }
    }
    items.push(message);
    const missing = id === null ? (message.time === null ? 'id-and-time' : 'id') : message.time === null ? 'time' : 'none';
    expected.push({ id, kind: 'message', sender, self, text: paragraphs.join('\n\n'), time: iso, attachments, replyTo, missing });
    previousSender = sender;
  }
  return { items, expected };
}
