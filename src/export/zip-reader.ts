/**
 * Reads ZIP archives from a Blob (a chosen file) without loading them: the central directory
 * is read from the end of the file, and each file is read from its own slice, in chunks when
 * it is large. Stored and deflated files are supported (a package re-zipped by Windows or
 * macOS is deflated); encrypted files and ZIP64 are not.
 */
import { crc32Final, crc32Update } from './zip';

export class ZipReadError extends Error {}

export interface ZipFileInfo {
  path: string;
  /** 0 stored, 8 deflated. */
  method: number;
  crc: number;
  compressedSize: number;
  size: number;
  localOffset: number;
}

const CHUNK_BYTES = 4 * 1024 * 1024;

export async function readBlobBytes(blob: Blob, start = 0, end = blob.size): Promise<Uint8Array> {
  return new Uint8Array(await blob.slice(start, end).arrayBuffer());
}

/** A Blob's bytes in chunks of at most `chunkBytes`. */
export async function* blobChunks(blob: Blob, chunkBytes = CHUNK_BYTES): AsyncGenerator<Uint8Array> {
  for (let start = 0; start < blob.size; start += chunkBytes) yield readBlobBytes(blob, start, Math.min(blob.size, start + chunkBytes));
}

/** Whether the bytes start like a ZIP archive (`PK\x03\x04`, or `PK\x05\x06` when empty). */
export function looksLikeZip(head: Uint8Array): boolean {
  return head[0] === 0x50 && head[1] === 0x4b && ((head[2] === 3 && head[3] === 4) || (head[2] === 5 && head[3] === 6));
}

/** The files of a ZIP archive, by path. */
export async function readZipDirectory(blob: Blob): Promise<Map<string, ZipFileInfo>> {
  const tailStart = Math.max(0, blob.size - (22 + 0xffff));
  const tail = await readBlobBytes(blob, tailStart);
  const view = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
  let end = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new ZipReadError('Not a ZIP archive (no central directory found)');
  const count = view.getUint16(end + 10, true);
  const centralSize = view.getUint32(end + 12, true);
  const centralOffset = view.getUint32(end + 16, true);
  if (count === 0xffff || centralOffset === 0xffffffff || centralSize === 0xffffffff) throw new ZipReadError('ZIP64 archives are not supported');
  if (centralOffset + centralSize > blob.size) throw new ZipReadError('The ZIP archive is incomplete or damaged');

  const central = await readBlobBytes(blob, centralOffset, centralOffset + centralSize);
  const c = new DataView(central.buffer, central.byteOffset, central.byteLength);
  const decoder = new TextDecoder();
  const files = new Map<string, ZipFileInfo>();
  let pos = 0;
  for (let i = 0; i < count; i++) {
    if (pos + 46 > central.length || c.getUint32(pos, true) !== 0x02014b50) throw new ZipReadError('The ZIP central directory is damaged');
    const flags = c.getUint16(pos + 8, true);
    const nameLength = c.getUint16(pos + 28, true);
    const extraLength = c.getUint16(pos + 30, true);
    const commentLength = c.getUint16(pos + 32, true);
    const path = decoder.decode(central.subarray(pos + 46, pos + 46 + nameLength));
    if (flags & 1) throw new ZipReadError(`"${path}" is encrypted`);
    const info: ZipFileInfo = {
      path,
      method: c.getUint16(pos + 10, true),
      crc: c.getUint32(pos + 16, true),
      compressedSize: c.getUint32(pos + 20, true),
      size: c.getUint32(pos + 24, true),
      localOffset: c.getUint32(pos + 42, true),
    };
    if (!path.endsWith('/')) files.set(path, info);
    pos += 46 + nameLength + extraLength + commentLength;
  }
  return files;
}

async function dataStart(blob: Blob, file: ZipFileInfo): Promise<number> {
  const header = await readBlobBytes(blob, file.localOffset, file.localOffset + 30);
  const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
  if (header.length < 30 || view.getUint32(0, true) !== 0x04034b50) throw new ZipReadError(`"${file.path}": the ZIP archive is damaged`);
  const start = file.localOffset + 30 + view.getUint16(26, true) + view.getUint16(28, true);
  if (start + file.compressedSize > blob.size) throw new ZipReadError(`"${file.path}": the ZIP archive is incomplete`);
  return start;
}

async function* inflate(chunks: AsyncGenerator<Uint8Array>, path: string): AsyncGenerator<Uint8Array> {
  if (typeof DecompressionStream !== 'function') throw new ZipReadError(`"${path}" is compressed, which this browser can't read; unzip and re-zip it without compression`);
  const stream = new DecompressionStream('deflate-raw');
  const writer = stream.writable.getWriter();
  const reader = stream.readable.getReader();
  let failure: unknown = null;
  const pump = (async () => {
    try {
      for await (const chunk of chunks) await writer.write(chunk as Uint8Array<ArrayBuffer>);
      await writer.close();
    } catch (error) {
      failure = error;
      await writer.abort(error).catch(() => undefined);
    }
  })();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      yield value;
    }
  } catch (error) {
    throw new ZipReadError(`"${path}" could not be decompressed: ${(failure ?? error) instanceof Error ? ((failure ?? error) as Error).message : String(failure ?? error)}`);
  } finally {
    // Stops the pump when the reader leaves early.
    await reader.cancel().catch(() => undefined);
    await pump;
  }
  if (failure) throw failure;
}

/** A file's content in chunks, checked against its CRC and size once read. */
export async function* zipFileChunks(blob: Blob, file: ZipFileInfo, chunkBytes = CHUNK_BYTES): AsyncGenerator<Uint8Array> {
  if (file.method !== 0 && file.method !== 8) throw new ZipReadError(`"${file.path}" uses a compression method this extension can't read (${file.method})`);
  const start = await dataStart(blob, file);
  const raw = blobChunks(blob.slice(start, start + file.compressedSize), chunkBytes);
  const chunks = file.method === 8 ? inflate(raw, file.path) : raw;
  let crc = 0xffffffff;
  let size = 0;
  for await (const chunk of chunks) {
    crc = crc32Update(crc, chunk);
    size += chunk.byteLength;
    if (size > file.size) throw new ZipReadError(`"${file.path}" is larger than the ZIP archive says`);
    yield chunk;
  }
  if (size !== file.size || crc32Final(crc) !== file.crc) throw new ZipReadError(`"${file.path}" is damaged (checksum mismatch)`);
}

/** A whole file, for small files and pictures. */
export async function readZipFile(blob: Blob, file: ZipFileInfo, maxBytes = Number.POSITIVE_INFINITY): Promise<Uint8Array> {
  if (file.size > maxBytes) throw new ZipReadError(`"${file.path}" is too large (${file.size} bytes)`);
  const bytes = new Uint8Array(file.size);
  let at = 0;
  for await (const chunk of zipFileChunks(blob, file)) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return bytes;
}

/** A UTF-8 text file line by line (`\n` or `\r\n`), without holding it whole. */
export async function* zipFileLines(blob: Blob, file: ZipFileInfo): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let rest = '';
  for await (const chunk of zipFileChunks(blob, file)) {
    rest += decoder.decode(chunk, { stream: true });
    let newline = rest.indexOf('\n');
    let from = 0;
    while (newline >= 0) {
      yield rest.slice(from, newline).replace(/\r$/, '');
      from = newline + 1;
      newline = rest.indexOf('\n', from);
    }
    rest = rest.slice(from);
  }
  rest += decoder.decode();
  if (rest !== '') yield rest.replace(/\r$/, '');
}
