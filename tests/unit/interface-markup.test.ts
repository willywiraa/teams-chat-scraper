/**
 * The pages' markup and stylesheet: the icons they ask for exist, the fonts they name ship with
 * the extension, and nothing is loaded from the network.
 */
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ICON_NAMES } from '../../src/ui/icons';

const PAGES = ['src/ui/popup.html', 'src/ui/archive.html', 'src/ui/save.html'];
const CSS = readFileSync('src/ui/ui.css', 'utf8');

describe('interface markup', () => {
  it('asks only for icons that exist', () => {
    for (const page of PAGES) {
      const names = [...readFileSync(page, 'utf8').matchAll(/data-icon="([^"]+)"/g)].map((match) => match[1]);
      for (const name of names) expect(ICON_NAMES, `${page}: data-icon="${name}"`).toContain(name);
    }
  });

  it('ships the fonts the stylesheet and the pages name, with their licence', () => {
    const urls = [...CSS.matchAll(/url\('([^']+)'\)/g)].map((match) => match[1] as string);
    expect(urls).toEqual(['fonts/Geist-Variable.woff2', 'fonts/GeistMono-Variable.woff2']);
    for (const page of PAGES) for (const [, href] of readFileSync(page, 'utf8').matchAll(/rel="preload" href="([^"]+)"/g)) urls.push(href as string);
    for (const url of urls) expect(existsSync(`src/ui/${url}`), url).toBe(true);
    expect(readFileSync('src/ui/licenses/Geist-OFL.txt', 'utf8')).toContain('SIL OPEN FONT LICENSE Version 1.1');
    expect(readFileSync('src/ui/licenses/Lucide-ISC.txt', 'utf8')).toContain('ISC License');
  });

  it('loads nothing from another origin', () => {
    for (const file of [...PAGES, 'src/ui/ui.css']) expect(readFileSync(file, 'utf8'), file).not.toMatch(/(?:src|href)=["']https?:|url\(['"]?https?:|@import/);
  });

  it('uses Geist for the interface and Geist Mono for machine values', () => {
    expect(CSS).toMatch(/--font-sans: 'Geist',/);
    expect(CSS).toMatch(/--font-mono: 'Geist Mono',/);
    for (const rule of ['.mono {', '.log {', 'textarea {\n  font-family']) {
      const start = CSS.replace(/\r\n/g, '\n').indexOf(rule);
      expect(start, rule).toBeGreaterThanOrEqual(0);
    }
  });
});
