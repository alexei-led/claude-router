import assert from 'node:assert/strict';
import test from 'node:test';
import { TIER_COLOR } from '../lib/display.mjs';
import { paintersOf } from '../lib/ui/painter.mjs';
import { ELEMENTS } from './harness.mjs';

const ui = paintersOf(ELEMENTS, 'terminal');
const texts = (tree) =>
  JSON.stringify(tree)
    .match(/"children":"([^"]*)"/g)
    ?.map((m) => m.slice(12, -1)) ?? [];

test('every surface draws with the terminal kit until the graphical one exists', () => {
  assert.deepEqual(Object.keys(paintersOf(ELEMENTS, 'desktop')), Object.keys(ui));
  assert.deepEqual(Object.keys(paintersOf(ELEMENTS)), Object.keys(ui));
});

test('section is a heading with its hint, the children, then a blank row', () => {
  const child = ui.text('body');
  const tree = ui.section('ROUTES', { hint: 'which model runs' }, [child]);
  assert.equal(tree.props.flexDirection, 'column');
  assert.deepEqual(texts(tree), ['ROUTES', ' which model runs', 'body', ' ']);
  assert.equal(tree.props.children[0].props.children[0].props.bold, true);
  assert.equal(ui.section('X', {}, []).props.children.length, 2);
});

test('section keeps its action on the heading row', () => {
  const action = ui.Button({ key: 'go', label: 'Go' });
  assert.equal(ui.section('X', { action }, []).props.children[0].props.children.at(-1), action);
});

test('field sets the label in a fixed column and the help under it', () => {
  const row = ui.field('Mode', ['on']);
  assert.equal(row.props.children[0].props.width, 22);
  const helped = ui.field('Mode', ['on'], { help: 'why', dim: true });
  assert.deepEqual(texts(helped), ['Mode', 'on', '', 'why']);
  assert.equal(helped.props.children[0].props.children[0].props.children[0].props.dimColor, true);
});

test('meter lights cells for the value in the tone colour', () => {
  const tree = ui.meter({ label: 'ctx ', value: 0.5, tone: 'tier:high', text: '50%', caption: 'left', cells: 4 });
  assert.equal(tree.props.children, 'ctx ▰▰▱▱ 50%  left');
  assert.equal(tree.props.color, TIER_COLOR.high);
});

test('strip draws a cell per reply, then the counts per tier', () => {
  const tree = ui.strip({ per: 1, cells: [{ low: 1 }, { high: 2 }, { none: 1 }] }, { columns: 80, now: 0 });
  assert.equal(tree.props.children.length, 2);
  assert.deepEqual(texts(tree).slice(0, 4), ['  tiers ', '█', '█', '·']);
  assert.deepEqual(ui.strip(null, { columns: 80, now: 0 }).props.children, []);
});

test('strip merges cells to fit the columns and says how many replies each holds', () => {
  const cells = Array.from({ length: 40 }, () => ({ low: 1 }));
  const tree = ui.strip({ per: 1, cells }, { columns: 30, now: 0 });
  assert.ok(texts(tree).some((t) => /^ {2}\d+ replies per cell$/.test(t)));
});

test('stat sets the value bold with its delta and caption', () => {
  const tree = ui.stat({ value: '$1.20', delta: '+5%', caption: 'today', tone: 'success' });
  assert.deepEqual(texts(tree), ['$1.20', '  +5%', '  today']);
  assert.equal(tree.props.children[0].props.bold, true);
});

test('choice is a Select where the surface has one, else the chosen label', () => {
  const picked = [];
  const options = [
    { value: 'a', label: 'A' },
    { value: 'b', label: 'B' },
  ];
  const tree = ui.choice({ key: 'k', options, selected: 'b', onPick: (v) => picked.push(v) });
  assert.equal(tree.type, 'Select');
  assert.equal(tree.props.value, 'b');
  tree.props.onSelect('a');
  assert.deepEqual(picked, ['a']);
  const bare = paintersOf({ Box: ELEMENTS.Box, Text: ELEMENTS.Text, Button: ELEMENTS.Button }, 'terminal');
  assert.equal(bare.choice({ key: 'k', options, selected: 'b', onPick() {} }).props.children, 'B');
});

test('table is a header row and a row per record, fixed columns padded for right alignment', () => {
  const tree = ui.table(
    [
      { key: 'name', label: 'Name', width: 6 },
      { key: 'n', label: 'N', align: 'right', width: 4 },
    ],
    [{ name: 'low', n: '7' }],
  );
  assert.equal(tree.props.children.length, 2);
  assert.deepEqual(texts(tree), ['Name', 'N', 'low', '   7']);
  assert.equal(tree.props.children[1].props.children[0].props.width, 6);
});

test('notice is one line in the tone colour with its action', () => {
  const action = ui.Button({ key: 'go', label: 'Go' });
  const tree = ui.notice('warning', 'careful', action);
  assert.equal(tree.props.children[0].props.children, 'careful');
  assert.equal(tree.props.children[1], action);
  assert.equal(JSON.stringify(ui.notice('danger', 'x')).includes('Button'), false);
});

test('strip says since when the strip restarted after the session began', () => {
  const from = new Date(2026, 9, 13, 12, 5).getTime();
  const strip = { per: 1, cells: [{ low: 1 }], from };
  const clock = new Date(from).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  const restarted = ui.strip(strip, { columns: 80, now: from + 1000, since: from - 60000 });
  assert.ok(texts(restarted).includes(`  since ${clock}`));
  assert.ok(!texts(ui.strip(strip, { columns: 80, now: from + 1000, since: from })).some((t) => t.includes('since')));
  assert.ok(!texts(ui.strip(strip, { columns: 80, now: from + 1000 })).some((t) => t.includes('since')));
});
