// The Usage tab's subagents: the strip of every agent by model, the trend, and the routed and passed-through types.
import { costText, modelName, percent, signedUsd } from '../../display.mjs';
import {
  modelTotals,
  PASS_LABEL,
  PASS_REASONS,
  PASS_WHY,
  readSubagentStore,
  summarizeSubagents,
} from '../../subagents.mjs';
import { dayKey, periodRange } from '../../usage.mjs';
import { savingTone } from '../tokens.mjs';
import { dayLabel, plural, sentence } from './format.mjs';
import { cents, chartOf, NO_DIFF, PERIOD_PHRASE, pricedText, saving, spanText } from './usage-shared.mjs';

/** @typedef {import('../tokens.mjs').Tone} Tone */
/** @typedef {{ text: string, tone: Tone }} Toned */

// A subagent row's squares at most: past this the rest is a count.
const ROW_SQUARES = 9;
// The summary strip's squares at most: past this each model gets its share of them, not one per agent.
const AGENT_STRIP = 25;
// The models in the order their squares go, by family; any other after them by name.
const FAMILIES = ['haiku', 'sonnet', 'opus', 'fable'];

// Why Claude Code picked a pass-through's model, on a card, where the terminal's words name a router.json key.
const PASS_CARD_WHY = { unlisted: 'Not among the subagent types the settings file routes' };

const familyRank = (id) => {
  const rank = FAMILIES.findIndex((family) => id.includes(family));
  return rank < 0 ? FAMILIES.length : rank;
};
const byFamily = (a, b) => familyRank(a[0]) - familyRank(b[0]) || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
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
function agentSummaryOf(s) {
  const models = agentsByModel(s);
  const total = models.reduce((n, [, m]) => n + m.agents, 0);
  const moved = models.reduce((n, [, m]) => n + m.moved, 0);
  const strip = squaresOf(models, AGENT_STRIP, true);
  const names = models.map(([id, m]) => ({
    tone: modelTone(id),
    text: `${modelName(id)} ${m.agents}`,
    graphical: `${modelName(id)} · ${m.agents}`,
  }));
  const routed = Object.entries(s.routed).filter(([, c]) => c.agents > 0);
  const kept = total - moved;
  return {
    strip,
    alt: `${plural(total, 'agent')}: ${models.map(([id, m]) => `${modelName(id)} ${m.agents}, ${m.moved} moved`).join('; ')}`,
    names,
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
  const values = days.map(([, n]) => n);
  return {
    label: 'per day',
    values,
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
    name: { terminal: name, graphical: label },
    squares: squaresOf(
      models.map(([model, m]) => [model, { agents: m.agents, moved: m.moved ?? 0 }]),
      ROW_SQUARES,
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
export function agentsOf(config, view, actions, period, now, billing) {
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
      columns: [],
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
    summary: agentSummaryOf(s),
    trend: agentTrendOf(s, period, now),
    undated,
    groups,
    columns: [{ key: 'name' }, { key: 'squares' }, { key: 'agents' }, { key: 'cost', show: 'wide' }, { key: 'pick' }],
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

/** @returns {Tone} A model's colour as a tone, by family; muted for a model of no known family. */
const modelTone = (id) => {
  const family = FAMILIES.find((one) => String(id ?? '').includes(one));
  return /** @type {Tone} */ (family ? `model:${family}` : 'muted');
};
