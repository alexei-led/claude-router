import assert from 'node:assert/strict';
import test from 'node:test';
import { CONFIG, controls, harness, JEV_KEY, press, projectPatch, projectRecord, start, texts } from './harness.mjs';

const command = async (h, args) => (await h.event('command.run', { command: 'router', args })).text;
const PROJECT = '/fixture/project/.claude';
const SHARED = `${PROJECT}/router.json`;
const LOCAL = `${PROJECT}/router.local.json`;

test('pane mode, Undo and /router routing edits never write any JSON settings file', async () => {
  const h = harness(JEV_KEY);
  h.files.set(CONFIG, '{ "mode": "quality", "activityRouting": "on" }\n');
  h.files.set(SHARED, '{ "mode": "quality" }\n');
  h.files.set(LOCAL, '{ "mode": "quality" }\n');
  const before = [...h.files];
  await start(h);
  await command(h, '');
  await press(h, 'tab-policy');
  await press(h, 'routing-mode', 'balanced');
  assert.deepEqual([...h.files], before);
  assert.equal(projectPatch(h).mode, 'balanced');
  assert.deepEqual(h.view().routingMode, { mode: 'balanced', source: 'project preference' });
  await press(h, 'undo');
  assert.deepEqual(h.view().routingMode, { mode: 'quality', source: 'project local' });
  await command(h, 'engine shadow');
  await command(h, 'activities off');
  assert.deepEqual(projectPatch(h), { routingEngine: 'shadow', activityRouting: 'off' });
  assert.deepEqual([...h.files], before);
});

test('a canonical launch alias shares the override, other roots and profiles do not', async () => {
  const original = harness(JEV_KEY);
  original.files.set(LOCAL, '{"mode":"cost"}');
  await start(original);
  await command(original, 'engine shadow');
  await press(original, 'tab-policy');
  await press(original, 'routing-mode', 'quality');

  const opened = async (launch, profile, canonicalRoot = launch, canonicalProfile = profile) => {
    const h = harness(JEV_KEY, original.preferences);
    h.env.set('CLAUDE_CONFIG_DIR', profile);
    h.$.session.root = async () => launch;
    // The host may return the workspace cwd from a different directory, but identity is fixed to launch root.
    h.$.session.cwd = async () => '/fixture/unrelated';
    h.files.set(LOCAL, '{"mode":"cost"}');
    const stat = h.$.fs.stat;
    h.$.fs.stat = async (path) =>
      path === launch || path === profile
        ? {
            kind: 'dir',
            isLink: path !== (path === launch ? canonicalRoot : canonicalProfile),
            realPath: path === launch ? canonicalRoot : canonicalProfile,
          }
        : stat(path);
    await start(h);
    return h;
  };
  const alias = await opened('/fixture/project-alias', '/fixture/team-alias', '/fixture/project', '/fixture/team');
  assert.equal(alias.view().projectRoot, '/fixture/project');
  assert.deepEqual(alias.view().routingMode, { mode: 'quality', source: 'project preference' });
  const subdir = await opened('/fixture/project/sub', '/fixture/team');
  assert.deepEqual(subdir.view().routingMode, { mode: 'balanced', source: 'default' });
  const anotherProfile = await opened('/fixture/project', '/fixture/sandbox');
  assert.deepEqual(anotherProfile.view().routingMode, { mode: 'cost', source: 'project local' });
  await command(anotherProfile, 'engine auto');
  assert.equal([...original.preferences.keys()].filter((key) => key.startsWith('project-routing:v1:')).length, 2);
});

test('no verified scope on a home alias or unknown canonical profile; commands cannot write', async () => {
  for (const rejected of ['home alias', 'unknown profile', 'profile directory alias']) {
    const h = harness(JEV_KEY);
    const stat = h.$.fs.stat;
    h.$.fs.stat = async (path) => {
      if (rejected === 'home alias' && path === '/fixture/project')
        return { kind: 'dir', realPath: '/fixture', isLink: true };
      if (rejected === 'unknown profile' && path === '/fixture/team') return { kind: 'dir' };
      if (rejected === 'profile directory alias' && path === PROJECT)
        return { kind: 'dir', realPath: '/fixture/team', isLink: true };
      return stat(path);
    };
    h.files.set(LOCAL, '{"mode":"quality"}');
    await start(h);
    assert.equal(h.view().projectRoot, null, rejected);
    assert.match(await command(h, 'engine auto'), /no verified project routing scope/, rejected);
    assert.equal(projectPatch(h), undefined, rejected);
    assert.equal(h.view().phase, 'ready', rejected);
  }
});

test('optional files distinguish absence, links, unreadable entries and invalid patches without exposing file contents', async () => {
  const h = harness(JEV_KEY);
  await start(h);
  assert.equal(h.view().projectError, null);
  h.files.set(SHARED, '{"mode":"cost"}');
  h.files.set(LOCAL, '{"classifier":"private-canary"}');
  await start(h);
  assert.match(h.view().projectError, /router\.local\.json.*invalid or unsupported/);
  assert.doesNotMatch(h.view().projectError, /private-canary/);
  assert.deepEqual(h.view().routingMode, { mode: 'cost', source: 'project' });
  h.links.add(LOCAL);
  const read = h.$.fs.read;
  const reads = [];
  h.$.fs.read = async (path) => {
    reads.push(path);
    return read(path);
  };
  await start(h);
  assert.match(h.view().projectError, /router\.local\.json is a symlink/);
  assert.ok(!reads.includes(LOCAL));
  const stat = h.$.fs.stat;
  h.$.fs.stat = async (path) => {
    if (path === LOCAL) throw new Error('private-canary');
    return stat(path);
  };
  await start(h);
  assert.match(h.view().projectError, /router\.local\.json could not be read/);
  assert.doesNotMatch(h.view().projectError, /private-canary/);
});

test('a linked .claude is never read even when its target is another directory under the project', async () => {
  const h = harness(JEV_KEY);
  h.files.set(SHARED, '{"mode":"cost"}');
  h.files.set(LOCAL, '{"mode":"quality"}');
  const stat = h.$.fs.stat;
  h.$.fs.stat = async (path) =>
    path === PROJECT ? { kind: 'dir', realPath: '/fixture/project/other', isLink: true } : stat(path);
  await start(h);
  assert.match(h.view().projectError, /router\.local\.json is outside a regular, unlinked \.claude directory/);
  assert.deepEqual(h.view().routingMode, { mode: 'balanced', source: 'default' });
});

test('corrupt owned overrides are ignored and require confirmed Clear; Delete history leaves preferences intact', async () => {
  const h = harness(JEV_KEY);
  h.files.set(LOCAL, '{"mode":"cost"}');
  await start(h);
  await command(h, 'engine shadow');
  const [key, record] = projectRecord(h);
  await press(h, 'tab-usage');
  await press(h, 'delete-history');
  await press(h, 'delete-confirm');
  assert.deepEqual(h.preferences.get(key), record);
  const damaged = { ...record, patch: { classifiers: { jev: { endpoint: 'https://private-canary.invalid' } } } };
  h.preferences.set(key, damaged);
  await start(h);
  assert.match(h.view().projectPreferenceError, /invalid.*Clear overrides/);
  assert.match(await command(h, 'engine auto'), /Not saved:.*invalid/);
  assert.equal(h.preferences.get(key), damaged);
  await press(h, 'tab-policy');
  await press(h, 'ask-clear-project-routing');
  await press(h, 'cancel-clear-project-routing');
  assert.equal(h.preferences.get(key), damaged);
  await press(h, 'ask-clear-project-routing');
  await press(h, 'clear-project-routing');
  assert.deepEqual(projectPatch(h), {});
  assert.equal(h.view().lastWrite, null);
  assert.equal(h.view().projectPreferenceError, null);
  assert.equal(h.view().routingMode.source, 'project local');
});

test('read failures and unverified record identities never authorize a write or a clear', async () => {
  const h = harness(JEV_KEY);
  await start(h);
  await command(h, 'engine shadow');
  const [key, record] = projectRecord(h);
  const get = h.$.store.get;
  h.$.store.get = async (id) => {
    if (id === key) throw new Error('private-canary');
    return get(id);
  };
  await start(h);
  assert.match(h.view().projectPreferenceError, /could not be read/);
  assert.doesNotMatch(await command(h, 'engine auto'), /private-canary/);
  assert.deepEqual(h.preferences.get(key), record);
  h.$.store.get = get;
  h.preferences.set(key, { ...record, identity: 'a'.repeat(64) });
  await start(h);
  assert.match(h.view().projectPreferenceError, /unverified identity/);
  assert.equal(h.view().canClearProject, false);
  assert.match(await command(h, 'engine auto'), /Not saved:.*unverified identity/);
  assert.equal(h.preferences.get(key).identity, 'a'.repeat(64));
});

test('a stale draft merges unrelated leaves, then a conflicting draft and stale Undo are refused', async () => {
  const a = harness(JEV_KEY);
  const b = harness(JEV_KEY, a.preferences);
  await start(a);
  await start(b);
  const draft = async (h, value) => {
    await press(h, 'tab-policy');
    await press(h, 'horizon', value);
  };
  await draft(a, '10');
  await command(b, 'activities off');
  await press(a, 'save-routing');
  assert.deepEqual(projectPatch(a), { activityRouting: 'off', policy: { downgradeHorizonTurns: 10 } });
  await draft(a, '1');
  await press(b, 'tab-policy');
  assert.equal(
    controls(await b.render()).some((node) => node.key === 'refresh-project-routing'),
    false,
  );
  await press(b, 'help');
  await press(b, 'refresh-project-routing');
  await draft(b, '3');
  await press(b, 'save-routing');
  await press(a, 'save-routing');
  assert.match(a.view().notice, /changed elsewhere/);
  assert.equal(a.view().tuning.horizon, 1);
  await press(a, 'undo');
  assert.match(a.view().notice, /changed elsewhere/);
  assert.deepEqual(projectPatch(a), { activityRouting: 'off', policy: { downgradeHorizonTurns: 3 } });
});

test('Undo refuses a save superseded by an overlapping write from another instance', async () => {
  const a = harness(JEV_KEY);
  const b = harness(JEV_KEY, a.preferences);
  await start(a);
  await start(b);
  await press(a, 'tab-policy');
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const set = b.$.store.set;
  b.$.store.set = async (key, value) => {
    if (key.startsWith('project-routing:v1:')) {
      entered.resolve();
      await release.promise;
    }
    return set(key, value);
  };
  const saving = command(b, 'activities off');
  await entered.promise;
  try {
    assert.match(await command(a, 'engine shadow'), /^Saved:/);
    assert.deepEqual(projectPatch(a), { routingEngine: 'shadow' });
  } finally {
    release.resolve();
  }
  assert.match(await saving, /^Saved:/);
  // Both writers read the empty record, and the host offers no compare-and-swap.
  const winner = { activityRouting: 'off' };
  assert.deepEqual(projectPatch(a), winner);
  await press(a, 'undo');
  assert.match(a.view().notice, /changed elsewhere\. Use Reload/);
  assert.deepEqual(projectPatch(a), winner);
});

test('a lost write acknowledgement keeps the draft and gives no false rollback assurance', async () => {
  const h = harness(JEV_KEY);
  await start(h);
  const set = h.$.store.set;
  h.$.store.set = async (key, value) => {
    await set(key, value);
    throw new Error('private-canary');
  };
  await press(h, 'tab-policy');
  await press(h, 'horizon', '10');
  await press(h, 'save-routing');
  assert.match(h.view().notice, /Save status unknown/);
  assert.doesNotMatch(h.view().notice, /private-canary|unchanged|rolled back/);
  assert.equal(h.view().tuning.horizon, 10);
  assert.equal(h.view().lastWrite, null);
  h.$.store.set = set;
  await press(h, 'discard-routing');
  await press(h, 'refresh-project-routing');
  assert.equal(controls(await h.render()).find((node) => node.key === 'horizon').value, '10');
});

test('confirmed clear and Undo keep the lower layers and newly opened sessions consistent', async () => {
  const h = harness(JEV_KEY);
  h.files.set(LOCAL, '{"mode":"cost"}');
  await start(h);
  await press(h, 'tab-policy');
  await press(h, 'routing-mode', 'balanced');
  await press(h, 'ask-clear-project-routing');
  await press(h, 'clear-project-routing');
  assert.deepEqual(projectPatch(h), {});
  assert.deepEqual(h.view().routingMode, { mode: 'cost', source: 'project local' });
  await press(h, 'undo');
  assert.deepEqual(projectPatch(h), { mode: 'balanced' });
  const reopened = harness(JEV_KEY, h.preferences);
  reopened.files.set(LOCAL, h.files.get(LOCAL));
  await start(reopened);
  assert.deepEqual(reopened.view().routingMode, { mode: 'balanced', source: 'project preference' });
});

test('overlapping pane presses do not start a second store mutation before acknowledgement', async () => {
  const h = harness(JEV_KEY);
  await start(h);
  await press(h, 'tab-policy');
  const entered = Promise.withResolvers();
  const ack = Promise.withResolvers();
  const set = h.$.store.set;
  let writes = 0;
  h.$.store.set = async (key, value) => {
    if (key.startsWith('project-routing:v1:')) {
      writes += 1;
      entered.resolve();
      await ack.promise;
    }
    return set(key, value);
  };
  const saving = press(h, 'routing-mode', 'cost');
  await entered.promise;
  assert.match(await command(h, 'engine shadow'), /in progress/);
  assert.equal(writes, 1);
  assert.deepEqual(h.view().routingMode, { mode: 'balanced', source: 'default' });
  ack.resolve();
  await saving;
  assert.deepEqual(projectPatch(h), { mode: 'cost' });
  assert.deepEqual(h.view().routingMode, { mode: 'cost', source: 'project preference' });
});

test('direct classifier picks save only the trusted ID, and clearing a local pick names the remote destination', async () => {
  const h = harness(JEV_KEY);
  await start(h);
  await press(h, 'tab-classifier');
  await press(h, 'classifier-ollama');
  assert.deepEqual(projectPatch(h), { classifier: 'ollama' });
  await press(h, 'tab-policy');
  await press(h, 'ask-clear-project-routing');
  assert.ok(texts(await h.render()).some((line) => line.includes('Classifier prompts will go to api.typesafe.ai.')));
  await press(h, 'clear-project-routing');
  assert.match(h.view().notice, /Classifier prompts go to api\.typesafe\.ai/);
  assert.deepEqual(projectPatch(h), {});
});
