import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

const root = new URL('../', import.meta.url);

test('the plugin root has no lockfile, so Claude Code installs no packages with the plugin', () => {
  for (const lockfile of [
    'package-lock.json',
    'npm-shrinkwrap.json',
    'bun.lock',
    'bun.lockb',
    'yarn.lock',
    'pnpm-lock.yaml',
  ]) {
    assert.equal(existsSync(new URL(lockfile, root)), false, `${lockfile} at the plugin root`);
  }
});

test('the root package.json declares no dependencies of any kind', () => {
  const pkg = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'));
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
    assert.equal(pkg[field], undefined, `${field} in package.json`);
  }
});
