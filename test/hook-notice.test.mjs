import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import { CONFIG, harness, JEV_KEY } from './harness.mjs';

const REPL = { cwd: '/fixture', surface: 'terminal', isInteractive: true };
const DAY = 24 * 60 * 60 * 1000;

const CAUSES = {
  'an old Claude Code': (h) => h.version('2.1.289'),
  'v0.8 gateway settings': (h) => h.env.set('ANTHROPIC_BASE_URL', 'http://127.0.0.1:43170'),
  'a router.json that does not load': (h) => h.files.set(CONFIG, '{'),
};

test('a session that starts with routing unavailable toasts why, once', async () => {
  const wording = {
    'an old Claude Code': /requires Claude Code 2\.1\.321 or newer/,
    'v0.8 gateway settings': /v0\.8 gateway settings remain/,
    'a router.json that does not load': /invalid router configuration/,
  };
  for (const [cause, apply] of Object.entries(CAUSES)) {
    const h = harness(JEV_KEY);
    apply(h);
    await h.event('session.start', REPL);
    assert.equal(h.toasts.length, 1, cause);
    assert.match(h.toasts[0], wording[cause]);
    assert.match(h.toasts[0], /Claude’s model is kept/);
  }
});

test('the same cause toasts again only after a day, each cause on its own clock', async () => {
  mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
  try {
    const h = harness(JEV_KEY);
    CAUSES['an old Claude Code'](h);
    await h.event('session.start', REPL);
    await h.event('session.start', REPL);
    assert.equal(h.toasts.length, 1);
    mock.timers.setTime(1_000_000 + DAY - 1);
    await h.event('session.start', REPL);
    assert.equal(h.toasts.length, 1);
    mock.timers.setTime(1_000_000 + DAY);
    await h.event('session.start', REPL);
    assert.equal(h.toasts.length, 2);
    h.version('2.1.321');
    CAUSES['v0.8 gateway settings'](h);
    await h.event('session.start', REPL);
    assert.equal(h.toasts.length, 3);
  } finally {
    mock.timers.reset();
  }
});

test('a headless run or a session with no surface says nothing', async () => {
  for (const start of [{ ...REPL, isInteractive: false }, { ...REPL, surface: null }, { cwd: '/fixture' }]) {
    const h = harness(JEV_KEY);
    CAUSES['an old Claude Code'](h);
    await h.event('session.start', start);
    assert.deepEqual(h.toasts, [], JSON.stringify(start));
    assert.equal(h.view().phase, 'unavailable');
  }
});

test('a session where routing runs says nothing', async () => {
  const h = harness(JEV_KEY);
  await h.event('session.start', REPL);
  assert.deepEqual(h.toasts, []);
});

test('a store that fails keeps the session starting', async () => {
  const h = harness(JEV_KEY);
  CAUSES['an old Claude Code'](h);
  h.$.store.get = async () => {
    throw new Error('store down');
  };
  await h.event('session.start', REPL);
  assert.deepEqual(h.toasts, []);
});
