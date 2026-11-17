// The Now tab as terminal rows: NEXT TURN, RECENT DECISIONS, PLAN, SESSION, CONTEXT, each a run of sibling lines under
// the pane, drawn from the model `nowTab` builds. The colours are the ones the terminal has always drawn for each
// reading, derived here from the model's numbers.
import { formatTokens, gaugeCells, limitColor, savingsColor, sparkline, tierBars } from '../../display.mjs';

// Below this a pin row holds one pin.
const PIN_ROW_COLUMNS = 64;
const SESSION_BAR = 16;
const ESTIMATE_LABEL = 22;
// The colours a reading's tone has always had on the terminal's context and cache rows.
const READING_COLOR = { success: 'green', warning: 'yellow', danger: 'red', muted: 'gray' };
const EMPTY_SESSION = { unpriced: '  no priced replies: cost unknown', none: '  no replies yet' };

/**
 * @param {any} ui the terminal painter
 * @param {any} model the Now model (panel.mjs nowOf)
 * @param {{ columns: number | null, now: number }} opts
 */
export function terminalNow(ui, model, { columns, now }) {
  return [
    ...nextLines(ui, model.next, columns),
    ...(model.decisions.length
      ? [ui.head('RECENT DECISIONS'), ...model.decisions.map((line) => ui.text(line)), ui.text(' ')]
      : []),
    ...planLines(ui, model.plan),
    ...sessionLines(ui, model.session, columns, now),
    ...contextLines(ui, model.context),
  ];
}

// NEXT TURN. With routing off or unavailable only the model applies: no tier, activity or reason from an earlier turn.
function nextLines(ui, next, columns) {
  const out = [ui.head('NEXT TURN')];
  if (next.state !== 'routed') return [...out, ...offLines(ui, next)];
  const { reading } = next;
  out.push(
    ui.line(
      '  ',
      ui.tierMeter(next.tier, next.tier ? 'lit' : 'off'),
      '  ',
      ui.text(next.label, { bold: true }),
      reading
        ? ui.line(
            '   ',
            // `uncertain` is an answer, not an activity: it applies none.
            reading.isActivity ? ui.activity(reading.choice) : ui.dim(reading.choice),
            reading.share ? ` ${reading.share}` : '',
            reading.other ? ui.dim(`  ${reading.other}`) : null,
            next.phase ? ui.dim(`  ${next.phase}`) : null,
          )
        : null,
    ),
    next.why ? ui.line(ui.dim('  why   '), next.why, next.support ? ui.dim(`   ${next.support}`) : null) : null,
    next.override ? ui.dim(`        ${next.override}`) : null,
    next.mode
      ? ui.line(
          ui.dim('  mode  '),
          ui.text(` ${next.mode.name} `, { backgroundColor: '#2a3040', color: '#c0c6d4' }),
          ui.dim(`  ${next.mode.from}`),
          next.mode.clear ? ui.dim(` · ${next.mode.clear}`) : null,
        )
      : null,
    ...pinLines(ui, next, columns),
    ui.text(' '),
  );
  return out.filter(Boolean);
}

// Routing off or unavailable: the model that runs, and why nothing else applies.
function offLines(ui, next) {
  const unavailable = next.state === 'unavailable';
  return [
    ui.line(
      unavailable ? ui.text('  ✕ ', { color: 'yellow' }) : ui.dim('  ○ '),
      ui.text(next.label, { bold: true }),
      ui.dim(`   ${next.note}`),
    ),
    ui.line(ui.dim('  pin   '), ui.dim(next.pinNote)),
    ui.text(' '),
  ];
}

// One button per tier, low to high, named by the route it runs ("▂▄ Haiku·high") with the classifier's support on the
// last turn; the current tier is marked and a pending pin is filled. A press pins the next turn only; pressing the
// pending pin again unpins it.
function pinLines(ui, next, columns) {
  const pin = ({ tier, route, support }) =>
    ui.Button({
      key: `pin-${tier}`,
      label: `${next.tier === tier ? '▶ ' : ''}${tierBars(tier)} ${route} ${support ?? '—'}`,
      variant: next.pendingPin === tier ? 'primary' : 'secondary',
      onPress: () => next.pick(tier),
    });
  const narrow = Number.isFinite(columns) && columns < PIN_ROW_COLUMNS;
  const rows = narrow ? next.pins.map((one) => [one]) : [next.pins.slice(0, 2), next.pins.slice(2)];
  return rows.map((pins, i) => ui.line(i ? '        ' : ui.dim('  pin   '), ...pins.flatMap((one) => [pin(one), ' '])));
}

// PLAN: Claude Code's plan windows, when it reports them.
function planLines(ui, plan) {
  if (!plan.length) return [];
  return [
    ui.line(ui.head('PLAN'), ui.dim('  Claude plan usage')),
    ...plan.map((limit) => {
      const [filled, empty] = gaugeCells(limit.percent / 100, 20);
      const color = limitColor(limit.percent);
      return ui.line(
        `  ${limit.label.padEnd(6)}`,
        ui.text(filled, { color }),
        ui.dim(empty),
        ui.text(` ${String(limit.percent).padStart(3)}%`, { color }),
        limit.reset ? ui.dim(`   resets ${limit.reset}`) : null,
      );
    }),
    ui.text(' '),
  ];
}

// SESSION: one total with the subagents, the difference against no routing, the main thread and the subagents as bars
// on one scale, then the replies by tier.
function sessionLines(ui, session, columns, now) {
  const strip = ui.stripRows(session.strip, { columns, now, since: session.since });
  const out = [
    ui.line(
      ui.head('SESSION'),
      session.head ? ui.dim(`  ${session.head}`) : null,
      session.running ? ui.text(`  ● ${session.running} running`, { color: 'yellow' }) : null,
    ),
  ];
  // Replies without a list price reach the strip but not the usage record: the tiers still show, the cost cannot.
  if (!session.priced) return [...out, ui.dim(EMPTY_SESSION[session.empty]), ...strip, ui.text(' ')];
  out.push(
    ui.line(
      '  ',
      ui.text(session.total, { bold: true }),
      ui.dim(`  ${session.billing}  `),
      ui.Button({ key: 'usage-session', label: 'Usage', onPress: session.usage }),
    ),
  );
  const { diff } = session;
  if (diff) {
    const versus = ` vs ${diff.versus}`;
    const of = ` ${diff.of}`;
    const fits = !Number.isFinite(columns) || 2 + diff.text.length + versus.length + of.length <= columns;
    out.push(
      ui.line(
        '  ',
        ui.text(diff.text, { bold: true, color: savingsColor(diff.usd) }),
        versus,
        fits ? ui.dim(of) : null,
      ),
    );
  }
  if (session.note) out.push(ui.dim(`  ${session.note}`));
  out.push(...costBars(ui, session));
  if (session.lost) out.push(lostLine(ui, session.policy));
  out.push(...strip, ui.text(' '));
  return out;
}

// The main thread and the subagents as bars on one scale, each with its difference against no routing; an effort-only
// profile shows its effort mix.
function costBars(ui, session) {
  const { scale } = session;
  const bar = (value) => {
    const filled = scale > 0 ? Math.max(value > 0 ? 1 : 0, Math.round((value / scale) * SESSION_BAR)) : 0;
    return [ui.text('█'.repeat(filled), { color: 'cyan' }), ui.dim('░'.repeat(SESSION_BAR - filled))];
  };
  const line = (against) =>
    against
      ? ui.line(
          '  ',
          ui.text(against.text, savingsColor(against.usd) ? { color: savingsColor(against.usd) } : {}),
          ui.dim(` vs ${against.versus}`),
        )
      : null;
  const out = session.parts.map((part) =>
    ui.line(
      part.name === 'main' ? '  main  ' : '  agents',
      part.amount.padStart(7),
      '  ',
      ...bar(part.usd),
      line(part.against),
    ),
  );
  if (session.effortMix.length)
    out.push(
      ui.line(
        ui.dim('  effort'),
        ...session.effortMix.flatMap(([effort, n]) => [ui.dim(`  ${effort} `), ui.text(String(n), { bold: true })]),
      ),
    );
  return out;
}

// Cache rebuilds cost more than the cheaper models saved: the policy's switch weight is the lever.
export const lostLine = (ui, onPress) =>
  ui.line(
    ui.text('  ▲ switches cost more than they saved  ', { color: 'yellow' }),
    ui.Button({ key: 'session-policy', label: 'Policy', onPress }),
  );

// CONTEXT: the window's fill on the model that runs next, and the cache reuse of the last reply and of the session.
function contextLines(ui, context) {
  const { fill, cache } = context;
  const [filled, empty] = gaugeCells((fill ?? 0) / 100, 20);
  return [
    ui.head('CONTEXT'),
    fill === null
      ? ui.line('  ctx    ', ui.dim(context.empty))
      : ui.line(
          '  ctx    ',
          ui.text(filled, { color: READING_COLOR[context.fillTone] }),
          ui.dim(empty),
          ` ${String(fill).padStart(3)}%`,
          ui.dim(`   ${context.suffix}`),
        ),
    ui.line(
      '  cache  ',
      cache.last
        ? ui.line(ui.text(cache.last.figure, { color: READING_COLOR[cache.tone] }), ui.dim(` ${cache.last.words}`))
        : ui.dim(cache.empty),
      cache.session ? ui.line(ui.dim(' · '), cache.session.figure, ui.dim(` ${cache.session.words}`)) : null,
      '   ',
      detailButton(ui, context),
    ),
    ...(context.detail.open ? readingDetail(ui, context.detail) : []),
  ];
}

const detailButton = (ui, context) =>
  ui.Button({
    key: 'usage-detail',
    label: context.detail.open ? 'less' : 'details',
    variant: context.detail.open ? 'primary' : 'secondary',
    onPress: context.detail.toggle,
  });

// Behind `details` on the Now tab: Claude's readings of the last reply, the input per reply, and the estimates the
// last decision weighed.
function readingDetail(ui, detail) {
  const { history, tiers } = detail;
  const glyphs = sparkline(history);
  const trend = history.length
    ? ui.line(
        '  ',
        ...[...glyphs].map((glyph, i) => {
          const tier = tiers[tiers.length - history.length + i];
          return tier ? ui.tier(tier, glyph) : ui.text(glyph);
        }),
        ui.dim(`  ${formatTokens(Math.min(...history))} … ${formatTokens(Math.max(...history))}`),
      )
    : ui.dim('  no replies yet');
  return [
    ui.dim(`  context observed ${formatTokens(detail.observed)} · estimated ${formatTokens(detail.estimated)}`),
    ui.dim(`  cache read ${formatTokens(detail.cacheRead)} · written ${formatTokens(detail.cacheWrite)} tokens`),
    ui.dim(`  output ${formatTokens(detail.output)} tokens on the last reply`),
    ui.text(' '),
    ui.head(`INPUT PER REPLY · ${detail.replies} · lowest to highest`),
    trend,
    ui.text(' '),
    ui.head('ESTIMATES · configured API rates'),
    ...detail.estimates.map(([label, value]) => ui.text(`${label.padEnd(ESTIMATE_LABEL)}${value}`)),
  ];
}
