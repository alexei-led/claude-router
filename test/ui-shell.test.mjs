// The graphical pane shell: title row, tab row, one notices slot, the body, and the save bar last. The terminal
// frame is pinned by ui-golden.test.mjs; here the terminal only has to show the same warnings in the same slot.
import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULTS } from '../lib/config.mjs';
import { renderPanel, routeDraftOf } from '../lib/panel.mjs';
import { paintersOf } from '../lib/ui/painter.mjs';
import { toneColor } from '../lib/ui/tokens.mjs';
import { byKey, controls, ELEMENTS, find, kids, texts } from './harness.mjs';

const SURFACES = ['desktop', 'vscode', 'mobile'];
const KEYS_SET = { jev: null, clef: null, 'clef-flash': null, 'clef-omni': null };
const view = (props = {}) => ({ mode: 'auto', phase: 'routed', credentials: KEYS_SET, tab: 'now', ...props });
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
const draw = (props, surface = 'desktop', usage = null) =>
  renderPanel(ELEMENTS, DEFAULTS, view(props), usage, actions, { columns: 100, surface });
const WARNED = {
  projectError: 'router.json: unknown model',
  actualModel: 'claude-sonnet-5-5',
  selectedModel: 'claude-haiku-5-5',
  credentials: {},
};
const SAVED = routeDraftOf(DEFAULTS, {});
const DRAFT = { ...SAVED, routes: { ...SAVED.routes, micro: { ...SAVED.routes.high } } };

const textOf = (node) =>
  typeof node?.props?.children === 'string' ? node.props.children : kids(node).map(textOf).join('');
// The shell's own children, in order, under the root.
const shell = (tree) => kids(tree);

for (const surface of SURFACES) {
  test(`${surface}: tabs are hotkeyed 1-5 with labels that carry no digit`, () => {
    const tree = draw({ tab: 'routes', routeDraft: DRAFT }, surface);
    const tabs = ['now', 'routes', 'policy', 'classifier', 'usage'].map((id) => byKey(tree, `tab-${id}`).props);
    assert.deepEqual(
      tabs.map((t) => t.hotkey),
      ['1', '2', '3', '4', '5'],
    );
    assert.deepEqual(
      tabs.map((t) => t.label),
      ['Now', 'Routes ●', 'Policy', 'Classifier', 'Usage'],
    );
    assert.deepEqual(
      tabs.map((t) => t.variant),
      ['secondary', 'primary', 'secondary', 'secondary', 'secondary'],
    );
  });

  test(`${surface}: the title row has Router, the classifier status and On | Off on the old keys`, () => {
    const tree = draw({ adviceMs: 347 }, surface);
    const head = shell(tree)[0];
    const words = texts(head);
    assert.ok(words.includes('Router'));
    assert.ok(words.some((t) => /^Jev ready · 347 ms$/.test(t)));
    const pair = controls(head).filter((c) => c.key === 'auto' || c.key === 'manual');
    assert.deepEqual(
      pair.map((c) => [c.key, c.label, c.hotkey, c.variant]),
      [
        ['auto', 'On', 'o', 'primary'],
        ['manual', 'Off', 'f', 'secondary'],
      ],
    );
    calls.length = 0;
    pair[1].onPress();
    assert.deepEqual(calls, [['mode', 'manual']]);
    const off = controls(shell(draw({ mode: 'manual' }, surface))[0]);
    assert.equal(off.find((c) => c.key === 'manual').variant, 'primary');
    assert.equal(off.find((c) => c.key === 'auto').variant, 'secondary');
  });

  test(`${surface}: one notices slot sits directly under the tabs and holds every warning`, () => {
    for (const tab of ['now', 'routes', 'policy', 'classifier', 'usage']) {
      const tree = draw({ ...WARNED, tab }, surface);
      const [, tabRow, slot] = shell(tree);
      assert.ok(byKey(tabRow, `tab-${tab}`), `${tab} tab row`);
      assert.equal(slot.props.key, 'notices', tab);
      const lines = kids(slot).map(textOf);
      assert.equal(lines.length, 3, tab);
      assert.match(lines[0], /Ignored: router\.json: unknown model/);
      assert.match(lines[1], /served by .* native fallback/);
      assert.match(lines[2], /keeping the model/);
      // On Classifier the active card holds Set up and k; on every other tab the notice does.
      if (tab === 'classifier') assert.equal(byKey(slot, 'key'), undefined, `${tab} Set up`);
      else {
        assert.ok(byKey(slot, 'key'), `${tab} Set up`);
        assert.equal(byKey(slot, 'key').props.hotkey, 'k');
      }
      // Nothing else on the page repeats a warning.
      const rest = texts({ type: 'Box', props: { children: shell(tree).filter((n) => n !== slot) } }).join('\n');
      assert.doesNotMatch(rest, /Ignored:|native fallback|keeping the model/, tab);
    }
  });

  test(`${surface}: warnings are drawn in the warning tone, and there is no slot without one`, () => {
    const slot = shell(draw(WARNED, surface))[2];
    for (const line of find(slot, (n) => n.type === 'Text' && /Ignored|served|keeping/.test(n.props.children)))
      assert.equal(line.props.color, toneColor('warning', 'graphical'));
    const clear = shell(draw({}, surface));
    assert.equal(find({ type: 'Box', props: { children: clear } }, (n) => n.props.key === 'notices').length, 0);
  });

  test(`${surface}: the save bar is the last child on every tab and its Save calls saveRouting`, () => {
    for (const tab of ['now', 'routes', 'policy', 'classifier', 'usage']) {
      const tree = draw({ tab, routeDraft: DRAFT }, surface);
      const last = shell(tree).at(-1);
      assert.equal(last.props.key, 'save-bar', tab);
      assert.match(texts(last).join(' '), /^Unsaved changes 1 change/, tab);
      calls.length = 0;
      byKey(last, 'save-routing').props.onPress();
      byKey(last, 'discard-routing').props.onPress();
      assert.deepEqual(calls, [['saveRouting'], ['discardRouting']], tab);
      assert.equal(byKey(last, 'save-routing').props.hotkey, 's');
      assert.equal(byKey(last, 'discard-routing').props.hotkey, 'd');
    }
    const clean = shell(draw({}, surface));
    assert.notEqual(clean.at(-1).props.key, 'save-bar');
  });

  test(`${surface}: the undo button survives with its key and hotkey`, () => {
    const tree = draw({ lastWrite: { label: 'classifier jev' } }, surface);
    assert.equal(byKey(tree, 'undo').props.hotkey, 'u');
    assert.equal(byKey(tree, 'help').props.label, '?');
  });

  test(`${surface}: a view with no readings draws no NaN, undefined or stray ?`, () => {
    for (const tab of ['now', 'routes', 'policy', 'classifier', 'usage']) {
      const tree = draw({ tab, adviceMs: Number.NaN, phase: 'unavailable', error: 'bad router.json' }, surface);
      const words = texts(tree).join('\n');
      assert.doesNotMatch(words, /NaN|undefined/, tab);
      assert.doesNotMatch(
        controls(tree)
          .map((c) => c.label)
          .filter((label) => label !== '?')
          .join(' '),
        /\?/,
        tab,
      );
      assert.equal(byKey(tree, 'auto'), undefined, 'no on/off while unavailable');
    }
    const bare = draw({ adviceMs: Number.NaN }, surface);
    assert.doesNotMatch(texts(bare).join('\n'), /NaN|undefined/);
    assert.ok(texts(bare).includes('Jev ready'));
  });
}

test('the terminal shows the same warnings once, directly under the tab row, on every tab', () => {
  for (const tab of ['now', 'routes', 'policy', 'classifier', 'usage']) {
    const lines = texts(renderPanel(ELEMENTS, DEFAULTS, view({ ...WARNED, tab }), null, actions, { columns: 80 }));
    const at = (pattern) => lines.findIndex((t) => pattern.test(t));
    assert.equal(lines.filter((t) => /Ignored:/.test(t)).length, 1, tab);
    assert.equal(lines.filter((t) => /native fallback/.test(t)).length, 1, tab);
    assert.equal(lines.filter((t) => /keeping the model/.test(t)).length, 1, tab);
    assert.equal(at(/Ignored:/) + 1, at(/native fallback/), tab);
    assert.equal(at(/native fallback/) + 1, at(/keeping the model/), tab);
  }
  const tree = renderPanel(ELEMENTS, DEFAULTS, view({ ...WARNED, tab: 'usage' }), null, actions, { columns: 80 });
  assert.equal(byKey(tree, 'key').props.hotkey, 'k');
});

test('the Now tab keeps no warning inside NEXT TURN', () => {
  const lines = texts(renderPanel(ELEMENTS, DEFAULTS, view(WARNED), null, actions, { columns: 80 }));
  const next = lines.indexOf('NEXT TURN');
  assert.ok(next > 0);
  assert.doesNotMatch(lines.slice(next).join('\n'), /Ignored:|native fallback|keeping the model/);
});

for (const surface of SURFACES) {
  test(`${surface}: view.error is a warning in the notices slot while routing is available`, () => {
    const tree = draw({ error: 'router.json unreadable' }, surface);
    const slot = shell(tree)[2];
    assert.equal(slot.props.key, 'notices');
    const [line] = find(slot, (n) => n.type === 'Text');
    assert.match(line.props.children, /router\.json unreadable/);
    assert.equal(line.props.color, toneColor('warning', 'graphical'));
    // The unavailable pane says its reason once, not twice.
    const down = draw({ phase: 'unavailable', error: 'bad router.json' }, surface);
    assert.equal(texts(shell(down)[2]).filter((t) => /bad router\.json/.test(t)).length, 1);
  });
}

test('the terminal shows view.error once, in its header line, not in a slot', () => {
  const tree = renderPanel(ELEMENTS, DEFAULTS, view({ error: 'router.json unreadable' }), null, actions, {
    columns: 80,
  });
  assert.equal(texts(tree).filter((t) => /router\.json unreadable/.test(t)).length, 1);
});

test('the graphical painter draws section as a bordered card and keeps the shared methods', () => {
  const ui = paintersOf(ELEMENTS, 'desktop');
  const terminal = paintersOf(ELEMENTS, 'terminal');
  for (const name of Object.keys(terminal)) assert.ok(name in ui, name);
  assert.equal(terminal.section, undefined);
  for (const surface of ['mobile', 'vscode']) assert.equal(typeof paintersOf(ELEMENTS, surface).section, 'function');
  const card = ui.section('Next turn', { hint: 'why' }, [ui.text('body')]);
  assert.equal(card.props.borderStyle, 'round');
  assert.equal(card.props.flexDirection, 'column');
  assert.equal(card.props.padding, 'md');
  assert.equal(card.props.gap, 'sm');
  const title = find(card, (n) => n.type === 'Text' && n.props.children === 'Next turn')[0];
  assert.equal(title.props.size, 'footnote');
  assert.equal(title.props.weight, 'semibold');
  assert.equal(title.props.color, toneColor('muted', 'graphical'));
  assert.ok(texts(card).includes('why'));
  assert.ok(texts(card).includes('body'));
  assert.equal(texts(card).includes(' '), false);
  const action = ui.Button({ key: 'go', label: 'Go' });
  assert.ok(find(ui.section('X', { action }, []), (n) => n === action).length);
});

test('field sets a fixed label column and mono only for numbers', () => {
  const ui = paintersOf(ELEMENTS, 'desktop');
  const row = ui.field('Votes', ['3', 'rounds'], { help: 'how many agree' });
  const [label] = find(row, (n) => n.props.width !== undefined);
  assert.equal(typeof label.props.width, 'number');
  assert.equal(label.props.flexShrink, 0);
  const three = find(row, (n) => n.type === 'Text' && n.props.children === '3')[0];
  const word = find(row, (n) => n.type === 'Text' && n.props.children === 'rounds')[0];
  assert.equal(three.props.mono, true);
  assert.equal(word.props.mono, undefined);
  const help = find(row, (n) => n.type === 'Text' && n.props.children === 'how many agree')[0];
  assert.equal(help.props.size, 'footnote');
  assert.equal(help.props.color, toneColor('muted', 'graphical'));
  const dim = ui.field('Quiet', ['x'], { dim: true });
  assert.equal(find(dim, (n) => n.props.children === 'Quiet')[0].props.color, toneColor('muted', 'graphical'));
});

test('notice colours its words by tone and trims the terminal indent', () => {
  const ui = paintersOf(ELEMENTS, 'desktop');
  const action = ui.Button({ key: 'key', label: 'Set up' });
  const tree = ui.notice('warning', '  Ignored: x  ', action);
  const [words] = find(tree, (n) => n.type === 'Text');
  assert.equal(words.props.children, 'Ignored: x');
  assert.equal(words.props.color, toneColor('warning', 'graphical'));
  assert.ok(find(tree, (n) => n === action).length);
});

test('choice is a segmented row of Buttons, the selected one primary, each pressing onPick', () => {
  const ui = paintersOf(ELEMENTS, 'desktop');
  const picked = [];
  const options = [
    { value: 'auto', label: 'On', key: 'auto', hotkey: 'o' },
    { value: 'manual', label: 'Off' },
  ];
  const tree = ui.choice({ key: 'power', options, selected: 'manual', onPick: (v) => picked.push(v) });
  const buttons = controls(tree);
  assert.deepEqual(
    buttons.map((b) => [b.key, b.label, b.hotkey, b.variant]),
    [
      ['auto', 'On', 'o', 'secondary'],
      ['power-manual', 'Off', undefined, 'primary'],
    ],
  );
  buttons[0].onPress();
  assert.deepEqual(picked, ['auto']);
});

// The save bar, the help and the profile line are cards and tones on a graphical surface, never the terminal's lines.
const RAW = ['red', 'green', 'yellow', 'cyan', 'white', 'gray'];
const PROVIDER = { ...DEFAULTS, provider: 'deepseek' };
for (const surface of SURFACES) {
  test(`${surface}: the save bar is an Unsaved changes card with a table and Discard then Save`, () => {
    const tree = draw({ tab: 'routes', routeDraft: DRAFT }, surface);
    const bar = byKey(tree, 'save-bar');
    assert.ok(bar.props.gap, 'the bar has a gap');
    const words = texts(bar);
    assert.ok(words.includes('Unsaved changes'));
    assert.ok(words.includes('Micro route'), words.join(' | '));
    assert.ok(words.includes('Setting'));
    for (const word of words) {
      assert.doesNotMatch(word, /^[-+] |router\.json changes|^●|routes\.micro/, word);
      assert.notEqual(word, ' ');
    }
    const [discard, save] = controls(bar).filter((c) => /-routing$/.test(c.key));
    assert.deepEqual(
      [discard.key, discard.variant, discard.hotkey, save.key, save.variant, save.hotkey],
      ['discard-routing', 'secondary', 'd', 'save-routing', 'primary', 's'],
    );
    // Elsewhere the card says where the changes are listed instead of listing them.
    const now = byKey(draw({ tab: 'now', routeDraft: DRAFT }, surface), 'save-bar');
    assert.ok(texts(now).includes('Unsaved changes'));
    assert.ok(!texts(now).includes('Micro route'));
    assert.match(texts(now).join(' '), /listed on Routes and Policy/);
  });

  test(`${surface}: the last notice and Undo are a notice in a tone`, () => {
    const saved = byKey(
      draw({ notice: 'Saved: 1 routing change', lastWrite: { label: 'routes' } }, surface),
      'save-bar',
    );
    const [line] = find(saved, (n) => n.type === 'Text' && /^Saved/.test(n.props.children));
    assert.equal(line.props.children, 'Saved: 1 routing change');
    assert.equal(line.props.color, toneColor('success', 'graphical'));
    assert.equal(byKey(saved, 'undo').props.hotkey, 'u');
    const last = byKey(draw({ lastWrite: { label: 'classifier jev' } }, surface), 'save-bar');
    const [words] = find(last, (n) => n.type === 'Text' && /Last change/.test(n.props.children));
    assert.equal(words.props.children, 'Last change: classifier jev');
    assert.equal(words.props.color, toneColor('muted', 'graphical'));
  });

  test(`${surface}: help is an About the router card of sentences, the tiers as meters`, () => {
    const tree = draw({ help: true }, surface);
    const words = texts(tree);
    assert.ok(words.includes('About the router'));
    assert.ok(!words.includes('ABOUT THESE NUMBERS'));
    assert.ok(
      words.some((t) => /^No routing: your model on the main thread, .* Answer quality is not measured\.$/.test(t)),
    );
    const card = find(tree, (n) => n.props.borderStyle && texts(n).includes('About the router'))[0];
    for (const word of texts(card)) assert.doesNotMatch(word, /▂|▄|▆|█/, word);
    assert.equal(find(card, (n) => n.type === 'Svg').length, 4);
  });

  test(`${surface}: the profile line is a muted footnote`, () => {
    const tree = renderPanel(ELEMENTS, PROVIDER, view({ configPath: '/x/router.json' }), null, actions, {
      columns: 100,
      surface,
    });
    const [line] = find(tree, (n) => n.type === 'Text' && /^Profile/.test(n.props.children));
    assert.equal(line.props.children, 'Profile: DeepSeek · /x/router.json');
    assert.equal(line.props.size, 'footnote');
    assert.equal(line.props.color, toneColor('muted', 'graphical'));
  });

  test(`${surface}: no text on any tab is drawn in a raw terminal colour`, () => {
    for (const tab of ['now', 'routes', 'policy', 'classifier', 'usage'])
      for (const props of [
        { routeDraft: DRAFT, help: true, notice: 'Not saved: x', lastWrite: { label: 'y' } },
        WARNED,
      ]) {
        const tree = draw({ tab, ...props }, surface);
        for (const node of find(tree, (n) => n.type === 'Text'))
          assert.ok(!RAW.includes(node.props.color), `${tab}: ${node.props.color} on ${textOf(node)}`);
      }
  });
}

// Missing credentials are said once, in the notice with Set up; the title points to it instead of repeating it.
for (const surface of SURFACES) {
  test(`${surface}: missing classifier credentials are announced once`, () => {
    for (const tab of ['now', 'classifier']) {
      const tree = draw({ tab, error: 'missing-key', credentials: { jev: 'missing-key' } }, surface);
      const said = texts(tree).filter((t) => /no API key/.test(t));
      assert.equal(said.length, 1, `${tab}: ${said.join(' | ')}`);
      assert.match(said[0], /keeping the model/);
      const head = shell(tree)[0];
      assert.ok(texts(head).includes('Jev needs attention'), texts(head).join(' | '));
      const [dot] = find(head, (n) => n.type === 'Text' && n.props.children === '●');
      assert.equal(dot.props.color, toneColor('warning', 'graphical'));
    }
    // Another error is a notice too: the title points to it.
    const timed = draw({ error: 'timeout' }, surface);
    assert.equal(texts(timed).filter((t) => /timed out/.test(t)).length, 1);
    assert.ok(texts(shell(timed)[0]).includes('Jev needs attention'));
    // With routing off no notice says it, so the title keeps the whole state.
    const off = draw({ mode: 'manual', error: 'missing-key', credentials: { jev: 'missing-key' } }, surface);
    assert.ok(
      texts(shell(off)[0]).some((t) => /^Jev: no API key/.test(t)),
      texts(shell(off)[0]).join(' | '),
    );
  });

  test(`${surface}: on the Classifier tab the notice leaves Set up and k to the active card`, () => {
    const tree = draw({ ...WARNED, tab: 'classifier' }, surface);
    const slot = byKey(tree, 'notices');
    assert.equal(controls(slot).length, 0);
    assert.match(texts(slot).join(' '), /keeping the model/);
    const owners = controls(tree).filter((c) => c.hotkey === 'k');
    assert.deepEqual(
      owners.map((c) => c.key),
      ['key-jev'],
    );
  });
}
