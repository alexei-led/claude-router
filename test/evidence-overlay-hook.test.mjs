// The hook reads the private overlay once per session; the file is optional and a bad one must never fail a turn.
import assert from 'node:assert/strict';
import test from 'node:test';
import { CONFIG, drain, harness, press, step, traceOf } from './harness.mjs';

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
  return traceOf(h);
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

test('a pane save keeps the overlay-filled capability on the adopted config', async () => {
  const h = harness();
  h.env.set('HOME', HOME);
  h.files.set(
    OVERLAY,
    overlayModule({
      'claude-opus-5-5': { aliases: ['claude-opus-5-5'], capability: { high: { default: 1, code: 1 } } },
    }),
  );
  // Every other model is too small for the turn's context, so the target can only be the incumbent opus.
  h.files.set(
    CONFIG,
    JSON.stringify({
      routingEngine: 'auto',
      baselineTier: 'low',
      models: { haiku: { contextWindow: 100 }, sonnet: { contextWindow: 100 }, fable: { contextWindow: 100 } },
      policy: { reviewEveryRequests: 0 },
    }),
  );
  h.model('claude-opus-5-5');
  const native = { ...step, model: 'claude-opus-5-5', effort: 'high', contextTokens: 1000 };
  await h.event('session.start', { cwd: '/fixture' });
  await h.event('turn.start', { turnId: 't1', text: 'One edit.' });
  await drain(h.step(native));
  await press(h, 'tab-routes');
  await press(h, 'tab-policy');
  await press(h, 'horizon', '10');
  await press(h, 'save-routing');
  await h.event('turn.start', { turnId: 't2', text: 'Two edits.' });
  await drain(h.step({ ...native, turnId: 't2' }));
  assert.equal(h.loop().decision.auto.capability, 1);
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
