import assert from 'node:assert/strict';
import { test } from 'node:test';
import { IdleTracker, TURN_WAIT_MS } from '../lib/idle.mjs';

const IDLE = 1_000;

function tracker() {
  const clock = { t: 0 };
  return { clock, idle: new IdleTracker({ now: () => clock.t }) };
}

test('idle once no request came for the idle time', () => {
  const { clock, idle } = tracker();
  clock.t = IDLE - 1;
  assert.equal(idle.idle(IDLE), false);
  clock.t = IDLE;
  assert.equal(idle.idle(IDLE), true);
});

test('a request in flight keeps it busy however long it runs', () => {
  const { clock, idle } = tracker();
  idle.requestStarted();
  clock.t = 10 * IDLE;
  assert.equal(idle.idle(IDLE), false);
  idle.requestEnded();
  assert.equal(idle.idle(IDLE), false);
  clock.t += IDLE;
  assert.equal(idle.idle(IDLE), true);
});

test('a turn waiting for a tool result keeps it until the session sends its next request', () => {
  const { clock, idle } = tracker();
  idle.turnPaused('s'); // a permission prompt the user has not answered
  clock.t = 5 * IDLE;
  assert.equal(idle.idle(IDLE), false);
  idle.turnResumed('s');
  assert.equal(idle.idle(IDLE), true);
});

test('a session that died mid-turn stops counting after a day', () => {
  const { clock, idle } = tracker();
  idle.turnPaused('dead');
  clock.t = TURN_WAIT_MS - 1;
  assert.equal(idle.idle(IDLE), false);
  clock.t = TURN_WAIT_MS;
  assert.equal(idle.idle(IDLE), true);
});
