// The Classifier tab's model: one row per configured classifier, then the active one's settings and readings, and its
// accuracy across sessions.

import { latencyP95, readMetrics, readStore, storeSummary } from '../../activity-stats.mjs';
import { classifierDestination } from '../../classifier-contract.mjs';
import { activeClassifier } from '../../config.mjs';
import { classifierStatus, missingCredentials, missingText, percent, probeOf, unpricedLine } from '../../display.mjs';
import { plural, sentence, sinceText } from './format.mjs';
import { choiceOf } from './policy.mjs';

const pausedText = (health, now) => `paused until ${sinceText(health.pausedUntil, now)}`;

// The verdict's bounds on the figures across sessions. `good` is the activity-routing plan §11 target (tools agree on at
// least 80% of turns, at most 1 escalation in 10 cheaper activity moves), `fair` the bound short of danger. Below
// MIN_COUNTED a share says too little to judge.
const FIT = { good: 0.8, fair: 0.6 };
const BACK_UP = { good: 0.1, fair: 0.25 };
const MIN_COUNTED = 10;

/**
 * @typedef {object} ClassifierRow one classifier: the terminal row's columns, and a card's status, readings and Button
 * @property {string} key
 * @property {string} label
 * @property {boolean} active
 * @property {() => void} press
 * @property {{ label: string } | null} use a card's header Button, on every card but the active one's
 * @property {{ text: string, local: boolean }} where where the prompt goes
 * @property {string | null} probe
 * @property {string | null} p95
 * @property {{ tone: import('../tokens.mjs').Tone, text: string }} state the terminal's mark and word
 * @property {{ key: string, label: string, press: (press: any) => void } | null} setup
 * @property {string} narrowDetail the terminal's second line in a narrow pane
 * @property {{ tone: import('../tokens.mjs').Tone, text: string }} status a card's
 * @property {{ status: { tone: import('../tokens.mjs').Tone, text: string }, detail: string }} compact
 * @property {{ label: string, value: string, tone: import('../tokens.mjs').Tone }[]} readings
 * @property {{ key: string, label: string, hotkey?: string, press: (press: any) => void, note?: string } | null} credentials
 *
 * @typedef {object} VerdictBar one share kept across sessions, judged
 * @property {string} label
 * @property {number} value the share, 0 to 1
 * @property {import('../tokens.mjs').Tone} tone the verdict's colour; muted with too few counted to judge
 * @property {string} percent
 * @property {string} note what was counted
 *
 * @typedef {object} ClassifierModel The Classifier tab: a row per classifier and the active one in full.
 * @property {ClassifierRow[]} rows
 * @property {ClassifierRow | undefined} current the active classifier's card
 * @property {{ title: string, rows: ClassifierRow[] } | null} others
 * @property {import('./format.mjs').Words} probeNote
 * @property {{ label: string, mark: { glyph: string, tone: import('../tokens.mjs').Tone, text: string }, deadline: { label: string, control: import('./routes.mjs').Choice & { key: string, text: string }, help: import('./format.mjs').Words }, wait: { text: string, slow: boolean }, sends: { label: string, text: import('./format.mjs').Words, help: import('./format.mjs').Words }, health: { label: string, paused: string | null, steady: string, failures: string, last: string | null, value: string, tone: import('../tokens.mjs').Tone }, credentials: { label: string, button: { key: string, label: string, hotkey: string, press: (press: any) => void }, note: string }, session: { head: string, text: string } | null, readings: { label: string, value: string, tone: import('../tokens.mjs').Tone, help?: string }[] }} active
 * @property {{ head: string, title: string, hint: string, bars: VerdictBar[], misses: { label: string, value: string } | null, unpriced: string | null } | null} store
 */
/**
 * @param {import('./frame.mjs').PaneContext} ctx
 * @returns {ClassifierModel}
 */
export function classifierOf({ config, view, actions, now }) {
  const active = activeClassifier(config);
  const health = view.health ?? { failures: 0, pausedUntil: 0 };
  const paused = health.pausedUntil > now;
  const rows = Object.entries(config.classifiers).map(([id, entry]) =>
    classifierRowOf(config, view, actions, id, entry, paused ? health : null, now),
  );
  const wait = waitOf(config, view, active);
  const { matched = 0, total = 0 } = view.activityStats?.agreement ?? {};
  const summary = storeSummary(readStore(view.activityStore));
  const store =
    summary.labelled > 0 ? storeUsageOf(summary, view.activityMetrics, view.activityStats?.agreement) : null;
  const healthParts = {
    paused: paused ? pausedText(health, now) : null,
    steady: 'not paused',
    failures: plural(health.failures, 'recent failure'),
    last: Number.isFinite(view.adviceMs) ? `last ${view.adviceMs} ms` : null,
  };
  return {
    rows,
    // A card's layout: the active classifier's full card, then the others as compact rows in one card.
    current: rows.find((row) => row.active),
    others: rows.some((row) => !row.active)
      ? { title: 'Other classifiers', rows: rows.filter((row) => !row.active) }
      : null,
    probeNote: {
      terminal: 'probe: historical turn-activity questions, not goal/phase accuracy; p95 from that run',
      graphical: 'Probe: historical turn-activity questions, not goal/phase accuracy; p95 from that run',
    },
    active: {
      label: active.label,
      mark: { glyph: '●', tone: /** @type {const} */ ('accent'), text: 'Active' },
      deadline: {
        label: 'Deadline',
        control: choiceOf('timeoutMs', active.timeoutMs, (v) => `${v} ms`, actions.classifierTimeout),
        help: {
          terminal: 'past the deadline the turn keeps its model',
          graphical: 'Past the deadline the turn keeps its model',
        },
      },
      wait: { text: wait.slow ? `${wait.text}: slower than the deadline` : wait.text, slow: wait.slow },
      sends: {
        label: 'Sends',
        text: {
          terminal: `prompt + ${config.context.recentTurns} recent turns → ${classifierDestination(active.endpoint).text}`,
          graphical: `Prompt + ${config.context.recentTurns} recent turns → ${classifierDestination(active.endpoint).text}`,
        },
        help: {
          terminal: 'the bounded active goal and current step also go to the classifier',
          graphical: 'The bounded active goal and current step also go to the classifier',
        },
      },
      health: {
        label: 'Health',
        ...healthParts,
        // A card's one line.
        value: sentence(
          [healthParts.paused ?? healthParts.steady, healthParts.failures, healthParts.last]
            .filter(Boolean)
            .join(' · '),
        ),
        tone: /** @type {import('../tokens.mjs').Tone} */ (paused ? 'warning' : 'primary'),
      },
      credentials: {
        label: 'Credentials',
        button: { key: 'key', label: 'Edit', hotkey: 'k', press: (press) => actions.key(press, config.classifier) },
        note: 'opens /plugin configure',
      },
      // How often this session's tools fit the classifier's accepted activity; none before a labelled turn, nor beside
      // the figures across sessions, whose fit note carries it.
      session:
        total && !store
          ? { head: 'THIS SESSION', text: `Tool compatibility (not accuracy): ${agreement(matched, total)}` }
          : null,
      // A card's readings: the wait against the deadline, and this session's agreement where `session` shows it.
      readings: [
        {
          label: 'Wait',
          value: wait.measured
            ? wait.slow
              ? `${wait.text} · slower than the deadline`
              : wait.text
            : 'None measured yet',
          tone: /** @type {import('../tokens.mjs').Tone} */ (wait.slow ? 'warning' : 'primary'),
        },
        total && !store
          ? {
              label: 'Tool agreement',
              value: `${agreement(matched, total)} this session`,
              tone: /** @type {import('../tokens.mjs').Tone} */ ('primary'),
              help: 'Compatibility with the tools a turn used, not accuracy',
            }
          : null,
      ].filter((one) => one !== null),
    },
    store,
  };
}

// One classifier: the terminal row's columns, and a card's status, readings and credentials Button. `paused` is the
// health while the classifier is paused, else null.
function classifierRowOf(config, view, actions, id, entry, paused, now) {
  const isActive = id === config.classifier;
  const missing = missingCredentials(config, view, id);
  const probe = probeOf(config, id);
  const where = classifierDestination(entry.endpoint);
  const { local, text: destination } = where;
  // The active classifier's last error, when it is not one of the missing credentials the row already names. While
  // routing is unavailable the error is the router's reason, which the notices show.
  const failed =
    isActive && view.phase !== 'unavailable' && view.error && !['missing-key', 'missing-account'].includes(view.error)
      ? view.error
      : null;
  /** @type {{ tone: import('../tokens.mjs').Tone, text: string }} */
  const status = missing
    ? { tone: 'warning', text: sentence(missingText(config, id, missing)) }
    : isActive && paused
      ? { tone: 'warning', text: sentence(pausedText(paused, now)) }
      : failed
        ? { tone: 'warning', text: `Last error: ${classifierStatus(config, failed)}` }
        : { tone: 'success', text: 'Ready' };
  return {
    key: `classifier-${id}`,
    label: entry.label,
    active: isActive,
    press: () => actions.classifier(id),
    // A card's header: Use on every card but the active one's.
    use: isActive ? null : { label: 'Use' },
    // The terminal's columns.
    where,
    probe: probe ? `${probe.correct}/${probe.probes}` : null,
    p95: probe ? `${probe.p95Ms} ms` : null,
    state: missing
      ? { tone: /** @type {const} */ ('warning'), text: `○ ${missingText(config, id, missing)}` }
      : { tone: /** @type {const} */ ('success'), text: '● ready' },
    setup: missing ? { key: `key-${id}`, label: 'Set up', press: (press) => actions.key(press, id) } : null,
    // The terminal's second line in a narrow pane: where the prompt goes, and the probe result.
    narrowDetail: [destination, probe ? `${probe.correct}/${probe.probes} · p95 ${probe.p95Ms} ms` : null]
      .filter(Boolean)
      .join(' · '),
    // A card's.
    status,
    // A compact row's: its status, and where the prompt goes with its probe result.
    compact: {
      status,
      detail: [
        local ? 'This machine' : destination,
        probe ? `${probe.correct} of ${probe.probes} right · p95 ${probe.p95Ms} ms` : null,
      ]
        .filter(Boolean)
        .join(' · '),
    },
    readings: [
      {
        label: 'Prompt goes to',
        value: local ? 'This machine' : destination,
        tone: /** @type {import('../tokens.mjs').Tone} */ (local ? 'success' : 'primary'),
      },
      probe
        ? {
            label: 'Activity probe',
            value: `${probe.correct} of ${probe.probes} right · p95 ${probe.p95Ms} ms`,
            tone: /** @type {import('../tokens.mjs').Tone} */ ('primary'),
          }
        : null,
    ].filter((one) => one !== null),
    // One credentials Button per card: Set up where something is missing, else the active one's Edit.
    // The active one's answers k either way, as the terminal's Edit does.
    credentials: missing
      ? {
          key: `key-${id}`,
          label: 'Set up',
          ...(isActive ? { hotkey: 'k' } : {}),
          press: (press) => actions.key(press, id),
        }
      : isActive
        ? {
            key: 'key',
            label: 'Edit credentials',
            hotkey: 'k',
            press: (press) => actions.key(press, id),
            note: 'Shows how to add them',
          }
        : null,
  };
}

// The active classifier's wait: live p95 over this session's turns, else its probe's; slow past the deadline.
function waitOf(config, view, active) {
  const { latency } = readMetrics(view.activityMetrics);
  const live = latencyP95(Object.hasOwn(latency, config.classifier) ? latency[config.classifier] : null);
  const probe = probeOf(config, config.classifier);
  const p95 = live ? live.ms : probe?.p95Ms;
  const text = live
    ? `p95 ${live.over ? '>' : '≤'} ${live.ms} ms over ${plural(live.turns, 'turn')}`
    : probe
      ? `p95 ${probe.p95Ms} ms in its probe`
      : 'no wait measured yet';
  return {
    text,
    measured: Boolean(live || probe),
    slow: Number.isFinite(p95) && Boolean(p95 > active.timeoutMs || live?.over),
  };
}

// "19 of 22 turns (86%)".
const agreement = (matched, total) => `${matched} of ${total} turns (${percent(matched / total)})`;

// A share kept across sessions with its verdict: success within `good`, warning within `fair`, else danger. A share
// is better the higher it is, unless `lower`.
function verdictBar(label, counted, total, note, { good, fair }, lower = false) {
  const value = counted / total;
  const within = (bound) => (lower ? value <= bound : value >= bound);
  const judged = total >= MIN_COUNTED;
  /** @type {import('../tokens.mjs').Tone} */
  const tone = !judged ? 'muted' : within(good) ? 'success' : within(fair) ? 'warning' : 'danger';
  return { label, value, tone, percent: percent(value), note: judged ? note : `${note} · too few to judge` };
}

// The counts kept across sessions, read from the stores as last loaded: how often the tools a turn used fit the
// classifier's activity, how often a cheaper activity move had to go back up, and the commonest misses. The fit uses
// the classifier's raw answer, so it can differ from this session's, which its note adds.
function storeUsageOf(summary, metrics, session) {
  const { downMoves } = readMetrics(metrics);
  const bars = [];
  const { matched, total } = summary.agreement;
  if (total > 0) {
    const now = session?.total ? ` · this session ${percent(session.matched / session.total)}` : '';
    bars.push(verdictBar('Label fits tools', matched, total, `${matched} of ${total}${now}`, FIT));
  }
  const { moves, escalations } = downMoves;
  if (moves > 0) {
    const note = `${escalations} of ${plural(moves, 'cheaper move')}`;
    bars.push(verdictBar('Cheaper → back up', escalations, moves, note, BACK_UP, true));
  }
  const misses = summary.disagreements.map((d) => `${d.predicted} → ${d.observed} ×${d.n}`).join(' · ');
  return {
    head: 'ACROSS SESSIONS',
    title: 'Across sessions',
    hint: `${plural(summary.labelled, 'turn')} since the last reset`,
    bars,
    misses: misses ? { label: 'Misses', value: misses } : null,
    unpriced: unpricedLine(metrics),
  };
}
