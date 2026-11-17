// The Now tab on desktop, VS Code and mobile: cards for Next turn, Plan usage beside Context when the pane is wide,
// This session and Recent decisions. The terminal rows are pinned by ui-golden.test.mjs.
import assert from 'node:assert/strict';
import test from 'node:test';

process.env.TZ = 'UTC';

const { DEFAULTS } = await import('../lib/config.mjs');
const { renderPanel } = await import('../lib/panel.mjs');
const { toneColor } = await import('../lib/ui/tokens.mjs');
const { CLAUDE, ROUTED } = await import('./band-states.mjs');
const { byKey, ELEMENTS, find, kids, texts, unique } = await import('./harness.mjs');
const { NOW, SESSION, STORE } = await import('./usage-fixtures.mjs');

const SURFACES = ['desktop', 'vscode', 'mobile'];
const KEYS_SET = { jev: null, clef: null, 'clef-flash': null, 'clef-omni': null };
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
const RICH = {
  ...ROUTED,
  tab: 'now',
  credentials: KEYS_SET,
  probabilities: { high: 0.88, medium: 0.07, low: 0.03 },
  estimate: { threshold: 0.82, upgradeMass: 0.88, taxUsd: 0.476 },
  inputTokens: 1000,
  cacheRead: 900,
  usageSession: SESSION,
  usageStore: STORE,
  strip: { per: 1, cells: [{ low: 2 }, { medium: 1 }, { high: 1, low: 1 }, { none: 1 }] },
};
const draw = (props = {}, { surface = 'desktop', usage = CLAUDE, columns = 100 } = {}) =>
  // Every tree a test draws holds each key and hotkey once.
  unique(renderPanel(ELEMENTS, DEFAULTS, { ...RICH, ...props }, usage, actions, { columns, now: NOW, surface }));

// A card is a round-bordered Box whose first row carries its title.
const card = (tree, title) =>
  find(tree, (n) => n.props.borderStyle === 'round' && texts(kids(n)[0]).includes(title))[0];
const all = (tree) => texts(tree).join('\n');

for (const surface of SURFACES) {
  test(`${surface}: each pin is its tier meter, a Button named by its route and its support; none primary with no pin`, () => {
    const tree = draw({}, { surface });
    const next = card(tree, 'Next turn');
    assert.ok(next, 'Next turn card');
    const labels = {};
    for (const tier of ['micro', 'low', 'medium', 'high']) {
      const pin = byKey(next, `pin-${tier}`);
      assert.equal(pin?.type, 'Button', tier);
      // The Button holds its label alone, a Text cut at its end; its meter and reading sit beside it in the group.
      assert.deepEqual(
        kids(pin).map((n) => [n.type, n.props.children, n.props.wrap]),
        [['Text', pin.props.label, 'truncate-end']],
        tier,
      );
      labels[tier] = pin.props.label;
      const group = find(next, (n) => kids(n).includes(pin))[0];
      assert.equal(group.props.flexDirection, 'row', tier);
      assert.equal(group.props.alignItems, 'center', tier);
      assert.equal(group.props.gap, 'xs', tier);
      // A group may shrink to the card; its meter never does.
      assert.equal(group.props.flexShrink, 1, tier);
      assert.equal(group.props.minWidth, 0, tier);
      const [holder] = kids(group);
      assert.equal(holder.props.flexShrink, 0, tier);
      const [meter] = kids(holder);
      assert.equal(meter.type, 'Svg', tier);
      assert.equal(meter.props.alt, `Tier: ${tier}`, tier);
    }
    assert.deepEqual(labels, {
      micro: 'Haiku · medium',
      low: 'Haiku · high',
      medium: 'Opus · medium',
      high: 'Opus · xhigh',
    });
    // No block glyphs anywhere in the pins: the meters are Svg.
    const row = find(next, (n) => n.props.gap === 'md' && n.props.flexWrap === 'wrap')[0];
    assert.equal(row.props.flexDirection, 'row');
    assert.equal(row.props.justifyContent, 'flex-start');
    assert.equal(kids(row).length, 4);
    assert.ok(!texts(row).some((t) => /[▂▄▆█●]/.test(t)), texts(row).join(' | '));
    const support = (tier) => kids(find(next, (n) => kids(n).includes(byKey(next, `pin-${tier}`)))[0]).at(-1);
    assert.equal(support('low').props.children, '3%');
    assert.equal(support('low').props.color, toneColor('muted', 'graphical'));
    assert.equal(support('low').props.tabular, true);
    assert.equal(support('low').props.size, 'footnote');
    assert.deepEqual(
      ['micro', 'low', 'medium', 'high'].map((tier) => byKey(next, `pin-${tier}`).props.variant),
      ['secondary', 'secondary', 'secondary', 'secondary'],
    );
    // The tier that runs now says current before its support, with no dot.
    assert.equal(support('high').props.children, 'current · 88%');
    assert.ok(!texts(row).some((t) => t === 'current · 3%'));
  });

  test(`${surface}: a pin without a reading draws no percent and no dash, and without Svg no meter`, () => {
    const next = card(draw({ probabilities: null }, { surface }), 'Next turn');
    const group = (tier) => find(next, (n) => kids(n).includes(byKey(next, `pin-${tier}`)))[0];
    assert.deepEqual(
      kids(group('low')).map((n) => n.type),
      ['Box', 'Button'],
    );
    assert.equal(kids(group('high')).at(-1).props.children, 'current');
    assert.doesNotMatch(texts(next).join(' '), /—/);
    const { Svg: _svg, ...NO_SVG } = ELEMENTS;
    const bare = card(
      unique(renderPanel(NO_SVG, DEFAULTS, { ...RICH }, CLAUDE, actions, { columns: 100, now: NOW, surface })),
      'Next turn',
    );
    for (const tier of ['micro', 'low', 'medium', 'high']) {
      const pin = byKey(bare, `pin-${tier}`);
      const kin = kids(find(bare, (n) => kids(n).includes(pin))[0]);
      assert.equal(kin[0], pin, tier);
      assert.ok(!kin.some((n) => n.type === 'Svg'), tier);
    }
  });

  test(`${surface}: a 90-character model name keeps its pin group shrinkable and draws without a throw`, () => {
    const name = `Custom ${'Long '.repeat(16)}Model`.slice(0, 90);
    const config = {
      ...DEFAULTS,
      models: { ...DEFAULTS.models, long: { ...DEFAULTS.models.haiku, id: `vendor/${name}`, name } },
      routes: { ...DEFAULTS.routes, low: { model: 'long', effort: 'high' } },
    };
    const tree = unique(
      renderPanel(ELEMENTS, config, { ...RICH }, CLAUDE, actions, { columns: 60, now: NOW, surface }),
    );
    const next = card(tree, 'Next turn');
    const pin = byKey(next, 'pin-low');
    assert.ok(pin.props.label.length > 40, pin.props.label);
    assert.equal(kids(pin)[0].props.wrap, 'truncate-end');
    const group = find(next, (n) => kids(n).includes(pin))[0];
    assert.equal(group.props.flexShrink, 1);
    assert.equal(group.props.minWidth, 0);
  });

  test(`${surface}: a pending pin is shown on its button, which unpins on a second press, with no extra row`, () => {
    const tree = draw({ pendingPin: 'low' }, { surface });
    const next = card(tree, 'Next turn');
    // Only the pending pin is primary; the current tier (high) keeps its word and stays secondary.
    assert.deepEqual(
      ['micro', 'low', 'medium', 'high'].filter((tier) => byKey(next, `pin-${tier}`).props.variant === 'primary'),
      ['low'],
    );
    // The current tier's group still says so beside its secondary Button.
    const high = find(next, (n) => kids(n).includes(byKey(next, 'pin-high')))[0];
    assert.ok(texts(high).some((t) => /^current/.test(t)));
    assert.equal(byKey(tree, 'unpin'), undefined);
    assert.doesNotMatch(all(tree), /⏵|unpin/);
    const plain = card(draw({}, { surface }), 'Next turn');
    assert.equal(kids(next).length, kids(plain).length);
    calls.length = 0;
    byKey(next, 'pin-low').props.onPress();
    byKey(next, 'pin-medium').props.onPress();
    assert.deepEqual(calls, [['unpin'], ['pin', 'medium']]);
  });

  test(`${surface}: the headline is the route with the why line, and a turn without a tier says so`, () => {
    const next = card(draw({ reason: 'upgrade' }, { surface }), 'Next turn');
    assert.ok(texts(next).includes('Opus 5.5 · xhigh'));
    assert.match(all(next), /Jev 88% ≥ 82% · switch ≈ \$0\.48/);
    const first = card(draw({ tier: null, reason: null, probabilities: null }, { surface }), 'Next turn');
    assert.ok(texts(first).includes('No routed turn yet — the first reply sets the route.'));
    assert.ok(byKey(first, 'pin-high'), 'pins stay without a tier');
  });

  test(`${surface}: with routing off the card names the model and offers no pins`, () => {
    const next = card(draw({ mode: 'manual', phase: 'manual' }, { surface }), 'Next turn');
    assert.ok(next);
    assert.match(all(next), /routing off/i);
    assert.equal(byKey(next, 'pin-high'), undefined);
  });

  test(`${surface}: plan bars carry their percent beside them, filled in the plan tone over the shared track`, () => {
    const plan = card(draw({}, { surface }), 'Plan usage');
    assert.ok(plan, 'Plan usage card');
    const words = texts(plan);
    assert.ok(words.includes('5h') && words.includes('7d'));
    assert.ok(words.includes('37%') && words.includes('81%'));
    const tracks = find(plan, (n) => n.props.backgroundColor === 'rgba(127,127,127,0.18)');
    assert.equal(tracks.length, 2);
    assert.deepEqual(
      tracks.map((t) => [kids(t)[0].props.width, kids(t)[0].props.backgroundColor]),
      [
        ['37%', toneColor('success', 'graphical')],
        ['81%', toneColor('warning', 'graphical')],
      ],
    );
    const figure = find(plan, (n) => n.props.children === '37%')[0];
    assert.equal(figure.props.tabular, true);
  });

  test(`${surface}: Plan and Context share a row from 110 columns and stack below`, () => {
    for (const [columns, row] of [
      [120, true],
      [110, true],
      [99, false],
      [null, false],
    ]) {
      const tree = draw({}, { surface, columns });
      const plan = card(tree, 'Plan usage');
      const context = card(tree, 'Context');
      const shared = find(
        tree,
        (n) =>
          n.props.flexDirection === 'row' && find(n, (m) => m === plan).length && find(n, (m) => m === context).length,
      );
      assert.equal(shared.length > 0, row, `${columns} columns`);
    }
  });

  test(`${surface}: the session card has its total, its bars and the strip as tier-coloured cells with counts`, () => {
    const tree = draw({}, { surface });
    const session = card(tree, 'This session');
    assert.ok(session, 'This session card');
    assert.ok(byKey(session, 'usage-session'));
    assert.ok(byKey(kids(session)[0], 'band-detail-toggle'), 'the band toggle is in the card header');
    const words = texts(session);
    assert.ok(words.some((t) => /^≈\$/.test(t)));
    assert.ok(words.includes('Main'));
    for (const tier of ['low', 'medium', 'high'])
      assert.ok(
        find(session, (n) => n.type === 'Box' && n.props.backgroundColor === toneColor(`tier:${tier}`, 'graphical'))
          .length,
        tier,
      );
    for (const legend of ['Low 3', 'Medium 1', 'High 1', 'not routed 1']) assert.ok(words.includes(legend), legend);
  });

  test(`${surface}: empty states read as words, never NaN or undefined`, () => {
    const empty = draw(
      { usageSession: null, strip: null, contextTokens: null, inputTokens: 0 },
      { surface, usage: null },
    );
    assert.ok(texts(card(empty, 'This session')).includes('No routed replies yet'));
    assert.ok(texts(card(empty, 'Context')).includes('No reading yet'));
    const nan = draw(
      {
        contextTokens: Number.NaN,
        inputTokens: Number.NaN,
        cacheRead: Number.NaN,
        estimate: { threshold: Number.NaN, upgradeMass: Number.NaN, taxUsd: Number.NaN },
        probabilities: { low: Number.NaN },
        usageSession: null,
        strip: { per: 1, cells: [] },
        usageDetail: true,
        history: [Number.NaN],
      },
      { surface, usage: null },
    );
    assert.doesNotMatch(
      JSON.stringify(nan, (_, v) => (Number.isNaN(v) ? 'NaN' : v === undefined ? 'undefined' : v)),
      /NaN|undefined/,
    );
    assert.doesNotMatch(all(nan), /NaN|undefined|\?/);
  });

  test(`${surface}: details in Context still opens the readings, and the old keys answer`, () => {
    const closed = draw({}, { surface });
    const context = card(closed, 'Context');
    assert.ok(byKey(context, 'usage-detail'));
    calls.length = 0;
    byKey(context, 'usage-detail').props.onPress();
    assert.deepEqual(calls, [['usageDetail']]);
    const open = draw(
      {
        usageDetail: true,
        comparison: { incumbent: 'low', candidate: 'high', minUsd: -0.02, maxUsd: 0.03, paybackTurns: 3 },
      },
      { surface },
    );
    assert.ok(texts(open).includes('−$0.02 to +$0.03'));
  });
}

// The Context card keeps the accent fill and plain cache figure until a reading warns: past 60% the fill warns, past
// 80% it is in danger (display.mjs bar()); a cache reuse below 60% warns from 20%.
for (const surface of SURFACES) {
  test(`${surface}: the Context card keeps the accent until the fill or the cache warns`, () => {
    const fill = (contextTokens) => {
      const context = card(draw({ contextTokens, inputTokens: 1000, cacheRead: 900 }, { surface }), 'Context');
      return find(context, (n) => n.type === 'Box' && /%$/.test(String(n.props.width)) && n.props.backgroundColor).map(
        (n) => [n.props.width, n.props.backgroundColor],
      );
    };
    assert.deepEqual(fill(400_000), [['40%', toneColor('accent', 'graphical')]]);
    assert.deepEqual(fill(700_000), [['70%', toneColor('warning', 'graphical')]]);
    assert.deepEqual(fill(850_000), [['85%', toneColor('danger', 'graphical')]]);
    assert.deepEqual(fill(950_000), [['95%', toneColor('danger', 'graphical')]]);
    const figure = (cacheRead, text) => {
      const context = card(draw({ inputTokens: 1000, cacheRead }, { surface }), 'Context');
      return find(context, (n) => n.type === 'Text' && n.props.children === text)[0].props.color;
    };
    assert.equal(figure(900, '90%'), toneColor('primary', 'graphical'));
    assert.equal(figure(100, '10%'), toneColor('primary', 'graphical'));
    assert.equal(figure(300, '30%'), toneColor('warning', 'graphical'));
  });
}

// The input per reply behind Details is a trend chart, not block glyphs in proportional text.
for (const surface of SURFACES) {
  test(`${surface}: the input per reply is a trend with its alt, never glyphs`, () => {
    const context = card(
      draw({ usageDetail: true, history: [12_000, 48_000, 30_000], tiers: ['low', 'high', 'medium'] }, { surface }),
      'Context',
    );
    const [chart] = find(context, (n) => n.type === 'Svg' && n.props.height === 48);
    assert.ok(chart, 'a trend Svg');
    assert.match(chart.props.alt, /12\.0K/);
    assert.match(chart.props.alt, /48\.0K/);
    for (const word of texts(context)) assert.doesNotMatch(word, /[▁▂▃▄▅▆▇█]/, word);
    assert.ok(texts(context).includes('12.0K lowest · 48.0K highest'));
    const none = card(draw({ usageDetail: true, history: [] }, { surface }), 'Context');
    assert.ok(texts(none).includes('No replies yet'));
  });
}

test('the strip splits into whole percents that sum to 100, however many runs it has', () => {
  const cells = Array.from({ length: 60 }, (_, i) => ({ [['low', 'medium', 'high', 'none'][i % 4]]: 1 }));
  const tree = draw({ strip: { per: 1, cells } }, { columns: 100 });
  const session = card(tree, 'This session');
  const row = find(
    session,
    (n) => n.props.flexDirection === 'row' && n.props.height === 1 && !n.props.backgroundColor,
  )[0];
  const widths = kids(row).map((n) => Number(n.props.width.slice(0, -1)));
  assert.equal(widths.length, 60);
  assert.ok(widths.every((w) => Number.isInteger(w) && w > 0));
  assert.equal(
    widths.reduce((a, b) => a + b, 0),
    100,
  );
  assert.doesNotMatch(all(session), /replies per cell/);
});

test('whole percents give every non-empty part at least 1, and a small bar value is never an empty bar', async () => {
  const { wholePercents } = await import('../lib/ui/graphical/charts.mjs');
  const widths = wholePercents([1000, 1, 1, 1]);
  assert.equal(
    widths.reduce((a, b) => a + b, 0),
    100,
  );
  assert.ok(widths.every((w) => w >= 1));
  assert.deepEqual(wholePercents([0, 0]), [0, 0]);
  const tree = draw({ subagentSession: null }, {});
  const session = card(tree, 'This session');
  const fills = find(session, (n) => n.props.backgroundColor === 'rgba(127,127,127,0.18)').map(
    (t) => kids(t)[0].props.width,
  );
  assert.ok(fills.every((w) => w !== '0%'));
  const { graphicalKit } = await import('../lib/ui/graphical/painter.mjs');
  const meter = graphicalKit(ELEMENTS).meter({ label: 'Agents', value: 0.001, tone: 'accent', text: '$0.01' });
  assert.equal(kids(kids(meter)[1])[0].props.width, '1%');
  assert.equal(graphicalKit(ELEMENTS).strip({ per: 1, cells: [] }, { columns: 80, now: 0 }), null);
});
