// The Policy tab's model: each control inside the sentence it completes, its default named when the value differs. One
// Save writes it with the Routes draft.

import { defaultsFor, ROUTING_MODES, TIERS, tuningOf } from '../../config.mjs';
import { classifierLabel, percent, routingModeOf, routingModeText } from '../../display.mjs';
import { POLICY_ROWS, routingChanges } from './draft.mjs';
import { sentence, tierLabel } from './format.mjs';
import { ROUTE_MARKS } from './routes.mjs';

const TUNING_CHOICES = {
  timeoutMs: [500, 1000, 1500, 3000, 5000],
  downgradeVotes: [1, 2, 3],
  horizon: [1, 3, 5, 10],
  cashCapUsd: [0.5, 1, 2, 5],
  activityMass: [0.5, 0.6, 0.7, 0.8],
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

// A Select's data over TUNING_CHOICES[key], with a saved value outside them kept as the first option; picking that one
// changes nothing. `text` is what a terminal without Select shows.
export function choiceOf(key, value, format, pick) {
  const values = TUNING_CHOICES[key].includes(value) ? TUNING_CHOICES[key] : [value, ...TUNING_CHOICES[key]];
  return {
    key,
    value: String(value),
    text: format(value),
    options: values.map((v) => ({ value: String(v), label: format(v) })),
    pick: (picked) => (TUNING_CHOICES[key].includes(Number(picked)) ? pick(Number(picked)) : undefined),
  };
}

// What the configured routing mode does, under its control on the Policy tab.
const MODE_HINT = {
  cost: 'a cheaper model or one effort level less where a turn allows',
  balanced: 'each tier runs its route as configured',
  quality: 'one effort level more, or the tier above, where a turn allows',
};
// A sentence a card starts with a capital, as the terminal writes it.
const sayWords = (words) => ({ terminal: words, graphical: sentence(words) });
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

/**
 * @typedef {object} Control a Select's data: its value, options, and what a surface without Select shows
 * @property {string} key
 * @property {string} value
 * @property {string} text
 * @property {{ value: string, label: import('./format.mjs').Words }[]} options
 * @property {(value: string) => void} pick
 *
 * @typedef {object} PolicyField
 * @property {string} key
 * @property {string} group a card's group
 * @property {string} label
 * @property {Control} control
 * @property {boolean} [changed]
 * @property {import('./format.mjs').Words | null} [default] its default, where the value differs
 * @property {import('./format.mjs').Words} [hint]
 * @property {string} [help] a card's help line
 * @property {string} [note]
 * @property {import('./format.mjs').Words | null} [session]
 *
 * @typedef {object} PolicyModel The Policy tab: each control with its words, marks and defaults.
 * @property {import('./routes.mjs').RouteMark} unsaved
 * @property {PolicyField} mode
 * @property {PolicyField} baseline
 * @property {Record<import('./draft.mjs').TuneKey, PolicyField>} tune
 * @property {import('./format.mjs').Words} up
 * @property {string} activitiesHint
 * @property {string} creditsHint
 * @property {{ title: string, fields: PolicyField[], notes: string[], warnings: string[] }[]} groups
 * @property {{ label: string, press: () => void }} reset
 * @property {{ path: string, title: string, copy: { label: import('./format.mjs').Words, press: () => void } | null }} file
 * @property {import('./format.mjs').Words} subagents
 */
/**
 * @param {import('./frame.mjs').PaneContext} ctx
 * @returns {PolicyModel}
 */
export function policyOf({ config, view, actions }) {
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
  const tune = /** @type {Record<import('./draft.mjs').TuneKey, PolicyField>} */ (
    Object.fromEntries(
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
    )
  );
  const mode = {
    key: 'routing-mode',
    group: 'Routing mode',
    label: 'Mode',
    control: {
      key: 'routing-mode',
      value: config.mode,
      text: config.mode,
      options: ROUTING_MODES.map((m) => ({ value: m, label: { terminal: m, graphical: sentence(m) } })),
      pick: (m) => actions.routingMode(m),
    },
    note: 'saved at once',
    hint: { terminal: MODE_HINT[config.mode], graphical: `${sentence(MODE_HINT[config.mode])} · saved at once` },
    // Name the active source when it is scoped to the project or the session.
    session:
      active.source === 'session' || active.source.startsWith('project')
        ? sayWords(`this session runs ${routingModeText(view)}`)
        : null,
  };
  const baseline = {
    key: 'baseline',
    group: 'Routing mode',
    label: 'Start tier',
    control: {
      key: 'baseline',
      value: draft.baselineTier,
      text: draft.baselineTier,
      options: TIERS.map((tier) => ({ value: tier, label: { terminal: tier, graphical: sentence(tier) } })),
      pick: (tier) => actions.baseline(tier),
    },
    changed: changes.baseline,
    default:
      draft.baselineTier === preset.baselineTier
        ? null
        : { terminal: `default ${preset.baselineTier}`, graphical: `Default ${tierLabel(preset.baselineTier)}` },
    hint: sayWords('when the session’s model is no tier’s model'),
  };
  const up = `needs ${classifierLabel(config)} support of ${percent(upgradeBase)}, up to ${percent(upgradeBase + upgradeSlope)} as the switch costs more`;
  const fields = [mode, baseline, ...Object.values(tune)];
  return {
    unsaved: ROUTE_MARKS.edited,
    mode,
    baseline,
    tune,
    up: sayWords(up),
    activitiesHint: 'else a new task runs its tier’s model; a continuation keeps it',
    creditsHint: creditsHelp,
    groups: POLICY_GROUPS.map((title) => ({
      title,
      fields: fields.filter((field) => field.group === title),
      notes: title === 'Switching up' ? [sayWords(up).graphical] : [],
      // Name the active source when it is scoped to the project or the session.
      warnings: title === 'Routing mode' && mode.session ? [mode.session.graphical] : [],
    })),
    reset: { label: 'Inherit policy', press: actions.resetPolicy },
    file: {
      path: view.configPath ?? 'profile router.json',
      title: 'Profile settings file (read-only)',
      copy: view.configPath ? { label: { terminal: 'copy', graphical: 'Copy path' }, press: actions.copyPath } : null,
    },
    subagents: { terminal: SUBAGENT_LINE[config.subagentRouting], graphical: SUBAGENT_CARD[config.subagentRouting] },
  };
}
