// Runs node/main.js outside Max with stand-ins for max-api and ./google.js.
// HOME is a temporary folder, so the device's data folder (<User Library>/
// Google Docs, with settings and logs) is there too.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import Module from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const realGoogle = createRequire(import.meta.url)('../node/google.js');
const { blocksText } = realGoogle;

const fakeMax = {
  outlets: [],
  handlers: {},
  outlet(...args) {
    this.outlets.push(args);
    return Promise.resolve();
  },
  addHandler(name, fn) {
    this.handlers[name] = fn;
  },
};
const fakeGoogle = {
  signed: false,
  missing: [],
  docs: {},
  saves: [],
  signedIn() {
    return this.signed;
  },
  missingScopes() {
    return this.missing;
  },
  async signIn() {
    this.signed = true;
  },
  async signOut() {
    this.signed = false;
  },
  async listDocs(query) {
    return Object.entries(this.docs)
      .filter(([, d]) => d.title.includes(query))
      .map(([id, d]) => ({ id, name: d.title, modifiedTime: '2026-10-27T19:00:00Z' }));
  },
  async readDoc(id) {
    const doc = this.docs[id];
    if (!doc) throw new Error('Doc not found');
    return { id, ...doc };
  },
  versions: {},
  async version(id) {
    return this.versions[id] ?? 1;
  },
  // Saves merge with docs[id].remote, a paragraph someone else added.
  async saveDoc(doc, base, blocks) {
    this.saves.push({ id: doc.id, base, blocks });
    if (JSON.stringify(blocks).includes('CONFLICT')) throw Object.assign(new Error('Someone else changed the same lines.'), { code: 'conflict' });
    const remote = this.docs[doc.id].remote;
    const merged = remote ? [...blocks, remote] : blocks;
    this.docs[doc.id] = { ...this.docs[doc.id], blocks: merged, text: blocksText(merged) };
    return { id: doc.id, ...this.docs[doc.id] };
  },
  async createDoc(title) {
    this.docs.created = { title, text: '\n', blocks: [], editable: true };
    return 'created';
  },
};
const load = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'max-api') return fakeMax;
  if (request === './google.js') return { ...realGoogle, createGoogle: () => fakeGoogle };
  return load.call(this, request, ...rest);
};

const home = await mkdtemp(path.join(tmpdir(), 'gdocs-home-'));
process.env.HOME = home;
const data = path.join(home, 'Music', 'Ableton', 'User Library', 'Google Docs');
await mkdir(data, { recursive: true });
await writeFile(path.join(data, 'settings.json'), JSON.stringify({ openOnLoad: true, checkSeconds: 0.05 }));
createRequire(import.meta.url)(path.join(root, 'node', 'main.js'));

const sent = (...prefix) => fakeMax.outlets.filter((o) => prefix.every((p, i) => o[i] === p));
const logText = () => readFile(path.join(data, 'logs', 'device.log'), 'utf8');
const fromPage = (...args) => fakeMax.handlers.fromPage(...args);

// Packets as ui/index.html sends and reads them.
const CHUNK = 4000;
async function pagePacket(kind, value) {
  const encoded = encodeURIComponent(JSON.stringify(value));
  await fromPage('pkt_begin', kind);
  for (let i = 0; i < encoded.length; i += CHUNK) await fromPage('pkt_chunk', `c${encoded.slice(i, i + CHUNK)}`);
  await fromPage('pkt_end');
}
function lastPacket(kind) {
  const begin = fakeMax.outlets.findLastIndex((o) => o[1] === 'pkt_begin' && o[2] === kind);
  assert.ok(begin >= 0, `no ${kind} packet`);
  const end = fakeMax.outlets.findIndex((o, i) => i > begin && o[1] === 'pkt_end');
  const parts = fakeMax.outlets.slice(begin + 1, end).map((o) => o[2]);
  assert.ok(parts.every((p) => p.startsWith('c')), 'every chunk starts with a letter');
  return JSON.parse(decodeURIComponent(parts.map((p) => p.slice(1)).join('')));
}

test('start: loads a copy of the page by file URL and opens the window', async () => {
  const [[, , url]] = sent('page', 'read');
  assert.match(url, /^file:\/\/.*\/ableton-google-docs\/editor\.html$/);
  assert.equal(await readFile(fileURLToPath(url), 'utf8'), await readFile(path.join(root, 'ui', 'index.html'), 'utf8'));
  assert.equal(sent('window', 'open').length, 1);
  assert.match(await logText(), /node started .* settings \{"openOnLoad":true/);
});

test('page ready: hello, auth state, and the round trip in the log', async () => {
  await fromPage('ready', 'Mozilla/5.0 test', 560, 760);
  assert.deepEqual(sent('page', 'hello')[0], ['page', 'hello', process.version]);
  assert.deepEqual(sent('page', 'auth').at(-1), ['page', 'auth', 'signedout']);
  await fromPage('ack');
  assert.match(await logText(), /round trip ok/);
});

test('sign-in: pending, then signed in', async () => {
  await fromPage('signin');
  const states = sent('page', 'auth').slice(-2).map((o) => o[2]);
  assert.deepEqual(states, ['pending', 'signedin']);
  assert.deepEqual(sent('status').at(-1), ['status', 'Signed in to Google']);
});

test('a token without the doc list permission asks to sign in again', async () => {
  fakeGoogle.missing = ['drive.metadata.readonly'];
  await fromPage('ready', 'ua', 1, 1);
  assert.deepEqual(sent('page', 'auth').at(-1), ['page', 'auth', 'upgrade']);
  fakeGoogle.missing = [];
});

test('doc list and search; the log has no doc names', async () => {
  fakeGoogle.docs.d1 = { title: 'Secret Song', text: 'x\n' };
  fakeGoogle.docs.d2 = { title: 'Notes', text: 'y\n' };
  await fromPage('find', '');
  assert.deepEqual(lastPacket('docs').files.map((f) => f.id), ['d1', 'd2']);
  await fromPage('find', 'Song');
  assert.deepEqual(lastPacket('docs'), { query: 'Song', files: [{ id: 'd1', name: 'Secret Song', modifiedTime: '2026-10-27T19:00:00Z' }] });
  assert.ok(!(await logText()).includes('Secret'), 'no doc names in the log');
});

test('open: a long doc with any characters arrives whole', async () => {
  const text = 'Verse 1 — "quotes", commas, ; semicolons {braces} 100% 007\u000b\n'.repeat(400);
  const blocks = [{ type: 'p', style: 'NORMAL_TEXT', list: 'none', level: 0, runs: [{ text: text.slice(0, -1), f: 1 }] }];
  fakeGoogle.docs.d3 = { title: 'Song – Lyrics', text, blocks, editable: true };
  await fromPage('open', 'd3');
  assert.ok(sent('page', 'pkt_chunk').length > 2, 'the doc is split into chunks');
  assert.deepEqual(lastPacket('doc'), { id: 'd3', title: 'Song – Lyrics', editable: true, blocks });
  const log = await logText();
  assert.match(log, new RegExp(`doc read d3 ${text.length} chars`));
  assert.ok(!log.includes('Verse 1'), 'the log never holds doc text');
});

test('save: long blocks from the page go to Google whole', async () => {
  const blocks = [{ type: 'p', style: 'HEADING_1', list: 'bullet', level: 0, runs: [{ text: 'New chorus — ünïcödé 😀 '.repeat(500), f: 3 }] }];
  await pagePacket('save', { blocks });
  assert.deepEqual(fakeGoogle.saves.at(-1).blocks, blocks);
  assert.deepEqual(lastPacket('saved'), { ok: true });
  assert.match(await logText(), /doc saved d3 \d+ chars/);
});

test('create: makes the doc and opens it', async () => {
  await fromPage('create', 'New Song');
  assert.equal(fakeGoogle.docs.created.title, 'New Song');
  assert.equal(lastPacket('doc').id, 'created');
  assert.match(await logText(), /doc created created/);
});

const para = (text, f = 0) => ({ type: 'p', style: 'NORMAL_TEXT', list: 'none', level: 0, runs: [{ text, f }] });
const waitFor = async (check) => {
  for (let i = 0; i < 100 && !check(); i++) await new Promise((r) => setTimeout(r, 10));
  assert.ok(check(), 'condition not reached');
};

test('change check: a new version is offered to the page; "synced" makes it the base', async () => {
  const blocks = [para('Verse')];
  fakeGoogle.docs.d4 = { title: 'Live', text: 'Verse\n', blocks, editable: true, revisionId: 'r1' };
  await fromPage('open', 'd4');
  const offersBefore = sent('page', 'pkt_begin', 'update').length;
  // Someone adds a line in Google Docs.
  const theirs = [para('Verse'), para('their line')];
  fakeGoogle.docs.d4 = { ...fakeGoogle.docs.d4, text: 'Verse\ntheir line\n', blocks: theirs, revisionId: 'r2' };
  fakeGoogle.versions.d4 = 2;
  await waitFor(() => sent('page', 'pkt_begin', 'update').length > offersBefore);
  const update = lastPacket('update');
  assert.deepEqual(update.blocks, theirs);
  assert.match(await logText(), /doc changed in Google Docs d4/);

  await fromPage('synced', update.id);
  await pagePacket('save', { blocks: [para('Verse'), para('their line'), para('mine')] });
  assert.deepEqual(fakeGoogle.saves.at(-1).base.blocks, theirs, 'the save starts from the update the page took');
});

test('save: a merged result is offered to the page', async () => {
  fakeGoogle.docs.d4.remote = para('from a buddy');
  const before = sent('page', 'pkt_begin', 'update').length;
  await pagePacket('save', { blocks: [para('Verse'), para('their line'), para('mine 2')] });
  assert.deepEqual(lastPacket('saved'), { ok: true });
  assert.equal(sent('page', 'pkt_begin', 'update').length, before + 1);
  assert.deepEqual(lastPacket('update').blocks.at(-1), para('from a buddy'));
  delete fakeGoogle.docs.d4.remote;
});

test('save: a conflict is reported, not overwritten', async () => {
  await pagePacket('save', { blocks: [{ type: 'p', style: 'NORMAL_TEXT', list: 'none', level: 0, runs: [{ text: 'CONFLICT', f: 0 }] }] });
  assert.deepEqual(lastPacket('saved'), { ok: false, conflict: true, message: 'Someone else changed the same lines.' });
});

test('refresh reads the current doc again', async () => {
  const before = sent('page', 'pkt_begin', 'doc').length;
  await fromPage('refresh');
  assert.equal(sent('page', 'pkt_begin', 'doc').length, before + 1);
});

test('a failed read goes to the page as an error', async () => {
  await fromPage('open', 'missing');
  assert.deepEqual(sent('page', 'error').at(-1), ['page', 'error', 'Doc not found']);
});

test('sign-out', async () => {
  await fromPage('signout');
  assert.deepEqual(sent('page', 'auth').at(-1), ['page', 'auth', 'signedout']);
});

test('jweb load events are logged, not answered', async () => {
  const before = fakeMax.outlets.length;
  await fromPage('onloadend', 200);
  assert.equal(fakeMax.outlets.length, before);
  assert.match(await logText(), /jweb onloadend 200/);
});

// Max gives some selectors a meaning of its own: `prepend fromPage` turned
// the page's "list" message into "fromPage" with an empty first word, so the
// doc list never loaded in Live (27.10.2026). The fake max-api above cannot
// see that, so this checks the page's message names directly.
test('page message names: no Max selector, and main.js handles each', async () => {
  const pageHtml = await readFile(path.join(root, 'ui', 'index.html'), 'utf8');
  const mainJs = await readFile(path.join(root, 'node', 'main.js'), 'utf8');
  const names = new Set([...pageHtml.matchAll(/max\.outlet\('([^']+)'/g)].map((m) => m[1]));
  const handled = new Set([...mainJs.matchAll(/case '([^']+)':/g)].map((m) => m[1]));
  assert.ok(names.size >= 8, `found ${names.size} names`);
  for (const name of names) {
    assert.ok(!['list', 'int', 'float', 'bang', 'symbol'].includes(name), `"${name}" is a Max selector`);
    assert.ok(handled.has(name), `main.js does not handle "${name}"`);
  }
});

test('start: node says "ready" (the patch then sends the stored doc) and asks Live once', () => {
  assert.equal(sent('ready').length, 1);
  assert.ok(sent('live', 'stamp').length >= 1);
});

// Answers node's next question to max/live.js while `action` waits for it.
async function withLive(answer, action) {
  const before = sent('live').length;
  const running = action();
  await waitFor(() => sent('live').length > before);
  fakeMax.handlers.fromLive(...answer);
  await running;
}

test('stamp: the locator before the playhead and the bar go to the page', async () => {
  await withLive(['stamp', 33, 'Chorus', '2'], () => fromPage('stamp'));
  assert.deepEqual(lastPacket('stamp'), { text: '[Chorus 2 · bar 33] ' });
  await withLive(['stamp', 1, ''], () => fromPage('stamp'));
  assert.deepEqual(lastPacket('stamp'), { text: '[bar 1] ' });
  await withLive(['stamp_error', 'Live is not ready'], () => fromPage('stamp'));
  assert.deepEqual(sent('page', 'error').at(-1), ['page', 'error', 'Live is not ready']);
});

test('stored doc: opened when the set loads; a newly opened doc is stored', async () => {
  fakeGoogle.signed = true;
  fakeGoogle.docs.d5 = { title: 'Set doc', text: 'x\n', blocks: [para('x')], editable: true };
  const stored = encodeURIComponent(JSON.stringify({ v: 1, doc: 'd5' }));
  const linksBefore = sent('setdoc').length;
  await fakeMax.handlers.storeddoc(stored);
  await waitFor(() => sent('page', 'pkt_begin', 'doc').length > 0 && lastPacket('doc').id === 'd5');
  assert.match(await logText(), /doc stored in the set d5/);
  assert.equal(sent('setdoc').length, linksBefore, 'opening the stored doc does not change the set');

  fakeGoogle.docs.d6 = { title: 'Other', text: 'y\n', blocks: [para('y')], editable: true };
  await fromPage('open', 'd6');
  assert.deepEqual(sent('setdoc').at(-1), ['setdoc', encodeURIComponent(JSON.stringify({ v: 1, doc: 'd6' }))]);
  // The patch echoes the stored value back; that opens nothing.
  const reads = sent('page', 'pkt_begin', 'doc').length;
  await fakeMax.handlers.storeddoc(sent('setdoc').at(-1)[1]);
  assert.equal(sent('page', 'pkt_begin', 'doc').length, reads);
});
