import assert from 'node:assert/strict';
import test from 'node:test';
import { readDecisions } from '../lib/decisions.mjs';
import { replayAuto, replayTable } from '../lib/replay.mjs';
import { TRACE_PREFIX, traceLoop } from '../lib/replay-trace.mjs';
import { answering, drain, harness, JEV_KEY, step } from './harness.mjs';
import { jevResponse } from './helpers.mjs';

const PATH = '/fixture/team/deepseek-router.json';
const MODEL = 'deepseek-flash[1m]';
const native = { ...step, model: MODEL, effort: 'low' };
const command = (h, args) => h.event('command.run', { command: 'router', args });
const reload = (h) => h.event('session.start', { cwd: '/fixture' });
function fixture(routingEngine = 'auto', extra = {}) {
  const h = harness(JEV_KEY);
  h.env.set('CLAUDE_ROUTER_PROVIDER', 'deepseek');
  h.model(MODEL);
  h.files.set(
    PATH,
    JSON.stringify({
      routingEngine,
      mode: 'quality',
      baselineTier: 'low',
      models: { flash: { capability: { low: 1, high: 2, max: 3 } } },
      routes: { low: { model: 'flash', effort: 'low' } },
      policy: { reviewEveryRequests: 0 },
      ...extra,
    }),
  );
  answering(h, jevResponse('low', { low: 1 }));
  return h;
}
function patch(h, change) {
  const cfg = JSON.parse(h.files.get(PATH));
  change(cfg);
  h.files.set(PATH, JSON.stringify(cfg));
}
async function turn(h, turnId, extra = {}) {
  await h.event('turn.start', { turnId, text: 'Synthetic task' });
  await drain(h.step({ ...native, turnId, ...extra }));
  await h.event('turn.complete', { turnId });
}
function newModule(h) {
  const next = harness(JEV_KEY, h.preferences, h.state);
  for (const [path, content] of h.files) next.files.set(path, content);
  next.env.set('CLAUDE_ROUTER_PROVIDER', 'deepseek');
  next.model(MODEL);
  answering(next, jevResponse('low', { low: 1 }));
  return next;
}

test('first quality startup at zero and one has distinct persisted decision and replay reasons', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-17T10:00:00Z') });
  for (const raw of [0, 1]) {
    const runs = [];
    for (const engine of ['shadow', 'auto']) {
      const h = fixture(engine, {
        baselineTier: raw ? 'low' : 'micro',
        models: { flash: { capability: { low: raw, high: 2, max: 3 } } },
      });
      answering(h, jevResponse(raw ? 'low' : 'micro', { [raw ? 'low' : 'micro']: 1 }));
      await reload(h);
      await turn(h, 'first');
      if (engine === 'auto') {
        assert.equal(h.loop().decision.reason, 'startup');
        assert.equal(h.loop().auto.state.routeCause, 'startup');
        assert.equal(h.loop().auto.state.routedDemand, raw);
        assert.equal(h.loop().decision.auto.requirement, raw + 0.5);
        const rows = readDecisions(h.preferences.get('decisions:v1:s1')).rows;
        const row = rows.find((row) => row.kind === 'start');
        assert.equal(row.reason, 'startup');
        assert.equal(row.auto.move, 'startup');
        assert.equal(row.mode, 'quality');
        assert.deepEqual(h.view().routingMode, { mode: 'quality', source: 'profile' });
        assert.equal(row.origin, 'unknown');
      }
      runs.push(h);
    }
    const record = runs[0].preferences.get(`${TRACE_PREFIX}s1`);
    assert.deepEqual(record.events[0].config.routingMode, { mode: 'quality', source: 'profile' });
    const table = replayTable(record);
    assert.deepEqual(table.mismatches, []);
    const rows = replayAuto(record, table.rows);
    assert.equal(rows[0].reason, 'startup');
    assert.equal(rows[0].mode, 'quality');
    assert.equal(rows[0].demand, raw);
    assert.deepEqual(rows[0].pair, { model: runs[1].requests[0].model, effort: runs[1].requests[0].effort });
  }
});

test('manual prefix preserves first startup but off/on after routing cannot reuse it, live and replay', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-17T10:00:00Z') });
  for (const engine of ['shadow', 'auto']) {
    const h = fixture(engine);
    await reload(h);
    for (const [id, enabled] of [
      ['prefix', false],
      ['first', true],
      ['off', false],
      ['again', true],
    ]) {
      await command(h, enabled ? 'on' : 'off');
      await turn(h, id);
      if (id === 'prefix') {
        assert.equal(h.loop().hasRoutedDecision, false);
        assert.equal(h.loop().requests, 1);
        assert.ok(h.loop().lastRequest);
        assert.ok(h.loop().switchedAt);
      }
      if (engine === 'auto' && id === 'first') assert.equal(h.loop().decision.reason, 'startup');
      if (engine === 'auto' && id === 'again') assert.equal(h.loop().decision.reason, 'no-evidence');
    }
    assert.equal(h.loop().hasRoutedDecision, true);
    if (engine === 'auto')
      assert.deepEqual(
        h.requests.map((r) => r.effort),
        ['low', 'high', 'low', 'low'],
      );
    else {
      const record = h.preferences.get(`${TRACE_PREFIX}s1`);
      const table = replayTable(record);
      assert.deepEqual(table.mismatches, []);
      const rows = replayAuto(record, table.rows);
      assert.deepEqual(
        rows.map((r) => r.pair.effort),
        ['low', 'high', 'low', 'low'],
      );
      assert.equal(rows[1].reason, 'startup');
      assert.equal(rows[3].reason, 'no-evidence');
    }
  }
});

test('pin first consumes privilege even with untouched demand state across module reload and compaction', async () => {
  for (const boundary of ['none', 'reload', 'compact', 'shrink']) {
    let h = fixture();
    await reload(h);
    await command(h, 'pin low');
    await turn(h, 'pin', { messageCount: 5 });
    assert.equal(h.loop().auto.state.turn, 0);
    assert.equal(h.loop().decision.reason, 'pinned');
    assert.equal(h.requests[0].effort, 'low');
    if (boundary === 'reload') h = newModule(h);
    if (boundary === 'compact') await h.event('session.compact', { trigger: 'manual' });
    await turn(h, 'next', { messageCount: boundary === 'shrink' ? 1 : 5 });
    assert.equal(h.requests.at(-1).effort, 'low', boundary);
    assert.equal(h.loop().decision.reason, 'no-evidence', boundary);
    assert.equal(h.loop().hasRoutedDecision, true);
    assert.notEqual(h.loop().auto.state.routeCause, 'startup');
  }
});

test('prior table routing consumes privilege before engine resets, including unmarked persisted history', async () => {
  for (const legacy of [false, true]) {
    const h = fixture('table');
    await reload(h);
    await turn(h, 'table');
    if (legacy) {
      const stored = structuredClone(h.state.get('loops:main'));
      delete stored.value.hasRoutedDecision;
      h.state.set('loops:main', stored);
    }
    await command(h, 'off');
    await turn(h, 'manual');
    patch(h, (cfg) => {
      cfg.routingEngine = 'auto';
    });
    await reload(h);
    await command(h, 'on');
    await turn(h, 'auto');
    assert.equal(h.requests.at(-1).effort, 'low');
    assert.equal(h.loop().decision.reason, 'no-evidence');
    patch(h, (cfg) => {
      cfg.routingEngine = 'table';
    });
    await reload(h);
    await turn(h, 'table-again');
    patch(h, (cfg) => {
      cfg.routingEngine = 'auto';
    });
    await reload(h);
    await turn(h, 'auto-again');
    assert.equal(h.loop().decision.reason, 'no-evidence');
    assert.equal(h.loop().hasRoutedDecision, true);
  }
});

test('valid persisted auto state and unknown first incumbent never manufacture startup after Mod reload', async () => {
  let h = fixture('auto', { models: { flash: { capability: { high: 2, max: 3 } } } });
  await reload(h);
  await turn(h, 'unknown');
  assert.equal(h.loop().decision.reason, 'no-evidence');
  const prior = structuredClone(h.loop().auto.state);
  h = newModule(h);
  await turn(h, 'reloaded');
  assert.equal(h.loop().decision.reason, 'no-evidence');
  assert.equal(h.loop().auto.state.turn, prior.turn + 1);
  assert.equal(h.loop().auto.state.routeCause, prior.routeCause);
  assert.equal(h.loop().hasRoutedDecision, true);
});

test('clear creates a new eligible history; compaction does not, live and replay', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-17T10:00:00Z') });
  for (const engine of ['shadow', 'auto']) {
    const h = fixture(engine);
    for (const sessionId of ['s1', 's2']) {
      if (sessionId === 's2') {
        await h.event('session.end', { reason: 'clear', sessionId: 's1' });
        h.clear('s2');
      }
      await reload(h);
      await command(h, 'pin low');
      await turn(h, 'pin');
      await h.event('session.compact', { trigger: 'manual' });
      await turn(h, 'after-compact');
      if (engine === 'auto') assert.equal(h.loop().decision.reason, 'no-evidence');
      else {
        const record = h.preferences.get(`${TRACE_PREFIX}${sessionId}`);
        const table = replayTable(record);
        assert.deepEqual(table.mismatches, []);
        assert.equal(replayAuto(record, table.rows).at(-1).reason, 'no-evidence');
      }
    }
    await h.event('session.end', { reason: 'clear', sessionId: 's2' });
    h.clear('s3');
    await reload(h);
    await turn(h, 'clear-first');
    if (engine === 'auto') assert.equal(h.loop().decision.reason, 'startup');
    else {
      const record = h.preferences.get(`${TRACE_PREFIX}s3`);
      const table = replayTable(record);
      assert.deepEqual(table.mismatches, []);
      assert.equal(replayAuto(record, table.rows)[0].reason, 'startup');
    }
  }
});

test('real mode and catalog edits before or during pins remain explicit choices in live auto and replay', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-17T10:00:00Z') });
  for (const edit of ['mode', 'catalog']) {
    for (const timing of ['before', 'during']) {
      for (const engine of ['shadow', 'auto']) {
        const h = fixture(
          engine,
          edit === 'mode' ? { mode: 'balanced' } : { models: { flash: { capability: { low: 1, high: 1, max: 1 } } } },
        );
        await reload(h);
        await turn(h, 'accepted');
        const change = async () => {
          if (edit === 'mode') await command(h, 'mode quality');
          else {
            patch(h, (cfg) => {
              cfg.models.flash.capability.high = 2;
            });
            await reload(h);
          }
        };
        if (timing === 'before') await change();
        await command(h, 'pin low');
        await turn(h, 'pin');
        if (timing === 'during') await change();
        await turn(h, 'unpinned');
        if (engine === 'auto') {
          assert.equal(h.loop().decision.reason, 'explicit-up', `${edit}/${timing}`);
          assert.equal(h.loop().auto.state.routeCause, edit);
          assert.equal(h.requests.at(-1).effort, 'high');
        } else {
          const record = h.preferences.get(`${TRACE_PREFIX}s1`);
          const table = replayTable(record);
          if (edit === 'mode') {
            assert.deepEqual(table.mismatches, [], `${edit}/${timing}`);
            const rows = replayAuto(record, table.rows);
            assert.equal(rows.at(-1).reason, 'explicit-up', `${edit}/${timing}`);
            assert.equal(rows.at(-1).pair.effort, 'high');
          } else assert.ok(record.incomplete.includes('reload'));
        }
      }
    }
  }
});

test('first cap-zero low .57 uses startup mass one but fresh micro .95 still stays, live and replay', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-17T10:00:00Z') });
  for (const micro of [false, true]) {
    for (const engine of ['shadow', 'auto']) {
      const h = fixture(engine, {
        mode: 'balanced',
        models: { flash: { capability: { low: 0, high: 2, max: 3 } } },
      });
      answering(
        h,
        micro ? jevResponse('micro', { micro: 0.95, low: 0.05 }) : jevResponse('low', { micro: 0.43, low: 0.57 }),
      );
      await reload(h);
      await turn(h, 'first');
      if (engine === 'auto') {
        assert.equal(h.loop().decision.reason, micro ? 'same-route' : 'startup');
        assert.equal(h.loop().auto.state.demand, micro ? 0 : 1);
        assert.equal(h.loop().auto.state.routedDemand, micro ? 0 : 1);
        assert.equal(h.requests.at(-1).effort, micro ? 'low' : 'high');
      } else {
        const record = h.preferences.get(`${TRACE_PREFIX}s1`);
        const table = replayTable(record);
        assert.deepEqual(table.mismatches, []);
        const rows = replayAuto(record, table.rows);
        assert.equal(rows[0].reason, micro ? 'same-route' : 'startup');
        assert.equal(rows[0].pair.effort, micro ? 'low' : 'high');
      }
    }
  }
});

test('tax or cash blocks consume the only startup chance without a second-turn retry, live and replay', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-17T10:00:00Z') });
  for (const gate of ['tax', 'cash']) {
    for (const engine of ['shadow', 'auto']) {
      const h = fixture(engine, {
        cache: {
          mode: 'explicit',
          effortScope: 'separate',
          writeMultiplier: { '5m': 1.25, '1h': 2 },
          ttlMs: { '5m': 300000, '1h': 3600000 },
        },
        policy: { reviewEveryRequests: 0, ...(gate === 'tax' ? { upgradeBase: 1 } : { cashCapUsd: 0 }) },
      });
      await reload(h);
      await turn(h, 'blocked');
      if (engine === 'auto') {
        assert.equal(h.loop().decision.reason, gate === 'tax' ? 'upgrade-pending' : 'no-route-native');
        assert.equal(h.loop().hasRoutedDecision, true);
        assert.equal(h.requests[0].effort, 'low');
      }
      await turn(h, 'second');
      if (engine === 'auto') {
        assert.equal(h.loop().decision.reason, gate === 'tax' ? 'no-evidence' : 'same-route');
        assert.equal(h.requests.at(-1).effort, 'low');
      } else {
        const record = h.preferences.get(`${TRACE_PREFIX}s1`);
        const table = replayTable(record);
        assert.deepEqual(table.mismatches, []);
        const rows = replayAuto(record, table.rows);
        assert.equal(rows[0].reason, gate === 'tax' ? 'upgrade-pending' : 'no-route-native');
        assert.equal(rows[1].reason, gate === 'tax' ? 'no-evidence' : 'same-route');
        assert.deepEqual(
          rows.map((r) => r.pair.effort),
          ['low', 'low'],
        );
      }
    }
  }
});

test('a rejected decision CAS does not consume first-routed eligibility', async () => {
  const h = fixture();
  await reload(h);
  const set = h.$.state.set;
  let rejected = false;
  h.$.state.set = async (ref, value, options) => {
    if (ref.key === 'loops' && value.hasRoutedDecision && !rejected) {
      rejected = true;
      return { isSet: false, version: 0 };
    }
    return set(ref, value, options);
  };
  await turn(h, 'stale');
  assert.equal(rejected, true);
  assert.equal(h.loop().hasRoutedDecision, false);
  assert.equal(h.requests[0].effort, 'low');
  await turn(h, 'accepted');
  assert.equal(h.loop().hasRoutedDecision, true);
  assert.equal(h.loop().decision.reason, 'startup');
});

test('legacy off-only request history conservatively consumes eligibility on auto entry', async () => {
  const h = fixture();
  await reload(h);
  await command(h, 'off');
  await turn(h, 'prefix');
  const stored = structuredClone(h.state.get('loops:main'));
  assert.equal(stored.value.hasRoutedDecision, false);
  delete stored.value.hasRoutedDecision;
  h.state.set('loops:main', stored);
  await command(h, 'on');
  await turn(h, 'legacy');
  assert.equal(h.requests.at(-1).effort, 'low');
  assert.equal(h.loop().decision.reason, 'no-evidence');
  assert.equal(h.loop().hasRoutedDecision, true);
});

test('trace loop preserves explicit routed-history marker and does not invent freshness for legacy histories', () => {
  for (const hasRoutedDecision of [false, true]) {
    assert.equal(traceLoop({ hasRoutedDecision }).hasRoutedDecision, hasRoutedDecision);
  }
  assert.equal(traceLoop({ requests: 2 }).hasRoutedDecision, undefined);
});
