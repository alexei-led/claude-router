// Routing decisions kept per session, so a later look can tell why a turn ran where it did: the prompt's origin, the
// classifier's answer, the tier and activity chosen, the reason, the route, and at the turn's end what its tools did and
// whether its replies were priced. Counts, labels and routes only, never text. Pure: the hook collects a turn's rows and
// writes them at turn.complete to the session's own $.store key under DECISIONS_PREFIX.

import { afterResetOf, isRecord } from './records.mjs';

export const DECISIONS_PREFIX = 'decisions:v1:';
// The newest rows a session keeps, and the sessions kept: $.store holds 4 MiB for every key together, and a row is about
// 300 bytes, so the records stay under 400 KB. Upgrade trigger: a review needs more history than this, or the store nears its limit; then roll rows into
// per-day counts.
export const MAX_ROWS = 60;
export const MAX_RECORDS = 20;
export const RETAIN_MS = 30 * 24 * 60 * 60 * 1000;
export const ROW_KINDS = ['start', 'review', 'observed', 'end'];

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

// One routing decision as a row: `kind` start (the turn's first step), review (a classifier review applied inside the
// turn) or observed (a move on the turn's own tool calls). `advice` is the classifier's answer or null, `error` why
// there is none, `decision` the route chosen (chooseRoute's), `facts` what it was chosen on, `sameTask` sameTaskOf.
export function decisionRow({
  at,
  kind,
  origin = null,
  mode = null,
  advice = null,
  error = null,
  decision,
  facts = {},
  sameTask = null,
}) {
  const activity = advice?.activity ?? null;
  const { downAllowed, contextTokens } = /** @type {{ downAllowed?: boolean, contextTokens?: number }} */ (facts);
  return {
    at,
    kind,
    origin: label(origin),
    mode: label(mode),
    cls: label(advice?.choice),
    p: round(advice?.probabilities?.[advice?.choice]),
    cont: round(advice?.continuation),
    act: label(activity?.choice),
    actP: round(activity?.probabilities?.[activity?.choice]),
    err: label(error),
    tier: label(decision?.tier),
    activity: label(decision?.activity),
    reason: label(decision?.reason),
    route: decision?.model ? label(`${decision.model}@${decision.effort ?? 'session'}`) : null,
    lateral: label(decision?.lateral),
    pinned: Boolean(decision?.pinned),
    same: typeof sameTask === 'boolean' ? sameTask : null,
    down: typeof downAllowed === 'boolean' ? downAllowed : null,
    ctx: Number.isFinite(contextTokens) ? Math.round(contextTokens / 1000) : null,
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

// A turn keeps its first row (the start) and its newest others up to MAX_TURN_ROWS: a long turn reviewed every few
// requests must not push the session's earlier turns out of MAX_ROWS.
export const MAX_TURN_ROWS = 10;
export function addTurnRow(rows, row) {
  const next = [...rows, row];
  return next.length > MAX_TURN_ROWS ? [next[0], ...next.slice(-(MAX_TURN_ROWS - 1))] : next;
}

// What the classifier reads on a progress turn: the active goal as the request, and the report as the newest line of
// the dialogue, so it judges the work still to do rather than the report's wording. Without a goal it reads the turn as
// before. `recentTurns` bounds the dialogue as extractFacts does.
export function progressInput({ prompt, turns }, { goal = null, note = null }, recentTurns) {
  if (!goal || !note) return { prompt, turns };
  return { prompt: goal, turns: [...turns, { role: 'user', text: note }].slice(-recentTurns) };
}

export function emptyDecisions() {
  return { version: 1, since: null, rows: [] };
}

const nullable = (check) => (v) => v === null || Boolean(check(v));
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
  observed: nullable(label),
  requests: Number.isSafeInteger,
  priced: Number.isSafeInteger,
  unpriced: (v) => isRecord(v) && Object.values(v).every((n) => Number.isSafeInteger(n) && n >= 0),
};

// A row with only its known fields of the right type, or null when its time or kind does not read. A row a later
// version wrote keeps what reads.
function readRow(row) {
  if (!isRecord(row) || !ROW_FIELDS.at(row.at) || !ROW_FIELDS.kind(row.kind)) return null;
  const out = {};
  for (const [field, check] of Object.entries(ROW_FIELDS))
    if (Object.hasOwn(row, field) && check(row[field])) out[field] = row[field];
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

function endLine(row) {
  const unpriced = Object.entries(row.unpriced ?? {}).map(([cause, k]) => `${cause} ${k}`);
  return [
    clock(row.at),
    'end     ',
    `tools ${row.observed ?? '?'}`,
    `${row.requests} request${row.requests === 1 ? '' : 's'}`,
    `${row.priced} priced`,
    unpriced.length ? `unpriced ${unpriced.join(', ')}` : null,
  ]
    .filter(Boolean)
    .join('  ');
}

// The newest `n` rows as lines for `/router decisions`, oldest first.
export function decisionLines(rows, n = 20) {
  if (!rows.length) return ['No routing decisions recorded in this session yet.'];
  return rows.slice(-n).map((row) => {
    if (row.kind === 'end') return endLine(row);
    const activity = row.act ? ` ${row.act}${share(row.actP)}` : '';
    const asked = row.cls ? `${row.cls}${share(row.p)}${activity}` : (row.err ?? 'no answer');
    const task = row.same === true ? 'same task' : row.same === false ? 'new task' : null;
    return [
      clock(row.at),
      row.kind.padEnd(8),
      row.origin ?? 'unknown',
      `asked ${asked}`,
      task,
      `-> ${row.tier ?? '-'}${row.activity ? ` ${row.activity}` : ''} ${row.route ?? ''}`.trimEnd(),
      `(${row.reason ?? '?'})`,
      row.pinned ? 'pinned' : null,
    ]
      .filter(Boolean)
      .join('  ');
  });
}
