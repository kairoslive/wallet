// Builds the extension and zips dist/ for upload to the Chrome Web Store: release/duo-wallet-<version>.zip.
// Refuses to package when the manifest and package.json versions disagree or the build looks wrong.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = resolve(root, 'dist');
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const manifest = JSON.parse(readFileSync(resolve(root, 'public/manifest.json'), 'utf8'));

const fail = (msg) => {
  console.error(`package: ${msg}`);
  process.exit(1);
};

if (manifest.version !== pkg.version) {
  fail(`public/manifest.json is ${manifest.version} but package.json is ${pkg.version}. Bump both to the same version.`);
}
if (!/^\d+(\.\d+){0,3}$/.test(manifest.version)) fail(`"${manifest.version}" isn't a valid Chrome extension version`);

execFileSync('node', [resolve(root, 'scripts/build.mjs')], { stdio: 'inherit', cwd: root });

const files = [];
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else files.push(relative(dist, p));
  }
};
walk(dist);

// Everything the manifest points at must be in the zip.
const referenced = [
  manifest.background.service_worker,
  manifest.action.default_popup,
  ...Object.values(manifest.icons),
  ...manifest.content_scripts.flatMap((c) => c.js),
];
for (const f of referenced) if (!files.includes(f)) fail(`manifest references ${f}, which the build didn't produce`);
const maps = files.filter((f) => f.endsWith('.map'));
if (maps.length) fail(`source maps in the build: ${maps.join(', ')}`);
// MV3 forbids remotely hosted code: no script may load from a URL.
for (const f of files.filter((f) => f.endsWith('.html'))) {
  if (/<script[^>]+src=["']https?:/i.test(readFileSync(join(dist, f), 'utf8'))) fail(`${f} loads a remote script`);
}

const out = resolve(root, 'release');
mkdirSync(out, { recursive: true });
const zip = join(out, `duo-wallet-${manifest.version}.zip`);
if (existsSync(zip)) rmSync(zip);
// -X drops macOS extra attributes; the manifest sits at the zip root, as the store requires.
execFileSync('zip', ['-r', '-X', '-q', zip, '.', '-x', '.DS_Store', '*/.DS_Store'], { cwd: dist, stdio: 'inherit' });

const kb = Math.round(statSync(zip).size / 1024);
console.log(
  `\nPackaged ${relative(root, zip)} (${kb} KB, ${files.length} files). Upload it at https://chrome.google.com/webstore/devconsole`,
);
