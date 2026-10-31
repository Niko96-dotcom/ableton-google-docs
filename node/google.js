// Google sign-in, the doc list, and reading and editing docs, without npm
// packages (node.script runs Max's own Node, and the release is one bundled
// file).
//
// Sign-in is OAuth for desktop apps: the system browser opens Google's consent
// page and redirects to a one-shot server on 127.0.0.1 (PKCE and a state
// check). The tokens stay in SECRETS_DIR (0700/0600), outside the User
// Library and outside git. The OAuth client is SECRETS_DIR/client.json, else
// the one built into the release (node/client.js).
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const BUILT_IN_CLIENT = require('./client.js');

const SECRETS_DIR = path.join(os.homedir(), 'Library', 'Application Support', 'ableton-google-docs');
const SCOPES = [
  'https://www.googleapis.com/auth/documents',
  'https://www.googleapis.com/auth/drive.file',
  // Names and dates of Drive files, for the doc list. Not their content.
  'https://www.googleapis.com/auth/drive.metadata.readonly',
];
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const DOCS_URL = 'https://docs.googleapis.com/v1/documents/';
const FILES_URL = 'https://www.googleapis.com/drive/v3/files';
const SIGN_IN_TIMEOUT_MS = 5 * 60 * 1000;
// Refresh this long before Google's expiry, so a request never races it.
const EXPIRY_MARGIN_MS = 60 * 1000;

class GoogleError extends Error {
  constructor(message, { status, code } = {}) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const base64url = (buffer) => buffer.toString('base64url');

// Accepts a docs.google.com link (also /u/1/ links) or a bare document id.
function docIdFromLink(text) {
  const s = String(text).trim();
  const fromUrl = s.match(/docs\.google\.com\/document\/(?:u\/\d+\/)?d\/([A-Za-z0-9_-]{20,})/);
  if (fromUrl) return fromUrl[1];
  if (/^[A-Za-z0-9_-]{25,}$/.test(s)) return s;
  return null;
}

// Text styles the editor shows and changes, as bit flags per character.
const TEXT_STYLES = [
  ['bold', 1],
  ['italic', 2],
  ['underline', 4],
  ['strikethrough', 8],
];
const flagsOf = (style = {}) => TEXT_STYLES.reduce((flags, [name, bit]) => (style[name] ? flags | bit : flags), 0);
const ORDERED_GLYPHS = new Set(['DECIMAL', 'ZERO_DECIMAL', 'ALPHA', 'UPPER_ALPHA', 'ROMAN', 'UPPER_ROMAN']);

// Read-only text: tables (cells by tab, rows by line) and tables of contents.
function plainText(content = []) {
  let text = '';
  for (const el of content) {
    if (el.paragraph) text += (el.paragraph.elements ?? []).map((e) => e.textRun?.content ?? '').join('');
    else if (el.table) text += tableText(el.table);
    else if (el.tableOfContents) text += plainText(el.tableOfContents.content);
  }
  return text;
}
const tableText = (table) =>
  (table.tableRows ?? []).map((row) => (row.tableCells ?? []).map((cell) => plainText(cell.content).replace(/\n$/, '')).join('\t') + '\n').join('');

// A Docs API document as the editor needs it:
// - text: plain text; pos: the doc index of each character (-1 where it
//   cannot be edited); tab, flags: its tab and text style;
// - paragraphs: the editable paragraphs with their doc range and style;
// - blocks: what the page shows, one per paragraph ({ type: 'p', style,
//   list, level, runs }) and one per stretch of read-only text ({ type:
//   'ro', text }). Joined (see blocksText), the blocks give text again.
// Tables, tables of contents, tab titles and the lines between tabs are
// read-only. With several tabs, each tab starts with its title.
function docModel(doc) {
  const model = { text: '', pos: [], tab: [], flags: [], tabIds: [], segmentEnds: new Set(), paragraphs: [], blocks: [] };
  const push = (s, start, tab, flags = 0) => {
    for (let i = 0; i < s.length; i++) {
      model.pos.push(start === null ? -1 : start + i);
      model.tab.push(tab);
      model.flags.push(flags);
    }
    model.text += s;
  };
  const pushReadOnly = (s, tab) => {
    push(s, null, tab);
    const last = model.blocks.at(-1);
    if (last?.type === 'ro') last.text += s;
    else model.blocks.push({ type: 'ro', text: s });
  };
  const paragraph = (el, tab, lists) => {
    const start = model.text.length;
    const runs = [];
    for (const e of el.paragraph.elements ?? []) {
      if (!e.textRun) continue;
      const flags = flagsOf(e.textRun.textStyle);
      push(e.textRun.content, e.startIndex, tab, flags);
      const last = runs.at(-1);
      if (last?.f === flags) last.text += e.textRun.content;
      else runs.push({ text: e.textRun.content, f: flags });
    }
    // The block shows the paragraph without its final line break.
    const last = runs.at(-1);
    if (last?.text.endsWith('\n')) {
      last.text = last.text.slice(0, -1);
      if (!last.text) runs.pop();
    }
    const style = el.paragraph.paragraphStyle?.namedStyleType ?? 'NORMAL_TEXT';
    const bullet = el.paragraph.bullet;
    const level = bullet?.nestingLevel ?? 0;
    const glyph = bullet && lists?.[bullet.listId]?.listProperties?.nestingLevels?.[level]?.glyphType;
    const list = !bullet ? 'none' : ORDERED_GLYPHS.has(glyph) ? 'number' : 'bullet';
    model.paragraphs.push({ start, end: model.text.length, startIndex: el.startIndex, endIndex: el.endIndex, tab, style, list });
    model.blocks.push({ type: 'p', style, list, level, runs });
  };
  // The last line break of a tab (a "segment") cannot be deleted.
  const body = (bodyContent = [], tab, lists) => {
    for (const el of bodyContent) {
      if (el.paragraph) paragraph(el, tab, lists);
      else if (el.table) pushReadOnly(tableText(el.table), tab);
      else if (el.tableOfContents) pushReadOnly(plainText(el.tableOfContents.content), tab);
    }
    if (model.pos.at(-1) >= 0) model.segmentEnds.add(model.text.length - 1);
  };

  const tabs = [];
  const walk = (list = []) => {
    for (const t of list) {
      tabs.push(t);
      walk(t.childTabs);
    }
  };
  walk(doc.tabs);
  if (tabs.length === 0) {
    model.tabIds.push(undefined);
    body(doc.body?.content, 0, doc.lists);
  }
  tabs.forEach((t, n) => {
    model.tabIds.push(t.tabProperties?.tabId);
    if (tabs.length > 1) pushReadOnly(`${n > 0 ? '\n' : ''}=== ${t.tabProperties?.title ?? 'Tab'} ===\n`, n);
    body(t.documentTab?.body?.content, n, t.documentTab?.lists);
  });
  return model;
}

// The plain text of blocks from docModel or from the page.
const blocksText = (blocks) => blocks.map((b) => (b.type === 'p' ? `${b.runs.map((r) => r.text).join('')}\n` : b.text)).join('');

const docText = (doc) => docModel(doc).text;

const isHigh = (c) => c >= 0xd800 && c <= 0xdbff;
const isLow = (c) => c >= 0xdc00 && c <= 0xdfff;

// The one changed range between two texts: common start and end cut off.
// Never splits an emoji or other surrogate pair (Docs indexes UTF-16).
function diffRange(before, after) {
  let start = 0;
  const max = Math.min(before.length, after.length);
  while (start < max && before[start] === after[start]) start++;
  let endBefore = before.length;
  let endAfter = after.length;
  while (endBefore > start && endAfter > start && before[endBefore - 1] === after[endAfter - 1]) {
    endBefore--;
    endAfter--;
  }
  if (start > 0 && isHigh(before.charCodeAt(start - 1))) start--;
  if (endBefore < before.length && isLow(before.charCodeAt(endBefore))) {
    endBefore++;
    endAfter++;
  }
  return { start, end: endBefore, text: after.slice(start, endAfter) };
}

// Two changes Google refuses, moved to an equal change that it accepts:
// - deleting the last line ("a\nlast\n" to "a\n") gives the range "last\n",
//   which ends with the line break Google never deletes; "\nlast" instead;
// - adding a line at the end, or before a table ("a\n" to "a\nb\n"), inserts
//   after that line break, where no text can go; "\nb" before it instead.
// The change slides one character left while the result stays the same.
function fitToDoc(model, change) {
  let { start, end, text } = change;
  const refused = () =>
    text
      ? start === end && (start >= model.pos.length || model.pos[start] < 0) && text.at(-1) === model.text[start - 1]
      : end > start && model.segmentEnds.has(end - 1) && model.text[start - 1] === model.text[end - 1];
  while (start > 0 && refused()) {
    if (text) text = model.text[start - 1] + text.slice(0, -1);
    start--;
    end--;
  }
  return { start, end, text };
}

// Docs API requests for one changed range of a docModel. The new text takes
// the style of the text before it, like typing in Google Docs.
function editRequests(model, { start, end, text }) {
  const readOnly = new GoogleError('Tables and tab titles cannot be edited here. Edit them in Google Docs.', { code: 'read_only' });
  if (start >= model.pos.length || model.pos[start] < 0) throw readOnly;
  const tab = model.tab[start];
  const tabId = model.tabIds[tab];
  const withTab = (o) => (tabId ? { ...o, tabId } : o);
  const requests = [];
  if (end > start) {
    for (let i = start; i < end; i++) if (model.pos[i] < 0 || model.tab[i] !== tab) throw readOnly;
    if (model.segmentEnds.has(end - 1)) throw new GoogleError('The last line break of a tab cannot be removed.', { code: 'read_only' });
    requests.push({ deleteContentRange: { range: withTab({ startIndex: model.pos[start], endIndex: model.pos[end - 1] + 1 }) } });
  }
  if (text) requests.push({ insertText: { location: withTab({ index: model.pos[start] }), text } });
  return requests;
}

// ---- merging with other people's changes, line by line

const linesOf = (text) => text.split('\n').slice(0, -1);
const plain = (text) => text.replace(/\u00a0/g, ' ');

// For each line of a, the index of the same line in b, or -1 where the line
// was changed, added or removed. Common lines at the start and the end match
// first; the rest by longest common subsequence.
function alignLines(a, b) {
  const map = new Array(a.length).fill(-1);
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) map[pre] = pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) {
    map[a.length - 1 - suf] = b.length - 1 - suf;
    suf++;
  }
  const A = a.slice(pre, a.length - suf);
  const B = b.slice(pre, b.length - suf);
  if (!A.length || !B.length || A.length * B.length > 4e6) return map;
  const lcs = Array.from({ length: A.length + 1 }, () => new Uint32Array(B.length + 1));
  for (let i = A.length - 1; i >= 0; i--) {
    for (let j = B.length - 1; j >= 0; j--) lcs[i][j] = A[i] === B[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  }
  for (let i = 0, j = 0; i < A.length && j < B.length; ) {
    if (A[i] === B[j]) map[pre + i++] = pre + j++;
    else if (lcs[i + 1][j] >= lcs[i][j + 1]) i++;
    else j++;
  }
  return map;
}

// A change made on baseText, moved to its place in docText, which may hold
// other people's changes. null when they changed the same lines.
function moveChange(change, baseText, docText) {
  if (baseText === docText) return change;
  const a = linesOf(baseText);
  const b = linesOf(docText);
  const map = alignLines(a, b);
  // The line after the last one stands for the end of the text.
  const mapped = (i) => (i === a.length ? b.length : map[i]);
  const lineOf = (text, p) => text.slice(0, p).split('\n').length - 1;
  const lineStart = (lines, i) => lines.slice(0, i).reduce((n, line) => n + line.length + 1, 0);
  const first = lineOf(baseText, change.start);
  const last = change.end > change.start ? lineOf(baseText, change.end - 1) : first;
  for (let i = first; i <= last; i++) if (mapped(i) < 0 || mapped(i) !== mapped(first) + (i - first)) return null;
  const start = lineStart(b, mapped(first)) + (change.start - lineStart(a, first));
  return { start, end: start + (change.end - change.start), text: change.text };
}

// Lines with the paragraph they belong to (null for read-only lines) and the
// text style of each character, from blocks or from a docModel.
function blockLines(blocks) {
  const lines = [];
  for (const b of blocks) {
    if (b.type === 'p') {
      lines.push({ text: plain(b.runs.map((r) => r.text).join('')), para: b, flags: b.runs.flatMap((r) => new Array(r.text.length).fill(r.f)) });
    } else {
      for (const text of linesOf(b.text)) lines.push({ text: plain(text), para: null });
    }
  }
  return lines;
}
function modelLines(model) {
  const byStart = new Map(model.paragraphs.map((p) => [p.start, p]));
  const lines = [];
  let start = 0;
  for (const text of linesOf(model.text)) {
    const para = byStart.get(start) ?? null;
    lines.push({ text: plain(text), para, flags: para ? model.flags.slice(start, start + text.length) : null });
    start += text.length + 1;
  }
  return lines;
}

// Docs API requests for the formatting changes made on the page: what
// differs between the page's blocks and the base blocks it started from,
// where the doc does not have it yet. Formatting that other people changed
// in the doc meanwhile stays. Lines that differ in text between page and
// doc are left alone.
function styleRequests(model, baseBlocks, pageBlocks) {
  const page = blockLines(pageBlocks);
  const base = blockLines(baseBlocks);
  const doc = modelLines(model);
  const toBase = alignLines(page.map((l) => l.text), base.map((l) => l.text));
  const toDoc = alignLines(page.map((l) => l.text), doc.map((l) => l.text));
  const withTab = (tab, o) => (model.tabIds[tab] ? { ...o, tabId: model.tabIds[tab] } : o);

  const requests = [];
  const deletes = [];
  const creates = [];
  page.forEach((line, j) => {
    const have = toDoc[j] >= 0 ? doc[toDoc[j]] : null;
    if (!line.para || !have?.para) return;
    const was = toBase[j] >= 0 && base[toBase[j]].para ? base[toBase[j]] : null;
    const at = have.para.start;
    for (const [name, bit] of TEXT_STYLES) {
      const wanted = (k) => (!was || (line.flags[k] ^ was.flags[k]) & bit) && (line.flags[k] ^ have.flags[k]) & bit;
      for (let k = 0; k < line.text.length; ) {
        if (!wanted(k)) {
          k++;
          continue;
        }
        const value = Boolean(line.flags[k] & bit);
        let e = k + 1;
        while (e < line.text.length && wanted(e) && Boolean(line.flags[e] & bit) === value) e++;
        const range = withTab(have.para.tab, { startIndex: model.pos[at + k], endIndex: model.pos[at + e - 1] + 1 });
        requests.push({ updateTextStyle: { range, textStyle: { [name]: value }, fields: name } });
        k = e;
      }
    }
    const want = line.para;
    const range = withTab(have.para.tab, { startIndex: have.para.startIndex, endIndex: have.para.endIndex });
    if ((!was || was.para.style !== want.style) && want.style !== have.para.style) {
      requests.push({ updateParagraphStyle: { range, paragraphStyle: { namedStyleType: want.style }, fields: 'namedStyleType' } });
    }
    if ((was && was.para.list === want.list) || want.list === have.para.list) return;
    if (have.para.list !== 'none') deletes.push({ deleteParagraphBullets: { range } });
    if (want.list === 'none') return;
    // Neighbours that get the same kind of list become one list.
    const last = creates.at(-1);
    if (last?.list === want.list && last.tab === have.para.tab && last.endIndex === have.para.startIndex) last.endIndex = have.para.endIndex;
    else creates.push({ list: want.list, tab: have.para.tab, startIndex: have.para.startIndex, endIndex: have.para.endIndex });
  });
  // Creating bullets removes leading tabs, which moves the indexes after
  // them, so the last list comes first.
  creates.sort((a, b) => b.startIndex - a.startIndex);
  const bullets = creates.map((c) => ({
    createParagraphBullets: {
      range: withTab(c.tab, { startIndex: c.startIndex, endIndex: c.endIndex }),
      bulletPreset: c.list === 'number' ? 'NUMBERED_DECIMAL_ALPHA_ROMAN' : 'BULLET_DISC_CIRCLE_SQUARE',
    },
  }));
  return [...requests, ...deletes, ...bullets];
}

function createGoogle({ dir = SECRETS_DIR, builtInClient = BUILT_IN_CLIENT, fetch: fetchFn = globalThis.fetch, openUrl, now = Date.now } = {}) {
  const tokenFile = path.join(dir, 'token.json');
  const clientFile = path.join(dir, 'client.json');

  function client() {
    if (builtInClient && !fs.existsSync(clientFile)) return builtInClient;
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(clientFile, 'utf8'));
    } catch {
      throw new GoogleError(`Google client missing: ${clientFile}`);
    }
    const { client_id: id, client_secret: secret } = raw.installed ?? raw;
    if (!id || !secret) throw new GoogleError(`Google client incomplete: ${clientFile}`);
    return { id, secret };
  }

  function readToken() {
    try {
      return JSON.parse(fs.readFileSync(tokenFile, 'utf8'));
    } catch {
      return null;
    }
  }

  function writeToken(token) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(tokenFile, JSON.stringify(token, null, 2) + '\n', { mode: 0o600 });
  }

  async function tokenRequest(params) {
    const response = await fetchFn(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params).toString(),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new GoogleError(`Google token request failed: ${body.error ?? response.status}`, { code: body.error });
    return body;
  }

  function saveGrant(grant, previous = {}) {
    const token = {
      refresh_token: grant.refresh_token ?? previous.refresh_token,
      access_token: grant.access_token,
      expires_at: now() + grant.expires_in * 1000,
      scope: grant.scope ?? previous.scope,
    };
    writeToken(token);
    return token;
  }

  async function accessToken({ forceRefresh = false } = {}) {
    const token = readToken();
    if (!token?.refresh_token) throw new GoogleError('Not signed in');
    if (!forceRefresh && token.access_token && token.expires_at - EXPIRY_MARGIN_MS > now()) return token.access_token;
    const { id, secret } = client();
    try {
      const grant = await tokenRequest({ grant_type: 'refresh_token', refresh_token: token.refresh_token, client_id: id, client_secret: secret });
      return saveGrant(grant, token).access_token;
    } catch (error) {
      // A revoked or expired refresh token never works again.
      if (error.code === 'invalid_grant') {
        fs.rmSync(tokenFile, { force: true });
        throw new GoogleError('Google sign-in expired. Sign in again.');
      }
      throw error;
    }
  }

  // A Google API call with the saved token. After a 401 the token is
  // refreshed once and the call repeated.
  async function api(url, { method = 'GET', body } = {}) {
    const call = async (token) =>
      fetchFn(url, {
        method,
        headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
    let response = await call(await accessToken());
    if (response.status === 401) response = await call(await accessToken({ forceRefresh: true }));
    const result = await response.json().catch(() => ({}));
    if (response.ok) return result;
    const message = result.error?.message ?? '';
    const reason = {
      401: 'Google rejected the sign-in',
      403: /insufficient.*scope/i.test(message) ? 'Sign in again to allow the new permission' : 'The signed-in account has no access to this doc',
      404: 'Doc not found',
    }[response.status];
    // Docs refuses a write with requiredRevisionId when the doc has changed.
    if (response.status === 400 && /revision/i.test(message)) {
      throw new GoogleError('The doc changed in Google Docs. Reload it, then edit again.', { status: 400, code: 'conflict' });
    }
    throw new GoogleError(reason ?? `Google answered ${response.status}${message ? `: ${message}` : ''}`, { status: response.status });
  }

  // Resolves when the token is saved. The page tells the user to switch to
  // the browser; Google redirects back to the one-shot server below.
  function signIn() {
    const { id, secret } = client();
    const verifier = base64url(crypto.randomBytes(32));
    const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
    const state = base64url(crypto.randomBytes(16));

    return new Promise((resolve, reject) => {
      let redirectUri;
      const server = http.createServer(async (req, res) => {
        const url = new URL(req.url, redirectUri);
        if (url.pathname !== '/') {
          res.writeHead(404).end();
          return;
        }
        const reply = (status, text) => {
          res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(`<!doctype html><meta charset="utf-8"><title>Google Docs for Live</title><body style="font:16px -apple-system,sans-serif;padding:40px">${text}</body>`);
        };
        if (url.searchParams.get('state') !== state) {
          reply(400, 'This sign-in link is not valid. Start the sign-in again in Live.');
          return;
        }
        finish();
        const code = url.searchParams.get('code');
        if (!code) {
          reply(400, 'Sign-in was cancelled. You can close this tab.');
          reject(new GoogleError(`Sign-in cancelled: ${url.searchParams.get('error') ?? 'no code'}`));
          return;
        }
        try {
          const grant = await tokenRequest({ grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: redirectUri, client_id: id, client_secret: secret });
          if (!grant.refresh_token) throw new GoogleError('Google sent no refresh token');
          saveGrant(grant);
          reply(200, 'Signed in. You can close this tab and go back to Live.');
          resolve();
        } catch (error) {
          reply(500, 'Sign-in failed. Look at the device in Live.');
          reject(error);
        }
      });
      const timer = setTimeout(() => {
        finish();
        reject(new GoogleError('Sign-in timed out'));
      }, SIGN_IN_TIMEOUT_MS);
      function finish() {
        clearTimeout(timer);
        server.close();
      }
      server.on('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      server.listen(0, '127.0.0.1', () => {
        redirectUri = `http://127.0.0.1:${server.address().port}/`;
        const params = new URLSearchParams({
          client_id: id,
          redirect_uri: redirectUri,
          response_type: 'code',
          scope: SCOPES.join(' '),
          access_type: 'offline',
          prompt: 'consent',
          code_challenge: challenge,
          code_challenge_method: 'S256',
          state,
        });
        openUrl(`${AUTH_URL}?${params}`);
      });
    });
  }

  async function signOut() {
    const token = readToken();
    fs.rmSync(tokenFile, { force: true });
    if (token?.refresh_token) {
      // Best effort: the local token is gone either way.
      await fetchFn(`${REVOKE_URL}?token=${encodeURIComponent(token.refresh_token)}`, { method: 'POST' }).catch(() => {});
    }
  }

  // Scopes this version needs that the saved token does not have. A token
  // from an older version works for docs by link, but not for the list.
  function missingScopes() {
    const granted = new Set(String(readToken()?.scope ?? '').split(' '));
    return SCOPES.filter((s) => !granted.has(s));
  }

  // Google Docs the account can open, last modified first, the date the list
  // shows. Not 'recency': it skips other people's edits, so a doc someone
  // shared and changed today sank below older ones until it was opened.
  async function listDocs(query = '') {
    const q = ["mimeType='application/vnd.google-apps.document'", 'trashed=false'];
    const name = query.trim();
    if (name) q.push(`name contains '${name.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`);
    const params = new URLSearchParams({ q: q.join(' and '), orderBy: 'modifiedTime desc', pageSize: '50', fields: 'files(id,name,modifiedTime)' });
    const result = await api(`${FILES_URL}?${params}`);
    return (result.files ?? []).map((f) => ({ id: f.id, name: f.name, modifiedTime: f.modifiedTime }));
  }

  // A doc and its model (see docModel), ready for saveDoc. Google sends a
  // revisionId only when the account may edit the doc.
  async function readDoc(link) {
    const id = docIdFromLink(link);
    if (!id) throw new GoogleError('Not a Google Docs link');
    const doc = await api(`${DOCS_URL}${encodeURIComponent(id)}?includeTabsContent=true`);
    return { id, title: doc.title ?? '', revisionId: doc.revisionId, editable: Boolean(doc.revisionId), ...docModel(doc) };
  }

  // targetRevisionId: Google applies the requests to the revision they were
  // made for and merges them with everything other people changed since.
  async function write(doc, requests) {
    if (!doc.editable) throw new GoogleError('This doc is view-only for your account.', { code: 'read_only' });
    await api(`${DOCS_URL}${encodeURIComponent(doc.id)}:batchUpdate`, {
      method: 'POST',
      body: { requests, writeControl: { targetRevisionId: doc.revisionId } },
    });
  }

  // Gives the doc the changes made on the page since `base` (the text and
  // blocks the page started from): first the changed text, moved to its
  // place in the newest doc, then the formatting the page changed. Other
  // people's changes stay. Each step reads the doc again; returns the newest.
  async function saveDoc(doc, base, blocks) {
    const baseText = plain(base.text);
    const change = diffRange(baseText, plain(blocksText(blocks)));
    let current = doc;
    if (change.start !== change.end || change.text) {
      // A revision that is too old to merge with: read again, try once more.
      for (let attempt = 1; ; attempt++) {
        const moved = moveChange(change, baseText, plain(current.text));
        if (!moved) {
          throw new GoogleError('Someone else changed the same lines at the same time. Your version is still in the editor: copy what you need, then press Reload.', { code: 'conflict' });
        }
        try {
          await write(current, editRequests(current, fitToDoc(current, moved)));
          break;
        } catch (error) {
          if (error.code !== 'conflict' || attempt === 2) throw error;
          current = await readDoc(current.id);
        }
      }
      current = await readDoc(current.id);
    }
    const requests = styleRequests(current, base.blocks, blocks);
    if (requests.length) {
      await write(current, requests);
      current = await readDoc(current.id);
    }
    return current;
  }

  // Drive's version number of a file: it grows with every change, also in
  // docs the account can only view (those have no revisionId).
  async function version(id) {
    const file = await api(`${FILES_URL}/${encodeURIComponent(id)}?fields=version`);
    return file.version;
  }

  // A new, empty doc in the account's Drive. Returns its id.
  async function createDoc(title) {
    const doc = await api(DOCS_URL.replace(/\/$/, ''), { method: 'POST', body: { title: title || 'Untitled document' } });
    return doc.documentId;
  }

  // api is for tools/ and later phases (creating docs); the page never gets it.
  return { signedIn: () => Boolean(readToken()?.refresh_token), missingScopes, signIn, signOut, listDocs, readDoc, saveDoc, createDoc, version, api };
}

module.exports = { createGoogle, docIdFromLink, docModel, docText, blocksText, diffRange, fitToDoc, editRequests, alignLines, moveChange, styleRequests, GoogleError, SECRETS_DIR, SCOPES };
