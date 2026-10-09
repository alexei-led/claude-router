// Activity statistics: counts only, never text. The session reducer feeds the Usage tab; the store reducer feeds the
// counts kept across sessions under `activity:stats:v1`. Pure: state and a turn in, new state out.

import { acceptActivity } from './activity.mjs';
import { ACTIVITIES, ACTIVITY_VALUES } from './config.mjs';

export const OBSERVED = ['code', 'docs', 'ops', 'read', 'talk'];
export const STORE_KEY = 'activity:stats:v1';

// The observed buckets each predicted activity allows. A weak oracle: it tells ops from code from explore, and cannot
// separate plan from review. That is enough to catch a cheap route on a coding turn.
export const ALLOWED = {
  code: ['code'],
  debug: ['code', 'ops', 'read'],
  explore: ['read', 'talk'],
  plan: ['talk', 'read', 'docs'],
  review: ['read', 'talk'],
  ops: ['ops'],
  docs: ['docs'],
};

// An answer without an allowed set (uncertain, none) never agrees; callers count agreement only for activities.
export function agrees(predicted, observed) {
  return Boolean(ALLOWED[predicted]?.includes(observed));
}

const RUN_BUCKETS = 5;
const CONFUSION_ROWS = [...ACTIVITY_VALUES, 'none'];

const count = (n) => (Number.isFinite(n) && n > 0 ? Math.floor(n) : 0);

export function emptySession() {
  return {
    byActivity: {},
    switches: { tier: 0, activity: 0 },
    agreement: { matched: 0, total: 0 },
    shadow: { differs: 0, turns: 0 },
  };
}

// One finished turn. `activity` is the turn's label (null: none), `answer` the classifier's accepted activity, which
// agreement compares with the tools (null: not counted), `shadow` marks a turn in shadow mode and `wouldDiffer` says
// whether 'on' would have routed it differently (null: no would-route).
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
    shadow: {
      differs: session.shadow.differs + (shadow && wouldDiffer === true ? 1 : 0),
      turns: session.shadow.turns + (shadow ? 1 : 0),
    },
  };
}

export function emptyStore() {
  return { version: 1, confusion: {}, runs: {}, lateral: { taken: 0, refused: 0 }, shadow: { differs: 0, turns: 0 } };
}

const isCount = (n) => Number.isSafeInteger(n) && n >= 0;
const isRecord = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const onlyKeys = (v, keys) => isRecord(v) && Object.keys(v).every((k) => keys.includes(k));
const countsOf = (v, keys) => onlyKeys(v, keys) && Object.values(v).every(isCount);
const exactCountsOf = (v, keys) =>
  isRecord(v) && Object.keys(v).length === keys.length && keys.every((k) => isCount(v[k]));

// The stored value if it has the exact shape, else an empty store: a hand-edited or older file must not break stats.
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
    exactCountsOf(value.shadow, ['differs', 'turns']);
  return ok ? value : emptyStore();
}

// One finished turn. `predicted` is the classifier's answer (null: none), `runEnded` a run that closed this turn,
// `lateral` the outcome of a lateral switch decision and `wouldDiffer` the shadow readout (null: not in shadow).
// Unknown labels are dropped, so the store keeps a fixed set of keys.
export function recordStore(store, { predicted, observed, runEnded, lateral, wouldDiffer }) {
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
  if (typeof wouldDiffer === 'boolean') {
    next.shadow.turns += 1;
    if (wouldDiffer) next.shadow.differs += 1;
  }
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
// accepted answer in both, which the tools are checked against. `switched` names
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
  return {
    mode,
    answer,
    label: mode === 'on' ? (decision.activity ?? null) : mode === 'shadow' ? answer : null,
    predicted: advice?.activity?.choice ?? null,
    switched,
    lateral: LATERAL[(mode === 'shadow' ? would : mode === 'on' ? decision : null)?.reason] ?? null,
    // A shadow turn always counts, so the session and store denominators agree.
    wouldDiffer: mode === 'shadow' ? Boolean(would && differs(would, decision)) : null,
  };
}
