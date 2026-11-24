// Bundles the extension into dist/ (load that folder as an unpacked extension in Edge).
// Usage: node scripts/build.mjs [--watch | --release]
// --release leaves out the source maps, for the store package (npm run package).
import { build, context } from 'esbuild';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outdir = path.join(root, 'dist');
const watch = process.argv.includes('--watch');
const release = process.argv.includes('--release');

const entryPoints = {
  background: 'src/background/service-worker.ts',
  content: 'src/content/content-script.ts',
  popup: 'src/ui/popup.ts',
  archive: 'src/ui/archive.ts',
  save: 'src/ui/save.ts',
  theme: 'src/ui/theme-boot.ts',
};

const staticFiles = ['src/ui/popup.html', 'src/ui/archive.html', 'src/ui/save.html', 'src/ui/ui.css'];

async function copyStatic() {
  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const manifest = JSON.parse(await readFile(path.join(root, 'src/manifest.json'), 'utf8'));
  manifest.version = pkg.version;
  await writeFile(path.join(outdir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  for (const file of staticFiles) {
    await cp(path.join(root, file), path.join(outdir, path.basename(file)));
  }
  // The side panel reuses the popup UI in "panel" mode.
  const popup = await readFile(path.join(root, 'src/ui/popup.html'), 'utf8');
  await writeFile(path.join(outdir, 'sidepanel.html'), popup.replace('data-mode="popup"', 'data-mode="panel"'));
  await cp(path.join(root, 'icons'), path.join(outdir, 'icons'), { recursive: true });
  // Geist and Geist Mono ship with the extension, which loads nothing from the network; the
  // licences cover the fonts and the Lucide icons drawn in src/ui/icons.ts.
  await cp(path.join(root, 'src/ui/fonts'), path.join(outdir, 'fonts'), { recursive: true });
  await cp(path.join(root, 'src/ui/licenses'), path.join(outdir, 'licenses'), { recursive: true });
}

/** @type {import('esbuild').Plugin} */
const staticPlugin = {
  name: 'copy-static',
  setup(pluginBuild) {
    pluginBuild.onEnd(async (result) => {
      if (result.errors.length === 0) {
        await copyStatic();
        if (watch) console.log(`[${new Date().toLocaleTimeString()}] rebuilt dist/`);
      }
    });
  },
};

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: Object.fromEntries(Object.entries(entryPoints).map(([name, file]) => [name, path.join(root, file)])),
  outdir,
  bundle: true,
  format: 'iife',
  target: ['chrome116'],
  sourcemap: release ? false : 'linked',
  legalComments: 'none',
  logLevel: 'info',
  plugins: [staticPlugin],
};

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });

if (watch) {
  const ctx = await context(options);
  await ctx.watch();
  console.log('Watching for changes... (Ctrl+C to stop)');
} else {
  await build(options);
  console.log(`Built extension${release ? ' for release' : ''} into ${path.relative(process.cwd(), outdir) || outdir}`);
}
