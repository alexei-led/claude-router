// Set up and Edit on a graphical surface, which cannot open `/plugin configure`'s dialog: the pane shows how to add the
// credentials from a terminal instead. The terminal still opens the dialog.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { DEFAULTS } from '../lib/config.mjs';
import { pluginIdOf } from '../lib/display.mjs';
import { keyHelpOf } from '../lib/panel.mjs';
import { controls, drain, duplicates, find, harness, start, step, texts } from './harness.mjs';

const ID = 'router@router-preview';

test('the plugin id is name@marketplace for an installed plugin, else its name', () => {
  assert.equal(
    pluginIdOf({ name: 'router', root: '/Users/me/.claude/plugins/cache/router-preview/router/1.24.0' }),
    'router@router-preview',
  );
  assert.equal(
    pluginIdOf({ name: 'router', root: '/Users/me/.claude/plugins/cache/alexei-led-claude-router/router/1.24.0' }),
    'router@alexei-led-claude-router',
  );
  assert.equal(pluginIdOf({ name: 'router', root: '/work/claude-router' }), 'router');
  assert.equal(pluginIdOf({ name: 'router', root: undefined }), 'router');
});

test('a folder install takes its id from settings’ enabledPlugins, when one key names it', () => {
  const folder = { name: 'router', root: '/work/claude-router' };
  assert.equal(pluginIdOf(folder, { 'router@router-preview': true, 'other@x': true }), 'router@router-preview');
  // `--plugin-dir` loads are `@inline`, which the CLI cannot configure.
  assert.equal(pluginIdOf(folder, { 'router@inline': true, 'router@router-preview': true }), 'router@router-preview');
  // A disabled earlier install is no candidate: the enabled one names the plugin.
  assert.equal(
    pluginIdOf(folder, { 'router@alexei-led-claude-router': false, 'router@router-preview': true }),
    'router@router-preview',
  );
  assert.equal(pluginIdOf(folder, { 'router@a': null, 'router@b': ['x'] }), 'router@b');
  // Two enabled candidates, none, or no settings: the bare name.
  assert.equal(pluginIdOf(folder, { 'router@a': false, 'router@b': false }), 'router');
  assert.equal(pluginIdOf(folder, { 'router@a': true, 'router@b': true }), 'router');
  assert.equal(pluginIdOf(folder, {}), 'router');
  assert.equal(pluginIdOf(folder, null), 'router');
  // Anything but word characters, dots, @ and - falls back to the name: nothing to quote in the command.
  assert.equal(pluginIdOf(folder, { "router@x'; rm -rf ~": true }), 'router');
  assert.equal(pluginIdOf({ name: 'router', root: '/h/.claude/plugins/cache/a b/router/1' }), 'router');
});

test('the key help adds a line on the full name only when the id has no marketplace', () => {
  assert.equal(keyHelpOf(DEFAULTS, 'jev', ID).note, null);
  assert.equal(
    keyHelpOf(DEFAULTS, 'jev', 'router').note,
    'If the command says the plugin is not found, use the full name shown by /plugin (name@marketplace).',
  );
});

test('an edit says Change instead of Add', () => {
  assert.equal(keyHelpOf(DEFAULTS, 'jev', ID, { edit: true }).title, 'Change the Jev key');
  assert.equal(keyHelpOf(DEFAULTS, 'openai', ID, { edit: true }).title, 'Change the OpenAI key');
  assert.equal(keyHelpOf(DEFAULTS, 'clef', ID, { edit: true }).title, 'Change the Cloudflare token and account ID');
});

test('the key help names each option the classifier reads, hides the secret and saves through --values-stdin', () => {
  const jev = keyHelpOf(DEFAULTS, 'jev', ID);
  assert.equal(jev.title, 'Add the Jev key');
  assert.equal(
    jev.command,
    `read -rs "K?Jev key: " && printf '{"typesafe_api_key":"%s"}' "$K" | claude plugin configure ${ID} --values-stdin; echo; unset K`,
  );
  const openai = keyHelpOf(DEFAULTS, 'openai', ID);
  assert.equal(openai.title, 'Add the OpenAI key');
  assert.match(openai.command, /^read -rs "K\?OpenAI key: " && printf '\{"openai_api_key":"%s"\}' "\$K" \| /);
  const clef = keyHelpOf(DEFAULTS, 'clef-flash', ID);
  assert.equal(clef.title, 'Add the Cloudflare token and account ID');
  assert.equal(
    clef.command,
    `read -rs "K?Cloudflare token: " && echo && read -r "A?Cloudflare account ID: " && printf '{"cloudflare_api_token":"%s","cloudflare_account_id":"%s"}' "$K" "$A" | claude plugin configure ${ID} --values-stdin; echo; unset K A`,
  );
  for (const help of [jev, openai, clef]) {
    assert.equal(help.alternative, `Or run claude in a terminal and type /plugin configure ${ID}`);
    assert.equal(help.reload, 'Then run /reload-plugins and press Done.');
    assert.doesNotMatch(JSON.stringify(help), /undefined|NaN/);
  }
  assert.equal(keyHelpOf(DEFAULTS, 'ollama', ID), null);
  assert.equal(keyHelpOf(DEFAULTS, 'nope', ID), null);
});

const pane = (h, surface) => h.render(undefined, surface);
const keyed = (tree, key) => find(tree, (node) => node.props.key === key);

test('a graphical Set up opens the key help and runs no command; the terminal’s runs /plugin configure', async () => {
  for (const surface of ['desktop', 'vscode', 'mobile']) {
    const h = harness();
    await start(h);
    const [setUp] = keyed(await pane(h, surface), 'key');
    assert.equal(setUp.props.hotkey, 'k', surface);
    await setUp.props.onPress({ surface });
    assert.equal(h.commandCalls(), 0, surface);
    assert.deepEqual(h.view().keyHelp, { id: 'jev', edit: false }, surface);
    const tree = await pane(h, surface);
    assert.deepEqual(duplicates(tree), { keys: [], hotkeys: [] }, surface);
    const [code] = find(tree, (node) => node.type === 'Code');
    assert.equal(code.props.language, 'bash', surface);
    assert.match(code.props.source, /"typesafe_api_key":"%s"/, surface);
    assert.match(code.props.source, /claude plugin configure router --values-stdin/, surface);
    assert.ok(texts(tree).includes('Add the Jev key'), surface);
    // The card takes the credentials notice's place: the missing key is said once.
    assert.ok(!texts(tree).some((line) => /no API key, keeping the model/.test(line)), surface);
    // The card replaces the notice and its Set up; nothing else takes k.
    assert.ok(find(tree, (node) => node.props.hotkey === 'k').length <= 1, surface);
  }
  const h = harness();
  await start(h);
  await keyed(await pane(h), 'key')[0].props.onPress({ surface: 'terminal' });
  assert.equal(h.commandCalls(), 1);
  assert.equal(h.view().keyHelp ?? null, null);
});

test('a graphical row’s Set up opens the help for its own classifier', async () => {
  const h = harness();
  await start(h);
  await keyed(await pane(h, 'desktop'), 'tab-classifier')[0].props.onPress({ surface: 'desktop' });
  await keyed(await pane(h, 'desktop'), 'key-openai')[0].props.onPress({ surface: 'desktop' });
  assert.deepEqual(h.view().keyHelp, { id: 'openai', edit: false });
  assert.equal(h.commandCalls(), 0);
  const tree = await pane(h, 'desktop');
  assert.match(find(tree, (node) => node.type === 'Code')[0].props.source, /"openai_api_key":"%s"/);
  assert.deepEqual(duplicates(tree), { keys: [], hotkeys: [] });
});

test('Copy command copies the command on the press’s surface and says so; Done closes the help', async () => {
  const h = harness();
  await start(h);
  await keyed(await pane(h, 'desktop'), 'key')[0].props.onPress({ surface: 'desktop' });
  const tree = await pane(h, 'desktop');
  const source = find(tree, (node) => node.type === 'Code')[0].props.source;
  await keyed(tree, 'key-help-copy')[0].props.onPress({ surface: 'desktop' });
  assert.deepEqual(h.copied.at(-1), { text: source, surface: 'desktop' });
  assert.ok(texts(await pane(h, 'desktop')).some((line) => /Copied/.test(line)));
  await keyed(await pane(h, 'desktop'), 'key-help-done')[0].props.onPress({ surface: 'desktop' });
  assert.equal(h.view().keyHelp, null);
  assert.equal(keyed(await pane(h, 'desktop'), 'key-help-copy').length, 0);
});

test('the key help closes by itself once the credential is there', async () => {
  const options = {};
  const h = harness(options);
  await start(h);
  await keyed(await pane(h, 'desktop'), 'key')[0].props.onPress({ surface: 'desktop' });
  assert.equal(keyed(await pane(h, 'desktop'), 'key-help-copy').length, 1);
  // The key saved from a terminal is read the next time the pane reloads its config, here on a classifier switch.
  options.typesafe_api_key = 'synthetic-key';
  await keyed(await pane(h, 'desktop'), 'tab-classifier')[0].props.onPress({ surface: 'desktop' });
  await keyed(await pane(h, 'desktop'), 'classifier-ollama')[0].props.onPress({ surface: 'desktop' });
  assert.equal(h.view().credentials.jev, null);
  assert.equal(keyed(await pane(h, 'desktop'), 'key-help-copy').length, 0);
  assert.equal(h.view().keyHelp, null);
});

test('the band’s Set up on a graphical surface opens the pane on the key help', async () => {
  const h = harness();
  await start(h);
  await drain(h.step(step));
  const band = await h.component(
    'AbovePrompt',
    { hasSurvey: false, isWorking: false, maxRows: 4, bodyColumns: 120, view: {} },
    { surface: 'desktop' },
  );
  await controls(band)
    .find((node) => node.key === 'band-key')
    .onPress({ surface: 'desktop' });
  assert.equal(h.commandCalls(), 0);
  assert.deepEqual(h.view().keyHelp, { id: 'jev', edit: false });
});

test('Edit credentials with the key present opens the change card, which stays until Done', async () => {
  const h = harness({ typesafe_api_key: 'synthetic-key' });
  h.settings({ enabledPlugins: { 'router@router-preview': true } });
  await start(h);
  await keyed(await pane(h, 'desktop'), 'tab-classifier')[0].props.onPress({ surface: 'desktop' });
  const [edit] = keyed(await pane(h, 'desktop'), 'key');
  assert.equal(edit.props.hotkey, 'k');
  await edit.props.onPress({ surface: 'desktop' });
  assert.equal(h.commandCalls(), 0);
  assert.deepEqual(h.view().keyHelp, { id: 'jev', edit: true });
  for (let i = 0; i < 2; i += 1) {
    const tree = await pane(h, 'desktop');
    assert.ok(texts(tree).includes('Change the Jev key'));
    // The id comes from settings when the install path names no marketplace.
    assert.match(find(tree, (node) => node.type === 'Code')[0].props.source, /configure router@router-preview /);
    assert.ok(!texts(tree).some((line) => /use the full name/.test(line)));
    assert.deepEqual(duplicates(tree), { keys: [], hotkeys: [] });
  }
  await keyed(await pane(h, 'desktop'), 'key-help-copy')[0].props.onPress({ surface: 'desktop' });
  assert.match(h.copied.at(-1).text, /configure router@router-preview --values-stdin/);
  await keyed(await pane(h, 'desktop'), 'key-help-done')[0].props.onPress({ surface: 'desktop' });
  assert.equal(h.view().keyHelp, null);
  assert.equal(keyed(await pane(h, 'desktop'), 'key-help-copy').length, 0);
});

test('with no marketplace anywhere the card keeps the bare name and says how to find the full one', async () => {
  const h = harness();
  await start(h);
  await keyed(await pane(h, 'desktop'), 'key')[0].props.onPress({ surface: 'desktop' });
  const tree = await pane(h, 'desktop');
  assert.match(find(tree, (node) => node.type === 'Code')[0].props.source, /configure router --values-stdin/);
  assert.ok(
    texts(tree).includes(
      'If the command says the plugin is not found, use the full name shown by /plugin (name@marketplace).',
    ),
  );
});

// The title's status says the classifier needs attention only while a notice states its error.
const titleOf = (tree) => {
  const status = find(
    tree,
    (node) => node.type === 'Text' && /needs attention| ready/.test(String(node.props.children)),
  );
  return status.map((node) => node.props.children);
};

test('an open Edit card leaves the title ready; an open Set up card says the classifier needs attention', async () => {
  const present = harness({ typesafe_api_key: 'synthetic-key' });
  await start(present);
  await keyed(await pane(present, 'desktop'), 'tab-classifier')[0].props.onPress({ surface: 'desktop' });
  await keyed(await pane(present, 'desktop'), 'key')[0].props.onPress({ surface: 'desktop' });
  const editing = await pane(present, 'desktop');
  assert.equal(keyed(editing, 'key-help-copy').length, 1);
  assert.ok(!titleOf(editing).some((text) => /needs attention/.test(text)), titleOf(editing).join(' | '));
  assert.ok(
    titleOf(editing).some((text) => /^Jev ready/.test(text)),
    titleOf(editing).join(' | '),
  );
  const missing = harness();
  await start(missing);
  // Routing on: the missing-key notice, which the card replaces, applies only then.
  await missing.event('command.run', { command: 'router', args: 'auto' });
  assert.equal(missing.view().mode, 'auto');
  await keyed(await pane(missing, 'desktop'), 'key')[0].props.onPress({ surface: 'desktop' });
  const setUp = await pane(missing, 'desktop');
  assert.equal(keyed(setUp, 'key-help-copy').length, 1);
  assert.ok(titleOf(setUp).includes('Jev needs attention'), titleOf(setUp).join(' | '));
});

test('the key help command passes an unusual plugin id to claude as one word', () => {
  const zsh = spawnSync('zsh', ['-c', 'true']);
  if (zsh.error) return;
  for (const pluginId of [ID, 'my router', "it's; touch pwned", '$(id)']) {
    const { command } = keyHelpOf(DEFAULTS, 'jev', pluginId);
    const run = spawnSync('zsh', ['-fc', `claude() { print -rl -- "$@"; cat >/dev/null; }; ${command}`], {
      input: 'secret\n',
      encoding: 'utf8',
    });
    assert.deepEqual(run.stdout.trim().split('\n').slice(0, 3), ['plugin', 'configure', pluginId], pluginId);
  }
});
