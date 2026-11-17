// The Now tab as cards for desktop, VS Code and mobile, drawn from the model `nowTab` builds: Next turn; Plan usage
// and Context side by side when the pane is wide, stacked when narrow; This session; Recent decisions.
import { muted, tone } from './tone.mjs';

// Two cards of label 10 + bar 10 + figure 7 + note + gaps, plus border and padding, need about 55 cells each.
const SIDE_BY_SIDE = 110;

const figure = (percent) => (Number.isFinite(percent) ? `${percent}%` : '—');

/**
 * @param {any} ui the graphical painter
 * @param {any} model the Now model (panel.mjs nowOf)
 * @param {{ columns: number | null, now: number }} opts
 */
export function graphicalNow(ui, model, { columns, now }) {
  const { Box } = ui;
  const plan = planCard(ui, model.plan);
  const context = contextCard(ui, model.context);
  const half = (card) => Box({ width: '50%', flexGrow: 1, flexShrink: 1, flexDirection: 'column', children: [card] });
  const pair = !plan
    ? context
    : Number.isFinite(columns) && columns >= SIDE_BY_SIDE
      ? Box({ flexDirection: 'row', gap: 'lg', alignItems: 'stretch', children: [half(plan), half(context)] })
      : Box({ flexDirection: 'column', gap: 'lg', children: [plan, context] });
  return [
    Box({
      flexDirection: 'column',
      gap: 'lg',
      children: [
        nextCard(ui, model.next),
        pair,
        sessionCard(ui, model.session, columns, now),
        model.decisions.length
          ? ui.section(
              'Recent decisions',
              {},
              model.decisions.map((line) => ui.text(line, { size: 'footnote', mono: true, wrap: 'truncate-end' })),
            )
          : null,
      ].filter(Boolean),
    }),
  ];
}

// The tier meter and the route, the activity reading at the right, the why line, then the pins.
function nextCard(ui, next) {
  const { Box } = ui;
  const routed = next.state === 'routed';
  const meter = ui.tierMeter(routed ? next.tier : null, routed && next.tier ? 'lit' : 'off');
  const reading = routed && next.reading;
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
                color: tone(reading.isActivity ? 'activity' : 'muted'),
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
            ? ui.text(next.card.note, { color: tone('warning'), wrap: 'truncate-end' })
            : muted(ui, next.card.note),
          muted(ui, next.card.pin, { size: 'footnote' }),
        ],
      }),
    ]);
  }
  // The why, the classifier's support, an override and the routing mode fold into one wrapping line.
  const why = [next.why, next.support, reading?.other, next.phase, next.override, next.mode?.card ?? null].filter(
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
            ? muted(ui, why.join(' · '), { tabular: true, wrap: 'wrap' })
            : null
          : muted(ui, next.card.firstTurn),
      ].filter(Boolean),
    }),
    Box({
      flexDirection: 'column',
      gap: 'sm',
      children: [
        muted(ui, 'Pin next turn', { size: 'footnote' }),
        ui.choice({
          key: 'pin',
          // Only a pending pin is primary; the tier that runs now is marked with a dot and the word current.
          options: next.pins.map((pin) => {
            const current = pin.tier === next.tier;
            return {
              value: pin.tier,
              label: pin.route,
              hint: [current ? 'current' : null, pin.support ?? '—'].filter(Boolean).join(' · '),
              icon: [
                current ? ui.text('●', { color: tone(`tier:${pin.tier}`) }) : null,
                ui.tierMeter(pin.tier, 'lit', { inButton: true }),
              ].filter(Boolean),
            };
          }),
          selected: next.pendingPin,
          onPick: next.pick,
        }),
      ],
    }),
  ]);
}

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
        ui.text(cache.last.figure, { tabular: true, color: tone(cache.graphicalTone) }),
        ui.text(cache.last.words),
        ...(cache.session
          ? [muted(ui, '·'), ui.text(cache.session.figure, { tabular: true }), ui.text(cache.session.words)]
          : []),
      ]
    : [ui.text(cache.card.empty)];
  return ui.section('Context', { action: toggle }, [
    context.fill === null
      ? muted(ui, context.card.empty)
      : ui.meter({
          label: 'Window',
          value: context.fill / 100,
          tone: context.graphicalFillTone,
          text: figure(context.fill),
          caption: context.suffix,
        }),
    Box({
      flexDirection: 'row',
      flexWrap: 'nowrap',
      alignItems: 'center',
      gap: 'md',
      children: [
        Box({ width: 10, flexShrink: 0, children: [muted(ui, 'Cache')] }),
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

// Behind Details: Claude's readings of the last reply, the input per reply as a trend, and the estimates the last
// decision weighed.
function readingDetail(ui, detail) {
  const { card } = detail;
  const heading = (words) => muted(ui, words, { size: 'footnote', weight: 'semibold' });
  return [
    muted(ui, card.readings, { tabular: true, wrap: 'wrap' }),
    heading(card.input),
    ...(card.trend ? [ui.trend(card.trend), muted(ui, card.range, { tabular: true })] : [muted(ui, card.empty)]),
    heading(card.estimates),
    ...detail.estimates.map(([label, value]) => ui.field(label, [value])),
  ];
}

// The total and how it is paid, the difference against no routing, the main thread and the subagents on one scale,
// then the replies by tier.
function sessionCard(ui, session, columns, now) {
  const toggle = ui.Button({
    key: 'band-detail-toggle',
    label: session.bandDetail ? 'Hide session row in band' : 'Show session row in band',
    onPress: session.toggleDetail,
  });
  const running = session.running
    ? ui.text(`● ${session.running} running`, { color: tone('warning'), size: 'footnote' })
    : null;
  const strip = ui.strip(session.strip, { columns, now, since: session.since });
  if (!session.priced)
    return ui.section(
      'This session',
      { hint: session.head || undefined, action: toggle },
      [running, muted(ui, session.empty.graphical), strip].filter(Boolean),
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
              ui.text(diff.text, { tabular: true, color: tone(diff.tone) }),
              muted(ui, `vs ${diff.versus} ${diff.of}`, { tabular: true }),
            ],
          })
        : null,
      session.note ? muted(ui, session.note, { size: 'footnote', wrap: 'wrap' }) : null,
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
        ? muted(ui, `Effort ${session.effortMix.map(([effort, n]) => `${effort} ${n}`).join(' · ')}`, { tabular: true })
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
