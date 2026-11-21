/**
 * The extension's logo, described once: an archive box shaped like a speech bubble (an overhanging
 * lid, a box with a handle slot, and a speech tail) on a blue tile. The same shapes give the SVG
 * master and every PNG, so they can't drift apart. A simplified, pixel-aligned variant is drawn
 * at 16 px, where the handle slot and thin gaps would blur.
 *
 * Kept free of dependencies (only `node:zlib`) and of TypeScript-only syntax, so Node runs it
 * directly (`scripts/generate-icons.mjs`) and the tests import it.
 */
import { deflateSync } from 'node:zlib';

export const BRAND_BLUE = '#1f5fbf';
const WHITE = '#ffffff';

export interface Rect {
  kind: 'rect';
  x: number;
  y: number;
  width: number;
  height: number;
  radius: number;
  fill: string;
}

export interface Polygon {
  kind: 'polygon';
  points: Array<[number, number]>;
  fill: string;
}

export type Shape = Rect | Polygon;

/** Shapes in drawing order on a square grid of `size` units. */
export interface Drawing {
  size: number;
  shapes: Shape[];
}

const rect = (x: number, y: number, width: number, height: number, radius: number, fill: string): Rect => ({ kind: 'rect', x, y, width, height, radius, fill });
const polygon = (points: Array<[number, number]>, fill: string): Polygon => ({ kind: 'polygon', points, fill });

/**
 * The mark without its tile, on a 128-unit grid: lid, box, tail, handle slot (in `ink`). Edges
 * lie on multiples of 8 units, which are whole pixels at 32 and 48 px.
 */
function mark(paper: string, ink: string): Shape[] {
  return [
    rect(24, 24, 80, 16, 6, paper),
    rect(32, 48, 64, 40, 8, paper),
    polygon([[40, 84], [64, 84], [32, 104]], paper),
    rect(48, 64, 32, 8, 4, ink),
  ];
}

/** The master logo, 128 units square. */
export const LOGO: Drawing = {
  size: 128,
  shapes: [rect(4, 4, 120, 120, 26, BRAND_BLUE), ...mark(WHITE, BRAND_BLUE)],
};

/** The 16 px logo: the same parts on whole pixels, the handle slot one pixel high. */
export const LOGO_SMALL: Drawing = {
  size: 16,
  shapes: [
    rect(0, 0, 16, 16, 3.5, BRAND_BLUE),
    rect(2, 3, 12, 3, 1, WHITE),
    rect(3, 7, 10, 5, 1, WHITE),
    polygon([[4, 11], [7.5, 11], [4, 14.5]], WHITE),
    rect(6, 9, 4, 1, 0, BRAND_BLUE),
  ],
};

/** The drawing used for an icon of `pixels` pixels. */
export function logoFor(pixels: number): Drawing {
  return pixels <= 16 ? LOGO_SMALL : LOGO;
}

/** The small store tile (440 × 280): the mark, white, centred on the brand colour. No text, so it holds whatever the extension is named. */
export const STORE_TILE: { width: number; height: number; shapes: Shape[] } = (() => {
  const scale = 2.2;
  const left = 220 - 64 * scale;
  const top = 140 - 64 * scale;
  const place = (shape: Shape): Shape =>
    shape.kind === 'rect'
      ? { ...shape, x: left + shape.x * scale, y: top + shape.y * scale, width: shape.width * scale, height: shape.height * scale, radius: shape.radius * scale }
      : { ...shape, points: shape.points.map(([x, y]) => [left + x * scale, top + y * scale]) };
  return { width: 440, height: 280, shapes: [rect(0, 0, 440, 280, 0, BRAND_BLUE), ...mark(WHITE, BRAND_BLUE).map(place)] };
})();

// ----------------------------------------------------------------- SVG

const num = (value: number): string => String(Math.round(value * 1000) / 1000);

function svgShape(shape: Shape): string {
  if (shape.kind === 'polygon') return `  <polygon points="${shape.points.map(([x, y]) => `${num(x)},${num(y)}`).join(' ')}" fill="${shape.fill}"/>`;
  const radius = shape.radius > 0 ? ` rx="${num(shape.radius)}"` : '';
  return `  <rect x="${num(shape.x)}" y="${num(shape.y)}" width="${num(shape.width)}" height="${num(shape.height)}"${radius} fill="${shape.fill}"/>`;
}

export function toSvg(width: number, height: number, shapes: readonly Shape[], title = 'Chat archive logo'): string {
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="${title}">`,
    ...shapes.map(svgShape),
    '</svg>',
    '',
  ].join('\n');
}

export function logoSvg(drawing: Drawing = LOGO): string {
  return toSvg(drawing.size, drawing.size, drawing.shapes);
}

// -------------------------------------------------------------- raster

function insideRect(x: number, y: number, r: Rect): boolean {
  if (x < r.x || x > r.x + r.width || y < r.y || y > r.y + r.height) return false;
  if (r.radius <= 0) return true;
  const cx = Math.min(Math.max(x, r.x + r.radius), r.x + r.width - r.radius);
  const cy = Math.min(Math.max(y, r.y + r.radius), r.y + r.height - r.radius);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r.radius ** 2;
}

/** Even-odd rule. */
function insidePolygon(x: number, y: number, points: ReadonlyArray<[number, number]>): boolean {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [xi, yi] = points[i] as [number, number];
    const [xj, yj] = points[j] as [number, number];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function rgb(hex: string): [number, number, number] {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
}

/**
 * Draws shapes into RGBA pixels (`width` × `height`), the shapes' units scaled by `scale`.
 * Each pixel averages 8 × 8 samples; a sample takes the colour of the topmost shape holding it.
 */
export function rasterize(shapes: readonly Shape[], width: number, height: number, scale: number): Uint8Array {
  const samples = 8;
  const colours = shapes.map((shape) => rgb(shape.fill));
  const pixels = new Uint8Array(width * height * 4);
  for (let py = 0; py < height; py++) {
    for (let px = 0; px < width; px++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let covered = 0;
      for (let sy = 0; sy < samples; sy++) {
        for (let sx = 0; sx < samples; sx++) {
          const x = (px + (sx + 0.5) / samples) / scale;
          const y = (py + (sy + 0.5) / samples) / scale;
          for (let i = shapes.length - 1; i >= 0; i--) {
            const shape = shapes[i] as Shape;
            if (shape.kind === 'rect' ? insideRect(x, y, shape) : insidePolygon(x, y, shape.points)) {
              const colour = colours[i] as [number, number, number];
              r += colour[0];
              g += colour[1];
              b += colour[2];
              covered++;
              break;
            }
          }
        }
      }
      const at = (py * width + px) * 4;
      if (covered > 0) {
        pixels[at] = Math.round(r / covered);
        pixels[at + 1] = Math.round(g / covered);
        pixels[at + 2] = Math.round(b / covered);
      }
      pixels[at + 3] = Math.round((covered / (samples * samples)) * 255);
    }
  }
  return pixels;
}

export function renderLogo(pixels: number): Uint8Array {
  const drawing = logoFor(pixels);
  return rasterize(drawing.shapes, pixels, pixels, pixels / drawing.size);
}

// ----------------------------------------------------------------- PNG

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (CRC_TABLE[(crc ^ byte) & 0xff] as number) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const head = new Uint8Array(8);
  const view = new DataView(head.buffer);
  view.setUint32(0, data.length);
  head.set(new TextEncoder().encode(type), 4);
  const crc = new Uint8Array(4);
  new DataView(crc.buffer).setUint32(0, crc32(concat([head.subarray(4), data])));
  return concat([head, data, crc]);
}

/** An RGBA PNG, rows unfiltered. */
export function encodePng(width: number, height: number, rgba: Uint8Array): Uint8Array {
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  const raw = new Uint8Array(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) raw.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), y * (width * 4 + 1) + 1);
  return concat([
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', new Uint8Array(deflateSync(raw, { level: 9 }))),
    chunk('IEND', new Uint8Array()),
  ]);
}
