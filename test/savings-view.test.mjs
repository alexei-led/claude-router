import assert from 'node:assert/strict';
import test from 'node:test';
import { renderBand } from '../lib/band.mjs';
import { DEFAULTS } from '../lib/config.mjs';
import { savingsLine, TIER_COLOR } from '../lib/display.mjs';
import { renderPanel } from '../lib/panel.mjs';
import { ELEMENTS, screen } from './harness.mjs';

const actions = new Proxy({}, { get: () => () => {} });
const SINCE = Date.parse('2026-10-10T12:00:00Z');
const STORE = {
  version: 1,
  since: SINCE,
  replies: 400,
  routedUsd: 41.18,
  yoursUsd: 52.6,
  cheaperUsd: -14.9,
  strongerUsd: 0,
  switchUsd: 3.48,
};
const SAVES = {
  replies: 64,
  routedUsd: 6.404,
  yoursUsd: 8.236,
  cheaperUsd: -2.31,
  strongerUsd: 0,
  switchUsd: 0.478,
  tiers: { micro: 12, low: 26, medium: 17, high: 9 },
  tierUsd: { micro: 0.4, low: 2.3, medium: 2.1, high: 1.6 },
  stronger: {},
};
const MORE = {
  replies: 41,
  routedUsd: 3.1,
  yoursUsd: 0.62,
  cheaperUsd: 0,
  strongerUsd: 2.31,
  switchUsd: 0.17,
  tiers: { low: 24, medium: 12, high: 5 },
  tierUsd: { low: 0.5, medium: 1.4, high: 1.2 },
  stronger: { 'claude-opus-5-5': 9 },
};
const EARLY = { ...SAVES, replies: 3, routedUsd: 0.21, yoursUsd: 0.26, cheaperUsd: -0.06, switchUsd: 0.01 };
const SHADOW = {
  byActivity: {},
  switches: { tier: 0, activity: 0 },
  agreement: { matched: 0, total: 0 },
  shadow: { differs: 3, turns: 20, estimated: 3, minUsd: -0.42, maxUsd: -0.11 },
};
const OPUS = { nativeModel: 'claude-opus-5-5', nativeEffort: 'xhigh' };
const HAIKU = { nativeModel: 'claude-haiku-5-5', nativeEffort: 'high' };
const FOOTER = [
  '',
  '  API list prices · same tokens and output length · not a bill;',
  '  on a Claude plan it stands for quota · answer quality not measured',
];
const SAVED_FOOTER = ['', '  since Oct 10: each session compared with its own model', ...FOOTER.slice(1)];

const view = (props) => ({
  mode: 'auto',
  phase: 'routed',
  tab: 'usage',
  credentials: { jev: null },
  tier: 'low',
  selectedModel: 'claude-haiku-5-5',
  actualModel: 'claude-haiku-5-5',
  effort: 'high',
  tiers: ['low', 'low', 'high'],
  savingsStore: STORE,
  ...props,
});

function section(props, { columns = 100, config = DEFAULTS } = {}) {
  const lines = screen(renderPanel(ELEMENTS, config, view(props), null, actions, { columns }));
  const at = lines.findIndex((line) => line.startsWith('ROUTING VS YOUR MODEL'));
  return lines.slice(at, lines.indexOf('USAGE · Claude readings') - 1);
}

test('the Usage tab opens with routing vs your model, each number on the line that names it', () => {
  for (const [name, props, expected] of [
    [
      'a session that saves',
      { ...OPUS, savings: SAVES, activityStats: SHADOW },
      [
        'ROUTING VS YOUR MODEL · Opus 5.5 · xhigh   this session   since Oct 10',
        '  Routed replies                           $6.40          $41.18',
        '  Same tokens on your model                $8.24          $52.60',
        '  Difference                               −$1.84 −22%    −$11.42 −22%',
        '    cheaper models                         −$2.31         −$14.90',
        '    stronger than yours                    $0.00          $0.00',
        '    cache writes from switches             +$0.47         +$3.48',
        '',
        '  routed      █████████████████░░░░░  $6.40',
        '  your model  ██████████████████████  $8.24',
        '  ■ micro 19%  ■ low 41%  ■ medium 27%  ■ high 14% of replies',
        '  if activity routing were on: est. −$0.42 … −$0.11 this session',
        ...SAVED_FOOTER,
      ],
    ],
    [
      'a session on Haiku that costs more',
      {
        ...HAIKU,
        savings: MORE,
        savingsStore: { ...STORE, routedUsd: 12.74, yoursUsd: 2.95, cheaperUsd: 0, strongerUsd: 9.02, switchUsd: 0.77 },
      },
      [
        'ROUTING VS YOUR MODEL · Haiku 5.5 · high   this session   since Oct 10',
        '  Routed replies                           $3.10          $12.74',
        '  Same tokens on your model                $0.62          $2.95',
        '  Difference                               +$2.48 ×5.0    +$9.79 ×4.3',
        '    cheaper models                         $0.00          $0.00',
        '    stronger than yours                    +$2.31         +$9.02',
        '      9 replies on Opus 5.5',
        '    cache writes from switches             +$0.17         +$0.77',
        '',
        '  routed      ██████████████████████  $3.10',
        '  your model  ████░░░░░░░░░░░░░░░░░░  $0.62',
        '  ■ low 59%  ■ medium 29%  ■ high 12% of replies',
        '  Routing spent more than Haiku 5.5 alone because upper tiers ran on Opus 5.5.',
        '  To spend less, pick cheaper models for those tiers in the Routing tab.',
        ...SAVED_FOOTER,
      ],
    ],
    [
      'too early in this session',
      { ...OPUS, savings: EARLY },
      [
        'ROUTING VS YOUR MODEL · Opus 5.5 · xhigh   this session   since Oct 10',
        '  Routed replies                           $0.21          $41.18',
        '  Same tokens on your model                $0.26          $52.60',
        '  Difference                               too early      −$11.42 −22%',
        '    3 routed replies so far; the session figure appears after 10',
        ...SAVED_FOOTER,
      ],
    ],
    [
      'routing off',
      { nativeModel: 'claude-sonnet-5-5', nativeEffort: 'medium', mode: 'manual', phase: 'manual', savings: null },
      [
        'ROUTING VS YOUR MODEL · Sonnet 5.5 · medium   this session   since Oct 10',
        '  Routing is off: every reply this session used your model.',
        '  Difference                                  $0.00          −$11.42 −22%',
        ...SAVED_FOOTER,
      ],
    ],
    [
      'routing unavailable',
      { ...OPUS, mode: 'auto', phase: 'unavailable', error: 'requires Claude Code 2.1.289 or newer', savings: null },
      [
        'ROUTING VS YOUR MODEL · Opus 5.5 · xhigh   this session   since Oct 10',
        '  Routing is unavailable: every reply this session used your model.',
        '  Difference                               $0.00          −$11.42 −22%',
        ...SAVED_FOOTER,
      ],
    ],
    [
      'a first session, before any reply',
      { ...OPUS, savings: null, savingsStore: null },
      [
        'ROUTING VS YOUR MODEL · Opus 5.5 · xhigh   this session',
        '  Routed replies                           $0.00',
        '  Same tokens on your model                $0.00',
        '  Difference                               too early',
        '    0 routed replies so far; the session figure appears after 10',
        ...FOOTER,
      ],
    ],
    [
      'a model without a list price',
      { nativeModel: 'claude-mystery-1-0', nativeEffort: null, savings: SAVES },
      ['ROUTING VS YOUR MODEL · Mystery 1.0', '  Mystery 1.0 has no list price in router.json models.'],
    ],
  ])
    assert.deepEqual(section(props), expected, name);
});

test('your model takes the color of the tier that runs it at your effort', () => {
  const colorOf = (props) => {
    const tree = renderPanel(ELEMENTS, DEFAULTS, view({ ...props, savings: SAVES }), null, actions);
    const found = [];
    (function walk(node) {
      if (node?.type === 'Text' && node.props.children === yourModel(props)) found.push(node.props.color);
      if (Array.isArray(node?.props?.children)) node.props.children.forEach(walk);
    })(tree);
    return found[0];
  };
  const yourModel = ({ nativeModel, nativeEffort }) =>
    `${nativeModel.includes('opus') ? 'Opus' : 'Haiku'} 5.5 · ${nativeEffort}`;
  assert.equal(colorOf(OPUS), TIER_COLOR.high);
  assert.equal(colorOf({ ...OPUS, nativeEffort: 'medium' }), TIER_COLOR.medium);
  assert.equal(colorOf(HAIKU), TIER_COLOR.low);
});

test('a narrow pane keeps every sentence whole and indented', () => {
  const lines = section({ ...OPUS, savings: EARLY }, { columns: 58 });
  assert.deepEqual(lines.slice(lines.findIndex((line) => line.includes('so far'))), [
    '    3 routed replies so far; the session figure appears',
    '    after 10',
    '',
    '  since Oct 10: each session compared with its own model',
    '  API list prices · same tokens and output length',
    '  not a bill; on a Claude plan it stands for quota',
    '  answer quality not measured',
  ]);
  assert.ok(lines.every((line) => line.length <= 58));
});

test('a narrow pane drops the bars before any number, then the saved column', () => {
  const props = { ...OPUS, savings: SAVES, activityStats: SHADOW };
  const at64 = section(props, { columns: 64 });
  assert.deepEqual(at64.slice(0, 4), [
    'ROUTING VS YOUR MODEL · Opus 5.5 · xhigh',
    '                             this session   since Oct 10',
    '  Routed replies             $6.40          $41.18',
    '  Same tokens on your model  $8.24          $52.60',
  ]);
  assert.ok(!at64.some((line) => line.includes('█')));
  assert.ok(at64.includes('  ■ micro 19%  ■ low 41%  ■ medium 27%  ■ high 14% of replies'));
  const at56 = section(props, { columns: 56 });
  assert.equal(at56[3], '  Same tokens on your model  $8.24');
  assert.ok(at56.every((line) => !line.includes('since')));
});

test('the activity estimate shows only in shadow, where on is not yet in the routed figure', () => {
  const props = { ...OPUS, savings: SAVES, activityStats: SHADOW };
  for (const mode of ['off', 'on'])
    assert.ok(!section(props, { config: { ...DEFAULTS, activityRouting: mode } }).some((l) => l.includes('activity')));
});

test('the two-row band adds the session against your model once it is past too early and fits', () => {
  const second = (props, columns = 140) =>
    screen(renderBand(ELEMENTS, DEFAULTS, view({ bandDetail: true, ...props }), null, { columns }, actions))[1];
  assert.equal(
    second({ ...OPUS, savings: SAVES }),
    'replies ███  1 switch  ·  vs your model −22% (−$1.84, list prices)',
  );
  assert.equal(
    second({ ...HAIKU, savings: MORE }),
    'replies ███  1 switch  ·  vs your model +$2.48 (stronger models, list prices)',
  );
  assert.equal(
    second({ ...HAIKU, savings: { ...MORE, strongerUsd: 0.1, switchUsd: 2.38 } }),
    'replies ███  1 switch  ·  vs your model +$2.48 (switch cache writes, list prices)',
  );
  assert.equal(second({ ...OPUS, savings: EARLY }), 'replies ███  1 switch');
  assert.equal(second({ ...OPUS, savings: SAVES }, 50), 'replies ███  1 switch');
  const oneRow = screen(
    renderBand(ELEMENTS, DEFAULTS, view({ ...OPUS, savings: SAVES }), null, { columns: 140 }, actions),
  );
  assert.ok(!oneRow.join('\n').includes('vs your model'));
});

test('/router without a surface says the session against your model in one line', () => {
  for (const [props, expected] of [
    [
      { ...OPUS, savings: SAVES },
      'vs your model (Opus 5.5 · xhigh): −$1.84 (−22%) this session, 64 replies, est. at list prices',
    ],
    [
      { ...HAIKU, savings: MORE },
      'vs your model (Haiku 5.5 · high): +$2.48 (×5.0) this session, 9 of 41 replies on Opus 5.5, est. at list prices',
    ],
    [{ ...OPUS, savings: EARLY }, 'vs your model (Opus 5.5 · xhigh): too early, 3 routed replies'],
    [
      { nativeModel: 'claude-sonnet-5-5', nativeEffort: 'medium', savings: null },
      'vs your model (Sonnet 5.5 · medium): no routed replies this session; −$11.42 (−22%) since Oct 10, each session compared with its own model',
    ],
    [
      { ...OPUS, phase: 'unavailable', savings: null },
      'vs your model (Opus 5.5 · xhigh): no routed replies this session; −$11.42 (−22%) since Oct 10, each session compared with its own model',
    ],
    [
      { ...OPUS, savings: null, savingsStore: 'corrupted' },
      'vs your model (Opus 5.5 · xhigh): no routed replies this session',
    ],
  ])
    assert.equal(savingsLine(view(props)), expected);
});
