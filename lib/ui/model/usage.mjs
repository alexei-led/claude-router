// The Usage tab's model: every reading, word and tone the terminal rows and the graphical cards draw, decided once.
// `usageOf` is the tab's one entry; `lib/ui/terminal/usage.mjs` and `lib/ui/graphical/usage.mjs` lay it out. Where the
// terminal and a card need different words, both sit side by side (`text` and `graphical`, or `{ terminal, graphical }`).
import { ACTIVITIES, resolveRoute, TIERS } from '../../config.mjs';
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
  routeLabel,
  signedUsd,
  sparkline,
  switchesLost,
  UNROUTED,
  uncomparedText,
  usd,
  yourModel,
} from '../../display.mjs';
import { cellForModel, isSameModel } from '../../route.mjs';
import { modelSpec } from '../../savings.mjs';
import {
  modelTotals,
  PASS_LABEL,
  PASS_REASONS,
  PASS_WHY,
  readSubagentStore,
  summarizeSubagents,
} from '../../subagents.mjs';
import {
  allTime,
  breakdown,
  cellsWhere,
  dayKey,
  INSIGHT_REPLIES,
  insights,
  mostlyOn,
  PERIODS,
  periodRange,
  summarize,
  trend,
} from '../../usage.mjs';
import { dayLabel } from '../strip.mjs';
import { savingTone } from '../tokens.mjs';
import { plural, sentence, tierLabel } from './words.mjs';

/** @typedef {import('../tokens.mjs').Tone} Tone */
/** @typedef {{ text: string, tone: Tone }} Toned */

const PERIOD_LABEL = { session: 'Session', today: 'Today', '7d': '7d', '30d': '30d', month: 'Month', all: 'All' };
// "No routed replies …" for each period.
const PERIOD_PHRASE = {
  session: 'this session',
  today: 'today',
  '7d': 'in the last 7 days',
  '30d': 'in the last 30 days',
  month: 'this month',
  all: 'yet',
};
// The cost table's total row: the terminal's word, and the caption under a card's headline figure.
const TOTAL = {
  session: { terminal: 'session', graphical: 'This session' },
  today: { terminal: 'today', graphical: 'Today' },
  '7d': { terminal: '7 days', graphical: 'Last 7 days' },
  '30d': { terminal: '30 days', graphical: 'Last 30 days' },
  month: { terminal: 'month', graphical: 'This month' },
  all: { terminal: 'all', graphical: 'All time' },
};
const GROUPS = [
  ['activity', 'Activity', 'By activity'],
  ['model', 'Model', 'By model'],
  ['tier', 'Tier', 'By tier'],
];
// What an open row lists: the routes of an activity, the activities of a model or a tier.
const CHILD_BY = { activity: 'route', model: 'activity', tier: 'activity' };
// The breakdown's terminal row: the open mark, the name, replies, cost and vs yours; "mostly on" or the share only
// where it fits.
const BREAKDOWN = 4 + 20 + 8 + 10 + 15;
const TAIL = 23;
// Tiers in their own order; `none` (not routed) last.
const TIER_RANK = (name) => (TIERS.includes(name) ? TIERS.indexOf(name) : TIERS.length);
// A graphical pane narrower than this, or one that reports no width, drops each table's least important columns.
const WIDE = 80;

// The subagent rows: the open mark, the type, its squares, agents, cost, and against Claude Code's pick with its arrow.
const AGENT_TYPE = 19;
const AGENT_SQUARES = 12;
const AGENT_ROW = 4 + AGENT_TYPE + AGENT_SQUARES + 3 + 9 + 11;
// The summary strip's squares at most: past this each model gets its share of them, not one per agent.
const AGENT_STRIP = 25;
// The models in the order their squares go, by family; any other after them by name.
const FAMILIES = ['haiku', 'sonnet', 'opus', 'fable'];

// Why Claude Code picked a pass-through's model, on a card, where the terminal's words name a router.json key.
const PASS_CARD_WHY = { unlisted: 'Not among the subagent types the settings file routes' };

// The footer as [text, joiner] pieces, packed to the pane: two lines at full width, more in a narrow pane.
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

/** @returns {Toned} A difference against no routing, signed, in its savings tone. */
const saving = (value) => ({ text: signedUsd(value), tone: savingTone(value) });
// A comparison that is not available.
/** @type {Toned} */
const NO_DIFF = { text: '—', tone: 'muted' };
// A cents difference, so a row never reads "+$0.00" for a fraction of a cent.
const cents = (value) => Math.round(value * 100) / 100;
const clipped = (text, width) => (text.length < width ? text : `${text.slice(0, width - 2)}…`);
const familyRank = (id) => {
  const rank = FAMILIES.findIndex((family) => id.includes(family));
  return rank < 0 ? FAMILIES.length : rank;
};
const byFamily = (a, b) => familyRank(a[0]) - familyRank(b[0]) || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
/** @returns {Tone} A model's colour as a tone, by family; muted for a model of no known family. */
const modelTone = (id) => {
  const family = FAMILIES.find((one) => String(id ?? '').includes(one));
  return /** @type {Tone} */ (family ? `model:${family}` : 'muted');
};
// A figure that is never NaN on a chart.
const finite = (value) => (Number.isFinite(value) ? value : 0);

// "Opus 5.5 · high" for a cell's `id@effort`.
function routeText(route) {
  const at = route.lastIndexOf('@');
  const effort = route.slice(at + 1);
  return routeLabel(route.slice(0, at), effort === 'session' ? null : effort);
}

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

// Prices summed over the priced requests, and how many were not priced (a model without a price in router.json).
const pricedText = (text, counts) =>
  counts.pricedRequests < counts.requests ? `${text} (${counts.requests - counts.pricedRequests} unpriced)` : text;

// "Oct 7 – Oct 13" for a period's span, or "since Oct 10", its `first` day, for one without a range; null without one.
function spanText(period, now, first) {
  const { from, to } = periodRange(period, now);
  if (period === 'today') return `today, ${dayLabel(to)}`;
  if (from) return `${dayLabel(from)} – ${dayLabel(to)}`;
  return first ? `since ${dayLabel(first)}` : null;
}

// A chart of `points`, its first and last bucket labels, and an alt that states the first, last and peak values.
function chartOf(title, points, labels, money, at = 'on') {
  const values = points.map(finite);
  const peak = Math.max(...values);
  const when = labels.all[values.indexOf(peak)];
  return {
    points: values,
    labels: [labels.all[0], labels.all.at(-1)],
    alt: `${title}, ${labels.all[0]} to ${labels.all.at(-1)}: first ${money(values[0])}, last ${money(values.at(-1))}, peak ${money(peak)} ${at} ${when}`,
    tone: /** @type {Tone} */ ('accent'),
  };
}

/**
 * The Usage tab, answer first for the chosen period: routing against your model as a ledger that adds up, the tokens,
 * the cost by activity, model or tier, the trend and What if, and what is worth a look. Subagents follow, for the same
 * period, then the notes and Delete history.
 */
export function usageOf(config, view, usage, actions, columns, now) {
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
  const wide = Number.isFinite(columns) && columns >= WIDE;
  const compare = !cost.effortOnly;
  return {
    wide,
    period: periodOf(period, actions),
    scope: scopeOf(config, view, period, summary, now),
    summary: summaryOf(config, view, period, cost, legacy, actions, wide),
    stats: replies ? statsOf({ ...summary.observed, turns: summary.turns }) : null,
    breakdown: replies ? breakdownOf(view, actions, summary, columns, compare, cost.billing, wide) : null,
    compare: replies ? compareOf(view, actions, summary, cost.billing, wide) : null,
    trend: replies ? trendOf(summary, period, now, cost.billing) : null,
    insights: replies ? insightsOf(summary, actions, columns) : null,
    agents: agentsOf(config, view, actions, period, now, columns, cost.billing, wide),
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
function summaryOf(config, view, period, cost, legacy, actions, wide) {
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
  const part = (label, graphical, value, note = null) =>
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
    // A card's columns and their headings, least important dropped first in a narrow pane.
    labels: { label: '', amount: 'Cost', diff: `Vs ${UNROUTED}`, base: 'Unrouted' },
    columns: ['label', 'amount', ...(compared ? ['diff'] : []), ...(compared && wide ? ['base'] : [])],
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

// A breakdown row's name: an activity as its verb, a tier as its bars, a model or a route by name; `none` in words.
function nameOf(by, name) {
  if (name === 'none') {
    const text = by === 'activity' ? 'no activity' : 'not routed';
    return { kind: 'none', text, graphical: sentence(text) };
  }
  if (by === 'activity') return { kind: by, text: name, graphical: name };
  if (by === 'tier') return { kind: by, text: name, graphical: tierLabel(name) };
  const text = by === 'model' ? modelName(name) : routeText(name);
  return { kind: 'plain', text, graphical: text };
}

// The period's cost by activity, model or tier, most first; `g` presses the next grouping. A row opens to what it
// holds and its cost parts. A narrow terminal drops "mostly on" (or the share) before any number.
function breakdownOf(view, actions, summary, columns, compare, billing, wide) {
  const by = GROUPS.some(([id]) => id === view.usageGroup) ? view.usageGroup : 'activity';
  const next = GROUPS[(GROUPS.findIndex(([id]) => id === by) + 1) % GROUPS.length][0];
  const group = {
    value: by,
    options: GROUPS.map(([id, label, title]) => ({
      value: id,
      key: `group-${id}`,
      label: { terminal: label, graphical: title },
      selected: id === by,
      ...(id === next ? { hotkey: 'g' } : {}),
    })),
    pick: (id) => actions.usageGroup(id),
    head: 'BY  ',
    hint: 'g next',
  };
  const cells = summary.observed.cells;
  // Tiers read low to high, as the band's bars; activities and models lead with the costliest.
  const groups =
    by === 'tier' ? breakdown(cells, by).sort((a, b) => TIER_RANK(a.name) - TIER_RANK(b.name)) : breakdown(cells, by);
  const missing = new Map(breakdown(summary.observed.uncompared, by).map((g) => [g.name, g]));
  const base = { title: 'Breakdown', group };
  if (!groups.length)
    return {
      ...base,
      // Defensive: the Usage tab shows its empty Summary before a period with no replies reaches the breakdown.
      empty: { text: 'no routed replies in this period', graphical: 'Nothing to break down in this period.' },
    };
  const tail = !Number.isFinite(columns) || columns >= BREAKDOWN + TAIL;
  const routedUsd = summary.observed.routedUsd;
  const numbers = (sums, unavailable) => ({
    replies: String(sums[0]),
    cost: costText(sums[1], billing),
    diff: !compare ? null : unavailable ? NO_DIFF : saving(cents(sums[1] - sums[2])),
  });
  const rows = groups.map((one) => {
    const id = `${by}:${one.name}`;
    const open = view.usageOpen === id;
    const route = by === 'model' ? null : mostlyOn(cellsWhere(cells, by, one.name));
    const fraction = routedUsd > 0 ? one.sums[1] / routedUsd : 0;
    const [, , , cheaper, stronger, switched, input, , output] = one.sums;
    const note = missing.has(one.name)
      ? `comparison unavailable · input ${formatTokens(input)} · output ${formatTokens(output)}`
      : `cheaper ${signedUsd(cents(cheaper))} · stronger ${signedUsd(cents(stronger))} · cache rebuilds ${signedUsd(cents(switched))} · input ${formatTokens(input)} · output ${formatTokens(output)}`;
    return {
      key: `row-${id}`,
      open,
      toggle: () => actions.usageOpen(open ? null : id),
      name: nameOf(by, one.name),
      ...numbers(one.sums, missing.has(one.name)),
      // The terminal's last column where it fits: the share of a model, else the route an activity or tier mostly ran.
      tail: !tail ? null : by === 'model' ? percent(fraction) : route ? routeText(route) : null,
      // A card's bar: the row's share of the routed cost, with its figure.
      share: { value: finite(fraction), text: percent(finite(fraction)) },
      children: open
        ? one.children.map((child) => ({
            name: nameOf(CHILD_BY[by], child.name),
            ...numbers(
              child.sums,
              missing.get(one.name)?.children.some((c) => c.name === child.name),
            ),
          }))
        : [],
      note: open ? { text: note, graphical: sentence(note) } : null,
    };
  });
  return {
    ...base,
    empty: null,
    header: {
      replies: { terminal: 'replies', graphical: 'Replies' },
      cost: { terminal: 'cost', graphical: 'Cost' },
      diff: compare ? { terminal: `vs ${UNROUTED}`, graphical: `Vs ${UNROUTED}` } : null,
      tail: tail ? (by === 'model' ? 'share' : 'mostly on') : null,
    },
    labels: { name: '', replies: 'Replies', cost: 'Cost', diff: `Vs ${UNROUTED}`, share: 'Share' },
    columns: wide
      ? ['name', 'replies', 'cost', ...(compare ? ['diff'] : []), 'share']
      : ['name', 'cost', ...(compare ? ['diff'] : [])],
    rows,
  };
}

// What the period's tokens would cost on each model alone, as your model for every reply (compareModels), beside what
// routing spent and your own models; a model some reply had no price on is left out. `toggle` switches the terminal
// between this and the trend, and shows or hides these rows on a card.
function compareOf(view, actions, summary, billing, wide) {
  const on = Boolean(view.usageCompare);
  const base = {
    on,
    toggle: {
      key: 'usage-compare',
      label: { terminal: on ? 'Trend' : 'What if', graphical: 'What if' },
      hotkey: 'c',
      press: actions.usageCompare,
    },
    head: 'WHAT IF',
    hint: { terminal: 'the same tokens on one model', graphical: 'The same tokens on one model alone' },
    title: 'What if',
  };
  if (summary.observed.uncomparedReplies)
    return {
      ...base,
      unavailable: 'What if unavailable: some replies have no comparable cache history.',
      rows: [],
      note: null,
    };
  const yours = Object.keys(summary.yours);
  const single = yours.length === 1 ? yours[0] : null;
  const rows = Object.entries(summary.whatIf)
    .filter(([, [n]]) => n === summary.replies)
    .map(([model, [, value]]) => ({
      label: `${modelName(model)}${model === single ? ' · yours' : ''}`,
      value,
      routed: false,
      yours: model === single,
    }));
  if (!rows.some((row) => row.yours))
    rows.push({
      label: yours.length > 1 ? 'Your models' : 'Your model',
      value: summary.yoursUsd,
      routed: false,
      yours: true,
    });
  rows.push({ label: 'Routed', value: summary.routedUsd, routed: true, yours: false });
  rows.sort((a, b) => a.value - b.value);
  const max = Math.max(...rows.map((row) => row.value));
  const note = 'same tokens and output on each model alone · answer quality not measured';
  return {
    ...base,
    unavailable: null,
    rows: rows.map((row) => ({
      label: row.label,
      strong: row.routed,
      // The bar's fill as a share of the costliest row, in the routed or the plain tone.
      fill: max > 0 ? row.value / max : 0,
      tone: /** @type {Tone} */ (row.routed ? 'accent' : 'muted'),
      cost: costText(row.value, billing),
      diff: row.routed ? null : row.yours ? NO_DIFF : saving(cents(row.value - summary.yoursUsd)),
    })),
    // A wide card draws each cost as its bar's figure.
    columns: wide ? ['label', 'bar', 'diff'] : ['label', 'cost', 'diff'],
    labels: { label: '', bar: 'Cost', cost: 'Cost', diff: 'Vs yours' },
    note: { text: note, graphical: sentence(note) },
  };
}

// Routed cost per hour, day or week: the terminal's one line of blocks (a dot for a bucket without replies) and its
// peak, and a card's line chart once there is more than one bucket.
function trendOf(summary, period, now, billing) {
  const t = trend(summary, period, now);
  const head = `COST BY ${t.unit.toUpperCase()}`;
  if (t.values.length < 2) return { head, single: `one ${t.unit} so far`, points: [], peak: null, chart: null };
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

// The evidence worth a look, each with the tab that changes it: the cell that carried most of the cost, the switch
// writes against the saving, the cell that ran above your model. Never which model to use.
function insightsOf(summary, actions, columns) {
  if (summary.observed.uncomparedReplies || summary.replies < INSIGHT_REPLIES) return null;
  const list = insights(summary);
  if (!list.length) return null;
  return {
    head: 'WORTH A LOOK',
    hint: {
      terminal: 'from the numbers; answer quality is not measured',
      graphical: 'From the numbers; answer quality is not measured',
    },
    title: 'Worth a look',
    items: list.map((insight) => insightOf(insight, actions, columns)),
  };
}

// One finding with the tab that changes it.
function insightOf(insight, actions, columns) {
  if (insight.kind === 'switch') {
    const text = `Cache rebuilds used ${percent(insight.share)} of the cheaper-model saving`;
    return {
      kind: 'switch',
      text,
      graphical: text,
      button: { key: 'insight-switch', label: 'Policy', press: () => actions.tab('policy') },
    };
  }
  const tier = TIERS.includes(insight.tier) ? insight.tier : null;
  const words =
    insight.kind === 'cost'
      ? `carried ${percent(insight.share)} of the cost`
      : `ran ${usd(insight.usd)} above your model`;
  const route = insight.route ? `mostly ${routeText(insight.route)}` : null;
  return {
    kind: insight.kind,
    activity: ACTIVITIES.includes(insight.activity) ? insight.activity : null,
    tier,
    tierLabel: tier ? tierLabel(tier) : null,
    notRouted: { terminal: 'not routed', graphical: 'Not routed' },
    text: words,
    route: { terminal: route && (!Number.isFinite(columns) || columns >= 90) ? route : null, graphical: route },
    button: tier
      ? {
          key: `insight-${insight.kind}`,
          label: 'Routes',
          press: () =>
            actions.openRoute(ACTIVITIES.includes(insight.activity) ? `${insight.activity}.${tier}` : `tier.${tier}`),
        }
      : null,
  };
}

// Each model's agents in a period and how many the router moved, across the routed types and the pass-throughs.
function agentsByModel(s) {
  const models = new Map();
  for (const kind of ['routed', 'passed'])
    for (const counts of Object.values(s[kind]))
      for (const [id, m] of Object.entries(counts.models)) {
        const sum = models.get(id) ?? { agents: 0, moved: 0 };
        models.set(id, { agents: sum.agents + m.agents, moved: sum.moved + (m.moved ?? 0) });
      }
  return [...models].filter(([, m]) => m.agents > 0).sort(byFamily);
}

// Squares for `models` ([id, { agents, moved }]), toned by model, filled for the agents the router moved. `scale`:
// one per agent up to `max`, then each model's share of `max`, at least one. Else one per agent up to `max`, and
// `rest` counts the agents past them. Each run is its tone, filled or not, its count and its glyphs.
function squaresOf(models, max, scale) {
  const total = models.reduce((n, [, m]) => n + m.agents, 0);
  const shown = (n) => (!scale || total <= max || !n ? n : Math.max(1, Math.round((n / total) * max)));
  const runs = [];
  let left = max;
  for (const [id, m] of models) {
    const n = Math.min(shown(m.agents), left);
    const filled = Math.min(n, shown(m.moved));
    const tone = modelTone(id);
    if (filled) runs.push({ tone, filled: true, n: filled, text: '■'.repeat(filled) });
    if (n > filled) runs.push({ tone, filled: false, n: n - filled, text: '□'.repeat(n - filled) });
    left -= n;
  }
  const rest = scale ? 0 : total - (max - left);
  return { runs, width: max - left, rest: rest ? `+${rest}` : null };
}

// "routing −$0.21 (−5%) vs Claude Code’s picks on 7 routed agents", in the session readout's words: the routed
// agents' cost against Claude Code's picks.
function verdictOf(routed) {
  const agents = routed.reduce((n, [, c]) => n + c.agents, 0);
  const totals = routed.map(([, c]) => modelTotals(c));
  const cost = totals.reduce((n, t) => n + t.usd, 0);
  const core = totals.reduce((n, t) => n + t.coreUsd, 0);
  const counts = {
    requests: routed.reduce((n, [, c]) => n + c.requests, 0),
    pricedRequests: routed.reduce((n, [, c]) => n + c.pricedRequests, 0),
  };
  if (!counts.pricedRequests) {
    const text = `${plural(agents, 'routed agent')}, not priced`;
    return { priced: false, text, graphical: text };
  }
  const difference = cents(cost - core);
  const on = pricedText(` on ${plural(agents, 'routed agent')}`, counts);
  const share = core > 0 && difference ? ` (${difference < 0 ? '−' : '+'}${percent(Math.abs(difference) / core)})` : '';
  return {
    priced: true,
    text: `routing ${signedUsd(difference)}${share}`,
    tone: savingTone(difference),
    versus: ' vs Claude Code’s picks',
    on,
    graphical: `Routing ${signedUsd(difference)}${share} vs Claude Code’s picks${on}`,
  };
}

// The strip of every agent by model, what the router moved, and how routing paid off.
function agentSummaryOf(s, columns) {
  const models = agentsByModel(s);
  const total = models.reduce((n, [, m]) => n + m.agents, 0);
  const moved = models.reduce((n, [, m]) => n + m.moved, 0);
  const strip = squaresOf(models, AGENT_STRIP, true);
  const names = models.map(([id, m]) => ({
    tone: modelTone(id),
    text: `${modelName(id)} ${m.agents}`,
    graphical: `${modelName(id)} · ${m.agents}`,
  }));
  const namesWidth = names.reduce((n, { text }, i) => n + (i ? 3 : 0) + text.length, 0);
  const routed = Object.entries(s.routed).filter(([, c]) => c.agents > 0);
  const kept = total - moved;
  return {
    strip,
    alt: `${plural(total, 'agent')}: ${models.map(([id, m]) => `${modelName(id)} ${m.agents}, ${m.moved} moved`).join('; ')}`,
    names,
    // The terminal puts the names under the strip where both do not fit on one row.
    split: Number.isFinite(columns) && 2 + strip.width + 2 + namesWidth > columns,
    total: plural(total, 'agent'),
    moved: { terminal: `■ ${moved} moved by the router`, graphical: `${moved} moved by the router` },
    kept: { terminal: `□ ${kept} on Claude Code’s pick`, graphical: `${kept} on Claude Code’s pick` },
    verdict: routed.length ? verdictOf(routed) : null,
  };
}

// Agents per day from the period's first day, or the first recorded one, to today, with the busiest day.
function agentTrendOf(s, period, now) {
  if (period === 'session' || period === 'today' || !s.perDay.length) return null;
  const counts = new Map(s.perDay);
  const start = periodRange(period, now).from ?? s.perDay[0][0];
  const [y, m, d] = start.split('-').map(Number);
  const days = [];
  for (let i = 0; ; i += 1) {
    const key = dayKey(new Date(y, m - 1, d + i).getTime());
    if (key > dayKey(now)) break;
    days.push([key, counts.get(key) ?? 0]);
  }
  if (days.length < 2) return null;
  const [peakDay, peak] = days.reduce((top, day) => (day[1] > top[1] ? day : top));
  // A long All period keeps its last days, as many as the terminal row has room for.
  const values = days.map(([, n]) => n);
  return {
    label: 'per day',
    glyphs: sparkline(values.slice(-(AGENT_ROW - 30))),
    peak: { terminal: `peak ${peak} on ${dayLabel(peakDay)}`, graphical: `Peak ${peak} on ${dayLabel(peakDay)}` },
    title: 'Agents per day',
    chart: chartOf('Agents per day', values, { all: days.map(([key]) => dayLabel(key)) }, String),
  };
}

// "+$0.44 ▲" against Claude Code's pick, in the savings tones; a dash when it rounds to nothing.
const pickOf = (value) =>
  value
    ? { ...saving(value), text: `${signedUsd(value)} ${value > 0 ? '▲' : '▼'}`, dash: false }
    : { ...NO_DIFF, dash: true };

// What a routed model row holds: "2 moved up", or "1 kept, 2 down".
function moveText(m) {
  const kept = m.agents - m.moved;
  const other = m.moved - m.up - m.down;
  const parts = [
    kept ? `${kept} kept` : null,
    m.up ? `${m.up} up` : null,
    m.down ? `${m.down} down` : null,
    other ? `${other} moved` : null,
  ].filter(Boolean);
  if (parts.length > 1 || kept) return parts.join(', ');
  return `${m.moved} moved${m.up ? ' up' : m.down ? ' down' : ''}`;
}

// One row of the subagent table; open, the models it ran on with their cost, and its requests and retry proxies.
function agentRowOf(view, actions, { id, name, label = name, counts, routed, why, billing }) {
  const open = view.usageOpen === id;
  const models = Object.entries(counts.models)
    .filter(([, m]) => m.agents > 0)
    .sort(byFamily);
  const t = modelTotals(counts);
  // A row none of whose requests had a price says so rather than $0.00.
  const priced = counts.pricedRequests > 0;
  /** @returns {Toned} */
  const costOf = (value) =>
    priced ? { text: costText(value, billing), tone: 'primary' } : { text: 'no price', tone: 'muted' };
  const notes = [
    `${(counts.requests / counts.agents).toFixed(1)} requests per agent`,
    routed ? `${counts.respawns || 'none'} respawned within 10 min` : null,
    counts.failures ? plural(counts.failures, 'classifier failure') : null,
    counts.pricedRequests < counts.requests ? `${counts.requests - counts.pricedRequests} requests not priced` : null,
  ].filter(Boolean);
  return {
    key: `row-${id}`,
    open,
    toggle: () => actions.usageOpen(open ? null : id),
    name: { terminal: clipped(name, AGENT_TYPE), graphical: label },
    squares: squaresOf(
      models.map(([model, m]) => [model, { agents: m.agents, moved: m.moved ?? 0 }]),
      AGENT_SQUARES - 3,
      false,
    ),
    alt: `${label}: ${models.map(([model, m]) => `${modelName(model)} ${m.agents}, ${m.moved ?? 0} moved`).join('; ')}`,
    agents: String(counts.agents),
    cost: costOf(t.usd),
    pick: routed && priced ? pickOf(cents(t.usd - t.coreUsd)) : null,
    why: routed ? null : (why ?? null),
    children: open
      ? models.map(([model, m]) => ({
          tone: modelTone(model),
          filled: Boolean(m.moved),
          text: `${m.moved ? '■' : '□'} ${modelName(model)}`,
          name: modelName(model),
          detail: routed ? moveText(m) : plural(m.agents, 'agent'),
          cost: costOf(m.usd),
          pick: routed && priced ? pickOf(cents(m.usd - m.coreUsd)) : null,
        }))
      : [],
    notes: open ? { text: notes.join(' · '), graphical: sentence(notes.join(' · ')) } : null,
  };
}

// Subagents in the chosen period: this session's record, or every session's in every project (one $.store per
// plugin install). A strip of every agent by the model it ran on, filled where the router moved it off Claude Code's
// pick, and the routed agents' cost against those picks. Then the routed types and the pass-throughs, each with its
// squares, agents and cost, opening to its models; a pass-through says why Claude Code picked.
function agentsOf(config, view, actions, period, now, columns, billing, wide) {
  const mode = config.subagentRouting;
  const record = readSubagentStore(period === 'session' ? view.subagentSession : view.subagentStore);
  const s = summarizeSubagents(record, periodRange(period, now));
  const first = Number.isFinite(record.since) ? dayKey(record.since) : null;
  const scope =
    period === 'session' ? 'this session' : `all projects · ${spanText(period, now, first) ?? 'nothing yet'}`;
  const base = {
    head: 'SUBAGENTS',
    scope: ` · ${scope}   subagent routing ${mode}`,
    title: 'Subagents',
    hint: `${sentence(scope)} · Subagent routing is ${mode}`,
  };
  const routed = Object.entries(s.routed)
    .filter(([, c]) => c.agents > 0)
    .sort((a, b) => b[1].agents - a[1].agents || (a[0] < b[0] ? -1 : 1));
  const passed = PASS_REASONS.filter((reason) => s.passed[reason]?.agents > 0).sort(
    (a, b) => s.passed[b].agents - s.passed[a].agents,
  );
  const undatedText = s.undated
    ? `+ ${plural(s.undated.agents, 'agent')} from before 1.14.0, not split by model · ${costText(s.undated.usd, billing)}`
    : null;
  const undated = undatedText ? { text: undatedText, graphical: undatedText } : null;
  if (!routed.length && !passed.length) {
    const older = !s.undated && periodRange(period, now).from !== null && readSubagentStore(view.subagentStore).undated;
    const none = `No subagents ${PERIOD_PHRASE[period]}.`;
    return {
      ...base,
      empty:
        mode === 'off'
          ? {
              text: 'Not recorded: subagentRouting is off in router.json.',
              graphical: 'Not recorded: subagent routing is off in the settings file.',
            }
          : { text: none, graphical: none },
      undated,
      older: older ? 'Agents from before 1.14.0 have no date: All shows them.' : null,
    };
  }
  const narrow = Number.isFinite(columns) && columns < AGENT_ROW;
  const rowOf = (fields) => agentRowOf(view, actions, { billing, ...fields });
  const groups = [
    routed.length
      ? {
          head: 'ROUTED',
          hint: { terminal: 'the router picked the model at spawn', graphical: 'The router picked the model at spawn' },
          title: 'Routed',
          header: { type: 'type', agents: 'agents', cost: 'cost', pick: 'vs CC' },
          labels: { name: '', squares: '', agents: 'Agents', cost: 'Cost', pick: 'Vs Claude Code' },
          rows: routed.map(([type, counts]) => rowOf({ id: `subagent:${type}`, name: type, counts, routed: true })),
        }
      : null,
    passed.length
      ? {
          head: 'NOT ROUTED',
          hint: { terminal: 'Claude Code picked the model', graphical: 'Claude Code picked the model' },
          title: 'Not routed',
          header: null,
          labels: { name: '', squares: '', agents: 'Agents', cost: 'Cost', pick: '' },
          rows: passed.map((reason) =>
            rowOf({
              id: `subagent-pass:${reason}`,
              name: PASS_LABEL[reason],
              label: sentence(PASS_LABEL[reason]),
              counts: s.passed[reason],
              routed: false,
              why: { terminal: PASS_WHY[reason], graphical: PASS_CARD_WHY[reason] ?? sentence(PASS_WHY[reason]) },
            }),
          ),
        }
      : null,
  ].filter(Boolean);
  return {
    ...base,
    empty: null,
    narrow,
    summary: agentSummaryOf(s, columns),
    trend: agentTrendOf(s, period, now),
    undated,
    groups,
    columns: wide ? ['name', 'squares', 'agents', 'cost', 'pick'] : ['name', 'squares', 'agents', 'pick'],
    legend: [
      {
        text: '■ moved by the router · □ Claude Code’s pick · color: the model',
        graphical: 'Filled squares: moved by the router · outlined: Claude Code’s pick · each model in its own color',
      },
      routed.length
        ? {
            text: 'vs CC: the same tokens on Claude Code’s pick, at configured API rates',
            graphical: 'Vs Claude Code: the same tokens on Claude Code’s pick, at configured API rates',
          }
        : null,
    ].filter(Boolean),
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
