// The initial auto state, the decision, shadow and the replay share one activity column; activity routing off means
// the default column, however the turn is classified.
import assert from 'node:assert/strict';
import test from 'node:test';
import { adviceActivity, takeAutoAdvice } from '../lib/auto-route.mjs';
import { loadConfig } from '../lib/config.mjs';

const config = (activityRouting) => loadConfig({ userFile: { activityRouting } });
const answer = (choice, mass) => ({ type: 'choice', choice, confidence: mass, probabilities: { [choice]: mass } });
const advice = (activity, mass, phase = null) => ({
  activity: answer(activity, mass),
  ...(phase ? { phase: answer(phase, mass) } : {}),
});

test('the routing activity, not the accepted goal, is the column the decision uses', () => {
  const cfg = config('on');
  const verify = advice('code', 1, 'verify');
  assert.equal(adviceActivity(cfg, verify), 'ops');
  const state = {};
  takeAutoAdvice(cfg, state, verify);
  assert.equal(state.activity, 'ops');
  assert.equal(adviceActivity(cfg, advice('ops', 1, 'produce')), 'code');
});

test('activity routing off leaves the default capability column', () => {
  const cfg = config('off');
  assert.equal(adviceActivity(cfg, advice('code', 1)), null);
  const state = {};
  takeAutoAdvice(cfg, state, advice('code', 1));
  assert.equal(state.activity, undefined);
});
