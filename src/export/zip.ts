/**
 * A minimal ZIP writer: files are stored without compression (the pictures are already
 * compressed, and stored entries can be read by any tool). File names are UTF-8. No
 * dependencies, no ZIP64, so an archive holds at most 65,535 files and 4 GB.
 *
 * `createZip` builds a small archive from files at hand; `ZipWriter` writes a large one in
 * parts, with files that are themselves written piece by piece.
 */
import { BlobSink } from './sink';

export interface ZipEntry {
  /** Path inside the archive, with `/` between folders (no leading `/`, no `..`). */
  path: string;
  data: Uint8Array | string;
}

const MAX_ENTRIES = 0xffff;
const MAX_OFFSET = 0xffffffff;
const UTF8_FLAG = 0x0800;
const TOO_MANY = `A ZIP export holds at most ${MAX_ENTRIES} files; export fewer conversations at once.`;
const TOO_LARGE = 'The ZIP export would be larger than 4 GB; export fewer conversations at once.';

let crcTable: Uint32Array | null = null;

function table(): Uint32Array {
  if (crcTable) return crcTable;
  crcTable = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcTable[n] = c >>> 0;
  }
  return crcTable;
}

/** Continues a CRC-32 over more bytes: start with `0xffffffff`, finish with `crc32Final`. */
export function crc32Update(crc: number, bytes: Uint8Array): number {
  const t = table();
  let c = crc;
  for (let i = 0; i < bytes.length; i++) c = (t[(c ^ (bytes[i] as number)) & 0xff] as number) ^ (c >>> 8);
  return c >>> 0;
}

export function crc32Final(crc: number): number {
  return (crc ^ 0xffffffff) >>> 0;
}

/** CRC-32 as used by ZIP (and PNG, gzip). */
export function crc32(bytes: Uint8Array): number {
  return crc32Final(crc32Update(0xffffffff, bytes));
}

/** MS-DOS time and date fields (local time, 2-second resolution, years 1980–2107). */
function dosDateTime(date: Date): { time: number; date: number } {
  const year = Math.min(Math.max(date.getFullYear(), 1980), 2107);
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

export function checkZipPath(path: string): void {
  if (!path || path.startsWith('/') || path.includes('\\') || path.split('/').some((part) => part === '' || part === '.' || part === '..')) {
    throw new Error(`Invalid path in ZIP archive: "${path}"`);
  }
}

interface EntryHeader {
  name: Uint8Array;
  crc: number;
  size: number;
  time: number;
  date: number;
}

function localHeader({ name, crc, size, time, date }: EntryHeader): Uint8Array {
  const local = new Uint8Array(30 + name.length);
  const l = new DataView(local.buffer);
  l.setUint32(0, 0x04034b50, true); // local file header signature
  l.setUint16(4, 20, true); // version needed to extract (2.0)
  l.setUint16(6, UTF8_FLAG, true);
  l.setUint16(8, 0, true); // stored, no compression
  l.setUint16(10, time, true);
  l.setUint16(12, date, true);
  l.setUint32(14, crc, true);
  l.setUint32(18, size, true); // compressed size
  l.setUint32(22, size, true); // uncompressed size
  l.setUint16(26, name.length, true);
  l.setUint16(28, 0, true); // extra field length
  local.set(name, 30);
  return local;
}

function centralHeader({ name, crc, size, time, date }: EntryHeader, offset: number): Uint8Array {
  const record = new Uint8Array(46 + name.length);
  const c = new DataView(record.buffer);
  c.setUint32(0, 0x02014b50, true); // central directory header signature
  c.setUint16(4, 20, true); // version made by (MS-DOS, 2.0)
  c.setUint16(6, 20, true); // version needed to extract
  c.setUint16(8, UTF8_FLAG, true);
  c.setUint16(10, 0, true);
  c.setUint16(12, time, true);
  c.setUint16(14, date, true);
  c.setUint32(16, crc, true);
  c.setUint32(20, size, true);
  c.setUint32(24, size, true);
  c.setUint16(28, name.length, true);
  // 30: extra length, 32: comment length, 34: disk number, 36: internal attributes, 38: external attributes (all 0)
  c.setUint32(42, offset, true);
  record.set(name, 46);
  return record;
}

function endOfCentralDirectory(entries: number, centralSize: number, centralOffset: number): Uint8Array {
  const end = new Uint8Array(22);
  const e = new DataView(end.buffer);
  e.setUint32(0, 0x06054b50, true); // end of central directory signature
  e.setUint16(8, entries, true); // entries on this disk
  e.setUint16(10, entries, true); // entries in total
  e.setUint32(12, centralSize, true);
  e.setUint32(16, centralOffset, true); // offset of the central directory
  return end;
}

/**
 * Builds a ZIP archive. Returns its bytes as a list of parts (pass them to `new Blob(parts)`),
 * so large pictures are not copied into one buffer.
 */
export function createZip(entries: readonly ZipEntry[], modified: Date = new Date()): Uint8Array[] {
  if (entries.length > MAX_ENTRIES) throw new Error(TOO_MANY);
  const encoder = new TextEncoder();
  const { time, date } = dosDateTime(modified);
  const seen = new Set<string>();
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    checkZipPath(entry.path);
    if (seen.has(entry.path)) throw new Error(`Duplicate path in ZIP archive: "${entry.path}"`);
    seen.add(entry.path);
    const name = encoder.encode(entry.path);
    const data = typeof entry.data === 'string' ? encoder.encode(entry.data) : entry.data;
    if (offset + 30 + name.length + data.length > MAX_OFFSET) throw new Error(TOO_LARGE);
    const header: EntryHeader = { name, crc: crc32(data), size: data.length, time, date };
    const local = localHeader(header);
    parts.push(local, data);
    central.push(centralHeader(header, offset));
    offset += local.length + data.length;
  }

  const centralSize = central.reduce((sum, record) => sum + record.length, 0);
  if (offset + centralSize > MAX_OFFSET) throw new Error(TOO_LARGE);
  return [...parts, ...central, endOfCentralDirectory(entries.length, centralSize, offset)];
}

/** A file of a `ZipWriter` that is written in parts; it goes into the archive when closed. */
export interface ZipFileWriter {
  readonly path: string;
  write(part: string | Uint8Array): void;
  close(): void;
}

/**
 * Writes a ZIP archive into a Blob, file by file. `open` starts a file that is written piece by
 * piece; several may be open at once (a transcript and the pictures it shows, for example).
 */
export class ZipWriter {
  private readonly out = new BlobSink();
  private readonly central: Uint8Array[] = [];
  private readonly encoder = new TextEncoder();
  private readonly reserved = new Set<string>();
  private readonly time: number;
  private readonly date: number;
  private offset = 0;
  private open_ = 0;
  private finished = false;

  constructor(modified: Date = new Date()) {
    ({ time: this.time, date: this.date } = dosDateTime(modified));
  }

  /** Number of files added or open. */
  get files(): number {
    return this.reserved.size;
  }

  has(path: string): boolean {
    return this.reserved.has(path);
  }

  private reserve(path: string): void {
    if (this.finished) throw new Error('The ZIP archive is already finished');
    checkZipPath(path);
    if (this.reserved.has(path)) throw new Error(`Duplicate path in ZIP archive: "${path}"`);
    if (this.reserved.size >= MAX_ENTRIES) throw new Error(TOO_MANY);
    this.reserved.add(path);
  }

  private append(path: string, crc: number, size: number, data: Uint8Array | Blob): void {
    const name = this.encoder.encode(path);
    if (this.offset + 30 + name.length + size > MAX_OFFSET) throw new Error(TOO_LARGE);
    const header: EntryHeader = { name, crc, size, time: this.time, date: this.date };
    const local = localHeader(header);
    this.out.write(local);
    this.out.write(data);
    this.central.push(centralHeader(header, this.offset));
    this.offset += local.length + size;
  }

  /** Adds a file whose content is at hand. */
  add(path: string, data: Uint8Array | string): void {
    this.reserve(path);
    const bytes = typeof data === 'string' ? this.encoder.encode(data) : data;
    this.append(path, crc32(bytes), bytes.byteLength, bytes);
  }

  /** Starts a file written in parts. */
  open(path: string): ZipFileWriter {
    this.reserve(path);
    this.open_++;
    const sink = new BlobSink();
    let crc = 0xffffffff;
    let size = 0;
    let closed = false;
    return {
      path,
      write: (part) => {
        if (closed) throw new Error(`"${path}" is already closed`);
        const bytes = typeof part === 'string' ? this.encoder.encode(part) : part;
        if (bytes.byteLength === 0) return;
        crc = crc32Update(crc, bytes);
        size += bytes.byteLength;
        if (size > MAX_OFFSET) throw new Error(TOO_LARGE);
        sink.write(bytes);
      },
      close: () => {
        if (closed) return;
        closed = true;
        this.open_--;
        this.append(path, crc32Final(crc), size, sink.toBlob());
      },
    };
  }

  /** The finished archive. Every opened file must be closed. */
  finish(): Blob {
    if (this.open_ > 0) throw new Error('A file of the ZIP archive is still open');
    this.finished = true;
    const centralSize = this.central.reduce((sum, record) => sum + record.length, 0);
    if (this.offset + centralSize > MAX_OFFSET) throw new Error(TOO_LARGE);
    for (const record of this.central) this.out.write(record);
    this.out.write(endOfCentralDirectory(this.central.length, centralSize, this.offset));
    return this.out.toBlob('application/zip');
  }
}
