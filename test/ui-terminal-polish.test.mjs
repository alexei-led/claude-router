// The terminal's layout in a narrow docked pane: the band's hover controls drawn over its readings instead of on a row
// of their own, a header that says a warning once and a tab row that fits, help lines that wrap inside their column,
// and classifier rows whose status never wraps a word per line.
import assert from 'node:assert/strict';
import test from 'node:test';

process.env.TZ = 'UTC';

const { renderBand } = await import('../lib/band.mjs');
const { partsWidth, SEPARATOR } = await import('../lib/ui/model/band.mjs');
const { DEFAULTS } = await import('../lib/config.mjs');
const { BAND_STATES, CLAUDE: CLAUDE_USAGE } = await import('./band-states.mjs');
const { ELEMENTS } = await import('./harness.mjs');
const { NOW } = await import('./usage-fixtures.mjs');

const actions = new Proxy({}, { get: () => () => {} });
const kids = (node) =>
  (Array.isArray(node?.props?.children) ? node.props.children : [node?.props?.children]).filter(
    (child) => child && typeof child === 'object',
  );
const walk = (node, out = []) => {
  if (!node || typeof node !== 'object') return out;
  out.push(node);
  for (const child of kids(node)) walk(child, out);
  return out;
};
// An element back as the band's own part, so the band's own `partsWidth` measures it.
const asPart = (node) =>
  node.type === 'Button' ? { button: node.props } : { text: String(node.props.children ?? ''), style: {} };
const drawn = (node) =>
  node.type === 'Text'
    ? String(node.props.children ?? '')
    : node.type === 'Button'
      ? node.props.plain
        ? node.props.label
        : `[ ${node.props.label} ]`
      : kids(node)
          .filter((child) => child.props.position !== 'absolute')
          .map(drawn)
          .join('');

const band = (view, usage, columns) =>
  renderBand(ELEMENTS, DEFAULTS, view, usage ?? null, { columns, now: NOW }, actions);
const overlayOf = (tree) => walk(tree).filter((node) => node.type === 'Box' && node.props.display === 'none');
// Each Button of the resting row as the cells it spans.
const buttonSpans = (row) => {
  let col = 0;
  const spans = [];
  for (const node of kids(row).filter((child) => child.props.position !== 'absolute')) {
    const w = partsWidth([asPart(node)]);
    if (node.type === 'Button') spans.push({ key: node.props.key, from: col, to: col + w });
    col += w;
  }
  return { spans, width: col };
};

for (const columns of [120, 100, 80, 70, 60, 40, null])
  test(`the terminal band draws its hover controls on its first row, covering none of its Buttons, at ${columns} columns`, () => {
    for (const [name, { view, usage }] of Object.entries(BAND_STATES)) {
      const label = `${name} at ${columns}`;
      const tree = band(view, usage, columns);
      const rows = kids(tree);
      assert.equal(rows.length, view.bandDetail ? 2 : 1, label);
      const overlays = overlayOf(tree);
      assert.ok(overlays.length <= 2, label);
      const { spans, width } = buttonSpans(rows[0]);
      if (columns !== null) assert.ok(width <= columns, label);
      const router = spans.find((span) => span.key === 'details');
      // The overlays come after the row's own parts, so they paint over them.
      const flow = kids(rows[0]).filter((node) => node.props.position !== 'absolute').length;
      assert.deepEqual(kids(rows[0]).slice(flow), overlays, `${label}: painted last`);
      const placed = [];
      for (const overlay of overlays) {
        assert.ok(kids(rows[0]).includes(overlay), `${label}: a child of the first row`);
        assert.equal(overlay.props.position, 'absolute', label);
        assert.equal(overlay.props.top, 0, label);
        assert.deepEqual(overlay.props.hover, { display: 'flex' }, label);
        const from = overlay.props.left;
        const to = from + partsWidth(kids(overlay).map(asPart));
        for (const span of spans)
          assert.ok(
            to <= span.from || from >= span.to,
            `${label}: covers ${span.key} [${span.from}, ${span.to}) with [${from}, ${to})`,
          );
        for (const other of placed) assert.ok(to <= other.from || from >= other.to, `${label}: overlays overlap`);
        placed.push({ from, to });
        if (columns === null) continue;
        assert.ok(to - from >= 12, label);
        // Over the readings up to the gap before Router, or after Router to the band's end.
        assert.equal(to, from < router.from ? router.from - 2 : columns, label);
      }
      // The first overlay holds the wider stretch; the second only what did not fit in it.
      if (overlays.length === 2 && columns !== null)
        assert.ok(placed[0].to - placed[0].from >= placed[1].to - placed[1].from, label);
      // Each hover control is drawn once.
      const keys = overlays.flatMap((overlay) =>
        walk(overlay)
          .filter((node) => node.type === 'Button')
          .map((node) => node.props.key),
      );
      assert.equal(new Set(keys).size, keys.length, label);
    }
  });

test('with readings at the row’s end, the overlay starts after the first segment and its separator', () => {
  for (const name of ['routed', 'routed-goal', 'native-fallback']) {
    const { view } = BAND_STATES[name];
    const tree = band(view, CLAUDE_USAGE, 100);
    const [row] = kids(tree);
    const [overlay] = overlayOf(tree);
    const first = drawn(row).split(SEPARATOR)[0];
    assert.equal(overlay.props.left, [...first].length + SEPARATOR.length, name);
    assert.equal(buttonSpans(row).spans.at(-1).from, 100 - 6, `${name}: Router at the band's end`);
  }
});

test('with nothing at the row’s end, the overlay takes the wider stretch: after Router, or over the reading', () => {
  const at = (columns) => {
    const tree = band(BAND_STATES.routed.view, null, columns);
    const [row] = kids(tree);
    const [overlay] = overlayOf(tree);
    return [drawn(row), overlay?.props.left];
  };
  // The row as it rests: Router follows the reason.
  assert.deepEqual(at(100), ['▂▄▆█ Opus 5.5 · xhigh   ↑ clearly stronger  Router', 52]);
  // At 60 the 8 columns after Router are fewer than the 18 over the reason.
  assert.deepEqual(at(60), ['▂▄▆█ Opus 5.5 · xhigh   ↑ clearly stronger  Router', 24]);
});

test('the overlay leaves the band’s own buttons uncovered: Set up, Details and the pin’s ✕', () => {
  for (const [name, key] of [
    ['classifier-set-up', 'band-key'],
    ['classifier-details', 'band-fix'],
    ['pending-pin', 'band-unpin'],
  ]) {
    const { view, usage } = BAND_STATES[name];
    const tree = band(view, usage, 140);
    const [row] = kids(tree);
    const [overlay] = overlayOf(tree);
    assert.ok(overlay, name);
    const parts = kids(row).filter((node) => node.props.position !== 'absolute');
    const at = parts.findIndex((node) => node.props.key === key);
    assert.ok(at >= 0, name);
    const end = partsWidth(parts.slice(0, at + 1).map(asPart));
    assert.ok(overlay.props.left >= end + SEPARATOR.length, `${name}: ${overlay.props.left} after ${end}`);
  }
});

test('the overlay keeps the hover controls’ keys and presses', () => {
  const pressed = [];
  const spy = new Proxy(
    {},
    {
      get:
        (_t, name) =>
        (...args) =>
          pressed.push([name, ...args]),
    },
  );
  const tree = renderBand(ELEMENTS, DEFAULTS, BAND_STATES.ready.view, null, { columns: 200, now: NOW }, spy);
  const [overlay] = overlayOf(tree);
  const buttons = walk(overlay).filter((node) => node.type === 'Button');
  assert.deepEqual(
    buttons.map((node) => node.props.key),
    ['band-pin-micro', 'band-pin-low', 'band-pin-medium', 'band-pin-high', 'band-manual', 'band-detail'],
  );
  for (const node of buttons) node.props.onPress();
  assert.deepEqual(pressed, [
    ['pin', 'micro'],
    ['pin', 'low'],
    ['pin', 'medium'],
    ['pin', 'high'],
    ['mode', 'manual'],
    ['toggleDetail'],
  ]);
});

test('a narrowing overlay drops the pins’ route names first, then 2 rows and the pins, and keeps Turn off', () => {
  const { view } = BAND_STATES.routed;
  const controls = (columns, bandDetail = false) => {
    const [overlay] = overlayOf(band({ ...view, bandDetail }, CLAUDE_USAGE, columns));
    return overlay
      ? kids(overlay)
          .filter((node) => node.type === 'Button')
          .map((node) => node.props.label)
      : null;
  };
  assert.deepEqual(controls(140), [
    '▂ Haiku·medium',
    '▂▄ Haiku·high',
    '▂▄▆ Opus·medium',
    '▂▄▆█ Opus·xhigh',
    'Turn off',
    '2 rows',
  ]);
  assert.deepEqual(controls(100), ['▂', '▂▄', '▂▄▆', '▂▄▆█', 'Turn off', '2 rows']);
  assert.deepEqual(controls(60), ['Turn off']);
  // Two rows keeps 1 row beside Turn off, the only way back to one row.
  assert.deepEqual(controls(70, true), ['Turn off', '1 row']);
  // Under 12 columns left over there is no overlay at all.
  assert.equal(controls(40), null);
});

test('a band with no width draws every hover control unpadded', () => {
  const tree = band(BAND_STATES.routed.view, null, null);
  const [overlay] = overlayOf(tree);
  assert.equal(overlay.props.position, 'absolute');
  assert.ok(walk(overlay).some((node) => node.props.key === 'band-manual'));
  assert.ok(
    !kids(overlay).some(
      (node) => node.type === 'Text' && /^ +$/.test(node.props.children) && node.props.children.length > 2,
    ),
  );
});

// B. The pane header.
const { renderPanel } = await import('../lib/panel.mjs');
const { routeDraftOf } = await import('../lib/ui/model/draft.mjs');
const { classifierTwoLine } = await import('../lib/ui/terminal/classifier.mjs');
const { CLAUDE } = await import('./band-states.mjs');
const KEYS_SET = { jev: null, clef: null, 'clef-flash': null, 'clef-omni': null };
const TAB_IDS = ['now', 'routes', 'policy', 'classifier', 'usage'];
const pane = (view, columns, config = DEFAULTS) =>
  renderPanel(ELEMENTS, config, { mode: 'auto', phase: 'routed', ...view }, CLAUDE, actions, { columns, now: NOW });
const headerLine = (tree) => kids(tree)[0];
const tabRow = (tree) => kids(tree).find((node) => walk(node).some((one) => one.props.key === 'tab-now'));
const textOf = (node) =>
  walk(node)
    .map((one) =>
      one.type === 'Text' ? String(one.props.children) : one.type === 'Button' ? `[ ${one.props.label} ]` : '',
    )
    .join('');

test('a header with the classifier warning under the tab row says see below instead of repeating it', () => {
  for (const tab of TAB_IDS) {
    const tree = pane({ tab, credentials: {} }, 80);
    const head = headerLine(tree);
    assert.doesNotMatch(textOf(head), /no API key/, tab);
    const word = walk(head).find((node) => node.type === 'Text' && node.props.children === 'see below');
    assert.ok(word, tab);
    assert.equal(word.props.dimColor, true, tab);
    assert.equal(textOf(tree).split('no API key, keeping the model').length - 1, 1, tab);
  }
});

test('a header without a notice keeps its classifier status', () => {
  for (const [view, status] of [
    [{ credentials: KEYS_SET, adviceMs: 347 }, 'Jev ready · 347 ms'],
    [{ credentials: KEYS_SET, error: 'timeout' }, 'Jev timed out'],
    // Routing off draws no notice, so the header still names the missing key.
    [{ credentials: {}, mode: 'manual', phase: 'manual' }, 'Jev: no API key'],
  ]) {
    const head = headerLine(pane({ tab: 'now', ...view }, 80));
    assert.ok(
      walk(head).some((node) => node.type === 'Text' && node.props.children === status),
      `${status}: ${textOf(head)}`,
    );
  }
});

// The tab row's width as the terminal draws it: a Button is its label in `[ ` and ` ]`.
const rowWidth = (row) =>
  kids(row).reduce(
    (n, node) => n + (node.type === 'Button' ? node.props.label.length + 4 : String(node.props.children).length),
    0,
  );
// Unsaved Routes and Policy drafts: both tabs carry a ● mark, the widest row.
const BASE_DRAFT = routeDraftOf(DEFAULTS, {});
const UNSAVED_DRAFT = {
  ...BASE_DRAFT,
  baselineTier: 'micro',
  routes: { ...BASE_DRAFT.routes, micro: { model: 'sonnet', effort: 'high' } },
};
for (const columns of [60, 70, 80, 120])
  test(`the tab row fits ${columns} columns and keeps every tab, its hotkey and help`, () => {
    for (const [name, view] of [
      ['plain', { tab: 'now', credentials: KEYS_SET }],
      ['unsaved', { tab: 'routes', credentials: KEYS_SET, tuning: { horizon: 10 }, routeDraft: UNSAVED_DRAFT }],
      ['unavailable', { tab: 'now', phase: 'unavailable', error: 'bad router.json' }],
    ]) {
      const label = `${name} at ${columns}`;
      const tree = pane(view, columns);
      const row = tabRow(tree);
      assert.ok(rowWidth(row) <= columns, `${label}: ${rowWidth(row)}`);
      const parts = kids(row);
      parts.forEach((node, i) => {
        if (node.type === 'Button' && parts[i + 1]?.type === 'Button') assert.fail(`${label}: two Buttons touch`);
        if (node.type === 'Button' && i + 1 < parts.length)
          assert.equal(parts[i + 1].props.children, ' ', `${label}: a space after ${node.props.key}`);
      });
      const buttons = walk(tree).filter((node) => node.type === 'Button');
      for (const [i, id] of TAB_IDS.entries()) {
        const tab = buttons.find((node) => node.props.key === `tab-${id}`);
        assert.ok(tab, `${label}: tab-${id}`);
        assert.equal(tab.props.hotkey, String(i + 1), `${label}: tab-${id}`);
      }
      const help = buttons.filter((node) => node.props.key === 'help');
      assert.equal(help.length, 1, label);
      // The help Button is on the tab row, or at the header line's end when the row has no room for it.
      const head = headerLine(tree);
      assert.ok(kids(row).includes(help[0]) || kids(head).at(-1) === help[0], label);
      if (kids(head).includes(help[0])) assert.ok(textOf(head).length <= columns, `${label}: ${textOf(head)}`);
    }
  });

test('a wide tab row keeps the digits in the labels; a 60-column one drops them', () => {
  const labels = (columns) =>
    kids(tabRow(pane({ tab: 'now', credentials: KEYS_SET }, columns)))
      .filter((node) => node.type === 'Button')
      .map((node) => node.props.label);
  assert.deepEqual(labels(80), ['1 Now', '2 Routes', '3 Policy', '4 Classifier', '5 Usage', '?']);
  assert.deepEqual(labels(60), ['Now', 'Routes', 'Policy', 'Classifier', 'Usage', '?']);
});

// One element per key and per hotkey: the engine cannot tell two apart (the walk the graphical tests share).
const { duplicates } = await import('./harness.mjs');

test('every terminal tab draws each key and hotkey once, with and without missing credentials', () => {
  for (const tab of TAB_IDS)
    for (const [name, credentials] of [
      ['keys set', KEYS_SET],
      ['no keys', {}],
    ])
      for (const columns of [60, 100, null]) {
        const tree = pane({ tab, credentials }, columns);
        assert.deepEqual(duplicates(tree), { keys: [], hotkeys: [] }, `${tab} with ${name} at ${columns}`);
      }
});

test('on the Classifier tab the warning has no Set up of its own: the Credentials row has the action', () => {
  const tree = pane({ tab: 'classifier', credentials: {} }, 100);
  const owners = walk(tree).filter((node) => node.type === 'Button' && node.props.hotkey === 'k');
  assert.deepEqual(
    owners.map((node) => [node.props.key, node.props.label]),
    [['key', 'Edit']],
  );
  assert.match(textOf(tree), /Jev: no API key, keeping the model/);
  // Elsewhere the warning keeps its Set up.
  const now = walk(pane({ tab: 'now', credentials: {} }, 100)).filter((node) => node.props.key === 'key');
  assert.deepEqual(
    now.map((node) => node.props.label),
    ['Set up'],
  );
});

// C. Policy: a field's lines in a column beside its label, so a wrapped line stays in that column.
const { screen } = await import('./harness.mjs');
const parentOf = (tree, target) => walk(tree).find((node) => kids(node).includes(target));
const isLabel = (node, width) => node?.type === 'Box' && node.props.width === width && node.props.flexShrink === 0;
const isValueColumn = (node) =>
  node?.type === 'Box' &&
  node.props.flexDirection === 'column' &&
  node.props.flexGrow === 1 &&
  node.props.flexShrink === 1;
// A help Text: in its field's value column, beside the fixed-width label, wrapping inside it.
const assertHanging = (tree, words, width, label) => {
  const text = walk(tree).find((node) => node.type === 'Text' && node.props.children === words);
  assert.ok(text, `${label}: ${words}`);
  assert.equal(text.props.wrap, 'wrap', `${label}: ${words}`);
  const column = parentOf(tree, text);
  assert.ok(isValueColumn(column), `${label}: ${words} in a value column`);
  const field = parentOf(tree, column);
  assert.ok(isLabel(kids(field)[0], width), `${label}: ${words} beside its label`);
  assert.equal(kids(field)[1], column, label);
};
const POLICY_HELP = [
  'each tier runs its route as configured',
  'this session runs cost (session)',
  'when the session’s model is no tier’s model',
  'else a new task runs its tier’s model; a continuation keeps it',
  'no model in router.json bills credits, so this has no effect',
];

for (const columns of [60, 80, null])
  test(`Policy help lines hang inside their value column at ${columns} columns`, () => {
    const view = { tab: 'policy', credentials: KEYS_SET, routingMode: { mode: 'cost', source: 'session' } };
    const tree = pane(view, columns);
    for (const words of POLICY_HELP) assertHanging(tree, words, 13, columns);
    assertHanging(tree, 'needs Jev support of 75%, up to 90% as the switch costs more', 13, columns);
    const padded = walk(tree).filter(
      (node) => node.type === 'Text' && /^ {3,}\S/.test(String(node.props.children)) && node.props.wrap === 'wrap',
    );
    assert.deepEqual(padded, [], `${columns}: no help Text starts with padding`);
    assert.ok(!walk(tree).some((node) => node.type === 'Text' && /^ {13}/.test(String(node.props.children))));
  });

test('Policy keeps every control, Reset and copy, with their presses', () => {
  const pressed = [];
  const spy = new Proxy(
    {},
    {
      get:
        (_t, name) =>
        (...args) =>
          pressed.push([name, ...args]),
    },
  );
  const view = {
    mode: 'auto',
    phase: 'routed',
    tab: 'policy',
    credentials: KEYS_SET,
    configPath: '/fixture/router.json',
  };
  const tree = renderPanel(ELEMENTS, DEFAULTS, view, null, spy, { columns: 60, now: NOW });
  const nodes = walk(tree);
  const find = (key) => nodes.find((node) => node.props.key === key);
  for (const key of ['routing-mode', 'baseline', 'downgradeVotes', 'horizon', 'activityMass', 'cashCapUsd'])
    assert.equal(find(key)?.type, 'Select', key);
  find('routing-mode').props.onSelect('cost');
  find('baseline').props.onSelect('low');
  find('horizon').props.onSelect(5);
  find('reset-policy').props.onPress();
  find('copy-path').props.onPress();
  assert.deepEqual(pressed, [
    ['routingMode', 'cost'],
    ['baseline', 'low'],
    ['tune', 'horizon', 5],
    ['resetPolicy'],
    ['copyPath'],
  ]);
});

test('a wide Policy tab reads as it did', () => {
  const view = { tab: 'policy', credentials: KEYS_SET, routingMode: { mode: 'cost', source: 'session' } };
  assert.deepEqual(screen(pane(view, 120)), WIDE_POLICY);
});

// The 120-column Policy tab before its fields hung their lines in a column: it must read the same.
const WIDE_POLICY = [
  'ROUTER  [ ◉ on ] [ ○ off ]  Jev ready',
  '[ 1 Now ] [ 2 Routes ] [ 3 Policy ] [ 4 Classifier ] [ 5 Usage ] [ ? ]',
  '',
  'POLICY · how readily the router changes models · edit, then Save',
  '',
  'Mode         balanced ▾  saved at once',
  '             each tier runs its route as configured',
  '             this session runs cost (session)',
  'Start        at low ▾',
  '             when the session’s model is no tier’s model',
  'Going down   after 2 ▾ agreeing turns',
  '             if a cache write pays back within 5 ▾',
  'Going up     needs Jev support of 75%, up to 90% as the switch costs more',
  'Activities   apply at 0.6 ▾ certainty or more',
  '             else a new task runs its tier’s model; a continuation keeps it',
  'Credits      cap one cold cache write at 2 ▾',
  '             no model in router.json bills credits, so this has no effect',
  '',
  '[ Reset policy to defaults ]',
  '',
  'FILE  profile router.json',
  'Subagents: on. Agents that pin no model get one at spawn, kept for every step.',
];

// D. Classifier rows in a narrow pane: two lines each, the status never squeezed.
const CLASSIFIER_IDS = Object.keys(DEFAULTS.classifiers);
const classifierView = { tab: 'classifier', credentials: { ...KEYS_SET, 'clef-flash': 'missing-key' } };
// The classifier rows' Buttons and what each press asks for.
const classifierPresses = (columns) => {
  const pressed = [];
  const spy = new Proxy(
    {},
    {
      get:
        (_t, name) =>
        (...args) =>
          pressed.push([name, ...args]),
    },
  );
  const view = { mode: 'auto', phase: 'routed', ...classifierView };
  const tree = renderPanel(ELEMENTS, DEFAULTS, view, CLAUDE, spy, { columns, now: NOW });
  const buttons = walk(tree).filter((node) => node.type === 'Button' && /^(classifier|key)-/.test(node.props.key));
  for (const node of buttons) node.props.onPress();
  return { keys: buttons.map((node) => [node.props.key, node.props.label]), pressed };
};

for (const columns of [60, null])
  test(`a narrow Classifier tab draws each classifier on two lines at ${columns} columns`, () => {
    const tree = pane(classifierView, columns);
    assert.ok(!textOf(tree).includes('prompt goes to'), 'no row of column titles');
    for (const id of CLASSIFIER_IDS) {
      const name = walk(tree).find((node) => node.props.key === `classifier-${id}`);
      const first = parentOf(tree, parentOf(tree, name));
      const block = parentOf(tree, first);
      assert.equal(block.props.flexDirection, 'column', id);
      assert.equal(kids(block).length, 2, `${id}: two rows`);
      assert.equal(kids(block)[0], first, id);
      const status = kids(first)
        .flatMap((cell) => walk(cell))
        .filter((node) => node.type === 'Text' && node.props.wrap === 'truncate-end');
      assert.equal(status.length, 1, `${id}: one status Text`);
      assert.match(status[0].props.children, /^(● ready|○ no API (key|token)) *$/, id);
      // The status cell shrinks, keeping its mark, so a long status is cut instead of pushing Set up off the row.
      const cell = parentOf(tree, status[0]);
      assert.equal(cell.props.flexShrink, 1, id);
      assert.equal(cell.props.minWidth, 2, id);
      const setup = walk(first).find((node) => node.props.key === `key-${id}`);
      if (setup) assert.notEqual(parentOf(tree, setup).props.flexShrink, 1, `${id}: Set up never shrinks`);
      if (setup) assert.equal(setup.props.flexShrink ?? 0, 0, id);
      // Set up, where credentials are missing, is on the first line.
      assert.equal(
        Boolean(setup),
        walk(tree).some((node) => node.props.key === `key-${id}`),
        id,
      );
      const second = kids(block)[1];
      const detail = walk(second).find((node) => node.type === 'Text' && /\S/.test(node.props.children));
      assert.equal(detail.props.dimColor, true, id);
    }
    const lines = screen(tree);
    assert.ok(lines.includes('    api.cloudflare.com · 69/70 · p95 883 ms'), lines.join('\n'));
    assert.ok(lines.includes('    this machine · 66/70 · p95 3483 ms'));
    assert.ok(lines.includes('    api.typesafe.ai'));
    assert.ok(
      lines.some((line) => /^\[ ○ Clef Flash \] ○ no API token +\[ Set up \]$/.test(line)),
      lines.join('\n'),
    );
    // The active classifier's help lines hang under its settings, as Policy's do.
    assertHanging(tree, 'past the deadline the turn keeps its model', 12, columns);
    assertHanging(tree, 'the bounded active goal and current step also go to the classifier', 12, columns);
  });

test('a narrow Classifier tab keeps the wide one’s keys, labels and presses', () => {
  assert.deepEqual(classifierPresses(60), classifierPresses(100));
  assert.deepEqual(classifierPresses(null), classifierPresses(100));
});

// The wide Classifier rows are drawn only where the widest of them, Set up included, fits.
test('Classifier rows go two-line whenever the widest wide row does not fit', () => {
  // The widest row here: `[ ○ Clef Flash ]`, host, probe, p95, `○ no API token  ` and `[ Set up ]`, 82 cells.
  const twoLine = (columns, credentials) => {
    const tree = pane({ tab: 'classifier', credentials }, columns);
    return !textOf(tree).includes('prompt goes to');
  };
  const missing = { ...KEYS_SET, 'clef-flash': 'missing-key' };
  assert.equal(twoLine(80, missing), true);
  assert.equal(twoLine(81, missing), true);
  assert.equal(twoLine(82, missing), false);
  assert.equal(twoLine(84, missing), false);
  // Every row drawn wide fits the pane.
  for (const columns of [82, 84]) {
    const lines = screen(pane({ tab: 'classifier', credentials: missing }, columns));
    for (const line of lines.filter((one) => /^\[ [◉○] /.test(one)))
      assert.ok([...line].length <= columns, `${columns}: ${line}`);
  }
  // With every key set (OpenAI still lacks one), the widest row is `○ no API key  [ Set up ]`, 80 cells.
  assert.equal(twoLine(80, KEYS_SET), false);
  assert.equal(twoLine(79, KEYS_SET), true);
});

test('with no rows to draw, the Classifier layout reads as fitting, with no -Infinity in the comparison', () => {
  assert.equal(classifierTwoLine([], 60), false);
  assert.equal(classifierTwoLine([], null), true);
  const row = { state: { text: '○ no API token' }, setup: { label: 'Set up' } };
  assert.equal(classifierTwoLine([row], 81), true);
  assert.equal(classifierTwoLine([row], 82), false);
});

// The help behind `?`: whole paragraphs the terminal wraps to the pane, not lines cut for 68 columns.
test('the terminal help draws its head and one wrapping Text per paragraph', () => {
  for (const columns of [50, 60, 100, null]) {
    const tree = pane({ tab: 'now', credentials: KEYS_SET, help: true }, columns);
    const nodes = kids(tree);
    const head = nodes.findIndex((node) => node.type === 'Text' && node.props.children === 'ABOUT THESE NUMBERS');
    assert.ok(head >= 0, `${columns}`);
    const paragraphs = nodes.slice(head + 1, head + 7);
    assert.deepEqual(
      paragraphs.map((node) => node.props.children),
      [
        '≈$ is tokens × configured API rates in router.json (list/custom).',
        'These are estimates, not invoices or measured plan-quota savings.',
        'No routing: your model on the main thread, Claude Code’s pick per agent, same tokens and output length. Answer quality is not measured.',
        'For the whole session cost, with side calls such as titles and compaction that the router does not see, run /cost.',
        'Plan bars are Claude Code’s 5-hour and 7-day readings.',
        'Tiers show as bars ▂▄▆█, low to high; a route never moves past 80% of its window.',
      ],
      `${columns}`,
    );
    for (const node of paragraphs) {
      assert.equal(node.props.wrap, 'wrap', `${columns}`);
      assert.equal(node.props.dimColor, true, `${columns}`);
    }
    assert.equal(nodes[head + 7].props.children, ' ', `${columns}: a blank line after`);
  }
});

// The terminal's way back from two band rows that needs no band room: a toggle on the Now tab's SESSION line.
test('the Now tab’s SESSION line toggles the band’s second row in every state', () => {
  for (const [name, view] of [
    ['routed', { credentials: KEYS_SET }],
    ['empty', { credentials: KEYS_SET, usageSession: null, strip: null }],
    ['off', { mode: 'manual', phase: 'manual', nativeModel: 'claude-opus-5-5' }],
    ['unavailable', { phase: 'unavailable', error: 'bad router.json' }],
  ])
    for (const bandDetail of [true, false])
      for (const columns of [40, 60, 100, null]) {
        const label = `${name}, ${bandDetail ? 'two rows' : 'one row'}, at ${columns}`;
        let toggled = 0;
        const spy = new Proxy({}, { get: (_t, key) => (key === 'toggleDetail' ? () => (toggled += 1) : () => {}) });
        const tree = renderPanel(
          ELEMENTS,
          DEFAULTS,
          { mode: 'auto', phase: 'routed', tab: 'now', bandDetail, ...view },
          null,
          spy,
          { columns, now: NOW },
        );
        const toggles = walk(tree).filter((node) => node.props.key === 'band-detail-toggle');
        assert.equal(toggles.length, 1, label);
        assert.equal(toggles[0].props.label, bandDetail ? 'band: 1 row' : 'band: 2 rows', label);
        const line = parentOf(tree, toggles[0]);
        assert.ok(
          kids(line).some((node) => node.props.children === 'SESSION'),
          `${label}: on the SESSION line`,
        );
        toggles[0].props.onPress();
        assert.equal(toggled, 1, label);
      }
});

test('with two band rows the terminal always has a way back to one', () => {
  const view = { ...BAND_STATES.routed.view, bandDetail: true };
  for (let columns = 24; columns <= 160; columns += 1) {
    const back = [
      ...walk(band(view, null, columns)).filter((node) => node.props.key === 'band-detail'),
      ...walk(pane({ ...view, tab: 'now', credentials: KEYS_SET }, columns)).filter(
        (node) => node.props.key === 'band-detail-toggle',
      ),
    ];
    assert.ok(back.length > 0, `${columns}`);
  }
  // In the user's 70-column pane the band itself keeps 1 row on hover.
  assert.ok(
    walk(band(view, null, 70)).some((node) => node.props.key === 'band-detail' && node.props.label === '1 row'),
  );
});
