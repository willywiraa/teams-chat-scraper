/**
 * A minimal ZIP writer: files are stored without compression (the pictures are already
 * compressed, and the transcripts are small). File names are UTF-8. No dependencies, no
 * ZIP64, so an archive holds at most 65,535 files and 4 GB.
 */

export interface ZipEntry {
  /** Path inside the archive, with `/` between folders (no leading `/`, no `..`). */
  path: string;
  data: Uint8Array | string;
}

const MAX_ENTRIES = 0xffff;
const MAX_OFFSET = 0xffffffff;
const UTF8_FLAG = 0x0800;

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

/** CRC-32 as used by ZIP (and PNG, gzip). */
export function crc32(bytes: Uint8Array): number {
  const t = table();
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = (t[(crc ^ (bytes[i] as number)) & 0xff] as number) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** MS-DOS time and date fields (local time, 2-second resolution, years 1980–2107). */
function dosDateTime(date: Date): { time: number; date: number } {
  const year = Math.min(Math.max(date.getFullYear(), 1980), 2107);
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

function checkPath(path: string): void {
  if (!path || path.startsWith('/') || path.includes('\\') || path.split('/').some((part) => part === '' || part === '.' || part === '..')) {
    throw new Error(`Invalid path in ZIP archive: "${path}"`);
  }
}

/**
 * Builds a ZIP archive. Returns its bytes as a list of parts (pass them to `new Blob(parts)`),
 * so large pictures are not copied into one buffer.
 */
export function createZip(entries: readonly ZipEntry[], modified: Date = new Date()): Uint8Array[] {
  if (entries.length > MAX_ENTRIES) throw new Error(`A ZIP export holds at most ${MAX_ENTRIES} files; export fewer conversations at once.`);
  const encoder = new TextEncoder();
  const { time, date } = dosDateTime(modified);
  const seen = new Set<string>();
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    checkPath(entry.path);
    if (seen.has(entry.path)) throw new Error(`Duplicate path in ZIP archive: "${entry.path}"`);
    seen.add(entry.path);
    const name = encoder.encode(entry.path);
    const data = typeof entry.data === 'string' ? encoder.encode(entry.data) : entry.data;
    const crc = crc32(data);
    if (offset + 30 + name.length + data.length > MAX_OFFSET) {
      throw new Error('The ZIP export would be larger than 4 GB; export fewer conversations at once.');
    }

    const local = new Uint8Array(30 + name.length);
    const l = new DataView(local.buffer);
    l.setUint32(0, 0x04034b50, true); // local file header signature
    l.setUint16(4, 20, true); // version needed to extract (2.0)
    l.setUint16(6, UTF8_FLAG, true);
    l.setUint16(8, 0, true); // stored, no compression
    l.setUint16(10, time, true);
    l.setUint16(12, date, true);
    l.setUint32(14, crc, true);
    l.setUint32(18, data.length, true); // compressed size
    l.setUint32(22, data.length, true); // uncompressed size
    l.setUint16(26, name.length, true);
    l.setUint16(28, 0, true); // extra field length
    local.set(name, 30);
    parts.push(local, data);

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
    c.setUint32(20, data.length, true);
    c.setUint32(24, data.length, true);
    c.setUint16(28, name.length, true);
    // 30: extra length, 32: comment length, 34: disk number, 36: internal attributes, 38: external attributes (all 0)
    c.setUint32(42, offset, true);
    record.set(name, 46);
    central.push(record);

    offset += local.length + data.length;
  }

  const centralSize = central.reduce((sum, record) => sum + record.length, 0);
  if (offset + centralSize > MAX_OFFSET) throw new Error('The ZIP export would be larger than 4 GB; export fewer conversations at once.');
  const end = new Uint8Array(22);
  const e = new DataView(end.buffer);
  e.setUint32(0, 0x06054b50, true); // end of central directory signature
  e.setUint16(8, entries.length, true); // entries on this disk
  e.setUint16(10, entries.length, true); // entries in total
  e.setUint32(12, centralSize, true);
  e.setUint32(16, offset, true); // offset of the central directory
  return [...parts, ...central, end];
}
