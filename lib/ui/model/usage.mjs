// The Usage tab's model: every reading, word and tone the terminal rows and the graphical cards draw, decided once.
// `usageOf` is the tab's one entry; `lib/ui/terminal/usage.mjs` and `lib/ui/graphical/usage.mjs` lay it out. Where the
// terminal and a card need different words, both sit side by side (`text` and `graphical`, or `{ terminal, graphical }`).
import { resolveRoute, TIERS } from '../../config.mjs';
import { routeEffort } from '../../cost.mjs';
import { periodCost } from '../../costs.mjs';
import {
  API_ESTIMATE,
  costText,
  diffText,
  EARLY_NOTE,
  formatTokens,
  liveUsage,
  modelName,
  percent,
  recordedModels,
  repliesText,
  switchesLost,
  UNROUTED,
  uncomparedText,
  usd,
  yourModel,
} from '../../display.mjs';
import { cellForModel, isSameModel } from '../../route.mjs';
import { modelSpec } from '../../savings.mjs';
import { readSubagentStore, summarizeSubagents } from '../../subagents.mjs';
import { allTime, dayKey, PERIODS, periodRange, summarize, trend } from '../../usage.mjs';
import { savingTone } from '../tokens.mjs';
import { dayLabel, plural, sentence } from './format.mjs';
import { agentsOf } from './usage-agents.mjs';
import { breakdownOf, compareOf, insightsOf } from './usage-breakdown.mjs';
import { chartOf, finite, PERIOD_PHRASE, saving, spanText } from './usage-shared.mjs';

/** @typedef {import('../tokens.mjs').Tone} Tone */
/** @typedef {{ text: string, tone: Tone }} Toned */

const PERIOD_LABEL = { session: 'Session', today: 'Today', '7d': '7d', '30d': '30d', month: 'Month', all: 'All' };
// The cost table's total row: the terminal's word, and the caption under a card's headline figure.
const TOTAL = {
  session: { terminal: 'session', graphical: 'This session' },
  today: { terminal: 'today', graphical: 'Today' },
  '7d': { terminal: '7 days', graphical: 'Last 7 days' },
  '30d': { terminal: '30 days', graphical: 'Last 30 days' },
  month: { terminal: 'month', graphical: 'This month' },
  all: { terminal: 'all', graphical: 'All time' },
};
// The footer as [text, joiner] pieces, packed to the pane: two lines at full width, more in a narrow pane.
/** @type {[string, string][]} */
const SAVINGS_FOOTER = [
  ['≈$ = tokens × configured API rates (list/custom)', ' · '],
  ['not invoices or measured quota savings', ' · '],
  ['answer quality not measured', ''],
];
const NOTES = {
  pieces: SAVINGS_FOOTER,
  width: 68,
  title: 'About these numbers',
  lines: [
    '≈$ = tokens × configured API rates (list/custom)',
    'Not invoices or measured quota savings',
    'Answer quality not measured',
  ],
};

// The tier whose route is your model at your effort, for its color; else any tier on your model.
function yourTier(config, view) {
  const runs = (tier) => {
    const route = resolveRoute(config, tier);
    return (
      isSameModel(config.models[route.model].id, view.nativeModel) &&
      routeEffort(config, route, view.nativeEffort) === (view.nativeEffort ?? null)
    );
  };
  return TIERS.find(runs) ?? cellForModel(config, view.nativeModel)?.tier ?? null;
}

/**
 * The Usage tab, answer first for the chosen period: routing against your model as a ledger that adds up, the tokens,
 * the cost by activity, model or tier, the trend and What if, and what is worth a look. Subagents follow, for the same
 * period, then the notes and Delete history.
 */
/**
 * @typedef {object} UsageModel The Usage tab. Each part holds its own readings, words and tones; the parts whose shape
 * differs by state (an empty summary, a period without replies) are typed loosely.
 * @property {{ value: string, options: { value: string, key: string, label: string, selected: boolean, hotkey?: string }[], pick: (period: string) => void, hint: string }} period
 * @property {{ text: string, model: { text: string, tier: string | null } | null, graphical: string }} scope
 * @property {any} summary the cost ledger
 * @property {{ text: string } | null} stats
 * @property {any} breakdown
 * @property {any} compare
 * @property {any} trend
 * @property {any} insights
 * @property {any} agents
 * @property {{ pieces: [string, string][], width: number, title: string, lines: string[] }} notes
 * @property {{ confirming: boolean, ask: any, question: string, yes: any, no: any }} delete
 */
/**
 * @param {import('./frame.mjs').PaneContext} ctx
 * @returns {UsageModel}
 */
export function usageOf({ config, view, usage, actions, now }) {
  const period = PERIODS.includes(view.usagePeriod) ? view.usagePeriod : 'session';
  const record = liveUsage(view, period === 'session' ? view.usageSession : view.usageStore);
  const summary = summarize(record, periodRange(period, now));
  // All adds the undated savings totals kept from before the usage records.
  const kept = period === 'all' ? allTime(record, view.savingsStore) : null;
  const legacy = kept?.legacy ?? null;
  const agents = summarizeSubagents(
    readSubagentStore(period === 'session' ? view.subagentSession : view.subagentStore),
    period === 'session' ? { from: null, to: null } : periodRange(period, now),
  );
  const cost = periodCost(config, {
    summary: kept ? { ...summary, ...kept.totals, observed: kept.observed } : summary,
    agents,
    usage,
  });
  const replies = Boolean(summary.observed.replies);
  const compare = !cost.effortOnly;
  return {
    period: periodOf(period, actions),
    scope: scopeOf(config, view, period, summary, now),
    summary: summaryOf(config, view, period, cost, legacy, actions),
    stats: replies ? statsOf({ ...summary.observed, turns: summary.turns }) : null,
    breakdown: replies ? breakdownOf(view, actions, summary, compare, cost.billing) : null,
    compare: replies ? compareOf(view, actions, summary, cost.billing) : null,
    trend: replies ? trendOf(summary, period, now, cost.billing) : null,
    insights: replies ? insightsOf(summary, actions) : null,
    agents: agentsOf(config, view, actions, period, now, cost.billing),
    notes: NOTES,
    delete: deleteOf(view, actions),
  };
}

// The period buttons; `p` presses the one after the shown period, so it steps through them.
function periodOf(period, actions) {
  const next = PERIODS[(PERIODS.indexOf(period) + 1) % PERIODS.length];
  return {
    value: period,
    options: PERIODS.map((id) => ({
      value: id,
      key: `period-${id}`,
      label: PERIOD_LABEL[id],
      selected: id === period,
      ...(id === next ? { hotkey: 'p' } : {}),
    })),
    pick: (id) => actions.period(id),
    hint: 'p next',
  };
}

// Whose replies the period holds and what each is compared with. `model` is your model with its tier, when the
// terminal draws it in the tier's colour.
function scopeOf(config, view, period, summary, now) {
  if (period === 'session') {
    const recorded = recordedModels(config, view, summary);
    if (recorded) {
      const text =
        Object.keys(summary.yours).length > 1
          ? `this session · each reply vs the model /model selected: ${recorded}`
          : `this session · your model ${recorded}`;
      return { text, model: null, graphical: sentence(text) };
    }
    const yours = yourModel(view);
    return {
      text: 'this session · your model ',
      model: { text: yours, tier: yourTier(config, view) },
      graphical: `This session · your model ${yours}`,
    };
  }
  const span = spanText(period, now, summary.days[0]?.[0]) ?? 'no dated replies yet';
  const text = `all projects · ${span} · each session vs its own model`;
  return { text, model: null, graphical: sentence(text) };
}

// Why a period has no cost to show.
function emptyOf(config, view, period) {
  if (period === 'session' && !modelSpec(config, view.nativeModel)) {
    const name = modelName(view.nativeModel);
    return {
      text: `${name} has no list price in router.json models.`,
      graphical: `${name} has no list price in the settings file.`,
    };
  }
  const off = period === 'session' && (view.phase === 'unavailable' || view.mode === 'manual');
  const text = off
    ? `Routing is ${view.phase === 'unavailable' ? 'unavailable' : 'off'}: replies use your model and are not counted.`
    : `No routed replies ${PERIOD_PHRASE[period]}.`;
  return { text, graphical: text };
}

// The period's cost as one table that adds up: the main thread with the parts of its difference, the subagents and the
// total. "No routing" is your model on the main thread and Claude Code's pick for each subagent; zero rows are left out.
function summaryOf(config, view, period, cost, legacy, actions) {
  if (!cost.replies && !cost.agents) return { empty: emptyOf(config, view, period) };
  const { billing } = cost;
  const compared = cost.diffUsd !== null;
  const r = cost.readout;
  // A row: its label, cost, difference against no routing and what no routing costs; null where a column is empty.
  const row = (label, graphical, amount, diff, base, rowBilling = billing) => ({
    kind: 'row',
    label,
    graphical,
    amount: costText(amount, rowBilling),
    diff: compared ? (diff === null ? { text: '', tone: 'primary' } : saving(diff)) : null,
    base: compared && base !== null ? costText(base, rowBilling) : null,
  });
  const part = (label, graphical, value, /** @type {string | null} */ note = null) =>
    value
      ? { kind: 'part', label, graphical, diff: saving(value), note: note && { text: note, graphical: note } }
      : null;
  // The rebuilds' share of what the cheaper models saved; past all of it the switches lost money, which `lost` says.
  const share = r.switchUsd > 0 && -r.cheaperUsd > 0 ? r.switchUsd / -r.cheaperUsd : null;
  const switches = share !== null && share <= 1 ? `${percent(share)} of the saving` : null;
  const total = TOTAL[period];
  const mainReplies = plural(cost.replies, 'reply', 'replies');
  return {
    empty: null,
    compared,
    headline: compared
      ? {
          compared: true,
          text: diffText(cost.diffUsd, cost.baseUsd),
          tone: savingTone(cost.diffUsd),
          versus: `vs ${UNROUTED}`,
          // A card's delta beside the headline figure.
          delta: `${diffText(cost.diffUsd, cost.baseUsd)} vs ${UNROUTED}`,
          early: cost.early ? `${repliesText(cost)}: ${EARLY_NOTE}` : null,
        }
      : {
          compared: false,
          text: cost.effortOnly
            ? 'Effort routing on one model: no saving is estimated; cost uses configured API rates.'
            : `${sentence(uncomparedText(cost))}: no saving is shown.`,
        },
    // A card's headline figure: the period's total and what it is.
    stat: { value: costText(cost.totalUsd, billing), caption: `${total.graphical} · ${API_ESTIMATE}` },
    header: {
      cost: { terminal: 'cost', graphical: 'Cost' },
      diff: compared ? { terminal: `vs ${UNROUTED}`, graphical: `Vs ${UNROUTED}` } : null,
      base: compared ? { terminal: UNROUTED, graphical: 'Unrouted' } : null,
    },
    rows: [
      row(`main · ${mainReplies}`, `Main · ${mainReplies}`, cost.mainUsd, cost.mainDiff, compared ? r.yoursUsd : null),
      compared ? part('cheaper models', 'Cheaper models', r.cheaperUsd) : null,
      compared ? part('stronger models', 'Stronger models', r.strongerUsd) : null,
      compared ? part('cache rebuilds', 'Cache rebuilds', r.switchUsd, switches) : null,
      cost.agents
        ? row(
            `agents · ${cost.agents}`,
            `Agents · ${cost.agents}`,
            cost.agentUsd,
            compared ? cost.agentDiff : null,
            compared ? cost.agentBaseUsd : null,
          )
        : null,
    ].filter(Boolean),
    total: {
      ...row(`${total.terminal} · ${API_ESTIMATE}`, 'Total', cost.totalUsd, cost.diffUsd, cost.baseUsd),
      strong: true,
    },
    credits:
      billing === 'mixed' ? row('  credits estimate', 'Credits estimate', cost.creditsUsd, null, null, 'billed') : null,
    // A card's columns and their headings; a `wide` column is dropped in a narrow pane.
    labels: { label: '', amount: 'Cost', diff: `Vs ${UNROUTED}`, base: 'Unrouted' },
    columns: [
      { key: 'label' },
      { key: 'amount' },
      ...(compared ? [{ key: 'diff' }, { key: 'base', show: 'wide' }] : []),
    ],
    legacy: legacy?.replies
      ? {
          text: `includes ${usd(legacy.routedUsd)} routed before dated records, kept without a breakdown`,
          graphical: `Includes ${usd(legacy.routedUsd)} routed before dated records, kept without a breakdown`,
        }
      : null,
    lost:
      compared && !r.early && switchesLost(r)
        ? {
            text: 'Switches cost more than they saved',
            button: { key: 'session-policy', label: 'Policy' },
            press: () => actions.tab('policy'),
          }
        : null,
  };
}

// Replies, turns, tokens and the cache share of the input.
const statsOf = (s) => ({
  text:
    `${plural(s.replies, 'reply', 'replies')} · ${plural(s.turns, 'turn')} · input ${formatTokens(s.inputTokens)}` +
    ` · cache hit ${s.inputTokens ? percent(s.cacheReadTokens / s.inputTokens) : '—'} · output ${formatTokens(s.outputTokens)}`,
});

// Routed cost per hour, day or week: the terminal's one line of blocks (a dot for a bucket without replies) and its
// peak, and a card's line chart once there is more than one bucket.
function trendOf(summary, period, now, billing) {
  const t = trend(summary, period, now);
  const head = `COST BY ${t.unit.toUpperCase()}`;
  if (t.values.length < 2) {
    const single = `one ${t.unit} so far`;
    return {
      head,
      single: { terminal: single, graphical: sentence(single) },
      title: 'Trend',
      points: [],
      peak: null,
      chart: null,
    };
  }
  const points = t.values.map(finite);
  const max = Math.max(...points);
  const all =
    t.unit === 'hour'
      ? points.map((_, i) => `${t.from + i}:00`)
      : points.map((_, i) => {
          const [y, m, d] = t.from.split('-').map(Number);
          return dayLabel(dayKey(new Date(y, m - 1, d + i * (t.unit === 'week' ? 7 : 1)).getTime()));
        });
  const title = `Cost by ${t.unit}`;
  return {
    head,
    single: null,
    points,
    peak: { terminal: `peak ${costText(max, billing)}`, graphical: `Peak ${costText(max, billing)}` },
    title: 'Trend',
    hint: title,
    chart: chartOf(title, points, { all }, (value) => costText(value, billing), t.unit === 'hour' ? 'at' : 'on'),
  };
}

// Delete history waits for a second press, as nothing brings the records back.
function deleteOf(view, actions) {
  return {
    confirming: Boolean(view.confirmDelete),
    ask: { key: 'delete-history', label: 'Delete history', press: () => actions.confirmDelete(true) },
    question: 'Delete the usage, activity and subagent history of every session?',
    yes: { key: 'delete-confirm', label: 'Delete', press: actions.resetStats },
    no: { key: 'delete-keep', label: 'Keep', press: () => actions.confirmDelete(false) },
  };
}
