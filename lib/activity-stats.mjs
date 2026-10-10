// Activity statistics: counts only, never text. The session reducer feeds the Usage tab; the store reducer feeds the
// counts kept across sessions under `activity:stats:v1`. Pure: state and a turn in, new state out.

import { acceptActivity } from './activity.mjs';
import { ACTIVITIES, ACTIVITY_VALUES } from './config.mjs';

export const OBSERVED = ['code', 'docs', 'ops', 'read', 'talk'];
export const STORE_KEY = 'activity:stats:v1';

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

export function emptySession() {
  return {
    byActivity: {},
    switches: { tier: 0, activity: 0 },
    agreement: { matched: 0, total: 0 },
    shadow: emptyShadow(),
  };
}

// One finished turn. `activity` is the turn's label (null: none), `answer` the classifier's accepted activity, which
// agreement compares with the tools (null: not counted), `shadow` marks a turn in shadow mode, `wouldDiffer` says
// whether 'on' would have routed it differently (null: no would-route) and `wouldUsd` prices that difference.
export function recordTurn(
  session,
  {
    activity,
    answer,
    observed,
    requests,
    inputTokens,
    outputTokens,
    tierSwitches,
    activitySwitches,
    wouldDiffer,
    wouldUsd,
    shadow,
  },
) {
  const key = activity ?? 'none';
  const before = session.byActivity[key] ?? { turns: 0, requests: 0, inputTokens: 0, outputTokens: 0 };
  return {
    byActivity: {
      ...session.byActivity,
      [key]: {
        turns: before.turns + 1,
        requests: before.requests + count(requests),
        inputTokens: before.inputTokens + count(inputTokens),
        outputTokens: before.outputTokens + count(outputTokens),
      },
    },
    switches: {
      tier: session.switches.tier + count(tierSwitches),
      activity: session.switches.activity + count(activitySwitches),
    },
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

export function emptyStore() {
  return { version: 1, confusion: {}, runs: {}, lateral: { taken: 0, refused: 0 }, shadow: emptyShadow() };
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
// unknown file must not break stats.
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

// A run is consecutive turns with the same predicted activity. Given the run so far ({ activity, length } or null)
// and this turn's predicted activity (null or 'uncertain' end it), returns the run now and the run that just ended.
export function advanceRun(run, predicted) {
  const activity = ACTIVITIES.includes(predicted) ? predicted : null;
  if (run && run.activity === activity) return { run: { activity, length: run.length + 1 }, ended: null };
  return { run: activity ? { activity, length: 1 } : null, ended: run };
}

const LATERAL = { 'activity-up': 'taken', 'activity-down': 'taken', 'activity-pending': 'refused' };
const differs = (a, b) => a.model !== b.model || (a.effort ?? null) !== (b.effort ?? null);

// What one routed turn adds to the stats, from its config, the classifier's advice, and the decisions before and
// after it. `label` is the turn's activity: the applied one in `on`, the accepted answer in `shadow`; `answer` is the
// accepted answer in both, which the tools are checked against and runs follow. `switched` names
// what moved the route from the previous turn's: 'activity' for a lateral move, 'tier' for any other, null for none
// or a pin. `lateral` reads the decision that carries an activity, the would-route in `shadow`; a lateral move refused
// by a hold or the cash gate shares its reason with tier decisions and is not counted.
export function turnActivity(config, advice, previous, decision) {
  const mode = config.activityRouting;
  const would = decision.wouldRoute ?? null;
  const switched =
    previous?.model && !decision.pinned && differs(previous, decision)
      ? LATERAL[decision.reason] === 'taken'
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
    lateral: LATERAL[(mode === 'shadow' ? would : mode === 'on' ? decision : null)?.reason] ?? null,
    // A shadow turn always counts, so the session and store denominators agree.
    wouldDiffer,
    wouldUsd: wouldDiffer ? (would.difference ?? null) : null,
  };
}

// The activities plan §11 checks agreement on before activity routing turns on by default.
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
