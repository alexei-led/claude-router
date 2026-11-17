// The band drawn natively on desktop, VS Code and mobile: one row, a left group that yields and a right group that
// stays, the tier as an Svg meter, and the pin as a Select. The terminal band is pinned by ui-golden.test.mjs.
import assert from 'node:assert/strict';
import test from 'node:test';

process.env.TZ = 'UTC';

const { COLOR, renderBand } = await import('../lib/band.mjs');
const { DEFAULTS } = await import('../lib/config.mjs');
const { TIERS } = await import('../lib/config.mjs');
const { resolveRoute } = await import('../lib/config.mjs');
const { shortRoute } = await import('../lib/display.mjs');
const { renderPanel } = await import('../lib/panel.mjs');
const { tierMeter } = await import('../lib/ui/graphical/meter.mjs');
const { toneColor } = await import('../lib/ui/tokens.mjs');
const { BAND_STATES, CLAUDE, ROUTED } = await import('./band-states.mjs');
const { ELEMENTS, find, goldenText, kids } = await import('./harness.mjs');
const { NOW } = await import('./usage-fixtures.mjs');

const SURFACES = ['desktop', 'mobile'];
const calls = [];
const actions = {
  open: () => calls.push(['open']),
  mode: (mode) => calls.push(['mode', mode]),
  pin: (tier) => calls.push(['pin', tier]),
  unpin: () => calls.push(['unpin']),
  key: () => calls.push(['key']),
  toggleDetail: () => calls.push(['toggleDetail']),
};
const draw = (view, usage = CLAUDE, opts = {}, config = DEFAULTS) =>
  renderBand(ELEMENTS, config, view, usage, { columns: 100, now: NOW, surface: 'desktop', ...opts }, actions);

// Every node with this key; the shared byKey is the first.
const keyed = (tree, key) => find(tree, (n) => n.props.key === key);
// The group holding Router: the band row's right group, found by its key rather than its depth.
const rightGroup = (tree) => find(tree, (n) => kids(n).some((child) => child?.props?.key === 'details'))[0];
const textOf = (node) =>
  typeof node?.props?.children === 'string' ? node.props.children : kids(node).map(textOf).join('');
const everything = (tree) => find(tree, () => true);
// The band's one row: the tree itself, or its first row when a second row follows.
const row = (tree) => (tree.props.flexDirection === 'column' ? kids(tree)[0] : tree);

for (const surface of SURFACES) {
  test(`graphical band on ${surface} is one centred, non-wrapping row`, () => {
    const tree = draw(ROUTED, CLAUDE, { surface });
    assert.equal(tree.type, 'Box');
    assert.equal(tree.props.key, 'router-band');
    for (const [name, value] of Object.entries({
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      flexWrap: 'nowrap',
    }))
      assert.equal(tree.props[name], value, name);
    // Buttons are taller than a text row: the row must neither clip them nor indent.
    assert.equal(tree.props.overflow, undefined);
    assert.equal(tree.props.paddingX, undefined);
    assert.equal(keyed(tree, 'band-detail').length + keyed(tree, 'band-manual').length, 0);
  });
}

test('no state has a hover reveal, a hidden box or a hover control', () => {
  for (const [name, { view, usage = null }] of Object.entries(BAND_STATES))
    for (const surface of SURFACES) {
      const tree = draw(view, usage, { surface });
      for (const node of everything(tree)) {
        assert.equal(node.props.hover, undefined, `${name} hover`);
        assert.notEqual(node.props.display, 'none', `${name} display`);
        assert.doesNotMatch(String(node.props.key), /^band-(detail|manual|pin-)/, name);
      }
    }
});

test('left group yields, right group stays, and the meter leads', () => {
  const tree = draw(ROUTED);
  const right = rightGroup(tree);
  const [left] = kids(tree).filter((group) => group !== right);
  assert.equal(left.props.flexShrink, 1);
  assert.equal(left.props.overflow, 'hidden');
  assert.equal(right.props.overflow, undefined);
  assert.equal(right.props.flexShrink, 0);
  const [first] = kids(left);
  assert.equal(first.type, 'Svg');
  assert.equal(first.props.alt, 'Tier: high');
  assert.equal(first.props.width, 16);
  assert.equal(first.props.height, 12);
});

test('readings are tabular and the right group ends with the pin Select then Router', () => {
  const view = { ...ROUTED, contextTokens: 90_000, inputTokens: 1000, cacheRead: 900 };
  const items = kids(rightGroup(draw(view)));
  const readings = items.filter((n) => n.type === 'Text');
  assert.ok(readings.some((n) => textOf(n).startsWith('ctx')));
  assert.ok(readings.some((n) => textOf(n).startsWith('cache')));
  for (const n of readings) assert.equal(n.props.tabular, true);
  const [select, details] = items.slice(-2);
  assert.equal(select.type, 'Select');
  assert.equal(select.props.key, 'band-pin');
  assert.equal(details.type, 'Button');
  assert.equal(details.props.key, 'details');
  assert.equal(details.props.variant, 'secondary');
  assert.equal(details.props.label, 'Router');
  details.props.onPress();
  assert.deepEqual(calls.pop(), ['open']);
});

test('pin Select lists a route per tier and picks call pin', () => {
  const select = keyed(draw(ROUTED), 'band-pin')[0];
  const [empty, ...tiers] = select.props.options;
  assert.equal(empty.label, 'Pin next turn');
  assert.equal(select.props.value, empty.value);
  assert.deepEqual(
    tiers.map((o) => o.label),
    TIERS.map((tier) => shortRoute(DEFAULTS, resolveRoute(DEFAULTS, tier))),
  );
  assert.deepEqual(
    tiers.map((o) => o.value),
    TIERS,
  );
  select.props.onSelect('low');
  assert.deepEqual(calls.pop(), ['pin', 'low']);
});

test('a pending pin selects its tier, and the empty option unpins', () => {
  const select = keyed(draw({ ...ROUTED, pendingPin: 'low' }), 'band-pin')[0];
  assert.equal(select.props.value, 'low');
  const empty = select.props.options[0];
  assert.equal(empty.label, 'No pin');
  select.props.onSelect(empty.value);
  assert.deepEqual(calls.pop(), ['unpin']);
  assert.equal(keyed(draw({ ...ROUTED, pendingPin: 'low' }), 'band-unpin').length, 0);
});

test('the pin Select is absent when routing is off, unavailable, choosing or warning', () => {
  for (const name of ['off', 'unavailable', 'choosing', 'classifier-set-up', 'classifier-details'])
    assert.equal(keyed(draw(BAND_STATES[name].view), 'band-pin').length, 0, name);
});

test('every state stays one row with Router at 30 columns', () => {
  for (const [name, { view, usage = null }] of Object.entries(BAND_STATES)) {
    const tree = draw({ ...view, bandDetail: false }, usage, { columns: 30 });
    assert.equal(tree.props.flexDirection, 'row', name);
    assert.equal(keyed(tree, 'details').length, 1, name);
    assert.equal(keyed(tree, 'details')[0].props.variant, 'secondary', name);
  }
});

test('states keep their buttons in the right group before Router', () => {
  for (const [name, key] of [
    ['off', 'band-auto'],
    ['unavailable', 'band-fix'],
    ['classifier-set-up', 'band-key'],
    ['classifier-details', 'band-fix'],
  ]) {
    const keys = kids(rightGroup(draw(BAND_STATES[name].view)))
      .map((n) => n.props.key)
      .filter(Boolean);
    assert.ok(keys.includes(key), `${name} has ${key}`);
    assert.equal(keys.at(-1), 'details', name);
  }
});

test('a pending pin can be cancelled when the Select is not drawn', () => {
  for (const [view, elements] of [
    [{ ...ROUTED, pendingPin: 'low', error: 'missing-key' }, ELEMENTS],
    [
      { ...ROUTED, pendingPin: 'low' },
      { ...ELEMENTS, Select: undefined },
    ],
  ]) {
    const tree = renderBand(elements, DEFAULTS, view, CLAUDE, { columns: 100, now: NOW, surface: 'desktop' }, actions);
    assert.equal(keyed(tree, 'band-pin').length, 0);
    const keys = kids(rightGroup(tree)).map((n) => n.props.key);
    assert.equal(keys.at(-1), 'details');
    assert.equal(keys.at(-2), 'band-unpin');
    keyed(tree, 'band-unpin')[0].props.onPress();
    assert.deepEqual(calls.pop(), ['unpin']);
  }
});

// The engine's mobile table always has a Select; an app that did not name it in `draws` is sent an empty Box, and a
// hook cannot tell which. The pending pin's own text and ✕ stay beside the Select there.
test('on mobile a pending pin keeps its text and ✕ beside the Select, even where the Select draws nothing', () => {
  const emptySelect = { ...ELEMENTS, Select: () => ELEMENTS.Box({}) };
  for (const elements of [ELEMENTS, emptySelect]) {
    const view = { ...ROUTED, pendingPin: 'low' };
    const tree = renderBand(elements, DEFAULTS, view, CLAUDE, { columns: 100, now: NOW, surface: 'mobile' }, actions);
    assert.match(textOf(row(tree)), /next/);
    const [unpin] = keyed(tree, 'band-unpin');
    assert.ok(unpin, 'band-unpin on mobile');
    unpin.props.onPress();
    assert.deepEqual(calls.pop(), ['unpin']);
  }
  // At phone width the pin's words give way, never its ✕; nor without a Select on any surface.
  for (const columns of [60, 40, 30])
    for (const [elements, surface] of [
      [emptySelect, 'mobile'],
      [{ ...ELEMENTS, Select: undefined }, 'desktop'],
    ]) {
      const view = { ...ROUTED, pendingPin: 'low' };
      const tree = renderBand(elements, DEFAULTS, view, CLAUDE, { columns, now: NOW, surface }, actions);
      assert.equal(keyed(tree, 'band-unpin').length, 1, `${surface} at ${columns}`);
      assert.equal(keyed(tree, 'details').length, 1, `${surface} at ${columns}`);
    }
  // Desktop draws the Select, which shows the pin: no second ✕.
  assert.equal(keyed(draw({ ...ROUTED, pendingPin: 'low' }), 'band-unpin').length, 0);
});

// The fit keeps room for the pin Select only where one is drawn.
test('the route keeps the Select’s room when no Select is drawn', () => {
  const route = 'y'.repeat(70);
  const config = {
    ...DEFAULTS,
    models: { ...DEFAULTS.models, opus: { ...DEFAULTS.models.opus, id: `claude-${route}-5-5` } },
  };
  const view = { ...BAND_STATES.off.view, nativeModel: `claude-${route}-5-5` };
  const tree = draw(view, CLAUDE, { columns: 100 }, config);
  assert.equal(keyed(tree, 'band-pin').length, 0);
  assert.doesNotMatch(textOf(row(tree)), /…/);
});

test('a long route label is truncated and Router stays', () => {
  const long = 'x'.repeat(90);
  const config = {
    ...DEFAULTS,
    models: { ...DEFAULTS.models, opus: { ...DEFAULTS.models.opus, id: `claude-${long}-5-5` } },
  };
  const tree = draw(
    { ...ROUTED, actualModel: `claude-${long}-5-5`, selectedModel: `claude-${long}-5-5` },
    CLAUDE,
    {},
    config,
  );
  const route = find(row(tree), (n) => n.type === 'Text' && textOf(n).includes('xxxxxxxxxx'))[0];
  assert.ok(route, 'route text drawn');
  assert.equal(route.props.wrap, 'truncate-end');
  assert.equal(keyed(tree, 'details').length, 1);
});

test('the detail row is a second row, never a third', () => {
  const { view, usage } = BAND_STATES.detail;
  const tree = draw(view, usage);
  const rows = kids(tree);
  assert.equal(rows.length, 2);
  assert.equal(row(tree).props.flexDirection, 'row');
  assert.match(textOf(rows[1]), /plan 5h/);
  assert.equal(keyed(draw({ ...view, bandDetail: false }, usage), 'router-band').length, 1);
  const off = BAND_STATES['detail-off'];
  const offRows = kids(draw(off.view, off.usage));
  assert.equal(offRows.length, 2);
  assert.match(textOf(offRows[1]), /plan 5h/);
});

// The session row is gap-separated readings in tones, the figures tabular: no gauge glyphs, no run of spaces.
test('the detail row draws its readings apart, without gauges or padding', () => {
  const plan = (percentUsed) => ({
    ...CLAUDE,
    rateLimits: [{ ...CLAUDE.rateLimits[0], percentUsed }, CLAUDE.rateLimits[1]],
  });
  const states = {
    ...BAND_STATES,
    'detail-no-replies': { view: { ...ROUTED, bandDetail: true }, usage: CLAUDE },
    'plan empty': { view: BAND_STATES.detail.view, usage: plan(0) },
    'plan full': { view: BAND_STATES.detail.view, usage: plan(100) },
  };
  for (const name of Object.keys(states).filter((n) => /^detail|^plan/.test(n))) {
    const { view, usage } = states[name];
    const second = kids(draw(view, usage))[1];
    assert.equal(second.props.flexDirection, 'row', name);
    assert.ok(second.props.gap, name);
    const items = kids(second);
    assert.ok(items.length > 1, `${name}: ${items.length} items`);
    for (const item of items) {
      assert.equal(item.type, 'Text', name);
      assert.equal(item.props.tabular, true, name);
      assert.doesNotMatch(textOf(item), /\s{2}|^\s|\s$/, `${name}: ${JSON.stringify(textOf(item))}`);
      for (const part of kids(item)) if (part.type === 'Text') assert.notEqual(part.props.children, '', name);
    }
    for (const node of find(second, (n) => n.type === 'Text' && typeof n.props.children === 'string')) {
      assert.doesNotMatch(node.props.children, /[▰▱█░]/, name);
      assert.doesNotMatch(node.props.children, /\s{2}/, `${name}: ${JSON.stringify(node.props.children)}`);
    }
    assert.match(textOf(second), /plan 5h/, name);
    assert.match(textOf(second), /\d+%/, name);
  }
});

test('no state prints NaN, undefined or a stray question mark', () => {
  const empty = { context: { tokens: Number.NaN }, rateLimits: [], cost: { usd: Number.NaN } };
  for (const [name, { view, usage = null }] of Object.entries(BAND_STATES))
    for (const u of [usage, null, empty]) {
      const text = goldenText(draw({ ...view, contextTokens: Number.NaN, cacheRead: Number.NaN }, u));
      assert.doesNotMatch(text, /NaN|undefined|\?/, name);
    }
});

test('colours come from graphical tones, never the terminal hexes', () => {
  const colours = new Set();
  for (const { view, usage = null } of Object.values(BAND_STATES))
    for (const node of everything(draw(view, usage)))
      if (node.type === 'Text' && node.props.color) colours.add(node.props.color);
  for (const hex of ['#7c9cff', '#8b93a7', '#f0b429', '#5fd7af', '#5f9fe0', '#d7af5f', '#e0708a', '#d77757', '#87d787'])
    assert.ok(!colours.has(hex), hex);
  const svgs = [];
  for (const { view, usage = null } of Object.values(BAND_STATES))
    for (const node of everything(draw(view, usage))) if (node.type === 'Svg') svgs.push(node.props.source);
  assert.ok(svgs.length);
  for (const source of svgs)
    for (const hex of Object.values(COLOR)) assert.ok(!source.includes(hex), `${hex} in an Svg`);
  assert.ok(colours.has('subtle'));
  assert.ok(colours.has(toneColor('activity', 'graphical')));
});

test('the terminal band is untouched and a missing surface draws it', () => {
  const terminal = goldenText(draw(ROUTED, CLAUDE, { surface: 'terminal' }));
  assert.equal(terminal, goldenText(draw(ROUTED, CLAUDE, { surface: undefined })));
  assert.match(terminal, /display="none"/);
});

test('the subagent band is one graphical row with no control and no Router', () => {
  const agent = { routedModel: 'claude-haiku-5-5', coreModel: 'claude-opus-5-5', move: 'down', choice: 'router' };
  for (const surface of SURFACES) {
    const tree = draw(ROUTED, null, { agentId: 'a1', agent, surface });
    assert.equal(tree.props.key, 'router-band');
    assert.equal(tree.props.flexDirection, 'row');
    assert.equal(tree.props.hover, undefined);
    assert.equal(keyed(tree, 'details').length, 0);
    assert.equal(find(tree, (n) => ['Button', 'Select'].includes(n.type)).length, 0);
    assert.match(textOf(tree), /^agent.*Haiku 5\.5.*from Opus 5\.5/);
    const bare = draw(ROUTED, null, { agentId: 'a1', agent: null, surface });
    assert.match(textOf(bare), /^agent/);
    assert.equal(find(bare, (n) => n.type === 'Button').length, 0);
  }
  const terminal = draw(ROUTED, null, { agentId: 'a1', agent, surface: 'terminal' });
  assert.equal(terminal.props.key, undefined);
});

// The spec's state table: the control on the right of each state, with Router last.
const CONTROL = {
  routed: ['band-pin'],
  ready: ['band-pin'],
  choosing: [],
  'pending-pin': ['band-pin'],
  'native-fallback': ['band-pin'],
  'classifier-set-up': ['band-key'],
  'classifier-details': ['band-fix'],
  unavailable: ['band-fix'],
  off: ['band-auto'],
};
test('each state draws the right-side control from the spec table, then Router', () => {
  for (const [name, controls] of Object.entries(CONTROL))
    for (const surface of SURFACES) {
      const tree = draw({ ...BAND_STATES[name].view, bandDetail: false }, null, { surface });
      const keys = kids(rightGroup(tree))
        .map((n) => n.props.key)
        .filter((k) => k && k !== undefined && !String(k).startsWith('band-unpin'));
      assert.deepEqual(keys, [...controls, 'details'], `${name} on ${surface}`);
    }
});

test('the pending pin shows as the Select value, the native fallback reads in the warning tone, choosing is a pending meter', () => {
  assert.equal(keyed(draw(BAND_STATES['pending-pin'].view), 'band-pin')[0].props.value, 'low');
  const fallback = draw(BAND_STATES['native-fallback'].view);
  assert.ok(
    find(
      fallback,
      (n) => n.type === 'Text' && /fallback/.test(textOf(n)) && n.props.color === toneColor('warning', 'graphical'),
    ).length,
  );
  assert.equal(find(draw(BAND_STATES.choosing.view), (n) => n.type === 'Svg')[0].props.alt, 'Tier: choosing');
  assert.match(textOf(draw(BAND_STATES.choosing.view)), /choosing/);
});

test('Turn on is a permanent primary Button, reachable without hover', () => {
  for (const name of ['off', 'detail-off']) {
    const tree = draw(BAND_STATES[name].view, BAND_STATES[name].usage ?? null, { surface: 'mobile' });
    const [turnOn] = keyed(tree, 'band-auto');
    assert.equal(turnOn.type, 'Button');
    assert.equal(turnOn.props.variant, 'primary');
    assert.equal(turnOn.props.label, 'Turn on');
    for (const node of everything(tree)) assert.equal(node.props.hover, undefined);
    turnOn.props.onPress();
    assert.deepEqual(calls.pop(), ['mode', 'auto']);
  }
});

function pane(surface, view = ROUTED, extra = {}) {
  return renderPanel(ELEMENTS, DEFAULTS, { ...view, tab: 'now', ...extra }, CLAUDE, actions, {
    columns: 100,
    now: NOW,
    surface,
  });
}
test('the Now tab offers the session row setting on graphical surfaces only', () => {
  for (const surface of SURFACES) {
    const [toggle] = keyed(pane(surface), 'band-detail-toggle');
    assert.equal(toggle.props.label, 'Show session row in band');
    toggle.props.onPress();
    assert.deepEqual(calls.pop(), ['toggleDetail']);
    assert.equal(
      keyed(pane(surface, ROUTED, { bandDetail: true }), 'band-detail-toggle')[0].props.label,
      'Hide session row in band',
    );
  }
  for (const surface of ['terminal', undefined]) assert.equal(keyed(pane(surface), 'band-detail-toggle').length, 0);
});

test('tierMeter draws four rising bars, lit to the tier, or text without Svg', () => {
  const lit = tierMeter(ELEMENTS, 'medium', 'lit');
  assert.equal(lit.type, 'Svg');
  assert.equal(lit.props.alt, 'Tier: medium');
  assert.equal(lit.props.width, 16);
  assert.equal(lit.props.height, 12);
  assert.match(lit.props.source, /viewBox="0 0 16 12"/);
  const rects = [...lit.props.source.matchAll(/<rect x="(\d+)" y="\d+" width="3" height="(\d+)" [^>]*fill="([^"]+)"/g)];
  assert.deepEqual(
    rects.map((m) => Number(m[1])),
    [0, 4, 8, 12],
  );
  const heights = rects.map((m) => Number(m[2]));
  assert.deepEqual(
    heights,
    [...heights].sort((a, b) => a - b),
  );
  assert.deepEqual(
    rects.map((m) => m[3] === toneColor('tier:medium', 'graphical')),
    [true, true, true, false],
  );
  assert.equal(tierMeter(ELEMENTS, null, 'off').props.alt, 'Tier: off');
  assert.equal(tierMeter(ELEMENTS, null, 'pending').props.alt, 'Tier: choosing');
  const { Svg: _, ...noSvg } = ELEMENTS;
  const text = tierMeter(noSvg, 'high', 'lit');
  assert.equal(text.type, 'Text');
  assert.equal(text.props.children, '▂▄▆█');
});
