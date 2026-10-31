#!/usr/bin/env node
// Installs a development build into the Ableton User Library of this Mac:
//   <User Library>/Google Docs/app/{node,ui,max}   code that node.script and js run
//   <User Library>/Presets/Audio Effects/Max Audio Effect/Google Docs.amxd
// Usage: node tools/install.mjs [--user-library <path>] [--open-on-load]
// --open-on-load writes settings.json so the editor opens when the device
// loads (used by tests that cannot click).
import { cp, mkdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const { findUserLibrary } = createRequire(import.meta.url)('../node/library.js');
const args = process.argv.slice(2);
const option = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};

const userLibrary = option('--user-library') ?? findUserLibrary();
const data = path.join(userLibrary, 'Google Docs');
const app = path.join(data, 'app');
const devices = path.join(userLibrary, 'Presets', 'Audio Effects', 'Max Audio Effect');
const device = path.join(devices, 'Google Docs.amxd');

await mkdir(app, { recursive: true });
for (const item of ['node', 'ui', 'max', 'package.json']) {
  await cp(path.join(root, item), path.join(app, item), { recursive: true, force: true });
}
if (args.includes('--open-on-load')) await writeFile(path.join(data, 'settings.json'), JSON.stringify({ openOnLoad: true }, null, 2) + '\n');

await mkdir(devices, { recursive: true });
execFileSync(process.execPath, [path.join(root, 'tools', 'build-device.mjs'), device, path.join(app, 'node', 'main.js')], { stdio: 'inherit' });
console.log(`Installed into ${userLibrary}`);
console.log('In Live: Browser > User Library > Presets > Audio Effects > Max Audio Effect > Google Docs.');
