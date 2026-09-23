import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadConfig } from '../lib/config.mjs';
import { clampEffort, rewriteRequest } from '../lib/rewrite.mjs';
import { body, user } from './helpers.mjs';

const config = loadConfig({});

test('high route sets the model and its effort, keeps everything else', () => {
  const b = body([user('x')]);
  const out = rewriteRequest(b, 'high', config);
  assert.equal(out.model, 'claude-opus-5-5');
  assert.deepEqual(out.output_config, { effort: 'xhigh' });
  assert.deepEqual(out.thinking, { type: 'adaptive' });
  assert.equal(out.messages, b.messages);
  assert.equal(b.model, 'router');
});

test('a route without effort keeps the client effort, clamped to the family', () => {
  const out = rewriteRequest(body([user('x')], { output_config: { effort: 'xhigh' } }), 'low', config);
  assert.equal(out.model, 'claude-sonnet-4-6');
  assert.equal(out.output_config.effort, 'high');
});

test('haiku drops effort and thinking', () => {
  const out = rewriteRequest(
    body([user('x')], { output_config: { effort: 'high', format: { type: 'json_schema' } } }),
    'micro',
    config,
  );
  assert.equal(out.model, 'claude-haiku-4-5');
  assert.equal(out.thinking, undefined);
  assert.deepEqual(out.output_config, { format: { type: 'json_schema' } });
  const bare = rewriteRequest(body([user('x')]), 'micro', config);
  assert.equal(bare.output_config, undefined);
});

test('haiku drops clear_thinking edits and keeps other edits', () => {
  const thinkingEdit = { type: 'clear_thinking_20251015', keep: 'all' };
  const toolEdit = { type: 'clear_tool_uses_20250919' };
  const mixed = body([user('x')], { context_management: { edits: [thinkingEdit, toolEdit] } });
  assert.deepEqual(rewriteRequest(mixed, 'micro', config).context_management, { edits: [toolEdit] });
  assert.equal(mixed.context_management.edits.length, 2);
  const only = body([user('x')], { context_management: { edits: [thinkingEdit] } });
  assert.equal(rewriteRequest(only, 'micro', config).context_management, undefined);
  assert.deepEqual(rewriteRequest(only, 'high', config).context_management, { edits: [thinkingEdit] });
});

test('clampEffort picks the highest supported level at or below', () => {
  assert.equal(clampEffort('xhigh', ['low', 'medium', 'high', 'max']), 'high');
  assert.equal(clampEffort('max', ['low', 'medium', 'high', 'max']), 'max');
  assert.equal(clampEffort('low', ['medium']), 'medium');
  assert.equal(clampEffort(undefined, ['low']), null);
  assert.equal(clampEffort('high', []), null);
});
