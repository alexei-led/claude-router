// The Classifier tab on desktop, VS Code and mobile: one card per classifier with its status, readings and
// credentials, the active one marked, and the counts across sessions in their own card. The terminal rows are pinned
// by ui-golden.test.mjs.
import assert from 'node:assert/strict';
import test from 'node:test';

process.env.TZ = 'UTC';

const { DEFAULTS } = await import('../lib/config.mjs');
const { renderPanel } = await import('../lib/panel.mjs');
const { toneColor } = await import('../lib/ui/tokens.mjs');
const { ROUTED } = await import('./band-states.mjs');
const { byKey, controls, ELEMENTS, find, kids, texts } = await import('./harness.mjs');

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
const KEYS = { jev: null, clef: 'missing-key', 'clef-flash': 'missing-account', 'clef-omni': null, openai: null };
const STORE = {
  version: 1,
  confusion: { code: { code: 10, read: 3 }, ops: { ops: 4, code: 1 } },
  runs: {},
  lateral: { taken: 4, refused: 2 },
};
const METRICS = {
  version: 1,
  latency: { jev: [0, 0, 0, 3, 15, 1, 1, ...Array(15).fill(0)] },
  downMoves: { moves: 12, escalations: 1 },
};
const VIEW = {
  ...ROUTED,
  tab: 'classifier',
  credentials: KEYS,
  adviceMs: 347,
  health: { failures: 1, pausedUntil: 0 },
  activityStats: { agreement: { matched: 19, total: 22 } },
  activityStore: STORE,
  activityMetrics: METRICS,
};
const draw = (props = {}, { surface = 'desktop', config = DEFAULTS } = {}) =>
  renderPanel(ELEMENTS, config, { ...VIEW, ...props }, null, actions, { columns: 100, surface });

const isCard = (n) => n.props.borderStyle === 'round';
const titleOf = (n) => texts(kids(n)[0])[0];
const cards = (tree) => find(body(tree), isCard);
const card = (tree, title) => cards(tree).find((n) => titleOf(n) === title);
const body = (tree) => byKey(tree, 'body');
const IDS = Object.keys(DEFAULTS.classifiers);
const LABELS = IDS.map((id) => DEFAULTS.classifiers[id].label);
// A card's header row holds the Active mark or the Use Button.
const isActive = (n) => texts(kids(n)[0]).includes('Active');

for (const surface of SURFACES) {
  test(`${surface}: one card per classifier, titled by its label, then Across sessions`, () => {
    const tree = draw({}, { surface });
    assert.deepEqual(cards(tree).map(titleOf), [...LABELS, 'Across sessions']);
  });

  for (const active of ['jev', 'ollama'])
    test(`${surface}: with ${active} active, exactly one card is marked active, the others offer Use`, () => {
      const tree = draw({}, { surface, config: { ...DEFAULTS, classifier: active } });
      const marked = cards(tree).filter(isActive);
      assert.equal(marked.length, 1);
      assert.equal(titleOf(marked[0]), DEFAULTS.classifiers[active].label);
      const mark = find(kids(marked[0])[0], (n) => n.type === 'Text' && n.props.children === '●');
      assert.equal(mark.length, 1);
      assert.equal(mark[0].props.color, toneColor('accent', 'graphical'));
      // The active mark keeps the classifier's key; every other card's Use Button has its own.
      assert.equal(find(body(tree), (n) => n.props.key === `classifier-${active}`).length, 1);
      for (const id of IDS.filter((one) => one !== active)) {
        const use = byKey(card(tree, DEFAULTS.classifiers[id].label), `classifier-${id}`);
        assert.equal(use.type, 'Button', id);
        assert.equal(use.props.label, 'Use', id);
      }
      // The deadline Select is the active card's alone.
      assert.equal(find(body(tree), (n) => n.props.key === 'timeoutMs').length, 1);
      assert.ok(byKey(marked[0], 'timeoutMs'));
    });

  test(`${surface}: pressing Use calls the same action as the terminal's row`, () => {
    const run = (tree) => {
      calls.length = 0;
      byKey(tree, 'classifier-ollama').props.onPress();
      byKey(tree, 'key-clef').props.onPress();
      byKey(tree, 'timeoutMs').props.onSelect('3000');
      byKey(tree, 'timeoutMs').props.onSelect('7');
      return [...calls];
    };
    const graphical = run(draw({}, { surface }));
    assert.deepEqual(graphical, [['classifier', 'ollama'], ['key'], ['classifierTimeout', 3000]]);
    assert.deepEqual(graphical, run(renderPanel(ELEMENTS, DEFAULTS, VIEW, null, actions, { columns: 100 })));
  });

  test(`${surface}: each card's status line names its state in its tone`, () => {
    const status = (tree, label) => kids(card(tree, label))[1];
    const tree = draw({}, { surface });
    const expect = {
      Jev: ['Ready', 'success'],
      Clef: ['No API token', 'warning'],
      'Clef Flash': ['No account ID', 'warning'],
      Ollama: ['Ready', 'success'],
    };
    for (const [label, [words, tone]] of Object.entries(expect)) {
      const line = status(tree, label);
      assert.equal(line.type, 'Text', label);
      assert.equal(line.props.children, words, label);
      assert.equal(line.props.color, toneColor(tone, 'graphical'), label);
    }
    const paused = draw({ health: { failures: 3, pausedUntil: Date.now() + 60e3 } }, { surface });
    assert.match(status(paused, 'Jev').props.children, /^Paused until \d/);
    assert.equal(status(paused, 'Jev').props.color, toneColor('warning', 'graphical'));
    const failed = draw({ error: 'timeout' }, { surface });
    assert.equal(status(failed, 'Jev').props.children, 'Last error: Jev timed out');
    assert.equal(status(failed, 'Ollama').props.children, 'Ready');
    // While routing is unavailable the error is the router's own reason, not the classifier's.
    const unavailable = draw({ phase: 'unavailable', error: 'bad router.json' }, { surface });
    assert.equal(status(unavailable, 'Jev').props.children, 'Ready');
  });

  test(`${surface}: latency and agreement are label and value rows; the credentials Buttons keep their keys`, () => {
    const tree = draw({}, { surface });
    const jev = card(tree, 'Jev');
    const words = texts(jev);
    for (const label of ['Prompt goes to', 'Wait', 'Tool agreement', 'Deadline', 'Sends', 'Health'])
      assert.ok(words.includes(label), label);
    assert.ok(words.includes('p95 ≤ 350 ms over 20 turns'), words.join('|'));
    assert.ok(words.includes('19 of 22 turns (86%) this session'));
    assert.ok(words.includes('Not paused · 1 recent failure · last 347 ms'));
    assert.equal(byKey(jev, 'key').props.label, 'Edit credentials');
    assert.equal(byKey(jev, 'key').props.hotkey, 'k');
    assert.ok(texts(card(tree, 'Ollama')).includes('This machine'));
    assert.ok(texts(card(tree, 'Clef Flash')).includes('69 of 70 right · p95 874 ms'));
    // One credentials Button per card: Set up where something is missing.
    assert.equal(byKey(card(tree, 'Clef'), 'key-clef').props.label, 'Set up');
    assert.ok(byKey(card(tree, 'Clef Flash'), 'key-clef-flash'));
    assert.equal(controls(card(tree, 'OpenAI')).filter((c) => /^key/.test(c.key)).length, 0);
  });

  test(`${surface}: the active classifier lacking its key has one Set up Button and every key is unique`, () => {
    const tree = draw({ credentials: { ...KEYS, jev: 'missing-key' } }, { surface });
    const jev = card(tree, 'Jev');
    assert.equal(byKey(jev, 'key-jev').props.label, 'Set up');
    assert.equal(byKey(jev, 'key-jev').props.hotkey, 'k');
    assert.equal(byKey(card(tree, 'Clef'), 'key-clef').props.hotkey, undefined);
    assert.equal(byKey(jev, 'key'), undefined);
    const keys = controls(tree).map((c) => c.key);
    assert.deepEqual(
      keys.filter((key, i) => keys.indexOf(key) !== i),
      [],
    );
  });

  test(`${surface}: Across sessions holds the stored counts as label and value rows`, () => {
    const tree = draw({}, { surface });
    const across = card(tree, 'Across sessions');
    const words = texts(across);
    for (const label of ['Labelled', 'Tool agreement', 'Activity moves', 'Escalations'])
      assert.ok(words.includes(label), label);
    assert.ok(words.includes('4 taken · 2 refused'));
    assert.ok(words.includes('1 after 12 cheaper activity moves'));
    assert.equal(card(draw({ activityStore: null }, { surface }), 'Across sessions'), undefined);
  });

  test(`${surface}: cards show display words: no hotkey letters, glyph-led states or router.json keys`, () => {
    const tree = draw({}, { surface });
    const words = [...texts(body(tree)), ...controls(body(tree)).map((c) => c.label ?? '')].join('\n');
    assert.doesNotMatch(words, /\([a-z]\)|timeoutMs|keyOption|◉|○|● ready/);
    for (const option of byKey(tree, 'timeoutMs').props.options) assert.doesNotMatch(option.label, /^[a-z]+$/);
  });

  test(`${surface}: the body uses tones, never terminal colours or dim text`, () => {
    const tree = draw({ health: { failures: 3, pausedUntil: Date.now() + 60e3 } }, { surface });
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
    const tree = draw(
      {
        adviceMs: Number.NaN,
        health: undefined,
        activityStats: null,
        activityStore: null,
        activityMetrics: null,
        credentials: {},
      },
      { surface },
    );
    assert.doesNotMatch(texts(body(tree)).join('\n'), /NaN|undefined|\?/);
    assert.ok(texts(card(tree, 'Jev')).includes('None measured yet'));
  });
}
