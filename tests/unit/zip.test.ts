/** The ZIP writer (whole and in parts) and the ZIP reader used by import. */
import { describe, expect, it } from 'vitest';
import { crc32, createZip, ZipWriter } from '../../src/export/zip';
import { looksLikeZip, readZipDirectory, readZipFile, zipFileLines } from '../../src/export/zip-reader';
import { deflatedZip, unzip, utf8 } from '../helpers/export';

/** Reads a stored (uncompressed) ZIP archive through its central directory, independently of the extension's reader. */
function readZip(bytes: Uint8Array): Map<string, Uint8Array> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = bytes.length - 22;
  expect(view.getUint32(end, true)).toBe(0x06054b50);
  const count = view.getUint16(end + 10, true);
  let pos = view.getUint32(end + 16, true);
  const files = new Map<string, Uint8Array>();
  const decoder = new TextDecoder();
  for (let i = 0; i < count; i++) {
    expect(view.getUint32(pos, true)).toBe(0x02014b50);
    expect(view.getUint16(pos + 8, true) & 0x0800).toBe(0x0800);
    expect(view.getUint16(pos + 10, true)).toBe(0);
    const crc = view.getUint32(pos + 16, true);
    const size = view.getUint32(pos + 24, true);
    const nameLength = view.getUint16(pos + 28, true);
    const offset = view.getUint32(pos + 42, true);
    const name = decoder.decode(bytes.subarray(pos + 46, pos + 46 + nameLength));
    expect(view.getUint32(offset, true)).toBe(0x04034b50);
    expect(view.getUint32(offset + 14, true)).toBe(crc);
    const dataStart = offset + 30 + view.getUint16(offset + 26, true) + view.getUint16(offset + 28, true);
    const data = bytes.slice(dataStart, dataStart + size);
    expect(crc32(data)).toBe(crc);
    files.set(name, data);
    pos += 46 + nameLength;
  }
  return files;
}

function joined(parts: Uint8Array[]): Uint8Array {
  const bytes = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    bytes.set(part, at);
    at += part.length;
  }
  return bytes;
}

describe('ZIP writer', () => {
  it('computes the standard CRC-32', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array())).toBe(0);
  });

  it('stores files, including UTF-8 names, so they read back unchanged', () => {
    const picture = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 255]);
    const files = readZip(joined(createZip([{ path: 'chat.html', data: '<p>Grüße</p>' }, { path: 'Ölprojekt/images/001.png', data: picture }], new Date(2024, 0, 15, 9, 30))));
    expect([...files.keys()]).toEqual(['chat.html', 'Ölprojekt/images/001.png']);
    expect(utf8(files.get('chat.html'))).toBe('<p>Grüße</p>');
    expect(files.get('Ölprojekt/images/001.png')).toEqual(picture);
  });

  it('refuses unsafe and duplicate paths', () => {
    for (const path of ['/abs.txt', '../up.txt', 'a/../b.txt', 'a\\b.txt', '', 'a//b.txt']) {
      expect(() => createZip([{ path, data: 'x' }])).toThrow(/Invalid path/);
    }
    expect(() => createZip([{ path: 'a.txt', data: 'x' }, { path: 'a.txt', data: 'y' }])).toThrow(/Duplicate path/);
    const zip = new ZipWriter();
    zip.add('a.txt', 'x');
    expect(() => zip.open('a.txt')).toThrow(/Duplicate path/);
    expect(() => zip.add('../b.txt', 'x')).toThrow(/Invalid path/);
  });

  it('writes files in parts, several open at once, into the same archive createZip makes', async () => {
    const modified = new Date(2024, 0, 15, 9, 30);
    const zip = new ZipWriter(modified);
    const text = zip.open('chat.md');
    const lines = zip.open('messages.jsonl');
    text.write('# Title\n');
    lines.write('{"a":1}\n');
    zip.add('images/001.png', new Uint8Array([1, 2, 3]));
    text.write('Grüße ');
    text.write(new TextEncoder().encode('and bytes'));
    lines.write('');
    lines.close();
    expect(() => zip.finish()).toThrow(/still open/);
    text.close();
    const blob = zip.finish();
    expect(blob.type).toBe('application/zip');
    const files = readZip(new Uint8Array(await blob.arrayBuffer()));
    // Files go into the archive when they are closed.
    expect([...files.keys()]).toEqual(['images/001.png', 'messages.jsonl', 'chat.md']);
    expect(utf8(files.get('chat.md'))).toBe('# Title\nGrüße and bytes');
    expect(utf8(files.get('messages.jsonl'))).toBe('{"a":1}\n');
    expect(() => text.write('late')).toThrow(/closed/);
  });
});

describe('ZIP reader', () => {
  it('reads what the writer wrote, file by file and line by line', async () => {
    const zip = new ZipWriter();
    const lines = zip.open('folder/lines.jsonl');
    for (let i = 0; i < 1000; i++) lines.write(`{"n":${i},"text":"Zeile ${i} ✓"}\r\n`);
    lines.write('{"last":true}');
    lines.close();
    zip.add('empty.txt', '');
    const blob = zip.finish();
    expect(looksLikeZip(new Uint8Array(await blob.slice(0, 4).arrayBuffer()))).toBe(true);
    const directory = await readZipDirectory(blob);
    expect([...directory.keys()]).toEqual(['folder/lines.jsonl', 'empty.txt']);
    const read: string[] = [];
    for await (const line of zipFileLines(blob, directory.get('folder/lines.jsonl')!)) read.push(line);
    expect(read).toHaveLength(1001);
    expect(read[999]).toBe('{"n":999,"text":"Zeile 999 ✓"}');
    expect(read[1000]).toBe('{"last":true}');
    expect(await readZipFile(blob, directory.get('empty.txt')!)).toEqual(new Uint8Array());
  });

  it('reads deflated files, as a re-zipped package has them', async () => {
    const big = 'line of text\n'.repeat(5000);
    const files = await unzip(deflatedZip({ 'pkg/manifest.json': '{"a":1}', 'pkg/big.txt': big, 'pkg/bytes.bin': new Uint8Array([0, 1, 2, 250]) }));
    expect(utf8(files.get('pkg/manifest.json'))).toBe('{"a":1}');
    expect(utf8(files.get('pkg/big.txt'))).toBe(big);
    expect(files.get('pkg/bytes.bin')).toEqual(new Uint8Array([0, 1, 2, 250]));
  });

  it('notices damage', async () => {
    const zip = new ZipWriter();
    zip.add('a.txt', 'hello world');
    const bytes = new Uint8Array(await zip.finish().arrayBuffer());
    const damaged = bytes.slice();
    // Local header (30 bytes) and "a.txt" come first; byte 36 is in the data.
    damaged[36] = (damaged[36] as number) ^ 0xff;
    const blob = new Blob([damaged]);
    await expect(readZipFile(blob, (await readZipDirectory(blob)).get('a.txt')!)).rejects.toThrow(/damaged/);
    await expect(readZipDirectory(new Blob(['not a zip at all']))).rejects.toThrow(/Not a ZIP archive/);
    await expect(readZipDirectory(new Blob([bytes.slice(0, bytes.length - 30)]))).rejects.toThrow();
  });
});
