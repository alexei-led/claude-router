import assert from 'node:assert/strict';
import { test } from 'node:test';
import { capabilityGaps } from '../lib/capability-gaps.mjs';
import { DEFAULTS, TIERS } from '../lib/config.mjs';

const model = (capability, efforts = ['low', 'high', 'max']) => ({
  ...DEFAULTS.models.opus,
  id: 'test-model',
  efforts,
  capability,
});
const allTiers = (route) => Object.fromEntries(TIERS.map((tier) => [tier, route]));
const config = ({ models, route, activities = {}, ...rest }) => ({
  ...DEFAULTS,
  routingEngine: 'auto',
  models,
  routes: allTiers(route),
  activities,
  ...rest,
});
const one = (capability, effort, efforts) =>
  config({ models: { m: model(capability, efforts) }, route: { model: 'm', effort } });

test('a routed cell is a gap when the engine reads no capability for it', () => {
  const cases = [
    ['number', one({ high: 2 }, 'high'), []],
    ['zero is rated', one({ high: 0 }, 'high'), []],
    ['activity map with a default', one({ high: { default: 2 } }, 'high'), []],
    ['activity map without a default', one({ high: { code: 2 } }, 'high'), ['m@high']],
    ['no capability', one({}, 'high'), ['m@high']],
    ['no capability map', one(undefined, 'high'), ['m@high']],
    ['another effort only', one({ low: 1 }, 'max'), ['m@max']],
    ['unlisted effort runs the one below', one({ low: 1 }, 'medium'), []],
    ['no-effort model, rated', one({ default: 1 }, null, []), []],
    ['no-effort model, unrated', one({}, null, []), ['m']],
    ['session effort, one effort rated', one({ low: 1 }, null), []],
    ['session effort, none rated', one({}, null), ['m']],
  ];
  for (const [name, given, expected] of cases) assert.deepEqual(capabilityGaps(given), expected, name);
});

test('activity cells are read under their activity, once each, only while activity routing is on', () => {
  const given = config({
    models: { m: model({ high: { default: 2 }, max: { code: 3 } }), other: model({}) },
    route: { model: 'm', effort: 'high' },
    activities: {
      code: { medium: { model: 'm', effort: 'max' }, high: { model: 'other', effort: 'max' } },
      debug: { medium: { model: 'm', effort: 'max' }, high: { model: 'other', effort: 'max' } },
    },
  });
  assert.deepEqual(capabilityGaps(given), ['other@max', 'm@max']);
  assert.deepEqual(capabilityGaps({ ...given, activityRouting: 'off' }), []);
});

test('only shadow also reads the routes the routing mode moves to', () => {
  const given = one({ low: 1 }, 'low');
  const quality = { mode: 'quality', source: 'profile' };
  assert.deepEqual(capabilityGaps({ ...given, routingEngine: 'shadow' }, quality), ['m@high']);
  assert.deepEqual(capabilityGaps({ ...given, routingEngine: 'auto' }, quality), []);
  assert.deepEqual(capabilityGaps({ ...given, routingEngine: 'shadow' }, { mode: 'balanced', source: 'default' }), []);
});
