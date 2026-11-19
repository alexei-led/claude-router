// The Routes tab's model: the grid of tier by activity with every cell's route, marks and handlers, the selected
// cell's editor, and the cache footer. Nothing is written until Save; the cache count reads the whole draft.

import { compareRoutes } from '../../activity.mjs';
import { ACTIVITIES, ACTIVITY_MODES, defaultsFor, resolveRoute, sameRoute, TIERS } from '../../config.mjs';
import { effortSharesCache } from '../../cost.mjs';
import { cardRoute, modelName, routeName } from '../../display.mjs';
import { heldRows } from '../../holds.mjs';
import { routingChanges } from './draft.mjs';
import { plural, sentence, tierLabel } from './format.mjs';

const LADDER = [...TIERS].reverse();
// The effort option that sends no effort of its own: the request keeps the one Claude Code sends.
const SESSION_EFFORT = 'session';
const INHERIT = 'inherit';
// The Routes grid's marks, as its legend explains them, each in its tone.
// `card` is the glyph a card draws where the terminal's is too slight in a Button.
/** @type {{ inherits: RouteMark, preset: RouteMark, edited: RouteMark, held: RouteMark }} */
export const ROUTE_MARKS = {
  inherits: { glyph: '·', card: '—', tone: 'muted', text: 'runs the tier’s model' },
  preset: { glyph: '°', tone: 'muted', text: 'built-in default' },
  edited: { glyph: '●', tone: 'warning', text: 'unsaved' },
  held: { glyph: '↷', tone: 'warning', text: 'held out now' },
};
const UNPRICED_OUTPUT = '$? out';

// The Routes grid's row of the tiers' own routes; every other row is an activity.
const TIER_ROW = 'tier';

const ACTIVITY_MODE_HINT = {
  off: 'not asked; every turn runs its tier’s model',
  on: 'an activity can change its tier’s model',
};
const windowSize = (tokens) => (tokens >= 1e6 ? `${tokens / 1e6}M` : `${Math.round(tokens / 1e3)}K`);

// A route as the grid names it: the models key, not the model name (two Haiku versions in router.json still read
// apart), and its effort, `inherit` for a route that leaves the effort to the session; no effort for a model without
// efforts.
const gridRoute = (config, route) => ({
  model: route.model,
  effort: config.models[route.model].efforts.length ? (route.effort ?? INHERIT) : null,
});
const routeKey = (route) => `${route.model}@${route.effort ?? ''}`;
const builtIn = (config, activity, tier) => defaultsFor(config.provider).activities[activity]?.[tier] ?? null;
const sharesEffort = (config, route) => effortSharesCache(config, config.models[route.model]?.id);
// The cache a route runs on: one per model on a model that keeps one cache across efforts, else one per route.
const cacheOf = (config, route) => (sharesEffort(config, route) ? route.model : routeKey(route));

// Why an override may be a mistake: no effect, a route above the next tier's, or a cache no other cell runs on.
function overrideWarnings(config, uses, activity, tier) {
  const route = resolveRoute(config, tier, activity);
  if (sameRoute(route, config.routes[tier])) return [];
  const aboveTier = TIERS[TIERS.indexOf(tier) + 1];
  const above = aboveTier === undefined ? undefined : config.routes[aboveTier];
  return [
    above && (compareRoutes(config, route, above) ?? 0) > 0 ? 'stronger than the tier above' : null,
    uses.get(cacheOf(config, route)) === 1
      ? config.cache.mode === 'automatic'
        ? 'a route only this cell uses; cache sharing is unknown'
        : `${sharesEffort(config, route) ? 'a model' : 'a model + effort'} only this cell uses: one more cache`
      : null,
  ].filter((warning) => warning !== null);
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

/**
 * @typedef {object} RouteMark a mark in the grid and its legend
 * @property {string} glyph
 * @property {string} [card] the glyph a card draws where the terminal's is too slight in a Button
 * @property {import('../tokens.mjs').Tone} tone
 * @property {string} text
 *
 * @typedef {object} Choice a model or effort Select: its value, options and what a surface without Select shows
 * @property {string | null} value
 * @property {{ value: string | null, label: string }[]} options
 * @property {(value: string) => void} pick
 *
 * @typedef {object} GridCell
 * @property {string} tier
 * @property {string} key
 * @property {{ model: string, effort: string | null } | null} route as the terminal's grid names it; null where it runs the tier's
 * @property {string} label a card's label
 * @property {boolean} inherits
 * @property {RouteMark[]} marks
 * @property {boolean} muted runs nothing now
 * @property {boolean} selected
 * @property {() => void} press
 *
 * @typedef {object} GridRow
 * @property {string} id
 * @property {string} kind 'tier' or 'activity'
 * @property {import('./format.mjs').Words} label
 * @property {GridCell[]} cells
 *
 * @typedef {object} TierEditor a tier's own route with its prices
 * @property {'tier'} kind
 * @property {string} tier
 * @property {string} title a card's title
 * @property {{ key: string, model: Choice & { name: string }, effort: (Choice & { text: string }) | null }} choices
 * @property {boolean} changed
 * @property {{ terminal: string, graphical: string }} rates
 *
 * @typedef {object} ActivityEditor an activity's cell with what it runs and the ways back
 * @property {'activity'} kind
 * @property {string} tier
 * @property {string} activity
 * @property {string} title a card's title
 * @property {{ key: string, model: Choice & { name: string }, effort: (Choice & { text: string }) | null }} choices
 * @property {boolean} changed
 * @property {import('./format.mjs').Words} state
 * @property {{ key: string, label: { terminal: string, graphical: string }, note: string, press: () => void } | null} remove
 * @property {{ key: string, label: string, press: () => void } | null} restore
 * @property {import('./format.mjs').Words[]} warnings
 *
 * @typedef {TierEditor | ActivityEditor} RouteEditor the selected cell's editor
 *
 * @typedef {object} FallbackTarget one entry of a model's chain
 * @property {string} label the target as the grid names it: the models key and its effort, "glm·max"
 * @property {boolean} held it is held out now
 * @property {boolean} runs it stands in for the model on the turn shown on Now
 *
 * @typedef {object} FallbackRow one model with a chain
 * @property {string} model the models key
 * @property {{ text: string, tone: import('../tokens.mjs').Tone }} status
 * @property {FallbackTarget[]} targets in the order they are tried
 *
 * @typedef {object} FallbacksModel FALLBACKS: the chains in router.json, read-only.
 * @property {FallbackRow[]} rows
 * @property {import('./format.mjs').Words} note where chains are set
 *
 * @typedef {object} RoutesModel The Routes tab: the grid, the cell editor, the fallback chains and the cache footer.
 * @property {{ id: string, label: import('./format.mjs').Words }[]} tiers
 * @property {{ label: string, value: string, options: { value: string, label: import('./format.mjs').Words }[], changed: boolean, hint: import('./format.mjs').Words, pick: (mode: string) => void }} mode
 * @property {{ warning: boolean, text: string, after: string | null } | null} overrides
 * @property {GridRow[]} rows
 * @property {RouteEditor | null} editor
 * @property {FallbacksModel | null} fallbacks null with no chain
 * @property {string | null} hint what a cell press does, until one is pressed
 * @property {RouteMark} inheritMark
 * @property {RouteMark[]} legend
 * @property {RouteMark} unsaved
 * @property {{ text: import('./format.mjs').Words, wrap: boolean }} cache
 * @property {import('./format.mjs').Words[]} steps
 * @property {{ label: string, hotkey: string, press: () => void }} reset
 * @property {string} note
 */
/**
 * @param {import('./frame.mjs').PaneContext} ctx
 * @returns {RoutesModel}
 */
export function routesOf({ config, view, actions, modelOptions, now }) {
  const held = heldRows(config, view.holds, now);
  const heldModel = (alias) => held.some((row) => row.aliases.includes(alias));
  const changes = routingChanges(config, view);
  const draft = { ...config, ...changes.draft };
  const mode = draft.activityRouting;
  const { uses, shared } = cacheUses(draft, mode === 'on');
  const selected = view.routeCell ?? null;
  // One grid cell: its route as the terminal grid writes it, null where it runs the tier's; a card's label, the display
  // name the model Select shows and the full effort word the effort Select shows; then its marks.
  const cell = (row, tier, route, { inherits = false, preset = false, edited = false, muted = false }) => ({
    tier,
    key: `cell-${row}-${tier}`,
    route: inherits ? null : gridRoute(draft, route),
    label: inherits ? ROUTE_MARKS.inherits.card : cardRoute(draft, route),
    inherits,
    marks: [
      preset ? ROUTE_MARKS.preset : null,
      edited ? ROUTE_MARKS.edited : null,
      !inherits && heldModel(route.model) ? ROUTE_MARKS.held : null,
    ].filter((mark) => mark !== null),
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
      label: { terminal: 'every turn', graphical: 'Default' },
      cells: TIERS.map((tier) => cell(TIER_ROW, tier, draft.routes[tier], { edited: changes.tiers.includes(tier) })),
    },
    ...ACTIVITIES.map((activity) => ({
      id: activity,
      kind: 'activity',
      label: activity,
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
  const cacheWords =
    config.cache.mode === 'automatic'
      ? 'Automatic prefix cache: hits are observed; lifetime and sharing across efforts are unknown. No cache-write premium.'
      : config.cache.mode === 'disabled'
        ? 'Prompt caching disabled: input is priced at the uncached rate.'
        : cacheSentence(uses.size, shared, mode);
  // Two adjacent tiers on one route: that step changes nothing.
  const same = LADDER.slice(0, -1).flatMap((upper, i) => {
    const lower = LADDER[i + 1];
    return lower !== undefined && sameRoute(draft.routes[upper], draft.routes[lower]) ? [[lower, upper]] : [];
  });
  const stepText = (lower, upper) => `${lower} and ${upper} run the same model and effort: that step changes nothing`;
  const modeHint = ACTIVITY_MODE_HINT[mode];
  return {
    tiers: TIERS.map((id) => ({ id, label: { terminal: id, graphical: tierLabel(id) } })),
    mode: {
      label: 'Activity routing',
      value: mode,
      options: ACTIVITY_MODES.map((m) => ({ value: m, label: { terminal: m, graphical: sentence(m) } })),
      changed: changes.mode,
      hint: { terminal: modeHint, graphical: sentence(modeHint) },
      pick: (m) => actions.activityMode(m),
    },
    overrides: overridesOf(view, config.activityRouting, mode),
    rows,
    editor,
    fallbacks: fallbacksOf(config, view, held),
    // What a cell press does, until one is pressed.
    hint: editor ? null : 'Select a cell to change its model and effort.',
    inheritMark: ROUTE_MARKS.inherits,
    legend: [
      ROUTE_MARKS.inherits,
      ROUTE_MARKS.preset,
      ROUTE_MARKS.edited,
      ...(rows.some((row) => row.cells.some((one) => one.marks.includes(ROUTE_MARKS.held))) ? [ROUTE_MARKS.held] : []),
    ],
    unsaved: ROUTE_MARKS.edited,
    // `wrap`: the terminal wraps the sentence that counts caches, not the fixed ones.
    cache: {
      text: { terminal: cacheWords, graphical: sentence(cacheWords) },
      wrap: config.cache.mode !== 'automatic' && config.cache.mode !== 'disabled',
    },
    steps: same.map(([lower, upper]) => ({
      terminal: stepText(lower, upper),
      graphical: stepText(tierLabel(lower), tierLabel(upper)),
    })),
    reset: { label: 'Reset routes to defaults', hotkey: 'r', press: actions.resetRoutes },
    note: 'A new model ID needs the active file → models: price, window, efforts.',
  };
}

// FALLBACKS: each model with a chain, its targets in order with the held ones and the one standing in on the turn Now
// shows, and the model's status. Null with no chain.
/** @returns {FallbacksModel | null} */
function fallbacksOf(config, view, held) {
  const chains = Object.entries(config.fallbacks);
  if (!chains.length) return null;
  const holder = (alias) => held.find((row) => row.aliases.includes(alias));
  const standing = view.reason === 'model-held' ? view.fallback : null;
  return {
    rows: chains.map(([model, chain]) => {
      const targets = chain.map((entry, index) => {
        const [alias, effort] = entry.split('@');
        return {
          label: effort ? `${alias}·${effort}` : alias,
          held: Boolean(holder(alias)),
          runs: standing?.from === model && standing.step === index + 1,
        };
      });
      const cause = holder(model);
      return {
        model,
        targets,
        status: cause
          ? {
              text: `held · ${cause.text}${targets.every((target) => target.held) ? ' · every target held' : ''}`,
              tone: /** @type {import('../tokens.mjs').Tone} */ ('warning'),
            }
          : { text: 'ready', tone: /** @type {import('../tokens.mjs').Tone} */ ('muted') },
      };
    }),
    note: { terminal: 'read-only · router.json → fallbacks', graphical: 'Read-only · set in router.json → fallbacks' },
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
/** @returns {RouteEditor | null} */
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
      title: `Edit Default at ${tierLabel(tier)}`,
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
    title: `Edit ${activity} at ${tierLabel(tier)}`,
    choices: routeChoices(
      draft,
      `activity-${activity}-${tier}`,
      route,
      modelOptions,
      (alias) => actions.activityModel(activity, tier, alias),
      (effort) => actions.activityEffort(activity, tier, effort),
    ),
    changed: changes.cells.some(([a, t]) => a === activity && t === tier),
    state: { terminal: state, graphical: sentence(state) },
    // Back to the tier's route, and back to the built-in default, where each would change the cell.
    remove: drop
      ? {
          key: `activity-tier-${activity}-${tier}`,
          // The terminal names the way back; a card names what it removes and says what runs after.
          label: { terminal: `Use tier model: ${routeName(draft, base)}`, graphical: 'Remove override' },
          note: sentence(note),
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
    warnings: warnings.map((warning) => ({ terminal: warning, graphical: sentence(warning) })),
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
