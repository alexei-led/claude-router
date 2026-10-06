import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  activeClassifier,
  CLASSIFIER_OPTIONS,
  DEFAULTS,
  loadConfig,
  tuningOf,
  withClassifier,
  withClassifierTimeout,
  withRoutes,
  withTuning,
} from '../lib/config.mjs';

test('defaults load without a user file, with Jev as the classifier', () => {
  const config = loadConfig();
  assert.equal(config.routes.low.model, 'sonnet');
  assert.equal(config.baselineTier, 'low');
  assert.equal(config.classifier, 'jev');
  assert.deepEqual(Object.keys(config.classifiers), ['jev', 'clef', 'clef-flash']);
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
  ['an unknown classifier key', { classifiers: { jev: { url: 'x' } } }, /classifiers\.jev\.url/],
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
  [
    'an infinite classifier timeout',
    parse('{"classifiers": {"jev": {"timeoutMs": 1e999}}}'),
    /classifiers\.jev\.timeoutMs/,
  ],
  ['an empty classifier endpoint', { classifiers: { clef: { endpoint: '' } } }, /classifiers\.clef\.endpoint/],
  ['a non-http endpoint', { classifiers: { jev: { endpoint: 'file:///etc/hosts' } } }, /classifiers\.jev\.endpoint/],
  [
    'a cleartext endpoint off this machine',
    { classifiers: { jev: { endpoint: 'http://proxy.example/v1' } } },
    /classifiers\.jev\.endpoint/,
  ],
  [
    'a cleartext endpoint that only starts like localhost',
    { classifiers: { jev: { endpoint: 'http://localhost.example/v1' } } },
    /classifiers\.jev\.endpoint/,
  ],
  ['a stray brace in an endpoint', { classifiers: { jev: { endpoint: 'https://x/{Account}' } } }, /placeholders/],
  ['a non-string classifier model', { classifiers: { jev: { model: 5 } } }, /classifiers\.jev\.model/],
  ['a key option that is not a plugin option', { classifiers: { jev: { keyOption: 'house_key' } } }, /keyOption/],
  [
    'an endpoint setting that is not a plugin option',
    { classifiers: { jev: { endpoint: 'https://x/{region}/decide' } } },
    /classifiers\.jev\.endpoint/,
  ],
  ['an empty label', { classifiers: { jev: { label: '' } } }, /classifiers\.jev\.label/],
  [
    'a new classifier without a label',
    { classifiers: { house: { endpoint: 'https://x', model: 'm', keyOption: 'k', timeoutMs: 1 } } },
    /classifiers\.house\.label/,
  ],
  ['an active classifier that is not configured', { classifier: 'gpt' }, /classifier is not in classifiers/],
  ['an active classifier on an inherited property', { classifier: 'toString' }, /classifier is not in classifiers/],
  ['a __proto__ classifier id', parse('{"classifiers": {"__proto__": {}}}'), /classifiers\.__proto__/],
  ['the 1.1 jev section', { jev: { timeoutMs: 900 } }, /scripts\/migrate-config\.mjs/],
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
      classifiers: { jev: { timeoutMs: 2500 } },
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
      { routes: { low: { model: 'opus' } }, classifiers: { jev: { timeoutMs: 900 } } },
      defaults,
      { classifiers: { jev: { timeoutMs: 900 } } },
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
    const loaded = loadConfig({ userFile: file });
    const written = withRoutes(file, { ...draft, base: { routes: loaded.routes, baselineTier: loaded.baselineTier } });
    assert.deepEqual(written, expected, name);
    loadConfig({ userFile: written });
  }
});

test('a pane save keeps router.json edits made on disk after the session loaded it', () => {
  const base = loadConfig({});
  const draft = {
    routes: { ...structuredClone(DEFAULTS.routes), micro: { model: 'sonnet', effort: null } },
    baselineTier: DEFAULTS.baselineTier,
    base: { routes: base.routes, baselineTier: base.baselineTier },
  };
  const onDisk = { routes: { high: { model: 'sonnet' } }, baselineTier: 'medium' };
  assert.deepEqual(withRoutes(onDisk, draft), {
    routes: { micro: { model: 'sonnet' }, high: { model: 'sonnet' } },
    baselineTier: 'medium',
  });
  const saved = tuningOf(base);
  assert.deepEqual(
    withTuning(
      { classifiers: { jev: { timeoutMs: 900 } }, policy: { downgradeVotes: 3 } },
      { ...saved, horizon: 10 },
      saved,
    ),
    { classifiers: { jev: { timeoutMs: 900 } }, policy: { downgradeVotes: 3, downgradeHorizonTurns: 10 } },
  );
  assert.deepEqual(
    withTuning(
      { policy: { downgradeVotes: 3, upgradeVotes: 3 } },
      { ...saved, downgradeVotes: 2 },
      {
        ...saved,
        downgradeVotes: 3,
      },
    ),
    { policy: { upgradeVotes: 3 } },
  );
  assert.deepEqual(withTuning({ policy: { cashCapUsd: 5 } }, saved, { ...saved, cashCapUsd: 5 }), {});
});

test('a classifier can be selected, partly overridden or added', () => {
  const house = {
    label: 'House',
    endpoint: 'https://gateway.example/{cloudflare_account_id}/clef',
    model: 'clef',
    keyOption: 'cloudflare_api_token',
    timeoutMs: 800,
  };
  for (const [name, userFile, id, expected] of [
    ['the default', null, 'jev', DEFAULTS.classifiers.jev],
    ['Clef Flash', { classifier: 'clef-flash' }, 'clef-flash', DEFAULTS.classifiers['clef-flash']],
    [
      'a built-in with a longer deadline',
      { classifier: 'clef', classifiers: { clef: { timeoutMs: 4000 } } },
      'clef',
      { ...DEFAULTS.classifiers.clef, timeoutMs: 4000 },
    ],
    ['a new one', { classifier: 'house', classifiers: { house } }, 'house', house],
  ]) {
    const config = loadConfig({ userFile });
    assert.equal(config.classifier, id, name);
    assert.deepEqual(activeClassifier(config), expected, name);
    assert.deepEqual(config.classifiers.jev, DEFAULTS.classifiers.jev, name);
  }
});

test('withClassifier writes only a choice that differs from the default', () => {
  for (const [name, file, id, expected] of [
    ['a new choice', { policy: { cashCapUsd: 1 } }, 'clef', { policy: { cashCapUsd: 1 }, classifier: 'clef' }],
    ['a changed choice', { classifier: 'clef' }, 'clef-flash', { classifier: 'clef-flash' }],
    ['back to the default', { classifier: 'clef', routes: {} }, 'jev', { routes: {} }],
  ]) {
    const written = withClassifier(file, id);
    assert.deepEqual(written, expected, name);
    assert.equal(loadConfig({ userFile: written }).classifier, id, name);
  }
});

test('withClassifierTimeout writes only a deadline that differs from the default', () => {
  const house = {
    label: 'House',
    endpoint: 'https://jev-proxy.example.internal/v1/systemone',
    model: 'jev-1.13.0',
    keyOption: 'typesafe_api_key',
    timeoutMs: 1500,
  };
  for (const [name, file, id, timeoutMs, expected] of [
    [
      'a longer deadline',
      { classifier: 'clef' },
      'clef',
      4000,
      { classifier: 'clef', classifiers: { clef: { timeoutMs: 4000 } } },
    ],
    [
      'back to the default drops the override and empty sections',
      { classifier: 'clef', classifiers: { clef: { timeoutMs: 4000 } }, policy: { cashCapUsd: 1 } },
      'clef',
      DEFAULTS.classifiers.clef.timeoutMs,
      { classifier: 'clef', policy: { cashCapUsd: 1 } },
    ],
    [
      'other fields of the entry stay',
      { classifiers: { jev: { label: 'J', timeoutMs: 900 } } },
      'jev',
      DEFAULTS.classifiers.jev.timeoutMs,
      { classifiers: { jev: { label: 'J' } } },
    ],
    [
      'a new classifier keeps its whole entry',
      { classifier: 'house', classifiers: { house } },
      'house',
      3000,
      { classifier: 'house', classifiers: { house: { ...house, timeoutMs: 3000 } } },
    ],
  ]) {
    const written = withClassifierTimeout(file, id, timeoutMs);
    assert.deepEqual(written, expected, name);
    assert.equal(loadConfig({ userFile: written }).classifiers[id].timeoutMs, timeoutMs, name);
  }
});

test('classifiers read exactly the options plugin.json declares', () => {
  const manifest = JSON.parse(readFileSync(new URL('../.claude-plugin/plugin.json', import.meta.url), 'utf8'));
  assert.deepEqual(Object.keys(manifest.userConfig).sort(), Object.keys(CLASSIFIER_OPTIONS).sort());
});

test('a loopback http endpoint passes for local stubs', () => {
  for (const endpoint of ['http://127.0.0.1:43171/delay', 'http://localhost/v1', 'http://[::1]:8080/v1']) {
    assert.equal(loadConfig({ userFile: { classifiers: { jev: { endpoint } } } }).classifiers.jev.endpoint, endpoint);
  }
});
