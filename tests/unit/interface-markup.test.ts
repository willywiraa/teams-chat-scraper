/**
 * The pages' markup and stylesheet: the icons they ask for exist, the type is the system's own
 * (Segoe UI, Consolas for machine values), and nothing is loaded from the network.
 */
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ICON_NAMES } from '../../src/ui/icons';

const PAGES = ['src/ui/popup.html', 'src/ui/archive.html', 'src/ui/save.html'];
const CSS = readFileSync('src/ui/ui.css', 'utf8').replace(/\r\n/g, '\n');

describe('interface markup', () => {
  it('asks only for icons that exist', () => {
    for (const page of PAGES) {
      const names = [...readFileSync(page, 'utf8').matchAll(/data-icon="([^"]+)"/g)].map((match) => match[1]);
      for (const name of names) expect(ICON_NAMES, `${page}: data-icon="${name}"`).toContain(name);
    }
  });

  it('ships the licence of the icons it draws', () => {
    expect(readFileSync('src/ui/licenses/Lucide-ISC.txt', 'utf8')).toContain('ISC License');
  });

  it('loads nothing from another origin, and no font file', () => {
    for (const file of [...PAGES, 'src/ui/ui.css']) expect(readFileSync(file, 'utf8'), file).not.toMatch(/(?:src|href)=["']https?:|url\(['"]?https?:|@import/);
    expect(CSS).not.toMatch(/@font-face/);
    for (const page of PAGES) expect(readFileSync(page, 'utf8'), page).not.toMatch(/rel="preload"/);
    expect(existsSync('src/ui/fonts')).toBe(false);
  });

  it('uses Segoe UI for the interface and Consolas only for machine values', () => {
    expect(CSS).toMatch(/--font-sans: 'Segoe UI',/);
    expect(CSS).toMatch(/--font-mono: Consolas,/);
    const mono = [...CSS.matchAll(/([^{}]+)\{[^}]*font-family: var\(--font-mono\)/g)].map((match) => (match[1] as string).trim().split('\n').at(-1));
    expect(mono).toEqual(['.mono', 'textarea']);
  });

  it('draws with two weights only, as Segoe UI has no medium', () => {
    const weights = new Set([...CSS.matchAll(/font-weight: (\w+)/g)].map((match) => match[1]));
    expect([...weights].sort()).toEqual(['400', '600', 'inherit']);
  });
});
