// What a session cost and how it is paid, as one value the band, the pane and /router all read, so they show the same
// numbers at the same moment. Pure: the inputs are the period's usage summary (usage.mjs), its subagent summary
// (subagents.mjs), the configured models and Claude Code's plan windows.
//
// Every dollar is tokens at the router file's list prices. How that dollar is paid decides its label: on a Claude plan
// it is quota, an "API value" shown with ≈; with an API key or a provider's credits it is billed. "No routing" is what
// the same tokens cost without the router: your model on the main thread, Claude Code's pick for each subagent.

import { EFFORTS, TIERS } from './config.mjs';
import { modelSpec, readout } from './savings.mjs';
import { dayKey } from './usage.mjs';

// The plan windows Claude Code reports, in the order shown. `spend_limit` is a gateway's cap on billed spend, not a
// plan's quota.
const WINDOWS = [
  ['five_hour', '5h'],
  ['seven_day', '7d'],
  ['spend_limit', 'spend'],
];
const QUOTA = ['five_hour', 'seven_day'];

// The windows with a reading, `{ kind, label, percent, resetsAt }` (resetsAt in ms, or null), in WINDOWS order.
export function planLimits(usage) {
  const limits = Array.isArray(usage?.rateLimits) ? usage.rateLimits : [];
  return WINDOWS.flatMap(([kind, label]) => {
    const limit = limits.find((l) => l?.kind === kind && Number.isFinite(l.percentUsed));
    if (!limit) return [];
    const resetsAt = Date.parse(limit.resetsAt ?? '');
    return [{ kind, label, percent: limit.percentUsed, resetsAt: Number.isFinite(resetsAt) ? resetsAt : null }];
  });
}

// How the session pays: `plan` (Claude plan quota), `mixed` (plan quota and provider credits), or `billed` (API key,
// gateway or credits). A plan shows itself only through its windows, which Claude Code reads from the first reply on:
// before that a plan session reads as billed, with nothing spent yet.
export function billingOf(config, usage) {
  const models = Object.values(config.models);
  const credits = models.some((m) => m.billing === 'credits');
  const plan = models.some((m) => m.billing === 'plan');
  if (!plan || !planLimits(usage).some((l) => QUOTA.includes(l.kind))) return 'billed';
  return credits ? 'mixed' : 'plan';
}

// Whether every route runs one model, so routing only moves the effort. The savings estimate holds output length
// constant and cannot price an effort change, so such a profile shows its effort mix instead of a saving.
export function isEffortOnly(config) {
  const cells = [
    ...TIERS.map((tier) => config.routes[tier]),
    ...(config.activityRouting === 'off' ? [] : Object.values(config.activities ?? {}).flatMap(Object.values)),
  ].filter(Boolean);
  return new Set(cells.map((route) => route.model)).size === 1;
}

const cents = (usd) => Math.round(usd * 100) / 100;
// A cell key ends with the route `id@effort` (usage.mjs replyEntry).
const routeOfCell = (key) => {
  const route = key.slice(key.lastIndexOf('|') + 1);
  const at = route.lastIndexOf('@');
  return at < 0 ? { id: route, effort: null } : { id: route.slice(0, at), effort: route.slice(at + 1) || null };
};

// Replies by effort, in effort order: [[effort, replies]].
function effortMix(cells) {
  const counts = {};
  for (const [key, sums] of Object.entries(cells)) {
    const { effort } = routeOfCell(key);
    const name = effort ?? 'default';
    counts[name] = (counts[name] ?? 0) + sums[0];
  }
  const rank = (e) => (EFFORTS.includes(e) ? EFFORTS.indexOf(e) : EFFORTS.length);
  return Object.entries(counts)
    .filter(([, n]) => n > 0)
    .sort((a, b) => rank(a[0]) - rank(b[0]));
}

// Subagents in a period: how many ran, what they cost, and what the same tokens cost on Claude Code's picks. A
// pass-through ran on Claude Code's pick, so it costs the same with and without routing. A record from before 1.14.0
// keeps undated totals without a pick price: they count as unrouted.
export function agentCosts(config, summary) {
  const out = { agents: 0, moved: 0, usd: 0, baseUsd: 0, creditsUsd: 0 };
  for (const kind of ['routed', 'passed'])
    for (const counts of Object.values(summary?.[kind] ?? {})) {
      out.agents += counts.agents;
      for (const [id, model] of Object.entries(counts.models)) {
        out.usd += model.usd;
        out.baseUsd += kind === 'routed' ? model.coreUsd : model.usd;
        out.moved += model.moved ?? 0;
        if (modelSpec(config, id)?.billing === 'credits') out.creditsUsd += model.usd;
      }
    }
  if (summary?.undated) {
    out.agents += summary.undated.agents;
    out.usd += summary.undated.usd;
    out.baseUsd += summary.undated.usd;
  }
  return out;
}

// The period's cost: `summary` from usage.mjs summarize, `agents` from subagents.mjs summarizeSubagents. `usage` is
// Claude Code's session usage: its plan windows tell how every period is paid.
export function periodCost(config, { summary, agents, usage = null }) {
  const a = agentCosts(config, agents);
  const r = readout(summary);
  const effortOnly = isEffortOnly(config);
  // A saving needs every main reply compared; effort-only profiles have none to show. Agents alone compare too: each
  // has Claude Code's pick to price against.
  const comparable = !effortOnly && (summary.replies > 0 || a.agents > 0) && !summary.observed.uncomparedReplies;
  const mainUsd = cents(summary.observed.routedUsd);
  const agentUsd = cents(a.usd);
  const agentBaseUsd = cents(a.baseUsd);
  const totalUsd = cents(mainUsd + agentUsd);
  const mainDiff = comparable ? r.differenceUsd : null;
  const agentDiff = cents(agentUsd - agentBaseUsd);
  const baseUsd = comparable ? cents(r.yoursUsd + agentBaseUsd) : null;
  const diffUsd = comparable ? cents(mainDiff + agentDiff) : null;
  const billing = billingOf(config, usage);
  let creditsUsd = null;
  if (billing === 'mixed') {
    let main = 0;
    for (const [key, sums] of Object.entries(summary.observed.cells))
      if (modelSpec(config, routeOfCell(key).id)?.billing === 'credits') main += sums[1];
    creditsUsd = cents(main + a.creditsUsd);
  }
  return {
    billing,
    replies: summary.observed.replies,
    agents: a.agents,
    moved: a.moved,
    mainUsd,
    agentUsd,
    agentBaseUsd,
    totalUsd,
    mainDiff,
    agentDiff: agentUsd || agentBaseUsd ? agentDiff : null,
    baseUsd,
    diffUsd,
    share: baseUsd > 0 ? diffUsd / baseUsd : null,
    // A sample of main replies: agents alone are each priced against their own pick, not sampled.
    early: r.early && summary.replies > 0,
    readout: r,
    comparable,
    uncomparedReplies: summary.observed.uncomparedReplies,
    effortOnly,
    effortMix: effortMix(summary.observed.cells),
    creditsUsd,
    limits: planLimits(usage),
  };
}

// "17:00" today, "Thu 09:00" on another day; null once the reset has passed, as the reading is then stale.
export function resetText(ms, now) {
  if (!Number.isFinite(ms) || ms <= now) return null;
  const date = new Date(ms);
  const time = date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  return dayKey(ms) === dayKey(now) ? time : `${date.toLocaleDateString('en-US', { weekday: 'short' })} ${time}`;
}
