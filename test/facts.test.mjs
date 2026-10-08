import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extractFacts as factsFromRequest } from '../lib/facts.mjs';
import { assistant, body, memory, toolResult, user } from './helpers.mjs';

const CONTEXT = { recentTurns: 4, maxTextChars: 30 };

const system = (text, extra = []) => ({ role: 'system', content: [{ type: 'text', text }, ...extra] });

test('a system message after the user message, where Claude Code 2.1.x puts hook output, does not hide the prompt', () => {
  const facts = factsFromRequest(
    body([user('fix the bug'), system('hook said x'), assistant('done'), user('now the tests'), system('hook')]),
    memory(),
    CONTEXT,
  );
  assert.equal(facts.prompt, 'now the tests');
  assert.equal(facts.continuation, false);
  assert.deepEqual(
    facts.turns.map((t) => [t.role, t.text]),
    [
      ['user', 'fix the bug'],
      ['assistant', 'done'],
    ],
  );
});

test('a trailing tool result is a continuation with no prompt, also behind a system message', () => {
  for (const [name, messages] of [
    ['tool result last', [user('run tests'), assistant('running', ['Bash']), toolResult('ok')]],
    [
      'system message after the tool result',
      [user('fix'), system('hook'), assistant('reading', ['Read']), toolResult('ok'), system('hook')],
    ],
  ]) {
    const facts = factsFromRequest(body(messages), memory(), CONTEXT);
    assert.equal(facts.continuation, true, name);
    assert.equal(facts.prompt, '', name);
  }
});

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

test('turns keep only the most recent ones, each clipped', () => {
  const messages = [];
  for (let i = 0; i < 10; i += 1) messages.push(user(`prompt ${i} ${'x'.repeat(80)}`), assistant(`answer ${i}`));
  const facts = factsFromRequest(body(messages), memory(), CONTEXT);
  assert.deepEqual(facts.turns, [
    { role: 'user', text: 'prompt 8 xxxx […] xxxxxxxxxxxx' },
    { role: 'assistant', text: 'answer 8' },
    { role: 'user', text: 'prompt 9 xxxx […] xxxxxxxxxxxx' },
    { role: 'assistant', text: 'answer 9' },
  ]);
});

test('repeated failure needs the same signature with an edit attempt between', () => {
  const same = body([
    user('go'),
    assistant('a', ['Bash']),
    toolResult('Error: test_login failed at line 12', { isError: true }),
    assistant('b', ['Edit']),
    toolResult('Error: test_login failed at line 40', { isError: true }),
  ]);
  assert.deepEqual(factsFromRequest(same, memory(), CONTEXT).failure, {
    signature: 'error: test_login failed at line #',
    index: 4,
  });
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

test('the prompt and earlier turns sent to Jev are capped at maxTextChars, keeping head and tail', () => {
  for (const [name, messages, context, read, expected] of [
    [
      'a long prompt',
      [user(`HEAD-${'x'.repeat(10_000)}-TAIL`)],
      CONTEXT,
      (f) => f.prompt,
      'HEAD-xxxxxxxx […] xxxxxxx-TAIL',
    ],
    ['a prompt within the cap', [user('fix the flaky test')], CONTEXT, (f) => f.prompt, 'fix the flaky test'],
    [
      'a long earlier turn',
      [user(`START-${'y'.repeat(500)}-END`), assistant('ok'), user('next')],
      CONTEXT,
      (f) => f.turns[0].text,
      'START-yyyyyyy […] yyyyyyyy-END',
    ],
    ['a cap smaller than the marker', [user('abcdefgh')], { ...CONTEXT, maxTextChars: 2 }, (f) => f.prompt, 'ab'],
  ]) {
    assert.equal(read(factsFromRequest(body(messages), memory(), context)), expected, name);
  }
});

test('the current user message is the prompt only, not also the last turn', () => {
  const facts = factsFromRequest(
    body([user('first task'), assistant('done'), user('CURRENT-MARKER now this')]),
    memory(),
    CONTEXT,
  );
  assert.equal(facts.prompt, 'CURRENT-MARKER now this');
  assert.deepEqual(
    facts.turns.map((t) => t.text),
    ['first task', 'done'],
  );
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
