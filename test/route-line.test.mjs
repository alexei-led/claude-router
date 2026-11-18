import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULTS } from '../lib/config.mjs';
import { lineOf } from '../lib/route-line.mjs';

test('a row for a refused activity move names the activity the band names, not the one the turn kept', () => {
  const view = {
    reason: 'activity-pending',
    activity: 'code',
    activityChoice: 'debug',
    activityProbabilities: { debug: 0.81 },
    tier: 'medium',
  };
  const route = { model: 'claude-sonnet-5-5', effort: 'high' };
  assert.equal(lineOf(DEFAULTS, view, route).reasonActivity, 'debug');
  assert.equal(lineOf(DEFAULTS, { ...view, activityProbabilities: { debug: 0.1 } }, route).reasonActivity, null);
  assert.equal(lineOf(DEFAULTS, { reason: 'upgrade', activity: 'code' }, route).reasonActivity, 'code');
});
