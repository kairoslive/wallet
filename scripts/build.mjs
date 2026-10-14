import { build as esbuild, context } from 'esbuild';
import { build as viteBuild } from 'vite';
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = resolve(root, 'dist');
const watch = process.argv.includes('--watch');
// Shared by the background and UI bundles so the UI can detect a stale service worker after a rebuild.
const BUILD_ID = Date.now().toString(36);

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });
cpSync(resolve(root, 'public'), dist, { recursive: true });

const common = {
  bundle: true,
  target: 'chrome114',
  minify: !watch,
  sourcemap: watch ? 'inline' : false,
  define: {
    'process.env.NODE_DEBUG': 'false',
    'process.env.NODE_ENV': '"production"',
    global: 'globalThis',
    __BUILD_ID__: JSON.stringify(BUILD_ID),
  },
  logLevel: 'info',
};

const entries = [
  {
    entryPoints: [resolve(root, 'src/background/index.ts')],
    outfile: resolve(dist, 'background.js'),
    format: 'esm',
    inject: [resolve(root, 'scripts/buffer-shim.js')],
  },
  { entryPoints: [resolve(root, 'src/content/index.ts')], outfile: resolve(dist, 'content.js'), format: 'iife' },
  { entryPoints: [resolve(root, 'src/inpage/index.ts')], outfile: resolve(dist, 'inpage.js'), format: 'iife' },
];

if (watch) {
  for (const e of entries) await (await context({ ...common, ...e })).watch();
  await viteBuild({
    root,
    configFile: resolve(root, 'vite.config.ts'),
    define: { __BUILD_ID__: JSON.stringify(BUILD_ID) },
    build: { watch: {}, minify: false },
  });
} else {
  await Promise.all(entries.map((e) => esbuild({ ...common, ...e })));
  await viteBuild({
    root,
    configFile: resolve(root, 'vite.config.ts'),
    define: { __BUILD_ID__: JSON.stringify(BUILD_ID) },
    logLevel: 'warn',
  });
  console.log('Built extension into dist/');
}
