// The Usage tab on desktop, VS Code and mobile: the period control and its scope, a Summary card with the headline
// figure, a Trend card, a Breakdown table with inline bars and What if, Worth a look, Subagents, About these numbers,
// then Delete history on its own row. The terminal rows are pinned by ui-golden.test.mjs.
import assert from 'node:assert/strict';
import test from 'node:test';

process.env.TZ = 'UTC';

const { DEFAULTS } = await import('../lib/config.mjs');
const { renderPanel } = await import('../lib/panel.mjs');
const { emptySubagentStore, recordAgent, spawnRecord } = await import('../lib/subagents.mjs');
const { paintersOf } = await import('../lib/ui/painter.mjs');
const { toneColor } = await import('../lib/ui/tokens.mjs');
const { CLAUDE, ROUTED } = await import('./band-states.mjs');
const { byKey, controls, ELEMENTS, find, kids, texts, unique } = await import('./harness.mjs');
const { at, NOW, OTHER, reply, SESSION, STORE } = await import('./usage-fixtures.mjs');
const { emptyUsage, recordUsage, replyEntry } = await import('../lib/usage.mjs');

const SURFACES = ['desktop', 'vscode', 'mobile'];
const calls = [];
const actions = new Proxy(
  {},
  {
    get:
      (_, name) =>
      (...args) =>
        calls.push([name, ...args]),
  },
);

// Subagent records: `[day, type or pass:reason, model, core model]` per agent, one flush each.
function agentStore(agents) {
  let store = emptySubagentStore();
  for (const [day, kind, model, core] of agents) {
    const pass = kind.startsWith('pass:') ? kind.slice(5) : null;
    const agent = {
      ...spawnRecord({
        sessionId: 's1',
        spawn: { subagentType: pass ? 'x' : kind },
        pass,
        choice: pass ? null : 'haiku',
        routedModel: model,
        coreModel: core,
        move: model === core || pass ? null : model.includes('opus') ? 'up' : 'down',
      }),
      requests: 2,
      pricedRequests: 2,
      actualUsd: model.includes('opus') ? 0.5 : 0.1,
      otherUsd: pass ? 0 : model === core ? 0.1 : core.includes('opus') ? 0.5 : 0.2,
    };
    store = recordAgent(store, agent, at(2026, 10, day));
  }
  return store;
}
const AGENTS = agentStore([
  [9, 'Explore', 'claude-haiku-5-5', 'claude-opus-5-5'],
  [11, 'Explore', 'claude-haiku-5-5', 'claude-opus-5-5'],
  [13, 'Explore', 'claude-haiku-5-5', 'claude-opus-5-5'],
  [13, 'dev-flow:reviewer', 'claude-opus-5-5', 'claude-sonnet-5-5'],
  [13, 'dev-flow:reviewer', 'claude-sonnet-5-5', 'claude-sonnet-5-5'],
  [13, 'dev-flow:reviewer', 'claude-haiku-5-5', 'claude-sonnet-5-5'],
  [13, 'pass:workflow', 'claude-opus-5-5', null],
]);
const VIEW = {
  ...ROUTED,
  tab: 'usage',
  credentials: { jev: null },
  usageSession: SESSION,
  usageStore: STORE,
  subagentSession: AGENTS,
  subagentStore: AGENTS,
};
const draw = (props = {}, { surface = 'desktop', config = DEFAULTS, columns = 100, usage = CLAUDE } = {}) =>
  // Every tree a test draws holds each key and hotkey once.
  unique(renderPanel(ELEMENTS, config, { ...VIEW, ...props }, usage, actions, { columns, now: NOW, surface }));
const terminal = (props = {}, { config = DEFAULTS, columns = 100 } = {}) =>
  renderPanel(ELEMENTS, config, { ...VIEW, ...props }, CLAUDE, actions, { columns, now: NOW });

const isCard = (n) => n.props.borderStyle === 'round';
const titleOf = (n) => texts(kids(n)[0])[0];
const body = (tree) => byKey(tree, 'body');
const cards = (tree) => find(body(tree), isCard);
const card = (tree, title) => cards(tree).find((n) => titleOf(n) === title);
const buttons = (tree) => find(tree, (n) => n.type === 'Button');
const svgs = (tree) => find(tree, (n) => n.type === 'Svg');
// The Box that holds a Text reading exactly `words`, nearest first.
const holder = (tree, words) =>
  find(tree, (n) => n.type === 'Box' && kids(n).some((c) => c.type === 'Text' && c.props.children === words)).at(-1);

// The savings totals kept from before the usage records, which All adds.
const LEGACY = {
  version: 1,
  since: 1,
  replies: 400,
  routedUsd: 41.18,
  yoursUsd: 52.6,
  cheaperUsd: -14.9,
  strongerUsd: 0,
  switchUsd: 3.48,
};
// One reply so far: the early note.
const EARLY = recordUsage(emptyUsage(), [reply(at(2026, 10, 13, 10), 'code')], { now: at(2026, 10, 13, 10) });
// A live reply whose cache rebuild cost more than the cheaper model saved.
const LOST = { ...reply(at(2026, 10, 13, 10), 'code'), sums: [1, 1, 0.5, -0.1, 0, 0.6, 0, 0, 0] };
// One reply without a comparison, priced only as observed.
const UNCOMPARED = recordUsage(
  emptyUsage(),
  [
    replyEntry({
      at: NOW,
      mode: 'cost',
      activity: 'code',
      tier: 'low',
      route: 'claude-haiku-5-5@high',
      yours: 'claude-sonnet-5-5',
      reply: null,
      replies: {},
      observedUsd: 0.42,
      usage: { input_tokens: 100, cache_read_input_tokens: 800, cache_creation_input_tokens: 200, output_tokens: 10 },
    }),
  ],
  { now: NOW },
);
// A subagent record from before 1.14.0: undated totals only.
const UNDATED_AGENTS = {
  version: 1,
  since: at(2026, 10, 10),
  routed: {},
  passed: { fork: { agents: 3, requests: 9, pricedRequests: 9, usd: 2 } },
};

// Every state the terminal goldens draw the Usage tab in, and the notes only some periods have.
const STATES = {
  rich: {},
  'open-activity': { usageOpen: 'activity:code' },
  'open-model': { usageOpen: 'model:claude-haiku-5-5', usageGroup: 'model' },
  'open-tier': { usageOpen: 'tier:high', usageGroup: 'tier' },
  'open-subagent': { usageOpen: 'subagent:dev-flow:reviewer', usagePeriod: 'today' },
  'open-pass': { usageOpen: 'subagent-pass:workflow', usagePeriod: 'today' },
  compare: { usageCompare: true },
  'confirm-delete': { confirmDelete: true },
  today: { usagePeriod: 'today' },
  '7d': { usagePeriod: '7d' },
  '30d': { usagePeriod: '30d' },
  month: { usagePeriod: 'month' },
  all: { usagePeriod: 'all' },
  'all-compare': { usagePeriod: 'all', usageCompare: true },
  'other-session': { usagePeriod: '7d', usageStore: OTHER, subagentStore: null },
  empty: { usageSession: null, usageStore: null, subagentSession: null, subagentStore: null },
  off: { mode: 'manual', phase: 'manual', usageSession: null, subagentSession: null },
  unavailable: { phase: 'unavailable', error: 'bad router.json', usageSession: null, subagentSession: null },
  'unpriced-model': { usageSession: null, subagentSession: null, nativeModel: 'claude-unlisted-1' },
  legacy: { usagePeriod: 'all', savingsStore: LEGACY },
  early: { usageSession: EARLY },
  lost: { usageSession: emptyUsage(), usageLive: Array(10).fill(LOST) },
  uncompared: { usageSession: UNCOMPARED, usageCompare: true, nativeModel: 'claude-sonnet-5-5' },
  undated: { usagePeriod: 'all', subagentStore: UNDATED_AGENTS },
  older: { usagePeriod: '7d', subagentStore: UNDATED_AGENTS },
};
const SUBAGENTS_OFF = { ...DEFAULTS, subagentRouting: 'off' };
// One model at different efforts: no saving is estimated.
const EFFORT_ONLY = {
  ...DEFAULTS,
  activityRouting: 'off',
  routes: Object.fromEntries(
    Object.entries(DEFAULTS.routes).map(([tier, route]) => [tier, { model: 'opus', effort: route.effort }]),
  ),
};
// Haiku bills credits, the rest the plan: the credits estimate.
const MIXED_BILLING = {
  ...DEFAULTS,
  models: Object.fromEntries(
    Object.entries(DEFAULTS.models).map(([key, model]) => [
      key,
      { ...model, billing: key === 'haiku' ? 'credits' : 'plan' },
    ]),
  ),
};

for (const surface of SURFACES) {
  test(`${surface}: the cards in order, Delete history on its own row after them`, () => {
    const tree = draw({}, { surface });
    assert.deepEqual(cards(tree).map(titleOf), [
      'Summary',
      'Trend',
      'Breakdown',
      'Worth a look',
      'Subagents',
      'About these numbers',
    ]);
    const column = kids(body(tree))[0];
    const last = kids(column).at(-1);
    assert.equal(byKey(last, 'delete-history').type, 'Button');
    assert.equal(find(last, isCard).length, 0);
  });

  test(`${surface}: the period control is a row of Buttons, the shown period primary, with no hotkey hint text`, () => {
    const tree = draw({ usagePeriod: '7d' }, { surface });
    const keys = ['session', 'today', '7d', '30d', 'month', 'all'].map((id) => `period-${id}`);
    const row = find(body(tree), (n) => kids(n).some((c) => c.props?.key === 'period-session'))[0];
    assert.deepEqual(
      kids(row).map((n) => n.props.key),
      keys,
    );
    assert.deepEqual(
      kids(row).map((n) => n.props.label),
      ['Session', 'Today', '7d', '30d', 'Month', 'All'],
    );
    assert.deepEqual(
      kids(row).map((n) => n.props.variant),
      ['secondary', 'secondary', 'primary', 'secondary', 'secondary', 'secondary'],
    );
    // `p` still steps to the next period; no `p next` words beside the Buttons.
    assert.equal(byKey(tree, 'period-30d').props.hotkey, 'p');
    assert.ok(['sm', 'md'].includes(row.props.gap), `period gap ${row.props.gap}`);
    for (const words of texts(body(tree))) assert.doesNotMatch(words, /\b[pgc] next\b/);
    // The scope line under it says which replies and against what.
    assert.ok(texts(body(tree)).some((t) => /^All projects · Oct 7 – Oct 13 · each session vs its own model$/.test(t)));
  });

  test(`${surface}: Summary leads with the period's cost, its saving as a toned delta, then the parts as rows`, () => {
    const tree = draw({}, { surface });
    const summary = card(tree, 'Summary');
    const words = texts(summary);
    assert.ok(words.includes('≈$5.80'), words.join('|'));
    const delta = find(summary, (n) => n.type === 'Text' && n.props.children === '−$5.70 (−50%) vs unrouted')[0];
    assert.ok(delta, words.join('|'));
    assert.equal(delta.props.color, toneColor('success', 'graphical'));
    assert.ok(words.includes('This session · API estimate'));
    for (const label of ['Main · 20 replies', 'Cheaper models', 'Cache rebuilds'])
      assert.ok(words.includes(label), label);
    // Amounts sit right-aligned in their own column, set in tabular figures.
    const cheaper = find(summary, (n) => n.type === 'Text' && n.props.children === '−$4.92')[0];
    assert.equal(cheaper.props.tabular, true);
    assert.equal(holder(summary, '−$4.92').props.justifyContent, 'flex-end');
    assert.ok(words.some((t) => /^20 replies · 10 turns · input 22\.0K/.test(t)));
  });

  test(`${surface}: empty states are one plain sentence each`, () => {
    const empty = draw(STATES.empty, { surface });
    assert.ok(texts(card(empty, 'Summary')).includes('No routed replies this session.'));
    assert.equal(card(empty, 'Breakdown'), undefined);
    assert.equal(card(empty, 'Trend'), undefined);
    const off = draw(STATES.off, { surface });
    assert.ok(texts(card(off, 'Summary')).includes('Routing is off: replies use your model and are not counted.'));
    const unpriced = draw(STATES['unpriced-model'], { surface });
    for (const words of texts(body(unpriced))) assert.doesNotMatch(words, /router\.json/);
    const notRecorded = draw({}, { surface, config: SUBAGENTS_OFF });
    assert.ok(texts(card(notRecorded, 'Subagents')).length > 1);
  });

  test(`${surface}: the Trend card draws the period's buckets as an Svg line with first and last labels`, () => {
    const tree = draw({ usagePeriod: '7d' }, { surface });
    const trend = card(tree, 'Trend');
    const [svg] = svgs(trend);
    assert.ok(svg, 'an Svg');
    assert.match(svg.props.alt, /first .*last .*peak/);
    assert.equal(svg.props.height, 48);
    assert.equal(svg.props.width, undefined);
    assert.match(svg.props.source, /width="1200" height="48" viewBox="0 0 1200 48" preserveAspectRatio="none"/);
    assert.doesNotMatch(svg.props.source, /100%|NaN|var\(|subtle|suggestion/);
    assert.match(svg.props.source, /#[0-9a-f]{6}/);
    const frame = find(trend, (n) => n.type === 'Box' && kids(n).includes(svg))[0];
    assert.equal(frame.props.overflow, 'hidden');
    assert.ok(texts(trend).includes('Oct 7'));
    assert.ok(texts(trend).includes('Oct 13'));
  });

  test(`${surface}: Breakdown is a table of name, replies, cost, saving and a bar with its figure beside it`, () => {
    const tree = draw({}, { surface });
    const breakdown = card(tree, 'Breakdown');
    for (const key of ['group-activity', 'group-model', 'group-tier', 'usage-compare'])
      assert.ok(byKey(breakdown, key), key);
    assert.equal(byKey(breakdown, 'group-activity').props.label, 'By activity');
    assert.equal(byKey(breakdown, 'group-activity').props.variant, 'primary');
    assert.equal(byKey(breakdown, 'usage-compare').props.label, 'What if');
    for (const words of ['Replies', 'Cost', 'Vs unrouted', 'Share']) assert.ok(texts(breakdown).includes(words), words);
    assert.equal(holder(breakdown, '≈$3.80').props.justifyContent, 'flex-end');
    // Each bar: a faint track holding the coloured fill, its figure as text beside it.
    const fills = find(breakdown, (n) => n.type === 'Box' && n.props.height === 1 && /%$/.test(n.props.width ?? ''));
    assert.equal(fills.length, 2);
    for (const fill of fills) {
      const bar = find(breakdown, (n) => n.type === 'Box' && kids(n).some((c) => kids(c).includes(fill)))[0];
      assert.ok(
        texts(bar).some((t) => /^\d+%$/.test(t)),
        JSON.stringify(texts(bar)),
      );
    }
  });

  test(`${surface}: an open row lists its children inside the same card, indented, and its cost parts`, () => {
    const tree = draw({ usageOpen: 'activity:code' }, { surface });
    const breakdown = card(tree, 'Breakdown');
    assert.equal(byKey(breakdown, 'row-activity:code').props.label, '▾');
    assert.ok(texts(breakdown).includes('Sonnet 5.5 · high'));
    assert.ok(texts(breakdown).some((t) => /^Cheaper −\$1\.32 · stronger \$0\.00/.test(t)));
    const child = holder(breakdown, 'Sonnet 5.5 · high');
    assert.ok(child.props.paddingLeft, 'indented');
  });

  test(`${surface}: What if adds its rows to the Breakdown card`, () => {
    const tree = draw({ usageCompare: true }, { surface });
    const breakdown = card(tree, 'Breakdown');
    assert.equal(byKey(breakdown, 'usage-compare').props.variant, 'primary');
    assert.ok(texts(breakdown).includes('What if'));
    assert.ok(texts(breakdown).includes('Routed'));
    assert.ok(texts(breakdown).includes('Opus 5.5 · yours'));
    assert.ok(card(tree, 'Trend'), 'the trend stays');
  });

  test(`${surface}: Worth a look keeps its Routes link`, () => {
    const tree = draw({}, { surface });
    const look = card(tree, 'Worth a look');
    assert.equal(byKey(look, 'insight-cost').props.label, 'Routes');
    assert.ok(texts(look).some((t) => /carried 47% of the cost/.test(t)));
  });

  test(`${surface}: Subagents lists each type with its squares, agents and verdict, and opens to its models`, () => {
    const tree = draw({ usagePeriod: 'today', usageOpen: 'subagent:dev-flow:reviewer' }, { surface });
    const agents = card(tree, 'Subagents');
    const words = texts(agents);
    for (const one of ['dev-flow:reviewer', 'Explore', 'Workflow agent', 'Routed', 'Not routed'])
      assert.ok(words.includes(one), one);
    assert.ok(
      words.some((t) => /^Routing [−+]\$\d/.test(t)),
      words.join('|'),
    );
    for (const svg of svgs(agents)) assert.ok(svg.props.alt.trim(), 'squares have an alt');
    assert.ok(svgs(agents).length >= 2);
    assert.ok(words.includes('Haiku 5.5'), 'the open row lists its models');
    for (const one of words) assert.doesNotMatch(one, /vs CC|subagentRouting|router\.json|color:/);
  });

  test(`${surface}: the notes sit in their own card and Delete history asks before it deletes`, () => {
    const tree = draw({}, { surface });
    assert.deepEqual(texts(card(tree, 'About these numbers')).slice(1), [
      '≈$ = tokens × configured API rates (list/custom)',
      'Not invoices or measured quota savings',
      'Answer quality not measured',
    ]);
    assert.equal(byKey(tree, 'delete-confirm'), undefined);
    const asking = draw({ confirmDelete: true }, { surface });
    assert.equal(byKey(asking, 'delete-history'), undefined);
    assert.equal(byKey(asking, 'delete-confirm').props.variant, 'primary');
    assert.ok(byKey(asking, 'delete-keep'));
    const question = find(
      body(asking),
      (n) =>
        n.type === 'Text' && n.props.children === 'Delete the usage, activity and subagent history of every session?',
    )[0];
    assert.equal(question.props.color, toneColor('warning', 'graphical'));
  });

  test(`${surface}: presses call the same actions with the same arguments as the terminal's`, () => {
    const run = (tree) => {
      calls.length = 0;
      for (const key of ['period-7d', 'period-session', 'group-model', 'row-activity:code', 'usage-compare'])
        byKey(tree, key).props.onPress();
      byKey(tree, 'row-subagent:Explore').props.onPress();
      byKey(tree, 'insight-cost').props.onPress();
      byKey(tree, 'delete-history').props.onPress();
      return [...calls];
    };
    const graphical = run(draw({}, { surface }));
    assert.deepEqual(graphical, run(terminal()));
    assert.deepEqual(graphical.slice(0, 2), [
      ['period', '7d'],
      ['period', 'session'],
    ]);
    const confirm = (tree) => {
      calls.length = 0;
      byKey(tree, 'delete-confirm').props.onPress();
      byKey(tree, 'delete-keep').props.onPress();
      byKey(tree, 'row-activity:code').props.onPress();
      return [...calls];
    };
    const open = { confirmDelete: true, usageOpen: 'activity:code' };
    assert.deepEqual(confirm(draw(open, { surface })), confirm(terminal(open)));
  });

  test(`${surface}: group-tier, insight-switch, session-policy and a pass-through row press as on the terminal`, () => {
    const press = (tree, keys) => {
      calls.length = 0;
      for (const key of keys) byKey(tree, key).props.onPress();
      return [...calls];
    };
    const pair = (props, keys) => {
      const graphical = press(draw(props, { surface }), keys);
      assert.deepEqual(graphical, press(terminal(props), keys), keys.join(' '));
      return graphical;
    };
    assert.deepEqual(pair({ usagePeriod: 'today' }, ['group-tier', 'row-subagent-pass:workflow']), [
      ['usageGroup', 'tier'],
      ['usageOpen', 'subagent-pass:workflow'],
    ]);
    // Cache rebuilds past 15% of the cheaper-model saving point to Policy.
    const costly = recordUsage(SESSION, [reply(at(2026, 10, 13, 14), 'hard')], { now: NOW, switched: 'tier' });
    const heavy = { ...costly, days: structuredClone(costly.days) };
    for (const sums of Object.values(heavy.days['2026-10-13'].cells)) {
      sums[1] += 0.3;
      sums[5] += 0.3;
    }
    assert.deepEqual(pair({ usageSession: heavy }, ['insight-switch']), [['tab', 'policy']]);
    assert.deepEqual(pair(STATES.lost, ['session-policy']), [['tab', 'policy']]);
    assert.deepEqual(pair({ ...STATES.lost, tab: 'now' }, ['session-policy']), [['tab', 'policy']]);
  });

  for (const [name, props] of Object.entries(STATES))
    test(`${surface} ${name}: every terminal key is drawn, each once, and no text is NaN, undefined or a stray ?`, () => {
      for (const config of [DEFAULTS, SUBAGENTS_OFF, EFFORT_ONLY, MIXED_BILLING]) {
        const tree = draw(props, { surface, config });
        const keys = controls(body(tree)).map((c) => c.key);
        assert.equal(new Set(keys).size, keys.length, `unique keys: ${keys}`);
        const shell = new Set(controls(tree).map((c) => c.key));
        for (const control of controls(terminal(props, { config })))
          assert.ok(shell.has(control.key), `${name}: ${control.key}`);
        for (const words of texts(body(tree))) assert.doesNotMatch(words, /NaN|undefined|^\?$|\$\?/);
        for (const svg of svgs(tree)) {
          assert.ok(svg.props.alt.trim());
          assert.doesNotMatch(`${svg.props.source}${svg.props.alt}`, /NaN|undefined/);
        }
      }
    });

  test(`${surface}: the notes only some periods have draw in plain words, their controls kept`, () => {
    const words = (props, config = DEFAULTS) => texts(body(draw(props, { surface, config })));
    assert.ok(words({}, MIXED_BILLING).includes('Credits estimate'));
    const effort = draw({ subagentSession: null }, { surface, config: EFFORT_ONLY });
    assert.ok(
      texts(card(effort, 'Summary')).includes(
        'Effort routing on one model: no saving is estimated; cost uses configured API rates.',
      ),
    );
    assert.ok(!texts(card(effort, 'Breakdown')).includes('Vs unrouted'));
    assert.ok(words(STATES.legacy).includes('Includes $41.18 routed before dated records, kept without a breakdown'));
    assert.ok(words(STATES.early).some((t) => /^1 reply so far: one model switch can still move this a lot$/.test(t)));
    const lost = draw(STATES.lost, { surface });
    assert.ok(texts(card(lost, 'Summary')).includes('Switches cost more than they saved'));
    assert.equal(byKey(card(lost, 'Summary'), 'session-policy').props.label, 'Policy');
    const uncompared = card(draw(STATES.uncompared, { surface }), 'Breakdown');
    assert.ok(texts(uncompared).includes('What if unavailable: some replies have no comparable cache history.'));
    assert.ok(!texts(uncompared).some((t) => /No routed replies/.test(t)));
    assert.ok(
      words(STATES.undated).some((t) => /^\+ 3 agents from before 1\.14\.0, not split by model · ≈\$2\.00$/.test(t)),
    );
    assert.ok(words(STATES.older).includes('Agents from before 1.14.0 have no date: All shows them.'));
    // A pass-through's reason sits under its row, whole, not in a narrow column.
    const why = find(
      card(draw({ usagePeriod: 'today' }, { surface }), 'Subagents'),
      (n) => n.props.children === 'The workflow sets it',
    )[0];
    assert.equal(why.props.wrap, 'wrap');
  });

  test(`${surface}: a narrow pane drops each table's least important columns`, () => {
    const narrow = draw({ usageCompare: true }, { surface, columns: 60 });
    const breakdown = card(narrow, 'Breakdown');
    assert.ok(!texts(breakdown).includes('Replies'));
    assert.ok(!texts(breakdown).includes('Share'));
    assert.ok(texts(breakdown).includes('Cost'));
    assert.ok(!texts(card(narrow, 'Summary')).includes('Unrouted'));
    assert.ok(texts(card(draw({}, { surface, columns: 100 }), 'Summary')).includes('Unrouted'));
    const unbounded = draw({}, { surface, columns: null });
    assert.ok(!texts(card(unbounded, 'Breakdown')).includes('Replies'));
  });

  test(`${surface}: every row of controls keeps a gap between them`, () => {
    for (const props of [{}, { confirmDelete: true }, { usageCompare: true }]) {
      const tree = draw(props, { surface });
      for (const box of find(body(tree), (n) => n.type === 'Box'))
        if (kids(box).filter((c) => c.type === 'Button').length > 1)
          assert.ok(box.props.gap, `no gap between ${buttons(box).map((b) => b.props.key)}`);
    }
  });
}

test('without usage or any record the tab draws its empty states and no NaN', () => {
  const blank = { ...VIEW, usageSession: null, usageStore: null, subagentSession: null, subagentStore: null };
  for (const usage of [null, { context: { tokens: Number.NaN }, rateLimits: [], cost: { usd: Number.NaN } }])
    for (const period of ['session', '7d', 'all']) {
      const tree = renderPanel(ELEMENTS, DEFAULTS, { ...blank, usagePeriod: period }, usage, actions, {
        columns: 80,
        now: NOW,
        surface: 'desktop',
      });
      assert.ok(card(tree, 'Summary'));
      for (const words of texts(body(tree))) assert.doesNotMatch(words, /NaN|undefined|^\?$/);
    }
});

test('the trend Svg stays under the size limit with 400 points, and states its first, last and peak', () => {
  const ui = paintersOf(ELEMENTS, 'desktop');
  const points = Array.from({ length: 400 }, (_, i) => (i % 7) * 1.234567);
  const labels = ['Oct 1', 'Nov 4'];
  const tree = ui.trend({ points, labels, alt: 'Cost by day: first $0, last $1, peak $7', tone: 'accent' });
  const [svg] = svgs(tree);
  assert.ok(svg.props.source.length < 131_072, `${svg.props.source.length}`);
  assert.equal(svg.props.alt, 'Cost by day: first $0, last $1, peak $7');
  // All zero, a NaN or a single point still draws numbers only.
  for (const odd of [[0, 0, 0], [Number.NaN, 2], [3]])
    assert.doesNotMatch(
      svgs(ui.trend({ points: odd, labels, alt: 'x', tone: 'accent' }))[0].props.source,
      /NaN|Infinity/,
    );
  // A surface without Svg says the alt in words.
  const { Svg: _svg, ...noSvg } = ELEMENTS;
  assert.ok(
    texts(paintersOf(noSvg, 'desktop').trend({ points, labels, alt: 'Cost by day', tone: 'accent' })).includes(
      'Cost by day',
    ),
  );
  // The terminal draws the same points as one row of blocks, a dot for an empty bucket.
  assert.equal(
    paintersOf(ELEMENTS, 'terminal').trend({ points: [0, 1, 2], labels, alt: 'x', tone: 'accent' }).props.children,
    '·▅█',
  );
});
