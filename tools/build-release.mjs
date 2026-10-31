#!/usr/bin/env node
// Builds the frozen device: one .amxd that carries the patch, the Node code
// with the editor page (bundled by esbuild) and max/live.js. It is the only
// file to install or share; settings, logs and the Google sign-in stay on
// each Mac (see node/library.js and node/google.js).
//
// The device's public OAuth client goes into the bundle (node/client.js). It
// is read from RELEASE_CLIENT, by default release-client.json next to the
// token (the JSON file Google gives for a desktop client). Without that file
// the device has no client of its own and each Mac needs client.json.
// Usage: [RELEASE_CLIENT=<client.json>] node tools/build-release.mjs [<out.amxd>]
//   (default dist/Google Docs.amxd; dist/ is not in git, releases are on GitHub)
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { decodeAmxd, encodeFrozenAmxd } from './amxd.mjs';

// Names, not paths: the frozen device finds them inside itself. Unique, as
// Max looks up script names in one search path for all devices.
const NODE_SCRIPT = 'google-docs-node.js';
const LIVE_SCRIPT = 'google-docs-live.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.resolve(process.argv[2] ?? path.join(root, 'dist', 'Google Docs.amxd'));
const html = await readFile(path.join(root, 'ui', 'index.html'), 'utf8');

// node/page.js reads ui/index.html; in the bundle it returns the text.
const pageText = {
  name: 'page-text',
  setup(b) {
    b.onResolve({ filter: /^\.\/page\.js$/ }, () => ({ path: 'page', namespace: 'page-text' }));
    b.onLoad({ filter: /.*/, namespace: 'page-text' }, () => ({ contents: `module.exports = () => ${JSON.stringify(html)};`, loader: 'js' }));
  },
};

const clientFile = process.env.RELEASE_CLIENT || path.join(homedir(), 'Library', 'Application Support', 'ableton-google-docs', 'release-client.json');
let client = null;
if (process.env.RELEASE_CLIENT || existsSync(clientFile)) {
  const raw = JSON.parse(await readFile(clientFile, 'utf8'));
  const { client_id: id, client_secret: secret } = raw.installed ?? raw;
  if (!id || !secret) throw new Error(`no client_id and client_secret in ${clientFile}`);
  client = { id, secret };
}
// node/google.js requires ./client.js; in the bundle it is the client.
const builtInClient = {
  name: 'built-in-client',
  setup(b) {
    b.onResolve({ filter: /^\.\/client\.js$/ }, () => ({ path: 'client', namespace: 'built-in-client' }));
    b.onLoad({ filter: /.*/, namespace: 'built-in-client' }, () => ({ contents: `module.exports = ${JSON.stringify(client)};`, loader: 'js' }));
  },
};
const bundle = await build({
  entryPoints: [path.join(root, 'node', 'main.js')],
  bundle: true,
  write: false,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['max-api'],
  legalComments: 'none',
  plugins: [pageText, builtInClient],
});

const scratch = await mkdtemp(path.join(tmpdir(), 'gdocs-release-'));
const unfrozen = path.join(scratch, 'device.amxd');
execFileSync(process.execPath, [path.join(root, 'tools', 'build-device.mjs'), unfrozen, NODE_SCRIPT, LIVE_SCRIPT]);
const patcher = decodeAmxd(await readFile(unfrozen));

await mkdir(path.dirname(out), { recursive: true });
await writeFile(
  out,
  encodeFrozenAmxd(patcher, path.basename(out), [
    { name: NODE_SCRIPT, text: bundle.outputFiles[0].text },
    { name: LIVE_SCRIPT, text: await readFile(path.join(root, 'max', 'live.js'), 'utf8') },
  ]),
);
console.log(`wrote ${out}`);
console.log(client ? `with the built-in Google client from ${clientFile}` : `without a built-in Google client (no ${clientFile}): each Mac needs client.json`);
