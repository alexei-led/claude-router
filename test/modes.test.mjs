import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ACTIVITIES, loadConfig, resolveRoute, TIERS } from '../lib/config.mjs';
import { applyMode, modeLabel, modeRoute, projectEffort, readProjectMode, resolveRoutingMode } from '../lib/modes.mjs';

const r = (model, effort) => ({ model, effort });
const ENGINEERING = ['code', 'debug', 'plan', 'review'];
const PLAIN = [null, 'explore', 'docs'];

test('the built-in routes in every mode, tier and activity', () => {
  const config = loadConfig();
  const cases = [
    // [tier, activities, balanced, cost, quality]
    ['high', [...PLAIN, ...ENGINEERING], r('opus', 'xhigh'), r('opus', 'high'), r('opus', 'max')],
    ['high', ['ops'], r('opus', 'xhigh'), r('haiku', 'high'), r('opus', 'max')],
    ['medium', PLAIN, r('opus', 'medium'), r('haiku', 'high'), r('opus', 'high')],
    ['medium', ENGINEERING, r('opus', 'medium'), r('sonnet', 'high'), r('opus', 'high')],
    ['medium', ['ops'], r('haiku', 'high'), r('haiku', 'medium'), r('haiku', 'xhigh')],
    ['low', [...PLAIN, 'ops'], r('haiku', 'high'), r('haiku', 'medium'), r('haiku', 'xhigh')],
    ['low', ENGINEERING, r('sonnet', 'high'), r('sonnet', 'medium'), r('sonnet', 'xhigh')],
    ['micro', [...PLAIN, ...ENGINEERING, 'ops'], r('haiku', 'medium'), r('haiku', 'medium'), r('haiku', 'medium')],
  ];
  for (const [tier, activities, balanced, cost, quality] of cases)
    for (const activity of activities) {
      const at = `${tier} ${activity}`;
      assert.deepEqual(modeRoute(config, 'balanced', tier, activity), balanced, `balanced ${at}`);
      assert.deepEqual(modeRoute(config, 'cost', tier, activity), cost, `cost ${at}`);
      assert.deepEqual(modeRoute(config, 'quality', tier, activity), quality, `quality ${at}`);
    }
});

test('the effort lever follows what the model lists', () => {
  const sparse = (efforts, routes) =>
    loadConfig({
      userFile: { models: { opus: { efforts } }, routes, activities: {}, activityRouting: 'off' },
    });
  const cases = [
    // [efforts, high route, medium route, mode, expected high route]
    // One level down projects up to the level it runs at: no step.
    [['low', 'high'], r('opus', 'high'), r('opus', 'low'), 'cost', r('opus', 'high')],
    [['high'], r('opus', 'high'), r('opus', 'high'), 'cost', r('opus', 'high')],
    [['low', 'medium', 'high'], r('opus', 'high'), r('opus', 'low'), 'cost', r('opus', 'medium')],
    [['low', 'high'], r('opus', 'low'), r('opus', 'low'), 'quality', r('opus', 'high')],
    [['low', 'high'], r('opus', 'high'), r('opus', 'high'), 'quality', r('opus', 'high')],
    // A configured effort the model does not list starts from the one it runs at.
    [['low', 'medium'], r('opus', 'max'), r('opus', 'medium'), 'cost', r('opus', 'low')],
    // No efforts: no effort lever, and no effort is ever added.
    [[], r('opus', 'high'), r('opus', 'high'), 'cost', r('opus', 'high')],
    [[], r('opus', 'high'), r('opus', 'high'), 'quality', r('opus', 'high')],
  ];
  for (const [efforts, high, medium, mode, expected] of cases)
    assert.deepEqual(
      modeRoute(sparse(efforts, { high, medium }), mode, 'high'),
      expected,
      `${mode} ${efforts} ${high.effort}`,
    );
});

test('a session effort route has no effort lever: cost stays, quality takes the tier above', () => {
  const config = loadConfig({ userFile: { routes: { medium: { model: 'opus', effort: null } } } });
  assert.deepEqual(modeRoute(config, 'cost', 'medium'), r('haiku', 'high'));
  const sameModel = loadConfig({
    userFile: { routes: { medium: { model: 'opus', effort: null }, low: { model: 'opus', effort: 'low' } } },
  });
  assert.deepEqual(modeRoute(sameModel, 'cost', 'medium'), r('opus', null));
  assert.deepEqual(modeRoute(config, 'quality', 'medium'), r('opus', 'xhigh'));
});

test('quality at max effort moves to the tier above, and high stays at the top', () => {
  const config = loadConfig({ userFile: { routes: { medium: { model: 'sonnet', effort: 'max' } } } });
  assert.deepEqual(modeRoute(config, 'quality', 'medium'), r('opus', 'xhigh'));
  const top = loadConfig({ userFile: { routes: { high: { model: 'opus', effort: 'max' } } } });
  assert.deepEqual(modeRoute(top, 'quality', 'high'), r('opus', 'max'));
});

test('cost takes the tier below only for a lower input price, and never goes to micro', () => {
  const samePrice = loadConfig({
    userFile: { models: { sonnet: { input: 4 } }, routes: { medium: { model: 'sonnet', effort: 'high' } } },
  });
  assert.deepEqual(modeRoute(samePrice, 'cost', 'high'), r('opus', 'high'));
  const pricier = loadConfig({ userFile: { routes: { medium: { model: 'opus', effort: 'low' } } } });
  assert.deepEqual(modeRoute(pricier, 'cost', 'high'), r('opus', 'high'));
  const config = loadConfig({ userFile: { routes: { micro: { model: 'haiku', effort: 'low' } } } });
  for (const tier of ['low', 'medium', 'high']) assert.notDeepEqual(modeRoute(config, 'cost', tier), r('haiku', 'low'));
});

test('applyMode builds the turn config from the configured routes and the mode policy', () => {
  const config = loadConfig();
  const cost = applyMode(config, { mode: 'cost', source: 'profile' });
  for (const tier of TIERS)
    for (const activity of [null, ...ACTIVITIES])
      assert.deepEqual(
        resolveRoute(cost, tier, activity),
        modeRoute(config, 'cost', tier, activity),
        `${tier} ${activity}`,
      );
  assert.equal(cost.policy.minDwellRequests, 4);
  assert.equal(cost.policy.upgradeSlope, config.policy.upgradeSlope);
  assert.deepEqual(cost.routingMode, { mode: 'cost', source: 'profile' });
  assert.deepEqual(config.routes.high, r('opus', 'xhigh'));
  // Built from the configured routes every turn: applying again gives the same table, not a second step.
  assert.deepEqual(applyMode(config, { mode: 'cost', source: 'profile' }), cost);
  const balanced = applyMode(config, { mode: 'balanced', source: 'default' });
  assert.equal(balanced.routes, config.routes);
  assert.equal(balanced.activities, config.activities);
  assert.deepEqual(balanced.policy, config.policy);
});

test('a user patch replaces those policy fields in its mode only', () => {
  const config = loadConfig({
    userFile: { policy: { minDwellRequests: 6 }, modes: { cost: { policy: { minDwellRequests: 2 } } } },
  });
  assert.equal(applyMode(config, { mode: 'cost', source: 'profile' }).policy.minDwellRequests, 2);
  assert.equal(applyMode(config, { mode: 'cost', source: 'profile' }).policy.downgradeVotes, 1);
  assert.equal(applyMode(config, { mode: 'balanced', source: 'default' }).policy.minDwellRequests, 6);
  assert.equal(applyMode(config, { mode: 'quality', source: 'profile' }).policy.minDwellRequests, 16);
});

test('the session override beats the project file, which beats the profile', () => {
  const cases = [
    [
      { session: 'cost', project: 'quality', profile: 'balanced' },
      { mode: 'cost', source: 'session' },
    ],
    [
      { session: null, project: 'quality', profile: 'cost' },
      { mode: 'quality', source: 'project' },
    ],
    [
      { session: null, project: null, profile: 'cost' },
      { mode: 'cost', source: 'profile' },
    ],
    [
      { session: null, project: null, profile: 'balanced' },
      { mode: 'balanced', source: 'default' },
    ],
    [{}, { mode: 'balanced', source: 'default' }],
    [
      { session: 'bogus', project: 'balanced' },
      { mode: 'balanced', source: 'project' },
    ],
  ];
  for (const [input, expected] of cases) assert.deepEqual(resolveRoutingMode(input), expected, JSON.stringify(input));
  assert.equal(modeLabel({ mode: 'cost', source: 'session' }), 'cost (session)');
});

test('a project file may set only the mode; any other content is ignored with a reason', () => {
  const cases = [
    [null, { mode: null, error: null }],
    ['{}', { mode: null, error: null }],
    ['{"mode":"cost"}', { mode: 'cost', error: null }],
    [
      '{"mode":"fast"}',
      { mode: null, error: 'project .claude/router.json mode must be one of cost, balanced, quality' },
    ],
    ['{"mode":"cost","routes":{}}', { mode: null, error: 'project .claude/router.json may only set mode, not routes' }],
    ['[1]', { mode: null, error: 'project .claude/router.json must be an object' }],
    ['{mode', { mode: null, error: 'project .claude/router.json is not valid JSON' }],
  ];
  for (const [text, expected] of cases) assert.deepEqual(readProjectMode(text), expected, text);
});

test('router.json mode and modes are validated', () => {
  const cases = [
    [{ mode: 'fast' }, /mode must be one of cost, balanced, quality/],
    [{ modes: { balanced: { policy: {} } } }, /modes\.balanced is not a known key/],
    [{ modes: { cost: { routes: {} } } }, /modes\.cost\.routes is not a known key/],
    [{ modes: { cost: { policy: { tiers: 1 } } } }, /modes\.cost\.policy\.tiers is not a known key/],
    [
      { modes: { cost: { policy: { minDwellRequests: -1 } } } },
      /modes\.cost\.policy\.minDwellRequests must be a non-negative integer/,
    ],
    [
      { modes: { quality: { policy: { upgradeBase: 2 } } } },
      /modes\.quality\.policy\.upgradeBase must be between 0 and 1/,
    ],
    [{ modes: { cost: null } }, /modes\.cost must be an object/],
  ];
  for (const [userFile, message] of cases)
    assert.throws(() => loadConfig({ userFile }), message, JSON.stringify(userFile));
  assert.equal(loadConfig({ userFile: { mode: 'cost' } }).mode, 'cost');
  assert.equal(loadConfig().mode, 'balanced');
});

test('projectEffort takes the level, else the next higher listed, else the highest lower', () => {
  assert.equal(projectEffort(['low', 'high'], 'high'), 'high');
  assert.equal(projectEffort(['low', 'high'], 'medium'), 'high');
  assert.equal(projectEffort(['low', 'medium'], 'max'), 'medium');
  assert.equal(projectEffort([], 'high'), null);
});
