/**
 * Reads an archive export (JSON format v1) in parts. The text is fed in chunks; the scanner
 * follows the outer structure itself and hands over each top-level field, each conversation
 * field, and each message and image as it is completed. Only one such value is held at a time,
 * so a file of any size is read without becoming one string.
 *
 * Only the outer structure is checked here; every handed-over value is parsed with
 * `JSON.parse`. Values the caller doesn't want (`skip`) are passed over without being parsed.
 */
import { ImportValidationError } from './format';

export type ArchiveJsonEvent =
  /** A top-level field other than `conversations`. */
  | { type: 'root'; key: string; value: unknown }
  /** The `conversations` array starts. */
  | { type: 'conversations' }
  | { type: 'conversation-start'; index: number }
  /** A conversation field other than `messages` and `images` (or one of those when it is not an array). */
  | { type: 'field'; index: number; key: string; value: unknown }
  | { type: 'message'; index: number; position: number; value: unknown }
  | { type: 'image'; index: number; position: number; value: unknown }
  | { type: 'conversation-end'; index: number; messages: number; images: number; sawMessages: boolean };

export interface ScanOptions {
  /** Pass over messages (or images) without parsing them; no events are given for them. */
  skip?: { messages?: boolean; images?: boolean };
}

type Role = 'root' | 'conversations' | 'conversation' | 'messages' | 'images';
type ObjectState = 'key-or-end' | 'key' | 'colon' | 'value' | 'comma-or-end';
type ArrayState = 'value-or-end' | 'value' | 'comma-or-end';

interface Frame {
  role: Role;
  state: ObjectState | ArrayState;
  key: string | null;
  /** Elements so far (arrays), or index (conversation). */
  count: number;
  index: number;
  messages: number;
  images: number;
  sawMessages: boolean;
}

/** A value being read: its text so far (when kept) and how far it has got. */
interface Capture {
  keep: boolean;
  pieces: string[];
  start: number;
  /** Container nesting; 0 for a string or a primitive. */
  depth: number;
  inString: boolean;
  escape: boolean;
  primitive: boolean;
  /** What the value is, once complete. */
  target: 'key' | 'value';
}

const WHITESPACE = new Set([' ', '\t', '\n', '\r']);
const STRING_STOP = /["\\]/g;
const PRIMITIVE_STOP = /[\s,\]}]/g;

export class ArchiveJsonScanner {
  private readonly stack: Frame[] = [];
  private capture: Capture | null = null;
  private started = false;
  private done = false;
  private conversations = 0;
  private position = 0;
  private events: ArchiveJsonEvent[] = [];

  constructor(private readonly options: ScanOptions = {}) {}

  /** Reads the next piece of text; returns the events it completed. */
  feed(text: string): ArchiveJsonEvent[] {
    this.events = [];
    let i = 0;
    while (i < text.length) {
      if (this.capture) {
        i = this.continueCapture(text, i);
        continue;
      }
      const ch = text[i] as string;
      if (WHITESPACE.has(ch) || (ch === '\ufeff' && !this.started)) {
        i++;
        continue;
      }
      if (this.done) this.fail(`unexpected "${ch}" after the end of the archive`, i);
      this.structural(ch, text, i);
      i = this.capture ? i : i + 1;
    }
    this.position += text.length;
    return this.events;
  }

  /** Checks that the archive is complete; returns the last events. */
  end(): ArchiveJsonEvent[] {
    this.events = [];
    if (!this.started) throw new ImportValidationError('Not valid JSON: the file is empty');
    if (!this.done || this.capture) throw new ImportValidationError('Not valid JSON: the file ends early (it may be incomplete)');
    return this.events;
  }

  private fail(problem: string, at: number): never {
    throw new ImportValidationError(`Not valid JSON: ${problem} at position ${this.position + at}`);
  }

  private get top(): Frame | undefined {
    return this.stack[this.stack.length - 1];
  }

  private push(role: Role, isObject: boolean, index = 0): void {
    this.stack.push({ role, state: isObject ? 'key-or-end' : 'value-or-end', key: null, count: 0, index, messages: 0, images: 0, sawMessages: false });
  }

  /** A character of the navigated structure (outside any value being read). */
  private structural(ch: string, text: string, i: number): void {
    const frame = this.top;
    if (!frame) {
      if (this.started) this.fail(`unexpected "${ch}"`, i);
      if (ch !== '{') throw new ImportValidationError('Archive must be a JSON object');
      this.started = true;
      this.push('root', true);
      return;
    }
    const isObject = frame.role === 'root' || frame.role === 'conversation';
    if (isObject) {
      switch (frame.state) {
        case 'key-or-end':
        case 'key':
          if (ch === '}' && frame.state === 'key-or-end') return this.closeFrame();
          if (ch !== '"') this.fail(`expected a field name, found "${ch}"`, i);
          return this.startCapture(text, i, true, 'key');
        case 'colon':
          if (ch !== ':') this.fail(`expected ":", found "${ch}"`, i);
          frame.state = 'value';
          return;
        case 'value':
          return this.objectValue(frame, ch, text, i);
        case 'comma-or-end':
          if (ch === ',') frame.state = 'key';
          else if (ch === '}') this.closeFrame();
          else this.fail(`expected "," or "}", found "${ch}"`, i);
          return;
      }
    }
    switch (frame.state) {
      case 'value-or-end':
      case 'value':
        if (ch === ']' && frame.state === 'value-or-end') return this.closeFrame();
        return this.arrayValue(frame, ch, text, i);
      case 'comma-or-end':
        if (ch === ',') frame.state = 'value';
        else if (ch === ']') this.closeFrame();
        else this.fail(`expected "," or "]", found "${ch}"`, i);
        return;
    }
  }

  private objectValue(frame: Frame, ch: string, text: string, i: number): void {
    frame.state = 'comma-or-end';
    if (frame.role === 'root' && frame.key === 'conversations') {
      if (ch !== '[') throw new ImportValidationError('"conversations" must be an array');
      this.events.push({ type: 'conversations' });
      return this.push('conversations', false);
    }
    if (frame.role === 'conversation' && ch === '[' && (frame.key === 'messages' || frame.key === 'images')) {
      if (frame.key === 'messages') frame.sawMessages = true;
      return this.push(frame.key, false);
    }
    this.startCapture(text, i, true, 'value');
  }

  private arrayValue(frame: Frame, ch: string, text: string, i: number): void {
    frame.state = 'comma-or-end';
    if (frame.role === 'conversations') {
      if (ch !== '{') throw new ImportValidationError(`conversations[${frame.count}] must be an object`);
      const index = this.conversations++;
      frame.count++;
      this.events.push({ type: 'conversation-start', index });
      return this.push('conversation', true, index);
    }
    const skip = frame.role === 'messages' ? this.options.skip?.messages : this.options.skip?.images;
    this.startCapture(text, i, !skip, 'value');
  }

  private closeFrame(): void {
    const frame = this.stack.pop() as Frame;
    const parent = this.top;
    if (frame.role === 'root') {
      this.done = true;
      return;
    }
    if (frame.role === 'conversation') {
      this.events.push({ type: 'conversation-end', index: frame.index, messages: frame.messages, images: frame.images, sawMessages: frame.sawMessages });
      return;
    }
    if (parent && (frame.role === 'messages' || frame.role === 'images')) {
      if (frame.role === 'messages') parent.messages = frame.count;
      else parent.images = frame.count;
    }
  }

  private startCapture(text: string, i: number, keep: boolean, target: Capture['target']): void {
    const ch = text[i] as string;
    const container = ch === '{' || ch === '[';
    this.capture = { keep, pieces: [], start: i, depth: container ? 1 : 0, inString: ch === '"', escape: false, primitive: !container && ch !== '"', target };
    // continueCapture starts on the opening character of a string or container, and steps over it.
    this.pendingOpen = container || ch === '"';
  }

  /** Set when a capture has just started on its opening character, which must be skipped once. */
  private pendingOpen = false;

  /** Reads as much of the value being captured as the text holds; returns where reading stopped. */
  private continueCapture(text: string, from: number): number {
    const capture = this.capture as Capture;
    let i = from;
    if (this.pendingOpen) {
      this.pendingOpen = false;
      i++;
    }
    while (i < text.length) {
      if (capture.primitive) {
        PRIMITIVE_STOP.lastIndex = i;
        const stop = PRIMITIVE_STOP.exec(text);
        if (!stop) return this.suspend(text, text.length);
        return this.finishCapture(text, stop.index);
      }
      if (capture.inString) {
        if (capture.escape) {
          capture.escape = false;
          i++;
          continue;
        }
        STRING_STOP.lastIndex = i;
        const stop = STRING_STOP.exec(text);
        if (!stop) return this.suspend(text, text.length);
        i = stop.index + 1;
        if (stop[0] === '\\') {
          capture.escape = true;
          continue;
        }
        capture.inString = false;
        if (capture.depth === 0) return this.finishCapture(text, i);
        continue;
      }
      const ch = text[i] as string;
      if (ch === '"') capture.inString = true;
      else if (ch === '{' || ch === '[') capture.depth++;
      else if (ch === '}' || ch === ']') {
        capture.depth--;
        if (capture.depth === 0) return this.finishCapture(text, i + 1);
      }
      i++;
    }
    return this.suspend(text, text.length);
  }

  /** The text ends inside the value: keep what was read and continue with the next piece. */
  private suspend(text: string, end: number): number {
    const capture = this.capture as Capture;
    if (capture.keep) capture.pieces.push(text.slice(capture.start, end));
    capture.start = 0;
    return end;
  }

  /** The value ends before `end`; hands it over. Returns where structural reading continues. */
  private finishCapture(text: string, end: number): number {
    const capture = this.capture as Capture;
    this.capture = null;
    const frame = this.top as Frame;
    if (capture.target === 'key') {
      frame.key = this.parse(capture.pieces.join('') + text.slice(capture.start, end), end) as string;
      frame.state = 'colon';
      return end;
    }
    if (!capture.keep) {
      frame.count += frame.role === 'messages' || frame.role === 'images' ? 1 : 0;
      return end;
    }
    const value = this.parse(capture.pieces.join('') + text.slice(capture.start, end), end);
    switch (frame.role) {
      case 'root':
        this.events.push({ type: 'root', key: frame.key as string, value });
        break;
      case 'conversation':
        this.events.push({ type: 'field', index: frame.index, key: frame.key as string, value });
        break;
      case 'messages':
      case 'images': {
        const conversation = this.stack[this.stack.length - 2] as Frame;
        this.events.push({ type: frame.role === 'messages' ? 'message' : 'image', index: conversation.index, position: frame.count, value });
        frame.count++;
        break;
      }
      default:
        break;
    }
    return end;
  }

  private parse(raw: string, at: number): unknown {
    try {
      return JSON.parse(raw);
    } catch (error) {
      this.fail((error as Error).message.replace(/^JSON\.parse: /, ''), at);
    }
  }
}

/** Runs the scanner over text chunks (from a file, for example), yielding its events. */
export async function* scanArchiveJson(chunks: AsyncIterable<string>, options: ScanOptions = {}): AsyncGenerator<ArchiveJsonEvent> {
  const scanner = new ArchiveJsonScanner(options);
  for await (const chunk of chunks) yield* scanner.feed(chunk);
  yield* scanner.end();
}
