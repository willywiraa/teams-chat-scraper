/** Helpers for export tests: an in-memory export reader and ZIP reading. */
import { deflateRawSync } from 'node:zlib';
import type { ExportReader, ImageInfo } from '../../src/export/pipeline';
import { inRange, type TimeRange } from '../../src/export/options';
import { crc32 } from '../../src/export/zip';
import { readZipDirectory, readZipFile } from '../../src/export/zip-reader';
import type { ConversationRecord, StoredImage, StoredMessage } from '../../src/shared/types';

export interface MemoryConversation {
  record: ConversationRecord;
  messages: StoredMessage[];
  images?: StoredImage[];
}

/** Serves conversations from memory, in pages of `pageSize` (small, to cross page boundaries). */
export function memoryReader(conversations: MemoryConversation[], pageSize = 2): ExportReader {
  const find = (key: string) => conversations.find((c) => c.record.conversationKey === key);
  return {
    getConversation: async (key) => find(key)?.record,
    listConversations: async () => conversations.map((c) => c.record),
    async *messagePages(key: string, range: TimeRange) {
      const messages = [...(find(key)?.messages ?? [])].filter((message) => inRange(message, range)).sort((a, b) => a.sortKey - b.sortKey);
      for (let start = 0; start < messages.length; start += pageSize) yield messages.slice(start, start + pageSize);
    },
    imageCatalog: async (key) =>
      (find(key)?.images ?? [])
        .map(({ data: _data, ...info }): ImageInfo => info)
        .sort((a, b) => a.firstSavedAt.localeCompare(b.firstSavedAt) || a.imageId.localeCompare(b.imageId)),
    getImage: async (key, imageId) => find(key)?.images?.find((image) => image.imageId === imageId),
  };
}

/** Every file of a ZIP Blob, read with the extension's own ZIP reader (which checks each CRC). */
export async function unzip(blob: Blob): Promise<Map<string, Uint8Array>> {
  const files = new Map<string, Uint8Array>();
  for (const [path, info] of await readZipDirectory(blob)) files.set(path, await readZipFile(blob, info));
  return files;
}

export const utf8 = (data: Uint8Array | undefined): string => new TextDecoder().decode(data);

export async function blobText(blob: Blob): Promise<string> {
  return new TextDecoder().decode(new Uint8Array(await blob.arrayBuffer()));
}

/** Makes the weekday-and-date wording independent of the ICU version ("Monday, 15 January" or "Monday 15 January"). */
export function icuNeutral(text: string): string {
  return text
    .replace(/(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),? (\d{1,2}) /g, '$1 $2 ')
    .replace(/(\d{4}),? (at )?(\d{2}:\d{2})/g, '$1, $3');
}

/** A ZIP with deflated files inside a folder, as Windows' "Compressed folder" makes one. */
export function deflatedZip(files: Record<string, string | Uint8Array>): Blob {
  const encoder = new TextEncoder();
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const [path, content] of Object.entries(files)) {
    const name = encoder.encode(path);
    const data = typeof content === 'string' ? encoder.encode(content) : content;
    const packed = new Uint8Array(deflateRawSync(data));
    const local = new Uint8Array(30 + name.length);
    const l = new DataView(local.buffer);
    l.setUint32(0, 0x04034b50, true);
    l.setUint16(4, 20, true);
    l.setUint16(8, 8, true);
    l.setUint32(14, crc32(data), true);
    l.setUint32(18, packed.length, true);
    l.setUint32(22, data.length, true);
    l.setUint16(26, name.length, true);
    local.set(name, 30);
    const record = new Uint8Array(46 + name.length);
    const c = new DataView(record.buffer);
    c.setUint32(0, 0x02014b50, true);
    c.setUint16(10, 8, true);
    c.setUint32(16, crc32(data), true);
    c.setUint32(20, packed.length, true);
    c.setUint32(24, data.length, true);
    c.setUint16(28, name.length, true);
    c.setUint32(42, offset, true);
    record.set(name, 46);
    parts.push(local, packed);
    central.push(record);
    offset += local.length + packed.length;
  }
  const size = central.reduce((sum, record) => sum + record.length, 0);
  const end = new Uint8Array(22);
  const e = new DataView(end.buffer);
  e.setUint32(0, 0x06054b50, true);
  e.setUint16(8, central.length, true);
  e.setUint16(10, central.length, true);
  e.setUint32(12, size, true);
  e.setUint32(16, offset, true);
  return new Blob([...parts, ...central, end] as BlobPart[]);
}
