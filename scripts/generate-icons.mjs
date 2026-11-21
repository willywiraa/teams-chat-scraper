// Generates the logo files from the one description in scripts/logo.ts, without external dependencies:
//   icons/logo.svg, icons/logo-16.svg            the SVG masters (128 units, and the 16 px variant)
//   icons/icon16|32|48|128.png                   the extension icons
//   store/logo-300.png, store/tile-440x280.png   store listing images (not part of the extension)
// Usage: npm run icons
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodePng, LOGO, LOGO_SMALL, logoSvg, rasterize, renderLogo, STORE_TILE } from './logo.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const icons = path.join(root, 'icons');
const store = path.join(root, 'store');
const ICON_SIZES = [16, 32, 48, 128];

await mkdir(icons, { recursive: true });
await mkdir(store, { recursive: true });
const written = [];
async function write(file, data) {
  await writeFile(file, data);
  written.push(path.relative(root, file).replace(/\\/g, '/'));
}

await write(path.join(icons, 'logo.svg'), logoSvg(LOGO));
await write(path.join(icons, 'logo-16.svg'), logoSvg(LOGO_SMALL));
for (const size of ICON_SIZES) await write(path.join(icons, `icon${size}.png`), encodePng(size, size, renderLogo(size)));
await write(path.join(store, 'logo-300.png'), encodePng(300, 300, renderLogo(300)));
await write(path.join(store, 'tile-440x280.png'), encodePng(STORE_TILE.width, STORE_TILE.height, rasterize(STORE_TILE.shapes, STORE_TILE.width, STORE_TILE.height, 1)));
console.log(`Wrote ${written.join(', ')}`);
