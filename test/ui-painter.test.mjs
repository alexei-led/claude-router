import assert from 'node:assert/strict';
import test from 'node:test';
import { paintersOf } from '../lib/ui/painter.mjs';
import { ELEMENTS, texts } from './harness.mjs';

const ui = paintersOf(ELEMENTS, 'terminal');

test('the graphical painter exposes every method the terminal kit does, and its cards', () => {
  const graphical = Object.keys(paintersOf(ELEMENTS, 'desktop'));
  for (const name of Object.keys(ui)) assert.ok(graphical.includes(name), name);
  for (const name of ['section', 'field', 'meter', 'strip', 'stat', 'choice', 'table'])
    assert.ok(graphical.includes(name) && !(name in ui), name);
  assert.deepEqual(Object.keys(paintersOf(ELEMENTS)), Object.keys(ui));
});

// The session strip as the terminal's two rows: a cell per reply, then the replies per tier.
const rows = (strip, opts) => ({ type: 'Box', props: { children: ui.stripRows(strip, opts) } });
test('stripRows draws a cell per reply, then the counts per tier', () => {
  const tree = rows({ per: 1, cells: [{ low: 1 }, { high: 2 }, { none: 1 }] }, { columns: 80, now: 0 });
  assert.equal(tree.props.children.length, 2);
  assert.deepEqual(texts(tree).slice(0, 4), ['  tiers ', '█', '█', '·']);
  assert.deepEqual(ui.stripRows(null, { columns: 80, now: 0 }), []);
});

test('stripRows merges cells to fit the columns and says how many replies each holds', () => {
  const cells = Array.from({ length: 40 }, () => ({ low: 1 }));
  const tree = rows({ per: 1, cells }, { columns: 30, now: 0 });
  assert.ok(texts(tree).some((t) => /^ {2}\d+ replies per cell$/.test(t)));
});

test('notice is one line in the tone colour with its action', () => {
  const action = ui.Button({ key: 'go', label: 'Go' });
  const tree = ui.notice('warning', 'careful', action);
  assert.equal(tree.props.children[0].props.children, 'careful');
  assert.equal(tree.props.children[1], action);
  assert.equal(JSON.stringify(ui.notice('danger', 'x')).includes('Button'), false);
});

test('stripRows says since when the strip restarted after the session began', () => {
  const from = new Date(2026, 9, 13, 12, 5).getTime();
  const strip = { per: 1, cells: [{ low: 1 }], from };
  const clock = new Date(from).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  const restarted = rows(strip, { columns: 80, now: from + 1000, since: from - 60000 });
  assert.ok(texts(restarted).includes(`  since ${clock}`));
  assert.ok(!texts(rows(strip, { columns: 80, now: from + 1000, since: from })).some((t) => t.includes('since')));
  assert.ok(!texts(rows(strip, { columns: 80, now: from + 1000 })).some((t) => t.includes('since')));
});
