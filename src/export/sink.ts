/**
 * Output written in parts. Exports never build one giant string: text and bytes are added piece
 * by piece, and every few megabytes the pieces are folded into a Blob, which the browser may keep
 * outside the page's memory.
 */

/** Where an export writes its text. */
export type TextSink = (text: string) => void;

const FOLD_BYTES = 4 * 1024 * 1024;

export class BlobSink {
  private readonly blobs: Blob[] = [];
  private pending: BlobPart[] = [];
  private pendingBytes = 0;

  constructor(private readonly foldBytes: number = FOLD_BYTES) {}

  /** Adds text (as UTF-8), bytes or a Blob. */
  write(part: string | Uint8Array | Blob): void {
    if (typeof part === 'string') {
      if (part === '') return;
      this.pending.push(part);
      this.pendingBytes += part.length;
    } else if (part instanceof Uint8Array) {
      if (part.byteLength === 0) return;
      this.pending.push(part as Uint8Array<ArrayBuffer>);
      this.pendingBytes += part.byteLength;
    } else {
      this.fold();
      this.blobs.push(part);
      return;
    }
    if (this.pendingBytes >= this.foldBytes) this.fold();
  }

  /** A sink function writing text here. */
  get text(): TextSink {
    return (text) => this.write(text);
  }

  private fold(): void {
    if (this.pending.length === 0) return;
    this.blobs.push(new Blob(this.pending));
    this.pending = [];
    this.pendingBytes = 0;
  }

  /** Everything written so far, as one Blob. */
  toBlob(type = ''): Blob {
    this.fold();
    return new Blob(this.blobs, type ? { type } : undefined);
  }
}
