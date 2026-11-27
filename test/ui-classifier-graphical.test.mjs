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
const { byKey, controls, ELEMENTS, find, kids, recorder, texts, unique } = await import('./harness.mjs');

const SURFACES = ['desktop', 'vscode', 'mobile'];
const { actions, calls } = recorder();
const NOW = Date.UTC(2026, 0, 5, 13, 40);
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
  // Every tree a test draws holds each key and hotkey once.
  unique(renderPanel(ELEMENTS, config, { ...VIEW, ...props }, null, actions, { columns: 100, surface, now: NOW }));

const isCard = (n) => n.props.borderStyle === 'round';
const titleOf = (n) => texts(kids(n)[0])[0];
const cards = (tree) => find(body(tree), isCard);
const card = (tree, title) => cards(tree).find((n) => titleOf(n) === title);
const body = (tree) => byKey(tree, 'body');
const IDS = Object.keys(DEFAULTS.classifiers);
// A card's header row holds the Active mark or the Use Button.
const isActive = (n) => texts(kids(n)[0]).includes('Active');
// An inactive classifier's compact row.
const rowOf = (tree, id) => byKey(tree, `row-classifier-${id}`);

for (const surface of SURFACES) {
  test(`${surface}: the active classifier's full card, one Other classifiers card, then Across sessions`, () => {
    const tree = draw({}, { surface });
    assert.deepEqual(cards(tree).map(titleOf), ['Jev', 'Other classifiers', 'Across sessions']);
    const others = card(tree, 'Other classifiers');
    assert.equal(kids(others).length - 1, IDS.length - 1);
    assert.ok(others.props.gap, 'the rows are spaced');
    assert.deepEqual(
      kids(others)
        .slice(1)
        .map((row) => row.props.key),
      IDS.filter((id) => id !== 'jev').map((id) => `row-classifier-${id}`),
    );
  });

  for (const active of ['jev', 'ollama'])
    test(`${surface}: with ${active} active, exactly one full card, marked active; the others are rows with Use`, () => {
      const tree = draw({}, { surface, config: { ...DEFAULTS, classifier: active } });
      const marked = cards(tree).filter(isActive);
      assert.equal(marked.length, 1);
      assert.equal(titleOf(marked[0]), DEFAULTS.classifiers[active].label);
      assert.equal(cards(tree).length, 3);
      const mark = find(kids(marked[0])[0], (n) => n.type === 'Text' && n.props.children === '●');
      assert.equal(mark.length, 1);
      assert.equal(mark[0].props.color, toneColor('accent', 'graphical'));
      // The active mark keeps the classifier's key; every other row's Use Button has its own.
      assert.equal(find(body(tree), (n) => n.props.key === `classifier-${active}`).length, 1);
      for (const id of IDS.filter((one) => one !== active)) {
        const use = byKey(rowOf(tree, id), `classifier-${id}`);
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
      for (const id of IDS.filter((one) => one !== 'jev')) byKey(tree, `classifier-${id}`).props.onPress();
      byKey(tree, 'key-clef').props.onPress();
      byKey(tree, 'timeoutMs').props.onSelect('3000');
      byKey(tree, 'timeoutMs').props.onSelect('7');
      return [...calls];
    };
    const graphical = run(draw({}, { surface }));
    assert.deepEqual(graphical, [
      ...IDS.filter((one) => one !== 'jev').map((id) => ['classifier', id]),
      // Set up names the classifier it is for, after the press.
      ['key', undefined, 'clef'],
      ['classifierTimeout', 3000],
    ]);
    assert.deepEqual(graphical, run(renderPanel(ELEMENTS, DEFAULTS, VIEW, null, actions, { columns: 100 })));
  });

  test(`${surface}: the full card's and each row's status names its state in its tone`, () => {
    const status = (tree) => kids(card(tree, 'Jev'))[1];
    const rowStatus = (tree, id) => find(rowOf(tree, id), (n) => n.type === 'Text')[1];
    const tree = draw({}, { surface });
    assert.equal(status(tree).props.children, 'Ready');
    assert.equal(status(tree).props.color, toneColor('success', 'graphical'));
    const expect = {
      clef: ['No API token', 'warning'],
      'clef-flash': ['No account ID', 'warning'],
      ollama: ['Ready', 'success'],
    };
    for (const [id, [words, tone]] of Object.entries(expect)) {
      const line = rowStatus(tree, id);
      assert.equal(line.props.children, words, id);
      assert.equal(line.props.color, toneColor(tone, 'graphical'), id);
    }
    const paused = draw({ health: { failures: 3, pausedUntil: NOW + 60e3 } }, { surface });
    assert.equal(status(paused).props.children, 'Paused until 13:41');
    assert.equal(status(paused).props.color, toneColor('warning', 'graphical'));
    const failed = draw({ error: 'timeout' }, { surface });
    assert.equal(status(failed).props.children, 'Last error: Jev timed out');
    assert.equal(rowStatus(failed, 'ollama').props.children, 'Ready');
    // While routing is unavailable the error is the router's own reason, not the classifier's.
    const unavailable = draw({ phase: 'unavailable', error: 'bad router.json' }, { surface });
    assert.equal(status(unavailable).props.children, 'Ready');
  });

  test(`${surface}: latency and agreement are label and value rows; the credentials Buttons keep their keys`, () => {
    const tree = draw({}, { surface });
    const jev = card(tree, 'Jev');
    const words = texts(jev);
    for (const label of ['Prompt goes to', 'Wait', 'Deadline', 'Sends', 'Health'])
      assert.ok(words.includes(label), label);
    assert.ok(words.includes('p95 ≤ 350 ms over 20 turns'), words.join('|'));
    // The session's agreement is in the note of the fit across sessions, not on the card as well.
    assert.ok(!words.includes('Tool agreement'));
    const alone = texts(card(draw({ activityStore: null }, { surface }), 'Jev'));
    assert.ok(alone.includes('Tool agreement'));
    assert.ok(alone.includes('19 of 22 turns (86%) this session'));
    assert.ok(words.includes('Not paused · 1 recent failure · last 347 ms'));
    assert.equal(byKey(jev, 'key').props.label, 'Edit credentials');
    assert.equal(byKey(jev, 'key').props.hotkey, 'k');
    // A row's detail: where its prompt goes, then its probe result where it has one.
    assert.ok(texts(rowOf(tree, 'clef-flash')).includes('api.cloudflare.com · 69 of 70 right · p95 874 ms'));
    assert.ok(texts(rowOf(tree, 'ollama')).some((one) => /^This machine · \d+ of 70 right · p95 \d+ ms$/.test(one)));
    assert.ok(texts(rowOf(tree, 'clef-omni')).includes('api.cloudflare.com'));
    // Set up where something is missing, on the row itself.
    assert.equal(byKey(rowOf(tree, 'clef'), 'key-clef').props.label, 'Set up');
    assert.ok(byKey(rowOf(tree, 'clef-flash'), 'key-clef-flash'));
    assert.equal(controls(rowOf(tree, 'openai')).filter((c) => /^key/.test(c.key)).length, 0);
  });

  for (const columns of [100, 60, null])
    test(`${surface}: at ${columns ?? 'no'} columns a row is ${columns === 100 ? 'one line' : 'two lines'}, its Buttons never shrinking`, () => {
      const tree = renderPanel(ELEMENTS, DEFAULTS, VIEW, null, actions, { columns, surface });
      const row = rowOf(tree, 'clef');
      const lines = columns === 100 ? [row] : kids(row);
      assert.equal(row.props.flexDirection, columns === 100 ? 'row' : 'column');
      assert.equal(lines.length, columns === 100 ? 1 : 2);
      for (const line of lines) {
        assert.equal(line.props.flexWrap, 'nowrap');
        assert.equal(line.props.alignItems, 'center');
      }
      const buttons = find(row, (n) => n.type === 'Box' && byKey(n, 'classifier-clef') && byKey(n, 'key-clef')).at(-1);
      assert.equal(buttons.props.flexShrink, 0);
      assert.deepEqual(
        controls(buttons).map((c) => c.key),
        ['key-clef', 'classifier-clef'],
      );
      // The buttons are last on their line.
      assert.equal(kids(lines.at(-1)).at(-1), buttons);
    });

  test(`${surface}: with one classifier configured there is no Other classifiers card`, () => {
    const config = { ...DEFAULTS, classifiers: { jev: DEFAULTS.classifiers.jev } };
    const tree = draw({}, { surface, config });
    assert.equal(card(tree, 'Other classifiers'), undefined);
    assert.ok(card(tree, 'Jev'));
  });

  test(`${surface}: the active classifier lacking its key has one Set up Button and every key is unique`, () => {
    const tree = draw({ credentials: { ...KEYS, jev: 'missing-key' } }, { surface });
    const jev = card(tree, 'Jev');
    assert.equal(byKey(jev, 'key-jev').props.label, 'Set up');
    assert.equal(byKey(jev, 'key-jev').props.hotkey, 'k');
    assert.equal(byKey(rowOf(tree, 'clef'), 'key-clef').props.hotkey, undefined);
    assert.equal(byKey(jev, 'key'), undefined);
    const keys = controls(tree).map((c) => c.key);
    assert.deepEqual(
      keys.filter((key, i) => keys.indexOf(key) !== i),
      [],
    );
  });

  test(`${surface}: Across sessions shows a judged bar per share, then the misses`, () => {
    const across = card(draw({}, { surface }), 'Across sessions');
    assert.deepEqual(texts(across), [
      'Across sessions',
      '18 turns since the last reset',
      'Label fits tools',
      '78%',
      '14 of 18 · this session 86%',
      'Cheaper → back up',
      '8%',
      '1 of 12 cheaper moves',
      'Misses',
      'code → read ×3 · ops → code ×1',
    ]);
    // Each bar is filled to its share in its verdict's colour.
    const fills = find(across, (n) => n.type === 'Box' && /%$/.test(String(n.props.width ?? '')));
    assert.deepEqual(
      fills.map((n) => [n.props.width, n.props.backgroundColor]),
      [
        ['78%', toneColor('warning', 'graphical')],
        ['8%', toneColor('success', 'graphical')],
      ],
    );
    // Each label has a column it fits in.
    for (const label of ['Label fits tools', 'Cheaper → back up']) {
      const columns = find(across, (n) => n.type === 'Box' && n.props.width > 0 && texts(n).join() === label);
      assert.equal(columns.length, 1, label);
      assert.ok(columns[0].props.width >= label.length, label);
    }
    assert.equal(card(draw({ activityStore: null }, { surface }), 'Across sessions'), undefined);
  });

  test(`${surface}: cards show display words: no hotkey letters, glyph-led states or router.json keys`, () => {
    const tree = draw({}, { surface });
    const words = [...texts(body(tree)), ...controls(body(tree)).map((c) => c.label ?? '')].join('\n');
    assert.doesNotMatch(words, /\([a-z]\)|timeoutMs|keyOption|◉|○|● ready/);
    for (const option of byKey(tree, 'timeoutMs').props.options) assert.doesNotMatch(option.label, /^[a-z]+$/);
  });

  test(`${surface}: the body uses tones, never terminal colours or dim text`, () => {
    const tree = draw({ health: { failures: 3, pausedUntil: NOW + 60e3 } }, { surface });
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
