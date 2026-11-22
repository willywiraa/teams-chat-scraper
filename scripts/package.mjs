// Builds the extension for release (no source maps) and puts dist/ into
// release/chat-archiver-<version>.zip, the file to upload to the Edge Add-ons store.
// Usage: npm run package
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const releaseDir = path.join(root, 'release');

execFileSync(process.execPath, [path.join(root, 'scripts/build.mjs'), '--release'], { stdio: 'inherit' });

/** Every file under a folder, as paths with `/`, sorted so the archive is the same each time. */
async function filesIn(folder, prefix = '') {
  const found = [];
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) found.push(...(await filesIn(path.join(folder, entry.name), relative)));
    else found.push(relative);
  }
  return found.sort();
}

const manifest = JSON.parse(await readFile(path.join(dist, 'manifest.json'), 'utf8'));
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
if (manifest.version !== pkg.version) throw new Error(`dist/manifest.json has version ${manifest.version}, package.json ${pkg.version}`);

const paths = await filesIn(dist);
const maps = paths.filter((file) => file.endsWith('.map'));
if (maps.length > 0) throw new Error(`A release build has no source maps, but dist/ holds ${maps.join(', ')}`);
for (const required of ['manifest.json', 'background.js', 'content.js', 'popup.html', 'archive.html', 'sidepanel.html', 'icons/icon128.png']) {
  if (!paths.includes(required)) throw new Error(`dist/ has no ${required}`);
}

// The same ZIP writer the exports use (stored entries; the store accepts them).
const bundled = await build({ entryPoints: [path.join(root, 'src/export/zip.ts')], bundle: true, format: 'esm', platform: 'neutral', write: false, logLevel: 'silent' });
const { createZip } = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);

const entries = await Promise.all(paths.map(async (file) => ({ path: file, data: new Uint8Array(await readFile(path.join(dist, file))) })));
const parts = createZip(entries, new Date());
await mkdir(releaseDir, { recursive: true });
const target = path.join(releaseDir, `chat-archiver-${pkg.version}.zip`);
await writeFile(target, Buffer.concat(parts));
const bytes = parts.reduce((sum, part) => sum + part.byteLength, 0);
console.log(`Packaged ${entries.length} files (${(bytes / 1024).toFixed(0)} KB) into ${path.relative(process.cwd(), target) || target}`);
