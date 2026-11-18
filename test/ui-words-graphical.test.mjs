// A card's words are decided in the models: the graphical renderers hold no wording and no capitalising, tier names
// and routing modes are labels with a capital, and no card names a hotkey or a router.json key.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';

process.env.TZ = 'UTC';

const { DEFAULTS, TIERS } = await import('../lib/config.mjs');
const { renderPanel } = await import('../lib/panel.mjs');
const { routeDraftOf } = await import('../lib/ui/model/draft.mjs');
const { CLAUDE, ROUTED } = await import('./band-states.mjs');
const { byKey, ELEMENTS, find, quiet, texts } = await import('./harness.mjs');
const { NOW, SESSION, STORE } = await import('./usage-fixtures.mjs');

const SURFACES = ['desktop', 'vscode', 'mobile'];
const VIEW = { ...ROUTED, credentials: { jev: null }, usageSession: SESSION, usageStore: STORE };
const draw = (props, surface) =>
  renderPanel(ELEMENTS, DEFAULTS, { ...VIEW, ...props }, CLAUDE, quiet, { columns: 100, now: NOW, surface });
const GRAPHICAL = new URL('../lib/ui/graphical/', import.meta.url);

test('the graphical renderers neither capitalise nor hold the wording the models decide', () => {
  for (const file of readdirSync(GRAPHICAL)) {
    const source = readFileSync(new URL(file, GRAPHICAL), 'utf8');
    assert.doesNotMatch(source, /\bsentence\(|const sentence\b/, file);
    assert.doesNotMatch(source, /savingsTone|No routed turn yet|No routed replies yet|No priced replies/, file);
  }
});

for (const surface of SURFACES) {
  test(`${surface}: Next turn's pin line names no hotkey`, () => {
    const off = texts(draw({ tab: 'now', mode: 'manual', phase: 'manual' }, surface));
    assert.ok(off.includes('Pinning needs routing on'), off.join(' | '));
    assert.ok(!off.some((t) => /\(o\)/.test(t)));
    const down = texts(draw({ tab: 'now', phase: 'unavailable', error: 'bad router.json' }, surface));
    assert.ok(down.includes('Pinning needs routing'));
  });

  test(`${surface}: the Subagents hint says subagent routing in words`, () => {
    const words = texts(draw({ tab: 'usage' }, surface)).join('\n');
    assert.match(words, /Subagent routing is on/);
    assert.doesNotMatch(words, /subagent routing on/);
  });

  test(`${surface}: tiers and activity routing modes are labels with a capital`, () => {
    const routes = draw({ tab: 'routes' }, surface);
    const head = texts(byKey(routes, 'grid-head'));
    for (const tier of TIERS) assert.ok(head.includes(tier[0].toUpperCase() + tier.slice(1)), tier);
    const mode = byKey(routes, 'activity-mode');
    assert.deepEqual(mode.props.options, [
      { value: 'off', label: 'Off' },
      { value: 'on', label: 'On' },
    ]);
    const usage = draw({ tab: 'usage', usageGroup: 'tier', usagePeriod: 'all' }, surface);
    const named = texts(usage);
    assert.ok(
      TIERS.some((tier) => named.includes(tier[0].toUpperCase() + tier.slice(1))),
      named.join(' | '),
    );
    for (const tier of TIERS)
      assert.equal(find(usage, (n) => n.type === 'Text' && n.props.children === tier).length, 0, tier);
  });
}

for (const surface of SURFACES) {
  test(`${surface}: a routing mode and a default tier read as labels`, () => {
    const now = texts(draw({ tab: 'now', routingMode: { mode: 'cost', source: 'session' } }, surface)).join('\n');
    assert.match(now, /Cost mode from session/);
    assert.doesNotMatch(now, /cost mode/);
    const draft = { ...routeDraftOf(DEFAULTS, {}), baselineTier: 'micro' };
    const policy = texts(draw({ tab: 'policy', routeDraft: draft }, surface));
    assert.ok(
      policy.includes(`Default ${DEFAULTS.baselineTier[0].toUpperCase()}${DEFAULTS.baselineTier.slice(1)}`),
      policy.join(' | '),
    );
  });
}

// The renderers draw a model; they never read the config or the raw view. The band takes both only to hand them to the
// band model, and reads the one flag that picks its second row.
test('the graphical renderers read neither the config nor the view', () => {
  for (const file of readdirSync(GRAPHICAL)) {
    const source = readFileSync(new URL(file, GRAPHICAL), 'utf8')
      .replace(/^import .*$/gm, (line) => line.replace(/config\.mjs/, ''))
      .replace(/^\s*\/\/.*$/gm, '');
    if (file === 'band.mjs') {
      assert.deepEqual(
        [...source.matchAll(/\bview\.(\w+)/g)].map((m) => m[1]),
        ['bandDetail', 'bandDetail'],
        file,
      );
      assert.doesNotMatch(source, /\bconfig\.\w/, file);
      continue;
    }
    assert.doesNotMatch(source, /\b(config|view)\b/, file);
  }
});
