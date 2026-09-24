import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadConfig } from '../lib/config.mjs';
import { adaptBetas, clampEffort, rewriteRequest } from '../lib/rewrite.mjs';
import { assistant, body, user } from './helpers.mjs';

const config = loadConfig({});

// Shapes captured from Claude Code 2.1.281 sessions on 2026-09-24: hook output goes in a `system` message after the
// prompt, and turn 1 adds the advisor tool with a `tool_addition` block that carries the cache breakpoint.
const CACHE = { type: 'ephemeral', ttl: '1h' };
const system = (text, extra = []) => ({ role: 'system', content: [{ type: 'text', text }, ...extra] });
const toolAddition = (cache = CACHE) => ({
  type: 'tool_addition',
  tool: { type: 'tool_reference', name: 'advisor' },
  cache_control: cache,
});
const conversation = () => [
  user('hi'),
  system('SessionStart hook output', [toolAddition()]),
  assistant('4'),
  user('next'),
  system('UserPromptSubmit hook output'),
];

test('opus takes system messages and tool changes: the messages are untouched', () => {
  const b = body(conversation());
  assert.equal(rewriteRequest(b, 'high', config).messages, b.messages);
});

test('sonnet keeps system messages but not tool additions; the cache breakpoint moves to the block before', () => {
  const b = body(conversation());
  const out = rewriteRequest(b, 'low', config).messages;
  assert.deepEqual(
    out.map((m) => m.role),
    ['user', 'system', 'assistant', 'user', 'system'],
  );
  assert.deepEqual(out[1].content, [{ type: 'text', text: 'SessionStart hook output', cache_control: CACHE }]);
  assert.equal(b.messages[1].content.length, 2, 'the request body is not mutated');
  const removal = body([user('hi'), system('hook', [{ type: 'tool_removal', tool: { name: 'advisor' } }])]);
  assert.deepEqual(rewriteRequest(removal, 'low', config).messages[1].content, [{ type: 'text', text: 'hook' }]);
});

test('a system message that held only a tool addition is dropped for sonnet', () => {
  const b = body([user('hi'), { role: 'system', content: [toolAddition(undefined)] }]);
  assert.deepEqual(
    rewriteRequest(b, 'low', config).messages.map((m) => m.role),
    ['user'],
  );
});

test('haiku takes no system messages: their text joins the user message as a system reminder', () => {
  const out = rewriteRequest(body(conversation()), 'micro', config).messages;
  assert.deepEqual(out, [
    {
      role: 'user',
      content: [
        { type: 'text', text: 'hi' },
        { type: 'text', text: '<system-reminder>\nSessionStart hook output\n</system-reminder>', cache_control: CACHE },
      ],
    },
    { role: 'assistant', content: [{ type: 'text', text: '4' }] },
    {
      role: 'user',
      content: [
        { type: 'text', text: 'next' },
        { type: 'text', text: '<system-reminder>\nUserPromptSubmit hook output\n</system-reminder>' },
      ],
    },
  ]);
});

test('the same history adapts the same way every turn, so the cached prefix holds', () => {
  const turn1 = rewriteRequest(body(conversation().slice(0, 2)), 'micro', config).messages;
  const turn2 = rewriteRequest(body(conversation()), 'micro', config).messages;
  assert.deepEqual(turn2[0], turn1[0]);
});

test('a model added without features gets neither system messages nor tool changes', () => {
  const custom = loadConfig({
    userFile: {
      models: {
        other: { id: 'claude-other', input: 1, cacheRead: 0.1, contextWindow: 200_000, billing: 'plan', efforts: [] },
      },
      routes: { micro: { model: 'other' } },
    },
  });
  const out = rewriteRequest(body(conversation()), 'micro', custom).messages;
  assert.deepEqual(
    out.map((m) => m.role),
    ['user', 'assistant', 'user'],
  );
});

test('betas the routed model does not support are dropped', () => {
  const sent =
    'oauth-2025-04-20,context-1m-2025-08-07,mid-conversation-system-2026-04-07,per-turn-control-2026-07-01,mid-conversation-tool-changes-2026-07-01';
  assert.equal(adaptBetas(sent, 'claude-opus-5-5', config), sent);
  assert.equal(
    adaptBetas(sent, 'claude-sonnet-5', config),
    'oauth-2025-04-20,context-1m-2025-08-07,mid-conversation-system-2026-04-07',
  );
  assert.equal(adaptBetas(sent, 'claude-haiku-4-5', config), 'oauth-2025-04-20');
  assert.equal(adaptBetas('context-1m-2025-08-07', 'claude-haiku-4-5', config), null);
});

test('high route sets the model and its effort, keeps everything else', () => {
  const b = body([user('x')]);
  const out = rewriteRequest(b, 'high', config);
  assert.equal(out.model, 'claude-opus-5-5');
  assert.deepEqual(out.output_config, { effort: 'xhigh' });
  assert.deepEqual(out.thinking, { type: 'adaptive' });
  assert.equal(out.messages, b.messages);
  assert.equal(b.model, 'jev-router');
});

test('a route without effort keeps the client effort, clamped to the family', () => {
  const out = rewriteRequest(body([user('x')], { output_config: { effort: 'xhigh' } }), 'low', config);
  assert.equal(out.model, 'claude-sonnet-5');
  assert.equal(out.output_config.effort, 'xhigh');
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

test('max_tokens is capped at the output limit of the routed model', () => {
  const cases = [
    ['micro', 128_000, 64_000],
    ['micro', 32_000, 32_000],
    ['high', 128_000, 128_000],
  ];
  for (const [tier, sent, expected] of cases)
    assert.equal(rewriteRequest(body([user('x')], { max_tokens: sent }), tier, config).max_tokens, expected, tier);
});
