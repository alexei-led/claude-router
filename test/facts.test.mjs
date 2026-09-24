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
    ['user', 'assistant'],
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

// Jev input: the prompt is capped like every turn (head and tail kept), and it is not also the last turn.
test('a long prompt is capped to maxTextChars and keeps its head and tail', () => {
  const long = `HEAD-${'x'.repeat(10_000)}-TAIL`;
  const { prompt } = factsFromRequest(body([user(long)]), memory(), CONTEXT);
  assert.ok(prompt.length <= CONTEXT.maxTextChars, `length ${prompt.length}`);
  assert.ok(prompt.startsWith('HEAD-'));
  assert.ok(prompt.endsWith('-TAIL'));
});

test('a prompt within the cap is unchanged', () => {
  const { prompt } = factsFromRequest(body([user('fix the flaky test')]), memory(), CONTEXT);
  assert.equal(prompt, 'fix the flaky test');
});

test('a long earlier turn keeps its head and tail', () => {
  const facts = factsFromRequest(
    body([user(`START-${'y'.repeat(500)}-END`), assistant('ok'), user('next')]),
    memory(),
    CONTEXT,
  );
  assert.ok(facts.turns[0].text.length <= CONTEXT.maxTextChars);
  assert.ok(facts.turns[0].text.startsWith('START-'));
  assert.ok(facts.turns[0].text.endsWith('-END'));
});

test('the current user message is the prompt only, not also the last turn', () => {
  const facts = factsFromRequest(
    body([user('first task'), assistant('done'), user('CURRENT-MARKER now this')]),
    memory(),
    CONTEXT,
  );
  assert.match(facts.prompt, /CURRENT-MARKER/);
  assert.ok(facts.turns.every((t) => !t.text.includes('CURRENT-MARKER')));
});

test('a trailing tool result with text is not a turn either', () => {
  const trailing = {
    role: 'user',
    content: [
      { type: 'tool_result', tool_use_id: 't', content: [{ type: 'text', text: 'ok' }] },
      { type: 'text', text: 'TRAILING-MARKER' },
    ],
  };
  const facts = factsFromRequest(body([user('go'), assistant('running', ['Bash']), trailing]), memory(), CONTEXT);
  assert.ok(facts.turns.every((t) => !t.text.includes('TRAILING-MARKER')));
  assert.deepEqual(
    facts.turns.map((t) => t.text),
    ['go', 'running'],
  );
});

test('a history that ends with the assistant keeps it as the last turn', () => {
  const facts = factsFromRequest(body([user('go'), assistant('LAST-ASSISTANT')]), memory(), CONTEXT);
  assert.equal(facts.turns.at(-1).text, 'LAST-ASSISTANT');
  assert.equal(facts.prompt, '');
});

test('a cap smaller than the marker still bounds the text', () => {
  const { prompt } = factsFromRequest(body([user('abcdefgh')]), memory(), { ...CONTEXT, maxTextChars: 2 });
  assert.ok(prompt.length <= 2);
});
