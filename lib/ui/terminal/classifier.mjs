// The Classifier tab as terminal rows: one row per classifier to compare, then the active one's settings and
// readings, this session's agreement and the counts across sessions. Drawn from the model `classifierTab` builds
// (panel.mjs classifierOf).
import { toneColor } from '../tokens.mjs';
import { field, help, select } from './policy.mjs';
import { dimLines } from './wrap.mjs';

/**
 * @param {any} ui the terminal painter
 * @param {any} model the Classifier model (panel.mjs classifierOf)
 * @param {{ columns: number | null }} opts
 */
export function terminalClassifier(ui, model, { columns }) {
  const { active } = model;
  const { cells } = model.terminal;
  const { wait, health, sends, credentials } = active;
  const rows = classifierRows(ui, model);
  // The deadline and what is sent: in a narrow pane their help lines hang under the value, as Policy's do.
  const deadline = [
    ui.cell(12, select(ui, active.deadline.control)),
    wait.slow ? ui.text(wait.text, { color: 'yellow' }) : ui.dim(wait.text),
  ];
  const settings = model.terminal.twoLine
    ? [
        field(ui, 12, active.deadline.label, [ui.line(...deadline), help(ui, active.deadline.help.terminal)]),
        field(ui, 12, sends.label, [ui.text(sends.text.terminal, { wrap: 'wrap' }), help(ui, sends.help.terminal)]),
      ]
    : [
        ui.line(ui.cell(12, active.deadline.label), ...deadline),
        ui.dim(`${''.padEnd(12)}${active.deadline.help.terminal}`),
        ui.line(ui.cell(12, sends.label), sends.text.terminal),
        ui.dim(`            ${sends.help.terminal}`),
      ];
  return [
    ui.line(ui.head('CLASSIFIER'), ui.dim(' · asked once per new turn · a pick saves at once')),
    model.terminal.twoLine
      ? null
      : ui.dim(
          `${''.padEnd(cells.name)}${'prompt goes to'.padEnd(cells.where)}${'probe'.padEnd(cells.probe)}${'p95'.padEnd(cells.p95)}status`,
        ),
    ...rows,
    ...dimLines(ui, `  ${model.probeNote.terminal}`, columns),
    ui.text(' '),
    ui.line(ui.head(active.label.toUpperCase()), ui.dim(' · active')),
    ...settings,
    ui.line(
      ui.cell(12, health.label),
      health.paused ? ui.text(health.paused, { color: 'yellow' }) : health.steady,
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
 * @param {any} ui the terminal painter
 * @param {any} model the Classifier model (panel.mjs classifierOf)
 */
function classifierRows(ui, model) {
  const { cells } = model.terminal;
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
    ui.text(row.state.text, { color: toneColor(row.state.tone, 'terminal'), ...style });
  const setup = (row) =>
    row.setup ? ui.Button({ key: row.setup.key, label: row.setup.label, onPress: row.setup.press }) : null;
  return model.terminal.twoLine
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
          ui.cell(cells.where, row.where.local ? ui.text(row.where.text, { color: 'green' }) : ui.dim(row.where.text)),
          ui.cell(cells.probe, row.probe ?? ui.dim('—')),
          ui.cell(cells.p95, row.p95 ?? ui.dim('—')),
          state(row),
          setup(row),
        ),
      );
}
