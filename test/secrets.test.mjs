// No Google credential and no home folder path in any file that git tracks
// or would add (untracked files outside .gitignore count too).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const PATTERNS = {
  'OAuth client ID': /\d+-[0-9a-z]{32}\.apps\.googleusercontent\.com/,
  'OAuth client secret': /GOCSPX-[\w-]{20,}/,
  'access token': /ya29\.[\w-]{20,}/,
  'refresh token': /\b1\/\/0[\w-]{20,}/,
  'home folder path': /\/Users\/\w/,
};

test('no credentials and no home folder paths in the repo', async () => {
  const files = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8' })
    .split('\0')
    .filter(Boolean);
  assert.ok(files.includes('node/google.js'), 'git lists the project files');
  const found = [];
  for (const file of files) {
    const text = await readFile(path.join(root, file), 'utf8').catch(() => '');
    for (const [what, pattern] of Object.entries(PATTERNS)) if (pattern.test(text)) found.push(`${file}: ${what}`);
  }
  assert.deepEqual(found, []);
});
