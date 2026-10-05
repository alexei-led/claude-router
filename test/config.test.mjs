import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULTS, loadConfig, tuningOf, withRoutes, withTuning } from '../lib/config.mjs';

test('defaults load without a user file and resolve no key', () => {
  const config = loadConfig({ env: {} });
  assert.equal(config.apiKey, null);
  assert.equal(config.routes.low.model, 'sonnet');
  assert.equal(config.baselineTier, 'low');
});

test('user file overrides merge deeply and keep the rest', () => {
  const config = loadConfig({
    userFile: {
      policy: { cashCapUsd: 2 },
      routes: { medium: { model: 'sonnet', effort: 'max' } },
      baselineTier: 'medium',
    },
  });
  assert.equal(config.policy.cashCapUsd, 2);
  assert.equal(config.policy.upgradeVotes, DEFAULTS.policy.upgradeVotes);
  assert.deepEqual(config.routes.medium, { model: 'sonnet', effort: 'max' });
  assert.equal(config.baselineTier, 'medium');
});

test('api key comes from TYPESAFE_API_KEY only', () => {
  assert.equal(loadConfig({ env: { CLAUDE_PLUGIN_OPTION_TYPESAFE_API_KEY: 'a' } }).apiKey, null);
  assert.equal(loadConfig({ env: { TYPESAFE_API_KEY: 'b' } }).apiKey, 'b');
  assert.equal(loadConfig({ env: { TYPESAFE_API_KEY: '  ' } }).apiKey, null);
});

for (const [name, userFile, message] of [
  ['unknown route model', { routes: { high: { model: 'gpt' } } }, /not in models/],
  ['bad effort', { routes: { high: { model: 'opus', effort: 'ultra' } } }, /effort/],
  ['negative price', { models: { opus: { input: -1 } } }, /input/],
  ['bad efforts list', { models: { opus: { efforts: ['huge'] } } }, /efforts/],
  ['mass above 1', { policy: { downgradeMass: 1.5 } }, /downgradeMass/],
  ['zero votes', { policy: { upgradeVotes: 0 } }, /upgradeVotes/],
  ['bad baseline', { baselineTier: 'ultra' }, /baselineTier/],
]) {
  test(`rejects ${name}`, () => {
    assert.throws(() => loadConfig({ userFile }), message);
  });
}

// Strict router.json: every key must be known, every number finite. A typo fails loudly instead of doing nothing.
const parse = (json) => JSON.parse(json); // JSON.parse keeps "__proto__" as an own key, as readJsonFile does

for (const [name, userFile, message] of [
  ['an unknown top-level key', { routs: {} }, /routs/],
  ['an unknown tier', { routes: { ultra: { model: 'opus' } } }, /routes\.ultra/],
  ['an unknown route key', { routes: { high: { model: 'opus', effrt: 'max' } } }, /routes\.high\.effrt/],
  ['an unknown model key', { models: { opus: { inputt: 1 } } }, /models\.opus\.inputt/],
  ['an unknown policy key', { policy: { upgradeSlop: 1 } }, /policy\.upgradeSlop/],
  ['an unknown cache key', { cache: { ttl: 1 } }, /cache\.ttl/],
  ['an unknown jev key', { jev: { url: 'x' } }, /jev\.url/],
  ['an unknown context key', { context: { turns: 3 } }, /context\.turns/],
  ['a __proto__ key at the top', parse('{"__proto__": {"log": false}}'), /__proto__/],
  ['a __proto__ model alias', parse('{"models": {"__proto__": {}}}'), /models\.__proto__/],
  ['a __proto__ ttl', parse('{"cache": {"ttlMs": {"__proto__": 1}}}'), /cache\.ttlMs\.__proto__/],
  ['a constructor model alias', { models: { constructor: {} } }, /models\.constructor/],
  ['a route to an inherited property', { routes: { low: { model: 'constructor' } } }, /routes\.low\.model/],
  ['a route to toString', { routes: { low: { model: 'toString' } } }, /routes\.low\.model/],
  ['a section that is not an object', { routes: 'opus' }, /routes must be an object/],
  ['a section that is an array', { policy: [] }, /policy must be an object/],
  ['a non-finite upgradeSlope', { policy: { upgradeSlope: 'steep' } }, /policy\.upgradeSlope/],
  ['a negative upgradeSlope', { policy: { upgradeSlope: -0.1 } }, /policy\.upgradeSlope/],
  ['a zero upgradePivotUsd', { policy: { upgradePivotUsd: 0 } }, /policy\.upgradePivotUsd/],
  ['a non-finite downgradeSlope', { policy: { downgradeSlope: 'steep' } }, /policy\.downgradeSlope/],
  ['a zero downgradePivotUsd', { policy: { downgradePivotUsd: 0 } }, /policy\.downgradePivotUsd/],
  ['a zero downgradeHorizonTurns', { policy: { downgradeHorizonTurns: 0 } }, /policy\.downgradeHorizonTurns/],
  ['a fractional downgradeHorizonTurns', { policy: { downgradeHorizonTurns: 1.5 } }, /policy\.downgradeHorizonTurns/],
  ['a non-numeric downgradeHorizonTurns', { policy: { downgradeHorizonTurns: 'x' } }, /policy\.downgradeHorizonTurns/],
  ['an infinite cashCapUsd', parse('{"policy": {"cashCapUsd": 1e999}}'), /policy\.cashCapUsd/],
  ['an infinite jev timeout', parse('{"jev": {"timeoutMs": 1e999}}'), /jev\.timeoutMs/],
  ['an empty jev endpoint', { jev: { endpoint: '' } }, /jev\.endpoint/],
  ['a non-string jev model', { jev: { model: 5 } }, /jev\.model/],
  ['a zero write multiplier', { cache: { writeMultiplier: { '5m': 0 } } }, /cache\.writeMultiplier\.5m/],
  ['a negative ttl', { cache: { ttlMs: { '1h': -1 } } }, /cache\.ttlMs\.1h/],
  ['a negative warm margin', { cache: { warmMarginMs: -1 } }, /cache\.warmMarginMs/],
  ['zero recent turns', { context: { recentTurns: 0 } }, /context\.recentTurns/],
  ['fractional text chars', { context: { maxTextChars: 1.5 } }, /context\.maxTextChars/],
]) {
  test(`rejects ${name}`, () => {
    assert.throws(() => loadConfig({ userFile }), message);
  });
}

for (const [name, userFile] of [
  ['an array', []],
  ['a string', 'opus'],
  ['a number', 5],
]) {
  test(`rejects a router.json that is ${name}`, () => {
    assert.throws(() => loadConfig({ userFile }), /router\.json must be an object/);
  });
}

test('error messages name the field, never the value', () => {
  for (const userFile of [
    { routes: { high: { model: 'secret-model' } } },
    { routes: { high: { model: 'opus', effort: 'secret-effort' } } },
  ]) {
    assert.throws(
      () => loadConfig({ userFile }),
      (error) => !/secret/.test(error.message),
    );
  }
});

test('the documented example and a new model alias pass', () => {
  const config = loadConfig({
    userFile: {
      routes: { low: { model: 'sonnet', effort: 'high' }, micro: { model: 'mine' } },
      jev: { timeoutMs: 2500 },
      models: { mine: { id: 'm', input: 1, cacheRead: 0.1, contextWindow: 200_000, billing: 'credits', efforts: [] } },
      cache: { ttlMs: { '5m': 300_000 }, warmMarginMs: 0 },
    },
  });
  assert.equal(config.routes.micro.model, 'mine');
  assert.equal(config.cache.ttlMs['1h'], DEFAULTS.cache.ttlMs['1h']);
});

test('a null route effort keeps the session effort and overrides a default effort', () => {
  const config = loadConfig({ userFile: { routes: { high: { model: 'opus', effort: null } } } });
  assert.equal(config.routes.high.effort, null);
});

test('withRoutes writes only the routes and baseline that differ from the defaults', () => {
  const defaults = { routes: structuredClone(DEFAULTS.routes), baselineTier: DEFAULTS.baselineTier };
  const edit = (tier, route) => ({ ...defaults, routes: { ...defaults.routes, [tier]: route } });
  for (const [name, file, draft, expected] of [
    [
      'defaults remove overrides',
      { routes: { low: { model: 'opus' } }, jev: { timeoutMs: 900 } },
      defaults,
      { jev: { timeoutMs: 900 } },
    ],
    [
      'changed model and effort',
      {},
      edit('medium', { model: 'sonnet', effort: 'xhigh' }),
      { routes: { medium: { model: 'sonnet', effort: 'xhigh' } } },
    ],
    [
      'session effort over a default effort',
      {},
      edit('high', { model: 'opus', effort: null }),
      { routes: { high: { model: 'opus', effort: null } } },
    ],
    [
      'no effort where the default has none',
      {},
      edit('low', { model: 'opus', effort: null }),
      { routes: { low: { model: 'opus' } } },
    ],
    ['baseline', { baselineTier: 'micro' }, { ...defaults, baselineTier: 'medium' }, { baselineTier: 'medium' }],
  ]) {
    const written = withRoutes(file, draft, loadConfig({ userFile: file }));
    assert.deepEqual(written, expected, name);
    loadConfig({ userFile: written });
  }
});

test('a pane save keeps router.json edits made on disk after the session loaded it', () => {
  const base = loadConfig({});
  const draft = {
    routes: { ...structuredClone(DEFAULTS.routes), micro: { model: 'sonnet', effort: null } },
    baselineTier: DEFAULTS.baselineTier,
  };
  const onDisk = { routes: { high: { model: 'sonnet' } }, baselineTier: 'medium' };
  assert.deepEqual(withRoutes(onDisk, draft, base), {
    routes: { micro: { model: 'sonnet' }, high: { model: 'sonnet' } },
    baselineTier: 'medium',
  });
  const saved = tuningOf(base);
  assert.deepEqual(
    withTuning({ jev: { timeoutMs: 900 }, policy: { downgradeVotes: 3 } }, { ...saved, horizon: 10 }, saved),
    { jev: { timeoutMs: 900 }, policy: { downgradeVotes: 3, downgradeHorizonTurns: 10 } },
  );
});
