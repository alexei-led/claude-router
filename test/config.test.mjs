import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  ACTIVITIES,
  ACTIVITY_MODES,
  ACTIVITY_VALUES,
  accountOf,
  activeClassifier,
  CLASSIFIER_OPTIONS,
  DEFAULTS,
  editActivity,
  effectiveActivities,
  loadConfig,
  resolveRoute,
  supportedVersion,
  TIERS,
} from '../lib/config.mjs';
import { routeEffort } from '../lib/cost.mjs';

test('defaults load without a user file, with Jev as the classifier', () => {
  const config = loadConfig();
  assert.deepEqual(config.routes.low, { model: 'haiku', effort: 'high' });
  assert.equal(config.baselineTier, 'low');
  assert.equal(config.classifier, 'jev');
  assert.deepEqual(Object.keys(config.classifiers), ['jev', 'clef', 'clef-flash', 'clef-omni', 'openai', 'ollama']);
});

test('routingEngine defaults to table and accepts only the strict engine enum', () => {
  assert.equal(loadConfig().routingEngine, 'table');
  for (const routingEngine of ['table', 'shadow', 'auto'])
    assert.equal(loadConfig({ userFile: { routingEngine } }).routingEngine, routingEngine);
  for (const routingEngine of [null, '', 'TABLE', 'shadow ', 'automatic', 0, false, [], {}])
    assert.throws(
      () => loadConfig({ userFile: { routingEngine } }),
      /routingEngine must be one of table, shadow, auto/,
    );
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

const fromDisk = (json) => JSON.parse(json);

for (const [name, userFile, message] of [
  ['an unknown top-level key', { routs: {} }, /routs/],
  ['an unknown tier', { routes: { ultra: { model: 'opus' } } }, /routes\.ultra/],
  ['an unknown route key', { routes: { high: { model: 'opus', effrt: 'max' } } }, /routes\.high\.effrt/],
  ['an unknown model key', { models: { opus: { inputt: 1 } } }, /models\.opus\.inputt/],
  ['an unknown policy key', { policy: { upgradeSlop: 1 } }, /policy\.upgradeSlop/],
  ['an unknown cache key', { cache: { ttl: 1 } }, /cache\.ttl/],
  ['an unknown classifier key', { classifiers: { jev: { url: 'x' } } }, /classifiers\.jev\.url/],
  ['an unknown context key', { context: { turns: 3 } }, /context\.turns/],
  ['a __proto__ key at the top', fromDisk('{"__proto__": {"log": false}}'), /__proto__/],
  ['a __proto__ model alias', fromDisk('{"models": {"__proto__": {}}}'), /models\.__proto__/],
  ['a __proto__ ttl', fromDisk('{"cache": {"ttlMs": {"__proto__": 1}}}'), /cache\.ttlMs\.__proto__/],
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
  ['an infinite cashCapUsd', fromDisk('{"policy": {"cashCapUsd": 1e999}}'), /policy\.cashCapUsd/],
  [
    'an infinite classifier timeout',
    fromDisk('{"classifiers": {"jev": {"timeoutMs": 1e999}}}'),
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
  ['an unknown classifier API', { classifiers: { jev: { api: 'anthropic' } } }, /classifiers\.jev\.api/],
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
  ['a __proto__ classifier id', fromDisk('{"classifiers": {"__proto__": {}}}'), /classifiers\.__proto__/],
  ['the 1.1 jev section', { jev: { timeoutMs: 900 } }, /scripts\/migrate-config\.mjs/],
  ['a zero write multiplier', { cache: { writeMultiplier: { '5m': 0 } } }, /cache\.writeMultiplier\.5m/],
  ['a negative ttl', { cache: { ttlMs: { '1h': -1 } } }, /cache\.ttlMs\.1h/],
  ['a negative warm margin', { cache: { warmMarginMs: -1 } }, /cache\.warmMarginMs/],
  ['zero recent turns', { context: { recentTurns: 0 } }, /context\.recentTurns/],
  ['an unknown activity', { activities: { write: { low: { model: 'sonnet' } } } }, /activities\.write/],
  ['uncertain as an activity', { activities: { uncertain: {} } }, /activities\.uncertain/],
  ['an unknown activity tier', { activities: { code: { ultra: {} } } }, /activities\.code\.ultra/],
  ['an unknown override key', { activities: { code: { low: { effrt: 'max' } } } }, /activities\.code\.low\.effrt/],
  ['an activity that is not an object', { activities: { code: 'sonnet' } }, /activities\.code must be an object/],
  ['an override that is not an object', { activities: { code: { low: 'sonnet' } } }, /activities\.code\.low must/],
  ['a __proto__ activity', fromDisk('{"activities": {"__proto__": {}}}'), /activities\.__proto__/],
  [
    'an override to an unknown model',
    { activities: { ops: { low: { model: 'gpt' } } } },
    /activities\.ops\.low\.model/,
  ],
  [
    'an override to an inherited property',
    { activities: { ops: { low: { model: 'toString' } } } },
    /activities\.ops\.low\.model/,
  ],
  [
    'an override with a bad effort',
    { activities: { code: { high: { effort: 'ultra' } } } },
    /activities\.code\.high\.effort/,
  ],
  ['an unknown activity mode', { activityRouting: 'auto' }, /activityRouting must be one of off, on/],
  ['activityMass above 1', { policy: { activityMass: 1.5 } }, /policy\.activityMass/],
  ['a negative activityMass', { policy: { activityMass: -0.1 } }, /policy\.activityMass/],
  ['fractional text chars', { context: { maxTextChars: 1.5 } }, /context\.maxTextChars/],
  ['an unknown long-context key', { models: { haiku: { longContext: { over: 1 } } } }, /longContext\.over/],
  ['a long context that is not an object', { models: { haiku: { longContext: 5 } } }, /longContext must be/],
  ['a fractional long-context threshold', { models: { haiku: { longContext: { above: 1.5 } } } }, /above/],
  ['a zero long-context multiplier', { models: { haiku: { longContext: { multiplier: 0 } } } }, /multiplier/],
  ['a negative strength', { models: { haiku: { strength: -1 } } }, /models\.haiku\.strength/],
  ['an imageInput that is not a boolean', { models: { haiku: { imageInput: 'yes' } } }, /models\.haiku\.imageInput/],
  ['a negative output price', { models: { haiku: { output: -1 } } }, /models\.haiku\.output/],
  ['an empty model id', { models: { haiku: { id: '' } } }, /models\.haiku\.id is required/],
  ['an unknown billing', { models: { haiku: { billing: 'free' } } }, /models\.haiku\.billing must be plan or credits/],
]) {
  test(`strict router.json rejects ${name} instead of ignoring it`, () => {
    assert.throws(() => loadConfig({ userFile }), message);
  });
}

for (const provider of ['kimi', 'deepseek', 'mimo'])
  test(`${provider}: choosing explicit cache needs the 5m and 1h prices its automatic cache does not have`, () => {
    assert.throws(
      () => loadConfig({ provider, userFile: { cache: { mode: 'explicit' } } }),
      /explicit cache requires 5m and 1h/,
    );
  });

for (const [name, userFile] of [
  ['an array', []],
  ['a string', 'opus'],
  ['a number', 5],
]) {
  test(`rejects a router.json that is ${name}`, () => {
    assert.throws(() => loadConfig({ userFile }), /router\.json must be an object/);
  });
}

test('a long-context surcharge merges per field, and null removes it', () => {
  assert.deepEqual(loadConfig({}).models.haiku.longContext, { above: 100_000, multiplier: 5 });
  const raised = loadConfig({ userFile: { models: { haiku: { longContext: { above: 200_000 } } } } });
  assert.deepEqual(raised.models.haiku.longContext, { above: 200_000, multiplier: 5 });
  assert.equal(loadConfig({ userFile: { models: { haiku: { longContext: null } } } }).models.haiku.longContext, null);
  assert.equal(loadConfig({}).models.opus.longContext, undefined);
});

test('error messages name the field, never the value', () => {
  for (const userFile of [
    { routes: { high: { model: 'secret-model' } } },
    { routes: { high: { model: 'opus', effort: 'secret-effort' } } },
    { activities: { code: { low: { model: 'secret-model' } } } },
    { activities: { code: { low: { effort: 'secret-effort' } } } },
    { activityRouting: 'secret-mode' },
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
    ['a new one', { classifier: 'house', classifiers: { house } }, 'house', { api: 'system-one', ...house }],
  ]) {
    const config = loadConfig({ userFile });
    assert.equal(config.classifier, id, name);
    assert.deepEqual(activeClassifier(config), expected, name);
    assert.deepEqual(config.classifiers.jev, DEFAULTS.classifiers.jev, name);
  }
});

test('classifiers read exactly the options plugin.json declares', () => {
  const manifest = JSON.parse(readFileSync(new URL('../.claude-plugin/plugin.json', import.meta.url), 'utf8'));
  assert.deepEqual(Object.keys(manifest.userConfig).sort(), Object.keys(CLASSIFIER_OPTIONS).sort());
});

test('a keyless classifier needs no key option; a user entry speaks System One unless it names an API', () => {
  const config = loadConfig({
    userFile: {
      classifiers: {
        'local-proxy': {
          label: 'Proxy',
          endpoint: 'http://127.0.0.1:9/v1',
          model: 'm',
          keyOption: null,
          timeoutMs: 800,
        },
      },
    },
  });
  assert.equal(config.classifiers.ollama.keyOption, null);
  assert.equal(config.classifiers['local-proxy'].api, 'system-one');
  assert.equal(config.classifiers.openai.api, 'openai-decisions');
});

test('a loopback http endpoint passes for local stubs', () => {
  for (const endpoint of ['http://127.0.0.1:43171/delay', 'http://localhost/v1', 'http://[::1]:8080/v1']) {
    assert.equal(loadConfig({ userFile: { classifiers: { jev: { endpoint } } } }).classifiers.jev.endpoint, endpoint);
  }
});

test('the default micro and low routes are Haiku at their own effort whatever the session effort', () => {
  for (const [tier, effort] of [
    ['micro', 'medium'],
    ['low', 'high'],
  ]) {
    assert.deepEqual(DEFAULTS.routes[tier], { model: 'haiku', effort });
    for (const session of ['low', 'medium', 'high', 'xhigh', 'max', null])
      assert.equal(
        routeEffort(loadConfig({}), resolveRoute(loadConfig({}), tier), session),
        effort,
        `${tier} ${session}`,
      );
  }
});

test('activity routing defaults to on with Sonnet at high for low engineering work and Haiku for medium ops', () => {
  const config = loadConfig();
  assert.deepEqual(ACTIVITY_VALUES, [...ACTIVITIES, 'uncertain']);
  assert.deepEqual(ACTIVITY_MODES, ['off', 'on']);
  assert.equal(config.activityRouting, 'on');
  assert.equal(config.policy.activityMass, 0.6);
  const sonnet = { model: 'sonnet', effort: 'high' };
  assert.deepEqual(config.activities, {
    code: { low: sonnet },
    debug: { low: sonnet },
    plan: { low: sonnet },
    review: { low: sonnet },
    ops: { medium: { model: 'haiku', effort: 'high' } },
  });
});

test('resolveRoute runs the default matrix in every cell and the base route without an activity', () => {
  const config = loadConfig();
  const H_MED = { model: 'haiku', effort: 'medium' };
  const H_HIGH = { model: 'haiku', effort: 'high' };
  const S_HIGH = { model: 'sonnet', effort: 'high' };
  const O_MED = { model: 'opus', effort: 'medium' };
  const O_XH = { model: 'opus', effort: 'xhigh' };
  const engineering = [H_MED, S_HIGH, O_MED, O_XH];
  const matrix = {
    base: [H_MED, H_HIGH, O_MED, O_XH],
    code: engineering,
    debug: engineering,
    plan: engineering,
    review: engineering,
    ops: [H_MED, H_HIGH, H_HIGH, O_XH],
    explore: [H_MED, H_HIGH, O_MED, O_XH],
    docs: [H_MED, H_HIGH, O_MED, O_XH],
  };
  assert.deepEqual(Object.keys(matrix).slice(1).sort(), [...ACTIVITIES].sort());
  for (const [activity, routes] of Object.entries(matrix))
    TIERS.forEach((tier, i) => {
      assert.deepEqual(
        resolveRoute(config, tier, activity === 'base' ? null : activity),
        routes[i],
        `${activity} ${tier}`,
      );
    });
});

test('a user override merges per field over the built-in one', () => {
  const config = loadConfig({
    userFile: {
      activities: {
        code: { low: { effort: 'medium' }, high: { effort: 'max' } },
        review: { low: { model: 'opus' } },
        ops: { medium: { model: 'sonnet' } },
        docs: { low: { effort: null } },
      },
    },
  });
  assert.equal(config.activityRouting, 'on');
  for (const [tier, activity, expected] of [
    ['low', 'code', { model: 'sonnet', effort: 'medium' }],
    ['high', 'code', { model: 'opus', effort: 'max' }],
    ['low', 'review', { model: 'opus', effort: 'high' }],
    ['medium', 'ops', { model: 'sonnet', effort: 'high' }],
    ['low', 'docs', { model: 'haiku', effort: null }],
    ['low', 'debug', { model: 'sonnet', effort: 'high' }],
  ]) {
    assert.deepEqual(resolveRoute(config, tier, activity), expected, `${tier} ${activity}`);
  }
});

// What 1.6 pane saves and hand edits left in router.json: a mode other than its default, cells that differ
// from its Sonnet·medium overrides, and removed built-ins written as the tier's base route.
test('a 1.6 router.json loads unchanged: its mode and cells stay as written, other cells take the new defaults', () => {
  for (const [name, file, mode, cells] of [
    ['no activity keys', {}, 'on', [['low', 'code', { model: 'sonnet', effort: 'high' }]]],
    ['off', { activityRouting: 'off' }, 'off', []],
    [
      'a 1.6 removal of docs at low',
      { activities: { docs: { low: { model: 'haiku', effort: 'high' } } } },
      'on',
      [['low', 'docs', { model: 'haiku', effort: 'high' }]],
    ],
    [
      'a 1.6 Sonnet·medium cell for medium explore, written in full',
      { activityRouting: 'on', activities: { explore: { medium: { model: 'sonnet', effort: 'medium' } } } },
      'on',
      [
        ['medium', 'explore', { model: 'sonnet', effort: 'medium' }],
        ['medium', 'ops', { model: 'haiku', effort: 'high' }],
      ],
    ],
    [
      'a 1.6 effort-only cell now merges over the new built-in',
      { activities: { ops: { medium: { effort: 'low' } } } },
      'on',
      [['medium', 'ops', { model: 'haiku', effort: 'low' }]],
    ],
  ]) {
    const config = loadConfig({ userFile: file });
    assert.equal(config.activityRouting, mode, name);
    for (const [tier, activity, route] of cells)
      assert.deepEqual(resolveRoute(config, tier, activity), route, `${name}: ${tier} ${activity}`);
  }
});

test('a retired shadow mode reads as unset, and other unknown modes still throw', () => {
  for (const key of ['activityRouting', 'subagentRouting']) {
    assert.equal(loadConfig({ userFile: { [key]: 'shadow' } })[key], 'on', key);
    assert.throws(() => loadConfig({ userFile: { [key]: 'auto' } }), new RegExp(`${key} must be one of off, on`), key);
  }
  const both = loadConfig({
    userFile: { activityRouting: 'shadow', subagentRouting: 'shadow', baselineTier: 'medium' },
  });
  assert.deepEqual([both.activityRouting, both.subagentRouting, both.baselineTier], ['on', 'on', 'medium']);
});

test('the documented activities example loads in every mode', () => {
  for (const activityRouting of ACTIVITY_MODES) {
    const config = loadConfig({
      userFile: {
        activityRouting,
        activities: {
          code: { high: { effort: 'max' } },
          review: { low: { model: 'opus', effort: 'medium' } },
        },
      },
    });
    assert.equal(config.activityRouting, activityRouting);
  }
});

// A pane route draft of `config`, as routeDraftOf builds it.
const draftOf = (config) => {
  const base = structuredClone({
    routes: config.routes,
    baselineTier: config.baselineTier,
    activities: config.activities,
    activityRouting: config.activityRouting,
  });
  return { ...structuredClone(base), base };
};

test('a draft edits only the activity cells it changed and follows the saved config elsewhere', () => {
  const loaded = loadConfig({});
  const draft = editActivity(draftOf(loaded), loaded, 'ops', 'low', 'effort', 'medium');
  const saved = loadConfig({ userFile: { activities: { code: { low: { effort: 'high' } } }, activityRouting: 'on' } });
  const { activities, activityRouting } = effectiveActivities(draft, saved);
  assert.deepEqual(activities.ops, { low: { effort: 'medium' }, medium: saved.activities.ops.medium });
  assert.deepEqual(activities.code, { low: { model: 'sonnet', effort: 'high' } });
  assert.equal(activityRouting, 'on');
  const routesOnly = { routes: loaded.routes, baselineTier: 'low', base: draftOf(loaded).base };
  assert.deepEqual(effectiveActivities(routesOnly, saved), { activities: saved.activities, activityRouting: 'on' });
  assert.deepEqual(effectiveActivities(editActivity(draft, loaded, 'code', 'low', 'remove'), saved).activities.code, {
    low: null,
  });
});

test('supportedVersion accepts Claude Code 2.1.321 and newer, with or without a prerelease', () => {
  for (const [version, supported] of [
    ['2.1.321', true],
    ['2.1.322-beta.1', true],
    ['2.2.0', true],
    ['3.0.0', true],
    ['2.1.320', false],
    ['2.1.289', false],
    ['2.0.999', false],
    ['1.9.400', false],
    ['2.1.321.1', false],
    ['2.1', false],
    ['', false],
    [undefined, false],
  ])
    assert.equal(supportedVersion(version), supported, String(version));
});

test('capabilities validate values, effort keys and no-effort defaults', () => {
  for (const value of [0, 0.5, 1, 1.5, 2, 2.5, 3])
    assert.equal(
      loadConfig({ userFile: { models: { sonnet: { capability: { high: value } } } } }).models.sonnet.capability.high,
      value,
    );
  for (const value of [-0.5, 3.5, 1.1, null, '2', NaN, Infinity])
    assert.throws(
      () => loadConfig({ userFile: { models: { sonnet: { capability: { high: value } } } } }),
      /capability/,
    );
  for (const capability of [null, [], 1, { default: 1 }, { invalid: 1 }])
    assert.throws(() => loadConfig({ userFile: { models: { sonnet: { capability } } } }), /capability/);
  assert.equal(
    loadConfig({ provider: 'mimo', userFile: { models: { flash: { capability: { default: 2 } } } } }).models.flash
      .capability.default,
    2,
  );
  assert.throws(
    () => loadConfig({ provider: 'mimo', userFile: { models: { flash: { capability: { high: 2 } } } } }),
    /capability/,
  );
});

test('capability overrides replace maps and changed model IDs do not inherit them', () => {
  const capability = { high: 2, medium: 1.5 };
  const override = (model) => loadConfig({ userFile: { models: { sonnet: model } } }).models.sonnet;
  assert.deepEqual(override({ capability }).capability, capability);
  assert.deepEqual(override({ capability: {} }).capability, {});
  assert.deepEqual(override({ id: 'another-model', capability: { low: 1 } }).capability, { low: 1 });
  assert.equal(override({ id: 'another-model' }).capability, undefined);
  assert.deepEqual(override({ id: 'claude-sonnet-5-5[1m]' }).capability, DEFAULTS.models.sonnet.capability);
  assert.throws(() => override({ efforts: ['low'], capability: { high: 1 } }), /capability/);
  const inherited = override({ efforts: ['low'] }).capability;
  assert.deepEqual(
    inherited,
    Object.fromEntries(Object.entries(DEFAULTS.models.sonnet.capability).filter(([key]) => key === 'low')),
  );
});

test('inherited capability is pruned on effort edits and never copied to a new model', () => {
  const previous = DEFAULTS.models.sonnet.capability;
  DEFAULTS.models.sonnet.capability = { low: 1, high: 2 };
  try {
    const model = (patch) => loadConfig({ userFile: { models: { sonnet: patch } } }).models.sonnet;
    assert.deepEqual(model({ efforts: ['low'] }).capability, { low: 1 });
    assert.deepEqual(model({ efforts: [] }).capability, {});
    assert.deepEqual(model({ capability: { medium: 1.5 } }).capability, { medium: 1.5 });
    assert.deepEqual(model({ id: 'other', capability: { medium: 1.5 } }).capability, { medium: 1.5 });
    assert.equal(model({ id: 'other' }).capability, undefined);
    assert.deepEqual(model({ id: 'claude-sonnet-5-5[1m]' }).capability, { low: 1, high: 2 });
  } finally {
    DEFAULTS.models.sonnet.capability = previous;
  }
});

test('absent effort and model declarations remain unknown and zero remains declared', () => {
  const { models } = loadConfig({ userFile: { models: { sonnet: { capability: { low: 0, high: 2.5 } } } } });
  assert.equal(models.sonnet.capability.low, 0);
  assert.equal(models.sonnet.capability.medium, undefined);
  assert.equal(models.opus.capability.high, undefined);
  assert.equal(models.missing?.capability, undefined);
});

const glm = {
  id: 'glm-5.3[1m]',
  input: 1,
  output: 2,
  cacheRead: 0.1,
  contextWindow: 1_000_000,
  billing: 'credits',
  efforts: ['high', 'max'],
};
const plain = { ...glm, id: 'deepseek-flash', efforts: [] };
const withChains = (file) => loadConfig({ userFile: { ...file, models: { glm, deepseek: plain, ...file.models } } });

test('an activity capability map names a half-step per activity', () => {
  const capability = {
    default: 1.5,
    code: 2,
    debug: 0,
    explore: 3,
    plan: 1,
    review: 2.5,
    ops: 0.5,
    docs: 1,
  };
  const config = loadConfig({ userFile: { models: { sonnet: { capability: { high: capability } } } } });
  assert.deepEqual(config.models.sonnet.capability.high, capability);
  assert.equal(
    loadConfig({ provider: 'mimo', userFile: { models: { flash: { capability: { default: capability } } } } }).models
      .flash.capability.default.code,
    2,
  );
  for (const value of [
    { high: { write: 1 } },
    { high: { code: 4 } },
    { high: { code: -0.5 } },
    { high: { code: 0.25 } },
    { high: { code: '2' } },
    { high: { code: null } },
    { high: [] },
  ])
    assert.throws(() => loadConfig({ userFile: { models: { sonnet: { capability: value } } } }), /capability/);
  assert.throws(
    () => loadConfig({ provider: 'mimo', userFile: { models: { flash: { capability: { high: { code: 2 } } } } } }),
    /not supported/,
  );
});

test('no fallbacks or accounts are configured by default', () => {
  const config = loadConfig();
  assert.deepEqual([config.fallbacks, config.accounts], [{}, {}]);
});

test('a chain of aliases, with and without an effort, loads as written', () => {
  const config = withChains({ fallbacks: { opus: ['glm@max', 'deepseek'], sonnet: ['glm@high'] } });
  assert.deepEqual(config.fallbacks, { opus: ['glm@max', 'deepseek'], sonnet: ['glm@high'] });
});

test('a plan model is on the plan account and any other model on its own, unless it names one', () => {
  const config = withChains({ models: { glm: { ...glm, account: 'zai' }, deepseek: plain } });
  assert.deepEqual(
    ['opus', 'haiku', 'glm', 'deepseek'].map((alias) => accountOf(config, alias)),
    ['plan', 'plan', 'zai', 'deepseek'],
  );
  assert.equal(accountOf(config, 'unlisted'), 'unlisted');
  assert.equal(accountOf(withChains({ models: { opus: { account: 'work' } } }), 'opus'), 'work');
  assert.equal(accountOf(withChains({ models: { opus: { account: 'plan' } } }), 'opus'), 'plan');
  assert.equal(accountOf(withChains({ models: { plan: { ...glm, account: 'zai' } } }), 'plan'), 'zai');
});

test('an account keeps a monthly reset in a time zone', () => {
  const accounts = { zai: { reset: { monthly: 28, tz: 'Asia/Tokyo' } }, plan: {} };
  assert.deepEqual(withChains({ accounts }).accounts, accounts);
});

for (const [name, file, message] of [
  ['a chain for an unknown model', { fallbacks: { gpt: ['glm'] } }, /fallbacks\.gpt is not in models/],
  ['an unknown target', { fallbacks: { opus: ['gpt'] } }, /fallbacks\.opus\[0\] is not in models/],
  ['the second target unknown', { fallbacks: { opus: ['glm', 'gpt@max'] } }, /fallbacks\.opus\[1\] is not in models/],
  [
    'an effort the target lacks',
    { fallbacks: { opus: ['glm@xhigh'] } },
    /fallbacks\.opus\[0\] effort is not supported/,
  ],
  ['an effort on a target with no efforts', { fallbacks: { opus: ['deepseek@high'] } }, /effort is not supported/],
  ['an empty effort', { fallbacks: { opus: ['glm@'] } }, /effort is not supported/],
  [
    'a model standing in for itself',
    { fallbacks: { opus: ['glm', 'opus@high'] } },
    /fallbacks\.opus\[1\] is the model/,
  ],
  ['a target listed twice', { fallbacks: { opus: ['glm@high', 'glm@max'] } }, /fallbacks\.opus\[1\] is listed twice/],
  ['a chain that is not a list', { fallbacks: { opus: 'glm' } }, /fallbacks\.opus must be a list/],
  ['an entry that is not a string', { fallbacks: { opus: [7] } }, /fallbacks\.opus\[0\] must be a models key/],
  ['an entry with two efforts', { fallbacks: { opus: ['glm@high@max'] } }, /fallbacks\.opus\[0\] must be a models key/],
  ['an empty entry', { fallbacks: { opus: [''] } }, /fallbacks\.opus\[0\] must be a models key/],
  ['fallbacks that is not an object', { fallbacks: ['glm'] }, /fallbacks must be an object/],
  [
    'a model that needs its own history as the source',
    { models: { glm: { ...glm, requiresOwnHistory: true } }, fallbacks: { glm: ['deepseek'] } },
    /fallbacks\.glm mixes a model that requires its own history/,
  ],
  [
    'a model that needs its own history as a target',
    { models: { glm: { ...glm, requiresOwnHistory: true } }, fallbacks: { opus: ['deepseek', 'glm'] } },
    /fallbacks\.opus mixes a model that requires its own history/,
  ],
  [
    'two models that each need their own history',
    {
      models: { glm: { ...glm, requiresOwnHistory: true }, deepseek: { ...plain, requiresOwnHistory: true } },
      fallbacks: { glm: ['deepseek'] },
    },
    /mixes a model that requires its own history/,
  ],
  [
    'a flag that is not a boolean',
    { models: { glm: { ...glm, requiresOwnHistory: 'yes' } } },
    /models\.glm\.requiresOwnHistory must be a boolean/,
  ],
  [
    'an account name with a slash',
    { models: { glm: { ...glm, account: 'a/b' } } },
    /models\.glm\.account must be a name/,
  ],
  [
    'an account name that is empty',
    { models: { glm: { ...glm, account: '' } } },
    /models\.glm\.account must be a name/,
  ],
  [
    'a reset on day 0',
    { accounts: { zai: { reset: { monthly: 0, tz: 'UTC' } } } },
    /accounts\.zai\.reset\.monthly must be a day from 1 to 28/,
  ],
  ['a reset on day 29', { accounts: { zai: { reset: { monthly: 29, tz: 'UTC' } } } }, /accounts\.zai\.reset\.monthly/],
  ['a reset on a part of a day', { accounts: { zai: { reset: { monthly: 1.5, tz: 'UTC' } } } }, /reset\.monthly/],
  ['a reset with no day', { accounts: { zai: { reset: { tz: 'UTC' } } } }, /reset\.monthly/],
  [
    'a reset in an unknown zone',
    { accounts: { zai: { reset: { monthly: 1, tz: 'Mars/Olympus' } } } },
    /accounts\.zai\.reset\.tz must be an IANA time zone/,
  ],
  ['a reset with no zone', { accounts: { zai: { reset: { monthly: 1 } } } }, /reset\.tz/],
  [
    'a reset with an unknown key',
    { accounts: { zai: { reset: { monthly: 1, tz: 'UTC', weekly: 1 } } } },
    /accounts\.zai\.reset\.weekly is not a known key/,
  ],
  ['an account with an unknown key', { accounts: { zai: { limit: 1 } } }, /accounts\.zai\.limit is not a known key/],
  ['accounts that is not an object', { accounts: [] }, /accounts must be an object/],
  [
    'a credits model on the plan account',
    { models: { glm: { ...glm, account: 'plan' } } },
    /models\.glm\.account must not be plan for a credits model/,
  ],
  [
    'a credits model keyed plan with no account of its own',
    { models: { plan: glm } },
    /models\.plan\.account must not be plan for a credits model/,
  ],
])
  test(`rejects ${name}`, () => {
    assert.throws(() => withChains(file), message);
  });

test('an error names the setting, never its value', () => {
  assert.throws(
    () => withChains({ fallbacks: { opus: ['sekret-model'] } }),
    (error) => !error.message.includes('sekret'),
  );
});

test('the Kimi preset needs its own history, so a chain through it is refused', () => {
  const config = loadConfig({ provider: 'kimi', userFile: {} });
  assert.equal(config.models.k3.requiresOwnHistory, true);
  assert.equal(loadConfig({ provider: 'deepseek', userFile: {} }).models.flash.requiresOwnHistory, undefined);
  assert.throws(
    () => loadConfig({ provider: 'kimi', userFile: { models: { glm }, fallbacks: { k3: ['glm'] } } }),
    /fallbacks\.k3 mixes a model that requires its own history/,
  );
});
