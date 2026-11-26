// What a shadow row records beside the table's route: the counterfactual auto move, the stronger candidates that were
// excluded and the routing profile.
import assert from 'node:assert/strict';
import test from 'node:test';
import { DECISIONS_PREFIX } from '../lib/decisions.mjs';
import { answering, CONFIG, drain, harness, JEV_KEY, step } from './harness.mjs';
import { assistant, jevResponse, user } from './helpers.mjs';

const MODELS = {
  haiku: { capability: { low: 0, medium: 0.5, high: 1, xhigh: 1.5, max: 1.5 } },
  sonnet: { capability: { low: 1, medium: 1.5, high: 2, xhigh: 2, max: 2 } },
  opus: { capability: { low: 2, medium: 2.5, high: 3, xhigh: 3, max: 3 } },
  fable: { capability: { low: 3, medium: 3, high: 3, xhigh: 3, max: 3 } },
};
const HIGH = jevResponse('high', { high: 1 });
const LOW = jevResponse('low', { low: 1 });

async function shadowSession(config = {}, advice = HIGH) {
  const h = harness(JEV_KEY);
  h.files.set(CONFIG, JSON.stringify({ routingEngine: 'shadow', models: MODELS, ...config }));
  answering(h, advice);
  await h.event('session.start', { cwd: '/fixture' });
  return h;
}

async function turn(h, turnId, text = 'A task.') {
  const messages = [user(text)];
  await h.submit({ text, origin: { kind: 'composer' }, wait: false }, () => h.event('turn.start', { turnId, text }));
  h.messages(async () => messages);
  await drain(h.step({ ...step, turnId, messageCount: messages.length }));
  h.messages(async () => [...messages, assistant('done')]);
  await h.event('turn.complete', { turnId });
  return h.preferences
    .get(`${DECISIONS_PREFIX}s1`)
    .rows.filter((row) => row.kind === 'start')
    .at(-1);
}

test('a held downgrade would serve the incumbent, with the reason auto holds it', async () => {
  const h = await shadowSession({ policy: { downgradeVotes: 1 } });
  const first = await turn(h, 't1');
  // The same task, so the table's cheaper route waits for a checkpoint.
  answering(h, jevResponse('low', { low: 1 }, 0.95));
  const row = await turn(h, 't2');
  assert.equal(row.reason, 'downgrade-held', 'the table holds its own downgrade');
  assert.equal(row.route, first.route);
  assert.equal(row.alt.move, 'dwell-held');
  assert.equal(row.alt.serve, 'opus@xhigh');
  assert.equal(row.route, 'claude-opus-5-5@xhigh');
  assert.notEqual(row.alt.serve, row.alt.route, 'the ungated target differs from what auto would serve');
});

test('a move auto would make serves its target', async () => {
  const h = await shadowSession();
  const row = await turn(h, 't1');
  assert.equal(row.alt.move, 'startup');
  assert.equal(row.alt.serve, row.alt.route);
  assert.equal(row.alt.incumbentCap, 0.5);
});

test('a pinned turn would serve its target without a move gate', async () => {
  const h = await shadowSession();
  await h.event('command.run', { command: 'router', args: 'pin high' });
  const row = await turn(h, 't1');
  assert.equal(row.alt.move, 'pinned');
  assert.equal(row.alt.serve, row.alt.route);
});

test('a keyword turn records no counterfactual: shadow demand does not model keywords', async () => {
  const h = await shadowSession();
  const row = await turn(h, 't1', 'maxthink about the design.');
  assert.equal(row.alt.move, 'unavailable');
  assert.equal(Object.hasOwn(row.alt, 'serve'), false);
});

test('an incumbent without capability after the first turn records no counterfactual', async () => {
  const none = Object.fromEntries(Object.keys(MODELS).map((alias) => [alias, { capability: {} }]));
  const h = await shadowSession({ models: none });
  await turn(h, 't1');
  const row = await turn(h, 't2');
  assert.equal(row.alt.move, 'unavailable');
  assert.equal(Object.hasOwn(row.alt, 'serve'), false);
  assert.equal(Object.hasOwn(row.alt, 'incumbentCap'), false);
});

test('a stronger candidate over the cash cap is recorded as blocked, cheapest first', async () => {
  const h = await shadowSession({
    models: { ...MODELS, fable: { ...MODELS.fable, billing: 'credits' } },
    policy: { cashCapUsd: 0 },
  });
  const { alt } = await turn(h, 't1');
  assert.ok(alt.blocked.length >= 1 && alt.blocked.length <= 3);
  for (const { route, reasons } of alt.blocked) {
    assert.match(route, /^fable@/);
    assert.deepEqual(reasons, ['cash-cap']);
  }
});

test('a row with every stronger candidate eligible has no blocked field', async () => {
  const h = await shadowSession();
  assert.equal(Object.hasOwn((await turn(h, 't1')).alt, 'blocked'), false);
});

test('the profile tag splits rows by model catalog and holds no path', async () => {
  const tags = [];
  for (const id of ['claude-opus-5-5', 'claude-opus-5-5', 'acme/opus-next']) {
    const h = await shadowSession({ models: { ...MODELS, opus: { ...MODELS.opus, id } } });
    tags.push((await turn(h, 't1')).alt.profile);
  }
  assert.match(tags[0], /^anthropic\.[0-9a-f]{8}$/);
  assert.equal(tags[1], tags[0]);
  assert.notEqual(tags[2], tags[0]);
});

test('the counterfactual leaves no route history in the shadow demand state', async () => {
  const h = await shadowSession({ policy: { downgradeVotes: 1 } });
  await turn(h, 't1');
  const first = structuredClone(h.loop().shadow.state);
  assert.equal(Object.hasOwn(first, 'routedDemand'), false);
  assert.equal(Object.hasOwn(first, 'routeCause'), false);
  answering(h, LOW);
  await turn(h, 't2');
  assert.deepEqual(h.loop().shadow.state, { ...first, turn: 2, demand: 1, votes: [3, 1] });
});

test('the decisions listing names what auto would serve and why', async () => {
  const h = await shadowSession();
  const row = await turn(h, 't1');
  const listing = await h.event('command.run', { command: 'router', args: 'decisions' });
  assert.ok(listing.text.includes(`auto would serve ${row.alt.serve} (startup)`), listing.text);
});
