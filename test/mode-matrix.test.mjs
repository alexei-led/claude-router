import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { EFFORTS, loadConfig, ROUTING_MODES, rank, resolveRoute, TIERS } from '../lib/config.mjs';
import {
  ACTIVITY_ANSWERS,
  CLASSIFIED,
  DOC,
  decision,
  matrix,
  PROFILES,
  UNROUTED_MODEL,
  withMatrix,
} from '../scripts/mode-matrix.mjs';
import { CONFIG, drain, harness, JEV_KEY, start, step } from './harness.mjs';

const ENGINEERING = ['code', 'debug', 'plan', 'review'];
const REST = ['explore', 'docs', 'uncertain'];
const EVERY = [...ENGINEERING, ...REST, 'ops'];
// Golden routes, `model/effort` as [cost, balanced, quality], by classifier tier and activity group.
const GOLDEN = {
  defaults: {
    micro: [[EVERY, ['haiku/medium', 'haiku/medium', 'haiku/medium']]],
    low: [
      [ENGINEERING, ['sonnet/medium', 'sonnet/high', 'sonnet/xhigh']],
      [
        [...REST, 'ops'],
        ['haiku/medium', 'haiku/high', 'haiku/xhigh'],
      ],
    ],
    medium: [
      [ENGINEERING, ['sonnet/high', 'opus/medium', 'opus/high']],
      [REST, ['haiku/high', 'opus/medium', 'opus/high']],
      [['ops'], ['haiku/medium', 'haiku/high', 'haiku/xhigh']],
    ],
    high: [
      [
        [...ENGINEERING, ...REST],
        ['opus/high', 'opus/xhigh', 'opus/max'],
      ],
      [['ops'], ['haiku/high', 'opus/xhigh', 'opus/max']],
    ],
    // `uncertain` keeps the incumbent tier: a fresh session's is the baseline, low.
    uncertain: [
      [ENGINEERING, ['sonnet/medium', 'sonnet/high', 'sonnet/xhigh']],
      [
        [...REST, 'ops'],
        ['haiku/medium', 'haiku/high', 'haiku/xhigh'],
      ],
    ],
  },
  'opus-high': {
    high: [
      [
        [...ENGINEERING, ...REST],
        ['opus/medium', 'opus/high', 'opus/xhigh'],
      ],
      [['ops'], ['haiku/high', 'opus/high', 'opus/xhigh']],
    ],
  },
};
// Cells (of 40) where each mode routes differently from balanced: every one but micro's 8.
const DIFFERING = { defaults: { cost: 32, quality: 32 }, 'opus-high': { cost: 32, quality: 32 } };
// A session already on a routed model: Opus runs medium in both profiles, and the cost table runs it only at high.
const OPUS = 'claude-opus-5-5';
const DIFFERING_ON_OPUS = { defaults: { cost: 32, quality: 32 }, 'opus-high': { cost: 32, quality: 32 } };

const pairOf = (d) => `${d.route.model}/${d.route.effort}`;
const goldenOf = (profile) => ({ ...GOLDEN.defaults, ...GOLDEN[profile] });

for (const [profile, { file }] of Object.entries(PROFILES)) {
  const rows = matrix(file);
  const config = loadConfig({ userFile: file });

  test(`${profile}: an uncertain first turn on Opus keeps its configured tier, medium, in every mode`, () => {
    const onOpus = matrix(file, OPUS);
    for (const activity of ACTIVITY_ANSWERS)
      assert.deepEqual(onOpus.uncertain[activity], rows.medium[activity], activity);
  });

  test(`${profile}: every tier × activity × mode routes to its golden pair`, () => {
    const golden = goldenOf(profile);
    for (const tier of CLASSIFIED) {
      const covered = golden[tier].flatMap(([activities]) => activities);
      assert.deepEqual([...covered].sort(), [...ACTIVITY_ANSWERS].sort(), `${tier} covers every activity once`);
      for (const [activities, pairs] of golden[tier])
        for (const activity of activities)
          assert.deepEqual(
            ROUTING_MODES.map((mode) => pairOf(rows[tier][activity][mode])),
            pairs,
            `${tier} ${activity}`,
          );
    }
  });

  for (const [nativeModel, differs] of [
    [UNROUTED_MODEL, DIFFERING[profile]],
    [OPUS, DIFFERING_ON_OPUS[profile]],
  ])
    test(`${profile}: the modes keep their invariants in every cell, session on ${nativeModel}`, () =>
      invariants(config, matrix(file, nativeModel), differs));
}

function invariants(config, rows, expectedDiffering) {
  const price = (d) => config.models[d.route.model].input;
  const effort = (d) => EFFORTS.indexOf(d.route.effort);
  // -1 cheaper, 0 same, 1 dearer: by input price, then by effort on the same model.
  const order = (a, b) =>
    price(a) !== price(b)
      ? Math.sign(price(a) - price(b))
      : a.route.model === b.route.model
        ? Math.sign(effort(a) - effort(b))
        : 0;
  const differing = { cost: 0, quality: 0 };
  for (const tier of CLASSIFIED)
    for (const activity of ACTIVITY_ANSWERS) {
      const at = `${tier} ${activity}`;
      const { cost, balanced, quality } = rows[tier][activity];
      if (tier === 'micro') assert.deepEqual([pairOf(cost), pairOf(quality)], [pairOf(balanced), pairOf(balanced)], at);
      // Balanced is the routing without modes: the configured route of the tier it lands on.
      const routed = activity === 'uncertain' ? null : activity;
      assert.deepEqual(balanced.route, resolveRoute(config, balanced.tier, routed), at);
      assert.ok(order(cost, balanced) <= 0, `cost costs more at ${at}`);
      assert.ok(order(quality, balanced) >= 0, `quality costs less at ${at}`);
      for (const mode of ROUTING_MODES) {
        const d = rows[tier][activity][mode];
        // The mode never moves the tier, so cost never creates micro; every route at low or above has an effort.
        assert.equal(d.tier, balanced.tier, `${mode} tier at ${at}`);
        if (rank(d.tier) >= rank('low')) assert.ok(EFFORTS.includes(d.effort), `${mode} effort at ${at}`);
      }
      if (pairOf(cost) !== pairOf(balanced)) differing.cost += 1;
      if (pairOf(quality) !== pairOf(balanced)) differing.quality += 1;
    }
  assert.deepEqual(differing, expectedDiffering);
}

test('balanced through the mode is the routing without one, cell by cell', () => {
  const config = loadConfig();
  for (const tier of CLASSIFIED)
    for (const activity of ACTIVITY_ANSWERS)
      assert.deepEqual(decision(config, tier, activity), matrix(null)[tier][activity].balanced, `${tier} ${activity}`);
});

test('a pin runs its tier’s configured route in every mode', async () => {
  for (const mode of ROUTING_MODES)
    for (const tier of TIERS) {
      const h = harness(JEV_KEY);
      h.files.set(CONFIG, JSON.stringify({ mode }));
      await start(h);
      await h.event('command.run', { command: 'router', args: `pin ${tier}` });
      await drain(h.step(step));
      const { model, effort } = resolveRoute(loadConfig(), tier);
      assert.deepEqual(
        [h.requests[0].model, h.requests[0].effort],
        [loadConfig().models[model].id, effort],
        `${mode} ${tier}`,
      );
    }
});

test('docs/routing-modes.md shows the matrix the router makes (npm run docs:modes)', () => {
  const text = readFileSync(DOC, 'utf8');
  assert.equal(text, withMatrix(text));
});

test('every classifier tier and activity answer is in the matrix', () => {
  assert.deepEqual(CLASSIFIED, [...TIERS, 'uncertain']);
  assert.equal(ACTIVITY_ANSWERS.length, 8);
});
