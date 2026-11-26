// The replay trace hook keeps a session within its caps: whole turns only, sequenced, never a half-turn.
import assert from 'node:assert/strict';
import test from 'node:test';
import { storedBytes, TRACE_SESSION_BYTES, usableTrace } from '../lib/replay-trace.mjs';
import { drain, shadowHarness, step, traceOf } from './harness.mjs';
import { user } from './helpers.mjs';

const record = traceOf;

async function begin(h) {
  await h.event('session.start', { cwd: '/fixture' });
}

async function turn(h, id = 't1', messages = [user('Synthetic task.')]) {
  await h.event('turn.start', { turnId: id, text: 'Synthetic task.' });
  h.messages(async () => messages);
  await drain(h.step({ ...step, turnId: id, messageCount: messages.length }));
  await h.event('turn.complete', { turnId: id });
}

// A different long model list on every read: nothing the recorder can leave out, so a session fills quickly.
function growingSettings(h) {
  let reads = 0;
  h.$.settings.read = async () => {
    reads++;
    const extra = Array.from({ length: 600 + (reads % 2) }, (_, i) => `synthetic-model-${reads}-${i}`);
    return { availableModels: ['haiku', 'sonnet', 'opus', ...extra] };
  };
}

test('over 60 actual decisions remain sequenced; per-session cap preserves only whole-turn usable prefixes', async () => {
  const h = shadowHarness();
  await begin(h);
  for (let i = 0; i < 65; i++) await turn(h, `t${i}`);
  assert.equal(record(h).capped, null);
  assert.equal(record(h).events.filter((e) => e.type === 'request').length, 65);
  growingSettings(h);
  for (let i = 65; i < 105; i++) await turn(h, `t${i}`);
  const trace = record(h);
  assert.ok(storedBytes(trace) <= TRACE_SESSION_BYTES);
  assert.ok(trace.capped.turns > 0);
  assert.equal(trace.capped.events % 3, 0);
  assert.equal(usableTrace(trace), true);
  assert.equal(trace.events.at(-1).type, 'end');
});

test('a long single tool turn discards its entire batch and retains capped coverage, not a half-turn', async () => {
  const h = shadowHarness();
  await begin(h);
  await turn(h, 'first');
  const before = record(h).events;
  growingSettings(h);
  await h.event('turn.start', { turnId: 'long', text: 'Synthetic task.' });
  for (let i = 0; i < 50; i++) await drain(h.step({ ...step, turnId: 'long', index: i, messageCount: 2 }));
  await h.event('turn.complete', { turnId: 'long' });
  assert.deepEqual(record(h).events, before);
  assert.equal(record(h).capped.turns, 1);
  assert.ok(record(h).capped.events >= 101);
  assert.equal(usableTrace(record(h)), true);
  assert.equal(JSON.stringify(record(h)).includes('Synthetic task'), false);
});

for (const [name, recordedBehind] of [
  ['a recorded turn before the one that caps the trace', true],
  ['only the turn that caps the trace', false],
])
  test(`an unfinished turn followed by ${name} ${recordedBehind ? 'is a hole' : 'is no hole'}`, async () => {
    const h = shadowHarness();
    await begin(h);
    await turn(h, 'first');
    await h.event('turn.start', { turnId: 'open', text: 'Synthetic task.' });
    await drain(h.step({ ...step, turnId: 'open' }));
    if (recordedBehind) await turn(h, 'behind');
    assert.equal(record(h).capped, null);
    // A model list larger than the session budget: this turn alone caps the record.
    const availableModels = Array.from({ length: 40_000 }, (_, i) => `synthetic-model-${i}`);
    h.$.settings.read = async () => ({ availableModels: ['haiku', 'sonnet', 'opus', ...availableModels] });
    await turn(h, 'capping');
    assert.equal(record(h).capped.turns, 1);
    await h.event('session.end', { reason: 'exit' });
    assert.equal(usableTrace(record(h)), !recordedBehind);
  });
