// The Policy tab as terminal rows: each control inside the sentence it completes, its unsaved mark and its default,
// then Reset and the file. Drawn from the model `policyTab` builds (panel.mjs policyOf).
import { marker } from './routes.mjs';

// The label column.
const LABEL = 13;
const PAD = ''.padEnd(LABEL);

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
  const label = (words) => ui.cell(LABEL, ui.text(words, { bold: true }));
  // The control's unsaved mark and its default where the value differs.
  const note = (field) => [marker(ui, field.changed && unsaved), field.default ? ui.dim(field.default.terminal) : null];
  const control = (key) => select(ui, tune[key].control);
  return [
    ui.line(ui.head('POLICY'), ui.dim(' · how readily the router changes models · edit, then Save')),
    ui.text(' '),
    ui.line(label('Mode'), select(ui, mode.control), ui.dim(`  ${mode.note}`)),
    ui.dim(`${PAD}${mode.hint}`),
    mode.session ? ui.text(`${PAD}${mode.session}`, { color: 'yellow' }) : null,
    ui.line(label('Start'), 'at ', select(ui, baseline.control), ' ', ...note(baseline)),
    ui.dim(`${PAD}${baseline.hint}`),
    ui.line(label('Going down'), 'after ', control('downgradeVotes'), ' agreeing turns ', ...note(tune.downgradeVotes)),
    ui.line(PAD, 'if a cache write pays back within ', control('horizon'), ' ', ...note(tune.horizon)),
    ui.line(label('Going up'), ui.dim(model.up)),
    ui.line(
      label('Activities'),
      'apply at ',
      control('activityMass'),
      ' certainty or more ',
      ...note(tune.activityMass),
    ),
    ui.dim(`${PAD}${model.activitiesHint}`),
    ui.line(label('Credits'), 'cap one cold cache write at ', control('cashCapUsd'), ' ', ...note(tune.cashCapUsd)),
    ui.dim(`${PAD}${model.creditsHint}`),
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
