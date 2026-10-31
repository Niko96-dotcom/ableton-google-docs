#!/usr/bin/env node
// Dev only: proves editing against the real Docs API with the device's own
// token, on the Mac where the device signed in. It creates a scratch doc,
// edits and formats it through saveDoc the way the page does (blocks), plays
// a buddy who edits at the same time, and checks the result in Google's own
// data. Then it moves the scratch doc to the trash.
// On the M5, with Live's Node and the installed code:
//   ssh macbook "cd '<User Library>/Google Docs/app/node' && GOOGLE_JS=./google.js '<Live's node>' -" < tools/edit-check.cjs
const assert = require('node:assert/strict');
const path = require('node:path');

const { createGoogle } = require(path.resolve(process.env.GOOGLE_JS ?? path.join(__dirname, '..', 'node', 'google.js')));
const google = createGoogle({ openUrl: () => {} });
const DOCS = 'https://docs.googleapis.com/v1/documents';
const para = (runs, style = 'NORMAL_TEXT', list = 'none') => ({ type: 'p', style, list, level: 0, runs: runs.map(([text, f]) => ({ text, f })) });

async function main() {
  const id = await google.createDoc('ableton-google-docs edit check (scratch, in the trash)');
  console.log('created scratch doc');
  try {
    // "chorus" bold, as if made in Google Docs.
    await google.api(`${DOCS}/${id}:batchUpdate`, {
      method: 'POST',
      body: {
        requests: [
          { insertText: { location: { index: 1 }, text: 'Verse one\nchorus line\nlast line' } },
          { updateTextStyle: { range: { startIndex: 11, endIndex: 17 }, textStyle: { bold: true }, fields: 'bold' } },
        ],
      },
    });
    let doc = await google.readDoc(id);
    assert.deepEqual(doc.blocks, [para([['Verse one', 0]]), para([['chorus', 1], [' line', 0]]), para([['last line', 0]])]);

    // Saves from the page: each starts from the doc the page shows (base).
    const save = async (blocks) => {
      doc = await google.saveDoc(doc, doc, blocks);
      return doc;
    };
    await save([para([['Verse one', 0]]), para([['chorus', 1], [' line, louder', 0]]), para([['last line', 0]])]);
    await save([para([['Verse 1', 0]]), para([['chorus', 1], [' line, louder', 0]]), para([['last line', 0]])]);
    await save([para([['Verse 1', 0]]), para([['chorus', 1], [' line, louder', 0]])]);
    assert.equal(doc.text, 'Verse 1\nchorus line, louder\n');
    console.log('text ok: insert, replace, delete the last line');

    const wanted = [
      para([['Verse 1', 0]], 'HEADING_1'),
      para([['chorus', 1], [' line, ', 0], ['louder', 2]]),
      para([['first', 0]], 'NORMAL_TEXT', 'bullet'),
      para([['second', 4]], 'NORMAL_TEXT', 'bullet'),
      para([['one', 8]], 'NORMAL_TEXT', 'number'),
    ];
    await save(wanted);
    assert.deepEqual(doc.blocks, wanted);
    console.log('formatting ok: heading, bold kept, italic, underline, strikethrough, bullets, numbers, lines added at the end');

    await save([wanted[0], wanted[1], { ...wanted[2], list: 'none' }, wanted[3], wanted[4]]);
    assert.equal(doc.blocks[2].list, 'none');
    assert.equal(doc.blocks[3].list, 'bullet');
    console.log('list removed from one line only');

    // A buddy edits through the API (another collaborator for Google).
    const buddy = (requests) => google.api(`${DOCS}/${id}:batchUpdate`, { method: 'POST', body: { requests } });
    const index = (d, text) => d.pos[d.text.indexOf(text)];

    // 1. The device has not seen the buddy's change yet: Google merges.
    const base1 = doc;
    await buddy([{ insertText: { location: { index: index(base1, 'Verse 1') }, text: 'Buddy: ' } }]);
    const page1 = structuredClone(base1.blocks);
    page1[1].runs.at(-1).text += '!';
    doc = await google.saveDoc(base1, base1, page1);
    assert.equal(doc.text.split('\n')[0], 'Buddy: Verse 1');
    assert.equal(doc.text.split('\n')[1], 'chorus line, louder!');
    console.log('merge ok: a change the device had not seen yet is kept (Google merges)');

    // 2. The device has seen the buddy's change (the change check read it),
    // the page has not taken it yet: the device moves its change.
    const base2 = doc;
    await buddy([
      { insertText: { location: { index: index(base2, 'one') }, text: 'number ' } },
      { updateTextStyle: { range: { startIndex: index(base2, 'first'), endIndex: index(base2, 'first') + 5 }, textStyle: { bold: true }, fields: 'bold' } },
    ]);
    const latest2 = await google.readDoc(id);
    const page2 = structuredClone(base2.blocks);
    page2[0].runs = [{ text: 'Buddy: Verse 1', f: 2 }];
    doc = await google.saveDoc(latest2, base2, page2);
    assert.deepEqual(doc.blocks[0].runs, [{ text: 'Buddy: Verse 1', f: 2 }], 'the page made the first line italic');
    assert.deepEqual(doc.blocks[2].runs, [{ text: 'first', f: 1 }], 'the buddy made "first" bold, and it stays');
    assert.equal(doc.text.split('\n')[4], 'number one', 'the buddy text stays');
    console.log('merge ok: a change the device had seen is kept, also the buddy\'s formatting');

    // 3. Both changed the same line: refused, nothing overwritten.
    const base3 = doc;
    await buddy([{ insertText: { location: { index: index(base3, 'second') }, text: 'Their ' } }]);
    const latest3 = await google.readDoc(id);
    const page3 = structuredClone(base3.blocks);
    page3[3].runs[0].text = 'My second';
    await assert.rejects(google.saveDoc(latest3, base3, page3), (error) => error.code === 'conflict');
    const after = await google.readDoc(id);
    assert.equal(after.text.split('\n')[3], 'Their second');
    console.log('conflict ok: both changed the same line; refused, the buddy\'s text kept');
  } finally {
    await google.api(`https://www.googleapis.com/drive/v3/files/${id}`, { method: 'PATCH', body: { trashed: true } });
    console.log('scratch doc moved to the trash');
  }
}

main().then(
  () => console.log('RESULT: ok'),
  (error) => {
    console.error(`RESULT: failed: ${error.message}`);
    process.exit(1);
  },
);
