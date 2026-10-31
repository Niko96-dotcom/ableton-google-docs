// node/google.js against a fake Google: sign-in through the real one-shot
// server on 127.0.0.1, token refresh, the doc list, reading and editing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { createGoogle, docIdFromLink, docModel, docText, blocksText, diffRange, fitToDoc, editRequests, alignLines, moveChange, styleRequests, SCOPES } = require('../node/google.js');

const DOC_ID = '195j9eDD3ccgjQRttHhJPymLJUCOUjs-jmwTrekvdjFE';
const json = (status, body) => ({ ok: status < 400, status, json: async () => body });

// Paragraphs as the Docs API returns them, with real start indexes.
function paragraphs(lines, start = 1) {
  let index = start;
  return lines.map((line) => {
    const el = { paragraph: { elements: [{ startIndex: index, textRun: { content: line } }] } };
    index += line.length;
    return el;
  });
}
const p = (text, startIndex = 1) => ({ paragraph: { elements: [{ startIndex, textRun: { content: text } }] } });
// Plain paragraphs as the page sends them.
const textBlocks = (text) =>
  text.replace(/\n$/, '').split('\n').map((line) => ({ type: 'p', style: 'NORMAL_TEXT', list: 'none', level: 0, runs: line ? [{ text: line, f: 0 }] : [] }));

// Records requests; answers the token endpoint, Drive and the Docs API.
function fakeGoogle() {
  const calls = [];
  let accessCount = 0;
  const state = {
    docStatus: [],
    writeStatus: [],
    doc: { title: 'Sample', revisionId: 'rev-1', tabs: [{ tabProperties: { tabId: 't.0', title: 'Tab 1' }, documentTab: { body: { content: paragraphs(['Hello\n']) } } }] },
    files: [{ id: 'd1', name: 'Song', modifiedTime: '2026-10-27T19:00:00Z', mimeType: 'x' }],
  };
  const fetch = async (url, init = {}) => {
    const u = String(url);
    let body;
    if (typeof init.body === 'string') body = init.headers?.['Content-Type'] === 'application/json' ? JSON.parse(init.body) : Object.fromEntries(new URLSearchParams(init.body));
    calls.push({ url: u, method: init.method ?? 'GET', body, auth: init.headers?.Authorization });
    if (u.startsWith('https://oauth2.googleapis.com/token')) {
      accessCount += 1;
      const grant = { access_token: `access-${accessCount}`, expires_in: 3600, scope: SCOPES.join(' ') };
      if (body.grant_type === 'authorization_code') grant.refresh_token = 'refresh-1';
      if (body.refresh_token === 'revoked') return json(400, { error: 'invalid_grant' });
      return json(200, grant);
    }
    if (u.startsWith('https://oauth2.googleapis.com/revoke')) return json(200, {});
    if (u.includes('?fields=version')) return json(200, { version: state.version });
    if (u.startsWith('https://www.googleapis.com/drive/v3/files')) return json(200, { files: state.files });
    if (u.includes(':batchUpdate')) {
      const status = state.writeStatus.shift() ?? 200;
      if (status === 400) return json(400, { error: { message: 'The required revision ID does not match the latest revision.' } });
      return json(status, {});
    }
    if (u === 'https://docs.googleapis.com/v1/documents') return json(200, { documentId: 'new-doc', title: body.title });
    if (u.startsWith('https://docs.googleapis.com/v1/documents/')) {
      const status = state.docStatus.shift() ?? 200;
      return status === 200 ? json(200, state.doc) : json(status, {});
    }
    throw new Error(`unexpected request ${u}`);
  };
  return { fetch, calls, state };
}

async function setup({ token } = {}) {
  const clock = { t: 1_000_000 };
  const dir = await mkdtemp(path.join(tmpdir(), 'gdocs-secrets-'));
  await writeFile(path.join(dir, 'client.json'), JSON.stringify({ installed: { client_id: 'cid', client_secret: 'csecret' } }));
  if (token) await writeFile(path.join(dir, 'token.json'), JSON.stringify({ refresh_token: 'refresh-1', access_token: 'a', expires_at: clock.t + 3_600_000, scope: SCOPES.join(' '), ...token }));
  const fake = fakeGoogle();
  const opened = [];
  const google = createGoogle({ dir, fetch: fake.fetch, openUrl: (url) => opened.push(url), now: () => clock.t });
  return { dir, fake, opened, google, clock };
}

async function waitFor(check) {
  for (let i = 0; i < 100 && !check(); i++) await new Promise((r) => setTimeout(r, 10));
  assert.ok(check(), 'condition not reached');
}

test('doc links', () => {
  assert.equal(docIdFromLink(`https://docs.google.com/document/d/${DOC_ID}/edit?tab=t.0`), DOC_ID);
  assert.equal(docIdFromLink(`https://docs.google.com/document/u/1/d/${DOC_ID}/edit`), DOC_ID);
  assert.equal(docIdFromLink(`  ${DOC_ID}  `), DOC_ID);
  assert.equal(docIdFromLink('https://example.com/document/d/abc'), null);
  assert.equal(docIdFromLink('hello'), null);
});

test('doc text: paragraphs, tables, tabs', () => {
  const table = { table: { tableRows: [{ tableCells: [{ content: [p('A\n')] }, { content: [p('B\n')] }] }] } };
  assert.equal(docText({ body: { content: [p('Verse\n'), table, p('End\n')] } }), 'Verse\nA\tB\nEnd\n');
  const tab = (title, text, childTabs) => ({ tabProperties: { title }, documentTab: { body: { content: [p(text)] } }, childTabs });
  assert.equal(docText({ tabs: [tab('Only', 'One\n')] }), 'One\n');
  assert.equal(docText({ tabs: [tab('Song', 'Lyrics\n', [tab('Notes', 'Idea\n')])] }), '=== Song ===\nLyrics\n\n=== Notes ===\nIdea\n');
});

test('doc model: doc index per character; tables and tab titles read-only', () => {
  const table = { table: { tableRows: [{ tableCells: [{ content: [p('A\n', 20)] }, { content: [p('B\n', 23)] }] }] } };
  const model = docModel({ body: { content: [...paragraphs(['Verse\n', 'two\n']), table, p('End\n', 30)] } });
  assert.equal(model.text, 'Verse\ntwo\nA\tB\nEnd\n');
  assert.deepEqual(model.pos.slice(0, 10), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.deepEqual(model.pos.slice(10, 14), [-1, -1, -1, -1], 'table text is read-only');
  assert.deepEqual(model.pos.slice(14), [30, 31, 32, 33]);
  assert.deepEqual([...model.segmentEnds], [17]);

  const tab = (tabId, title, text) => ({ tabProperties: { tabId, title }, documentTab: { body: { content: [p(text)] } } });
  const tabs = docModel({ tabs: [tab('t.a', 'Song', 'La\n'), tab('t.b', 'Notes', 'Hi\n')] });
  assert.equal(tabs.text, '=== Song ===\nLa\n\n=== Notes ===\nHi\n');
  assert.deepEqual(tabs.tabIds, ['t.a', 't.b']);
  const hi = tabs.text.indexOf('Hi');
  assert.deepEqual([tabs.pos[hi], tabs.tab[hi]], [1, 1]);
  assert.equal(tabs.pos[0], -1, 'tab titles are read-only');
});

test('diff: one changed range, never inside a surrogate pair', () => {
  assert.deepEqual(diffRange('Hello world\n', 'Hello there world\n'), { start: 6, end: 6, text: 'there ' });
  assert.deepEqual(diffRange('abc\n', 'ac\n'), { start: 1, end: 2, text: '' });
  assert.deepEqual(diffRange('same\n', 'same\n'), { start: 5, end: 5, text: '' });
  // 😀 and 😃 share the high surrogate; the change must cover the whole pair.
  assert.deepEqual(diffRange('a😀b\n', 'a😃b\n'), { start: 1, end: 3, text: '😃' });
});

test('deleting the last line keeps the line break Google never deletes', () => {
  const model = docModel({ body: { content: paragraphs(['Verse\n', 'last\n']) } });
  const change = fitToDoc(model, diffRange(model.text, 'Verse\n'));
  assert.deepEqual(change, { start: 5, end: 10, text: '' }, '"\\nlast", not "last\\n"');
  assert.deepEqual(editRequests(model, change), [{ deleteContentRange: { range: { startIndex: 6, endIndex: 11 } } }]);

  const tab = (tabId, title, lines) => ({ tabProperties: { tabId, title }, documentTab: { body: { content: paragraphs(lines) } } });
  const tabs = docModel({ tabs: [tab('t.a', 'Song', ['La\n', 'gone\n']), tab('t.b', 'Notes', ['Hi\n'])] });
  const after = tabs.text.replace('gone\n', '');
  const shifted = fitToDoc(tabs, diffRange(tabs.text, after));
  assert.deepEqual(editRequests(tabs, shifted), [{ deleteContentRange: { range: { startIndex: 3, endIndex: 8, tabId: 't.a' } } }]);
});

test('adding a line at the end, or before a table, goes before the last line break', () => {
  const model = docModel({ body: { content: paragraphs(['Verse\n', 'last\n']) } });
  const change = fitToDoc(model, diffRange(model.text, 'Verse\nlast\nnew\n'));
  assert.deepEqual(change, { start: 10, end: 10, text: '\nnew' });
  assert.deepEqual(editRequests(model, change), [{ insertText: { location: { index: 11 }, text: '\nnew' } }]);

  const table = { table: { tableRows: [{ tableCells: [{ content: [p('A\n', 9)] }] }] } };
  const withTable = docModel({ body: { content: [p('Verse\n'), table, p('End\n', 14)] } });
  const before = fitToDoc(withTable, diffRange(withTable.text, 'Verse\nmore\nA\nEnd\n'));
  assert.deepEqual(editRequests(withTable, before), [{ insertText: { location: { index: 6 }, text: '\nmore' } }]);
});

test('edit requests: insert, delete, replace, tabs, read-only parts', () => {
  const model = docModel({ body: { content: paragraphs(['Hello world\n']) } });
  assert.deepEqual(editRequests(model, { start: 6, end: 6, text: 'there ' }), [{ insertText: { location: { index: 7 }, text: 'there ' } }]);
  assert.deepEqual(editRequests(model, { start: 0, end: 6, text: '' }), [{ deleteContentRange: { range: { startIndex: 1, endIndex: 7 } } }]);
  assert.deepEqual(editRequests(model, { start: 6, end: 11, text: 'Live' }), [
    { deleteContentRange: { range: { startIndex: 7, endIndex: 12 } } },
    { insertText: { location: { index: 7 }, text: 'Live' } },
  ]);

  const tab = (tabId, title, text) => ({ tabProperties: { tabId, title }, documentTab: { body: { content: [p(text)] } } });
  const tabs = docModel({ tabs: [tab('t.a', 'Song', 'La\n'), tab('t.b', 'Notes', 'Hi\n')] });
  const hi = tabs.text.indexOf('Hi');
  assert.deepEqual(editRequests(tabs, { start: hi, end: hi, text: 'Oh ' }), [{ insertText: { location: { index: 1, tabId: 't.b' }, text: 'Oh ' } }]);
  assert.throws(() => editRequests(tabs, { start: 0, end: 3, text: '' }), /cannot be edited here/);
  assert.throws(() => editRequests(tabs, { start: hi, end: hi + 3, text: '' }), /last line break of a tab/);

  const table = { table: { tableRows: [{ tableCells: [{ content: [p('A\n', 8)] }] }] } };
  const withTable = docModel({ body: { content: [p('Verse\n'), table, p('End\n', 12)] } });
  assert.throws(() => editRequests(withTable, { start: 6, end: 7, text: 'X' }), /Tables and tab titles/);
});

test('sign-in: browser consent, loopback redirect, token saved 0600', async () => {
  const { dir, fake, opened, google } = await setup();
  assert.equal(google.signedIn(), false);
  const done = google.signIn();
  await waitFor(() => opened.length === 1);
  const auth = new URL(opened[0]);
  assert.equal(auth.origin + auth.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.equal(auth.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(auth.searchParams.get('access_type'), 'offline');
  assert.equal(auth.searchParams.get('scope'), SCOPES.join(' '));
  const redirect = new URL(auth.searchParams.get('redirect_uri'));
  assert.equal(redirect.hostname, '127.0.0.1');

  // A request with a wrong state is refused and the sign-in keeps waiting.
  const wrong = await fetch(`${redirect}?code=x&state=wrong`);
  assert.equal(wrong.status, 400);

  const page = await fetch(`${redirect}?code=the-code&state=${auth.searchParams.get('state')}`);
  assert.equal(page.status, 200);
  await done;

  const exchange = fake.calls.find((c) => c.body?.grant_type === 'authorization_code');
  assert.equal(exchange.body.code, 'the-code');
  assert.equal(exchange.body.redirect_uri, String(redirect));
  assert.ok(exchange.body.code_verifier.length >= 43);
  const token = JSON.parse(await readFile(path.join(dir, 'token.json'), 'utf8'));
  assert.equal(token.refresh_token, 'refresh-1');
  assert.equal((await stat(path.join(dir, 'token.json'))).mode & 0o777, 0o600);
  assert.equal(google.signedIn(), true);
  assert.deepEqual(google.missingScopes(), []);
});

test('cancelled consent rejects', async () => {
  const { opened, google } = await setup();
  const done = google.signIn();
  await waitFor(() => opened.length === 1);
  const auth = new URL(opened[0]);
  const rejected = assert.rejects(done, /Sign-in cancelled: access_denied/);
  await fetch(`${auth.searchParams.get('redirect_uri')}?error=access_denied&state=${auth.searchParams.get('state')}`);
  await rejected;
  assert.equal(google.signedIn(), false);
});

test('a token from the first version lacks the doc list permission', async () => {
  const { google } = await setup({ token: { scope: SCOPES.slice(0, 2).join(' ') } });
  assert.deepEqual(google.missingScopes(), ['https://www.googleapis.com/auth/drive.metadata.readonly']);
});

test('doc list: only Google Docs, not in the trash, last modified first, search escaped', async () => {
  const { fake, google } = await setup({ token: {} });
  assert.deepEqual(await google.listDocs(''), [{ id: 'd1', name: 'Song', modifiedTime: '2026-10-27T19:00:00Z' }]);
  let params = new URL(fake.calls.at(-1).url).searchParams;
  assert.equal(params.get('q'), "mimeType='application/vnd.google-apps.document' and trashed=false");
  assert.equal(params.get('orderBy'), 'modifiedTime desc');
  await google.listDocs("Niko's song");
  params = new URL(fake.calls.at(-1).url).searchParams;
  assert.match(params.get('q'), / and name contains 'Niko\\'s song'$/);
});

test('read: uses the saved token, refreshes it when it expires and after a 401', async () => {
  const { fake, google, clock } = await setup({ token: { access_token: 'old' } });
  const doc = await google.readDoc(DOC_ID);
  assert.deepEqual([doc.id, doc.title, doc.text, doc.revisionId], [DOC_ID, 'Sample', 'Hello\n', 'rev-1']);
  assert.equal(fake.calls.at(-1).auth, 'Bearer old');

  clock.t += 3_600_000;
  await google.readDoc(DOC_ID);
  assert.equal(fake.calls.at(-1).auth, 'Bearer access-1', 'refreshed after expiry');

  fake.state.docStatus.push(401);
  await google.readDoc(DOC_ID);
  assert.equal(fake.calls.at(-1).auth, 'Bearer access-2', 'refreshed after a 401');
});

test('read: clear errors', async () => {
  const { dir, fake, google } = await setup();
  await assert.rejects(google.readDoc(DOC_ID), /Not signed in/);
  await writeFile(path.join(dir, 'token.json'), JSON.stringify({ refresh_token: 'refresh-1', access_token: 'a', expires_at: 9e15 }));
  await assert.rejects(google.readDoc('not a link'), /Not a Google Docs link/);
  fake.state.docStatus.push(403);
  await assert.rejects(google.readDoc(DOC_ID), /no access to this doc/);
  fake.state.docStatus.push(404);
  await assert.rejects(google.readDoc(DOC_ID), /Doc not found/);
});

test('save: writes only the change, made for its revision, then reads again', async () => {
  const { fake, google } = await setup({ token: {} });
  const doc = await google.readDoc(DOC_ID);
  fake.state.doc = { ...fake.state.doc, revisionId: 'rev-2', tabs: [{ tabProperties: { tabId: 't.0' }, documentTab: { body: { content: paragraphs(['Hello Live\n']) } } }] };
  const after = await google.saveDoc(doc, doc, textBlocks('Hello Live\n'));
  const write = fake.calls.find((c) => c.url.endsWith(':batchUpdate'));
  assert.deepEqual(write.body, {
    requests: [{ insertText: { location: { index: 6, tabId: 't.0' }, text: ' Live' } }],
    writeControl: { targetRevisionId: 'rev-1' },
  });
  assert.equal(after.text, 'Hello Live\n');
  assert.equal(after.revisionId, 'rev-2');

  const before = fake.calls.length;
  assert.equal(await google.saveDoc(after, after, textBlocks('Hello Live\n')), after, 'no change, no request');
  assert.equal(fake.calls.length, before);
});

test('a view-only doc has no revision and is not written', async () => {
  const { fake, google } = await setup({ token: {} });
  fake.state.doc = { ...fake.state.doc, revisionId: undefined };
  const doc = await google.readDoc(DOC_ID);
  assert.equal(doc.editable, false);
  await assert.rejects(google.saveDoc(doc, doc, textBlocks('Hello there\n')), /view-only/);
  assert.ok(!fake.calls.some((c) => c.url.endsWith(':batchUpdate')));
});

test('save: a revision too old to merge with is read again and tried once more', async () => {
  const { fake, google } = await setup({ token: {} });
  const doc = await google.readDoc(DOC_ID);
  fake.state.writeStatus.push(400);
  await google.saveDoc(doc, doc, textBlocks('Hello there\n'));
  assert.equal(fake.calls.filter((c) => c.url.endsWith(':batchUpdate')).length, 2);
  fake.state.writeStatus.push(400, 400);
  await assert.rejects(google.saveDoc(doc, doc, textBlocks('Hello again\n')), (error) => error.code === 'conflict');
});

test('a revoked refresh token signs out', async () => {
  const { google, clock } = await setup({ token: { refresh_token: 'revoked', expires_at: 0 } });
  clock.t += 1;
  await assert.rejects(google.readDoc(DOC_ID), /expired\. Sign in again/);
  assert.equal(google.signedIn(), false);
});

test('missing client config is named', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'gdocs-secrets-'));
  const google = createGoogle({ dir, builtInClient: null, openUrl: () => {} });
  assert.throws(() => google.signIn(), /Google client missing/);
});

test('the built-in client signs in when there is no client.json; client.json wins', async () => {
  const builtInClient = { id: 'built-in-id', secret: 'built-in-secret' };
  const refreshWith = async (dir) => {
    await writeFile(path.join(dir, 'token.json'), JSON.stringify({ refresh_token: 'refresh-1', expires_at: 0, scope: SCOPES.join(' ') }));
    const fake = fakeGoogle();
    await createGoogle({ dir, builtInClient, fetch: fake.fetch, openUrl: () => {}, now: () => 1 }).readDoc(DOC_ID);
    return fake.calls.find((c) => c.body?.grant_type === 'refresh_token').body;
  };
  const bare = await refreshWith(await mkdtemp(path.join(tmpdir(), 'gdocs-secrets-')));
  assert.deepEqual([bare.client_id, bare.client_secret], ['built-in-id', 'built-in-secret']);
  const own = await refreshWith((await setup()).dir);
  assert.deepEqual([own.client_id, own.client_secret], ['cid', 'csecret']);
});

test('sign-out removes the token and revokes it', async () => {
  const { fake, google } = await setup({ token: {} });
  await google.signOut();
  assert.equal(google.signedIn(), false);
  assert.match(fake.calls.at(-1).url, /revoke\?token=refresh-1/);
});

// A paragraph element with styled runs: [text, textStyle] pairs.
function styled(startIndex, runs, paragraphStyle, bullet) {
  let index = startIndex;
  const elements = runs.map(([content, textStyle]) => {
    const e = { startIndex: index, textRun: { content, textStyle } };
    index += content.length;
    return e;
  });
  return { startIndex, endIndex: index, paragraph: { elements, paragraphStyle, bullet } };
}

test('doc model: blocks with styles, lists and read-only parts give the text again', () => {
  const lists = { l1: { listProperties: { nestingLevels: [{ glyphSymbol: '●' }] } }, l2: { listProperties: { nestingLevels: [{ glyphType: 'DECIMAL' }] } } };
  const table = { table: { tableRows: [{ tableCells: [{ content: [p('A\n')] }, { content: [p('B\n')] }] }] } };
  const doc = {
    body: {
      content: [
        styled(1, [['Song\n', {}]], { namedStyleType: 'TITLE' }),
        styled(6, [['Bold', { bold: true }], [' and ', {}], ['both', { bold: true, italic: true }], ['\n', {}]]),
        styled(20, [['one\n', {}]], {}, { listId: 'l1' }),
        styled(24, [['two\n', {}]], {}, { listId: 'l2', nestingLevel: 0 }),
        table,
        styled(40, [['\n', {}]]),
      ],
    },
    lists,
  };
  const model = docModel(doc);
  assert.deepEqual(model.blocks, [
    { type: 'p', style: 'TITLE', list: 'none', level: 0, runs: [{ text: 'Song', f: 0 }] },
    { type: 'p', style: 'NORMAL_TEXT', list: 'none', level: 0, runs: [{ text: 'Bold', f: 1 }, { text: ' and ', f: 0 }, { text: 'both', f: 3 }] },
    { type: 'p', style: 'NORMAL_TEXT', list: 'bullet', level: 0, runs: [{ text: 'one', f: 0 }] },
    { type: 'p', style: 'NORMAL_TEXT', list: 'number', level: 0, runs: [{ text: 'two', f: 0 }] },
    { type: 'ro', text: 'A\tB\n' },
    { type: 'p', style: 'NORMAL_TEXT', list: 'none', level: 0, runs: [] },
  ]);
  assert.equal(blocksText(model.blocks), model.text);
  assert.deepEqual(model.paragraphs.map((x) => [x.startIndex, x.endIndex, x.style, x.list]), [
    [1, 6, 'TITLE', 'none'],
    [6, 20, 'NORMAL_TEXT', 'none'],
    [20, 24, 'NORMAL_TEXT', 'bullet'],
    [24, 28, 'NORMAL_TEXT', 'number'],
    [40, 41, 'NORMAL_TEXT', 'none'],
  ]);
});

test('style requests: only what differs, lists grouped and last first', () => {
  const doc = {
    body: {
      content: [
        styled(1, [['Verse\n', {}]]),
        styled(7, [['Bold line\n', { bold: true }]]),
        styled(17, [['a\n', {}]]),
        styled(19, [['b\n', {}]]),
        styled(21, [['c\n', {}]], {}, { listId: 'x' }),
      ],
    },
    lists: { x: { listProperties: { nestingLevels: [{ glyphSymbol: '●' }] } } },
  };
  const model = docModel(doc);
  assert.deepEqual(styleRequests(model, model.blocks, model.blocks), [], 'the same blocks need no requests');

  const blocks = structuredClone(model.blocks);
  blocks[0].style = 'HEADING_1';
  blocks[0].runs = [{ text: 'Ver', f: 2 }, { text: 'se', f: 0 }];
  blocks[1].runs = [{ text: 'Bold', f: 1 }, { text: ' line', f: 0 }];
  blocks[2].list = 'number';
  blocks[3].list = 'number';
  blocks[4].list = 'none';
  assert.deepEqual(styleRequests(model, model.blocks, blocks), [
    { updateTextStyle: { range: { startIndex: 1, endIndex: 4 }, textStyle: { italic: true }, fields: 'italic' } },
    { updateParagraphStyle: { range: { startIndex: 1, endIndex: 7 }, paragraphStyle: { namedStyleType: 'HEADING_1' }, fields: 'namedStyleType' } },
    { updateTextStyle: { range: { startIndex: 11, endIndex: 16 }, textStyle: { bold: false }, fields: 'bold' } },
    { deleteParagraphBullets: { range: { startIndex: 21, endIndex: 23 } } },
    { createParagraphBullets: { range: { startIndex: 17, endIndex: 21 }, bulletPreset: 'NUMBERED_DECIMAL_ALPHA_ROMAN' } },
  ]);

  const other = structuredClone(model.blocks);
  other[0].runs = [{ text: 'Verses', f: 0 }];
  assert.deepEqual(styleRequests(model, model.blocks, other), [], 'a line with other text: no style requests');
});

test('save: text first, then formatting, each made for the newest revision', async () => {
  const { fake, google } = await setup({ token: {} });
  const doc = await google.readDoc(DOC_ID);
  const blocks = [{ type: 'p', style: 'HEADING_1', list: 'none', level: 0, runs: [{ text: 'Hello', f: 1 }, { text: ' Live', f: 0 }] }];
  fake.state.doc = { ...fake.state.doc, revisionId: 'rev-2', tabs: [{ tabProperties: { tabId: 't.0' }, documentTab: { body: { content: [styled(1, [['Hello Live\n', {}]])] } } }] };
  await google.saveDoc(doc, doc, blocks);
  const writes = fake.calls.filter((c) => c.url.endsWith(':batchUpdate')).map((c) => c.body);
  assert.equal(writes.length, 2);
  assert.deepEqual(writes[0].requests, [{ insertText: { location: { index: 6, tabId: 't.0' }, text: ' Live' } }]);
  assert.equal(writes[0].writeControl.targetRevisionId, 'rev-1');
  assert.deepEqual(writes[1].requests, [
    { updateTextStyle: { range: { startIndex: 1, endIndex: 6, tabId: 't.0' }, textStyle: { bold: true }, fields: 'bold' } },
    { updateParagraphStyle: { range: { startIndex: 1, endIndex: 12, tabId: 't.0' }, paragraphStyle: { namedStyleType: 'HEADING_1' }, fields: 'namedStyleType' } },
  ]);
  assert.equal(writes[1].writeControl.targetRevisionId, 'rev-2');
});

test('create: a new doc with the title', async () => {
  const { fake, google } = await setup({ token: {} });
  assert.equal(await google.createDoc('New Song'), 'new-doc');
  assert.deepEqual(fake.calls.at(-1).body, { title: 'New Song' });
  await google.createDoc('');
  assert.deepEqual(fake.calls.at(-1).body, { title: 'Untitled document' });
});

test('line alignment: same lines match, changed ones do not', () => {
  assert.deepEqual(alignLines(['a', 'b', 'c'], ['a', 'x', 'b', 'c']), [0, 2, 3]);
  assert.deepEqual(alignLines(['a', 'b', 'c'], ['a', 'B', 'c']), [0, -1, 2]);
  assert.deepEqual(alignLines(['v', 'x', 'y', 'z'], ['v', 'y', 'q', 'z']), [0, -1, 1, 3]);
});

test('moving a change past other people\'s changes', () => {
  const base = 'Verse\nchorus\nend\n';
  // They added a line at the top; the change in "end" moves down with it.
  assert.deepEqual(moveChange({ start: 16, end: 16, text: '!' }, base, 'Intro\nVerse\nchorus\nend\n'), { start: 22, end: 22, text: '!' });
  // They changed another line: the change stays where it was.
  assert.deepEqual(moveChange({ start: 5, end: 5, text: ' 1' }, base, 'Verse\nCHORUS\nend\n'), { start: 5, end: 5, text: ' 1' });
  // Adding at the very end goes after their lines.
  assert.deepEqual(moveChange({ start: 17, end: 17, text: 'new\n' }, base, 'Verse\nchorus\nend\nmore\n'), { start: 22, end: 22, text: 'new\n' });
  // They changed the same line: no move.
  assert.equal(moveChange({ start: 6, end: 12, text: 'hook' }, base, 'Verse\nchorus!\nend\n'), null);
});

test('save: merges with a change someone else made meanwhile', async () => {
  const { fake, google } = await setup({ token: {} });
  const tab = (lines, revisionId) => ({ title: 'Song', revisionId, tabs: [{ tabProperties: { tabId: 't.0' }, documentTab: { body: { content: paragraphs(lines) } } }] });
  fake.state.doc = tab(['Verse\n', 'chorus\n', 'end\n'], 'rev-1');
  const base = await google.readDoc(DOC_ID);
  // Someone renamed the first line; the page added "!" to the last one.
  fake.state.doc = tab(['Verse 1\n', 'chorus\n', 'end\n'], 'rev-2');
  const latest = await google.readDoc(DOC_ID);
  fake.state.doc = tab(['Verse 1\n', 'chorus\n', 'end!\n'], 'rev-3');
  const after = await google.saveDoc(latest, base, textBlocks('Verse\nchorus\nend!\n'));
  const write = fake.calls.find((c) => c.url.endsWith(':batchUpdate')).body;
  assert.deepEqual(write.requests, [{ insertText: { location: { index: 19, tabId: 't.0' }, text: '!' } }]);
  assert.equal(write.writeControl.targetRevisionId, 'rev-2');
  assert.equal(after.text, 'Verse 1\nchorus\nend!\n');

  await assert.rejects(google.saveDoc(latest, base, textBlocks('Verse A\nchorus\nend\n')), (error) => error.code === 'conflict' && /same lines/.test(error.message));
});

test('style requests: formatting someone else changed meanwhile stays', () => {
  const plainDoc = docModel({ body: { content: [styled(1, [['Verse\n', {}]]), styled(7, [['chorus\n', {}]])] } });
  const theirs = docModel({ body: { content: [styled(1, [['Verse\n', {}]]), styled(7, [['chorus', { bold: true }], ['\n', {}]])] } });
  // The page started from the plain doc and changed nothing: no requests.
  assert.deepEqual(styleRequests(theirs, plainDoc.blocks, plainDoc.blocks), []);
  // The page made "Verse" italic: only that is sent; "chorus" stays bold.
  const mine = structuredClone(plainDoc.blocks);
  mine[0].runs = [{ text: 'Verse', f: 2 }];
  assert.deepEqual(styleRequests(theirs, plainDoc.blocks, mine), [{ updateTextStyle: { range: { startIndex: 1, endIndex: 6 }, textStyle: { italic: true }, fields: 'italic' } }]);
});

test('version: Drive\'s version number of the doc', async () => {
  const { fake, google } = await setup({ token: {} });
  fake.state.version = '42';
  assert.equal(await google.version(DOC_ID), '42');
  assert.match(fake.calls.at(-1).url, /drive\/v3\/files\/195j9e.*\?fields=version$/);
});
