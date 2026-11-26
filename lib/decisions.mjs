// Routing decisions kept per session, so a later look can tell why a turn ran where it did: the prompt's origin, the
// classifier's answer, the tier and activity chosen, the reason, the route, and at the turn's end what its tools did and
// whether its replies were priced. Counts, labels and routes only, never text. Pure: the hook collects a turn's rows and
// writes them at turn.complete to the session's own $.store key under DECISIONS_PREFIX.

import { ROUTING_ENGINES } from './config.mjs';
import { afterResetOf, isRecord } from './records.mjs';

export const DECISIONS_PREFIX = 'decisions:v1:';
// The newest rows a session keeps, and the sessions kept: $.store holds 4 MiB for every key together. A row is at
// most about 350 bytes, so the records stay under 450 KB; a shadow row's proposal adds about 450 bytes, at most
// 1.2 KB, so records of shadow rows alone take about 950 KB, and 1.9 MB at the bound. Upgrade trigger: a review needs
// more history than this, or the store nears its limit; then roll rows into per-day counts.
export const MAX_ROWS = 60;
export const MAX_RECORDS = 20;
export const RETAIN_MS = 30 * 24 * 60 * 60 * 1000;
export const ROW_KINDS = ['start', 'review', 'observed', 'end', 'failure'];
// The most of an API error's text a failure row keeps, and of the plan's readings.
export const FAILURE_DETAILS_CHARS = 300;
const FAILURE_LIMITS = 4;

// Where a prompt came from, as the engine stamps it (prompt.submit's PromptOrigin.kind). Progress origins report on the
// running work, so their turn is the same task: the classifier judges the active goal with the report as dialogue, and a
// cheaper route still waits for the checkpoint. Goal origins are a person's or another agent's request, which may start
// a new task. Anything else (unclassified, a kind a later engine adds, or none seen) routes as before and leaves the
// goal as it was.
export const PROGRESS_ORIGINS = ['task-notification', 'observer', 'observer-activity', 'auto-continuation'];
export const GOAL_ORIGINS = [
  'composer',
  'bridge',
  'sdk',
  'slack-ping',
  'channel',
  'scheduled-trigger',
  'plugin',
  'peer',
  'peer-send-message',
  'projects-relay',
  'coordinator',
];
const ORIGIN = /^[a-z][a-z-]{0,39}$/;
export const originKind = (origin) =>
  typeof origin?.kind === 'string' && ORIGIN.test(origin.kind) ? origin.kind : 'unknown';
export const isProgressOrigin = (kind) => PROGRESS_ORIGINS.includes(kind);
export const isGoalOrigin = (kind) => GOAL_ORIGINS.includes(kind);

// Submissions waiting for their turn: a prompt typed or delivered while a turn runs starts its own turn later, or never
// (one delivered into the running turn). Each waits at most QUEUE_MS, and at most QUEUE_MAX wait.
export const QUEUE_MS = 10 * 60 * 1000;
export const QUEUE_MAX = 16;
const sameText = (a, b) => typeof a === 'string' && typeof b === 'string' && a.trim() === b.trim();

// The queue with one more submission, the expired and the oldest past the bound dropped.
export function queueOrigin(queue, { kind, text, at }) {
  return [...queue.filter((entry) => at - entry.at < QUEUE_MS), { kind, text, at }].slice(-QUEUE_MAX);
}

// The origin of a turn that starts with `text` at `at`, taken from the queue: the oldest waiting submission with that
// text. Returns { kind, queue }; kind 'unknown' when none matches.
export function takeOrigin(queue, text, at) {
  const live = queue.filter((entry) => at - entry.at < QUEUE_MS);
  const i = live.findIndex((entry) => sameText(entry.text, text));
  if (i === -1) return { kind: 'unknown', queue: live };
  return { kind: live[i].kind, queue: [...live.slice(0, i), ...live.slice(i + 1)] };
}

const round = (n, digits = 2) => (Number.isFinite(n) ? Math.round(n * 10 ** digits) / 10 ** digits : null);
const label = (value) => (typeof value === 'string' && value.length > 0 && value.length <= 80 ? value : null);
const count = (n) => (Number.isSafeInteger(n) && n > 0 ? n : 0);

// Shadow retains a narrow projection, not the engine result or any of the transcript facts.
const ALT_REASONS = [
  'classifier',
  'jump',
  'pin',
  'escalation',
  'hold',
  'no-advice',
  'uncertain',
  'same-demand',
  'upgrade',
  'upgrade-pending',
  'downgrade',
  'downgrade-pending',
  'error',
  'pinned',
];
const ALT_OUTCOMES = ['meets-demand', 'declared-below-demand', 'unknown-only', 'no-route', 'incumbent'];
// decideMove's reasons, with the two a shadow counterfactual adds: `pinned` and `unavailable`.
const ALT_MOVES = [
  'no-route',
  'same-route',
  'reentry',
  'forced',
  'escalation',
  'escalation-unknown',
  'escalation-exhausted',
  'startup',
  'upgrade',
  'upgrade-pending',
  'explicit-up',
  'no-evidence',
  'downgrade',
  'downgrade-pending',
  'downgrade-held',
  'dwell-held',
  'hold',
  'economics-pending',
  'cheaper',
  'pinned',
  'unavailable',
];
// assessCandidates' reasons to exclude a candidate.
const BLOCK_REASONS = [
  'model-missing',
  'effort-unsupported',
  'unavailable',
  'held-out',
  'context-full',
  'context-unknown',
  'images',
  'cash-cap',
];
const MAX_BLOCKED = 3;
// A provider name, cut short, and the hash of its model ids (profileTag).
const PROFILE_TAG = /^[a-z][a-z0-9-]{0,23}\.[0-9a-f]{8}$/;

// Which routing profile made a row, so the rows of one store split by profile: the provider name and an FNV-1a hash of
// the configured model ids. No path and nothing from the home directory goes into it. Limit: two profiles of one
// provider with the same models share a tag.
export function profileTag(config) {
  const models = Object.entries(config.models)
    .map(([alias, model]) => `${alias}=${model.id}`)
    .sort()
    .join('\n');
  let hash = 2166136261;
  for (let i = 0; i < models.length; i++) hash = Math.imul(hash ^ models.charCodeAt(i), 16777619);
  return `${config.provider.slice(0, 24)}.${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

const altLevel = (n) => (Number.isFinite(n) && n >= 0 && n <= 3 && Number.isInteger(n * 2) ? n : null);
const altCost = (n) => (Number.isFinite(n) && n >= 0 ? Number(n.toFixed(6)) : null);
const ALT_ROUTE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}@(low|medium|high|xhigh|max|session)$/;
const AUTO_ROUTE = /^([^\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+)@(low|medium|high|xhigh|max|session)$/u;
function validAutoRoute(value) {
  if (typeof value !== 'string' || value.length > 72) return false;
  const match = AUTO_ROUTE.exec(value);
  return Boolean(match?.[1] && match[1].length <= 64);
}
const isAltRoute = (value) => typeof value === 'string' && ALT_ROUTE.test(value);

function readBlocked(value) {
  if (!Array.isArray(value)) return [];
  return value
    .flatMap((one) => {
      if (!isRecord(one) || !isAltRoute(one.route) || !Array.isArray(one.reasons)) return [];
      const { reasons } = one;
      const known = BLOCK_REASONS.filter((reason) => reasons.includes(reason));
      return known.length ? [{ route: one.route, reasons: known }] : [];
    })
    .slice(0, MAX_BLOCKED);
}

// The fields only a shadow proposal has, each left out unless it reads.
function readCounterfactual(alt) {
  const blocked = readBlocked(alt.blocked);
  const incumbentCap = altLevel(alt.incumbentCap);
  return {
    ...(isAltRoute(alt.serve) ? { serve: alt.serve } : {}),
    ...(ALT_MOVES.includes(alt.move) ? { move: alt.move } : {}),
    ...(incumbentCap === null ? {} : { incumbentCap }),
    ...(blocked.length ? { blocked } : {}),
    ...(typeof alt.profile === 'string' && PROFILE_TAG.test(alt.profile) ? { profile: alt.profile } : {}),
  };
}

function readAlt(alt, auto = false) {
  if (!isRecord(alt)) return null;
  return {
    demand: altLevel(alt.demand),
    reason: ALT_REASONS.includes(alt.reason) ? alt.reason : null,
    headroom: alt.headroom === true,
    targetReason: ['escalation', 'escalation-unknown', 'escalation-exhausted'].includes(alt.targetReason)
      ? alt.targetReason
      : null,
    requirement: altLevel(alt.requirement),
    outcome: ALT_OUTCOMES.includes(alt.outcome) ? alt.outcome : null,
    route: (auto ? validAutoRoute(alt.route) : isAltRoute(alt.route)) ? alt.route : null,
    capability: altLevel(alt.capability),
    minUsd: altCost(alt.minUsd),
    maxUsd: altCost(alt.maxUsd),
    ...(auto ? {} : readCounterfactual(alt)),
  };
}

// The reasons whose estimate holds a mass the policy compared with its threshold. Any other reason can carry an
// estimate that is not its own: a context or availability override keeps the one of the decision it replaced, and a
// jump compared its mass with jumpConfidence, not the threshold.
const WEIGHED = [
  'upgrade',
  'upgrade-pending',
  'downgrade',
  'downgrade-pending',
  'downgrade-held',
  'activity-up',
  'activity-pending',
];

// The mass the policy compared and the bar it had to clear, from the decision's estimate (decide, lateralMove): mass
// above the incumbent for a move up, at or below the classifier's choice for a pending move down (the target for a
// taken or held one), the label's share for an activity move up, 1 when that move needs no label. Both or neither: a
// decision that weighed no mass (a hold, a cash gate, a cheaper route judged on its cache write) adds no field, so its
// row stays as small as before. Nor does an observed move: its mass is 1 by rule, the tools being the evidence.
function compared(kind, decision) {
  if (kind === 'observed' || !WEIGHED.includes(decision?.reason)) return {};
  const { upgradeMass, downgradeMass, threshold } = decision.estimate ?? {};
  const mass = round(upgradeMass ?? downgradeMass);
  const bar = round(threshold);
  return mass === null || bar === null ? {} : { mass, bar };
}

/** @typedef {{ choice: string, probabilities?: Record<string, number> }} AdviceChoice */

// One routing decision as a row: `kind` start (the turn's first step), review (a classifier review applied inside the
// turn) or observed (a move on the turn's own tool calls). `advice` is the classifier's answer or null, `error` why
// there is none, `decision` the route chosen (chooseRoute's), `facts` what it was chosen on, `sameTask` sameTaskOf.
export function decisionRow({
  at,
  kind,
  origin = null,
  mode = null,
  advice = /** @type {(AdviceChoice & { continuation?: number, activity?: AdviceChoice | null, phase?: AdviceChoice }) | null} */ (
    null
  ),
  error = null,
  decision,
  facts = {},
  sameTask = /** @type {boolean | null} */ (null),
  engine = /** @type {string | null} */ (null),
  alt = /** @type {object | null} */ (null),
}) {
  const activity = advice?.activity ?? null;
  const { downAllowed, contextTokens } = /** @type {{ downAllowed?: boolean, contextTokens?: number }} */ (facts);
  return {
    at,
    kind,
    origin: label(origin),
    mode: label(mode),
    cls: label(advice?.choice),
    p: round(advice?.probabilities?.[advice.choice]),
    cont: round(advice?.continuation),
    act: label(activity?.choice),
    actP: round(activity?.probabilities?.[activity.choice]),
    ...(advice?.phase
      ? { phase: label(advice.phase.choice), phaseP: round(advice.phase.probabilities?.[advice.phase.choice]) }
      : {}),
    err: label(error),
    tier: label(decision?.tier),
    activity: label(decision?.activity),
    reason: label(decision?.reason),
    route: decision?.model ? label(`${decision.model}@${decision.effort ?? 'session'}`) : null,
    lateral: label(decision?.lateral),
    pinned: Boolean(decision?.pinned),
    same: typeof sameTask === 'boolean' ? sameTask : null,
    down: typeof downAllowed === 'boolean' ? downAllowed : null,
    ctx: typeof contextTokens === 'number' && Number.isFinite(contextTokens) ? Math.round(contextTokens / 1000) : null,
    ...compared(kind, decision),
    ...(engine !== null && engine !== 'table' && ROUTING_ENGINES.includes(engine) ? { engine } : {}),
    ...(engine === 'shadow' && readAlt(alt) ? { alt: readAlt(alt) } : {}),
    ...(engine === 'auto' && readAlt(decision?.auto, true)
      ? { auto: { ...readAlt(decision.auto, true), move: label(decision.auto.move) } }
      : {}),
  };
}

// The turn's end: the bucket its tools fall in (observedActivity), its routed requests, how many were priced, and the
// unpriced ones by cause (UNPRICED_CAUSES in activity-stats.mjs).
export function endRow({ at, observed = null, requests = 0, priced = 0, unpriced = {} }) {
  const causes = Object.fromEntries(
    Object.entries(unpriced ?? {}).filter(([cause, n]) => label(cause) && Number.isSafeInteger(n) && n > 0),
  );
  return {
    at,
    kind: 'end',
    observed: label(observed),
    requests: count(requests),
    priced: count(priced),
    unpriced: causes,
  };
}

// An API error that ended a main turn, kept to learn what Claude Code reports (docs/plans/2026-11-19-fallback-chains.md):
// `err` the error word, `details` the first characters of its text when the build gives one, `limits` the plan windows
// at that moment (`pct`, `resets` in ms), `fail` the kind the failure classified as (null: nothing held), `scope` and
// `held` what it held: a model id or an account. Local record only; /router decisions shows no text.
export function failureRow({
  at,
  error = null,
  details = /** @type {string | null | undefined} */ (null),
  limits = /** @type {{ kind: string, percent: number, resetsAt: number | null }[]} */ ([]),
  failure = /** @type {string | null} */ (null),
  scope = /** @type {string | null} */ (null),
  held = /** @type {string | null} */ (null),
}) {
  return {
    at,
    kind: 'failure',
    err: label(error),
    details: typeof details === 'string' && details ? details.slice(0, FAILURE_DETAILS_CHARS) : null,
    limits: limits.slice(0, FAILURE_LIMITS).map((limit) => ({
      kind: label(limit.kind),
      pct: round(limit.percent, 1),
      resets: Number.isFinite(limit.resetsAt) ? limit.resetsAt : null,
    })),
    fail: label(failure),
    scope: label(scope),
    held: label(held),
  };
}

// A turn keeps at most MAX_TURN_ROWS rows: a long turn reviewed every few requests must not push the session's earlier
// turns out of MAX_ROWS. A review that changed nothing (the same tier, route, reason, activity, error, shadow route and
// would-serve route as the review before it) joins that row: `n` counts them, `at` stays the first and `last` is the
// newest, and `mass` is the best support any of them gave. Past the bound the oldest review that left the route as it
// was goes first, so the start and every row that moved the route stay; with none, the oldest row after the start.
export const MAX_TURN_ROWS = 10;
const sameCheck = (a, b) =>
  a.kind === 'review' &&
  b.kind === 'review' &&
  ['tier', 'route', 'reason', 'activity', 'err', 'pinned'].every(
    (field) => (a[field] ?? null) === (b[field] ?? null),
  ) &&
  (a.alt?.route ?? null) === (b.alt?.route ?? null) &&
  (a.alt?.serve ?? null) === (b.alt?.serve ?? null);
export function addTurnRow(rows, row) {
  const previous = rows.at(-1);
  if (previous && sameCheck(previous, row)) {
    const best = Math.max(previous.mass ?? Number.NEGATIVE_INFINITY, row.mass ?? Number.NEGATIVE_INFINITY);
    return [
      ...rows.slice(0, -1),
      {
        ...row,
        at: previous.at,
        last: row.at,
        n: (previous.n ?? 1) + 1,
        ...(Number.isFinite(best) ? { mass: best } : {}),
      },
    ];
  }
  const next = [...rows, row];
  if (next.length <= MAX_TURN_ROWS) return next;
  const still = next.findIndex((one, i) => i > 0 && one.kind === 'review' && one.route === next[i - 1].route);
  return still > 0
    ? [...next.slice(0, still), ...next.slice(still + 1)]
    : [next[0], ...next.slice(-(MAX_TURN_ROWS - 1))];
}

// What the classifier reads on a progress turn: the active goal as the request, and the report as the newest line of
// the dialogue, so it judges the work still to do rather than the report's wording. Without a goal it reads the turn as
// before. `recentTurns` bounds the dialogue as extractFacts does.
export function progressInput({ prompt, turns }, { goal = null, note = null }, recentTurns) {
  if (!goal || !note) return { prompt, turns };
  return { prompt: goal, turns: [...turns, { role: 'user', text: note }].slice(-recentTurns) };
}

// Keep an anchor only on positive continuation evidence. Ambiguity drops it rather than inventing a stale goal.
export function continuedGoal(previous, candidate, continuation, threshold) {
  if (previous && Number.isFinite(continuation) && continuation > 0.5 && continuation >= threshold) return previous;
  if (Number.isFinite(continuation) && continuation < threshold && continuation < 0.5 && continuation <= 1 - threshold)
    return candidate;
  return null;
}

export function emptyDecisions() {
  return { version: 1, since: null, rows: [] };
}

const nullable = (check) => (v) => v === null || Boolean(check(v));
const isLimitReading = (v) =>
  isRecord(v) && nullable(label)(v.kind) && nullable(Number.isFinite)(v.pct) && nullable(Number.isFinite)(v.resets);
const ROW_FIELDS = {
  at: Number.isFinite,
  kind: (v) => ROW_KINDS.includes(v),
  origin: nullable(label),
  mode: nullable(label),
  cls: nullable(label),
  p: nullable(Number.isFinite),
  cont: nullable(Number.isFinite),
  act: nullable(label),
  actP: nullable(Number.isFinite),
  phase: nullable(label),
  phaseP: nullable(Number.isFinite),
  err: nullable(label),
  tier: nullable(label),
  activity: nullable(label),
  reason: nullable(label),
  route: nullable(label),
  lateral: nullable(label),
  pinned: (v) => typeof v === 'boolean',
  same: nullable((v) => typeof v === 'boolean'),
  down: nullable((v) => typeof v === 'boolean'),
  ctx: nullable(Number.isFinite),
  mass: Number.isFinite,
  bar: Number.isFinite,
  n: (v) => Number.isSafeInteger(v) && v > 1,
  last: Number.isFinite,
  engine: (v) => ROUTING_ENGINES.includes(v),
  observed: nullable(label),
  requests: Number.isSafeInteger,
  priced: Number.isSafeInteger,
  unpriced: (v) => isRecord(v) && Object.values(v).every((n) => Number.isSafeInteger(n) && n >= 0),
  details: nullable((v) => typeof v === 'string' && v.length <= FAILURE_DETAILS_CHARS),
  limits: (v) => Array.isArray(v) && v.length <= FAILURE_LIMITS && v.every(isLimitReading),
  fail: nullable(label),
  scope: nullable(label),
  held: nullable(label),
};

// A row with only its known fields of the right type, or null when its time or kind does not read. A row a later
// version wrote keeps what reads.
function readRow(row) {
  if (!isRecord(row) || !ROW_FIELDS.at(row.at) || !ROW_FIELDS.kind(row.kind)) return null;
  const out = {};
  for (const [field, check] of Object.entries(ROW_FIELDS))
    if (Object.hasOwn(row, field) && check(row[field])) out[field] = row[field];
  if (out.engine === 'shadow' && readAlt(row.alt)) out.alt = readAlt(row.alt);
  if (out.engine === 'auto' && readAlt(row.auto, true))
    out.auto = { ...readAlt(row.auto, true), move: label(row.auto.move) };
  return out;
}

// The stored value with the rows that read, else an empty record: a hand edit never breaks a turn.
export function readDecisions(value) {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.rows)) return emptyDecisions();
  if (!(value.since === null || Number.isFinite(value.since))) return emptyDecisions();
  return { version: 1, since: value.since, rows: value.rows.map(readRow).filter(Boolean).slice(-MAX_ROWS) };
}

// A record whose first row came before the last reset at `resetAt` (ms) reads as empty.
export const decisionsAfterReset = (record, resetAt) => afterResetOf(record, resetAt, emptyDecisions);

// The record with a finished turn's rows added at `now`, the oldest dropped past MAX_ROWS. No rows: the record itself.
export function appendDecisions(record, rows, now) {
  if (!rows.length) return record;
  return { version: 1, since: record.since ?? now, rows: [...record.rows, ...rows].slice(-MAX_ROWS) };
}

// Which of the stored `[key, value]` records the store can let go at `now`: those whose newest row is older than
// RETAIN_MS, then past `max` records the ones whose newest row is oldest. A value that does not read as version 1 keeps
// its key: a later version may have written it.
export function prunedDecisions(entries, now, max = MAX_RECORDS) {
  const dated = entries
    .filter(([, value]) => isRecord(value) && value.version === 1)
    .map(([key, value]) => {
      const record = readDecisions(value);
      return [key, record.rows.at(-1)?.at ?? record.since ?? 0];
    });
  const gone = new Set(dated.filter(([, last]) => now - last > RETAIN_MS).map(([key]) => key));
  const kept = dated.filter(([key]) => !gone.has(key)).sort((a, b) => b[1] - a[1]);
  for (const [key] of kept.slice(max)) gone.add(key);
  return gone;
}

const pad2 = (n) => String(n).padStart(2, '0');
const clock = (ms) => {
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
};
const share = (p) => (Number.isFinite(p) ? ` ${Math.round(p * 100)}%` : '');
// No comparison sign: the stored values are rounded, and a move can clear its bar and still wait for a second vote.
const weighed = (row) =>
  Number.isFinite(row.mass) && Number.isFinite(row.bar) ? `${share(row.mass)} vs bar${share(row.bar)}` : '';

export function shadowLine(row) {
  const alt = readAlt(row.alt);
  if (row.engine !== 'shadow' || !alt) return null;
  const cost =
    alt.minUsd === null || alt.maxUsd === null ? 'unknown' : `$${alt.minUsd.toFixed(4)}–$${alt.maxUsd.toFixed(4)}`;
  const served = alt.move ? `; auto would serve ${alt.serve ?? 'none'} (${alt.move})` : '';
  return `shadow demand ${alt.demand ?? '?'} (${alt.reason ?? '?'}${alt.headroom ? ', headroom' : ''}) → target ${alt.route ?? 'none'} cap ${alt.capability ?? 'unknown'}; ${alt.outcome ?? '?'}${alt.targetReason ? ` (${alt.targetReason})` : ''}; required ${alt.requirement ?? '?'}; next-turn estimate ${cost}${served} (proposal only)`;
}

function endLine(row) {
  const unpriced = Object.entries(row.unpriced ?? {})
    .filter(([cause]) => cause !== 'comparison')
    .map(([cause, k]) => `${cause} ${k}`);
  return [
    clock(row.at),
    'end     ',
    `tools ${row.observed ?? '?'}`,
    `${row.requests} request${row.requests === 1 ? '' : 's'}`,
    `${row.priced} priced`,
    unpriced.length ? `unpriced ${unpriced.join(', ')}` : null,
    row.unpriced?.comparison ? `comparison unavailable ${row.unpriced.comparison}` : null,
  ]
    .filter(Boolean)
    .join('  ');
}

function failureLine(row) {
  const held = row.fail ? [row.fail, 'held', row.scope, row.held] : ['held nothing'];
  return [clock(row.at), 'failure ', row.err ?? 'unknown error', held.filter(Boolean).join(' ')].join('  ');
}

// The newest `n` rows as lines for `/router decisions`, oldest first.
export function decisionLines(rows, n = 20) {
  if (!rows.length) return ['No routing decisions recorded in this session yet.'];
  return rows.slice(-n).map((row) => {
    if (row.kind === 'end') return endLine(row);
    if (row.kind === 'failure') return failureLine(row);
    const activity = row.act ? ` ${row.phase ? 'goal ' : ''}${row.act}${share(row.actP)}` : '';
    const phase = row.phase ? `phase ${row.phase}${share(row.phaseP)}` : null;
    const asked = row.cls ? `${row.cls}${share(row.p)}${activity}` : (row.err ?? 'no answer');
    const task = row.same === true ? 'same task' : row.same === false ? 'new task' : null;
    return [
      clock(row.at),
      row.kind.padEnd(8),
      row.origin ?? 'unknown',
      `asked ${asked}`,
      phase,
      task,
      `-> ${row.tier ?? '-'}${row.activity ? ` ${row.activity}` : ''} ${row.route ?? ''}`.trimEnd(),
      `(${row.reason ?? '?'}${weighed(row)})`,
      row.n > 1 ? `${row.n} checks until ${clock(row.last)}` : null,
      row.pinned ? 'pinned' : null,
      shadowLine(row),
      row.engine === 'auto' && row.auto
        ? `demand ${row.auto.demand ?? '?'} → target ${row.auto.route ?? 'none'} cap ${row.auto.capability ?? 'unknown'}; ${row.auto.outcome}; move ${row.auto.move}; next-turn estimate ${row.auto.minUsd === null || row.auto.maxUsd === null ? 'unknown' : `$${row.auto.minUsd.toFixed(4)}–$${row.auto.maxUsd.toFixed(4)}`}`
        : null,
    ]
      .filter(Boolean)
      .join('  ');
  });
}
