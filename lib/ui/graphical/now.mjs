// The Now tab as cards for desktop, VS Code and mobile, drawn from the model in ui/model/now.mjs: Next turn; Plan usage
// and Context side by side when the pane is wide, stacked when narrow; This session; Recent decisions.
import { isFiniteNumber } from '../tokens.mjs';

// Two cards of label 10 + bar 10 + figure 7 + note + gaps, plus border and padding, need about 55 cells each.
const SIDE_BY_SIDE = 110;

// A reading's tone on a card: its own where it warns, else the card's ordinary one.
const alertOr = (name, ordinary) => (name === 'warning' || name === 'danger' ? name : ordinary);

// The routing mode as one label: "Cost mode from session · ... · /router mode default clears it".
const modeWords = (ui, mode) => (mode ? [ui.say(mode.from), mode.clear].filter(Boolean).join(' · ') : null);

const figure = (percent) => (Number.isFinite(percent) ? `${percent}%` : '—');

/**
 * @param {any} ui the graphical kit
 * @param {import('../model/now.mjs').NowModel} model
 * @param {{ columns: number | null, now: number }} opts
 */
export function graphicalNow(ui, model, { columns, now }) {
  const { Box } = ui;
  const plan = planCard(ui, model.plan);
  const context = contextCard(ui, model.context);
  const half = (card) => Box({ width: '50%', flexGrow: 1, flexShrink: 1, flexDirection: 'column', children: [card] });
  const pair = !plan
    ? context
    : isFiniteNumber(columns) && columns >= SIDE_BY_SIDE
      ? Box({ flexDirection: 'row', gap: 'lg', alignItems: 'stretch', children: [half(plan), half(context)] })
      : Box({ flexDirection: 'column', gap: 'lg', children: [plan, context] });
  return [
    Box({
      flexDirection: 'column',
      gap: 'lg',
      children: [
        nextCard(ui, model.next),
        model.held ? heldCard(ui, model.held) : null,
        pair,
        sessionCard(ui, model.session, columns, now),
        model.decisions ? decisionsCard(ui, model.decisions) : null,
      ].filter(Boolean),
    }),
  ];
}

/**
 * @param {any} ui
 * @param {import('../model/decisions.mjs').DecisionsModel} decisions
 */
// Recent decisions: a table row per turn, its notes as lines under it, and where every row is.
function decisionsCard(ui, decisions) {
  const { Box } = ui;
  const columns = [
    { key: 'time', label: 'Time', width: 6 },
    { key: 'took', label: 'Took', width: 6 },
    { key: 'route', label: 'Route' },
    { key: 'work', label: 'Work', width: 10 },
    { key: 'calls', label: 'Calls', width: 8, align: 'right' },
    { key: 'why', label: 'Why' },
  ];
  const records = decisions.turns.flatMap((turn) => [
    {
      time: turn.time,
      took: turn.took,
      route: Box({
        flexDirection: 'row',
        gap: 'sm',
        alignItems: 'center',
        children: [ui.tierMeter(turn.tier, turn.tier ? 'lit' : 'off'), ui.text(turn.route, { wrap: 'truncate-end' })],
      }),
      work: turn.work ? ui.text(turn.work, { color: ui.color('activity') }) : '',
      calls: turn.calls,
      why: ui.text(turn.why, { wrap: 'truncate-end', ...(turn.whyTone ? { color: ui.color(turn.whyTone) } : {}) }),
    },
    ...turn.notes.map((note) => ({
      span: ui.text(`${note.lead} ${note.text}`, {
        size: 'footnote',
        wrap: 'truncate-end',
        color: ui.color(note.tone ?? 'muted'),
      }),
    })),
  ]);
  return ui.section('Recent decisions', decisions.summary ? { hint: decisions.summary } : {}, [
    ui.table(columns, records),
    ui.muted(`${decisions.earlier ? `+${decisions.earlier} earlier · ` : ''}every row: ${decisions.more}`),
  ]);
}

/**
 * @param {any} ui
 * @param {import('../model/now.mjs').HeldOutModel} held
 */
// HELD OUT: a row per hold with its cause and end in the warning tone, the models it covers under it, and its Release.
function heldCard(ui, held) {
  const { Box } = ui;
  return ui.section('Held out', { hint: ui.say(held.note) }, [
    ...held.rows.map((row) =>
      Box({
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 'md',
        children: [
          Box({
            flexDirection: 'column',
            gap: 'xs',
            flexShrink: 1,
            children: [
              Box({
                flexDirection: 'row',
                flexWrap: 'wrap',
                gap: 'sm',
                children: [
                  ui.text(row.name, { weight: 'semibold' }),
                  ui.text(row.text, { color: ui.color('warning'), tabular: true }),
                ],
              }),
              row.covers ? ui.muted(`Covers ${row.covers}`, { size: 'footnote', wrap: 'wrap' }) : null,
            ].filter(Boolean),
          }),
          Box({
            flexShrink: 0,
            children: [ui.Button({ key: row.release.key, label: row.release.label, onPress: row.release.press })],
          }),
        ],
      }),
    ),
    ui.muted(ui.say(held.footer), { size: 'footnote', wrap: 'wrap' }),
  ]);
}

/**
 * @param {any} ui
 * @param {import('../model/now.mjs').NextModel} next
 */
// The tier meter and the route, the activity reading at the right, the why line, then the pins.
function nextCard(ui, next) {
  const { Box } = ui;
  const routed = next.state === 'routed';
  const meter = ui.tierMeter(routed ? next.tier : null, routed && next.tier ? 'lit' : 'off');
  const reading = routed ? next.reading : null;
  const headline = Box({
    flexDirection: 'row',
    flexWrap: 'nowrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 'md',
    children: [
      Box({
        flexDirection: 'row',
        alignItems: 'center',
        gap: 'sm',
        flexShrink: 1,
        overflow: 'hidden',
        children: [
          Box({ flexShrink: 0, children: [meter] }),
          ui.text(next.label, { size: 'heading', weight: 'semibold', wrap: 'truncate-end' }),
        ],
      }),
      reading
        ? Box({
            flexShrink: 0,
            children: [
              ui.text([reading.choice, reading.share].filter(Boolean).join(' '), {
                size: 'footnote',
                weight: 'medium',
                tabular: true,
                color: ui.color(reading.isActivity ? 'activity' : 'muted'),
              }),
            ],
          })
        : null,
    ].filter(Boolean),
  });
  if (!routed) {
    const unavailable = next.state === 'unavailable';
    return ui.section('Next turn', {}, [
      Box({
        flexDirection: 'column',
        gap: 'xs',
        children: [
          headline,
          unavailable
            ? ui.text(ui.say(next.note), { color: ui.color('warning'), wrap: 'truncate-end' })
            : ui.muted(ui.say(next.note)),
          ui.muted(ui.say(next.pin), { size: 'footnote' }),
        ],
      }),
    ]);
  }
  // The why, the classifier's support, an override and the routing mode fold into one wrapping line.
  const why = [next.why, next.support, reading?.other, next.phase, next.override, modeWords(ui, next.mode)].filter(
    Boolean,
  );
  return ui.section('Next turn', {}, [
    Box({
      flexDirection: 'column',
      gap: 'xs',
      children: [
        headline,
        next.tier
          ? why.length
            ? ui.muted(why.join(' · '), { tabular: true, wrap: 'wrap' })
            : null
          : ui.muted(next.firstTurn),
      ].filter(Boolean),
    }),
    Box({
      flexDirection: 'column',
      gap: 'sm',
      children: [
        ui.muted(ui.say(next.pinHead), { size: 'footnote', wrap: 'wrap' }),
        pinRow(ui, next),
        ui.muted(ui.say(next.pinNote), { size: 'footnote' }),
      ],
    }),
  ]);
}

/**
 * @param {any} ui
 * @param {import('../model/now.mjs').NextRoutedModel} next
 */
// The pins: per tier, its meter beside a Button named by its route, then its reading (`current` on the tier that runs
// now, the classifier's support). The meter stays outside the Button, which holds Text alone; only a pending pin is
// primary. A group may shrink, its label cut, so a long model name never makes it wider than the card.
function pinRow(ui, next) {
  const { Box, Button } = ui;
  return Box({
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'flex-start',
    gap: 'md',
    children: next.pins.map((pin) =>
      Box({
        flexDirection: 'row',
        alignItems: 'center',
        gap: 'xs',
        flexShrink: 1,
        minWidth: 0,
        children: [
          Box({ flexShrink: 0, children: [ui.tierMeter(pin.tier, 'lit')] }),
          Button({
            key: `pin-${pin.tier}`,
            label: pin.route,
            children: [ui.text(pin.route, { wrap: 'truncate-end' })],
            variant: next.pendingPin === pin.tier ? 'primary' : 'secondary',
            onPress: () => next.pick(pin.tier),
          }),
          pin.reading ? ui.muted(pin.reading, { size: 'footnote', tabular: true }) : null,
        ].filter(Boolean),
      }),
    ),
  });
}

/**
 * @param {any} ui
 * @param {import('../model/now.mjs').NowModel['plan']} plan
 */
function planCard(ui, plan) {
  if (!plan.length) return null;
  return ui.section(
    'Plan usage',
    {},
    plan.map((limit) =>
      ui.meter({
        label: limit.label,
        value: limit.percent / 100,
        tone: limit.tone,
        text: figure(limit.percent),
        caption: limit.reset ? `resets ${limit.reset}` : undefined,
      }),
    ),
  );
}

/**
 * @param {any} ui
 * @param {import('../model/now.mjs').ContextModel} context
 */
function contextCard(ui, context) {
  const { Box } = ui;
  const toggle = ui.Button({
    key: 'usage-detail',
    label: context.detail.open ? 'Less' : 'Details',
    variant: context.detail.open ? 'primary' : 'secondary',
    onPress: context.detail.toggle,
  });
  const { cache } = context;
  // The last reply's figure in the cache's tone, then its words; the session's after a muted dot.
  const reuse = cache.last
    ? [
        ui.text(cache.last.figure, { tabular: true, color: ui.color(alertOr(cache.tone, 'primary')) }),
        ui.text(cache.last.words),
        ...(cache.session
          ? [ui.muted('·'), ui.text(cache.session.figure, { tabular: true }), ui.text(cache.session.words)]
          : []),
      ]
    : [ui.text(ui.say(cache.empty))];
  return ui.section('Context', { action: toggle }, [
    context.fill === null
      ? ui.muted(ui.say(context.empty))
      : ui.meter({
          label: 'Window',
          value: context.fill / 100,
          tone: alertOr(context.fillTone, 'accent'),
          text: figure(context.fill),
          caption: context.suffix,
        }),
    Box({
      flexDirection: 'row',
      flexWrap: 'nowrap',
      alignItems: 'center',
      gap: 'md',
      children: [
        Box({ width: 10, flexShrink: 0, children: [ui.muted('Cache')] }),
        Box({
          flexDirection: 'row',
          alignItems: 'center',
          gap: 'xs',
          flexShrink: 1,
          overflow: 'hidden',
          children: reuse,
        }),
      ],
    }),
    ...(context.detail.open ? readingDetail(ui, context.detail) : []),
  ]);
}

/**
 * @param {any} ui
 * @param {import('../model/now.mjs').ContextModel['detail']} detail
 */
// Behind Details: Claude's readings of the last reply, the input per reply as a trend, and the estimates the last
// decision weighed.
function readingDetail(ui, detail) {
  const heading = (words) => ui.muted(words, { size: 'footnote', weight: 'semibold' });
  return [
    ui.muted(ui.say(detail.readings), { tabular: true, wrap: 'wrap' }),
    heading(ui.say(detail.input)),
    ...(detail.chart
      ? [ui.trend(detail.chart), ui.muted(ui.say(detail.range), { tabular: true })]
      : [ui.muted(ui.say(detail.empty))]),
    heading(ui.say(detail.estimatesHead)),
    ...detail.estimates.map(([label, value]) => ui.field(label, [value])),
  ];
}

/**
 * @param {any} ui
 * @param {import('../model/now.mjs').SessionModel} session
 * @param {number | null} columns
 * @param {number} now
 */
// The total and how it is paid, the difference against no routing, the main thread and the subagents on one scale,
// then the replies by tier.
function sessionCard(ui, session, columns, now) {
  const toggle = ui.Button({
    key: 'band-detail-toggle',
    label: ui.say(session.detailToggle),
    onPress: session.toggleDetail,
  });
  const running = session.running
    ? ui.text(`● ${session.running} running`, { color: ui.color('warning'), size: 'footnote', tabular: true })
    : null;
  const strip = ui.strip(session.strip, { columns, now, since: session.since });
  if (!session.priced)
    return ui.section(
      'This session',
      { hint: session.head || undefined, action: toggle },
      [running, ui.muted(ui.say(session.empty)), strip].filter(Boolean),
    );
  const { Box } = ui;
  const { diff, scale } = session;
  return ui.section(
    'This session',
    { hint: session.head || undefined, action: toggle },
    [
      Box({
        flexDirection: 'row',
        alignItems: 'flex-start',
        justifyContent: 'space-between',
        gap: 'md',
        children: [
          ui.stat({ value: session.total, caption: session.billing }),
          Box({
            flexDirection: 'row',
            gap: 'sm',
            alignItems: 'center',
            flexShrink: 0,
            children: [running, ui.Button({ key: 'usage-session', label: 'Usage', onPress: session.usage })].filter(
              Boolean,
            ),
          }),
        ],
      }),
      diff
        ? Box({
            flexDirection: 'row',
            flexWrap: 'wrap',
            gap: 'xs',
            children: [
              ui.text(diff.text, { tabular: true, color: ui.color(diff.tone) }),
              ui.muted(`vs ${diff.versus} ${diff.of}`, { tabular: true }),
            ],
          })
        : null,
      session.note ? ui.muted(session.note, { size: 'footnote', wrap: 'wrap' }) : null,
      Box({
        flexDirection: 'column',
        gap: 'sm',
        children: session.parts.map((part) =>
          ui.meter({
            label: part.name === 'main' ? 'Main' : 'Agents',
            value: scale > 0 ? part.usd / scale : 0,
            tone: 'accent',
            text: part.amount,
            caption: part.against ? `${part.against.text} vs ${part.against.versus}` : undefined,
          }),
        ),
      }),
      session.effortMix.length
        ? ui.muted(`Effort ${session.effortMix.map(([effort, n]) => `${effort} ${n}`).join(' · ')}`, { tabular: true })
        : null,
      session.lost
        ? ui.notice(
            'warning',
            'Switches cost more than they saved',
            ui.Button({ key: 'session-policy', label: 'Policy', onPress: session.policy }),
          )
        : null,
      strip,
    ].filter(Boolean),
  );
}
