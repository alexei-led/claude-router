// Activity statistics: counts only, never text. The session reducer feeds the Usage tab; the store reducers feed the
// counts kept across sessions under `activity:stats:v1` and `activity:metrics:v1`. Pure: state and a turn in, new
// state out.

import { acceptActivity } from './activity.mjs';
import { ACTIVITIES, ACTIVITY_VALUES } from './config.mjs';

export const OBSERVED = ['code', 'docs', 'ops', 'read', 'talk'];
export const STORE_KEY = 'activity:stats:v1';
export const METRICS_KEY = 'activity:metrics:v1';

// The observed buckets each predicted activity allows. A weak oracle: it tells code from ops and explore, and cannot
// separate plan from review. That is enough to catch a cheap route on a coding turn.
export const ALLOWED = {
  code: ['code'],
  debug: ['code', 'ops', 'read'],
  explore: ['read', 'talk'],
  plan: ['talk', 'read', 'docs'],
  review: ['read', 'talk'],
  // git status or a test listing is still running commands: a read-only Bash turn is ops too.
  ops: ['ops', 'read'],
  docs: ['docs'],
};

// An answer without an allowed set (uncertain, none) never agrees; callers count agreement only for activities.
export function agrees(predicted, observed) {
  return Boolean(ALLOWED[predicted]?.includes(observed));
}

const RUN_BUCKETS = 5;
const CONFUSION_ROWS = [...ACTIVITY_VALUES, 'none'];

const count = (n) => (Number.isFinite(n) && n > 0 ? Math.floor(n) : 0);

// The shadow readout: turns in shadow, those `on` would have routed differently, and of those the ones with a
// next-request estimate (`estimated`) and the sum of their [min, max] ranges in USD at configured list prices.
const emptyShadow = () => ({ differs: 0, turns: 0, estimated: 0, minUsd: 0, maxUsd: 0 });
const isRange = (r) => Number.isFinite(r?.minUsd) && Number.isFinite(r?.maxUsd);

function addShadow(shadow, wouldDiffer, range) {
  const priced = wouldDiffer && isRange(range);
  return {
    differs: shadow.differs + (wouldDiffer ? 1 : 0),
    turns: shadow.turns + 1,
    estimated: shadow.estimated + (priced ? 1 : 0),
    minUsd: shadow.minUsd + (priced ? range.minUsd : 0),
    maxUsd: shadow.maxUsd + (priced ? range.maxUsd : 0),
  };
}

function addRoutes(before, added) {
  const next = { ...before };
  for (const [route, n] of Object.entries(added ?? {})) if (count(n)) next[route] = (next[route] ?? 0) + count(n);
  return next;
}

// The route most of an activity's routed replies went out with, `model@effort`; ties go to the first in name order,
// so the readout is stable. Null without routed replies.
export function mostlyOn(counts) {
  const [top] = Object.entries(counts?.routes ?? {}).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  return top?.[0] ?? null;
}

export function emptySession() {
  return {
    byActivity: {},
    switches: { tier: 0, activity: 0 },
    lateral: { taken: 0, refused: 0 },
    agreement: { matched: 0, total: 0 },
    shadow: emptyShadow(),
  };
}

// One finished turn. `activity` is the turn's label (null: none), `answer` the classifier's accepted activity, which
// agreement compares with the tools (null: not counted), `lateral` the turn's lateral outcome (turnActivity, counted
// outside shadow only), `shadow` marks a turn in shadow mode, `wouldDiffer` says whether 'on' would have routed it
// differently (null: no would-route) and `wouldUsd` prices that difference. `routedUsd` is the list price of the
// turn's priced replies (null: none had a price), `pricedRequests` how many of its replies had one, and `routes` counts
// its routed replies by the `model@effort` they went out with.
export function recordTurn(
  session,
  {
    activity,
    answer,
    observed,
    requests,
    inputTokens,
    outputTokens,
    routedUsd = null,
    pricedRequests = 0,
    routes = {},
    tierSwitches,
    activitySwitches,
    lateral,
    wouldDiffer,
    wouldUsd,
    shadow,
  },
) {
  const key = activity ?? 'none';
  const before = session.byActivity[key] ?? { turns: 0, requests: 0, inputTokens: 0, outputTokens: 0 };
  // A view saved by 1.7.0 has no lateral counts.
  const moves = { taken: 0, refused: 0, ...session.lateral };
  return {
    byActivity: {
      ...session.byActivity,
      [key]: {
        turns: before.turns + 1,
        requests: before.requests + count(requests),
        inputTokens: before.inputTokens + count(inputTokens),
        outputTokens: before.outputTokens + count(outputTokens),
        // Counts saved by 1.7.0 have no cost, priced replies or routes: their replies stay unpriced.
        routedUsd: Number.isFinite(routedUsd) ? (before.routedUsd ?? 0) + routedUsd : (before.routedUsd ?? null),
        pricedRequests: (before.pricedRequests ?? 0) + count(pricedRequests),
        routes: addRoutes(before.routes ?? {}, routes),
      },
    },
    switches: {
      tier: session.switches.tier + count(tierSwitches),
      activity: session.switches.activity + count(activitySwitches),
    },
    // In shadow the lateral outcome is the would-route's, which no route followed; the Shadow line covers it.
    lateral:
      !shadow && (lateral === 'taken' || lateral === 'refused') ? { ...moves, [lateral]: moves[lateral] + 1 } : moves,
    agreement: answer
      ? {
          matched: session.agreement.matched + (agrees(answer, observed) ? 1 : 0),
          total: session.agreement.total + 1,
        }
      : session.agreement,
    // A view saved by 1.6.0 has no estimate fields.
    shadow: shadow
      ? addShadow({ ...emptyShadow(), ...session.shadow }, wouldDiffer === true, wouldUsd)
      : { ...emptyShadow(), ...session.shadow },
  };
}

// Classifier wait per turn, bucketed by these upper bounds in ms, plus one bucket above the last; kept per classifier
// id for at most LATENCY_CLASSIFIERS ids, so the store stays bounded.
export const LATENCY_BOUNDS = [
  100, 150, 200, 250, 300, 350, 400, 450, 500, 600, 700, 800, 900, 1000, 1250, 1500, 2000, 2500, 3000, 4000, 5000,
];
const LATENCY_BUCKETS = LATENCY_BOUNDS.length + 1;
const LATENCY_CLASSIFIERS = 8;

export function emptyStore() {
  return { version: 1, confusion: {}, runs: {}, lateral: { taken: 0, refused: 0 }, shadow: emptyShadow() };
}

// The p95 of a latency histogram: the upper bound of its bucket in ms, `over` when it lies above the last bound, and
// the turns counted. Null without turns.
export function latencyP95(buckets) {
  const turns = (buckets ?? []).reduce((sum, n) => sum + n, 0);
  if (!turns) return null;
  let seen = 0;
  const at = buckets.findIndex((n) => {
    seen += n;
    return seen >= 0.95 * turns;
  });
  return at < LATENCY_BOUNDS.length
    ? { ms: LATENCY_BOUNDS[at], over: false, turns }
    : { ms: LATENCY_BOUNDS.at(-1), over: true, turns };
}

const isCount = (n) => Number.isSafeInteger(n) && n >= 0;
const isRecord = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const onlyKeys = (v, keys) => isRecord(v) && Object.keys(v).every((k) => keys.includes(k));
const countsOf = (v, keys) => onlyKeys(v, keys) && Object.values(v).every(isCount);
const exactCountsOf = (v, keys) =>
  isRecord(v) && Object.keys(v).length === keys.length && keys.every((k) => isCount(v[k]));

const SHADOW_COUNTS = ['differs', 'turns'];
const SHADOW_ESTIMATE = ['estimated', 'minUsd', 'maxUsd'];
// 1.6.0 kept the shadow counts only; 1.6.1 adds the estimate. Either shape, never a part of the estimate.
const isShadow = (v) =>
  exactCountsOf(v, SHADOW_COUNTS) ||
  (onlyKeys(v, [...SHADOW_COUNTS, ...SHADOW_ESTIMATE]) &&
    Object.keys(v).length === 5 &&
    SHADOW_COUNTS.every((k) => isCount(v[k])) &&
    isCount(v.estimated) &&
    Number.isFinite(v.minUsd) &&
    Number.isFinite(v.maxUsd));

// The stored value if it has a known shape, filled to the current one, else an empty store: a hand-edited or
// unknown file must not break stats. The shape is 1.7.0's, which rejects any other key: a new count goes under its own
// key, such as METRICS_KEY, so a downgrade keeps these.
export function readStore(value) {
  const ok =
    onlyKeys(value, ['version', 'confusion', 'runs', 'lateral', 'shadow']) &&
    value.version === 1 &&
    onlyKeys(value.confusion, CONFUSION_ROWS) &&
    Object.values(value.confusion).every((row) => countsOf(row, OBSERVED)) &&
    onlyKeys(value.runs, ACTIVITIES) &&
    Object.values(value.runs).every(
      (lengths) => Array.isArray(lengths) && lengths.length === RUN_BUCKETS && lengths.every(isCount),
    ) &&
    exactCountsOf(value.lateral, ['taken', 'refused']) &&
    isShadow(value.shadow);
  return ok ? { ...value, shadow: { ...emptyShadow(), ...value.shadow } } : emptyStore();
}

// One finished turn. `predicted` is the classifier's answer (null: none), `runEnded` a run that closed this turn,
// `lateral` the outcome of a lateral switch decision, `wouldDiffer` the shadow readout (null: not in shadow) and
// `wouldUsd` its estimate. Unknown labels are dropped, so the store keeps a fixed set of keys.
export function recordStore(store, { predicted, observed, runEnded, lateral, wouldDiffer, wouldUsd }) {
  const row = predicted ?? 'none';
  const next = {
    version: 1,
    confusion: { ...store.confusion },
    runs: { ...store.runs },
    lateral: { ...store.lateral },
    shadow: { ...store.shadow },
  };
  if (CONFUSION_ROWS.includes(row) && OBSERVED.includes(observed))
    next.confusion[row] = { ...next.confusion[row], [observed]: (next.confusion[row]?.[observed] ?? 0) + 1 };
  if (runEnded && ACTIVITIES.includes(runEnded.activity) && runEnded.length >= 1) {
    const lengths = [...(next.runs[runEnded.activity] ?? Array(RUN_BUCKETS).fill(0))];
    lengths[Math.min(Math.floor(runEnded.length), RUN_BUCKETS) - 1] += 1;
    next.runs[runEnded.activity] = lengths;
  }
  if (lateral === 'taken' || lateral === 'refused') next.lateral[lateral] += 1;
  if (typeof wouldDiffer === 'boolean') next.shadow = addShadow(next.shadow, wouldDiffer, wouldUsd);
  return next;
}

// The readings kept across sessions beside the stats store, under METRICS_KEY: the classifier wait per classifier id,
// and the cheaper activity moves taken in `on` with the escalations that followed one.
export function emptyMetrics() {
  return { version: 1, latency: {}, downMoves: { moves: 0, escalations: 0 } };
}

const isLatency = (v) =>
  isRecord(v) &&
  Object.keys(v).length <= LATENCY_CLASSIFIERS &&
  Object.values(v).every((b) => Array.isArray(b) && b.length === LATENCY_BUCKETS && b.every(isCount));

// Each part read on its own: a bad or outdated one, such as latency after LATENCY_BOUNDS changes, reads as empty and
// leaves the other.
export function readMetrics(value) {
  const empty = emptyMetrics();
  if (!isRecord(value) || value.version !== 1) return empty;
  return {
    version: 1,
    latency: isLatency(value.latency) ? value.latency : empty.latency,
    downMoves: exactCountsOf(value.downMoves, ['moves', 'escalations']) ? value.downMoves : empty.downMoves,
  };
}

// One finished turn: `adviceMs` how long `classifier` took (null: not timed), and `downMove` 'moved' or 'escalated'
// (advanceDown).
export function recordMetrics(metrics, { classifier = null, adviceMs = null, downMove = null }) {
  const next = { version: 1, latency: { ...metrics.latency }, downMoves: { ...metrics.downMoves } };
  const known = Object.hasOwn(next.latency, classifier);
  if (
    typeof classifier === 'string' &&
    Number.isFinite(adviceMs) &&
    adviceMs >= 0 &&
    (known || Object.keys(next.latency).length < LATENCY_CLASSIFIERS)
  ) {
    const buckets = known ? [...next.latency[classifier]] : Array(LATENCY_BUCKETS).fill(0);
    const at = LATENCY_BOUNDS.findIndex((bound) => adviceMs <= bound);
    buckets[at === -1 ? LATENCY_BOUNDS.length : at] += 1;
    next.latency[classifier] = buckets;
  }
  if (downMove === 'moved') next.downMoves.moves += 1;
  if (downMove === 'escalated') next.downMoves.escalations += 1;
  return next;
}

// Escalations after a cheaper activity move. `after` is the `model@effort` route a cheaper move went to while the
// watch lasts, else null; `turn` is the turn's mode, decision reason and lateral outcome, whether a failure asked for
// an escalation (also one the cash gate held or context-fit replaced), whether it was pinned, and its route. A taken
// cheaper move in `on` starts the watch; an escalation while it lasts counts once and ends it, as does a turn on
// another route or a turn in another mode (an `off` turn too, which records nothing else). A pin is the person's choice, not a route change: the watch goes on if the turn after it returns.
// Returns the watch now and the turn's event: 'moved', 'escalated' or null.
export function advanceDown(after, { mode, reason, lateral, escalated, pinned, route }) {
  if (mode !== 'on') return { after: null, event: null };
  if (reason === 'activity-down' && lateral === 'taken') return { after: route, event: 'moved' };
  if (!after || pinned) return { after, event: null };
  if (escalated) return { after: null, event: 'escalated' };
  return { after: route === after ? after : null, event: null };
}

// A run is consecutive turns with the same predicted activity. Given the run so far ({ activity, length } or null)
// and this turn's predicted activity (null or 'uncertain' end it), returns the run now and the run that just ended.
export function advanceRun(run, predicted) {
  const activity = ACTIVITIES.includes(predicted) ? predicted : null;
  if (run && run.activity === activity) return { run: { activity, length: run.length + 1 }, ended: null };
  return { run: activity ? { activity, length: 1 } : null, ended: run };
}

const differs = (a, b) => a.model !== b.model || (a.effort ?? null) !== (b.effort ?? null);
// A decision's lateral outcome: 'taken', 'refused' (not worth it, a hold, the cash gate), or null for none.
const lateralOf = (decision) =>
  decision?.lateral === 'taken' || decision?.lateral === 'refused' ? decision.lateral : null;

// What one routed turn adds to the stats, from its config, the classifier's advice, and the decisions before and
// after it. `label` is the turn's activity: the applied one in `on`, the accepted answer in `shadow`; `answer` is the
// accepted answer in both, which the tools are checked against and runs follow. `switched` names
// what moved the route from the previous turn's: 'activity' for a lateral move, 'tier' for any other, null for none
// or a pin. `lateral` reads the decision that carries an activity, the would-route in `shadow`.
export function turnActivity(config, advice, previous, decision) {
  const mode = config.activityRouting;
  const would = decision.wouldRoute ?? null;
  const switched =
    previous?.model && !decision.pinned && differs(previous, decision)
      ? lateralOf(decision) === 'taken'
        ? 'activity'
        : 'tier'
      : null;
  const answer = mode === 'off' ? null : acceptActivity(config, advice);
  const wouldDiffer = mode === 'shadow' ? Boolean(would && differs(would, decision)) : null;
  return {
    mode,
    answer,
    label: mode === 'on' ? (decision.activity ?? null) : mode === 'shadow' ? answer : null,
    predicted: advice?.activity?.choice ?? null,
    switched,
    lateral: lateralOf(mode === 'shadow' ? would : mode === 'on' ? decision : null),
    // A shadow turn always counts, so the session and store denominators agree.
    wouldDiffer,
    wouldUsd: wouldDiffer ? (would.difference ?? null) : null,
  };
}

// The activities whose agreement plan §11 tracks: the costly mistake is a cheap route on a coding turn.
const FOCUS = ['code', 'ops', 'explore'];

// The counts kept across sessions as the Usage tab and /router show them. Agreement covers the rows that name an
// activity: the store holds the raw answer, and `uncertain` or no answer never agrees; `focus` is the same over the
// FOCUS rows only. The two largest disagreements come first; ties keep the matrix order, so the readout is stable.
export function storeSummary(store) {
  let labelled = 0;
  let matched = 0;
  let total = 0;
  const focus = { matched: 0, total: 0 };
  const misses = [];
  for (const predicted of CONFUSION_ROWS)
    for (const observed of OBSERVED) {
      const n = store.confusion[predicted]?.[observed] ?? 0;
      labelled += n;
      if (!n || !ALLOWED[predicted]) continue;
      total += n;
      const agreed = agrees(predicted, observed);
      if (agreed) matched += n;
      else misses.push({ predicted, observed, n });
      if (FOCUS.includes(predicted)) {
        focus.total += n;
        if (agreed) focus.matched += n;
      }
    }
  return {
    labelled,
    agreement: { matched, total },
    focus,
    disagreements: misses.sort((a, b) => b.n - a.n).slice(0, 2),
    lateral: store.lateral,
    shadow: store.shadow,
  };
}
