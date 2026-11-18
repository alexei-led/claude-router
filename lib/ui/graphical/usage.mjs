// The Usage tab as cards for desktop, VS Code and mobile, drawn from the model in ui/model/usage.mjs: the period control and its scope; Summary with the headline figure and the ledger; Trend; Breakdown with
// What if; Worth a look; Subagents; About these numbers; then Delete history on its own row. Layout only: every word,
// figure and tone is the model's.
import { isFiniteNumber } from '../tokens.mjs';
import { squares } from './squares.mjs';

// The tables' fixed columns, in cells; a column without a width takes what is left.
const SUMMARY = {
  label: { align: 'left' },
  amount: { align: 'right', width: 9 },
  diff: { align: 'right', width: 12 },
  base: { align: 'right', width: 10 },
};
const BREAKDOWN = {
  name: { align: 'left' },
  replies: { align: 'right', width: 7 },
  cost: { align: 'right', width: 9 },
  diff: { align: 'right', width: 12 },
  share: { align: 'left', width: 22 },
};
const WHAT_IF = {
  label: { align: 'left' },
  bar: { align: 'left', width: 30 },
  cost: { align: 'right', width: 9 },
  diff: { align: 'right', width: 12 },
};
const AGENTS = {
  name: { align: 'left' },
  squares: { align: 'left', width: 14 },
  agents: { align: 'right', width: 6 },
  cost: { align: 'right', width: 9 },
  pick: { align: 'right', width: 14 },
};
// The tables drop their wide-only columns below this many columns.
const WIDE = 80;
// An open row's children and notes sit in from its name.
const INDENT = 4;

const figure = (ui, text, extra = {}) => ui.text(text, { tabular: true, wrap: 'truncate-end', ...extra });
const toned = (ui, one) => figure(ui, one.text, { color: ui.color(one.tone) });
const footnote = (ui, words) => ui.muted(words, { size: 'footnote', tabular: true, wrap: 'wrap' });
const subheading = (ui, words) => ui.muted(words, { size: 'footnote', weight: 'semibold' });
const wrapRow = (ui, children, extra = {}) =>
  ui.Box({ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 'sm', ...extra, children });
const columnsOf = (spec, keys, labels = {}) => keys.map((key) => ({ key, label: labels[key] ?? '', ...spec[key] }));
const chevron = (ui, row) => ui.Button({ key: row.key, label: row.open ? '▾' : '▸', plain: true, onPress: row.toggle });
const indented = (ui, children) =>
  ui.Box({ flexDirection: 'row', alignItems: 'center', gap: 'xs', paddingLeft: INDENT, children });

/**
 * @param {any} ui the graphical kit
 * @param {import('../model/usage.mjs').UsageModel} source
 * @param {{ columns: number | null }} opts
 */
export function graphicalUsage(ui, source, { columns }) {
  // A pane narrower than this, or one that reports no width, drops each table's wide-only columns for its narrow ones.
  const wide = isFiniteNumber(columns) && columns >= WIDE;
  const fit = (list = []) => list.filter(({ show }) => !show || (show === 'wide') === wide).map(({ key }) => key);
  const model = {
    ...source,
    summary: { ...source.summary, columns: fit(source.summary.columns) },
    breakdown: source.breakdown && { ...source.breakdown, columns: fit(source.breakdown.columns) },
    compare: source.compare && { ...source.compare, columns: fit(source.compare.columns) },
    agents: { ...source.agents, columns: fit(source.agents.columns) },
  };
  return [
    ui.Box({
      flexDirection: 'column',
      gap: 'lg',
      children: [
        periodBlock(ui, model),
        summaryCard(ui, model.summary, model.stats),
        model.trend?.chart ? trendCard(ui, model.trend) : null,
        model.breakdown ? breakdownCard(ui, model.breakdown, model.compare) : null,
        model.insights ? insightsCard(ui, model.insights) : null,
        agentsCard(ui, model.agents),
        ui.section(
          model.notes.title,
          {},
          model.notes.lines.map((line) => footnote(ui, line)),
        ),
        deleteRow(ui, model.delete),
      ].filter(Boolean),
    }),
  ];
}

// The period Buttons, then which replies they hold and against what.
function periodBlock(ui, { period, scope }) {
  return ui.Box({
    flexDirection: 'column',
    gap: 'sm',
    children: [
      ui.choice({
        key: 'period',
        options: period.options.map((option) => ({
          value: option.value,
          key: option.key,
          label: option.label,
          ...(option.hotkey ? { hotkey: option.hotkey } : {}),
        })),
        selected: period.value,
        onPick: period.pick,
        gap: 'sm',
      }),
      ui.muted(scope.graphical, { wrap: 'wrap' }),
    ],
  });
}

// The headline figure and its saving, the ledger, the tokens and the notes that apply.
function summaryCard(ui, summary, stats) {
  if (summary.empty) return ui.section('Summary', {}, [ui.text(summary.empty.graphical, { wrap: 'wrap' })]);
  const { headline } = summary;
  const record = (one) => ({
    label:
      one.kind === 'part'
        ? indented(ui, [ui.muted(one.graphical), one.note ? footnote(ui, one.note.graphical) : null].filter(Boolean))
        : ui.text(one.graphical, { wrap: 'truncate-end', ...(one.strong ? { weight: 'semibold' } : {}) }),
    amount: one.amount ? figure(ui, one.amount, one.strong ? { weight: 'semibold' } : {}) : '',
    diff: one.diff ? toned(ui, one.diff) : '',
    base: one.base ? figure(ui, one.base, { color: ui.color('muted') }) : '',
  });
  return ui.section(
    'Summary',
    {},
    [
      headline.compared
        ? ui.stat({
            value: summary.stat.value,
            caption: summary.stat.caption,
            delta: headline.delta,
            tone: headline.tone,
          })
        : ui.stat({ value: summary.stat.value, caption: summary.stat.caption }),
      headline.compared ? null : ui.muted(headline.text, { wrap: 'wrap' }),
      headline.compared && headline.early
        ? ui.text(headline.early, { size: 'footnote', color: ui.color('warning'), wrap: 'wrap' })
        : null,
      ui.table(
        columnsOf(SUMMARY, summary.columns, summary.labels),
        [...summary.rows, summary.total, summary.credits].filter(Boolean).map(record),
      ),
      stats ? footnote(ui, stats.text) : null,
      summary.legacy ? footnote(ui, summary.legacy.graphical) : null,
      summary.lost
        ? ui.notice(
            'warning',
            summary.lost.text,
            ui.Button({ key: summary.lost.button.key, label: summary.lost.button.label, onPress: summary.lost.press }),
          )
        : null,
    ].filter(Boolean),
  );
}

function trendCard(ui, trend) {
  return ui.section(trend.title, { hint: trend.hint }, [ui.trend(trend.chart), footnote(ui, trend.peak.graphical)]);
}

// A breakdown row's name: an activity in its tone, a tier as its bars and name, a model or route by name.
function nameParts(ui, name) {
  if (name.kind === 'none') return [ui.muted(name.graphical)];
  if (name.kind === 'activity') return [ui.text(name.graphical, { color: ui.color('activity'), wrap: 'truncate-end' })];
  if (name.kind === 'tier')
    return [ui.tierMeter(name.text, 'lit', { inButton: true }), ui.text(name.graphical, { wrap: 'truncate-end' })];
  return [ui.text(name.graphical, { wrap: 'truncate-end' })];
}

// The grouping and What if over the cost by activity, model or tier, each row a bar of its share; an open row's
// children and cost parts in the same card; What if's rows under them when it is on.
function breakdownCard(ui, breakdown, compare) {
  const { group } = breakdown;
  const controls = wrapRow(
    ui,
    [
      ui.choice({
        key: 'group',
        options: group.options.map((option) => ({
          value: option.value,
          key: option.key,
          label: option.label.graphical,
          ...(option.hotkey ? { hotkey: option.hotkey } : {}),
        })),
        selected: group.value,
        onPick: group.pick,
        gap: 'sm',
      }),
      ui.Button({
        key: compare.toggle.key,
        label: compare.toggle.label.graphical,
        hotkey: compare.toggle.hotkey,
        variant: compare.on ? 'primary' : 'secondary',
        onPress: compare.toggle.press,
      }),
    ],
    { justifyContent: 'space-between', gap: 'md' },
  );
  if (breakdown.empty)
    return ui.section(breakdown.title, {}, [
      controls,
      ui.muted(breakdown.empty.graphical, { wrap: 'wrap' }),
      ...(compare.on ? whatIf(ui, compare) : []),
    ]);
  const numbers = (one) => ({
    replies: figure(ui, one.replies),
    cost: figure(ui, one.cost),
    diff: one.diff ? toned(ui, one.diff) : '',
  });
  const records = breakdown.rows.flatMap((row) => [
    {
      name: ui.Box({
        flexDirection: 'row',
        alignItems: 'center',
        gap: 'xs',
        children: [chevron(ui, row), ...nameParts(ui, row.name)],
      }),
      ...numbers(row),
      share: ui.meter({ value: row.share.value, tone: 'accent', text: row.share.text }),
    },
    ...row.children.map((child) => ({ name: indented(ui, nameParts(ui, child.name)), ...numbers(child), share: '' })),
    ...(row.note ? [{ span: indented(ui, [footnote(ui, row.note.graphical)]) }] : []),
  ]);
  return ui.section(breakdown.title, {}, [
    controls,
    ui.table(columnsOf(BREAKDOWN, breakdown.columns, breakdown.labels), records),
    ...(compare.on ? whatIf(ui, compare) : []),
  ]);
}

// What the same tokens cost on each model alone, each a bar with its cost beside it, against your model.
function whatIf(ui, compare) {
  const head = wrapRow(ui, [subheading(ui, compare.title), footnote(ui, compare.hint.graphical)]);
  if (compare.unavailable) return [head, ui.muted(compare.unavailable, { wrap: 'wrap' })];
  const records = compare.rows.map((row) => ({
    label: ui.text(row.label, { wrap: 'truncate-end', ...(row.strong ? { weight: 'semibold' } : {}) }),
    bar: ui.meter({ value: row.fill, tone: row.tone, text: row.cost }),
    cost: figure(ui, row.cost),
    diff: row.diff ? toned(ui, row.diff) : '',
  }));
  return [
    head,
    ui.table(columnsOf(WHAT_IF, compare.columns, compare.labels), records),
    footnote(ui, compare.note.graphical),
  ];
}

function insightsCard(ui, insights) {
  const button = (b) => (b ? ui.Button({ key: b.key, label: b.label, onPress: b.press }) : null);
  return ui.section(
    insights.title,
    { hint: insights.hint.graphical },
    insights.items.map((item) =>
      item.kind === 'switch'
        ? wrapRow(ui, [ui.text(item.graphical, { wrap: 'wrap' }), button(item.button)])
        : wrapRow(
            ui,
            [
              item.activity ? ui.text(item.activity, { color: ui.color('activity') }) : null,
              item.activity ? ui.muted('·') : null,
              ...(item.tier
                ? [ui.tierMeter(item.tier, 'lit', { inButton: true }), ui.text(item.tierLabel)]
                : [ui.muted(item.notRouted.graphical)]),
              ui.text(item.text, { wrap: 'wrap' }),
              item.route ? ui.muted(item.route, { wrap: 'wrap' }) : null,
              button(item.button),
            ].filter(Boolean),
          ),
    ),
  );
}

// Every agent by model, what the router moved and how routing paid off; then the routed types and the pass-throughs,
// each opening to its models.
function agentsCard(ui, agents) {
  if (agents.empty)
    return ui.section(
      agents.title,
      { hint: agents.hint },
      [
        ui.text(agents.empty.graphical, { wrap: 'wrap' }),
        agents.undated ? footnote(ui, agents.undated.graphical) : null,
        agents.older ? footnote(ui, agents.older) : null,
      ].filter(Boolean),
    );
  const { summary } = agents;
  const group = (one) => {
    const records = one.rows.flatMap((row) => [
      {
        name: ui.Box({
          flexDirection: 'row',
          alignItems: 'center',
          gap: 'xs',
          children: [chevron(ui, row), ui.text(row.name.graphical, { wrap: 'truncate-end' })],
        }),
        squares: ui.Box({
          flexDirection: 'row',
          alignItems: 'center',
          gap: 'xs',
          children: [
            squares(ui, row.squares, row.alt),
            row.squares.rest ? footnote(ui, row.squares.rest) : null,
          ].filter(Boolean),
        }),
        agents: figure(ui, row.agents),
        cost: toned(ui, row.cost),
        pick: row.pick ? toned(ui, row.pick) : '',
      },
      // Why Claude Code picked a pass-through's model, under its row.
      ...(row.why ? [{ span: indented(ui, [footnote(ui, row.why.graphical)]) }] : []),
      ...row.children.map((child) => ({
        name: indented(ui, [ui.text(child.name, { color: ui.color(child.tone), wrap: 'truncate-end' })]),
        squares: ui.muted(child.detail),
        agents: '',
        cost: toned(ui, child.cost),
        pick: child.pick ? toned(ui, child.pick) : '',
      })),
      ...(row.notes ? [{ span: indented(ui, [footnote(ui, row.notes.graphical)]) }] : []),
    ]);
    return ui.Box({
      flexDirection: 'column',
      gap: 'xs',
      children: [
        wrapRow(ui, [subheading(ui, one.title), footnote(ui, one.hint.graphical)]),
        ui.table(columnsOf(AGENTS, agents.columns, one.labels), records),
      ],
    });
  };
  return ui.section(
    agents.title,
    { hint: agents.hint },
    [
      wrapRow(
        ui,
        [
          squares(ui, summary.strip, summary.alt),
          ...summary.names.map((name) => ui.text(name.graphical, { tabular: true, color: ui.color(name.tone) })),
        ],
        { gap: 'md' },
      ),
      wrapRow(ui, [ui.muted(summary.total), ui.muted(summary.moved.graphical), ui.muted(summary.kept.graphical)], {
        gap: 'md',
      }),
      summary.verdict
        ? summary.verdict.priced
          ? ui.text(summary.verdict.graphical, { tabular: true, wrap: 'wrap', color: ui.color(summary.verdict.tone) })
          : ui.muted(summary.verdict.graphical, { wrap: 'wrap' })
        : null,
      agents.trend
        ? ui.Box({
            flexDirection: 'column',
            gap: 'xs',
            children: [
              subheading(ui, agents.trend.title),
              ui.trend(agents.trend.chart),
              footnote(ui, agents.trend.peak.graphical),
            ],
          })
        : null,
      agents.undated ? footnote(ui, agents.undated.graphical) : null,
      ...agents.groups.map(group),
      ...agents.legend.map((one) => footnote(ui, one.graphical)),
    ].filter(Boolean),
  );
}

// Delete history alone on its row; pressed, the question with Delete and Keep.
function deleteRow(ui, del) {
  if (!del.confirming)
    return wrapRow(ui, [ui.Button({ key: del.ask.key, label: del.ask.label, onPress: del.ask.press })]);
  return wrapRow(ui, [
    ui.text(del.question, { color: ui.color('warning'), wrap: 'wrap' }),
    ui.Button({ key: del.yes.key, label: del.yes.label, variant: 'primary', onPress: del.yes.press }),
    ui.Button({ key: del.no.key, label: del.no.label, onPress: del.no.press }),
  ]);
}
