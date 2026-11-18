// The Usage tab's cost by activity, model or tier, What if, and what is worth a look.
import { ACTIVITIES, TIERS } from '../../config.mjs';
import { costText, formatTokens, modelName, percent, signedUsd, UNROUTED, usd } from '../../display.mjs';
import { breakdown, cellsWhere, INSIGHT_REPLIES, insights, mostlyOn } from '../../usage.mjs';
import { sentence, tierLabel } from './format.mjs';
import { cents, finite, NO_DIFF, routeText, saving } from './usage-shared.mjs';

/** @typedef {import('../tokens.mjs').Tone} Tone */
/** @typedef {{ text: string, tone: Tone }} Toned */

const GROUPS = [
  ['activity', 'Activity', 'By activity'],
  ['model', 'Model', 'By model'],
  ['tier', 'Tier', 'By tier'],
];
// What an open row lists: the routes of an activity, the activities of a model or a tier.
const CHILD_BY = { activity: 'route', model: 'activity', tier: 'activity' };
// Tiers in their own order; `none` (not routed) last.
const TIER_RANK = (name) => (TIERS.includes(name) ? TIERS.indexOf(name) : TIERS.length);
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
export function breakdownOf(view, actions, summary, compare, billing) {
  const by = GROUPS.some(([id]) => id === view.usageGroup) ? view.usageGroup : 'activity';
  const next = GROUPS[(GROUPS.findIndex(([id]) => id === by) + 1) % GROUPS.length]?.[0];
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
      columns: [],
      empty: { text: 'no routed replies in this period', graphical: 'Nothing to break down in this period.' },
    };
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
      tail: by === 'model' ? percent(fraction) : route ? routeText(route) : null,
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
      tail: by === 'model' ? 'share' : 'mostly on',
    },
    labels: { name: '', replies: 'Replies', cost: 'Cost', diff: `Vs ${UNROUTED}`, share: 'Share' },
    columns: [
      { key: 'name' },
      { key: 'replies', show: 'wide' },
      { key: 'cost' },
      ...(compare ? [{ key: 'diff' }] : []),
      { key: 'share', show: 'wide' },
    ],
    rows,
  };
}

// What the period's tokens would cost on each model alone, as your model for every reply (compareModels), beside what
// routing spent and your own models; a model some reply had no price on is left out. `toggle` switches the terminal
// between this and the trend, and shows or hides these rows on a card.
export function compareOf(view, actions, summary, billing) {
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
      columns: [],
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
    columns: [{ key: 'label' }, { key: 'bar', show: 'wide' }, { key: 'cost', show: 'narrow' }, { key: 'diff' }],
    labels: { label: '', bar: 'Cost', cost: 'Cost', diff: 'Vs yours' },
    note: { text: note, graphical: sentence(note) },
  };
}

// The evidence worth a look, each with the tab that changes it: the cell that carried most of the cost, the switch
// writes against the saving, the cell that ran above your model. Never which model to use.
export function insightsOf(summary, actions) {
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
    items: list.map((insight) => insightOf(insight, actions)),
  };
}

// One finding with the tab that changes it.
function insightOf(insight, actions) {
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
    route,
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
