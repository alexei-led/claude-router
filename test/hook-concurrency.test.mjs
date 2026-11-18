import assert from 'node:assert/strict';
import test from 'node:test';
import { DECISIONS_PREFIX } from '../lib/decisions.mjs';
import { answering, controls, drain, harness, JEV_KEY, step } from './harness.mjs';
import { assistant, jevResponse, user } from './helpers.mjs';

const control = (tree, key) => {
  const found = controls(tree).find((node) => node.key === key);
  assert.ok(found, `no control ${key}`);
  return found;
};

test('two patches applied while the first view read is pending both stay in the view', async () => {
  const h = harness();
  const tree = await h.render();
  const tab = control(tree, 'tab-usage');
  const help = control(tree, 'help');
  const read = h.$.state.get;
  let releaseReads;
  const gate = new Promise((resolve) => {
    releaseReads = resolve;
  });
  let pending = 0;
  h.$.state.get = async (ref) => {
    pending += 1;
    await gate;
    return read(ref);
  };
  const first = tab.onPress();
  const second = help.onPress();
  while (pending < 2) await new Promise((resolve) => setImmediate(resolve));
  releaseReads();
  await Promise.all([first, second]);
  assert.equal(h.view().tab, 'usage');
  assert.equal(h.view().help, true);
});

test('turns that end while the decision record is being read all keep their rows', async () => {
  const h = harness(JEV_KEY);
  answering(h, jevResponse('high', { micro: 0, low: 0, medium: 0.05, high: 0.95, uncertain: 0 }, 0.2));
  await h.event('session.start', { cwd: '/fixture' });
  const ids = ['t1', 't2'];
  for (const turnId of ids) {
    const text = `Task ${turnId}.`;
    await h.submit({ text, origin: { kind: 'composer' }, wait: false }, () => h.event('turn.start', { turnId, text }));
    h.messages(async () => [user(text)]);
    await drain(h.step({ ...step, turnId, messageCount: 1 }));
  }
  h.messages(async () => [user('Task.'), assistant('done')]);
  const read = h.$.store.get;
  let releaseReads;
  const gate = new Promise((resolve) => {
    releaseReads = resolve;
  });
  let pending = 0;
  h.$.store.get = async (key) => {
    if (!key.startsWith(DECISIONS_PREFIX)) return read(key);
    pending += 1;
    await gate;
    return read(key);
  };
  const ended = ids.map((turnId) => h.event('turn.complete', { turnId }));
  while (pending < 2) await new Promise((resolve) => setImmediate(resolve));
  releaseReads();
  await Promise.all(ended);
  const rows = h.preferences.get(`${DECISIONS_PREFIX}s1`).rows;
  assert.equal(rows.filter((row) => row.kind === 'end').length, 2);
});

test('a submission that finishes first leaves the later one its origin', async () => {
  const h = harness(JEV_KEY);
  answering(h, jevResponse('high', { micro: 0, low: 0, medium: 0.05, high: 0.95, uncertain: 0 }, 0.2));
  await h.event('session.start', { cwd: '/fixture' });
  let releaseFirst;
  let releaseSecond;
  const firstGate = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  const secondGate = new Promise((resolve) => {
    releaseSecond = resolve;
  });
  const first = h.submit({ text: 'First.', origin: { kind: 'peer' }, wait: false }, () => firstGate);
  const second = h.submit({ text: 'Second.', origin: { kind: 'composer' }, wait: false }, async () => {
    await secondGate;
    await h.event('turn.start', { turnId: 't2', text: 'Second.' });
  });
  releaseFirst();
  await first;
  releaseSecond();
  await second;
  h.messages(async () => [user('Second.')]);
  await drain(h.step({ ...step, turnId: 't2', messageCount: 1 }));
  await h.event('turn.complete', { turnId: 't2' });
  assert.equal(h.preferences.get(`${DECISIONS_PREFIX}s1`).rows[0].origin, 'composer');
});
