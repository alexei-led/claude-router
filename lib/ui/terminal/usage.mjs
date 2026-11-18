// The Usage tab as terminal rows, drawn from the model `usageTab` builds (lib/ui/model/usage.mjs usageOf): the period
// buttons and scope, the cost ledger, the tokens, the breakdown, the trend or What if, what is worth a look, the
// subagents, the footer and Delete history.
import { SAVINGS_COLOR, sparkline } from '../../display.mjs';
import { toneColor } from '../tokens.mjs';
import { lostLine } from './now.mjs';
import { dimLines, pack } from './wrap.mjs';

// The savings colours the pane has always drawn a difference in, by tone.
const SAVING = { success: SAVINGS_COLOR.less, warning: SAVINGS_COLOR.more };
// What If's bars: the routed row in the heading's cyan, the others gray.
const BAR_COLOR = { accent: 'cyan', muted: 'gray' };
// The cost table's columns: label, cost, difference, no routing.
const COST_LABEL = 26;
const COST_AMOUNT = 8;
const COST_DIFF = 15;
const COST_BASE = 12;
// The ledger's amount column; the breakdown's name column; bars at full scale.
const LEDGER_AMOUNT = 9;
const NAME = 20;
const BAR = 22;
const AGENT_TYPE = 19;
const AGENT_SQUARES = 12;
// The breakdown's row: the open mark, the name, replies, cost and vs yours; "mostly on" or the share only where it fits.
const BREAKDOWN = 4 + 20 + 8 + 10 + 15;
const TAIL = 23;
// A route beside an insight needs this many columns.
const INSIGHT_ROUTE = 90;
// The subagent rows: the open mark, the type, its squares, agents, cost, and against Claude Code's pick with its arrow;
// a narrower pane drops the cost column and the reason.
const AGENT_ROW = 4 + AGENT_TYPE + AGENT_SQUARES + 3 + 9 + 11;
// A long All period keeps its last days of the agents-per-day trend, as many as the row has room for.
const TREND_DAYS = AGENT_ROW - 30;
const clipped = (text, width) => (text.length < width ? text : `${text.slice(0, width - 2)}…`);

// A difference in its savings colour; muted is a dim dash.
const differenceText = (ui, diff, width) =>
  diff.tone === 'muted'
    ? ui.dim(diff.text.padStart(width))
    : ui.text(diff.text.padStart(width), SAVING[diff.tone] ? { color: SAVING[diff.tone] } : {});
// Text in a model's colour; a model of no known family (muted) is plain.
const colored = (ui, tone, text) => ui.text(text, tone === 'muted' ? {} : { color: toneColor(tone, 'terminal') });

/**
 * @param {any} ui the terminal painter
 * @param {import('../model/usage.mjs').UsageModel} model
 * @param {{ columns: number | null }} opts
 */
export function terminalUsage(ui, model, { columns }) {
  const out = [periodRow(ui, model.period), scopeLine(ui, model.scope), ui.text(' ')];
  out.push(...summaryLines(ui, model.summary, columns));
  if (model.stats) out.push(ui.text(' '), ui.dim(`  ${model.stats.text}`));
  if (model.breakdown) {
    out.push(ui.text(' '), ...breakdownLines(ui, model.breakdown, columns), ui.text(' '));
    const { compare } = model;
    const toggle = ui.Button({
      key: compare.toggle.key,
      label: compare.toggle.label.terminal,
      hotkey: compare.toggle.hotkey,
      onPress: compare.toggle.press,
    });
    out.push(
      ...(compare.on
        ? [
            ui.line(ui.head(compare.head), ui.dim(` · ${compare.hint.terminal}   `), toggle),
            ...compareLines(ui, compare),
          ]
        : trendLines(ui, model.trend, toggle)),
      ...insightLines(ui, model.insights, columns),
    );
  }
  out.push(
    ui.text(' '),
    ...agentLines(ui, model.agents, columns),
    ui.text(' '),
    ...pack(model.notes.pieces, Math.min(model.notes.width, columns ?? model.notes.width), '  ').map((line) =>
      ui.dim(line),
    ),
  );
  out.push(ui.text(' '), deleteLine(ui, model.delete));
  return out;
}

const periodRow = (ui, period) =>
  ui.line(
    ...period.options.flatMap((option) => [
      ui.Button({
        key: option.key,
        label: option.label,
        ...(option.hotkey ? { hotkey: option.hotkey } : {}),
        variant: option.selected ? 'primary' : 'secondary',
        onPress: () => period.pick(option.value),
      }),
      ' ',
    ]),
    ui.dim(`  ${period.hint}`),
  );

const scopeLine = (ui, scope) =>
  scope.model
    ? ui.line(
        ui.dim(scope.text),
        scope.model.tier ? ui.tier(scope.model.tier, scope.model.text) : ui.text(scope.model.text),
      )
    : ui.dim(scope.text);

function summaryLines(ui, summary, columns) {
  if (summary.empty) return [ui.dim(summary.empty.text)];
  const { compared, headline, header } = summary;
  const row = (one) => {
    const style = one.strong ? { bold: true } : {};
    return ui.line(
      ui.cell(COST_LABEL, ui.text(one.label, style)),
      ui.text(one.amount.padStart(COST_AMOUNT), style),
      one.diff
        ? ui.text(one.diff.text.padStart(COST_DIFF), {
            ...style,
            ...(SAVING[one.diff.tone] ? { color: SAVING[one.diff.tone] } : {}),
          })
        : null,
      one.base !== null ? ui.dim(one.base.padStart(COST_BASE)) : null,
    );
  };
  const part = (one) =>
    ui.line(
      ui.cell(COST_LABEL, ui.dim(`  ${one.label}`)),
      ''.padStart(COST_AMOUNT),
      differenceText(ui, one.diff, COST_DIFF),
      one.note ? ui.dim(`   ${one.note.text}`) : null,
    );
  const out = [
    headline.compared
      ? ui.line(
          ui.text(headline.text, { bold: true, color: SAVING[headline.tone] }),
          ` ${headline.versus}`,
          headline.early ? ui.text(`   ${headline.early}`, { color: 'yellow' }) : null,
        )
      : ui.dim(headline.text),
    ui.text(' '),
    ui.line(
      ui.cell(COST_LABEL, ''),
      ui.dim(header.cost.terminal.padStart(COST_AMOUNT)),
      header.diff ? ui.dim(header.diff.terminal.padStart(COST_DIFF)) : null,
      header.base ? ui.dim(header.base.terminal.padStart(COST_BASE)) : null,
    ),
    ...summary.rows.map((one) => (one.kind === 'part' ? part(one) : row(one))),
    ui.dim('─'.repeat(COST_LABEL + COST_AMOUNT + (compared ? COST_DIFF + COST_BASE : 0))),
    row(summary.total),
    summary.credits ? row(summary.credits) : null,
  ].filter(Boolean);
  if (summary.legacy) out.push(...dimLines(ui, summary.legacy.text, columns));
  if (summary.lost) out.push(lostLine(ui, summary.lost.press));
  return out;
}

// A breakdown row's name: an activity as its verb, a tier as its bars, a model or a route by name.
function groupName(ui, name) {
  if (name.kind === 'none') return ui.dim(name.text);
  if (name.kind === 'activity') return ui.activity(name.text);
  if (name.kind === 'tier') return ui.bars(name.text);
  return ui.text(name.text);
}

function breakdownLines(ui, breakdown, columns) {
  const { group } = breakdown;
  const out = [
    ui.line(
      ui.head(group.head),
      ...group.options.flatMap((option) => [
        ui.Button({
          key: option.key,
          label: option.label.terminal,
          ...(option.hotkey ? { hotkey: option.hotkey } : {}),
          variant: option.selected ? 'primary' : 'secondary',
          onPress: () => group.pick(option.value),
        }),
        ' ',
      ]),
      ui.dim(`  ${group.hint}`),
    ),
  ];
  if (breakdown.empty) return [...out, ui.dim(`  ${breakdown.empty.text}`)];
  const { header } = breakdown;
  const tail = !Number.isFinite(columns) || columns >= BREAKDOWN + TAIL;
  out.push(
    ui.dim(
      `    ${''.padEnd(NAME)}${header.replies.terminal.padStart(8)}${header.cost.terminal.padStart(10)}${header.diff ? header.diff.terminal.padStart(15) : ''}${tail ? `   ${header.tail}` : ''}`,
    ),
  );
  const numbers = (one) => [
    `${one.replies.padStart(8)}${one.cost.padStart(10)}`,
    one.diff ? differenceText(ui, one.diff, 15) : null,
  ];
  for (const row of breakdown.rows) {
    out.push(
      ui.line(
        '  ',
        ui.Button({ key: row.key, label: row.open ? '▾' : '▸', plain: true, onPress: row.toggle }),
        ' ',
        ui.cell(NAME, groupName(ui, row.name)),
        ...numbers(row),
        tail && row.tail ? ui.dim(`   ${row.tail}`) : null,
      ),
    );
    for (const child of row.children)
      out.push(ui.line('      ', ui.cell(NAME - 2, groupName(ui, child.name)), ...numbers(child)));
    if (row.note) out.push(...dimLines(ui, `      ${row.note.text}`, columns));
  }
  return out;
}

function compareLines(ui, compare) {
  if (compare.unavailable) return [ui.dim(compare.unavailable)];
  return [
    ...compare.rows.map((row) => {
      const filled = Math.max(0, Math.min(BAR, Math.round(row.fill * BAR)));
      return ui.line(
        '  ',
        ui.cell(22, ui.text(row.label, row.strong ? { bold: true } : {})),
        ui.text('█'.repeat(filled), { color: BAR_COLOR[row.tone] }),
        ' '.repeat(BAR - filled),
        row.cost.padStart(LEDGER_AMOUNT),
        row.diff ? differenceText(ui, row.diff, 11) : '',
      );
    }),
    ui.dim(`  ${compare.note.text}`),
  ];
}

function trendLines(ui, trend, toggle) {
  if (trend.single) return [ui.line(ui.head(trend.head), ui.dim(`  ${trend.single}   `), toggle)];
  return [
    ui.line(
      ui.head(`${trend.head} `),
      ui.trend({ points: trend.points, labels: trend.chart.labels, alt: trend.chart.alt, tone: trend.chart.tone }),
      ui.dim(`  ${trend.peak.terminal}   `),
      toggle,
    ),
  ];
}

function insightLines(ui, insights, columns) {
  if (!insights) return [];
  return [
    ui.text(' '),
    ui.line(ui.head(insights.head), ui.dim(` · ${insights.hint.terminal}`)),
    ...insights.items.map((item) => insightLine(ui, item, columns)),
  ];
}

function insightLine(ui, item, columns) {
  const button = (b) => (b ? ui.Button({ key: b.key, label: b.label, onPress: b.press }) : null);
  if (item.kind === 'switch') return ui.line(`  ${item.text}  `, button(item.button));
  return ui.line(
    '  ',
    ...(item.activity ? [ui.activity(item.activity), ui.dim(' · ')] : []),
    item.tier ? ui.bars(item.tier) : ui.dim(item.notRouted.terminal),
    ` ${item.text}`,
    item.route && (!Number.isFinite(columns) || columns >= INSIGHT_ROUTE) ? ui.dim(` · ${item.route}`) : null,
    '  ',
    button(item.button),
  );
}

const squareParts = (ui, squares) => squares.runs.map((run) => colored(ui, run.tone, run.text));

// The names go under the strip where both do not fit on one row.
const split = (summary, columns) => {
  const namesWidth = summary.names.reduce((n, { text }, i) => n + (i ? 3 : 0) + text.length, 0);
  return Number.isFinite(columns) && 2 + summary.strip.width + 2 + namesWidth > columns;
};

function agentLines(ui, agents, columns) {
  const out = [ui.line(ui.head(agents.head), ui.dim(agents.scope))];
  const undated = agents.undated ? [ui.dim(`  ${agents.undated.text}`)] : [];
  if (agents.empty)
    return [
      ...out,
      ui.dim(`  ${agents.empty.text}`),
      ...undated,
      ...(agents.older ? [ui.dim(`  ${agents.older}`)] : []),
    ];
  const { summary } = agents;
  const narrow = Number.isFinite(columns) && columns < AGENT_ROW;
  const strip = squareParts(ui, summary.strip);
  const names = summary.names.flatMap((one, i) => [i ? ui.dim(' · ') : null, colored(ui, one.tone, one.text)]);
  out.push(
    ...(split(summary, columns)
      ? [ui.line('  ', ...strip), ui.line('  ', ...names)]
      : [ui.line('  ', ...strip, '  ', ...names)]),
    ui.line(`  ${summary.total}`, ui.dim(' · '), summary.moved.terminal, ui.dim(' · '), summary.kept.terminal),
  );
  if (summary.verdict)
    out.push(
      summary.verdict.priced
        ? ui.line(
            '  ',
            ui.text(summary.verdict.text, { bold: true, color: SAVING[summary.verdict.tone] }),
            summary.verdict.versus,
            ui.dim(summary.verdict.on),
          )
        : ui.dim(`  ${summary.verdict.text}`),
    );
  if (agents.trend)
    out.push(
      ui.line(
        `  ${agents.trend.label} `,
        ui.text(sparkline(agents.trend.values.slice(-TREND_DAYS)), { bold: true }),
        ui.dim(`  ${agents.trend.peak.terminal}`),
      ),
    );
  out.push(...undated);
  const cost = (one) => (one.tone === 'muted' ? ui.dim(one.text.padStart(9)) : one.text.padStart(9));
  const pick = (one) => (one.dash ? ui.dim(one.text.padStart(9)) : differenceText(ui, one, 11));
  for (const group of agents.groups) {
    out.push(ui.text(' '), ui.line(ui.text(`  ${group.head}`, { bold: true }), ui.dim(` · ${group.hint.terminal}`)));
    if (group.header)
      out.push(
        ui.dim(
          `    ${group.header.type.padEnd(AGENT_TYPE)}${group.header.agents.padEnd(AGENT_SQUARES + 3)}${narrow ? '' : group.header.cost.padStart(9)}${group.header.pick.padStart(9)}`,
        ),
      );
    for (const row of group.rows) {
      out.push(
        ui.line(
          '  ',
          ui.Button({ key: row.key, label: row.open ? '▾' : '▸', plain: true, onPress: row.toggle }),
          ' ',
          ui.cell(AGENT_TYPE, clipped(row.name.terminal, AGENT_TYPE)),
          ui.cell(
            AGENT_SQUARES,
            ui.line(...squareParts(ui, row.squares), row.squares.rest ? ui.dim(row.squares.rest) : null),
          ),
          row.agents.padStart(3),
          narrow ? null : cost(row.cost),
          row.pick ? pick(row.pick) : null,
          row.why && !narrow ? ui.dim(`  ${row.why.terminal}`) : null,
        ),
      );
      for (const child of row.children)
        out.push(
          ui.line(
            '      ',
            ui.cell(17, colored(ui, child.tone, child.text)),
            ui.cell(15, ui.dim(child.detail)),
            narrow ? null : cost(child.cost),
            child.pick ? pick(child.pick) : null,
          ),
        );
      if (row.notes) out.push(...dimLines(ui, `      ${row.notes.text}`, columns));
    }
  }
  out.push(ui.text(' '), ...agents.legend.flatMap((one) => dimLines(ui, `  ${one.text}`, columns)));
  return out;
}

function deleteLine(ui, del) {
  if (!del.confirming)
    return ui.Button({ key: del.ask.key, label: del.ask.label, dimColor: true, onPress: del.ask.press });
  return ui.line(
    ui.text(`${del.question}  `, { color: 'yellow' }),
    ui.Button({ key: del.yes.key, label: del.yes.label, variant: 'primary', onPress: del.yes.press }),
    ' ',
    ui.Button({ key: del.no.key, label: del.no.label, onPress: del.no.press }),
  );
}
