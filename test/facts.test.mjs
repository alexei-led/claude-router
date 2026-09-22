import assert from 'node:assert/strict';
import { test } from 'node:test';
import { factsFromRequest } from '../lib/facts.mjs';
import { assistant, body, memory, toolResult, user } from './helpers.mjs';

const CONTEXT = { recentTurns: 4, maxTextChars: 30 };

test('a new user turn yields the prompt without system reminders', () => {
  const b = body([
    user('fix the bug'),
    assistant('done'),
    {
      role: 'user',
      content: [
        { type: 'text', text: '<system-reminder>x</system-reminder>' },
        { type: 'text', text: 'now the tests' },
      ],
    },
  ]);
  const facts = factsFromRequest(b, memory(), CONTEXT);
  assert.equal(facts.prompt, 'now the tests');
  assert.equal(facts.continuation, false);
  assert.deepEqual(
    facts.turns.map((t) => t.role),
    ['user', 'assistant', 'user'],
  );
});

test('a tool result at the end is a continuation with no prompt', () => {
  const facts = factsFromRequest(
    body([user('run tests'), assistant('running', ['Bash']), toolResult('ok')]),
    memory(),
    CONTEXT,
  );
  assert.equal(facts.continuation, true);
  assert.equal(facts.prompt, '');
});

test('turns are bounded and truncated', () => {
  const messages = [];
  for (let i = 0; i < 10; i += 1) messages.push(user(`prompt ${i} ${'x'.repeat(80)}`), assistant(`answer ${i}`));
  const facts = factsFromRequest(body(messages), memory(), CONTEXT);
  assert.equal(facts.turns.length, 4);
  assert.ok(facts.turns[0].text.length <= 30);
});

test('repeated failure needs the same signature with an edit attempt between', () => {
  const same = body([
    user('go'),
    assistant('a', ['Bash']),
    toolResult('Error: test_login failed at line 12', { isError: true }),
    assistant('b', ['Edit']),
    toolResult('Error: test_login failed at line 40', { isError: true }),
  ]);
  assert.ok(factsFromRequest(same, memory(), CONTEXT).failure);
  const noEdit = body([
    user('go'),
    assistant('a', ['Bash']),
    toolResult('Error: x', { isError: true }),
    assistant('b'),
    toolResult('Error: x', { isError: true }),
  ]);
  assert.equal(factsFromRequest(noEdit, memory(), CONTEXT).failure, null);
});

test('memory fields pass through', () => {
  const m = memory({ lastRoute: 'high', models: { a: 1 } });
  const facts = factsFromRequest(body([user('x')]), m, CONTEXT);
  assert.equal(facts.lastRoute, 'high');
  assert.deepEqual(facts.models, { a: 1 });
});
