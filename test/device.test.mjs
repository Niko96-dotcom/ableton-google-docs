// The generated device against node/main.js: every message node sends has a
// route in the patch, every message the patch sends to node has a handler,
// and the js script and the stored doc are wired as main.js expects.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

async function buildDevice() {
  const dir = await mkdtemp(path.join(tmpdir(), 'gdocs-device-'));
  const out = path.join(dir, 'Google Docs.amxd');
  execFileSync(process.execPath, [path.join(root, 'tools', 'build-device.mjs'), out, path.join(dir, 'app', 'node', 'main.js')]);
  const buffer = await readFile(out);
  let pos = 0;
  while (pos + 8 <= buffer.length) {
    const tag = buffer.toString('ascii', pos, pos + 4);
    const size = buffer.readUInt32LE(pos + 4);
    if (tag === 'ptch') return { dir, patcher: JSON.parse(buffer.toString('utf8', pos + 8, pos + 8 + size).replace(/\0+$/, '')).patcher };
    pos += 8 + size;
  }
  throw new Error('no patch chunk');
}

test('the patch and node/main.js agree on every message', async () => {
  const { dir, patcher } = await buildDevice();
  const main = await readFile(path.join(root, 'node', 'main.js'), 'utf8');
  const boxes = patcher.boxes.map((b) => b.box);
  const byId = Object.fromEntries(boxes.map((b) => [b.id, b]));
  const node = boxes.find((b) => b.text?.startsWith('node.script'));
  assert.equal(node.text, `node.script "${path.join(dir, 'app', 'node', 'main.js')}" @autostart 1`);

  // node -> patch: the first word of each maxApi.outlet picks a route outlet.
  const route = boxes.find((b) => patcher.lines.some((l) => l.patchline.source[0] === node.id && l.patchline.destination[0] === b.id));
  const routed = route.text.split(' ').slice(1);
  const sentByNode = new Set([...main.matchAll(/maxApi\.outlet\('([^']+)'/g)].map((m) => m[1]));
  for (const name of sentByNode) assert.ok(routed.includes(name), `the patch does not route "${name}"`);

  // patch -> node: what reaches node's inlet starts with a handler's name.
  const handlers = new Set([...main.matchAll(/addHandler\('([^']+)'/g)].map((m) => m[1]));
  const into = patcher.lines.filter((l) => l.patchline.destination[0] === node.id).map((l) => byId[l.patchline.source[0]]);
  for (const box of into) {
    const name = box.maxclass === 'message' ? box.text.split(' ')[0] : box.text.replace(/^prepend /, '');
    assert.ok(handlers.has(name), `main.js has no handler for "${name}" (${box.text})`);
  }
});

test('Live script and stored doc', async () => {
  const { dir, patcher } = await buildDevice();
  const boxes = patcher.boxes.map((b) => b.box);
  const js = boxes.find((b) => b.text?.startsWith('js '));
  assert.equal(js.text, `js "${path.join(dir, 'app', 'max', 'live.js')}"`);
  const doc = boxes.find((b) => b.text === 'pattr doc');
  assert.equal(doc.saved_object_attributes.parameter_enable, 1);
  assert.deepEqual(
    [doc.saved_attribute_attributes.valueof.parameter_type, doc.saved_attribute_attributes.valueof.parameter_invisible],
    [3, 1],
    'a blob that is stored with the set and never shown or automated',
  );
  const liveJs = await readFile(path.join(root, 'max', 'live.js'), 'utf8');
  assert.match(liveJs, /function stamp\(\)/);
});
