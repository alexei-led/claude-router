// The Classifier tab as terminal rows: one row per classifier to compare, then the active one's settings and
// readings, this session's agreement and the counts across sessions. Drawn from the model in
// ui/model/classifier.mjs.
import { toneColor } from '../tokens.mjs';
import { dimLines } from './wrap.mjs';

// The wide row's columns: the name, where the prompt goes, the probe and the p95 as fixed cells, then the status and
// Set up.
const CELLS = { name: 17, where: 21, probe: 8, p95: 10 };
const CELLS_WIDTH = Object.values(CELLS).reduce((sum, width) => sum + width, 0);
// A row's status as drawn: a missing credential leaves room for the Set up Button after it.
const stateText = (row) => (row.setup ? `${row.state.text}  ` : row.state.text);
// A Button is drawn as its label in `[ ` and ` ]`.
const wideRowWidth = (row) => CELLS_WIDTH + stateText(row).length + (row.setup ? row.setup.label.length + 4 : 0);

/**
 * Whether the Classifier rows are drawn on two lines each: with no width, or where the widest wide row does not fit.
 * No rows fit anywhere.
 * @param {{ state: { text: string }, setup: { label: string } | null }[]} rows
 * @param {number | null} columns
 */
export const classifierTwoLine = (rows, columns) =>
  !Number.isFinite(columns) || columns < rows.reduce((widest, row) => Math.max(widest, wideRowWidth(row)), 0);

/**
 * @param {any} ui the terminal kit
 * @param {import('../model/classifier.mjs').ClassifierModel} model
 * @param {{ columns: number | null }} opts
 */
export function terminalClassifier(ui, model, { columns }) {
  const { active } = model;
  const cells = CELLS;
  const twoLine = classifierTwoLine(model.rows, columns);
  const { wait, health, sends, credentials } = active;
  const rows = classifierRows(ui, model, twoLine);
  // The deadline and what is sent: in a narrow pane their help lines hang under the value, as Policy's do.
  const deadline = [
    ui.cell(12, ui.select(active.deadline.control)),
    wait.slow ? ui.text(wait.text, { color: ui.color('warning') }) : ui.dim(wait.text),
  ];
  const settings = twoLine
    ? [
        ui.field(12, active.deadline.label, [ui.line(...deadline), ui.help(ui.say(active.deadline.help))]),
        ui.field(12, sends.label, [ui.text(ui.say(sends.text), { wrap: 'wrap' }), ui.help(ui.say(sends.help))]),
      ]
    : [
        ui.line(ui.cell(12, active.deadline.label), ...deadline),
        ui.dim(`${''.padEnd(12)}${ui.say(active.deadline.help)}`),
        ui.line(ui.cell(12, sends.label), ui.say(sends.text)),
        ui.dim(`            ${ui.say(sends.help)}`),
      ];
  return [
    ui.line(ui.head('CLASSIFIER'), ui.dim(' · asked once per new turn · a pick saves at once')),
    twoLine
      ? null
      : ui.dim(
          `${''.padEnd(cells.name)}${'prompt goes to'.padEnd(cells.where)}${'probe'.padEnd(cells.probe)}${'p95'.padEnd(cells.p95)}status`,
        ),
    ...rows,
    ...dimLines(ui, `  ${ui.say(model.probeNote)}`, columns),
    ui.text(' '),
    ui.line(ui.head(active.label.toUpperCase()), ui.dim(' · active')),
    ...settings,
    ui.line(
      ui.cell(12, health.label),
      health.paused ? ui.text(health.paused, { color: ui.color('warning') }) : health.steady,
      ` · ${health.failures}`,
      health.last ? ui.dim(` · ${health.last}`) : null,
    ),
    ui.line(
      ui.cell(12, credentials.label),
      ui.Button({
        key: credentials.button.key,
        label: credentials.button.label,
        hotkey: credentials.button.hotkey,
        onPress: credentials.button.press,
      }),
      ui.dim(`  ${credentials.note}`),
    ),
    ...(active.session ? [ui.text(' '), ui.head(active.session.head), ui.text(active.session.text)] : []),
    ...(model.store
      ? [
          ui.text(' '),
          ui.head(model.store.head),
          ...model.store.rows.map((row) => ui.text(row.text)),
          ...(model.store.unpriced ? [ui.text(model.store.unpriced)] : []),
        ]
      : []),
  ];
}

/**
 * The classifiers. Wide: one row of columns to compare. Narrow: the name, its status (cut, never wrapped, where the
 * pane is too narrow for it; its mark stays) and Set up, which keeps its width, then where the prompt goes and the
 * probe result under the name.
 * @param {any} ui the terminal kit
 * @param {any} model the Classifier model (ui/model/classifier.mjs)
 */
function classifierRows(ui, model, twoLine) {
  const cells = CELLS;
  const name = (row) =>
    ui.cell(
      cells.name,
      ui.Button({
        key: row.key,
        label: `${row.active ? '◉' : '○'} ${row.label.padEnd(10)}`,
        variant: row.active ? 'primary' : 'secondary',
        onPress: row.press,
      }),
    );
  const state = (row, style = {}) =>
    ui.text(stateText(row), { color: toneColor(row.state.tone, 'terminal'), ...style });
  const setup = (row) =>
    row.setup ? ui.Button({ key: row.setup.key, label: row.setup.label, onPress: row.setup.press }) : null;
  return twoLine
    ? model.rows.map((row) =>
        ui.Box({
          flexDirection: 'column',
          children: [
            ui.line(
              name(row),
              ui.Box({ flexShrink: 1, minWidth: 2, children: [state(row, { wrap: 'truncate-end' })] }),
              row.setup ? ui.Box({ flexShrink: 0, children: [setup(row)] }) : null,
            ),
            ui.dim(`    ${row.narrowDetail}`),
          ],
        }),
      )
    : model.rows.map((row) =>
        ui.line(
          name(row),
          ui.cell(
            cells.where,
            row.where.local ? ui.text(row.where.text, { color: ui.color('success') }) : ui.dim(row.where.text),
          ),
          ui.cell(cells.probe, row.probe ?? ui.dim('—')),
          ui.cell(cells.p95, row.p95 ?? ui.dim('—')),
          state(row),
          setup(row),
        ),
      );
}
