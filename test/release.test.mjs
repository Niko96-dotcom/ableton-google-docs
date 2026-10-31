// The frozen device format (tools/amxd.mjs) and the release build
// (tools/build-release.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeFrozenAmxd, encodeFrozenAmxd, freeze } from '../tools/amxd.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

test('frozen format: header, files and file list as Max writes them', () => {
  const date = new Date('2026-10-27T20:00:00Z');
  const buffer = encodeFrozenAmxd({ boxes: [], lines: [] }, 'Dev.amxd', [{ name: 'a.js', text: 'one' }], { date });
  assert.equal(buffer.toString('ascii', 0, 4), 'ampf');
  assert.equal(buffer.toString('ascii', 8, 12), 'aaaa');
  assert.deepEqual([...buffer.subarray(20, 24)], [7, 0, 0, 0], 'meta 7 marks a frozen device');
  const ptch = buffer.subarray(32);
  assert.equal(ptch.toString('ascii', 0, 4), 'mx@c');
  assert.deepEqual([ptch.readUInt32BE(4), ptch.readUInt32BE(8)], [16, 0]);

  const [patch, script] = decodeFrozenAmxd(buffer);
  assert.deepEqual([patch.kind, patch.name, patch.flag], ['JSON', 'Dev.amxd', 17]);
  assert.deepEqual([script.kind, script.name, script.flag, script.data.toString()], ['TEXT', 'a.js', 8, 'one']);
  assert.equal(script.mdat, Math.floor(date.getTime() / 1000) + 2082844800, 'seconds since 1904');
  const { patcher } = JSON.parse(patch.data.toString().replace(/\0+$/, ''));
  assert.equal(patcher.project.amxdtype, 0x61616161, '"aaaa": an audio effect');
  assert.equal(patcher.project.devpath, '.');

  assert.equal(Buffer.compare(freeze(decodeFrozenAmxd(buffer)), buffer), 0, 'decode and freeze give the same bytes');
});

// Builds the release into a scratch folder; HOME is a scratch folder too, so
// a real release-client.json on this Mac never goes into a test build.
async function buildRelease(env = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'gdocs-release-test-'));
  const out = path.join(dir, 'Google Docs.amxd');
  const { RELEASE_CLIENT, ...rest } = process.env;
  const log = execFileSync(process.execPath, [path.join(root, 'tools', 'build-release.mjs'), out], { env: { ...rest, HOME: dir, ...env }, encoding: 'utf8' });
  return { dir, log, files: decodeFrozenAmxd(await readFile(out)) };
}

test('release: the device names exactly the files it carries; the page is inside', async () => {
  const { files: [patch, ...files] } = await buildRelease();
  const { patcher } = JSON.parse(patch.data.toString().replace(/\0+$/, ''));
  const texts = patcher.boxes.map((b) => b.box.text ?? '');
  assert.ok(texts.includes('node.script "google-docs-node.js" @autostart 1'));
  assert.ok(texts.includes('js "google-docs-live.js"'));
  assert.deepEqual(files.map((f) => f.name), ['google-docs-node.js', 'google-docs-live.js']);

  // esbuild writes the page as a template string, with \u escapes for
  // characters outside ASCII; plain ASCII parts of it stay as they are.
  const node = files[0].data.toString();
  for (const part of ['<div id="toolbar">', 'function serialize()', 'id="editor" contenteditable="true"']) {
    assert.ok(node.includes(part), `the editor page is in the Node bundle (${part})`);
  }
  assert.ok(!/require\("\.\/(google|library|page|client)\.js"\)/.test(node), 'no loose project files are needed');
  assert.ok(node.includes('require("max-api")'), 'max-api comes from Max');
  assert.equal(files[1].data.toString(), await readFile(path.join(root, 'max', 'live.js'), 'utf8'));
});

test('release: the OAuth client from RELEASE_CLIENT is built in; without one, none is', async () => {
  const { dir, log: bare } = await buildRelease();
  assert.match(bare, /without a built-in Google client/);
  const clientFile = path.join(dir, 'release-client.json');
  await writeFile(clientFile, JSON.stringify({ installed: { client_id: 'test-client-id', client_secret: 'test-client-secret' } }));
  const { log, files } = await buildRelease({ RELEASE_CLIENT: clientFile });
  assert.match(log, /with the built-in Google client/);
  const node = files[1].data.toString();
  assert.ok(node.includes('"test-client-id"') && node.includes('"test-client-secret"'));
});
