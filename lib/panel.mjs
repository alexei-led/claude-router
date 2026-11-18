import { compareRoutes } from './activity.mjs';
import { latencyP95, readMetrics, readStore, storeSummary } from './activity-stats.mjs';
import {
  ACTIVITIES,
  ACTIVITY_MODES,
  activeClassifier,
  defaultsFor,
  effectiveActivities,
  effectiveRoutes,
  endpointSettings,
  ROUTING_MODES,
  resolveRoute,
  sameCell,
  sameRoute,
  TIERS,
  tuningOf,
} from './config.mjs';
import { effortSharesCache } from './cost.mjs';
import { resetText } from './costs.mjs';
import { decisionLines } from './decisions.mjs';
import {
  API_ESTIMATE,
  activityReading,
  baselineName,
  cardRoute,
  classifierLabel,
  classifierState,
  classifierStatus,
  comparedModel,
  costText,
  diffText,
  EARLY_NOTE,
  formatTokens,
  GATEWAY_CLEANUP,
  GATEWAY_SETTINGS,
  limitTone,
  liveUsage,
  missingCredentials,
  missingText,
  modeLever,
  modelName,
  percent,
  percentPair,
  probeOf,
  reasonActivity,
  repliesText,
  routeLabel,
  routeName,
  routingModeOf,
  routingModeText,
  sessionCost,
  sessionUsage,
  shortReason,
  shortRoute,
  shownConfig,
  signedUsd,
  switchesLost,
  unavailableReason,
  uncomparedText,
  unpricedLine,
  usageMetrics,
  usd,
  whyText,
} from './display.mjs';
import { isSameModel } from './route.mjs';
import { graphicalClassifier } from './ui/graphical/classifier.mjs';
import { graphicalHelp, graphicalKeyHelp, graphicalProfile, graphicalSaveBar } from './ui/graphical/frame.mjs';
import { graphicalNow } from './ui/graphical/now.mjs';
import { graphicalPolicy } from './ui/graphical/policy.mjs';
import { graphicalRoutes } from './ui/graphical/routes.mjs';
import { renderShell } from './ui/graphical/shell.mjs';
import { graphicalUsage } from './ui/graphical/usage.mjs';
import { usageOf } from './ui/model/usage.mjs';
import { plural, sentence, tierLabel } from './ui/model/words.mjs';
import { orTerminal, paintersOf } from './ui/painter.mjs';
import { sinceText } from './ui/strip.mjs';
import { terminalClassifier } from './ui/terminal/classifier.mjs';
import { terminalNow } from './ui/terminal/now.mjs';
import { terminalPolicy } from './ui/terminal/policy.mjs';
import { terminalRoutes } from './ui/terminal/routes.mjs';
import { terminalUsage } from './ui/terminal/usage.mjs';
import { isGraphical, savingTone, toneColor } from './ui/tokens.mjs';

// Routes and Policy edit one draft and save together; Classifier saves each pick at once.
const TABS = [
  ['now', '1', 'Now'],
  ['routes', '2', 'Routes'],
  ['policy', '3', 'Policy'],
  ['classifier', '4', 'Classifier'],
  ['usage', '5', 'Usage'],
];
const DRAFT_TABS = ['routes', 'policy'];
const TUNING_CHOICES = {
  timeoutMs: [500, 1000, 1500, 3000, 5000],
  downgradeVotes: [1, 2, 3],
  horizon: [1, 3, 5, 10],
  cashCapUsd: [0.5, 1, 2, 5],
  activityMass: [0.5, 0.6, 0.7, 0.8],
};
const LADDER = [...TIERS].reverse();
// The effort option that sends no effort of its own: the request keeps the one Claude Code sends.
const SESSION_EFFORT = 'session';
const INHERIT = 'inherit';
// The Routes grid's marks, as its legend explains them, each in its tone.
// `card` is the glyph a card draws where the terminal's is too slight in a Button.
/** @type {Record<string, { glyph: string, card?: string, tone: import('./ui/tokens.mjs').Tone, text: string }>} */
const ROUTE_MARKS = {
  inherits: { glyph: '·', card: '—', tone: 'muted', text: 'runs the tier’s model' },
  preset: { glyph: '°', tone: 'muted', text: 'built-in default' },
  edited: { glyph: '●', tone: 'warning', text: 'unsaved' },
};
const UNPRICED_OUTPUT = '$? out';

// The Routes grid's row of the tiers' own routes; every other row is an activity.
const TIER_ROW = 'tier';

const ACTIVITY_MODE_HINT = {
  off: 'not asked; every turn runs its tier’s model',
  on: 'an activity can change its tier’s model',
};
// What `subagentRouting` does, under the router.json path: it is set in the file, not in the pane.
const SUBAGENT_LINE = {
  off: 'Subagents keep their own model (subagentRouting off).',
  on: 'Subagents: on. Agents that pin no model get one at spawn, kept for every step.',
};
// The same on a card, which names no router.json key.
const SUBAGENT_CARD = {
  off: 'Subagents keep their own model.',
  on: 'Subagents that pin no model get one at spawn, kept for every step.',
};
const EFFORT_SHORT = { low: 'low', medium: 'med', high: 'high', xhigh: 'xh', max: 'max', [INHERIT]: 'inh' };

// The route draft the Routes and Policy tabs edit: the saved routes, activity overrides and mode until the person
// changes one.
export function routeDraftOf(config, view) {
  if (view.routeDraft) return view.routeDraft;
  const base = structuredClone({
    ...(config.provider && config.provider !== 'anthropic' ? { provider: config.provider } : {}),
    routes: config.routes,
    baselineTier: config.baselineTier,
    activities: config.activities,
    activityRouting: config.activityRouting,
  });
  return { ...structuredClone(base), base };
}

const dollars = (value) => (Number.isFinite(value) ? usd(value) : 'not reported');
// The host and port as the request sees them: user info before an `@` is not the host. An endpoint that does not
// parse, such as one with a placeholder in its host, shows as written up to its path, and is not this machine.
function urlOf(endpoint) {
  try {
    return new URL(endpoint);
  } catch {
    return null;
  }
}
const hostOf = (endpoint) => urlOf(endpoint)?.host ?? endpoint.replace(/^https?:\/\//, '').split('/')[0];
const LOCAL_HOSTS = ['127.0.0.1', 'localhost', '[::1]'];
const isLocal = (endpoint) => LOCAL_HOSTS.includes(urlOf(endpoint)?.hostname);
const windowSize = (tokens) => (tokens >= 1e6 ? `${tokens / 1e6}M` : `${Math.round(tokens / 1e3)}K`);
const contextSuffix = (metrics) =>
  Number.isFinite(metrics.nextContext)
    ? `~${formatTokens(metrics.nextContext)} / ${formatTokens(metrics.window)}`
    : 'no reading yet';

export function renderPanel(elements, config, view, usage, actions, opts = {}) {
  return orTerminal(
    opts.surface,
    (surface) => drawPanel(elements, config, view, usage, actions, { ...opts, surface }),
    opts.onFallback,
  );
}

function drawPanel(
  elements,
  config,
  view,
  usage,
  actions,
  {
    modelOptions = Object.keys(config.models),
    columns = null,
    now = Date.now(),
    surface = undefined,
    pluginId = 'router',
  } = {},
) {
  const ui = paintersOf(elements, surface);
  const tab = TABS.some(([id]) => id === view.tab) ? view.tab : 'now';
  const body = { now: nowTab, routes: routesTab, policy: policyTab, classifier: classifierTab, usage: usageTab }[tab];
  const graphical = isGraphical(surface);
  const { lines: notices, statesClassifier } = noticeLines(ui, config, view, actions, graphical, tab, pluginId);
  const profile = profileOf(config, view);
  const content = body(ui, config, view, usage, actions, modelOptions, columns, now, surface);
  const bar = saveBarOf(config, view, tab, actions);
  if (graphical)
    return renderShell(
      ui,
      view,
      tab,
      actions,
      [
        ...(view.help ? [graphicalHelp(ui, HELP)] : []),
        ...(profile ? [graphicalProfile(ui, profile)] : []),
        ...content,
      ],
      {
        tabs: TABS,
        unsaved: unsavedTabs(config, view),
        notices,
        status: titleStatus(config, view, statesClassifier),
        bar: graphicalSaveBar(ui, bar),
      },
    );
  const preface = [...(view.help ? helpLines(ui) : []), ...(profile ? [ui.dim(profile.terminal)] : [])];
  // No Close button: Esc and the pane's own close dismiss it.
  return ui.Box({
    flexDirection: 'column',
    children: [
      ...header(ui, config, view, tab, actions, notices, columns),
      ...preface,
      ...content,
      ...statusBar(ui, bar),
    ],
  });
}

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

// The warnings that apply to the next turn, drawn once under the tab row on every tab: an ignored project config, a
// native fallback, and classifier credentials that are missing. They matter only while routing is on. The graphical
// pane has no header text for an unavailable router, so its reason joins them, and its title states the classifier's
// error only where no notice does. `statesClassifier` says whether one does.
function noticeLines(ui, config, view, actions, graphical, tab, pluginId) {
  const unavailable = view.phase === 'unavailable';
  const out = [];
  let statesClassifier = false;
  // A graphical Set up opens how to add the credentials here, in place of their notice, until they are there.
  const keyHelp = graphical ? keyHelpCardOf(config, view, actions, pluginId) : null;
  if (keyHelp) {
    out.push(graphicalKeyHelp(ui, keyHelp));
    // In place of the credentials notice it states their lack; an Edit's card, with nothing missing, states nothing.
    statesClassifier = keyHelp.id === config.classifier && Boolean(noticedCredentials(config, view));
  }
  if (graphical && unavailable) {
    out.push(ui.notice('warning', unavailableReason(view)));
    if (view.error === GATEWAY_SETTINGS) for (const line of GATEWAY_CLEANUP) out.push(ui.notice('warning', line));
  }
  // Missing credentials have their own notice below, with Set up; this one would say them a second time.
  if (graphical && !unavailable && view.error && !['missing-key', 'missing-account'].includes(view.error)) {
    out.push(ui.notice('warning', classifierStatus(config, view.error)));
    statesClassifier = true;
  }
  if (view.mode !== 'auto' || unavailable) return { lines: out, statesClassifier };
  const current = view.selectedModel ?? view.nativeModel;
  const missing = noticedCredentials(config, view);
  if (view.projectError) out.push(ui.notice('warning', `  Ignored: ${view.projectError}`));
  if (view.actualModel && current && !isSameModel(current, view.actualModel))
    out.push(ui.notice('warning', `  ! served by ${modelName(view.actualModel)} · native fallback`));
  if (missing && keyHelp?.id !== config.classifier) {
    // On the Classifier tab the notice leaves k to the tab: the active card's Set up on a graphical surface, the
    // Credentials row's Edit on the terminal.
    const setUp =
      tab === 'classifier'
        ? null
        : ui.Button({
            key: 'key',
            label: 'Set up',
            hotkey: 'k',
            onPress: (press) => actions.key(press, config.classifier),
          });
    out.push(ui.notice('warning', `  ${classifierStatus(config, missing)}, keeping the model  `, setUp));
    statesClassifier = true;
  }
  return { lines: out, statesClassifier };
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
function keyHelpCardOf(config, view, actions, pluginId) {
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
/** @returns {{ tone: import('./ui/tokens.mjs').Tone, text: string }} */
function titleStatus(config, view, statesClassifier) {
  if (view.phase === 'unavailable') return { tone: 'warning', text: 'unavailable · Claude’s model is kept' };
  if (statesClassifier) return { tone: 'warning', text: `${classifierLabel(config)} needs attention` };
  return classifierState(config, view);
}

// The classifier's missing credentials the notices name under the tab row: only while routing is on and available.
const noticedCredentials = (config, view) =>
  view.mode === 'auto' && view.phase !== 'unavailable' ? missingCredentials(config, view, config.classifier) : null;

// Which tabs hold an unsaved draft.
function unsavedTabs(config, view) {
  const changes = routingChanges(config, view);
  return {
    routes: changes.tiers.length + changes.cells.length + Number(changes.mode) > 0,
    policy: changes.policy.length + Number(changes.baseline) > 0,
  };
}

// Routing's state, its one mode control and the classifier's state on one line. While routing is unavailable, on and
// off would change nothing, so the line says why instead of offering them.
function routingState(ui, config, view, actions, help) {
  const end = help ? ['  ', help] : [];
  if (view.phase === 'unavailable')
    return [
      ui.line(
        ui.head('ROUTER'),
        '  ',
        ui.text('unavailable', { color: 'yellow' }),
        ui.dim('  Claude’s model is kept'),
        ...end,
      ),
      ui.text(unavailableReason(view), { color: 'yellow' }),
      ...(view.error === GATEWAY_SETTINGS ? GATEWAY_CLEANUP.map((line) => ui.text(line, { color: 'yellow' })) : []),
    ];
  const state = classifierState(config, view);
  // The notices under the tab row name missing credentials with their remedy; the header points there.
  const missing = noticedCredentials(config, view);
  const repeated = missing && state.text === classifierStatus(config, missing);
  // A radio pair, marked as the Classifier tab marks its active row.
  const option = (mode, label, hotkey) =>
    ui.Button({
      key: mode,
      label: `${view.mode === mode ? '◉' : '○'} ${label}`,
      hotkey,
      variant: view.mode === mode ? 'primary' : 'secondary',
      onPress: () => actions.mode(mode),
    });
  return [
    ui.line(
      ui.head('ROUTER'),
      '  ',
      option('auto', 'on', 'o'),
      ' ',
      option('manual', 'off', 'f'),
      '  ',
      repeated ? ui.dim('see below') : ui.text(state.text, { color: toneColor(state.tone, 'terminal') }),
      ...end,
    ),
  ];
}

// The tabs carry their number keys in their labels, so every key the pane answers is on screen. A row wider than the
// pane drops the digits (the keys still answer), and then moves ? to the header line's end, so Ink never squeezes the
// spaces between the tabs away.
function header(ui, config, view, tab, actions, notices, columns) {
  const unsaved = unsavedTabs(config, view);
  const labels = (numbered) =>
    TABS.map(([id, hotkey, label]) => `${numbered ? `${hotkey} ` : ''}${label}${unsaved[id] ? ' ●' : ''}`);
  // As drawn: a Button is its label in `[ ` and ` ]`, a space after each tab.
  const width = (tabs, withHelp) => tabs.reduce((n, name) => n + name.length + 5, 0) + (withHelp ? 5 : -1);
  const fits = (tabs, withHelp) => !Number.isFinite(columns) || width(tabs, withHelp) <= columns;
  const digits = fits(labels(true), true);
  const names = labels(digits);
  const help = ui.Button({
    key: 'help',
    label: '?',
    variant: view.help ? 'primary' : 'secondary',
    onPress: actions.help,
  });
  const helpOnRow = fits(names, true);
  return [
    ...routingState(ui, config, view, actions, helpOnRow ? null : help),
    ui.line(
      ...TABS.flatMap(([id, hotkey], i) => [
        i ? ' ' : null,
        ui.Button({
          key: `tab-${id}`,
          label: names[i],
          hotkey,
          variant: tab === id ? 'primary' : 'secondary',
          onPress: () => actions.tab(id),
        }),
      ]),
      ...(helpOnRow ? [' ', help] : []),
    ),
    ...notices,
    ui.text(' '),
  ];
}

// "Jev 93% ≥ 90% · switch ≈ $0.48": the support for the switch the policy weighed against the bar it set, and the switch
// cost. Null without a reading.
function supportText(label, estimate) {
  if (!Number.isFinite(estimate?.threshold)) return null;
  const mass = Number.isFinite(estimate.upgradeMass) ? estimate.upgradeMass : estimate.downgradeMass;
  const cost = Number.isFinite(estimate.taxUsd) ? ` · switch ≈ ${usd(estimate.taxUsd)}` : '';
  if (!Number.isFinite(mass)) return `${label} needs ${percent(estimate.threshold)}${cost}`;
  const [gave, needs] = percentPair(mass, estimate.threshold);
  return `${label} ${gave} ${mass >= estimate.threshold ? '≥' : '<'} ${needs}${cost}`;
}

// Three questions, in order: what runs next and why, what the plan and the session cost, and how full the context is.
// The cost table, today’s totals and the subagent list are on Usage. The model holds the readings as text, numbers and
// tones; the terminal draws it as rows and the graphical surfaces as cards.
function nowTab(ui, config, view, usage, actions, _modelOptions, columns, now, surface) {
  const model = nowOf(config, view, usage, actions, now);
  return isGraphical(surface) ? graphicalNow(ui, model, { columns, now }) : terminalNow(ui, model, { columns, now });
}

function nowOf(config, view, usage, actions, now) {
  const cost = sessionCost(config, view, usage, now);
  return {
    next: nextOf(config, view, actions),
    decisions: view.decisionRows?.length ? decisionLines(view.decisionRows, 5) : [],
    plan: cost.limits.map((limit) => ({
      label: limit.label,
      percent: limit.percent,
      tone: limitTone(limit.percent),
      reset: resetText(limit.resetsAt, now),
    })),
    session: sessionOf(config, view, cost, actions, now),
    context: contextOf(config, view, usage, actions, now),
  };
}

// NEXT TURN. With routing off or unavailable only the model applies: no tier, activity or reason from an earlier turn.
function nextOf(config, view, actions) {
  const unavailable = view.phase === 'unavailable';
  const current = view.selectedModel ?? view.nativeModel;
  if (unavailable)
    return {
      state: 'unavailable',
      label: routeLabel(view.nativeModel, view.nativeEffort),
      note: 'routing unavailable · Claude’s model',
      pinNote: 'needs routing',
      // A card's words: a sentence, and the pin's state without the terminal's hotkey.
      card: { note: 'Routing unavailable · Claude’s model', pin: 'Pinning needs routing' },
    };
  if (view.mode !== 'auto')
    return {
      state: 'off',
      label: routeLabel(current, view.effort),
      note: 'routing off · /model choice',
      pinNote: 'needs routing on (o)',
      card: { note: 'Routing off · /model choice', pin: 'Pinning needs routing on' },
    };
  const mode = config.activityRouting;
  const reading = mode === 'off' ? null : activityReading(view);
  const shown = shownConfig(config, view);
  const base = view.tier ? resolveRoute(shown, view.tier) : null;
  const override =
    mode === 'on' && view.activity && base && !sameRoute(resolveRoute(shown, view.tier, view.activity), base);
  const { mode: routingMode, source } = routingModeOf(view);
  const lever = modeLever(config, view);
  return {
    state: 'routed',
    label: routeLabel(current, view.effort),
    tier: view.tier ?? null,
    reading: reading && {
      choice: reading.choice,
      isActivity: ACTIVITIES.includes(reading.choice),
      share: reading.share || null,
      other: reading.others[0] ?? null,
    },
    phase: view.taskPhase ? `phase ${view.taskPhase} · route activity ${view.activity ?? 'base'}` : null,
    why: view.reason ? shortReason(view.reason, reasonActivity(config, view)) : null,
    support: supportText(classifierLabel(config), view.estimate),
    override: override ? `${whyText(config, view)} · tier route ${routeName(shown, base)}` : null,
    mode:
      routingMode !== 'balanced' || source === 'session'
        ? {
            name: routingMode,
            from: `from ${source}${lever ? ` · ${lever} on this tier` : ''}`,
            clear: source === 'session' ? '/router mode default clears it' : null,
            // A card's: the mode as a label.
            card: [
              `${sentence(routingMode)} mode from ${source}${lever ? ` · ${lever} on this tier` : ''}`,
              source === 'session' ? '/router mode default clears it' : null,
            ]
              .filter(Boolean)
              .join(' · '),
          }
        : null,
    // One per tier, low to high: the route it runs and the classifier's support on the last turn.
    pins: TIERS.map((tier) => {
      const support = view.probabilities?.[tier];
      return {
        tier,
        route: shortRoute(config, resolveRoute(shown, tier)),
        // A graphical pin's label: the model's family and the effort, as the Routes cards word them.
        label: cardRoute(config, resolveRoute(shown, tier), { short: true }),
        support: Number.isFinite(support) ? percent(support) : null,
        // A graphical pin's reading: `current` on the tier that runs now, then the support; null with neither.
        reading:
          [tier === view.tier ? 'current' : null, Number.isFinite(support) ? percent(support) : null]
            .filter(Boolean)
            .join(' · ') || null,
      };
    }),
    pendingPin: view.pendingPin ?? null,
    // A card's line before the first routed turn, where the terminal shows none.
    card: { firstTurn: 'No routed turn yet — the first reply sets the route.' },
    // A press pins the next turn; pressing the pending pin again unpins it.
    pick: (tier) => (view.pendingPin === tier ? actions.unpin() : actions.pin(tier)),
  };
}

// The session's empty states: no reply carries a price, or no reply yet.
const UNPRICED_SESSION = { terminal: 'no priced replies: cost unknown', graphical: 'No priced replies: cost unknown' };
const EMPTY_SESSION = { terminal: 'no replies yet', graphical: 'No routed replies yet' };

// The estimate's billing product is context, never evidence of an invoice or measured quota use.
function billingWords(cost) {
  if (cost.billing === 'plan') return `${API_ESTIMATE} · plan quota, not a charge`;
  if (cost.billing === 'mixed') return `${API_ESTIMATE} · credits ${costText(cost.creditsUsd, cost.billing)}`;
  return `${API_ESTIMATE} · configured rates, not an invoice`;
}

// SESSION: one total with the subagents, the difference against no routing, the main thread and the subagents on one
// scale, then the replies by tier.
function sessionOf(config, view, cost, actions, now) {
  const since = liveUsage(view, view.usageSession).since;
  const switches = sessionUsage(view, now).switches;
  const switchCount = switches.tier + switches.activity;
  const head = [
    Number.isFinite(since) ? `since ${sinceText(since, now)}` : null,
    cost.replies ? plural(cost.replies, 'reply', 'replies') : null,
    cost.agents ? plural(cost.agents, 'agent') : null,
    switchCount ? plural(switchCount, 'switch', 'switches') : null,
  ].filter(Boolean);
  const compared = cost.diffUsd !== null;
  const r = cost.readout;
  const priced = Boolean(cost.replies || cost.agents);
  // A part's difference against no routing, and what it is measured against.
  const against = (diff, versus) => (diff === null ? null : { usd: diff, text: signedUsd(diff), versus });
  return {
    head: head.join(' · '),
    running: view.subagentsRunning ?? 0,
    bandDetail: Boolean(view.bandDetail),
    toggleDetail: actions.toggleDetail,
    // The band's second row, on and off: the terminal's SESSION line names the band's rows, a card the setting.
    detailToggle: view.bandDetail
      ? { terminal: 'band: 1 row', graphical: 'Hide session row in band' }
      : { terminal: 'band: 2 rows', graphical: 'Show session row in band' },
    // Replies without a list price reach the strip but not the usage record: the tiers still show, the cost cannot.
    priced,
    empty: priced ? null : view.strip?.cells?.length ? UNPRICED_SESSION : EMPTY_SESSION,
    strip: view.strip,
    since,
    total: costText(cost.totalUsd, cost.billing),
    billing: billingWords(cost),
    usage: () => actions.usageFor('session'),
    diff: compared
      ? {
          usd: cost.diffUsd,
          text: diffText(cost.diffUsd, cost.baseUsd),
          tone: savingTone(cost.diffUsd),
          versus: baselineName(view, sessionUsage(view, now), cost),
          of: costText(cost.baseUsd, cost.billing),
        }
      : null,
    note: compared
      ? cost.early
        ? `${repliesText(cost)}: ${EARLY_NOTE}`
        : null
      : cost.effortOnly
        ? 'effort routing on one model: no saving is estimated'
        : cost.uncomparedReplies
          ? `${uncomparedText(cost)}: no saving shown`
          : null,
    scale: Math.max(cost.mainUsd, cost.agentUsd),
    parts: [
      {
        name: 'main',
        usd: cost.mainUsd,
        amount: costText(cost.mainUsd, cost.billing),
        against: against(
          compared && cost.replies ? cost.mainDiff : null,
          comparedModel(config, view, sessionUsage(view, now)),
        ),
      },
      ...(cost.agents
        ? [
            {
              name: 'agents',
              usd: cost.agentUsd,
              amount: costText(cost.agentUsd, cost.billing),
              against: against(compared ? cost.agentDiff : null, 'their picks'),
            },
          ]
        : []),
    ],
    effortMix: cost.effortOnly ? cost.effortMix : [],
    lost: Boolean(cost.comparable && !r.early && switchesLost(r)),
    policy: () => actions.tab('policy'),
  };
}

// A card's words behind Context's Details: Claude's readings of the last reply in one line, and the input per reply as a
// trend from the oldest reply to the latest, with its range.
function detailCard(observed, view, history) {
  const low = formatTokens(Math.min(...history));
  const high = formatTokens(Math.max(...history));
  const replies = `last ${plural(history.length, 'reply', 'replies')}`;
  return {
    readings: `Observed ${formatTokens(observed)} · estimated ${formatTokens(view.contextTokens)} · cache read ${formatTokens(view.cacheRead)} · written ${formatTokens(view.cacheWrite)} · output ${formatTokens(view.outputTokens)} tokens`,
    input: `Input per reply · ${replies}`,
    trend: history.length
      ? {
          points: history,
          labels: ['Oldest', 'Latest'],
          alt: `Input per reply over the ${replies}: ${low} to ${high} tokens`,
          tone: /** @type {import('./ui/tokens.mjs').Tone} */ ('accent'),
        }
      : null,
    range: history.length ? `${low} lowest · ${high} highest` : null,
    empty: 'No replies yet',
    estimates: 'Estimates · configured API rates',
  };
}

// The readings' colours from usageMetrics as tones, so the thresholds stay in display.mjs.
/** @type {Record<string, import('./ui/tokens.mjs').Tone>} */
const COLOR_TONE = { red: 'danger', yellow: 'warning', green: 'success', gray: 'muted' };

// A reading's tone on a card: its own where it warns, else the card's ordinary one.
/** @returns {import('./ui/tokens.mjs').Tone} */
const alertOr = (tone, ordinary) => (tone === 'warning' || tone === 'danger' ? tone : ordinary);

// CONTEXT: the window's fill on the model that runs next, and the cache reuse of the last reply and of the session.
function contextOf(config, view, usage, actions, now) {
  const metrics = usageMetrics(config, view, usage);
  const session = sessionUsage(view, now).observed;
  const fill = metrics.contextBar.percent;
  const history = view.history ?? [];
  const { comparison } = view;
  return {
    fill,
    fillTone: COLOR_TONE[metrics.contextBar.color],
    // A card keeps the accent until the fill warns.
    graphicalFillTone: alertOr(COLOR_TONE[metrics.contextBar.color], 'accent'),
    suffix: contextSuffix(metrics),
    empty: 'no reading yet',
    card: { empty: 'No reading yet' },
    // The cache reuse of the last reply and of the session, each a figure and its words.
    cache: {
      tone: COLOR_TONE[metrics.cacheBar.color],
      // A card writes the figure in the text colour until the reuse warns.
      graphicalTone: alertOr(COLOR_TONE[metrics.cacheBar.color], 'primary'),
      last: metrics.cacheBar.percent === null ? null : { figure: `${metrics.cacheBar.percent}%`, words: 'last reply' },
      session: session.inputTokens
        ? { figure: percent(session.cacheReadTokens / session.inputTokens), words: 'session' }
        : null,
      empty: 'no reply yet',
      card: { empty: 'No reply yet' },
    },
    detail: {
      open: Boolean(view.usageDetail),
      toggle: actions.usageDetail,
      observed: metrics.observed,
      estimated: view.contextTokens,
      cacheRead: view.cacheRead,
      cacheWrite: view.cacheWrite,
      output: view.outputTokens,
      history,
      tiers: view.tiers ?? [],
      replies: `last ${plural(history.length, 'reply', 'replies')}`,
      card: detailCard(metrics.observed, view, history),
      // The estimates the last decision weighed, as label and value.
      estimates: [
        ['Cache hits saved', dollars(metrics.cacheBenefit)],
        Number.isFinite(view.estimate?.taxUsd) ? ['Switch cost', dollars(view.estimate.taxUsd)] : null,
        ...(comparison
          ? [
              ['Compared tiers', `${comparison.incumbent} → ${comparison.candidate}`],
              ['Next-turn difference', `${signedUsd(comparison.minUsd)} to ${signedUsd(comparison.maxUsd)}`],
              [
                'Payback',
                comparison.paybackTurns === null ? 'none projected' : `${comparison.paybackTurns} later turns`,
              ],
            ]
          : []),
      ].filter(Boolean),
    },
  };
}

// Rows: [key, label, format, router.json field]. Typed as tuples so tsc keeps each position's type.
/** @type {[string, string, (value: number) => string, string][]} */
export const POLICY_ROWS = [
  ['downgradeVotes', 'Votes to go down', String, 'policy.downgradeVotes'],
  ['horizon', 'Payback horizon', (v) => plural(v, 'turn'), 'policy.downgradeHorizonTurns'],
  ['cashCapUsd', 'Credits cap', (v) => `$${v.toFixed(2)}`, 'policy.cashCapUsd'],
  ['activityMass', 'Activity threshold', percent, 'policy.activityMass'],
];

// What Routes and Policy changed and have not saved: tiers, baseline, activity cells and mode against the saved config,
// policy values against the values the draft started from. `cells` lists [activity, tier] pairs.
export function routingChanges(config, view) {
  const raw = routeDraftOf(config, view);
  const draft = { ...effectiveRoutes(raw, config), ...effectiveActivities(raw, config) };
  const saved = tuningOf(config);
  const base = view.tuningBase ?? saved;
  const tuning = { ...saved, ...view.tuning };
  const tiers = TIERS.filter((tier) => !sameRoute(draft.routes[tier], config.routes[tier]));
  const baseline = draft.baselineTier !== config.baselineTier;
  const cells = ACTIVITIES.flatMap((activity) =>
    TIERS.filter((tier) => !sameCell(draft.activities[activity]?.[tier], config.activities[activity]?.[tier])).map(
      (tier) => [activity, tier],
    ),
  );
  const mode = draft.activityRouting !== config.activityRouting;
  const policy = POLICY_ROWS.map(([key]) => key).filter(
    (key) => Object.hasOwn(view.tuning ?? {}, key) && view.tuning[key] !== base[key],
  );
  const count = tiers.length + Number(baseline) + cells.length + Number(mode) + policy.length;
  return { draft, saved, tuning, tiers, baseline, cells, mode, policy, count };
}

// "sonnet·high": the route's models key and its effort, short enough for the terminal grid; `inherit` for a route that
// leaves the effort to the session, and no effort for a model without efforts. The key, not the model name: two Haiku
// versions in router.json still read apart.
function gridRoute(config, route, narrow) {
  if (!config.models[route.model].efforts.length) return route.model;
  const effort = route.effort ?? INHERIT;
  return `${route.model}·${narrow ? (EFFORT_SHORT[effort] ?? effort) : effort}`;
}
const routeKey = (route) => `${route.model}@${route.effort ?? ''}`;
const builtIn = (config, activity, tier) => defaultsFor(config.provider).activities[activity]?.[tier] ?? null;
const sharesEffort = (config, route) => effortSharesCache(config, config.models[route.model]?.id);
// The cache a route runs on: one per model on a model that keeps one cache across efforts, else one per route.
const cacheOf = (config, route) => (sharesEffort(config, route) ? route.model : routeKey(route));

// Why an override may be a mistake: no effect, a route above the next tier's, or a cache no other cell runs on.
function overrideWarnings(config, uses, activity, tier) {
  const route = resolveRoute(config, tier, activity);
  if (sameRoute(route, config.routes[tier])) return [];
  const above = config.routes[TIERS[TIERS.indexOf(tier) + 1]];
  return [
    above && compareRoutes(config, route, above) > 0 ? 'stronger than the tier above' : null,
    uses.get(cacheOf(config, route)) === 1
      ? config.cache.mode === 'automatic'
        ? 'a route only this cell uses; cache sharing is unknown'
        : `${sharesEffort(config, route) ? 'a model' : 'a model + effort'} only this cell uses: one more cache`
      : null,
  ].filter(Boolean);
}

// The model and effort choices of one route; `session` is offered as `inherit`. `effort` is null for a model without
// efforts. `name` and `text` are what a surface without Select shows.
function routeChoices(config, key, route, modelOptions, onModel, onEffort) {
  const model = config.models[route.model];
  const aliases = modelOptions.includes(route.model) ? modelOptions : [route.model, ...modelOptions];
  return {
    key,
    model: {
      value: route.model,
      name: modelName(model.id),
      options: aliases.map((alias) => ({ value: alias, label: modelName(config.models[alias].id) })),
      pick: onModel,
    },
    effort: model.efforts.length
      ? {
          value: route.effort ?? SESSION_EFFORT,
          text: route.effort ?? INHERIT,
          options: [
            { value: SESSION_EFFORT, label: INHERIT },
            ...model.efforts.map((effort) => ({ value: effort, label: effort })),
          ],
          pick: (effort) => onEffort(effort === SESSION_EFFORT ? null : effort),
        }
      : null,
  };
}

// Routes per cache: the tiers' routes, and the overrides when `overrides` is set. The count shows the overrides once
// activity routing is on; the one-more-cache warning always counts them, so it reads the same in every mode. `shared`
// says, per counted route, whether its model keeps one cache across efforts.
function cacheUses(draft, overrides) {
  const uses = new Map();
  const shared = [];
  const count = (route) => {
    shared.push(sharesEffort(draft, route));
    uses.set(cacheOf(draft, route), (uses.get(cacheOf(draft, route)) ?? 0) + 1);
  };
  for (const tier of TIERS) count(draft.routes[tier]);
  if (overrides)
    for (const activity of ACTIVITIES)
      for (const tier of TIERS) {
        const route = resolveRoute(draft, tier, activity);
        if (!sameRoute(route, draft.routes[tier])) count(route);
      }
  return { uses, shared };
}

// The Routes tab: one grid of tier (columns) by activity (rows), the tiers' own routes on top. A cell press opens its
// editor under the grid. Nothing is written until Save; the cache count reads the whole draft. The model holds every
// cell's routes, marks and handlers; the terminal draws it as rows and the graphical surfaces as cards.
function routesTab(ui, config, view, _usage, actions, modelOptions, columns, _now, surface) {
  const model = routesOf(config, view, actions, modelOptions, columns);
  return isGraphical(surface) ? graphicalRoutes(ui, model) : terminalRoutes(ui, model, { columns });
}

function routesOf(config, view, actions, modelOptions, columns) {
  const changes = routingChanges(config, view);
  const draft = { ...config, ...changes.draft };
  const mode = draft.activityRouting;
  // Efforts are cut short below 80 columns; a graphical pane lists each row's tiers there, and with no width.
  const narrow = Number.isFinite(columns) && columns < 80;
  const { uses, shared } = cacheUses(draft, mode === 'on');
  const selected = view.routeCell ?? null;
  // One grid cell: its route in the effort words the editor's Select offers, or the inherit mark where it runs the
  // tier's, as the terminal grid writes it; then its marks.
  const cell = (row, tier, route, { inherits = false, preset = false, edited = false, muted = false }) => ({
    tier,
    key: `cell-${row}-${tier}`,
    text: inherits ? ROUTE_MARKS.inherits.glyph : gridRoute(draft, route, narrow),
    // A card's: the display name the model Select shows and the full effort word the effort Select shows.
    label: inherits ? ROUTE_MARKS.inherits.card : cardRoute(draft, route),
    inherits,
    marks: [preset ? ROUTE_MARKS.preset : null, edited ? ROUTE_MARKS.edited : null].filter(Boolean),
    // Runs nothing now: the tier's model, or an override while activity routing is not on.
    muted,
    selected: selected === `${row}.${tier}`,
    press: () => actions.selectCell(`${row}.${tier}`),
  });
  const rows = [
    // The tiers' own routes: "every turn" in the terminal grid, "Default" on a card.
    {
      id: TIER_ROW,
      kind: TIER_ROW,
      label: 'every turn',
      title: 'Default',
      cells: TIERS.map((tier) => cell(TIER_ROW, tier, draft.routes[tier], { edited: changes.tiers.includes(tier) })),
    },
    ...ACTIVITIES.map((activity) => ({
      id: activity,
      kind: 'activity',
      label: activity,
      title: activity,
      cells: TIERS.map((tier) => {
        const route = resolveRoute(draft, tier, activity);
        const edited = changes.cells.some(([a, t]) => a === activity && t === tier);
        if (sameRoute(route, draft.routes[tier]))
          return cell(activity, tier, route, { inherits: true, edited, muted: true });
        const preset = builtIn(draft, activity, tier);
        return cell(activity, tier, route, {
          preset: Boolean(preset) && sameRoute(route, { model: preset.model, effort: preset.effort ?? null }),
          edited,
          muted: mode !== 'on',
        });
      }),
    })),
  ];
  const editor = editorOf(draft, changes, selected, cacheUses(draft, true).uses, actions, modelOptions);
  const cache =
    config.cache.mode === 'automatic'
      ? {
          text: 'Automatic prefix cache: hits are observed; lifetime and sharing across efforts are unknown. No cache-write premium.',
          wrap: false,
        }
      : config.cache.mode === 'disabled'
        ? { text: 'Prompt caching disabled: input is priced at the uncached rate.', wrap: false }
        : { text: cacheSentence(uses.size, shared, mode), wrap: true };
  // Two adjacent tiers on one route: that step changes nothing.
  const same = LADDER.slice(0, -1)
    .filter((upper, i) => sameRoute(draft.routes[upper], draft.routes[LADDER[i + 1]]))
    .map((upper) => [LADDER[LADDER.indexOf(upper) + 1], upper]);
  const stepText = (lower, upper) => `${lower} and ${upper} run the same model and effort: that step changes nothing`;
  return {
    narrow,
    layout: narrow || !Number.isFinite(columns) ? 'list' : 'grid',
    tiers: TIERS,
    mode: {
      label: 'Activity routing',
      value: mode,
      options: ACTIVITY_MODES,
      changed: changes.mode,
      hint: ACTIVITY_MODE_HINT[mode],
      pick: (m) => actions.activityMode(m),
    },
    // A card's words: sentences, the tiers and the modes as labels.
    card: {
      hint: sentence(ACTIVITY_MODE_HINT[mode]),
      modes: ACTIVITY_MODES.map((m) => ({ value: m, label: sentence(m) })),
      // What a surface without Select shows.
      mode: `Activity routing: ${sentence(mode)}`,
      tiers: Object.fromEntries(TIERS.map((tier) => [tier, tierLabel(tier)])),
      cache: sentence(cache.text),
      steps: same.map(([lower, upper]) => stepText(tierLabel(lower), tierLabel(upper))),
    },
    overrides: overridesOf(view, config.activityRouting, mode),
    rows,
    editor,
    // What a cell press does, until one is pressed.
    hint: editor ? null : 'Select a cell to change its model and effort.',
    legend: [ROUTE_MARKS.inherits, ROUTE_MARKS.preset, ROUTE_MARKS.edited],
    unsaved: ROUTE_MARKS.edited,
    cache,
    steps: same.map(([lower, upper]) => stepText(lower, upper)),
    reset: { label: 'Reset routes to defaults', press: actions.resetRoutes },
    note: 'A new model ID needs the active file → models: price, window, efforts.',
  };
}

// Why the cache count matters: a model keeps one cache across efforts (the 5.5 models on an API key or a subscription)
// or one per effort (other providers).
function cacheSentence(n, shared, mode) {
  const scope = mode === 'on' ? '' : ' (tiers only: activity routing is not on)';
  const per = shared.every(Boolean)
    ? 'one per model; effort changes keep it'
    : shared.some(Boolean)
      ? 'one per model, or per model + effort where efforts cache apart'
      : 'one per model + effort';
  return `${plural(n, 'prompt cache')} in use${scope}: ${per}. A switch to a cold cache writes the whole context again, the switch cost on Now.`;
}

// The editor of the selected grid cell: a tier's own route with its prices, or an activity's cell with what it runs,
// its built-in default, and the two ways back. Null with no cell, or one that names no tier and row.
function editorOf(draft, changes, selected, uses, actions, modelOptions) {
  const [row, tier] = selected?.split('.') ?? [];
  if (!TIERS.includes(tier) || (row !== TIER_ROW && !ACTIVITIES.includes(row))) return null;
  if (row === TIER_ROW) {
    const route = draft.routes[tier];
    const model = draft.models[route.model];
    const output = model.output ?? null;
    const span = `${windowSize(model.contextWindow)} window`;
    return {
      kind: TIER_ROW,
      tier,
      name: `Default at ${tier}`,
      card: { title: `Edit Default at ${tierLabel(tier)}` },
      choices: routeChoices(
        draft,
        `route-${tier}`,
        route,
        modelOptions,
        (alias) => actions.routeModel(tier, alias),
        (effort) => actions.routeEffort(tier, effort),
      ),
      changed: changes.tiers.includes(tier),
      // Per million tokens. Without an output price in router.json the terminal has always written `$? out`;
      // a card leaves the output price out.
      rates: {
        terminal: `$${model.input} in · ${output === null ? UNPRICED_OUTPUT : `$${output} out`} per M tokens · ${span}`,
        graphical: `$${model.input} in${output === null ? '' : ` · $${output} out`} per M tokens · ${span}`,
      },
    };
  }
  const activity = row;
  const route = resolveRoute(draft, tier, activity);
  const base = draft.routes[tier];
  const preset = builtIn(draft, activity, tier);
  const presetRoute = preset ? { model: preset.model, effort: preset.effort ?? null } : null;
  const own = !sameRoute(route, base);
  // A saved cell that resolves to the tier's route and is no built-in one changes nothing; 1.6 wrote such cells.
  const noEffect = !own && !presetRoute && Boolean(draft.activities[activity]?.[tier]);
  const drop = own || noEffect;
  const back = Boolean(presetRoute) && !sameRoute(route, presetRoute);
  const state = !own
    ? presetRoute && !sameRoute(route, presetRoute)
      ? 'runs the tier’s model; the built-in default is removed'
      : noEffect
        ? 'same as the tier’s model: no effect'
        : 'runs the tier’s model'
    : presetRoute && sameRoute(route, presetRoute)
      ? 'built-in default'
      : 'your override';
  const note = `tier model: ${routeName(draft, base)}`;
  const warnings = overrideWarnings(draft, uses, activity, tier);
  return {
    kind: 'activity',
    activity,
    tier,
    name: `${activity} at ${tier}`,
    choices: routeChoices(
      draft,
      `activity-${activity}-${tier}`,
      route,
      modelOptions,
      (alias) => actions.activityModel(activity, tier, alias),
      (effort) => actions.activityEffort(activity, tier, effort),
    ),
    changed: changes.cells.some(([a, t]) => a === activity && t === tier),
    state,
    // Back to the tier's route, and back to the built-in default, where each would change the cell.
    remove: drop
      ? {
          key: `activity-tier-${activity}-${tier}`,
          // The terminal names the way back; a card names what it removes and says what runs after.
          label: { terminal: `Use tier model: ${routeName(draft, base)}`, graphical: 'Remove override' },
          note,
          press: () => actions.removeActivity(activity, tier),
        }
      : null,
    restore: back
      ? {
          key: `activity-default-${activity}-${tier}`,
          label: `Restore default: ${routeName(draft, presetRoute)}`,
          press: () => actions.restoreActivity(activity, tier),
        }
      : null,
    warnings,
    // A card's words: its title with the tier as a label, and sentences.
    card: {
      title: `Edit ${activity} at ${tierLabel(tier)}`,
      state: sentence(state),
      note: drop ? sentence(note) : null,
      warnings: warnings.map(sentence),
    },
  };
}

// Whether the overrides run now: the saved mode decides, since a draft runs nothing until Save. A different draft mode
// says what Save will change. Null while they run and Save changes nothing.
function overridesOf(view, saved, drafted) {
  const why = (mode) =>
    view.phase === 'unavailable'
      ? 'routing is unavailable'
      : view.mode === 'manual'
        ? 'routing is off'
        : mode === 'on'
          ? null
          : `activity routing is ${mode}`;
  const now = why(saved);
  const after = drafted === saved || Boolean(why(drafted)) === Boolean(now) ? null : why(drafted) ? 'not' : 'in';
  if (!now && !after) return null;
  return {
    warning: Boolean(now),
    text: now ? `Activity overrides not in use: ${now}` : 'Activity overrides in use',
    after: after ? `${after === 'not' ? 'not in use' : 'in use'} after Save` : null,
  };
}

// A Select's data over TUNING_CHOICES[key], with a saved value outside them kept as the first option; picking that one
// changes nothing. `text` is what a terminal without Select shows; `title` and each option's `title` are a card's.
function choiceOf(key, value, format, pick) {
  const values = TUNING_CHOICES[key].includes(value) ? TUNING_CHOICES[key] : [value, ...TUNING_CHOICES[key]];
  return {
    key,
    value: String(value),
    text: format(value),
    title: format(value),
    options: values.map((v) => ({ value: String(v), label: format(v), title: format(v) })),
    pick: (picked) => (TUNING_CHOICES[key].includes(Number(picked)) ? pick(Number(picked)) : undefined),
  };
}

// What the profile's routing mode does, under its control on the Policy tab.
const MODE_HINT = {
  cost: 'a cheaper model or one effort level less where a turn allows',
  balanced: 'each tier runs its route as configured',
  quality: 'one effort level more, or the tier above, where a turn allows',
};
// "default 5 turns" beside a changed value in the terminal, "Default 5 turns" on a card.
const defaultOf = (value) => ({ terminal: `default ${value}`, graphical: `Default ${value}` });
// The Policy form's cards on a graphical surface, in order. Switching up holds no control, only its derived line.
const POLICY_GROUPS = ['Routing mode', 'Switching down', 'Switching up', 'Activities', 'Credits'];
// Each tuning value's card and help line on a graphical surface; the label is POLICY_ROWS'.
export const POLICY_FORM = {
  downgradeVotes: { group: 'Switching down', help: 'Agreeing turns before a cheaper model runs' },
  horizon: { group: 'Switching down', help: 'A cache write must pay back within this many turns' },
  activityMass: {
    group: 'Activities',
    help: 'Below this certainty a new task runs its tier’s model; a continuation keeps it',
  },
  cashCapUsd: { group: 'Credits', help: 'The most one cold cache write may cost, on a model that bills credits' },
};

// The Policy tab: each control inside the sentence it completes, its default named when the value differs. One Save
// writes it with the Routes draft. The model holds every control's value, options, marks and words; the terminal draws
// it as sentences and the graphical surfaces as a form of cards.
function policyTab(ui, config, view, _usage, actions, _modelOptions, _columns, _now, surface) {
  const model = policyOf(config, view, actions);
  return isGraphical(surface) ? graphicalPolicy(ui, model) : terminalPolicy(ui, model);
}

function policyOf(config, view, actions) {
  const changes = routingChanges(config, view);
  const { draft, tuning, policy } = changes;
  const preset = defaultsFor(config.provider);
  const defaults = tuningOf(preset);
  const { upgradeBase, upgradeSlope } = config.policy;
  const credits = Object.values(config.models).some((model) => model.billing === 'credits');
  const active = routingModeOf(view);
  const creditsHelp = credits
    ? 'on a model that bills credits'
    : 'no model in router.json bills credits, so this has no effect';
  const tune = Object.fromEntries(
    POLICY_ROWS.map(([key, label, format]) => {
      const form = POLICY_FORM[key];
      return [
        key,
        {
          key,
          group: form.group,
          label,
          control: choiceOf(key, tuning[key], format, (value) => actions.tune(key, value)),
          changed: policy.includes(key),
          default: tuning[key] === defaults[key] ? null : defaultOf(format(defaults[key])),
          // A setting with no effect says so in its help line.
          help: key === 'cashCapUsd' && !credits ? sentence(creditsHelp) : form.help,
        },
      ];
    }),
  );
  const mode = {
    key: 'routing-mode',
    group: 'Routing mode',
    label: 'Mode',
    control: {
      key: 'routing-mode',
      value: config.mode,
      text: config.mode,
      title: sentence(config.mode),
      options: ROUTING_MODES.map((m) => ({ value: m, label: m, title: sentence(m) })),
      pick: (m) => actions.routingMode(m),
    },
    note: 'saved at once',
    hint: MODE_HINT[config.mode],
    help: `${sentence(MODE_HINT[config.mode])} · saved at once`,
    // A session or project mode runs instead of the profile's.
    session:
      active.source === 'session' || active.source === 'project' ? `this session runs ${routingModeText(view)}` : null,
  };
  const baseline = {
    key: 'baseline',
    group: 'Routing mode',
    label: 'Start tier',
    control: {
      key: 'baseline',
      value: draft.baselineTier,
      text: draft.baselineTier,
      // A card names a tier with a capital, as it does a mode.
      title: sentence(draft.baselineTier),
      options: TIERS.map((tier) => ({ value: tier, label: tier, title: sentence(tier) })),
      pick: (tier) => actions.baseline(tier),
    },
    changed: changes.baseline,
    default:
      draft.baselineTier === preset.baselineTier
        ? null
        : { terminal: `default ${preset.baselineTier}`, graphical: `Default ${tierLabel(preset.baselineTier)}` },
    hint: 'when the session’s model is no tier’s model',
  };
  baseline.help = sentence(baseline.hint);
  const up = `needs ${classifierLabel(config)} support of ${percent(upgradeBase)}, up to ${percent(upgradeBase + upgradeSlope)} as the switch costs more`;
  const fields = [mode, baseline, ...Object.values(tune)];
  return {
    unsaved: ROUTE_MARKS.edited,
    mode,
    baseline,
    tune,
    up,
    activitiesHint: 'else a new task runs its tier’s model; a continuation keeps it',
    creditsHint: creditsHelp,
    groups: POLICY_GROUPS.map((title) => ({
      title,
      fields: fields.filter((field) => field.group === title),
      notes: title === 'Switching up' ? [sentence(up)] : [],
      // A session or project mode runs instead of the profile's.
      warnings: title === 'Routing mode' && mode.session ? [sentence(mode.session)] : [],
    })),
    reset: { label: 'Reset policy to defaults', press: actions.resetPolicy },
    file: {
      path: view.configPath ?? 'profile router.json',
      title: 'Settings file',
      copy: view.configPath ? { label: { terminal: 'copy', graphical: 'Copy path' }, press: actions.copyPath } : null,
    },
    subagents: { text: SUBAGENT_LINE[config.subagentRouting], label: SUBAGENT_CARD[config.subagentRouting] },
  };
}

// One row per configured classifier, as columns to compare: where the prompt goes, its activity probe and p95 wait,
// and whether its credentials are complete. A row press and the deadline are single values with nothing to review as
// a set, so each writes router.json at once; Undo in the status bar puts it back. Under the rows, the active
// classifier's own settings and readings, and its accuracy across sessions. The model holds every classifier's
// readings, words and tones; the terminal draws it as rows and the graphical surfaces as one card per classifier.
function classifierTab(ui, config, view, _usage, actions, _modelOptions, columns, _now, surface) {
  const model = classifierOf(config, view, actions, columns);
  return isGraphical(surface) ? graphicalClassifier(ui, model) : terminalClassifier(ui, model, { columns });
}

// Where a classifier's prompt goes: this machine, or the endpoint's host.
const whereOf = (entry) => (isLocal(entry.endpoint) ? 'this machine' : hostOf(entry.endpoint));
const pausedText = (health) => `paused until ${new Date(health.pausedUntil).toLocaleTimeString()}`;

// The terminal's wide Classifier row: the name, where the prompt goes, the probe and the p95 as fixed cells, then the
// status and Set up.
const CLASSIFIER_CELLS = { name: 17, where: 21, probe: 8, p95: 10 };
const cellsWidth = Object.values(CLASSIFIER_CELLS).reduce((sum, width) => sum + width, 0);
// A Button is drawn as its label in `[ ` and ` ]`.
const wideRowWidth = (row) => cellsWidth + row.state.text.length + (row.setup ? row.setup.label.length + 4 : 0);
/**
 * Whether the terminal draws the Classifier rows on two lines each: with no width, or where the widest wide row does
 * not fit. No rows fit anywhere.
 * @param {{ state: { text: string }, setup: { label: string } | null }[]} rows
 * @param {number | null} columns
 */
export const classifierTwoLine = (rows, columns) =>
  !Number.isFinite(columns) || columns < rows.reduce((widest, row) => Math.max(widest, wideRowWidth(row)), 0);

function classifierOf(config, view, actions, columns) {
  const active = activeClassifier(config);
  const health = view.health ?? { failures: 0, pausedUntil: 0 };
  const paused = health.pausedUntil > Date.now();
  const rows = Object.entries(config.classifiers).map(([id, entry]) =>
    classifierRowOf(config, view, actions, id, entry, paused ? health : null),
  );
  const wait = waitOf(config, view, active);
  const { matched = 0, total = 0 } = view.activityStats?.agreement ?? {};
  const store = storeSummary(readStore(view.activityStore));
  const healthParts = {
    paused: paused ? pausedText(health) : null,
    steady: 'not paused',
    failures: plural(health.failures, 'recent failure'),
    last: Number.isFinite(view.adviceMs) ? `last ${view.adviceMs} ms` : null,
  };
  return {
    rows,
    // A card's layout: the active classifier's full card, then the others as compact rows in one card, each row on
    // two lines in a narrow pane or one with no width.
    current: rows.find((row) => row.active),
    others: rows.some((row) => !row.active)
      ? { title: 'Other classifiers', rows: rows.filter((row) => !row.active) }
      : null,
    narrow: !Number.isFinite(columns) || columns < 80,
    // The terminal's layout: its wide rows as columns to compare only where the widest of them fits, else two lines
    // per classifier.
    terminal: {
      cells: CLASSIFIER_CELLS,
      twoLine: classifierTwoLine(rows, columns),
    },
    probeNote: {
      terminal: 'probe: historical turn-activity questions, not goal/phase accuracy; p95 from that run',
      graphical: 'Probe: historical turn-activity questions, not goal/phase accuracy; p95 from that run',
    },
    active: {
      label: active.label,
      mark: { glyph: '●', tone: /** @type {const} */ ('accent'), text: 'Active' },
      deadline: {
        label: 'Deadline',
        control: choiceOf('timeoutMs', active.timeoutMs, (v) => `${v} ms`, actions.classifierTimeout),
        help: {
          terminal: 'past the deadline the turn keeps its model',
          graphical: 'Past the deadline the turn keeps its model',
        },
      },
      wait: { text: wait.slow ? `${wait.text}: slower than the deadline` : wait.text, slow: wait.slow },
      sends: {
        label: 'Sends',
        text: {
          terminal: `prompt + ${config.context.recentTurns} recent turns → ${whereOf(active)}`,
          graphical: `Prompt + ${config.context.recentTurns} recent turns → ${whereOf(active)}`,
        },
        help: {
          terminal: 'the bounded active goal and current step also go to the classifier',
          graphical: 'The bounded active goal and current step also go to the classifier',
        },
      },
      health: {
        label: 'Health',
        ...healthParts,
        // A card's one line.
        value: sentence(
          [healthParts.paused ?? healthParts.steady, healthParts.failures, healthParts.last]
            .filter(Boolean)
            .join(' · '),
        ),
        tone: /** @type {import('./ui/tokens.mjs').Tone} */ (paused ? 'warning' : 'primary'),
      },
      credentials: {
        label: 'Credentials',
        button: { key: 'key', label: 'Edit', hotkey: 'k', press: (press) => actions.key(press, config.classifier) },
        note: 'opens /plugin configure',
      },
      // How often this session's tools fit the classifier's accepted activity; none before a labelled turn.
      session: total
        ? { head: 'THIS SESSION', text: `Tool compatibility (not accuracy): ${agreement(matched, total)}` }
        : null,
      // A card's readings: the wait against the deadline, and this session's agreement.
      readings: [
        {
          label: 'Wait',
          value: wait.measured
            ? wait.slow
              ? `${wait.text} · slower than the deadline`
              : wait.text
            : 'None measured yet',
          tone: /** @type {import('./ui/tokens.mjs').Tone} */ (wait.slow ? 'warning' : 'primary'),
        },
        total
          ? {
              label: 'Tool agreement',
              value: `${agreement(matched, total)} this session`,
              tone: /** @type {import('./ui/tokens.mjs').Tone} */ ('primary'),
              help: 'Compatibility with the tools a turn used, not accuracy',
            }
          : null,
      ].filter(Boolean),
    },
    store: store.labelled > 0 ? storeUsageOf(store, view.activityMetrics) : null,
  };
}

// One classifier: the terminal row's columns, and a card's status, readings and credentials Button. `paused` is the
// health while the classifier is paused, else null.
function classifierRowOf(config, view, actions, id, entry, paused) {
  const isActive = id === config.classifier;
  const missing = missingCredentials(config, view, id);
  const probe = probeOf(config, id);
  const local = isLocal(entry.endpoint);
  // The active classifier's last error, when it is not one of the missing credentials the row already names. While
  // routing is unavailable the error is the router's reason, which the notices show.
  const failed =
    isActive && view.phase !== 'unavailable' && view.error && !['missing-key', 'missing-account'].includes(view.error)
      ? view.error
      : null;
  /** @type {{ tone: import('./ui/tokens.mjs').Tone, text: string }} */
  const status = missing
    ? { tone: 'warning', text: sentence(missingText(config, id, missing)) }
    : isActive && paused
      ? { tone: 'warning', text: sentence(pausedText(paused)) }
      : failed
        ? { tone: 'warning', text: `Last error: ${classifierStatus(config, failed)}` }
        : { tone: 'success', text: 'Ready' };
  return {
    key: `classifier-${id}`,
    label: entry.label,
    active: isActive,
    press: () => actions.classifier(id),
    // A card's header: Use on every card but the active one's.
    use: isActive ? null : { label: 'Use' },
    // The terminal's columns.
    where: { text: whereOf(entry), local },
    probe: probe ? `${probe.correct}/${probe.probes}` : null,
    p95: probe ? `${probe.p95Ms} ms` : null,
    state: missing
      ? { tone: /** @type {const} */ ('warning'), text: `○ ${missingText(config, id, missing)}  ` }
      : { tone: /** @type {const} */ ('success'), text: '● ready' },
    setup: missing ? { key: `key-${id}`, label: 'Set up', press: (press) => actions.key(press, id) } : null,
    // The terminal's second line in a narrow pane: where the prompt goes, and the probe result.
    narrowDetail: [whereOf(entry), probe ? `${probe.correct}/${probe.probes} · p95 ${probe.p95Ms} ms` : null]
      .filter(Boolean)
      .join(' · '),
    // A card's.
    status,
    // A compact row's: its status, and where the prompt goes with its probe result.
    compact: {
      status,
      detail: [
        local ? 'This machine' : whereOf(entry),
        probe ? `${probe.correct} of ${probe.probes} right · p95 ${probe.p95Ms} ms` : null,
      ]
        .filter(Boolean)
        .join(' · '),
    },
    readings: [
      {
        label: 'Prompt goes to',
        value: local ? 'This machine' : whereOf(entry),
        tone: /** @type {import('./ui/tokens.mjs').Tone} */ (local ? 'success' : 'primary'),
      },
      probe
        ? {
            label: 'Activity probe',
            value: `${probe.correct} of ${probe.probes} right · p95 ${probe.p95Ms} ms`,
            tone: /** @type {import('./ui/tokens.mjs').Tone} */ ('primary'),
          }
        : null,
    ].filter(Boolean),
    // One credentials Button per card: Set up where something is missing, else the active one's Edit.
    // The active one's answers k either way, as the terminal's Edit does.
    credentials: missing
      ? {
          key: `key-${id}`,
          label: 'Set up',
          ...(isActive ? { hotkey: 'k' } : {}),
          press: (press) => actions.key(press, id),
        }
      : isActive
        ? {
            key: 'key',
            label: 'Edit credentials',
            hotkey: 'k',
            press: (press) => actions.key(press, id),
            note: 'Shows how to add them',
          }
        : null,
  };
}

// The active classifier's wait: live p95 over this session's turns, else its probe's; slow past the deadline.
function waitOf(config, view, active) {
  const { latency } = readMetrics(view.activityMetrics);
  const live = latencyP95(Object.hasOwn(latency, config.classifier) ? latency[config.classifier] : null);
  const probe = probeOf(config, config.classifier);
  const p95 = live ? live.ms : probe?.p95Ms;
  const text = live
    ? `p95 ${live.over ? '>' : '≤'} ${live.ms} ms over ${plural(live.turns, 'turn')}`
    : probe
      ? `p95 ${probe.p95Ms} ms in its probe`
      : 'no wait measured yet';
  return {
    text,
    measured: Boolean(live || probe),
    slow: Number.isFinite(p95) && (p95 > active.timeoutMs || live?.over),
  };
}

// "19 of 22 turns (86%)".
const agreement = (matched, total) => `${matched} of ${total} turns (${percent(matched / total)})`;

// The counts kept across sessions, read from the stores as last loaded: how often the tools a turn used fit the
// classifier's activity, and what the activity moves led to. Agreement uses the classifier's raw answer, so it can
// differ from the session's. Each row is the terminal's line and a card's label and value.
function storeUsageOf(summary, metrics) {
  const { downMoves } = readMetrics(metrics);
  const rows = [
    { text: `Labelled   ${summary.labelled} turns`, label: 'Labelled', value: plural(summary.labelled, 'turn') },
  ];
  const { matched, total } = summary.agreement;
  if (total > 0)
    rows.push({
      text: `Tool compatibility (not accuracy): ${agreement(matched, total)}`,
      label: 'Tool agreement',
      value: agreement(matched, total),
    });
  const { focus } = summary;
  if (focus.total > 0)
    rows.push({
      text: `Code/ops/explore  classifier vs tools: ${agreement(focus.matched, focus.total)}`,
      label: 'Code, ops and explore',
      value: agreement(focus.matched, focus.total),
    });
  if (summary.disagreements.length) {
    const pairs = summary.disagreements.map((d) => `${d.predicted} → ${d.observed} ${d.n}`).join(' · ');
    rows.push({ text: `Mismatch   ${pairs}`, label: 'Mismatches', value: pairs });
  }
  const { taken, refused } = summary.lateral;
  if (taken + refused > 0)
    rows.push({
      text: `Activity moves  ${taken} taken · ${refused} refused`,
      label: 'Activity moves',
      value: `${taken} taken · ${refused} refused`,
    });
  const { moves, escalations } = downMoves;
  if (moves > 0) {
    rows.push({
      text: `Escalations  after a cheaper activity move: ${escalations} in ${moves} move${moves === 1 ? '' : 's'}`,
      label: 'Escalations',
      value: `${escalations} after ${plural(moves, 'cheaper activity move')}`,
    });
  }
  return {
    head: 'ACROSS SESSIONS · since the last reset',
    title: 'Across sessions',
    hint: 'Since the last reset',
    rows,
    unpriced: unpricedLine(metrics),
  };
}

// Success for a write or its undo, danger for a refused write, warning for everything else that needs a look.
/** @returns {import('./ui/tokens.mjs').Tone} */
const noticeTone = (notice) =>
  /^Not saved/.test(notice) ? 'danger' : /^(Saved|Undid|Path copied)/.test(notice) ? 'success' : 'warning';

// The one place for commit state on every tab: the unsaved Routes and Policy draft with Save and Discard (the
// router.json lines it writes on those two tabs, a count elsewhere), the last notice, and Undo for the last write.
// Each changed setting is its router.json key and the before and after the terminal lists, and a card's label and
// values.
function saveBarOf(config, view, tab, actions) {
  const changes = routingChanges(config, view);
  const rows = [];
  const same = (text) => ({ terminal: text, graphical: text });
  const row = (key, label, before, after) => rows.push({ key, label, before, after });
  for (const tier of changes.tiers)
    row(
      `routes.${tier}`,
      `${tierLabel(tier)} route`,
      same(routeName(config, config.routes[tier])),
      same(routeName(config, changes.draft.routes[tier])),
    );
  const tierWords = (tier) => ({ terminal: tier, graphical: tierLabel(tier) });
  if (changes.baseline)
    row('baselineTier', 'Start tier', tierWords(config.baselineTier), tierWords(changes.draft.baselineTier));
  const draft = { ...config, ...changes.draft };
  const cellName = (c, activity, tier) =>
    c.activities[activity]?.[tier]
      ? same(routeName(c, resolveRoute(c, tier, activity)))
      : { terminal: 'no override', graphical: 'No override' };
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
  for (const [key, label, format, field] of POLICY_ROWS.filter(([policyKey]) => changes.policy.includes(policyKey)))
    row(field, label, same(format(changes.saved[key])), same(format(changes.tuning[key])));
  const { count } = changes;
  const listed = DRAFT_TABS.includes(tab);
  const confirms = Boolean(view.lastWrite && view.notice?.startsWith('Saved'));
  return {
    count,
    // On Routes and Policy the changes are listed; elsewhere only counted.
    listed,
    rows,
    pending: {
      tone: /** @type {import('./ui/tokens.mjs').Tone} */ ('warning'),
      text: `● ${count} unsaved routing change${count === 1 ? '' : 's'}  `,
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
          last: {
            terminal: `Last change: ${view.lastWrite.label}  `,
            graphical: `Last change: ${view.lastWrite.label}`,
          },
        }
      : null,
  };
}

// The save bar as the terminal's lines: router.json's diff on the two draft tabs, the count with Save and Discard,
// then the notice and Undo.
function statusBar(ui, bar) {
  const out = [];
  if (bar.count) {
    out.push(ui.text(' '));
    if (bar.listed) {
      out.push(ui.dim('router.json changes:'));
      for (const row of bar.rows)
        out.push(
          ui.text(`- ${row.key.padEnd(30)} ${row.before.terminal}`, { color: toneColor('danger', 'terminal') }),
          ui.text(`+ ${row.key.padEnd(30)} ${row.after.terminal}`, { color: toneColor('success', 'terminal') }),
        );
    }
    const { save, discard } = bar;
    out.push(
      ui.line(
        ui.text(bar.pending.text, { color: toneColor(bar.pending.tone, 'terminal') }),
        ui.Button({ key: save.key, label: save.label, hotkey: save.hotkey, variant: 'primary', onPress: save.press }),
        ' ',
        ui.Button({ key: discard.key, label: discard.label, hotkey: discard.hotkey, onPress: discard.press }),
        bar.listed ? null : ui.dim(`  ${bar.elsewhere}`),
      ),
    );
  }
  const undo = bar.undo
    ? ui.Button({ key: bar.undo.key, label: bar.undo.label, hotkey: bar.undo.hotkey, onPress: bar.undo.press })
    : null;
  if (bar.notice || undo) out.push(ui.text(' '));
  if (bar.notice)
    out.push(
      ui.line(
        ui.text(`${bar.notice.text}  `, { color: toneColor(bar.notice.tone, 'terminal') }),
        bar.undo?.confirms ? undo : null,
      ),
    );
  if (undo && !bar.undo.confirms) out.push(ui.line(ui.dim(bar.undo.last.terminal), undo));
  return out;
}

// The Usage tab: the period, the cost against no routing, the breakdown, the trend and What if, what is worth a look,
// the subagents and Delete history. The model (lib/ui/model/usage.mjs) holds every reading, word and tone; the
// terminal draws it as rows and the graphical surfaces as cards.
function usageTab(ui, config, view, usage, actions, _modelOptions, columns, now, surface) {
  const model = usageOf(config, view, usage, actions, columns, now);
  return isGraphical(surface) ? graphicalUsage(ui, model) : terminalUsage(ui, model, { columns });
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
      text: 'Tiers show as rising bars, low to high; a route never moves past 80% of its window.',
      terminal: 'Tiers show as bars ▂▄▆█, low to high; a route never moves past 80% of its window.',
      tiers: TIERS,
    },
  ],
};

// One Text per paragraph, wrapping to the pane.
function helpLines(ui) {
  return [
    ui.head(HELP.head),
    ...HELP.paragraphs.map((paragraph) =>
      ui.text('terminal' in paragraph ? paragraph.terminal : paragraph.text, { dimColor: true, wrap: 'wrap' }),
    ),
    ui.text(' '),
  ];
}
