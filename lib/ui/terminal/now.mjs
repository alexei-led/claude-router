// The Now tab as terminal rows: NEXT TURN, RECENT DECISIONS, PLAN, SESSION, CONTEXT, each in a box from PANEL_COLUMNS
// and a run of lines under the pane below it, drawn from the model in ui/model/now.mjs. The colours are the ones the
// terminal has always drawn for each reading, derived here from the model's numbers.
import { gaugeCells, sparkline } from '../../display.mjs';
import { CHIP_BACKGROUND, isFiniteNumber } from '../tokens.mjs';
import { dimLines } from './wrap.mjs';

const SESSION_BAR = 16;
// A cost bar's label and its amount, before the bar.
const PART_LABEL = 8;
const AMOUNT = 7;
const ESTIMATE_LABEL = 22;
// A Release button: its label in `[ ` and ` ]`.
const RELEASE_CELLS = 'Release'.length + 4;

/**
 * @param {any} ui the terminal kit
 * @param {import('../model/now.mjs').NowModel} model
 * @param {{ columns: number | null, now: number }} opts
 */
export function terminalNow(ui, model, { columns, now }) {
  // Each section stacks full width: from PANEL_COLUMNS in a box, so its lines fit the box's inner width.
  const room = ui.inner(columns);
  return [
    ...ui.panel(columns, nextLines(ui, model.next, room)),
    ...(model.held ? ui.panel(columns, heldLines(ui, model.held, room)) : []),
    ...(model.decisions.length
      ? ui.panel(columns, [ui.head('RECENT DECISIONS'), ...model.decisions.map((line) => ui.text(line))])
      : []),
    ...(model.plan.length ? ui.panel(columns, planLines(ui, model.plan)) : []),
    ...ui.panel(columns, sessionLines(ui, model.session, room, now)),
    ...ui.panel(columns, contextLines(ui, model.context), false),
  ];
}

/**
 * @param {any} ui
 * @param {import('../model/now.mjs').NextModel} next
 * @param {number | null} columns the section's own columns
 */
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
      ui.text(next.label, { weight: 'semibold' }),
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
          ui.text(` ${next.mode.name} `, { backgroundColor: CHIP_BACKGROUND, color: ui.color('primary') }),
          ui.dim(`  ${ui.say(next.mode.from)}`),
          next.mode.clear ? ui.dim(` · ${next.mode.clear}`) : null,
        )
      : null,
    ...pinLines(ui, next, columns),
  );
  return out.filter(Boolean);
}

/**
 * @param {any} ui
 * @param {import('../model/now.mjs').NextOffModel} next
 */
// Routing off or unavailable: the model that runs, and why nothing else applies.
function offLines(ui, next) {
  const unavailable = next.state === 'unavailable';
  return [
    ui.line(
      unavailable ? ui.text('  ✕ ', { color: ui.color('warning') }) : ui.dim('  ○ '),
      ui.text(next.label, { weight: 'semibold' }),
      ui.dim(`   ${ui.say(next.note)}`),
    ),
    ui.line(ui.dim('  pin   '), ui.dim(ui.say(next.pin))),
  ];
}

/**
 * @param {any} ui
 * @param {import('../model/now.mjs').NextRoutedModel} next
 * @param {number | null} columns
 */
// The pins as one dropdown under what they offer: a tier pins the next turn only, No pin drops a pending pin.
function pinLines(ui, next, columns) {
  return [
    ...dimLines(ui, `  ${ui.say(next.pinHead)}`, columns),
    ui.line('    ', ui.select(next.pinControl)),
    ...dimLines(ui, `    ${ui.say(next.pinNote)}`, columns),
  ];
}

/**
 * @param {any} ui
 * @param {import('../model/now.mjs').HeldOutModel} held
 * @param {number | null} columns the section's own columns
 */
// HELD OUT: each hold with its cause and end, the models it covers and its Release, on the row's own line where it fits.
function heldLines(ui, held, columns) {
  const out = [ui.line(ui.head('HELD OUT'), ui.dim(`  ${ui.say(held.note)}`))];
  for (const row of held.rows) {
    const release = ui.Button({ key: row.release.key, label: row.release.label, onPress: row.release.press });
    const beside = !isFiniteNumber(columns) || `  ${row.name}  ${row.text}  `.length + RELEASE_CELLS <= columns;
    out.push(
      ui.line(
        ui.text(`  ${row.name}`, { weight: 'semibold' }),
        ui.dim(`  ${row.text}`),
        beside ? '  ' : null,
        beside ? release : null,
      ),
    );
    if (row.covers) out.push(...dimLines(ui, `    covers ${row.covers}`, columns));
    if (!beside) out.push(ui.line('    ', release));
  }
  out.push(ui.dim(`  ${ui.say(held.footer)}`));
  return out;
}

/**
 * @param {any} ui
 * @param {import('../model/now.mjs').NowModel['plan']} plan
 */
// PLAN: Claude Code's plan windows, when it reports them.
function planLines(ui, plan) {
  return [
    ui.line(ui.head('PLAN'), ui.dim('  Claude plan usage')),
    ...plan.map((limit) => {
      const [filled, empty] = gaugeCells(limit.percent / 100, 20);
      const color = ui.color(limit.tone);
      return ui.line(
        `  ${limit.label.padEnd(6)}`,
        ui.text(filled, { color }),
        ui.dim(empty),
        ui.text(` ${String(limit.percent).padStart(3)}%`, { color }),
        limit.reset ? ui.dim(`   resets ${limit.reset}`) : null,
      );
    }),
  ];
}

/**
 * @param {any} ui
 * @param {import('../model/now.mjs').SessionModel} session
 * @param {number | null} columns the section's own columns
 * @param {number} now
 */
// SESSION: one total with the subagents, the difference against no routing, the main thread and the subagents as bars
// on one scale, then the replies by tier.
function sessionLines(ui, session, columns, now) {
  const strip = ui.stripRows(session.strip, { columns, now, since: session.since });
  const out = [
    ui.line(
      ui.head('SESSION'),
      session.head ? ui.dim(`  ${session.head}`) : null,
      session.running ? ui.text(`  ● ${session.running} running`, { color: ui.color('warning') }) : null,
      '  ',
      // The band's second row, on and off, so two rows can be left at any band width.
      ui.Button({ key: 'band-detail-toggle', label: ui.say(session.detailToggle), onPress: session.toggleDetail }),
    ),
  ];
  // Replies without a list price reach the strip but not the usage record: the tiers still show, the cost cannot.
  if (!session.priced) return [...out, ui.dim(`  ${ui.say(session.empty)}`), ...strip];
  out.push(
    ui.line(
      '  ',
      ui.text(session.total, { weight: 'semibold' }),
      ui.dim(`  ${session.billing}  `),
      ui.Button({ key: 'usage-session', label: 'Usage', onPress: session.usage }),
    ),
  );
  const { diff } = session;
  if (diff) {
    const versus = ` vs ${diff.versus}`;
    const of = ` ${diff.of}`;
    const fits = !isFiniteNumber(columns) || 2 + diff.text.length + versus.length + of.length <= columns;
    out.push(
      ui.line(
        '  ',
        ui.text(diff.text, { weight: 'semibold', color: ui.color(diff.tone) }),
        versus,
        fits ? ui.dim(of) : null,
      ),
    );
  }
  if (session.note) out.push(ui.dim(`  ${session.note}`));
  out.push(...costBars(ui, session, columns));
  if (session.lost) out.push(ui.lostLine(session.policy));
  out.push(...strip);
  return out;
}

/**
 * @param {any} ui
 * @param {import('../model/now.mjs').SessionModel} session
 * @param {number | null} columns the section's own columns
 */
// The main thread and the subagents as bars on one scale, each with its difference against no routing where it fits; an
// effort-only profile shows its effort mix.
function costBars(ui, session, columns) {
  const { scale } = session;
  const bar = (value) => {
    const filled = scale > 0 ? Math.max(value > 0 ? 1 : 0, Math.round((value / scale) * SESSION_BAR)) : 0;
    return [ui.text('█'.repeat(filled), { color: ui.color('accent') }), ui.dim('░'.repeat(SESSION_BAR - filled))];
  };
  const versus = (against) => {
    if (!against) return null;
    const note = ` vs ${against.versus}`;
    const width = PART_LABEL + AMOUNT + 2 + SESSION_BAR + 2 + against.text.length + note.length;
    if (isFiniteNumber(columns) && width > columns) return null;
    return ui.line('  ', ui.text(against.text, against.tone ? { color: ui.color(against.tone) } : {}), ui.dim(note));
  };
  const out = session.parts.map((part) =>
    ui.line(
      part.name === 'main' ? '  main  ' : '  agents',
      part.amount.padStart(AMOUNT),
      '  ',
      ...bar(part.usd),
      versus(part.against),
    ),
  );
  if (session.effortMix.length)
    out.push(
      ui.line(
        ui.dim('  effort'),
        ...session.effortMix.flatMap(([effort, n]) => [
          ui.dim(`  ${effort} `),
          ui.text(String(n), { weight: 'semibold' }),
        ]),
      ),
    );
  return out;
}

/**
 * @param {any} ui
 * @param {import('../model/now.mjs').ContextModel} context
 */
// CONTEXT: the window's fill on the model that runs next, and the cache reuse of the last reply and of the session.
function contextLines(ui, context) {
  const { fill, cache } = context;
  const [filled, empty] = gaugeCells((fill ?? 0) / 100, 20);
  return [
    ui.head('CONTEXT'),
    fill === null
      ? ui.line('  ctx    ', ui.dim(ui.say(context.empty)))
      : ui.line(
          '  ctx    ',
          ui.text(filled, { color: ui.color(context.fillTone) }),
          ui.dim(empty),
          ` ${String(fill).padStart(3)}%`,
          ui.dim(`   ${context.suffix}`),
        ),
    ui.line(
      '  cache  ',
      cache.last
        ? ui.line(ui.text(cache.last.figure, { color: ui.color(cache.tone) }), ui.dim(` ${cache.last.words}`))
        : ui.dim(ui.say(cache.empty)),
      cache.session ? ui.line(ui.dim(' · '), cache.session.figure, ui.dim(` ${cache.session.words}`)) : null,
      '   ',
      detailButton(ui, context),
    ),
    ...(context.detail.open ? readingDetail(ui, context.detail) : []),
  ];
}

/**
 * @param {any} ui
 * @param {import('../model/now.mjs').ContextModel} context
 */
const detailButton = (ui, context) =>
  ui.Button({
    key: 'usage-detail',
    label: context.detail.open ? 'less' : 'details',
    variant: context.detail.open ? 'primary' : 'secondary',
    onPress: context.detail.toggle,
  });

/**
 * @param {any} ui
 * @param {import('../model/now.mjs').ContextModel['detail']} detail
 */
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
        ui.dim(`  ${ui.say(detail.range)}`),
      )
    : ui.dim(`  ${ui.say(detail.empty)}`);
  return [
    ...detail.readings.terminal.map((line) => ui.dim(`  ${line}`)),
    ui.text(' '),
    ui.head(ui.say(detail.input)),
    trend,
    ui.text(' '),
    ui.head(ui.say(detail.estimatesHead)),
    ...detail.estimates.map(([label, value]) => ui.text(`${label.padEnd(ESTIMATE_LABEL)}${value}`)),
  ];
}
