#!/usr/bin/env node
// Dev only: checks the Google API part of the device without a sign-in. With
// an access token from GOOGLE_ACCESS_TOKEN it lists docs (count only) and
// reads one doc through the same code the device uses. Prints no doc names.
// Usage: GOOGLE_ACCESS_TOKEN=… node tools/api-check.mjs <doc link or id>
import { mkdtemp, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { createGoogle } = require('../node/google.js');

const link = process.argv[2];
const accessToken = process.env.GOOGLE_ACCESS_TOKEN;
if (!link || !accessToken) {
  console.error('usage: GOOGLE_ACCESS_TOKEN=… node tools/api-check.mjs <doc link or id>');
  process.exit(2);
}
// A throwaway secrets folder: the given token, valid for this run only.
const dir = await mkdtemp(path.join(tmpdir(), 'gdocs-check-'));
await writeFile(path.join(dir, 'token.json'), JSON.stringify({ refresh_token: 'unused', access_token: accessToken, expires_at: Date.now() + 30 * 60 * 1000 }), { mode: 0o600 });
await writeFile(path.join(dir, 'client.json'), JSON.stringify({ installed: { client_id: 'unused', client_secret: 'unused' } }));
const google = createGoogle({ dir, openUrl: () => {} });

const recent = await google.listDocs('');
console.log(`doc list: ${recent.length} docs, newest changed ${recent[0]?.modifiedTime ?? '-'}`);
const doc = await google.readDoc(link);
console.log(`read: "${doc.title}", tabs ${doc.tabIds.length}, ${doc.text.length} characters, revision ${doc.revisionId ? 'present' : 'missing'}`);
