import assert from 'node:assert/strict';
import test from 'node:test';
import { emptyStore, STORE_KEY, STORE_PREFIX } from '../lib/activity-stats.mjs';
import { readUsage, summarize } from '../lib/usage.mjs';
import {
  band,
  CLEF_FLASH_ANSWER,
  CLOUDFLARE_KEYS,
  CONFIG,
  controls,
  drain,
  harness,
  press,
  projectPatch,
  start,
  step,
  TINY_ROUTER,
  texts,
} from './harness.mjs';
import { jevResponse, savedCounts, sessionOf } from './helpers.mjs';

test('clear discards unsaved tuning and preserves active configuration', async () => {
  const h = harness();
  await start(h);
  await press(h, 'tab-routes');
  await press(h, 'tab-policy');
  await press(h, 'horizon', '10');
  assert.equal(h.view().tuning.horizon, 10);
  await h.event('session.end', { reason: 'clear' });
  h.clear();
  await drain(h.step({ ...step, turnId: 't2' }));
  assert.equal(h.view().tuning, null);
  await press(h, 'tab-policy');
  assert.equal(controls(await h.render()).find((node) => node.key === 'horizon').value, '5');
});

test('saved tuning cannot change a classification already in progress', async () => {
  const h = harness({ typesafe_api_key: 'synthetic-key' });
  let resolve;
  h.http(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  await start(h);
  const pending = drain(h.step(step));
  for (let i = 0; i < 100 && !resolve; i += 1) await Promise.resolve();
  assert.ok(resolve);
  await press(h, 'tab-routes');
  await press(h, 'tab-policy');
  await press(h, 'downgradeVotes', '1');
  await press(h, 'save-routing');
  resolve({
    status: 200,
    ok: true,
    headers: {},
    text: JSON.stringify({
      answers: {
        route: {
          type: 'choice',
          choice: 'micro',
          confidence: 0.999,
          probabilities: { micro: 0.999, low: 0.001, medium: 0, high: 0 },
        },
        continuation: { type: 'noul', noul: 0 },
      },
    }),
  });
  await pending;
  assert.equal(h.requests[0].model, step.model);
  assert.equal(h.view().probabilities.micro, 0.999);
  await press(h, 'tab-now');
  assert.ok(texts(await h.render()).some((line) => /100%/.test(line)));
});

test('a saved route edit writes a project override and routes the next turn', async () => {
  const h = harness();
  await start(h);
  await press(h, 'tab-routes');
  await press(h, 'tab-routes');
  await press(h, 'cell-tier-medium');
  await press(h, 'route-medium-model', 'sonnet');
  await press(h, 'tab-routes');
  await press(h, 'cell-tier-medium');
  await press(h, 'route-medium-effort', 'xhigh');
  assert.ok(texts(await h.render()).some((line) => /\+ routes\.medium\s+Sonnet 5\.5 · xhigh/.test(line)));
  await press(h, 'save-routing');
  assert.deepEqual(projectPatch(h), { routes: { medium: { model: 'sonnet', effort: 'xhigh' } } });
  assert.equal(h.view().routeDraft, null);
  assert.match(h.view().notice, /^Saved: routing changes\. Applies from the next turn in this project\.$/);
  await h.event('turn.start', { turnId: 't2', text: 'Next.' });
  await h.event('command.run', { command: 'router', args: 'pin medium' });
  await drain(h.step({ ...step, turnId: 't2' }));
  assert.deepEqual([h.requests[0].model, h.requests[0].effort], ['claude-sonnet-5-5', 'xhigh']);
});

test('session effort on a tier sends the effort Claude Code asked for', async () => {
  const h = harness();
  await start(h);
  await press(h, 'tab-routes');
  await press(h, 'tab-routes');
  await press(h, 'cell-tier-high');
  await press(h, 'route-high-effort', 'session');
  await press(h, 'save-routing');
  assert.deepEqual(projectPatch(h).routes.high, { effort: null });
  await h.event('turn.start', { turnId: 't2', text: 'Next.' });
  await h.event('command.run', { command: 'router', args: 'pin high' });
  await drain(h.step({ ...step, turnId: 't2', effort: 'low' }));
  assert.deepEqual([h.requests[0].model, h.requests[0].effort], ['claude-opus-5-5', 'low']);
});

test('clearing saved tier overrides inherits profile routes and keeps other preferences', async () => {
  const h = harness();
  const profile = { routes: { low: { model: 'opus' } } };
  h.files.set(CONFIG, JSON.stringify(profile));
  await start(h);
  await press(h, 'tab-classifier');
  await press(h, 'timeoutMs', '500');
  await press(h, 'tab-routes');
  await press(h, 'cell-tier-low');
  await press(h, 'route-low-model', 'haiku');
  await press(h, 'save-routing');
  assert.equal(projectPatch(h).routes.low.model, 'haiku');
  await press(h, 'reset-routes');
  assert.deepEqual(projectPatch(h), { classifiers: { jev: { timeoutMs: 500 } } });
  assert.equal(controls(await h.render()).find((node) => node.key === 'route-low-model').value, 'opus');
  assert.deepEqual(JSON.parse(h.files.get(CONFIG)), profile);
  await press(h, 'undo');
  assert.equal(projectPatch(h).routes.low.model, 'haiku');
});

test('a model without effort levels has no effort control and drops the chosen effort', async () => {
  const h = harness();
  h.files.set(CONFIG, TINY_ROUTER);
  await start(h);
  await press(h, 'tab-routes');
  await press(h, 'cell-tier-micro');
  assert.equal(
    controls(await h.render()).find((node) => node.key === 'route-micro-effort'),
    undefined,
  );
  await press(h, 'tab-routes');
  await press(h, 'cell-tier-high');
  await press(h, 'route-high-model', 'tiny');
  assert.deepEqual(h.view().routeDraft.routes.high, { model: 'tiny', effort: null });
  assert.equal(
    controls(await h.render()).find((node) => node.key === 'route-high-effort'),
    undefined,
  );
});

test('model choices follow the availableModels allowlist', async () => {
  const h = harness();
  h.settings({ availableModels: ['sonnet'] });
  await start(h);
  await press(h, 'tab-routes');
  await press(h, 'cell-tier-low');
  const select = controls(await h.render()).find((node) => node.key === 'route-low-model');
  assert.deepEqual(
    select.options.map((option) => option.value),
    ['haiku', 'sonnet'],
  );
});

test('a symlinked profile is never written when the pane saves and undoes its own store patch', async () => {
  const h = harness();
  h.files.set(CONFIG, '{}');
  h.links.add(CONFIG);
  await start(h);
  await press(h, 'tab-policy');
  await press(h, 'horizon', '10');
  await press(h, 'save-routing');
  assert.deepEqual(projectPatch(h), { policy: { downgradeHorizonTurns: 10 } });
  await press(h, 'undo');
  assert.deepEqual(projectPatch(h), {});
  assert.equal(h.files.get(CONFIG), '{}');
});

test('a tuning save writes only the changed value and keeps a hand-edited profile byte-for-byte', async () => {
  const h = harness();
  await start(h);
  const edited = '{ "classifiers": { "jev": { "timeoutMs": 900 } } }';
  h.files.set(CONFIG, edited);
  await press(h, 'tab-policy');
  await press(h, 'horizon', '10');
  await press(h, 'save-routing');
  assert.deepEqual(projectPatch(h), { policy: { downgradeHorizonTurns: 10 } });
  assert.equal(h.files.get(CONFIG), edited);
});

test('the activity threshold is a policy draft: Save can override with a built-in value, and Undo', async () => {
  const h = harness({ typesafe_api_key: 'synthetic-key' });
  const LOW = { micro: 0, low: 0.95, medium: 0.05, high: 0, uncertain: 0 };
  h.http(async () => ({
    ok: true,
    status: 200,
    headers: {},
    text: JSON.stringify(jevResponse('low', LOW, 0, { code: 0.79, ops: 0.21 })),
  }));
  await h.event('session.start', { cwd: '/fixture' });
  await press(h, 'tab-policy');
  const threshold = controls(await h.render()).find((c) => c.key === 'activityMass');
  assert.deepEqual(
    threshold.options.map((o) => o.label),
    ['50%', '60%', '70%', '80%'],
  );
  assert.equal(threshold.value, '0.6');
  await press(h, 'tab-policy');
  await press(h, 'activityMass', '0.8');
  assert.equal(h.files.get(CONFIG), undefined);
  const lines = texts(await h.render());
  const at = lines.indexOf('Project routing changes:');
  assert.deepEqual(lines.slice(at + 1, at + 3), [
    '- policy.activityMass            60%',
    '+ policy.activityMass            80%',
  ]);
  await press(h, 'save-routing');
  assert.deepEqual(projectPatch(h), { policy: { activityMass: 0.8 } });
  // A code reading of 79% clears the upgrade bar but not the new threshold: the tier route runs, not the code override.
  await h.event('turn.start', { turnId: 't1', text: 'One edit.' });
  await drain(h.step(step));
  assert.deepEqual([h.requests[0].model, h.requests[0].effort], ['claude-haiku-5-5', 'high']);
  await press(h, 'tab-policy');
  await press(h, 'activityMass', '0.6');
  await press(h, 'save-routing');
  assert.deepEqual(projectPatch(h), { policy: { activityMass: 0.6 } });
  await press(h, 'undo');
  assert.deepEqual(projectPatch(h), { policy: { activityMass: 0.8 } });
});

test('one routing save writes sparse routes and policy together', async () => {
  const h = harness();
  await start(h);
  await press(h, 'tab-routes');
  await press(h, 'cell-tier-micro');
  await press(h, 'route-micro-model', 'sonnet');
  await press(h, 'tab-policy');
  await press(h, 'horizon', '10');
  await press(h, 'save-routing');
  assert.deepEqual(projectPatch(h), {
    routes: { micro: { model: 'sonnet' } },
    policy: { downgradeHorizonTurns: 10 },
  });
});

test('Undo changes the project preference only, keeping a hand-edit made since Save', async () => {
  const h = harness();
  await start(h);
  await press(h, 'tab-policy');
  await press(h, 'horizon', '10');
  await press(h, 'save-routing');
  h.files.set(CONFIG, '{ "classifier": "clef" }');
  await press(h, 'tab-usage');
  await press(h, 'undo');
  assert.deepEqual(projectPatch(h), {});
  assert.equal(h.files.get(CONFIG), '{ "classifier": "clef" }');
  assert.equal(h.view().lastWrite, null);
});

test('the deadline has Undo too', async () => {
  const h = harness();
  await start(h);
  await press(h, 'tab-classifier');
  await press(h, 'timeoutMs', '500');
  assert.deepEqual(projectPatch(h), { classifiers: { jev: { timeoutMs: 500 } } });
  await press(h, 'undo');
  assert.deepEqual(projectPatch(h), {});
});

test('after an Undo, a pending draft compares against the restored values, so picking an undone value again saves', async () => {
  const h = harness();
  await start(h);
  await press(h, 'tab-routes');
  await press(h, 'tab-policy');
  await press(h, 'cashCapUsd', '5');
  await press(h, 'tab-routes');
  await press(h, 'cell-tier-high');
  await press(h, 'route-high-model', 'sonnet');
  await press(h, 'save-routing');
  await press(h, 'tab-policy');
  await press(h, 'downgradeVotes', '3');
  await press(h, 'tab-routes');
  await press(h, 'cell-tier-micro');
  await press(h, 'route-micro-model', 'sonnet');
  await press(h, 'undo');
  assert.deepEqual(projectPatch(h), {});
  await press(h, 'cell-tier-high');
  assert.equal(controls(await h.render()).find((node) => node.key === 'route-high-model').value, 'opus');
  await press(h, 'tab-policy');
  await press(h, 'cashCapUsd', '5');
  await press(h, 'tab-routes');
  await press(h, 'cell-tier-high');
  await press(h, 'route-high-model', 'sonnet');
  await press(h, 'save-routing');
  assert.deepEqual(projectPatch(h), {
    routes: { micro: { model: 'sonnet' }, high: { model: 'sonnet' } },
    policy: { downgradeVotes: 3, cashCapUsd: 5 },
  });
});

test('the pane opens without the last notice and keeps Undo for the last write', async () => {
  const h = harness();
  await start(h);
  await press(h, 'tab-classifier');
  await press(h, 'timeoutMs', '500');
  assert.match(h.view().notice, /^Saved:/);
  await h.event('command.run', { command: 'router', args: '' });
  assert.equal(h.view().notice, null);
  const pane = await h.render();
  assert.ok(texts(pane).some((line) => /^Last change: Jev deadline 1500 → 500 ms/.test(line)));
  assert.ok(controls(pane).some((node) => node.key === 'undo'));
});

test('clearing saved policy overrides immediately inherits hand-edited values', async () => {
  const h = harness();
  h.files.set(CONFIG, '{"policy":{"downgradeVotes":3,"cashCapUsd":5}}');
  await start(h);
  await press(h, 'tab-policy');
  await press(h, 'downgradeVotes', '2');
  await press(h, 'save-routing');
  assert.deepEqual(projectPatch(h), { policy: { downgradeVotes: 2 } });
  await press(h, 'reset-policy');
  assert.deepEqual(projectPatch(h), {});
  assert.equal(controls(await h.render()).find((node) => node.key === 'downgradeVotes').value, '3');
  assert.equal(h.files.get(CONFIG), '{"policy":{"downgradeVotes":3,"cashCapUsd":5}}');
});

test('an unsaved routing draft shows on every tab, Discard drops it, and a new session clears it', async () => {
  const h = harness();
  await start(h);
  await press(h, 'tab-routes');
  await press(h, 'tab-routes');
  await press(h, 'cell-tier-medium');
  await press(h, 'route-medium-model', 'sonnet');
  await press(h, 'tab-classifier');
  let pane = await h.render();
  assert.equal(controls(pane).find((node) => node.key === 'tab-routes').label, '2 Routes ●');
  assert.ok(texts(pane).includes('● 1 unsaved routing change  '));
  assert.ok(controls(pane).some((node) => node.key === 'save-routing'));
  await press(h, 'discard-routing');
  pane = await h.render();
  assert.equal(controls(pane).find((node) => node.key === 'tab-routes').label, '2 Routes');
  assert.equal(
    controls(pane).find((node) => node.key === 'save-routing'),
    undefined,
  );
  await press(h, 'tab-routes');
  await press(h, 'tab-policy');
  await press(h, 'baseline', 'medium');
  await h.event('session.start', { cwd: '/fixture' });
  assert.equal(h.view().routeDraft, null);
});

test('Manual mode shows no pin dropdown', async () => {
  const h = harness();
  await start(h);
  assert.ok(controls(await h.render()).some((node) => node.key === 'pin'));
  await press(h, 'manual');
  const pane = await h.render();
  assert.ok(!controls(pane).some((node) => node.key === 'pin'));
  assert.ok(texts(pane).includes('needs routing on (o)'));
});

test('a classifier row switches at once, Undo from any tab returns to the previous one, and a switch clears the old health', async () => {
  const h = harness({ typesafe_api_key: 'synthetic-key', ...CLOUDFLARE_KEYS });
  h.http(async () => ({ ok: false, status: 401, text: '', headers: {} }));
  await start(h);
  await drain(h.step(step));
  assert.equal(h.view().health.failures, 1);
  await press(h, 'tab-classifier');
  await press(h, 'classifier-clef-flash');
  assert.deepEqual(projectPatch(h), { classifier: 'clef-flash' });
  assert.deepEqual(h.view().health, { failures: 0, pausedUntil: 0, classifier: 'clef-flash' });
  let pane = await h.render();
  assert.equal(controls(pane).find((node) => node.key === 'classifier-clef-flash').label, '◉ Clef Flash');
  assert.equal(controls(pane).find((node) => node.key === 'classifier-jev').label, '○ Jev       ');
  assert.equal(controls(pane).find((node) => node.key === 'timeoutMs').value, '3000');
  assert.ok(
    texts(pane).some((line) =>
      /^Saved: classifier Jev → Clef Flash\. Applies from the next turn in this project\./.test(line),
    ),
  );
  assert.ok(texts(pane).includes('prompt + 6 recent turns → api.cloudflare.com'));
  await press(h, 'tab-now');
  await press(h, 'undo');
  assert.deepEqual(projectPatch(h), {});
  assert.equal(
    h.view().notice,
    'Undid: classifier Jev → Clef Flash. Applies from the next turn. Classifier prompts go to api.typesafe.ai.',
  );
  await press(h, 'tab-classifier');
  pane = await h.render();
  assert.equal(
    controls(pane).find((node) => node.key === 'undo'),
    undefined,
  );
  assert.equal(controls(pane).find((node) => node.key === 'timeoutMs').value, '1500');
  await press(h, 'classifier-clef-flash');
  const calls = [];
  h.http(async (url) => {
    calls.push(url);
    return { ok: true, status: 200, text: CLEF_FLASH_ANSWER, headers: {} };
  });
  await h.event('turn.start', { turnId: 't2', text: 'Rename x.' });
  await drain(h.step({ ...step, turnId: 't2' }));
  assert.match(calls[0], /clef-flash$/);
  await press(h, 'tab-now');
  assert.equal(h.view().lastWrite.label, 'classifier Jev → Clef Flash');
});

test('the deadline saves at once for the active classifier and its built-in value is an explicit override', async () => {
  const h = harness();
  await start(h);
  await press(h, 'tab-classifier');
  await press(h, 'classifier-clef');
  await press(h, 'timeoutMs', '1500');
  assert.deepEqual(projectPatch(h), { classifier: 'clef', classifiers: { clef: { timeoutMs: 1500 } } });
  assert.match(h.view().notice, /^Saved: Clef deadline 3000 → 1500 ms\./);
  await press(h, 'timeoutMs', '3000');
  assert.deepEqual(projectPatch(h), { classifier: 'clef', classifiers: { clef: { timeoutMs: 3000 } } });
});

test('a new session keeps classifier health only while the classifier is the same', async () => {
  const h = harness({ typesafe_api_key: 'synthetic-key', ...CLOUDFLARE_KEYS });
  h.http(async () => ({ ok: false, status: 401, text: '', headers: {} }));
  await start(h);
  await drain(h.step(step));
  await h.event('session.start', { cwd: '/fixture' });
  assert.equal(h.view().health.failures, 1);
  h.files.set(CONFIG, JSON.stringify({ classifier: 'clef' }));
  await h.event('session.start', { cwd: '/fixture' });
  assert.deepEqual(h.view().health, { failures: 0, pausedUntil: 0, classifier: 'clef' });
  assert.equal(h.view().adviceMs, null);
});

test('a switch clears the previous classifier readings, so no label claims them', async () => {
  const h = harness({ typesafe_api_key: 'synthetic-key', ...CLOUDFLARE_KEYS });
  h.http(async () => ({
    ok: true,
    status: 200,
    text: JSON.stringify(jevResponse('high', { micro: 0, low: 0.05, medium: 0.05, high: 0.9, uncertain: 0 })),
    headers: {},
  }));
  await start(h);
  await drain(h.step(step));
  assert.equal(h.view().probabilities.high, 0.9);
  await press(h, 'tab-classifier');
  await press(h, 'classifier-clef');
  for (const field of ['adviceMs', 'adviceChoice', 'probabilities', 'estimate', 'error'])
    assert.equal(h.view()[field], null, field);
  await press(h, 'tab-now');
  const pane = await h.render();
  assert.ok(texts(pane).some((line) => /^Clef ready/.test(line)));
  assert.ok(!texts(pane).some((line) => /Clef gave/.test(line)));
  const pin = controls(pane).find((c) => c.key === 'pin');
  assert.deepEqual(
    pin.options.map((o) => o.label),
    ['Pin to a tier', '▂ Haiku·medium —', '▂▄ Haiku·high —', '▂▄▆ Opus·medium —', '▶ ▂▄▆█ Opus·xhigh —'],
  );
});

test('a turn classified when the switch lands keeps its route, and its answer touches neither health nor status', async () => {
  const h = harness({ typesafe_api_key: 'synthetic-key', ...CLOUDFLARE_KEYS });
  // Activity routing off: Sonnet runs no route, so it keeps running until a decision moves it.
  h.files.set(CONFIG, JSON.stringify({ routes: { low: { model: 'opus' } }, activityRouting: 'off' }));
  h.model('claude-sonnet-5-5');
  let release;
  h.http(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  await start(h);
  await h.event('command.run', { command: 'router', args: 'on' });
  const turn = drain(h.step({ ...step, model: 'claude-sonnet-5-5' }));
  for (let i = 0; i < 20 && !release; i += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.ok(release, 'the Jev request is in flight');
  await press(h, 'tab-classifier');
  await press(h, 'classifier-clef-flash');
  release({ ok: false, status: 401, text: '', headers: {} });
  await turn;
  assert.equal(h.requests[0].model, 'claude-sonnet-5-5', 'no answer keeps the running model');
  assert.notEqual(h.view().reason, 'manual');
  assert.deepEqual(projectPatch(h).classifier, 'clef-flash');
  assert.deepEqual(h.view().health, { failures: 0, pausedUntil: 0, classifier: 'clef-flash' });
  assert.equal(h.view().error, null);
});

test('a hand-edited classifier is adopted on reload, not when the pane saves unrelated routing settings', async () => {
  const h = harness({ typesafe_api_key: 'synthetic-key', ...CLOUDFLARE_KEYS });
  h.http(async () => ({ ok: false, status: 401, text: '', headers: {} }));
  await start(h);
  await drain(h.step(step));
  assert.equal(h.view().health.failures, 1);
  h.files.set(CONFIG, '{"classifier":"clef"}');
  await press(h, 'tab-policy');
  await press(h, 'horizon', '10');
  await press(h, 'save-routing');
  assert.deepEqual(projectPatch(h), { policy: { downgradeHorizonTurns: 10 } });
  assert.equal(h.view().health.classifier, 'jev');
  await start(h);
  assert.deepEqual(h.view().health, { failures: 0, pausedUntil: 0, classifier: 'clef' });
  assert.equal(h.view().adviceMs, null);
});

test('a classifier switch while routing is unavailable keeps the unavailable reason', async () => {
  const h = harness();
  h.version('2.1.200');
  await start(h);
  const reason = h.view().error;
  assert.equal(h.view().phase, 'unavailable');
  await press(h, 'tab-classifier');
  await press(h, 'classifier-clef');
  assert.equal(projectPatch(h), undefined);
  assert.equal(h.view().error, reason);
});

test('a classifier switch that cannot write leaves the classifier and router.json unchanged', async () => {
  const h = harness();
  h.files.set(CONFIG, '{}');
  await start(h);
  h.$.store.set = async () => {
    throw new Error('synthetic store refusal');
  };
  await press(h, 'tab-classifier');
  await press(h, 'classifier-clef');
  assert.match(h.view().notice, /store did not confirm the change/);
  assert.equal(h.files.get(CONFIG), '{}');
  assert.equal(controls(await h.render()).find((node) => node.key === 'classifier-jev').label, '◉ Jev       ');
  assert.ok(texts(await h.render()).some((line) => /^ {2}Jev: no API key, keeping the model/.test(line)));
});

test('two presses on one drawn pane open and close help again', async () => {
  const h = harness();
  await start(h);
  const help = controls(await h.render()).find((node) => node.key === 'help');
  await help.onPress();
  await help.onPress();
  assert.equal(h.view().help, false);
});

test('activity edits join the routing draft: Save writes them with the mode, and Undo removes them', async () => {
  const h = harness();
  await start(h);
  await press(h, 'tab-routes');
  await press(h, 'activity-mode', 'off');
  await press(h, 'tab-routes');
  await press(h, 'cell-code-low');
  await press(h, 'activity-code-low-model', 'opus');
  await press(h, 'tab-routes');
  await press(h, 'cell-ops-medium');
  await press(h, 'activity-tier-ops-medium');
  await press(h, 'tab-routes');
  await press(h, 'cell-review-high');
  await press(h, 'activity-review-high-effort', 'max');
  await press(h, 'save-routing');
  assert.match(h.view().notice, /^Saved: routing changes\./);
  assert.deepEqual(projectPatch(h), {
    activities: {
      code: { low: { model: 'opus' } },
      review: { high: { effort: 'max' } },
      ops: { medium: null },
    },
    activityRouting: 'off',
  });
  assert.equal(h.view().routeDraft, null);
  await press(h, 'undo');
  assert.deepEqual(projectPatch(h), {});
});

test('a pending activity edit survives another pane write and saves later', async () => {
  const h = harness();
  await start(h);
  await press(h, 'tab-routes');
  await press(h, 'tab-routes');
  await press(h, 'cell-code-low');
  await press(h, 'activity-code-low-model', 'opus');
  await press(h, 'tab-classifier');
  await press(h, 'timeoutMs', '500');
  assert.deepEqual(h.view().routeDraft.activities.code.low, { model: 'opus', effort: 'high' });
  await press(h, 'tab-routes');
  await press(h, 'save-routing');
  assert.deepEqual(projectPatch(h), {
    classifiers: { jev: { timeoutMs: 500 } },
    activities: { code: { low: { model: 'opus' } } },
  });
});

test('Delete history clears usage, activity and subagent records, the session counts and the saved ones', async () => {
  const h = harness({ typesafe_api_key: 'synthetic-key' });
  h.http(async () => ({
    ok: true,
    status: 200,
    headers: {},
    text: JSON.stringify(
      jevResponse('low', { micro: 0, low: 0.95, medium: 0.05, high: 0, uncertain: 0 }, 0, { code: 0.9, ops: 0.1 }),
    ),
  }));
  await start(h);
  await drain(h.step(step));
  await h.event('turn.complete', { turnId: 't1' });
  assert.equal(h.view().activityStats.byActivity.code.turns, 1);
  assert.deepEqual(h.preferences.get(`${STORE_PREFIX}s1`).confusion, { code: { talk: 1 } });
  // Another session's records, from before the reset: one started at the reset's millisecond counts as written after it.
  const earlier = (key) => ({ ...h.preferences.get(key), since: 1 });
  h.preferences.set(`${STORE_PREFIX}s0`, earlier(`${STORE_PREFIX}s1`));
  h.preferences.set(STORE_KEY, {
    version: 1,
    confusion: { ops: { ops: 2 } },
    runs: {},
    lateral: { taken: 1, refused: 0 },
  });
  assert.deepEqual(h.view().activityStore.confusion, { code: { talk: 1 } });
  assert.equal(sessionOf(h).replies, 1);
  assert.equal(summarize(readUsage(h.preferences.get('usage:v1:s1')), { from: null, to: null }).replies, 1);
  assert.equal(h.preferences.get('savings:v1:s1'), undefined);
  assert.ok(h.preferences.get('activity:metrics:v1:s1').latency.jev);
  h.preferences.set('activity:metrics:v1:s0', earlier('activity:metrics:v1:s1'));
  h.preferences.set('usage:v1:s0', earlier('usage:v1:s1'));
  h.preferences.set('savings:v1:s0', {
    version: 1,
    since: 1,
    replies: 4,
    routedUsd: 1,
    yoursUsd: 2,
    cheaperUsd: -1,
    strongerUsd: 0,
    switchUsd: 0,
  });
  await press(h, 'tab-usage');
  await press(h, 'delete-history');
  await press(h, 'delete-confirm');
  await h.settle();
  assert.equal(h.view().activityStats, null);
  assert.equal(sessionOf(h).replies, 0);
  assert.deepEqual(h.view().activityStore, emptyStore());
  assert.equal(h.view().savingsStore.replies, 0);
  assert.deepEqual([h.view().usageStore.days, h.view().usageSession.days, h.view().confirmDelete], [{}, {}, false]);
  assert.deepEqual(
    [...h.preferences.keys()].filter((key) => key.startsWith('savings:') || key.startsWith('usage:v1:')),
    ['savings:reset:v1'],
  );
  assert.ok(Number.isFinite(h.preferences.get('savings:reset:v1')));
  assert.equal(h.view().notice, 'History deleted: usage, activity and subagent records of every session.');
  await press(h, 'tab-classifier');
  assert.ok(!texts(await h.render()).includes('ACROSS SESSIONS'));
  assert.deepEqual(
    [...h.preferences.keys()].filter((key) => key.startsWith('activity:')),
    [],
  );
  assert.deepEqual(h.view().activityMetrics, {
    version: 1,
    since: null,
    latency: {},
    downMoves: { moves: 0, escalations: 0 },
    unpriced: { usage: 0, model: 0, ttl: 0, error: 0, comparison: 0 },
  });
});

test('opening the pane reloads the counts another session added', async () => {
  const h = harness();
  await start(h);
  assert.equal(h.view().activityStore.lateral.taken, 0);
  h.preferences.set(STORE_KEY, {
    version: 1,
    confusion: { ops: { ops: 3 } },
    runs: {},
    lateral: { taken: 2, refused: 0 },
  });
  h.preferences.set(`${STORE_PREFIX}s0`, {
    version: 1,
    since: 1,
    confusion: { code: { code: 1 } },
    runs: {},
    lateral: { taken: 1, refused: 0 },
  });
  await h.event('command.run', { command: 'router', args: '' });
  assert.equal(h.view().activityStore.lateral.taken, 3);
  await press(h, 'tab-classifier');
  const lines = texts(await h.render());
  assert.ok(lines.includes(' · 4 turns since the last reset'), lines.join('\n'));
  assert.ok(lines.includes('  4 of 4 · too few to judge'), lines.join('\n'));
});

test('Delete history during a turn completion is not undone by that turn', async () => {
  const RESET = 'savings:reset:v1';
  const earlier = {
    version: 1,
    since: 1,
    confusion: { code: { code: 4 } },
    runs: {},
    lateral: { taken: 2, refused: 1 },
  };
  let gate = null;
  const preferences = new (class extends Map {
    get(key) {
      if (key !== RESET || !gate) return super.get(key);
      // The turn reads the marker once per record it writes, and may read it for several at once.
      const { promise, resolve } = Promise.withResolvers();
      gate.waiting.push(resolve);
      gate.reached();
      return promise;
    }
  })([[`${STORE_PREFIX}s1`, earlier]]);
  const h = harness({ typesafe_api_key: 'synthetic-key' }, preferences);
  h.http(async () => ({
    ok: true,
    status: 200,
    headers: {},
    text: JSON.stringify(
      jevResponse('low', { micro: 0, low: 0.95, medium: 0.05, high: 0, uncertain: 0 }, 0, { code: 0.9, ops: 0.1 }),
    ),
  }));
  await start(h);
  await drain(h.step(step));
  const reached = Promise.withResolvers();
  gate = { reached: reached.resolve, waiting: [] };
  const completing = h.event('turn.complete', { turnId: 't1' });
  await reached.promise;
  const read = gate;
  await press(h, 'tab-usage');
  gate = null;
  await press(h, 'delete-history');
  await press(h, 'delete-confirm');
  // The marker as the turn read it, before the reset wrote it.
  for (const resolve of read.waiting) resolve(undefined);
  await completing;
  assert.equal(h.view().notice, 'History deleted: usage, activity and subagent records of every session.');
  assert.deepEqual(savedCounts(h.preferences), {
    version: 1,
    confusion: {},
    runs: {},
    lateral: { taken: 0, refused: 0 },
  });
  assert.deepEqual(h.view().activityStore, emptyStore());
});

test('Delete history while a turn writes its counts leaves the readout empty', async () => {
  const STORE = `${STORE_PREFIX}s1`;
  let gate = null;
  const preferences = new (class extends Map {
    set(key, value) {
      super.set(key, value);
      if (key !== STORE || !gate) return this;
      const { promise, resolve } = Promise.withResolvers();
      gate.resolve = resolve;
      gate.reached();
      return promise;
    }
  })();
  const h = harness({ typesafe_api_key: 'synthetic-key' }, preferences);
  h.http(async () => ({
    ok: true,
    status: 200,
    headers: {},
    text: JSON.stringify(
      jevResponse('low', { micro: 0, low: 0.95, medium: 0.05, high: 0, uncertain: 0 }, 0, { code: 0.9, ops: 0.1 }),
    ),
  }));
  await start(h);
  await drain(h.step(step));
  const reached = Promise.withResolvers();
  gate = { reached: reached.resolve };
  const completing = h.event('turn.complete', { turnId: 't1' });
  await reached.promise;
  const write = gate;
  gate = null;
  await press(h, 'tab-usage');
  await press(h, 'delete-history');
  await press(h, 'delete-confirm');
  write.resolve();
  await completing;
  assert.equal(h.preferences.get(STORE), undefined);
  assert.equal(h.preferences.get('activity:metrics:v1:s1'), undefined);
  assert.deepEqual(h.view().activityMetrics.latency, {});
  assert.deepEqual(h.view().activityStore, emptyStore());
  await press(h, 'tab-classifier');
  assert.ok(!texts(await h.render()).includes('ACROSS SESSIONS'));
});

test('Use tier model is an explicit override even for a legacy no-effect activity cell', async () => {
  const h = harness();
  h.files.set(CONFIG, JSON.stringify({ activities: { docs: { low: { model: 'haiku', effort: 'high' } } } }));
  await start(h);
  await press(h, 'tab-routes');
  await press(h, 'cell-docs-low');
  assert.ok(texts(await h.render()).includes('same as the tier’s model: no effect'));
  await press(h, 'activity-tier-docs-low');
  await press(h, 'save-routing');
  assert.deepEqual(projectPatch(h), { activities: { docs: { low: null } } });
  const pane = await h.render();
  assert.ok(texts(pane).includes('explicitly uses the tier’s model'));
  assert.ok(!controls(pane).some((c) => c.key === 'activity-tier-docs-low'));
});

test('Reset routes keeps pending activity edits and the mode', async () => {
  const h = harness();
  await start(h);
  await press(h, 'tab-routes');
  await press(h, 'activity-mode', 'off');
  await press(h, 'tab-routes');
  await press(h, 'cell-code-low');
  await press(h, 'activity-code-low-model', 'opus');
  await press(h, 'reset-routes');
  assert.equal(h.view().notice, 'No stored overrides changed.');
  await press(h, 'save-routing');
  assert.deepEqual(projectPatch(h), {
    activities: { code: { low: { model: 'opus' } } },
    activityRouting: 'off',
  });
});

test('a pane the surface leaves undrawn says why in a toast, and a placed one says nothing', async () => {
  const h = harness();
  await start(h);
  const open = async () => (await band(h)).controls.find((node) => node.key === 'details').onPress();
  h.opens({ isPlaced: true });
  await open();
  assert.equal(h.toasts.length, 0);
  h.opens({ isPlaced: false, reason: 'the terminal is 100 columns wide; the floor is 144' });
  await open();
  assert.equal(h.toasts.at(-1), 'The Router pane is not shown: the terminal is 100 columns wide; the floor is 144');
});
