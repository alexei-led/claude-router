import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ALLOWED,
  advanceRun,
  agrees,
  emptySession,
  emptyStore,
  OBSERVED,
  readStore,
  recordStore,
  recordTurn,
  turnActivity,
} from '../lib/activity-stats.mjs';
import { ACTIVITIES, DEFAULTS } from '../lib/config.mjs';

const turn = (extra = {}) => ({
  activity: 'code',
  observed: 'code',
  requests: 3,
  inputTokens: 1000,
  outputTokens: 200,
  tierSwitches: 0,
  activitySwitches: 0,
  wouldDiffer: null,
  shadow: false,
  ...extra,
});

test('every activity allows a set of buckets, and agreement follows it', () => {
  assert.deepEqual(Object.keys(ALLOWED), ACTIVITIES);
  for (const [predicted, observed, expected] of [
    ['code', 'code', true],
    ['code', 'ops', false],
    ['code', 'docs', false],
    ['debug', 'code', true],
    ['debug', 'ops', true],
    ['debug', 'read', true],
    ['debug', 'talk', false],
    ['explore', 'read', true],
    ['explore', 'talk', true],
    ['explore', 'code', false],
    ['plan', 'docs', true],
    ['plan', 'ops', false],
    ['review', 'read', true],
    ['review', 'docs', false],
    ['ops', 'ops', true],
    ['ops', 'read', false],
    ['docs', 'docs', true],
    ['docs', 'code', false],
    ['uncertain', 'talk', false],
    [null, 'talk', false],
    ['code', undefined, false],
  ])
    assert.equal(agrees(predicted, observed), expected, `${predicted} vs ${observed}`);
  for (const buckets of Object.values(ALLOWED)) for (const b of buckets) assert.ok(OBSERVED.includes(b), b);
});

test('a session accumulates turns, requests and tokens per activity, and none without a label', () => {
  let session = emptySession();
  session = recordTurn(session, turn());
  session = recordTurn(session, turn({ requests: 2, inputTokens: 500, outputTokens: 50 }));
  session = recordTurn(session, turn({ activity: 'ops', observed: 'ops', requests: 1 }));
  session = recordTurn(session, turn({ activity: null, observed: 'talk', requests: 4 }));
  assert.deepEqual(session.byActivity, {
    code: { turns: 2, requests: 5, inputTokens: 1500, outputTokens: 250 },
    ops: { turns: 1, requests: 1, inputTokens: 1000, outputTokens: 200 },
    none: { turns: 1, requests: 4, inputTokens: 1000, outputTokens: 200 },
  });
});

test('session agreement counts only turns with a predicted activity', () => {
  let session = emptySession();
  for (const [activity, observed] of [
    ['code', 'code'],
    ['code', 'ops'],
    ['explore', 'talk'],
    [null, 'code'],
    [null, 'talk'],
  ])
    session = recordTurn(session, turn({ activity, observed }));
  assert.deepEqual(session.agreement, { matched: 2, total: 3 });
});

test('session switches and shadow counters add up', () => {
  let session = emptySession();
  for (const extra of [
    { tierSwitches: 1, shadow: true, wouldDiffer: true },
    { activitySwitches: 2, shadow: true, wouldDiffer: false },
    { shadow: true, wouldDiffer: null },
    { tierSwitches: 1, activitySwitches: 1, wouldDiffer: true },
  ])
    session = recordTurn(session, turn(extra));
  assert.deepEqual(session.switches, { tier: 2, activity: 3 });
  assert.deepEqual(session.shadow, { differs: 1, turns: 3 });
});

test('recordTurn returns a new session and treats bad numbers as zero', () => {
  const before = emptySession();
  const after = recordTurn(
    before,
    turn({ requests: Number.NaN, inputTokens: -5, outputTokens: undefined, tierSwitches: 'x' }),
  );
  assert.deepEqual(before, emptySession());
  assert.deepEqual(after.byActivity.code, { turns: 1, requests: 0, inputTokens: 0, outputTokens: 0 });
  assert.deepEqual(after.switches, { tier: 0, activity: 0 });
});

test('the store counts a predicted x observed matrix, with none for a missing prediction', () => {
  let store = emptyStore();
  for (const [predicted, observed] of [
    ['code', 'code'],
    ['code', 'code'],
    ['code', 'ops'],
    ['uncertain', 'talk'],
    [null, 'read'],
  ])
    store = recordStore(store, { predicted, observed, runEnded: null, lateral: null, wouldDiffer: null });
  assert.deepEqual(store.confusion, {
    code: { code: 2, ops: 1 },
    uncertain: { talk: 1 },
    none: { read: 1 },
  });
});

test('the store buckets run lengths 1, 2, 3, 4 and 5 or more', () => {
  let store = emptyStore();
  for (const length of [1, 2, 2, 3, 4, 5, 6, 40])
    store = recordStore(store, {
      predicted: null,
      observed: 'talk',
      runEnded: { activity: 'ops', length },
      lateral: null,
      wouldDiffer: null,
    });
  assert.deepEqual(store.runs, { ops: [1, 2, 1, 1, 3] });
});

test('the store counts lateral outcomes and the shadow readout', () => {
  let store = emptyStore();
  for (const [lateral, wouldDiffer] of [
    ['taken', true],
    ['refused', false],
    ['refused', null],
    [null, true],
    ['sideways', undefined],
  ])
    store = recordStore(store, { predicted: 'ops', observed: 'ops', runEnded: null, lateral, wouldDiffer });
  assert.deepEqual(store.lateral, { taken: 1, refused: 2 });
  assert.deepEqual(store.shadow, { differs: 2, turns: 3 });
});

test('the store drops labels it does not know, so its key set stays fixed', () => {
  const store = recordStore(emptyStore(), {
    predicted: '__proto__',
    observed: 'code',
    runEnded: { activity: 'uncertain', length: 2 },
    lateral: null,
    wouldDiffer: null,
  });
  assert.deepEqual(store, emptyStore());
  const badObserved = recordStore(emptyStore(), {
    predicted: 'code',
    observed: 'sleep',
    runEnded: { activity: 'code', length: 0 },
    lateral: null,
    wouldDiffer: null,
  });
  assert.deepEqual(badObserved, emptyStore());
});

test('recordStore does not change the store it was given', () => {
  const store = readStore(
    recordStore(emptyStore(), {
      predicted: 'code',
      observed: 'code',
      runEnded: { activity: 'code', length: 2 },
      lateral: 'taken',
      wouldDiffer: true,
    }),
  );
  const copy = structuredClone(store);
  recordStore(store, {
    predicted: 'code',
    observed: 'ops',
    runEnded: { activity: 'code', length: 9 },
    lateral: 'refused',
    wouldDiffer: false,
  });
  assert.deepEqual(store, copy);
});

test('readStore keeps a valid store and falls back to an empty one for any bad shape', () => {
  const valid = {
    version: 1,
    confusion: { code: { code: 4, ops: 1 }, none: { talk: 2 } },
    runs: { code: [1, 0, 2, 0, 3] },
    lateral: { taken: 2, refused: 1 },
    shadow: { differs: 3, turns: 10 },
  };
  assert.deepEqual(readStore(valid), valid);
  assert.deepEqual(readStore(structuredClone(emptyStore())), emptyStore());
  const mutate = (change) => {
    const copy = structuredClone(valid);
    change(copy);
    return copy;
  };
  for (const [name, value] of [
    ['undefined', undefined],
    ['null', null],
    ['a string', '{"version":1}'],
    ['an array', []],
    ['an empty object', {}],
    ['a future version', mutate((v) => (v.version = 2))],
    ['no version', mutate((v) => delete v.version)],
    ['an extra top-level key', mutate((v) => (v.text = 'hello'))],
    ['missing runs', mutate((v) => delete v.runs)],
    ['confusion as an array', mutate((v) => (v.confusion = []))],
    ['an unknown predicted row', mutate((v) => (v.confusion.guess = { code: 1 }))],
    ['an unknown observed bucket', mutate((v) => (v.confusion.code.sleep = 1))],
    ['a row that is not an object', mutate((v) => (v.confusion.code = 5))],
    ['a negative count', mutate((v) => (v.confusion.code.code = -1))],
    ['a fractional count', mutate((v) => (v.confusion.code.code = 1.5))],
    ['a string count', mutate((v) => (v.confusion.code.code = '4'))],
    ['a NaN count', mutate((v) => (v.lateral.taken = Number.NaN))],
    ['uncertain as a run activity', mutate((v) => (v.runs.uncertain = [0, 0, 0, 0, 0]))],
    ['too few run buckets', mutate((v) => (v.runs.code = [1, 2, 3, 4]))],
    ['too many run buckets', mutate((v) => (v.runs.code = [1, 2, 3, 4, 5, 6]))],
    ['runs as an object', mutate((v) => (v.runs.code = { 0: 1 }))],
    ['a non-count run bucket', mutate((v) => (v.runs.code[2] = null))],
    ['lateral missing a key', mutate((v) => delete v.lateral.refused)],
    ['lateral with an extra key', mutate((v) => (v.lateral.other = 1))],
    ['shadow missing a key', mutate((v) => delete v.shadow.turns)],
    ['shadow as a number', mutate((v) => (v.shadow = 7))],
  ])
    assert.deepEqual(readStore(value), emptyStore(), name);
});

test('advanceRun extends a run of the same activity and closes it on a change', () => {
  let run = null;
  const seen = [];
  for (const predicted of ['code', 'code', 'ops', 'code', 'code', 'code']) {
    const step = advanceRun(run, predicted);
    run = step.run;
    seen.push(step.ended);
  }
  assert.deepEqual(seen, [null, null, { activity: 'code', length: 2 }, { activity: 'ops', length: 1 }, null, null]);
  assert.deepEqual(run, { activity: 'code', length: 3 });
});

test('a missing or uncertain prediction ends the run and starts none', () => {
  for (const predicted of [null, 'uncertain', undefined, 'bogus']) {
    assert.deepEqual(advanceRun({ activity: 'plan', length: 4 }, predicted), {
      run: null,
      ended: { activity: 'plan', length: 4 },
    });
    assert.deepEqual(advanceRun(null, predicted), { run: null, ended: null });
  }
});

test('a run closed by advanceRun feeds the store', () => {
  let run = null;
  let store = emptyStore();
  for (const predicted of ['ops', 'ops', 'ops', 'code']) {
    const step = advanceRun(run, predicted);
    run = step.run;
    store = recordStore(store, { predicted, observed: 'ops', runEnded: step.ended, lateral: null, wouldDiffer: null });
  }
  assert.deepEqual(store.runs, { ops: [0, 0, 1, 0, 0] });
});

test('turnActivity labels a routed turn per mode and names what moved the route', () => {
  const config = (activityRouting) => ({ ...DEFAULTS, activityRouting });
  const advice = (choice, mass) => ({ activity: { choice, probabilities: { [choice]: mass } } });
  const sonnet = { model: 'claude-sonnet-5-5', effort: 'medium', tier: 'low' };
  const haiku = { model: 'claude-haiku-5-5', effort: 'high', tier: 'low' };
  const opus = { model: 'claude-opus-5-5', effort: 'medium', tier: 'medium' };
  for (const [name, mode, answer, previous, decision, expected] of [
    [
      'on: a lateral move down',
      'on',
      advice('ops', 0.81),
      sonnet,
      { ...haiku, activity: 'ops', reason: 'activity-down' },
      { label: 'ops', predicted: 'ops', switched: 'activity', lateral: 'taken', wouldDiffer: null },
    ],
    [
      'on: a refused move keeps the route',
      'on',
      advice('ops', 0.81),
      sonnet,
      { ...sonnet, activity: 'code', reason: 'activity-pending' },
      { label: 'code', predicted: 'ops', switched: null, lateral: 'refused', wouldDiffer: null },
    ],
    [
      'on: a tier move',
      'on',
      advice('code', 0.9),
      haiku,
      { ...opus, activity: 'code', reason: 'upgrade' },
      { label: 'code', predicted: 'code', switched: 'tier', lateral: null, wouldDiffer: null },
    ],
    [
      'on: an effort change is a switch',
      'on',
      null,
      sonnet,
      { ...sonnet, effort: 'high', activity: null, reason: 'context-fit' },
      { label: null, predicted: null, switched: 'tier', lateral: null, wouldDiffer: null },
    ],
    [
      'on: a pin is no switch',
      'on',
      null,
      haiku,
      { ...opus, activity: null, reason: 'pinned', pinned: true },
      { label: null, predicted: null, switched: null, lateral: null, wouldDiffer: null },
    ],
    [
      'shadow: the accepted label and what on would do',
      'shadow',
      advice('code', 0.7),
      haiku,
      { ...haiku, activity: null, reason: 'hold', wouldRoute: { ...sonnet, activity: 'code', reason: 'activity-up' } },
      { label: 'code', predicted: 'code', switched: null, lateral: 'taken', wouldDiffer: true },
    ],
    [
      'shadow: a weak label is none, the same route does not differ',
      'shadow',
      advice('code', 0.5),
      null,
      { ...haiku, activity: null, reason: 'hold', wouldRoute: { ...haiku, activity: null, reason: 'hold' } },
      { label: null, predicted: 'code', switched: null, lateral: null, wouldDiffer: false },
    ],
    [
      'shadow: uncertain is predicted but not a label',
      'shadow',
      advice('uncertain', 0.9),
      haiku,
      { ...haiku, activity: null, reason: 'hold', wouldRoute: null },
      { label: null, predicted: 'uncertain', switched: null, lateral: null, wouldDiffer: false },
    ],
    [
      'off: nothing',
      'off',
      null,
      haiku,
      { ...haiku, activity: null, reason: 'hold', wouldRoute: null },
      { label: null, predicted: null, switched: null, lateral: null, wouldDiffer: null },
    ],
  ])
    assert.deepEqual(turnActivity(config(mode), answer, previous, decision), { mode, ...expected }, name);
});
