// The hook reads the private overlay once per session; the file is optional and a bad one must never fail a turn.
import assert from 'node:assert/strict';
import test from 'node:test';
import { TRACE_PREFIX } from '../lib/replay-trace.mjs';
import { CONFIG, drain, harness, step } from './harness.mjs';

const HOME = '/fixture/home';
const OVERLAY = `${HOME}/.config/claude-router/evidence.local.mjs`;
const overlayModule = (entries) =>
  `export const EVIDENCE_LOCAL = ${JSON.stringify({
    checked: '2026-11-22',
    source: 'https://artificialanalysis.ai/',
    tier: 'free',
    entries,
  })};`;

const OPUS = { aliases: ['claude-opus-5-5'], capability: { high: { default: 2, code: 2.5 } } };

function fixture(text) {
  const h = harness();
  h.env.set('HOME', HOME);
  if (text !== undefined) h.files.set(OVERLAY, text);
  h.files.set(
    CONFIG,
    JSON.stringify({
      routingEngine: 'shadow',
      mode: 'quality',
      baselineTier: 'low',
      policy: { reviewEveryRequests: 0 },
    }),
  );
  return h;
}

async function turn(h) {
  await h.event('session.start', { cwd: '/fixture' });
  await h.event('turn.start', { turnId: 't1', text: 'One edit.' });
  await drain(h.step(step));
  await h.event('turn.complete', { turnId: 't1' });
  return h.preferences.get(`${TRACE_PREFIX}s1`);
}

test('the hook seeds a configured model from a valid private overlay', async () => {
  const record = await turn(fixture(overlayModule({ 'claude-opus-5-5': OPUS })));
  const capability = record.events[0].config.models.opus.capability;
  assert.deepEqual(capability.high, { default: 2, code: 2.5 });
  assert.equal(capability.medium, 2);
});

test('an absent overlay leaves the configured capability as it was', async () => {
  const record = await turn(fixture(undefined));
  assert.equal(record.events[0].config.models.opus.capability.high, undefined);
  assert.equal(record.events[0].config.models.opus.capability.medium, 2);
});

test('a malformed overlay never fails a session or a turn', async () => {
  for (const text of [
    'export const EVIDENCE_LOCAL = {',
    'export const EVIDENCE_LOCAL = "nonsense";',
    'throw new Error("broken overlay");',
  ]) {
    const h = fixture(text);
    const record = await turn(h);
    assert.ok(record, text);
    assert.equal(h.requests.length, 1, text);
    assert.equal(record.events[0].config.models.opus.capability.high, undefined, text);
  }
});
