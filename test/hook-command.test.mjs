import assert from 'node:assert/strict';
import test from 'node:test';
import { argumentHint, SUBCOMMANDS } from '../lib/subcommands.mjs';
import { CONFIG, harness, JEV_KEY, projectPatch } from './harness.mjs';

async function started() {
  const h = harness(JEV_KEY);
  h.files.set(CONFIG, JSON.stringify({}));
  await h.event('session.start', { cwd: '/fixture' });
  return h;
}

// What typing `text` leaves at the cursor: the token before it and where that begins.
const typed = (text) => {
  const start = text.lastIndexOf(' ') + 1;
  return { text, cursor: text.length, token: text.slice(start), start };
};
const labels = async (h, text, engine) => (await h.autocomplete(typed(text), engine)).map((row) => row.label);

test('typeahead after /router offers the words that start with what is typed', async () => {
  const h = await started();
  const cases = [
    ['/router a', ['activities off', 'activities on']],
    ['/router e', ['engine table', 'engine shadow', 'engine auto']],
    ['/router p', ['pin micro', 'pin low', 'pin medium', 'pin high']],
    ['/router d', ['decisions [n]']],
    ['/router t', ['trace export']],
    ['/router h', ['holds']],
    ['/router r', ['release <model|account>']],
    ['/router release p', []],
    ['/router m', ['mode cost', 'mode balanced', 'mode quality', 'mode default']],
    ['/router mode', ['mode cost', 'mode balanced', 'mode quality', 'mode default']],
    ['/router  o', ['on', 'off']],
    ['/router O', ['on', 'off']],
    ['/router z', []],
    ['/router pin h', ['high']],
    ['/router pin m', ['micro', 'medium']],
    ['/router pin x', []],
    ['/router mode b', ['balanced']],
    ['/router activities o', ['off', 'on']],
    ['/router trace e', ['export']],
    ['/router decisions 5', []],
    ['/router pin high m', []],
  ];
  for (const [text, expected] of cases) assert.deepEqual(await labels(h, text), expected, text);
});

test('typeahead stays out of every other prompt', async () => {
  const h = await started();
  for (const text of ['a', 'auto', 'please /router a', '/routerx a', '/model a', '/router']) {
    assert.deepEqual(await h.autocomplete(typed(text)), [], text);
  }
});

test('typeahead rows follow the engine’s own and say what taking them writes', async () => {
  const h = await started();
  const engine = [{ text: '/router-help' }];
  const rows = await h.autocomplete(typed('/router mode q'), engine);
  assert.deepEqual(rows, [
    engine[0],
    { text: 'quality', label: 'quality', description: 'Stronger: one effort level more, else the tier above' },
  ]);
  assert.deepEqual(await h.autocomplete(typed('/router z'), engine), engine);
});

// Claude Code asks for rows only while a token is under the caret, so after `/router mode ` it asks nothing: a word
// that takes a value is offered with each value, a row that writes the whole command.
test('a word that takes a value is offered with each value and what it does, never as a word to finish', async () => {
  const h = await started();
  for (const sub of SUBCOMMANDS.filter((one) => one.values)) {
    const rows = await h.autocomplete(typed(`/router ${sub.name}`));
    assert.deepEqual(
      rows.map((row) => row.text),
      sub.values.map((value) => `${sub.name} ${value}`),
      sub.name,
    );
    for (const row of rows) assert.match(row.description ?? '', /\S/, row.text);
  }
});

test('typeahead names the model each tier runs', async () => {
  const h = await started();
  const rows = await h.autocomplete(typed('/router pin me'));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].text, 'medium');
  assert.match(rows[0].description, /\S/);
});

test('every word and value in the table runs a command, not the pane', async () => {
  const h = await started();
  const run = (args) => h.event('command.run', { command: 'router', args });
  const pane = await run('');
  for (const sub of SUBCOMMANDS) {
    for (const value of sub.values ?? ['']) {
      const args = `${sub.name} ${value}`.trim();
      assert.equal(typeof (await run(args)).text, 'string', args);
    }
    if (sub.hint === '[n]') assert.equal(typeof (await run(`${sub.name} 3`)).text, 'string');
  }
  assert.deepEqual(pane, {});
  assert.deepEqual(await run('nonsense'), {});
});

test('/router engine writes the project engine and answers with the save', async () => {
  const h = await started();
  const answer = await h.event('command.run', { command: 'router', args: 'engine auto' });
  assert.match(answer.text, /Saved: routing engine table → auto\. Applies from the next turn in this project\./);
  assert.deepEqual(projectPatch(h), { routingEngine: 'auto' });
  assert.equal(h.files.get(CONFIG), '{}');
});

test('the argument hint names every word of the table', () => {
  const hint = argumentHint();
  for (const sub of SUBCOMMANDS) assert.ok(hint.includes(sub.name), sub.name);
  assert.equal(hint.startsWith('['), true);
  assert.equal(hint.endsWith(']'), true);
});

test('/router decisions takes a whole number from 1 to 60, 20 when none is given', async () => {
  const h = await started();
  const run = async (args) => (await h.event('command.run', { command: 'router', args })).text;
  const choose = 'Choose decisions 1 to 60, or none for 20.';
  for (const n of ['0', '-3', '2.5', '1e1', '0x10', 'many']) assert.equal(await run(`decisions ${n}`), choose, n);
  for (const n of ['', ' 1', ' 60', ' 99']) assert.notEqual(await run(`decisions${n}`), choose, n);
});
