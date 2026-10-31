// ui/index.html in headless Chrome, with a stand-in for jweb's window.max.
// jweb is Chromium 135 and this is the installed Google Chrome, so the
// editing behavior can differ in details; the round trip must not.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';

const require = createRequire(import.meta.url);
const { docModel, blocksText } = require('../node/google.js');
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// A doc with every kind of content the editor shows.
function styled(startIndex, runs, paragraphStyle, bullet) {
  let index = startIndex;
  const elements = runs.map(([content, textStyle]) => {
    const e = { startIndex: index, textRun: { content, textStyle } };
    index += content.length;
    return e;
  });
  return { startIndex, endIndex: index, paragraph: { elements, paragraphStyle, bullet } };
}
const cell = (text) => ({ content: [{ paragraph: { elements: [{ textRun: { content: `${text}\n` } }] } }] });
const SAMPLE = docModel({
  revisionId: 'r1',
  lists: { b: { listProperties: { nestingLevels: [{ glyphSymbol: '●' }, { glyphSymbol: '○' }] } }, n: { listProperties: { nestingLevels: [{ glyphType: 'DECIMAL' }] } } },
  body: {
    content: [
      styled(1, [['My Song\n', {}]], { namedStyleType: 'TITLE' }),
      styled(9, [['Verse\n', {}]], { namedStyleType: 'HEADING_2' }),
      styled(15, [['First ', {}], ['bold', { bold: true }], [' and ', {}], ['under', { underline: true, italic: true }], ['\n', {}]]),
      styled(36, [['soft\u000bbreak  two  spaces\n', {}]]),
      styled(58, [['ends soft\u000b\n', {}]]),
      styled(69, [['\n', {}]]),
      styled(70, [['bullet\n', {}]], {}, { listId: 'b' }),
      styled(77, [['nested\n', {}]], {}, { listId: 'b', nestingLevel: 1 }),
      styled(84, [['one\n', {}]], {}, { listId: 'n' }),
      { table: { tableRows: [{ tableCells: [cell('A'), cell('B')] }] } },
      styled(100, [['strike', { strikethrough: true }], ['😀 end\n', {}]]),
    ],
  },
});

let browser;
let page;
before(async () => {
  browser = await chromium.launch({ channel: 'chrome', headless: true });
});
after(async () => {
  await browser?.close();
});

async function freshPage() {
  page = await browser.newPage();
  await page.addInitScript(() => {
    window.__out = [];
    window.__inlets = {};
    window.max = { outlet: (...args) => window.__out.push(args), bindInlet: (name, fn) => { window.__inlets[name] = fn; } };
  });
  await page.goto(pathToFileURL(path.join(root, 'ui', 'index.html')).href);
  await page.waitForFunction(() => window.__out.some((o) => o[0] === 'ready'));
}
const deliver = (name, ...args) => page.evaluate(([n, a]) => window.__inlets[n](...a), [name, args]);
async function sendPacket(kind, data) {
  const encoded = encodeURIComponent(JSON.stringify(data));
  await deliver('pkt_begin', kind);
  for (let i = 0; i < encoded.length; i += 4000) await deliver('pkt_chunk', `c${encoded.slice(i, i + 4000)}`);
  await deliver('pkt_end');
}
// The packets the page sent, decoded, in order.
async function packetsSent(kind) {
  const out = await page.evaluate(() => window.__out);
  const packets = [];
  let current = null;
  for (const [name, arg] of out) {
    if (name === 'pkt_begin') current = { kind: arg, parts: [] };
    else if (name === 'pkt_chunk') current.parts.push(arg.slice(1));
    else if (name === 'pkt_end') packets.push({ kind: current.kind, data: JSON.parse(decodeURIComponent(current.parts.join(''))) });
  }
  return packets.filter((p) => p.kind === kind).map((p) => p.data);
}
// Waits for the next save, answers it like node does, returns its blocks.
async function nextSave() {
  const before = (await packetsSent('save')).length;
  await page.waitForFunction((n) => window.__out.filter((o) => o[0] === 'pkt_begin' && o[1] === 'save').length > n, before, { timeout: 5000 });
  const blocks = (await packetsSent('save')).at(-1).blocks;
  await sendPacket('saved', { ok: true });
  return blocks;
}
async function openSample(editable = true) {
  await deliver('auth', 'signedin');
  await sendPacket('doc', { id: 'd1', title: 'My Song', editable, blocks: SAMPLE.blocks });
}
// Puts the caret into the paragraph `index`, after `offset` characters
// (or at its end), or selects `length` characters from there.
const caret = (index, offset = null, length = 0) =>
  page.evaluate(
    ([i, off, len]) => {
      const div = document.getElementById('editor').children[i];
      const walker = document.createTreeWalker(div, NodeFilter.SHOW_TEXT);
      const nodes = [];
      while (walker.nextNode()) nodes.push(walker.currentNode);
      const at = (o) => {
        if (!nodes.length) return [div, 0];
        for (const n of nodes) {
          if (o <= n.data.length) return [n, o];
          o -= n.data.length;
        }
        const last = nodes.at(-1);
        return [last, last.data.length];
      };
      const range = document.createRange();
      const start = off === null ? at(Infinity) : at(off);
      range.setStart(...start);
      range.setEnd(...(len ? at(off + len) : start));
      document.getElementById('editor').focus();
      const sel = getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    },
    [index, offset, length],
  );

test('signed in: the page asks for the doc list with "find"', async () => {
  await freshPage();
  await deliver('auth', 'signedin');
  const out = await page.evaluate(() => window.__out);
  assert.deepEqual(out.find((o) => o[0] === 'find'), ['find', '']);
});

test('round trip: the editor shows the doc exactly, so it opens for editing', async () => {
  await freshPage();
  await openSample();
  const state = await page.evaluate(() => ({ editable: document.getElementById('editor').isContentEditable, save: document.getElementById('saveState').textContent }));
  assert.deepEqual(state, { editable: true, save: 'Saved' });
  const blocks = await page.evaluate(() => normal(serialize()));
  assert.deepEqual(blocks, SAMPLE.blocks);
  assert.equal(blocksText(blocks), SAMPLE.text);
});

test('typing saves the text; typing after bold text stays bold', async () => {
  await freshPage();
  await openSample();
  await caret(2, 10);
  await page.keyboard.type('er');
  const blocks = await nextSave();
  assert.deepEqual(blocks[2].runs, [{ text: 'First ', f: 0 }, { text: 'bolder', f: 1 }, { text: ' and ', f: 0 }, { text: 'under', f: 6 }]);
  assert.equal(blocksText(blocks), SAMPLE.text.replace('bold and', 'bolder and'));
});

test('toolbar: bold, style, lists', async () => {
  await freshPage();
  await openSample();
  await caret(2, 0, 5);
  await page.click('[data-command="bold"]');
  let blocks = await nextSave();
  assert.deepEqual(blocks[2].runs.slice(0, 2), [{ text: 'First', f: 1 }, { text: ' ', f: 0 }]);

  await caret(3, 2);
  await page.selectOption('#paraStyle', 'HEADING_1');
  blocks = await nextSave();
  assert.equal(blocks[3].style, 'HEADING_1');

  await caret(5);
  await page.click('[data-list="number"]');
  blocks = await nextSave();
  assert.equal(blocks[5].list, 'number');
  await page.click('[data-list="number"]');
  blocks = await nextSave();
  assert.equal(blocks[5].list, 'none');
  assert.equal(blocksText(blocks), SAMPLE.text, 'formatting does not change the text');
});

test('Return splits a paragraph and keeps its style; Shift+Return is a soft break', async () => {
  await freshPage();
  await openSample();
  await caret(6, 3);
  await page.keyboard.press('Enter');
  let blocks = await nextSave();
  assert.deepEqual(
    blocks.slice(6, 8).map((b) => [b.list, b.runs.map((r) => r.text).join('')]),
    [['bullet', 'bul'], ['bullet', 'let']],
  );
  await caret(1);
  await page.keyboard.press('Shift+Enter');
  await page.keyboard.type('x');
  blocks = await nextSave();
  assert.equal(blocks[1].runs.map((r) => r.text).join(''), 'Verse\u000bx');
});

test('paste: plain text, line by line', async () => {
  await freshPage();
  await openSample();
  await caret(5);
  await page.evaluate(() => {
    const data = new DataTransfer();
    data.setData('text/plain', 'line one\r\nline two');
    data.setData('text/html', '<b style="color:red">line one</b><br>line two');
    document.getElementById('editor').dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  });
  const blocks = await nextSave();
  assert.deepEqual(
    blocks.slice(5, 7).map((b) => b.runs),
    [[{ text: 'line one', f: 0 }], [{ text: 'line two', f: 0 }]],
  );
});

test('a view-only doc cannot be edited', async () => {
  await freshPage();
  await openSample(false);
  const state = await page.evaluate(() => ({
    editable: document.getElementById('editor').isContentEditable,
    save: document.getElementById('saveState').textContent,
    toolbar: [...document.querySelectorAll('#toolbar button')].every((b) => b.disabled),
  }));
  assert.deepEqual(state, { editable: false, save: 'View only', toolbar: true });
});

test('a doc the editor cannot show exactly opens read-only', async () => {
  await freshPage();
  await deliver('auth', 'signedin');
  // A line break inside a run cannot be one paragraph in the editor.
  const blocks = [{ type: 'p', style: 'NORMAL_TEXT', list: 'none', level: 0, runs: [{ text: 'a\nb', f: 0 }] }];
  await sendPacket('doc', { id: 'd2', title: 'Odd', editable: true, blocks });
  const editable = await page.evaluate(() => document.getElementById('editor').isContentEditable);
  assert.equal(editable, false);
});

test('new doc: the title goes to node with "create"', async () => {
  await freshPage();
  await deliver('auth', 'signedin');
  await page.click('#newButton');
  await page.fill('#newTitle', 'Night Drive');
  await page.click('#newForm button[type="submit"]');
  const out = await page.evaluate(() => window.__out);
  assert.deepEqual(out.find((o) => o[0] === 'create'), ['create', 'Night Drive']);
});

const synced = async () => (await page.evaluate(() => window.__out)).filter((o) => o[0] === 'synced').map((o) => o[1]);

test('an update while saved: the editor changes, the cursor stays in its text', async () => {
  await freshPage();
  await openSample();
  await caret(2, 6);
  const blocks = structuredClone(SAMPLE.blocks);
  // A buddy adds a line above the cursor's line and changes one below it.
  blocks.splice(1, 0, { type: 'p', style: 'NORMAL_TEXT', list: 'none', level: 0, runs: [{ text: 'A line from a buddy', f: 0 }] });
  blocks[5].runs = [{ text: 'changed by a buddy', f: 0 }];
  await sendPacket('update', { id: 3, editable: true, blocks });
  assert.deepEqual(await page.evaluate(() => normal(serialize())), blocks);
  assert.deepEqual(await synced(), [3]);
  const beforeCaret = await page.evaluate(() => {
    const range = getSelection().getRangeAt(0).cloneRange();
    range.setStart(document.getElementById('editor').children[3], 0);
    return range.toString();
  });
  assert.equal(beforeCaret, 'First ', 'the cursor is still after "First "');
  assert.equal(await page.evaluate(() => document.getElementById('saveState').textContent), 'Updated');
});

test('an update while typing waits; the save makes it stale; the next one applies', async () => {
  await freshPage();
  await openSample();
  await caret(2);
  await page.keyboard.type('!');
  const theirs = structuredClone(SAMPLE.blocks);
  theirs[0].runs = [{ text: 'Their title', f: 0 }];
  await sendPacket('update', { id: 7, editable: true, blocks: theirs });
  let shown = await page.evaluate(() => normal(serialize()));
  assert.equal(shown[0].runs[0].text, 'My Song', 'not applied while typing');
  assert.ok(shown[2].runs.at(-1).text.endsWith('!'), 'the typed text is still there');
  await nextSave();
  assert.deepEqual(await synced(), [], 'the update from before the save is dropped');

  const merged = structuredClone(theirs);
  merged[2].runs.at(-1).text += '!';
  await sendPacket('update', { id: 8, editable: true, blocks: merged });
  shown = await page.evaluate(() => normal(serialize()));
  assert.deepEqual(shown, merged);
  assert.deepEqual(await synced(), [8]);
});

test('stamp: at the cursor; without a cursor on a new line at the end', async () => {
  await freshPage();
  await openSample();
  await caret(2, 6);
  await page.click('#stamp');
  assert.ok((await page.evaluate(() => window.__out)).some((o) => o[0] === 'stamp'), 'the page asks node for a stamp');
  await sendPacket('stamp', { text: '[Chorus · bar 33] ' });
  let blocks = await nextSave();
  assert.equal(blocks[2].runs.map((r) => r.text).join(''), 'First [Chorus · bar 33] bold and under');

  await page.evaluate(() => document.activeElement.blur());
  await page.click('#stamp');
  await sendPacket('stamp', { text: '[bar 1] ' });
  blocks = await nextSave();
  assert.deepEqual(blocks.at(-1), { type: 'p', style: 'NORMAL_TEXT', list: 'none', level: 0, runs: [{ text: '[bar 1] ', f: 0 }] });
  assert.equal(blocks.length, SAMPLE.blocks.length + 1);
});
