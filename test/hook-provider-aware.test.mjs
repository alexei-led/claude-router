import assert from 'node:assert/strict';
import test from 'node:test';
import { answering, CONFIG, drain, harness, JEV_KEY, start, step, substituted } from './harness.mjs';
import { jevResponse, user } from './helpers.mjs';

test('native hook raises an ops reasoning phase without changing the goal and records delegated vs reported identity', async () => {
  const h = harness(JEV_KEY);
  h.model('claude-opus-5-5');
  answering(h, jevResponse('medium', { medium: 1 }, 0, { ops: 1 }, 'execute'));
  await start(h);
  await drain(h.step(step));
  assert.equal(h.view().selectedModel, 'claude-haiku-5-5');
  assert.equal(h.view().delegatedModel, h.requests[0].model);
  assert.equal(h.view().delegatedEffort, h.requests[0].effort);
  answering(h, jevResponse('medium', { medium: 1 }, 0.99, { ops: 1 }, 'reason'));
  const text = 'Determine why the deployment failed.';
  h.messages(async () => [user('Complete the operational task.'), user(text)]);
  await h.event('turn.start', { turnId: 't2', text });
  await drain(h.step({ ...step, turnId: 't2', messageCount: 2 }, substituted));
  assert.equal(h.requests.at(-1).model, 'claude-opus-5-5');
  assert.equal(h.view().goal, 'ops');
  assert.equal(h.view().taskPhase, 'reason');
  assert.equal(h.view().activity, 'debug');
  assert.equal(h.view().delegatedModel, 'claude-opus-5-5');
  assert.equal(h.view().delegatedEffort, 'medium');
  assert.equal(h.view().actualModel, 'claude-sonnet-5-5');
  assert.equal(Object.hasOwn(h.view(), 'servedEffort'), false);
  h.surfaces([]);
  const status = (await h.event('command.run', { command: 'router', args: '' })).text;
  assert.match(status, /Selected: claude-opus-5-5 · effort medium/);
  assert.match(status, /Last delegated to engine: claude-opus-5-5 · effort medium/);
  assert.match(status, /Response-reported model: claude-sonnet-5-5/);
  assert.match(status, /API-transmitted and served effort: unknown/);
  assert.match(status, /configured API-rate estimates \(list\/custom\), not bills/);
});

test('quality never caps explicit Haiku pins or manual effort and delegated fields follow pass-through', async () => {
  for (const effort of ['xhigh', 'max']) {
    const h = harness();
    h.files.set(CONFIG, JSON.stringify({ mode: 'quality', routes: { low: { model: 'haiku', effort } } }));
    await start(h);
    await h.event('command.run', { command: 'router', args: 'pin low' });
    await drain(h.step(step));
    assert.equal(h.requests[0].effort, effort);
    assert.equal(h.view().delegatedEffort, effort);
    await h.event('command.run', { command: 'router', args: 'off' });
    await h.event('turn.start', { turnId: 'manual', text: 'Explicit manual work.' });
    await drain(h.step({ ...step, turnId: 'manual', effort: 'max' }));
    assert.equal(h.view().delegatedEffort, 'max');
    assert.equal(h.view().delegatedModel, step.model);
  }
});

test('an absent response model stays unknown, never copied from the delegated request', async () => {
  const h = harness();
  await start(h);
  await h.event('command.run', { command: 'router', args: 'pin medium' });
  await drain(h.step(step, { usage: undefined }));
  assert.equal(h.view().delegatedModel, 'claude-opus-5-5');
  assert.equal(h.view().actualModel, null);
});
