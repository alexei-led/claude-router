import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { housekeeping, readJsonFile, rotate, saveMemory } from '../lib/store.mjs';

const tempDir = () => mkdtempSync(join(tmpdir(), 'store-'));

// The hook prints this error into the session. V8's JSON message quotes the text around the bad token.
test('a malformed JSON file names the file, not its content', () => {
  const path = join(tempDir(), 'router.json');
  writeFileSync(path, '{ "jev": { "endpoint": https://example.test/SECRET-FRAGMENT } }');
  assert.throws(
    () => readJsonFile(path),
    (error) => error.message === `cannot read ${path}: not valid JSON`,
  );
  assert.equal(readJsonFile(join(tempDir(), 'missing.json')), null);
});

test('rotate keeps one previous generation once the file passes the limit', () => {
  const path = join(tempDir(), 'decisions.jsonl');
  rotate(path, 10);
  writeFileSync(path, 'short');
  rotate(path, 10);
  assert.equal(readFileSync(path, 'utf8'), 'short');
  writeFileSync(path, 'x'.repeat(11));
  rotate(path, 10);
  assert.equal(existsSync(path), false);
  assert.equal(readFileSync(`${path}.1`, 'utf8'), 'x'.repeat(11));
});

test('housekeeping drops session memory older than a month and keeps the rest', () => {
  const dir = tempDir();
  saveMemory(dir, 'old', { lastRoute: 'low' });
  saveMemory(dir, 'fresh', { lastRoute: 'high' });
  const monthAgo = new Date(Date.now() - 31 * 24 * 3_600_000);
  utimesSync(join(dir, 'sessions', 'old.json'), monthAgo, monthAgo);
  housekeeping(dir);
  assert.deepEqual(readdirSync(join(dir, 'sessions')), ['fresh.json']);
});

test('housekeeping of an empty data directory does nothing', () => {
  assert.doesNotThrow(() => housekeeping(tempDir()));
});
