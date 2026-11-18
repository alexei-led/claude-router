// The Policy tab on desktop, VS Code and mobile: a form of cards (Routing mode, Switching down, Switching up,
// Activities, Credits), each field a label, its Select and one muted help line. The terminal rows are pinned by
// ui-golden.test.mjs.
import assert from 'node:assert/strict';
import test from 'node:test';

const { DEFAULTS, TIERS } = await import('../lib/config.mjs');
const { renderPanel } = await import('../lib/panel.mjs');
const { POLICY_ROWS, routeDraftOf } = await import('../lib/ui/model/draft.mjs');
const { POLICY_FORM } = await import('../lib/ui/model/policy.mjs');
const { toneColor } = await import('../lib/ui/tokens.mjs');
const { ROUTED } = await import('./band-states.mjs');
const { byKey, controls, ELEMENTS, find, kids, texts, unique } = await import('./harness.mjs');

const SURFACES = ['desktop', 'vscode', 'mobile'];
const GROUPS = ['Routing mode', 'Switching down', 'Switching up', 'Activities', 'Credits'];
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
const VIEW = { ...ROUTED, tab: 'policy', credentials: { jev: null }, configPath: '/fixture/team/router.json' };
const draw = (props = {}, { surface = 'desktop', config = DEFAULTS, elements = ELEMENTS } = {}) =>
  // Every tree a test draws holds each key and hotkey once.
  unique(renderPanel(elements, config, { ...VIEW, ...props }, null, actions, { columns: 100, surface }));

const isCard = (n) => n.props.borderStyle === 'round';
const titleOf = (n) => texts(kids(n)[0])[0];
const cards = (tree) => find(tree, isCard);
const card = (tree, title) => cards(tree).find((n) => titleOf(n) === title);
const body = (tree) => byKey(tree, 'body');
const muted = toneColor('muted', 'graphical');
// The field holding a control: its row and the help line under it.
const fieldOf = (tree, key) =>
  find(
    tree,
    (n) => n.type === 'Box' && n.props.flexDirection === 'column' && n.props.gap === 'xs' && Boolean(byKey(n, key)),
  ).at(-1);
const helpOf = (field) => find(field, (n) => n.type === 'Text' && n.props.size === 'footnote');
const SELECTS = ['routing-mode', 'baseline', ...POLICY_ROWS.map(([key]) => key)];

test('every POLICY_ROWS key has its card and help line in POLICY_FORM', () => {
  for (const [key] of POLICY_ROWS) {
    assert.ok(Object.hasOwn(POLICY_FORM, key), key);
    assert.ok(GROUPS.includes(POLICY_FORM[key].group), key);
    assert.ok(POLICY_FORM[key].help, key);
  }
});

for (const surface of SURFACES) {
  test(`${surface}: the form is one card per group, titled in order`, () => {
    const titles = cards(body(draw({}, { surface }))).map(titleOf);
    assert.deepEqual(titles, [...GROUPS, 'Settings file']);
  });

  test(`${surface}: Reset sits on its own row after the group cards; the path and Copy path in Settings file`, () => {
    const tree = draw({}, { surface });
    const stack = kids(kids(body(tree))[0]);
    const credits = stack.indexOf(card(tree, 'Credits'));
    const reset = stack[credits + 1];
    assert.deepEqual(
      controls(reset).map((c) => c.key),
      ['reset-policy'],
    );
    assert.equal(stack[credits + 2], card(tree, 'Settings file'));
    const settings = card(tree, 'Settings file');
    assert.ok(texts(settings).includes('/fixture/team/router.json'));
    assert.deepEqual(
      controls(settings).map((c) => c.key),
      ['copy-path'],
    );
    assert.equal(byKey(settings, 'copy-path').props.label, 'Copy path');
  });

  test(`${surface}: each policy key appears once, under exactly one group; mode and start tier under Routing mode`, () => {
    const tree = draw({}, { surface });
    for (const key of SELECTS) {
      assert.equal(find(body(tree), (n) => n.props.key === key).length, 1, key);
      const holders = GROUPS.filter((title) => byKey(card(tree, title), key));
      assert.equal(holders.length, 1, `${key} in ${holders}`);
    }
    for (const key of ['routing-mode', 'baseline']) assert.ok(byKey(card(tree, 'Routing mode'), key), key);
    assert.deepEqual(
      find(card(tree, 'Switching up'), (n) => n.type === 'Select'),
      [],
      'Switching up holds no control',
    );
  });

  test(`${surface}: every field has a label and one muted help line`, () => {
    const tree = draw({}, { surface });
    for (const key of SELECTS) {
      const field = fieldOf(body(tree), key);
      assert.ok(field, key);
      const help = helpOf(field);
      assert.equal(help.length, 1, key);
      assert.equal(help[0].props.color, muted, key);
      assert.ok(help[0].props.children.length > 10, key);
    }
    // Switching up's derived line is help text, not a control.
    assert.deepEqual(kids(card(tree, 'Switching up')).slice(1).flatMap(texts), [
      'Needs Jev support of 75%, up to 90% as the switch costs more',
    ]);
  });

  test(`${surface}: a setting with no effect says so in its help line, in the muted tone`, () => {
    const help = helpOf(fieldOf(body(draw({}, { surface })), 'cashCapUsd'));
    assert.equal(help[0].props.children, 'No model in router.json bills credits, so this has no effect');
    assert.equal(help[0].props.color, muted);
    const credits = {
      ...DEFAULTS,
      models: { ...DEFAULTS.models, haiku: { ...DEFAULTS.models.haiku, billing: 'credits' } },
    };
    const billed = helpOf(fieldOf(body(draw({}, { surface, config: credits })), 'cashCapUsd'));
    assert.doesNotMatch(billed[0].props.children, /no effect/);
  });

  test(`${surface}: an unsaved change carries the unsaved mark, the ● on the tab and the save bar`, () => {
    const plain = draw({}, { surface });
    assert.equal(byKey(plain, 'tab-policy').props.label, 'Policy');
    assert.equal(byKey(plain, 'save-bar'), undefined);
    const tree = draw(
      { tuning: { horizon: 10 }, routeDraft: { ...routeDraftOf(DEFAULTS, {}), baselineTier: 'micro' } },
      { surface },
    );
    assert.equal(byKey(tree, 'tab-policy').props.label, 'Policy ●');
    assert.ok(byKey(tree, 'save-bar'));
    assert.ok(byKey(byKey(tree, 'save-bar'), 'save-routing'));
    const marked = (key) =>
      find(kids(fieldOf(body(tree), key))[0], (n) => n.type === 'Text' && n.props.children === '●');
    for (const key of ['horizon', 'baseline']) {
      assert.equal(marked(key).length, 1, key);
      assert.equal(marked(key)[0].props.color, toneColor('warning', 'graphical'));
    }
    for (const key of ['downgradeVotes', 'activityMass', 'cashCapUsd']) assert.equal(marked(key).length, 0, key);
    // The changed value names its default.
    assert.ok(texts(fieldOf(body(tree), 'horizon')).includes('Default 5 turns'));
  });

  test(`${surface}: a Select pick calls the same action with the same arguments as the terminal's`, () => {
    const picks = [
      ['downgradeVotes', '3'],
      ['horizon', '10'],
      ['activityMass', '0.8'],
      ['cashCapUsd', '1'],
      ['routing-mode', 'cost'],
      ['baseline', 'micro'],
    ];
    const run = (tree) => {
      calls.length = 0;
      for (const [key, value] of picks) byKey(tree, key).props.onSelect(value);
      return [...calls];
    };
    const graphical = run(draw({}, { surface }));
    assert.deepEqual(graphical, [
      ['tune', 'downgradeVotes', 3],
      ['tune', 'horizon', 10],
      ['tune', 'activityMass', 0.8],
      ['tune', 'cashCapUsd', 1],
      ['routingMode', 'cost'],
      ['baseline', 'micro'],
    ]);
    assert.deepEqual(graphical, run(renderPanel(ELEMENTS, DEFAULTS, VIEW, null, actions, { columns: 100 })));
    // A saved value outside the choices is kept as the first option; picking it changes nothing.
    const odd = draw({ tuning: { horizon: 7 } }, { surface });
    assert.equal(byKey(odd, 'horizon').props.options[0].label, '7 turns');
    calls.length = 0;
    byKey(odd, 'horizon').props.onSelect('7');
    assert.deepEqual(calls, []);
    calls.length = 0;
    byKey(odd, 'reset-policy').props.onPress();
    byKey(odd, 'copy-path').props.onPress();
    assert.deepEqual(calls, [['resetPolicy'], ['copyPath']]);
  });

  test(`${surface}: the form shows display words: no router.json keys, terminal abbreviations or hotkey letters`, () => {
    const tree = draw({ routingMode: { mode: 'cost', source: 'session' } }, { surface });
    const words = [
      ...texts(body(tree)),
      ...controls(body(tree)).flatMap((c) => [c.label ?? '', ...(c.options ?? []).map((o) => o.label)]),
    ].join('\n');
    assert.doesNotMatch(words, /subagentRouting|downgradeVotes|cashCapUsd|activityMass|baselineTier|policy\./);
    assert.doesNotMatch(words, /\([a-z]\)|\bmed\b|\binh\b/);
    assert.deepEqual(
      byKey(tree, 'routing-mode').props.options.map((o) => o.label),
      ['Cost', 'Balanced', 'Quality'],
    );
    // Tier names in option labels start with a capital, as the modes do.
    assert.deepEqual(
      byKey(tree, 'baseline').props.options.map((o) => o.label),
      ['Micro', 'Low', 'Medium', 'High'],
    );
    // Their values stay the tier ids router.json holds, and a pick passes the id on.
    const baseline = byKey(tree, 'baseline');
    assert.deepEqual(
      baseline.props.options.map((o) => o.value),
      TIERS,
    );
    assert.equal(baseline.props.value, DEFAULTS.baselineTier);
    calls.length = 0;
    baseline.props.onSelect('micro');
    assert.deepEqual(calls, [['baseline', 'micro']]);
    assert.deepEqual(
      byKey(tree, 'routing-mode').props.options.map((o) => o.value),
      ['cost', 'balanced', 'quality'],
    );
    // No option label is a bare lowercase word.
    for (const select of find(body(tree), (n) => n.type === 'Select'))
      for (const option of select.props.options) assert.doesNotMatch(option.label, /^[a-z]+$/, select.props.key);
    // The session's own mode is a warning in the Routing mode card.
    const session = find(
      card(tree, 'Routing mode'),
      (n) => n.type === 'Text' && /^This session runs/.test(n.props.children),
    );
    assert.equal(session.length, 1);
    assert.equal(session[0].props.color, toneColor('warning', 'graphical'));
    // The field labels.
    for (const label of ['Mode', 'Start tier', ...POLICY_ROWS.map(([, label]) => label)])
      assert.ok(texts(body(tree)).includes(label), label);
  });

  test(`${surface}: the body uses tones, never terminal colours or dim text`, () => {
    const tree = draw({ tuning: { horizon: 10 }, routingMode: { mode: 'cost', source: 'session' } }, { surface });
    const graphical = new Set(
      ['primary', 'muted', 'accent', 'success', 'warning', 'danger', 'activity'].map((t) => toneColor(t, 'graphical')),
    );
    for (const node of find(body(tree), (n) => n.type === 'Text')) {
      assert.equal(node.props.dimColor, undefined, node.props.children);
      assert.equal(node.props.bold, undefined, node.props.children);
      if (node.props.color) assert.ok(graphical.has(node.props.color), `${node.props.children}: ${node.props.color}`);
    }
  });

  test(`${surface}: a view with no usage or readings shows no NaN, undefined or stray ?`, () => {
    const tree = draw({ adviceMs: Number.NaN, inputTokens: Number.NaN, configPath: undefined }, { surface });
    assert.doesNotMatch(texts(body(tree)).join('\n'), /NaN|undefined|\?/);
    assert.equal(byKey(tree, 'copy-path'), undefined);
  });

  test(`${surface}: without Select the values show as text`, () => {
    const { Select: _select, ...elements } = ELEMENTS;
    const tree = draw({}, { surface, elements });
    assert.equal(find(body(tree), (n) => n.type === 'Select').length, 0);
    for (const value of ['5 turns', 'Balanced', 'Low']) assert.ok(texts(body(tree)).includes(value), value);
  });
}
