/**
 * The logo files are generated from one description (scripts/logo.ts), and the interface colours
 * keep readable contrast in both themes.
 */
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { BRAND_BLUE, LOGO, LOGO_SMALL, logoSvg, rasterize, renderLogo, STORE_TILE } from '../../scripts/logo';

/** Width, height and RGBA pixels of a PNG written by `encodePng` (8-bit RGBA, rows unfiltered). */
function decodePng(bytes: Uint8Array): { width: number; height: number; pixels: Uint8Array } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  expect([...bytes.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  let width = 0;
  let height = 0;
  const data: Uint8Array[] = [];
  for (let at = 8; at < bytes.length; ) {
    const length = view.getUint32(at);
    const type = new TextDecoder().decode(bytes.subarray(at + 4, at + 8));
    const body = bytes.subarray(at + 8, at + 8 + length);
    if (type === 'IHDR') {
      width = view.getUint32(at + 8);
      height = view.getUint32(at + 12);
      expect([body[8], body[9]]).toEqual([8, 6]);
    }
    if (type === 'IDAT') data.push(body);
    at += 12 + length;
  }
  const raw = new Uint8Array(inflateSync(Buffer.concat(data)));
  const pixels = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    expect(raw[y * (width * 4 + 1)]).toBe(0);
    pixels.set(raw.subarray(y * (width * 4 + 1) + 1, (y + 1) * (width * 4 + 1)), y * width * 4);
  }
  return { width, height, pixels };
}

const file = (path: string) => new Uint8Array(readFileSync(path));

describe('logo files', () => {
  it('the SVG masters are the drawings', () => {
    expect(readFileSync('icons/logo.svg', 'utf8').replace(/\r\n/g, '\n')).toBe(logoSvg(LOGO));
    expect(readFileSync('icons/logo-16.svg', 'utf8').replace(/\r\n/g, '\n')).toBe(logoSvg(LOGO_SMALL));
  });

  it('the icons and store images are drawn from the same shapes (run npm run icons after changing them)', () => {
    for (const size of [16, 32, 48, 128]) {
      const png = decodePng(file(`icons/icon${size}.png`));
      expect([png.width, png.height]).toEqual([size, size]);
      expect(png.pixels).toEqual(renderLogo(size));
    }
    expect(decodePng(file('store/logo-300.png')).pixels).toEqual(renderLogo(300));
    const tile = decodePng(file('store/tile-440x280.png'));
    expect([tile.width, tile.height]).toEqual([440, 280]);
    expect(tile.pixels).toEqual(rasterize(STORE_TILE.shapes, 440, 280, 1));
  });

  it('draws the 16 px icon on whole pixels: a white lid and box on the brand colour, no purple', () => {
    const pixels = renderLogo(16);
    const at = (x: number, y: number) => [...pixels.subarray((y * 16 + x) * 4, (y * 16 + x) * 4 + 4)];
    expect(at(8, 4)).toEqual([255, 255, 255, 255]); // lid
    expect(at(8, 6)).toEqual([0x1f, 0x5f, 0xbf, 255]); // gap under the lid
    expect(at(4, 8)).toEqual([255, 255, 255, 255]); // box
    expect(at(8, 9)).toEqual([0x1f, 0x5f, 0xbf, 255]); // handle slot
    expect(BRAND_BLUE).not.toBe('#5b5fc7');
  });
});

// ------------------------------------------------------------- contrast

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (high + 0.05) / (low + 0.05);
}

const CSS = readFileSync('src/ui/ui.css', 'utf8');

/** The colour variables set in the CSS rule that starts with `selector`. */
function colours(selector: string): Record<string, string> {
  const start = CSS.indexOf(selector);
  expect(start, selector).toBeGreaterThanOrEqual(0);
  const block = CSS.slice(start, CSS.indexOf('}', start));
  return Object.fromEntries([...block.matchAll(/--([\w-]+):\s*(#[0-9a-f]{6})\s*;/gi)].map((m) => [m[1] as string, (m[2] as string).toLowerCase()]));
}

/** "System" when Windows is dark, and an explicit "Dark". */
const DARK_FOR_SYSTEM = ":root:not([data-theme='light']) {";
const DARK_CHOSEN = ":root[data-theme='dark'] {";

/** The colour variables of the light theme and, over them, of the dark theme. */
function themes(): Record<'light' | 'dark', Record<string, string>> {
  const light = colours(':root {');
  return { light, dark: { ...light, ...colours(DARK_CHOSEN) } };
}

describe('interface colours', () => {
  it('use a blue accent instead of the Teams purple', () => {
    const { light, dark } = themes();
    expect(light.accent).toBe(BRAND_BLUE);
    for (const theme of [light, dark]) for (const value of Object.values(theme)) expect(['#5b5fc7', '#4f52b2', '#7f85f5', '#9297f7']).not.toContain(value);
  });

  it('are the same for a dark Windows theme and for the Dark choice', () => {
    expect(CSS.indexOf('@media (prefers-color-scheme: dark)')).toBeLessThan(CSS.indexOf(DARK_FOR_SYSTEM));
    const system = colours(DARK_FOR_SYSTEM);
    expect(Object.keys(system).length).toBeGreaterThanOrEqual(15);
    expect(colours(DARK_CHOSEN)).toEqual(system);
    // Every colour of the light theme has a dark value.
    expect(Object.keys(system).sort()).toEqual(Object.keys(colours(':root {')).sort());
  });

  it('keep text readable (WCAG AA, 4.5:1) in both themes', () => {
    for (const [name, theme] of Object.entries(themes())) {
      const pairs: Array<[string, string]> = [
        ['text', 'bg'],
        ['text', 'card'],
        ['muted', 'card'],
        ['muted', 'bg'],
        ['accent-text', 'accent'],
        ['accent-text', 'accent-hover'],
        ['accent', 'card'],
        ['danger', 'card'],
        ['warning', 'card'],
        ['text', 'notice-bg'],
        ['text', 'success-bg'],
        ['text', 'error-bg'],
        ['text', 'hover'],
        ['muted', 'hover'],
        ['accent', 'selected'],
        ['text', 'self-bg'],
        ['muted', 'self-bg'],
      ];
      for (const [fore, back] of pairs) {
        const ratio = contrast(theme[fore] as string, theme[back] as string);
        expect(ratio, `${name}: --${fore} on --${back}`).toBeGreaterThanOrEqual(4.5);
      }
      // The focus ring needs 3:1 against what it sits on (WCAG 1.4.11).
      for (const back of ['card', 'bg']) expect(contrast(theme.focus as string, theme[back] as string), `${name}: --focus on --${back}`).toBeGreaterThanOrEqual(3);
    }
  });
});
