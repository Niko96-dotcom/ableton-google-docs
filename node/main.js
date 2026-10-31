// node.script entry point. node.script only starts .js files, and max-api
// can only be required, so this file is CommonJS.
//
// Loads the editor page into the jweb, signs in to Google, lists, reads and
// saves docs for it. Every step goes to the log, so a run can be checked from
// the log alone. The log never holds tokens, doc names or doc text.
const maxApi = require('max-api');
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createGoogle, blocksText } = require('./google.js');
const { findUserLibrary } = require('./library.js');
const pageHtml = require('./page.js');

// Settings and logs live in <User Library>/Google Docs (see library.js).
const dataDir = path.join(findUserLibrary(), 'Google Docs');
const logFile = path.join(dataDir, 'logs', 'device.log');

function readSettings() {
  try {
    return JSON.parse(fs.readFileSync(path.join(dataDir, 'settings.json'), 'utf8'));
  } catch {
    return {};
  }
}

function log(...parts) {
  try {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    fs.appendFileSync(logFile, `${new Date().toISOString()} [${process.pid}] ${parts.join(' ')}\n`);
  } catch {
    // A log that cannot be written must not stop the device.
  }
}

const page = (...args) => maxApi.outlet('page', ...args);
const status = (text) => maxApi.outlet('status', text);

// Packets carry JSON both ways. Max turns a symbol that looks like a number
// into a number, and doc text can be long. So a packet is URI-encoded JSON in
// chunks that start with a letter: pkt_begin <kind>, pkt_chunk c…, pkt_end.
const CHUNK = 4000;
async function send(kind, data) {
  const encoded = encodeURIComponent(JSON.stringify(data));
  await page('pkt_begin', kind);
  for (let i = 0; i < encoded.length; i += CHUNK) await page('pkt_chunk', `c${encoded.slice(i, i + CHUNK)}`);
  await page('pkt_end');
}
let incoming = null;

const docForPage = (doc) => ({ id: doc.id, title: doc.title, editable: doc.editable, blocks: doc.blocks });

const google = createGoogle({ openUrl: (url) => execFile('open', [url]) });
let signingIn = false;

// The open doc. latest: the newest doc read from Google. base: the text and
// blocks the page shows as saved; a save sends what changed since base.
// They differ while the page has not taken an update yet. offers: the
// updates sent to the page, by id, until it answers "synced <id>".
let open = null;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// The doc stored in the Live set (a hidden parameter, see build-device.mjs):
// the last doc opened in this set, opened again when the set loads.
let storedDoc = null;
const encodeStored = (id) => encodeURIComponent(JSON.stringify({ v: 1, doc: id }));
function decodeStored(value) {
  try {
    return JSON.parse(decodeURIComponent(String(value))).doc ?? null;
  } catch {
    return null;
  }
}

// Questions to max/live.js, one at a time: "stamp" gives the bar at the
// playhead and the last locator before it.
let liveWaiting = null;
function askLive(question) {
  return new Promise((resolve, reject) => {
    const waiter = (answer) => {
      clearTimeout(timer);
      resolve(answer);
    };
    const timer = setTimeout(() => {
      if (liveWaiting === waiter) liveWaiting = null;
      reject(new Error('Live did not answer'));
    }, 3000);
    timer.unref();
    liveWaiting = waiter;
    maxApi.outlet('live', question);
  });
}
async function stampText() {
  const [kind, bar, ...name] = await askLive('stamp');
  if (kind !== 'stamp') throw new Error([bar, ...name].join(' ') || 'Live did not answer');
  const locator = name.join(' ').trim();
  return locator ? `[${locator} · bar ${bar}] ` : `[bar ${bar}] `;
}

// Opening, saving and the change check run one at a time.
let queue = Promise.resolve();
const exclusive = (fn) => (queue = queue.then(fn, fn));

function authState() {
  if (signingIn) return 'pending';
  if (!google.signedIn()) return 'signedout';
  return google.missingScopes().length ? 'upgrade' : 'signedin';
}

async function sendAuth() {
  const state = authState();
  await page('auth', state);
  const text = { signedin: 'Signed in to Google', signedout: 'Not signed in', upgrade: 'Sign in again for the doc list' }[state];
  if (text) status(text);
}

async function fail(action, error) {
  log(action, 'failed:', error.message);
  await page('error', error.message);
}

async function signIn() {
  if (signingIn) return;
  signingIn = true;
  log('sign-in started');
  status('Sign in in your browser');
  await sendAuth();
  try {
    await google.signIn();
    log('sign-in ok');
  } catch (error) {
    await fail('sign-in', error);
  } finally {
    signingIn = false;
  }
  await sendAuth();
  if (storedDoc && !open && google.signedIn()) await exclusive(() => openDoc(storedDoc));
}

async function list(query) {
  try {
    const files = await google.listDocs(query);
    log('doc list', `${files.length} docs`, query ? '(search)' : '');
    await send('docs', { query, files });
  } catch (error) {
    await fail('doc list', error);
  }
}

async function openDoc(link) {
  await page('busy', 'Loading doc…');
  try {
    const doc = await google.readDoc(link);
    const version = await google.version(doc.id).catch(() => null);
    open = { latest: doc, base: { text: doc.text, blocks: doc.blocks }, version, offers: new Map(), nextOffer: 1 };
    log('doc read', doc.id, `${doc.text.length} chars`);
    await send('doc', docForPage(doc));
    status(doc.title || 'Untitled doc');
    if (storedDoc !== doc.id) {
      storedDoc = doc.id;
      maxApi.outlet('setdoc', encodeStored(doc.id));
      log('doc linked to the set', doc.id);
    }
  } catch (error) {
    await fail('doc read', error);
  }
}

// Sends the newest doc to the page when it differs from what the page shows.
async function offer() {
  if (!open || same(open.latest.blocks, open.base.blocks)) return;
  const id = open.nextOffer++;
  open.offers.set(id, { text: open.latest.text, blocks: open.latest.blocks });
  for (const old of open.offers.keys()) if (old < id - 5) open.offers.delete(old);
  log('doc update offered', id);
  await send('update', { id, editable: open.latest.editable, blocks: open.latest.blocks });
}

// The change check: Drive's version number is cheap to read. Only when it
// changed is the doc read again.
let checkFailing = false;
async function check() {
  const doc = open;
  if (!doc || signingIn || !google.signedIn()) return;
  try {
    const version = await google.version(doc.latest.id);
    if (version === doc.version || open !== doc) return;
    doc.version = version;
    const latest = await google.readDoc(doc.latest.id);
    checkFailing = false;
    if (open !== doc || (latest.revisionId === doc.latest.revisionId && same(latest.blocks, doc.latest.blocks))) return;
    doc.latest = latest;
    log('doc changed in Google Docs', latest.id);
    await offer();
  } catch (error) {
    if (!checkFailing) log('change check failed:', error.message);
    checkFailing = true;
  }
}

async function create(title) {
  await page('busy', 'Creating doc…');
  try {
    const id = await google.createDoc(title);
    log('doc created', id);
    await openDoc(id);
  } catch (error) {
    await fail('doc create', error);
  }
}

async function save(blocks) {
  if (!open) {
    await send('saved', { ok: false, message: 'No doc is open' });
    return;
  }
  try {
    open.latest = await google.saveDoc(open.latest, open.base, blocks);
    open.base = { text: blocksText(blocks), blocks };
    // The newest doc now holds the page's changes; older offers are stale.
    open.offers.clear();
    log('doc saved', open.latest.id, `${open.latest.text.length} chars`);
    await send('saved', { ok: true });
    await offer();
  } catch (error) {
    log('doc save failed:', error.message);
    await send('saved', { ok: false, conflict: error.code === 'conflict', message: error.message });
  }
}

async function packet(kind, data) {
  if (kind === 'save') await exclusive(() => save(data.blocks ?? []));
  else log('unknown packet', kind);
}

// jweb sends its own load messages out of the same outlet as the page.
const JWEB_EVENTS = new Set(['onloadstart', 'onloadend', 'url', 'title']);

maxApi.addHandler('fromPage', async (kind, ...args) => {
  if (JWEB_EVENTS.has(kind)) {
    log('jweb', kind, ...args);
    return;
  }
  switch (kind) {
    case 'ready': {
      const [userAgent, width, height] = args;
      log('page ready', `${width}x${height}`, userAgent);
      await page('hello', process.version);
      await sendAuth();
      // A new page shows the newest doc.
      if (open) {
        open.base = { text: open.latest.text, blocks: open.latest.blocks };
        await send('doc', docForPage(open.latest));
      }
      break;
    }
    case 'ack':
      log('round trip ok');
      break;
    case 'signin':
      await signIn();
      break;
    case 'signout':
      await google.signOut();
      open = null;
      log('signed out');
      await sendAuth();
      break;
    case 'find':
      await list(args.join(' '));
      break;
    case 'open':
      await exclusive(() => openDoc(args.join(' ')));
      break;
    case 'create':
      await exclusive(() => create(args.join(' ').trim()));
      break;
    case 'refresh':
      if (open) await exclusive(() => openDoc(open.latest.id));
      break;
    case 'stamp':
      try {
        const text = await stampText();
        log('stamp', text.trim());
        await send('stamp', { text });
      } catch (error) {
        await fail('stamp', error);
      }
      break;
    case 'synced': {
      const snapshot = open?.offers.get(Number(args[0]));
      if (snapshot) {
        open.base = snapshot;
        log('doc update applied', args[0]);
      }
      break;
    }
    case 'pkt_begin':
      incoming = { kind: String(args[0]), parts: [] };
      break;
    case 'pkt_chunk':
      incoming?.parts.push(String(args[0]).slice(1));
      break;
    case 'pkt_end': {
      const done = incoming;
      incoming = null;
      if (done) await packet(done.kind, JSON.parse(decodeURIComponent(done.parts.join(''))));
      break;
    }
    default:
      log('unknown page message', kind);
  }
});

maxApi.addHandler('opened', () => log('editor window opened'));

maxApi.addHandler('fromLive', (...answer) => {
  const waiting = liveWaiting;
  liveWaiting = null;
  waiting?.(answer);
});

// The patch sends the stored value once node says "ready", and again after
// every "setdoc".
maxApi.addHandler('storeddoc', async (...value) => {
  const id = value.length ? decodeStored(value.join(' ')) : null;
  if (!id || id === storedDoc) return;
  storedDoc = id;
  log('doc stored in the set', id);
  if (google.signedIn() && open?.latest.id !== id) await exclusive(() => openDoc(id));
});

const settings = readSettings();
// settings.checkSeconds: how often to look for other people's changes.
let checking = false;
setInterval(() => {
  if (checking) return;
  checking = true;
  exclusive(check).finally(() => {
    checking = false;
  });
}, (settings.checkSeconds ?? 3) * 1000).unref();
log('node started', process.version, 'from', __dirname, 'settings', JSON.stringify(settings));
// jweb loads the page from a file: a temporary copy of the page's text.
status('Loading editor…');
const pageFile = path.join(os.tmpdir(), 'ableton-google-docs', 'editor.html');
fs.mkdirSync(path.dirname(pageFile), { recursive: true });
fs.writeFileSync(pageFile, pageHtml());
page('read', pathToFileURL(pageFile).href);
maxApi.outlet('ready');
stampText().then(
  (text) => log('live ok', text.trim()),
  (error) => log('live failed:', error.message),
);
if (settings.openOnLoad) maxApi.outlet('window', 'open');
