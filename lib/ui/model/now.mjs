// The Now tab's model: what runs next and why, what the plan and the session cost, and how full the context is. The
// model holds the readings as text, numbers and tones; the terminal draws it as rows and the graphical surfaces as cards.

import { ACTIVITIES, resolveRoute, sameRoute, TIERS } from '../../config.mjs';
import { resetText } from '../../costs.mjs';
import { decisionLines } from '../../decisions.mjs';
import {
  API_ESTIMATE,
  activityReading,
  baselineName,
  cardRoute,
  classifierLabel,
  comparedModel,
  costText,
  diffText,
  EARLY_NOTE,
  formatTokens,
  liveUsage,
  modeLever,
  percent,
  percentPair,
  reasonActivity,
  repliesText,
  routeLabel,
  routeName,
  routingModeOf,
  sessionCost,
  sessionUsage,
  shortReason,
  shortRoute,
  shownConfig,
  signedUsd,
  switchesLost,
  uncomparedText,
  usageMetrics,
  usd,
  whyText,
} from '../../display.mjs';
import { limitTone, savingTone } from '../tokens.mjs';
import { plural, sentence, sinceText } from './format.mjs';

const dollars = (value) => (Number.isFinite(value) ? usd(value) : 'not reported');
const contextSuffix = (metrics) =>
  Number.isFinite(metrics.nextContext)
    ? `~${formatTokens(metrics.nextContext)} / ${formatTokens(metrics.window)}`
    : 'no reading yet';

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

/**
 * @typedef {object} NextPin one per tier, low to high
 * @property {string} tier
 * @property {import('./format.mjs').Words} route the route it runs, as the terminal's grid and a card name it
 * @property {string | null} support the classifier's support on the last turn
 * @property {string | null} reading a card's: `current` on the tier that runs now, then the support
 *
 * @typedef {object} NextOffModel NEXT TURN with routing off or unavailable: only the model, a note and what pinning needs.
 * @property {'off' | 'unavailable'} state
 * @property {string} label the model and effort that run
 * @property {import('./format.mjs').Words} note
 * @property {import('./format.mjs').Words} pin why pinning is not offered
 *
 * @typedef {object} NextRoutedModel NEXT TURN with routing on.
 * @property {'routed'} state
 * @property {string} label the model and effort that run
 * @property {string | null} tier
 * @property {{ choice: string, isActivity: boolean, share: string | null, other: string | null } | null} reading
 * @property {string | null} phase
 * @property {string | null} why
 * @property {string | null} support
 * @property {string | null} override
 * @property {{ name: string, from: import('./format.mjs').Words, clear: string | null } | null} mode
 * @property {NextPin[]} pins
 * @property {string | null} pendingPin
 * @property {string} firstTurn a card's line before the first routed turn
 * @property {(tier: string) => void} pick pins the next turn; the pending pin again unpins
 *
 * @typedef {NextOffModel | NextRoutedModel} NextModel
 *
 * @typedef {object} Against a part's difference against no routing
 * @property {number} usd
 * @property {string} text
 * @property {import('../tokens.mjs').Tone | null} tone null when it is zero
 * @property {string} versus
 *
 * @typedef {object} SessionModel SESSION: one total with the subagents, the difference, the parts on one scale.
 * @property {string} head
 * @property {number} running
 * @property {boolean} bandDetail
 * @property {() => void} toggleDetail
 * @property {import('./format.mjs').Words} detailToggle the band's second row, on and off
 * @property {boolean} priced
 * @property {import('./format.mjs').Words | null} empty
 * @property {any} strip the session's replies as cells by tier
 * @property {number | null} since
 * @property {string} total
 * @property {string} billing
 * @property {() => void} usage
 * @property {{ usd: number, text: string, tone: import('../tokens.mjs').Tone, versus: string, of: string } | null} diff
 * @property {string | null} note
 * @property {number} scale
 * @property {{ name: string, usd: number, amount: string, against: Against | null }[]} parts
 * @property {[string, number][]} effortMix
 * @property {boolean} lost
 * @property {() => void} policy
 *
 * @typedef {object} ContextModel CONTEXT: the window's fill, the cache reuse, and what is behind Details.
 * @property {number | null} fill
 * @property {import('../tokens.mjs').Tone} fillTone
 * @property {string} suffix
 * @property {import('./format.mjs').Words} empty
 * @property {{ tone: import('../tokens.mjs').Tone, last: { figure: string, words: string } | null, session: { figure: string, words: string } | null, empty: import('./format.mjs').Words }} cache
 * @property {{ open: boolean, toggle: () => void, readings: { terminal: string[], graphical: string }, input: import('./format.mjs').Words, history: number[], tiers: string[], chart: { points: number[], labels: string[], alt: string, tone: import('../tokens.mjs').Tone } | null, range: import('./format.mjs').Words | null, empty: import('./format.mjs').Words, estimatesHead: import('./format.mjs').Words, estimates: [string, string][] }} detail
 *
 * @typedef {object} NowModel The Now tab: what runs next, the plan, the session and the context.
 * @property {NextModel} next
 * @property {string[]} decisions
 * @property {{ label: string, percent: number, tone: import('../tokens.mjs').Tone, reset: string | null }[]} plan
 * @property {SessionModel} session
 * @property {ContextModel} context
 */
/**
 * @param {import('./frame.mjs').PaneContext} ctx
 * @returns {NowModel}
 */
export function nowOf({ config, view, usage, actions, now }) {
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
/** @returns {NextModel} */
function nextOf(config, view, actions) {
  const unavailable = view.phase === 'unavailable';
  const current = view.selectedModel ?? view.nativeModel;
  if (unavailable)
    return {
      state: 'unavailable',
      label: routeLabel(view.nativeModel, view.nativeEffort),
      note: { terminal: 'routing unavailable · Claude’s model', graphical: 'Routing unavailable · Claude’s model' },
      pin: { terminal: 'needs routing', graphical: 'Pinning needs routing' },
    };
  if (view.mode !== 'auto')
    return {
      state: 'off',
      label: routeLabel(current, view.effort),
      note: { terminal: 'routing off · /model choice', graphical: 'Routing off · /model choice' },
      pin: { terminal: 'needs routing on (o)', graphical: 'Pinning needs routing on' },
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
            from: {
              terminal: `from ${source}${lever ? ` · ${lever} on this tier` : ''}`,
              graphical: `${sentence(routingMode)} mode from ${source}${lever ? ` · ${lever} on this tier` : ''}`,
            },
            clear: source === 'session' ? '/router mode default clears it' : null,
          }
        : null,
    // One per tier, low to high: the route it runs and the classifier's support on the last turn.
    pins: TIERS.map((tier) => {
      const support = view.probabilities?.[tier];
      return {
        tier,
        // A card names the model's family and the effort, as the Routes cards word them.
        route: {
          terminal: shortRoute(config, resolveRoute(shown, tier)),
          graphical: cardRoute(config, resolveRoute(shown, tier), { short: true }),
        },
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
    firstTurn: 'No routed turn yet — the first reply sets the route.',
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
  const against = (diff, versus) =>
    diff === null ? null : { usd: diff, text: signedUsd(diff), tone: diff ? savingTone(diff) : null, versus };
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

// Behind Context's Details: Claude's readings of the last reply, and the input per reply as a trend from the oldest
// reply to the latest, with its range.
function detailOf(observed, view, history, actions, comparison, metrics) {
  const low = formatTokens(Math.min(...history));
  const high = formatTokens(Math.max(...history));
  const replies = `last ${plural(history.length, 'reply', 'replies')}`;
  const tokens = (value) => formatTokens(value);
  return {
    open: Boolean(view.usageDetail),
    toggle: actions.usageDetail,
    readings: {
      terminal: [
        `context observed ${tokens(observed)} · estimated ${tokens(view.contextTokens)}`,
        `cache read ${tokens(view.cacheRead)} · written ${tokens(view.cacheWrite)} tokens`,
        `output ${tokens(view.outputTokens)} tokens on the last reply`,
      ],
      graphical: `Observed ${tokens(observed)} · estimated ${tokens(view.contextTokens)} · cache read ${tokens(view.cacheRead)} · written ${tokens(view.cacheWrite)} · output ${tokens(view.outputTokens)} tokens`,
    },
    input: { terminal: `INPUT PER REPLY · ${replies} · lowest to highest`, graphical: `Input per reply · ${replies}` },
    // The input per reply and the tier each reply ran on, oldest first.
    history,
    tiers: view.tiers ?? [],
    chart: history.length
      ? {
          points: history,
          labels: ['Oldest', 'Latest'],
          alt: `Input per reply over the ${replies}: ${low} to ${high} tokens`,
          tone: /** @type {import('../tokens.mjs').Tone} */ ('accent'),
        }
      : null,
    range: history.length ? { terminal: `${low} … ${high}`, graphical: `${low} lowest · ${high} highest` } : null,
    empty: { terminal: 'no replies yet', graphical: 'No replies yet' },
    estimatesHead: { terminal: 'ESTIMATES · configured API rates', graphical: 'Estimates · configured API rates' },
    // The estimates the last decision weighed, as label and value.
    estimates: /** @type {([string, string] | null)[]} */ ([
      ['Cache hits saved', dollars(metrics.cacheBenefit)],
      Number.isFinite(view.estimate?.taxUsd) ? ['Switch cost', dollars(view.estimate.taxUsd)] : null,
      ...(comparison
        ? [
            ['Compared tiers', `${comparison.incumbent} → ${comparison.candidate}`],
            ['Next-turn difference', `${signedUsd(comparison.minUsd)} to ${signedUsd(comparison.maxUsd)}`],
            ['Payback', comparison.paybackTurns === null ? 'none projected' : `${comparison.paybackTurns} later turns`],
          ]
        : []),
    ]).filter((one) => one !== null),
  };
}

// CONTEXT: the window's fill on the model that runs next, and the cache reuse of the last reply and of the session.
function contextOf(config, view, usage, actions, now) {
  const metrics = usageMetrics(config, view, usage);
  const session = sessionUsage(view, now).observed;
  const history = view.history ?? [];
  return {
    fill: metrics.contextBar.percent,
    fillTone: metrics.contextBar.tone,
    suffix: contextSuffix(metrics),
    empty: { terminal: 'no reading yet', graphical: 'No reading yet' },
    // The cache reuse of the last reply and of the session, each a figure and its words.
    cache: {
      tone: metrics.cacheBar.tone,
      last: metrics.cacheBar.percent === null ? null : { figure: `${metrics.cacheBar.percent}%`, words: 'last reply' },
      session: session.inputTokens
        ? { figure: percent(session.cacheReadTokens / session.inputTokens), words: 'session' }
        : null,
      empty: { terminal: 'no reply yet', graphical: 'No reply yet' },
    },
    detail: detailOf(metrics.observed, view, history, actions, view.comparison, metrics),
  };
}
