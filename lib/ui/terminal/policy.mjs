// The Policy tab as terminal rows: each control inside the sentence it completes, its unsaved mark and its default,
// its help under it in the same column, then Reset and the file. Drawn from the model `policyTab` builds (panel.mjs policyOf).
import { marker } from './routes.mjs';

// The label column.
const LABEL = 13;

/**
 * A field: its label in a fixed column, then its lines stacked in a column of their own, so a line that wraps in a
 * narrow pane stays inside that column instead of falling back to the pane's edge.
 * @param {any} ui the terminal painter
 * @param {number} width the label column's width
 * @param {any} label
 * @param {any[]} lines
 */
export const field = (ui, width, label, lines) =>
  ui.Box({
    children: [
      ui.cell(width, label),
      ui.Box({ flexDirection: 'column', flexGrow: 1, flexShrink: 1, children: lines.filter(Boolean) }),
    ],
  });

/**
 * A line of help under a control, wrapping inside its field's column.
 * @param {any} ui the terminal painter
 * @param {string} words
 * @param {object} [style] dim unless given
 */
export const help = (ui, words, style = { dimColor: true }) => ui.text(words, { ...style, wrap: 'wrap' });

// A Select over the control's options, or its value as text on a surface without Select.
export const select = (ui, control) =>
  ui.Select
    ? ui.Select({
        key: control.key,
        value: control.value,
        options: control.options.map(({ value, label }) => ({ value, label })),
        onSelect: control.pick,
      })
    : control.text;

/**
 * @param {any} ui the terminal painter
 * @param {any} model the Policy model (panel.mjs policyOf)
 */
export function terminalPolicy(ui, model) {
  const { mode, baseline, tune, unsaved, file } = model;
  const label = (words) => ui.text(words, { bold: true });
  // The control's unsaved mark and its default where the value differs.
  const note = (field) => [marker(ui, field.changed && unsaved), field.default ? ui.dim(field.default.terminal) : null];
  const control = (key) => select(ui, tune[key].control);
  return [
    ui.line(ui.head('POLICY'), ui.dim(' · how readily the router changes models · edit, then Save')),
    ui.text(' '),
    field(ui, LABEL, label('Mode'), [
      ui.line(select(ui, mode.control), ui.dim(`  ${mode.note}`)),
      help(ui, mode.hint),
      mode.session ? help(ui, mode.session, { color: 'yellow' }) : null,
    ]),
    field(ui, LABEL, label('Start'), [
      ui.line('at ', select(ui, baseline.control), ' ', ...note(baseline)),
      help(ui, baseline.hint),
    ]),
    field(ui, LABEL, label('Going down'), [
      ui.line('after ', control('downgradeVotes'), ' agreeing turns ', ...note(tune.downgradeVotes)),
      ui.line('if a cache write pays back within ', control('horizon'), ' ', ...note(tune.horizon)),
    ]),
    field(ui, LABEL, label('Going up'), [help(ui, model.up)]),
    field(ui, LABEL, label('Activities'), [
      ui.line('apply at ', control('activityMass'), ' certainty or more ', ...note(tune.activityMass)),
      help(ui, model.activitiesHint),
    ]),
    field(ui, LABEL, label('Credits'), [
      ui.line('cap one cold cache write at ', control('cashCapUsd'), ' ', ...note(tune.cashCapUsd)),
      help(ui, model.creditsHint),
    ]),
    ui.text(' '),
    ui.Button({ key: 'reset-policy', label: model.reset.label, onPress: model.reset.press }),
    ui.text(' '),
    ui.line(
      ui.head('FILE'),
      `  ${file.path}  `,
      file.copy ? ui.Button({ key: 'copy-path', label: file.copy.label.terminal, onPress: file.copy.press }) : null,
    ),
    ui.dim(model.subagents.text),
  ];
}
