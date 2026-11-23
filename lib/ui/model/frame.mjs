// The pane's frame as data: the provider profile, the warnings under the tabs, how to add a classifier's credentials,
// the title's state, the save bar and the help.

import { endpointSettings, ROUTING_ENGINES, resolveRoute, TIERS } from '../../config.mjs';
import {
  classifierLabel,
  classifierState,
  classifierStatus,
  GATEWAY_CLEANUP,
  GATEWAY_SETTINGS,
  missingCredentials,
  modelName,
  routeName,
  unavailableReason,
} from '../../display.mjs';
import { isSameModel } from '../../route.mjs';
import { isRouting } from '../../view.mjs';
import { isGraphical } from '../tokens.mjs';
import { POLICY_ROWS, routingChanges } from './draft.mjs';
import { plural, sentence, tierLabel } from './format.mjs';

// Routes and Policy edit one draft and save together; Classifier saves each pick at once.
const DRAFT_TABS = ['routes', 'policy'];

// The provider profile's names on a card; any other profile shows its own key.
const PROVIDER_NAME = { deepseek: 'DeepSeek', zai: 'z.ai', minimax: 'MiniMax', mimo: 'MiMo', kimi: 'Kimi' };

// The provider profile and the file it reads, under the tabs; null on Anthropic.
function profileOf(config, view) {
  if (!config.provider || config.provider === 'anthropic') return null;
  const path = view.configPath ?? config.nativePath;
  const name = PROVIDER_NAME[config.provider] ?? config.provider;
  return {
    terminal: `profile ${[config.provider, path].filter(Boolean).join(' · ')}`,
    graphical: `Profile: ${[name, path].filter(Boolean).join(' · ')}`,
  };
}

/**
 * A warning under the tab row. `text` is as the terminal draws it, which pads it; `action` is a Button the notice carries.
 * @typedef {object} Notice
 * @property {import('../tokens.mjs').Tone} tone
 * @property {string} text
 * @property {{ key: string, label: string, hotkey?: string, press: (press: any) => void } | null} [action]
 * @property {boolean} [graphicalOnly] drawn on a graphical surface only, where the header has no room for it
 */

// The warnings that apply to the next turn, drawn once under the tab row on every tab: an ignored project config, a
// native fallback, and classifier credentials that are missing. They matter only while routing is on. The graphical
// pane has no header text for an unavailable router, so its reason joins them, and its title states the classifier's
// error only where no notice does. `statesClassifier` says whether one does.
function noticesOf({ config, view, actions }, tab, keyHelp) {
  const unavailable = view.phase === 'unavailable';
  /** @type {Notice[]} */
  const notices = [];
  // In place of the credentials notice a graphical Set up's card states their lack; an Edit's card, with nothing missing,
  // states nothing.
  let statesClassifier =
    Boolean(keyHelp) && keyHelp.id === config.classifier && Boolean(noticedCredentials(config, view));
  const warn = (text, extra = {}) => notices.push({ tone: 'warning', text, ...extra });
  if (unavailable) {
    warn(unavailableReason(view), { graphicalOnly: true });
    if (view.error === GATEWAY_SETTINGS) for (const line of GATEWAY_CLEANUP) warn(line, { graphicalOnly: true });
  }
  // Missing credentials have their own notice below, with Set up; this one would say them a second time.
  if (!unavailable && view.error && !['missing-key', 'missing-account'].includes(view.error)) {
    warn(classifierStatus(config, view.error), { graphicalOnly: true });
    statesClassifier = true;
  }
  if (view.projectError) warn(`Ignored: ${view.projectError}`);
  if (view.projectPreferenceError) warn(`Ignored: ${view.projectPreferenceError}`);
  if (view.projectRoot) {
    if (tab === 'policy') {
      notices.push({
        tone: 'muted',
        text: 'Saves to this project and profile',
        ...(view.canClearProject && !view.confirmProjectClear
          ? {
              action: {
                key: 'ask-clear-project-routing',
                label: 'Clear overrides',
                press: () => actions.confirmProjectClear(true),
              },
            }
          : {}),
      });
      if (view.confirmProjectClear) {
        warn('Clear all settings saved by this pane?', {
          action: { key: 'clear-project-routing', label: 'Clear all', press: actions.clearProject },
        });
        notices.push({
          tone: 'muted',
          text: view.projectClearDestination
            ? `Files stay. Classifier prompts will go to ${view.projectClearDestination}.`
            : 'Your config files and history won’t change.',
          action: {
            key: 'cancel-clear-project-routing',
            label: 'Cancel',
            press: () => actions.confirmProjectClear(false),
          },
        });
      }
    }
    if (view.help) {
      notices.push({
        tone: 'muted',
        text: `Project: ${view.projectRoot} · ${config.provider ?? 'anthropic'}`,
      });
      notices.push({
        tone: 'muted',
        text: `Pane saves use the plugin store. The pane does not write .claude/${view.projectLocalFile} or the profile file.`,
      });
    }
    if (view.help || view.projectReloadNeeded || view.projectPreferenceError)
      notices.push({
        tone: 'muted',
        text: 'Saved project settings',
        action: { key: 'refresh-project-routing', label: 'Reload', press: actions.refreshProject },
      });
  } else if (tab === 'policy' && Object.hasOwn(view, 'projectRoot'))
    warn('No verified project scope. Routing preferences cannot be saved here.');
  if (!isRouting(view)) return { notices, statesClassifier };
  const current = view.selectedModel ?? view.nativeModel;
  const missing = noticedCredentials(config, view);
  if (view.actualModel && current && !isSameModel(current, view.actualModel))
    warn(`! served by ${modelName(view.actualModel)} · native fallback`);
  if (missing && keyHelp?.id !== config.classifier) {
    // On the Classifier tab the notice leaves k to the tab: the active card's Set up on a graphical surface, the
    // Credentials row's Edit on the terminal.
    warn(`${classifierStatus(config, missing)}, keeping the model`, {
      action:
        tab === 'classifier'
          ? null
          : { key: 'key', label: 'Set up', hotkey: 'k', press: (press) => actions.key(press, config.classifier) },
    });
    statesClassifier = true;
  }
  return { notices, statesClassifier };
}

// How to add a classifier's credentials where the surface cannot open `/plugin configure`'s dialog: one zsh line that
// asks for each option (the secret hidden, nothing in the shell's history) and saves them with `claude plugin
// configure --values-stdin`, or the dialog from a terminal's claude. Null for a classifier that needs none.
const OPTION_PROMPT = {
  typesafe_api_key: 'Jev key',
  cloudflare_api_token: 'Cloudflare token',
  cloudflare_account_id: 'Cloudflare account ID',
  openai_api_key: 'OpenAI key',
};
// A word as zsh reads it: unchanged when it holds nothing the shell treats specially, otherwise single-quoted.
const shellWord = (word) => (/^[\w@.:/+-]+$/.test(word) ? word : `'${word.replaceAll("'", "'\\''")}'`);

/**
 * @param {any} config
 * @param {string} id the classifier
 * @param {string} pluginId as `claude plugin configure` takes it
 * @param {{ edit?: boolean }} [opts] changing a credential that is there, not adding a missing one
 */
export function keyHelpOf(config, id, pluginId, { edit = false } = {}) {
  const entry = config.classifiers[id];
  if (!entry) return null;
  const options = [entry.keyOption, ...endpointSettings(entry.endpoint)].filter(Boolean);
  if (!options.length) return null;
  const names = options.map((_, i) => 'KABCDEFG'[i]);
  const reads = options.flatMap((option, i) => {
    const secret = option === entry.keyOption;
    const prompt = OPTION_PROMPT[option] ?? (secret ? 'Key' : option);
    // A hidden read leaves the cursor on its line: the next prompt starts on a fresh one.
    return [
      `read -r${secret ? 's' : ''} "${names[i]}?${prompt}: "`,
      ...(secret && i < options.length - 1 ? ['echo'] : []),
    ];
  });
  const json = `{${options.map((option) => `"${option}":"%s"`).join(',')}}`;
  const values = names.map((name) => `"$${name}"`).join(' ');
  const verb = edit ? 'Change' : 'Add';
  const plugin = shellWord(pluginId);
  return {
    id,
    edit,
    title: options.includes('cloudflare_account_id')
      ? `${verb} the Cloudflare token and account ID`
      : `${verb} the ${entry.label} key`,
    sentence:
      'This app can’t open the plugin settings dialog, so add it from a terminal: this zsh line asks for it without showing the key or keeping it in your history.',
    command: `${reads.join(' && ')} && printf '${json}' ${values} | claude plugin configure ${plugin} --values-stdin; echo; unset ${names.join(' ')}`,
    alternative: `Or run claude in a terminal and type /plugin configure ${pluginId}`,
    // A plugin id with no marketplace may be refused by the CLI; the full one is in /plugin.
    note: pluginId.includes('@')
      ? null
      : 'If the command says the plugin is not found, use the full name shown by /plugin (name@marketplace).',
    // Whether the reload reaches this session's credentials is not known, so Done is the way out.
    reload: 'Then run /reload-plugins and press Done.',
  };
}

// The open key help with its Copy command and Done: an Edit's until Done, a Set up's while the classifier it is for
// still lacks a credential. `view.keyHelp` is `{ id, edit }`.
function keyHelpCardOf({ config, view, actions, pluginId }) {
  const { id, edit = false } = view.keyHelp ?? {};
  if (!id || !config.classifiers[id] || (!edit && !missingCredentials(config, view, id))) return null;
  const help = keyHelpOf(config, id, pluginId, { edit });
  return (
    help && {
      ...help,
      copy: { key: 'key-help-copy', label: 'Copy command', press: actions.copyKeyHelp },
      done: { key: 'key-help-done', label: 'Done', press: actions.keyHelpDone },
    }
  );
}

// The graphical title's short state: why routing is unavailable, the classifier's state, or, where a notice already
// states the classifier's error, a short pointer to it.
/** @returns {{ tone: import('../tokens.mjs').Tone, text: string }} */
function titleStatus(config, view, statesClassifier) {
  if (view.phase === 'unavailable') return { tone: 'warning', text: 'unavailable · Claude’s model is kept' };
  if (statesClassifier) return { tone: 'warning', text: `${classifierLabel(config)} needs attention` };
  return classifierState(config, view);
}

// The classifier's missing credentials the notices name under the tab row: only while routing is on and available.
const noticedCredentials = (config, view) =>
  isRouting(view) ? missingCredentials(config, view, config.classifier) : null;

// Which tabs hold an unsaved draft.
function unsavedTabs(config, view) {
  const changes = routingChanges(config, view);
  return {
    routes: changes.tiers.length + changes.cells.length + Number(changes.mode) > 0,
    policy: changes.policy.length + Number(changes.baseline) > 0,
  };
}

// Success for a write or its undo, danger for a refused write, warning for everything else that needs a look.
/** @returns {import('../tokens.mjs').Tone} */
const noticeTone = (notice) =>
  /^(Not saved|Save status unknown)/.test(notice)
    ? 'danger'
    : /^(Saved|Released|Undid|Path copied)/.test(notice)
      ? 'success'
      : 'warning';

/**
 * What each pane tab's model and the frame read: the config, the router view and its usage, the pane's actions, the
 * models the route editor offers, the pane's width (null for none), the clock, the surface and the plugin's id.
 * @typedef {object} PaneContext
 * @property {any} config
 * @property {any} view
 * @property {any} usage
 * @property {any} actions
 * @property {string[]} modelOptions
 * @property {number | null} columns
 * @property {number} now
 * @property {string | undefined} surface
 * @property {string} pluginId
 */

// The pane shows the pending project overrides as fields on Routes and Policy, or just a count elsewhere.
function saveBarOf({ config, view, actions }, tab) {
  const changes = routingChanges(config, view);
  const rows = [];
  const row = (key, label, before, after) => rows.push({ key, label, before, after });
  for (const tier of changes.tiers)
    row(
      `routes.${tier}`,
      `${tierLabel(tier)} route`,
      routeName(config, config.routes[tier]),
      routeName(config, changes.draft.routes[tier]),
    );
  const tierWords = (tier) => ({ terminal: tier, graphical: tierLabel(tier) });
  if (changes.baseline)
    row('baselineTier', 'Start tier', tierWords(config.baselineTier), tierWords(changes.draft.baselineTier));
  const draft = { ...config, ...changes.draft };
  const cellName = (c, activity, tier) => {
    const cell = c.activities[activity]?.[tier];
    if (cell === null) return { terminal: 'tier model (explicit)', graphical: 'Tier model (explicit)' };
    return cell ? routeName(c, resolveRoute(c, tier, activity)) : { terminal: 'no override', graphical: 'No override' };
  };
  for (const [activity, tier] of changes.cells)
    row(
      `activities.${activity}.${tier}`,
      `${activity} at ${tierLabel(tier)}`,
      cellName(config, activity, tier),
      cellName(draft, activity, tier),
    );
  const modeWords = (mode) => ({ terminal: mode, graphical: sentence(mode) });
  if (changes.mode)
    row(
      'activityRouting',
      'Activity routing',
      modeWords(config.activityRouting),
      modeWords(changes.draft.activityRouting),
    );
  for (const [key, label, format, field] of POLICY_ROWS.filter(([name]) => changes.policy.includes(name)))
    row(field, label, format(changes.saved[key]), format(changes.tuning[key]));
  const { count } = changes;
  const listed = DRAFT_TABS.includes(tab);
  const confirms = Boolean(view.lastWrite && /^(Saved|Released)/.test(view.notice ?? ''));
  return {
    count,
    // On Routes and Policy the changes are listed; elsewhere only counted.
    listed,
    rows,
    pending: {
      tone: /** @type {import('../tokens.mjs').Tone} */ ('warning'),
      text: `● ${count} unsaved routing change${count === 1 ? '' : 's'}`,
    },
    elsewhere: 'listed on Routes and Policy',
    title: 'Unsaved changes',
    hint: listed ? plural(count, 'change') : `${plural(count, 'change')}, listed on Routes and Policy`,
    columns: { label: 'Setting', before: 'Before', after: 'After' },
    save: { key: 'save-routing', label: 'Save', hotkey: 's', press: actions.saveRouting },
    discard: { key: 'discard-routing', label: 'Discard', hotkey: 'd', press: actions.discardRouting },
    notice: view.notice ? { tone: noticeTone(view.notice), text: view.notice } : null,
    // Undo beside a notice that confirms the write, else on its own line under the write it undoes.
    undo: view.lastWrite
      ? {
          key: 'undo',
          label: 'Undo',
          hotkey: 'u',
          press: actions.undo,
          confirms,
          last: `Last change: ${view.lastWrite.label}`,
        }
      : null,
  };
}
// What the numbers mean, behind `?`: the same paragraphs under the terminal's head and on a card. The tier paragraph
// draws the tiers' bars inline on the terminal and as their meters, low to high, on a card.
const HELP = {
  head: 'ABOUT THESE NUMBERS',
  title: 'About the router',
  paragraphs: [
    { text: '≈$ is tokens × configured API rates in router.json (list/custom).' },
    { text: 'These are estimates, not invoices or measured plan-quota savings.' },
    {
      text: 'No routing: your model on the main thread, Claude Code’s pick per agent, same tokens and output length. Answer quality is not measured.',
    },
    {
      text: 'For the whole session cost, with side calls such as titles and compaction that the router does not see, run /cost.',
    },
    { text: 'Plan bars are Claude Code’s 5-hour and 7-day readings.' },
    {
      text: {
        terminal: 'Tiers show as bars ▂▄▆█, low to high; a route never moves past 80% of its window.',
        graphical: 'Tiers show as rising bars, low to high; a route never moves past 80% of its window.',
      },
      tiers: TIERS,
    },
  ],
};

/**
 * @typedef {object} SaveBar the one place for commit state: the unsaved draft, the last notice, Undo
 * @property {number} count
 * @property {boolean} listed the changes are listed (Routes and Policy), not only counted
 * @property {{ key: string, label: string, before: import('./format.mjs').Words, after: import('./format.mjs').Words }[]} rows
 * @property {{ tone: import('../tokens.mjs').Tone, text: string }} pending
 * @property {string} elsewhere
 * @property {string} title
 * @property {string} hint
 * @property {{ label: string, before: string, after: string }} columns
 * @property {{ key: string, label: string, hotkey: string, press: () => void }} save
 * @property {{ key: string, label: string, hotkey: string, press: () => void }} discard
 * @property {{ tone: import('../tokens.mjs').Tone, text: string } | null} notice
 * @property {{ key: string, label: string, hotkey: string, press: () => void, confirms: boolean, last: string } | null} undo
 *
 * @typedef {object} FrameModel Everything the pane draws around a tab.
 * @property {string} mode the router's mode
 * @property {{ value: string, label: import('./format.mjs').Words, hotkey: string }[]} power the on and off choices
 * @property {{ reason: string, cleanup: string[] } | null} unavailable why routing is unavailable
 * @property {{ tone: import('../tokens.mjs').Tone, text: string, repeated: boolean }} classifier its state, and whether the notices say it again
 * @property {boolean} helpOpen
 * @property {typeof HELP | null} help
 * @property {import('./format.mjs').Words | null} profile
 * @property {ReturnType<typeof keyHelpCardOf>} keyHelp
 * @property {{ value: string, options: { value: string, label: string }[] }} engine
 * @property {Notice[]} notices
 * @property {{ tone: import('../tokens.mjs').Tone, text: string }} status the graphical title's short state
 * @property {Record<string, boolean>} unsaved which tabs hold an unsaved draft
 * @property {SaveBar} bar
 */
/**
 * Everything the pane draws around a tab, as data: the warnings, the key help card, the title's state, the save bar and
 * the help.
 * @param {PaneContext} ctx
 * @param {string} tab the shown tab's id
 * @returns {FrameModel}
 */
export function frameOf(ctx, tab) {
  const { config, view } = ctx;
  // Only a graphical surface cannot open `/plugin configure`'s dialog.
  const keyHelp = isGraphical(ctx.surface) ? keyHelpCardOf(ctx) : null;
  const { notices, statesClassifier } = noticesOf(ctx, tab, keyHelp);
  const unavailable = view.phase === 'unavailable';
  const state = classifierState(config, view);
  // The notices under the tab row name missing credentials with their remedy; the terminal's header points there.
  const missing = noticedCredentials(config, view);
  return {
    mode: view.mode,
    power: [
      { value: 'auto', label: { terminal: 'on', graphical: 'On' }, hotkey: 'o' },
      { value: 'manual', label: { terminal: 'off', graphical: 'Off' }, hotkey: 'f' },
    ],
    // The configured engine; it applies from the next turn, as the on/off pair does.
    engine: {
      value: config.routingEngine,
      options: ROUTING_ENGINES.map((value) => ({ value, label: value })),
    },
    unavailable: unavailable
      ? { reason: unavailableReason(view), cleanup: view.error === GATEWAY_SETTINGS ? GATEWAY_CLEANUP : [] }
      : null,
    classifier: { ...state, repeated: Boolean(missing && state.text === classifierStatus(config, missing)) },
    helpOpen: Boolean(view.help),
    help: view.help ? HELP : null,
    profile: profileOf(config, view),
    keyHelp,
    notices,
    status: titleStatus(config, view, statesClassifier),
    unsaved: unsavedTabs(config, view),
    bar: saveBarOf(ctx, tab),
  };
}
