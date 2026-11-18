// The Policy tab as terminal rows: each control inside the sentence it completes, its unsaved mark and its default,
// its help under it in the same column, then Reset and the file. Drawn from the model in ui/model/policy.mjs.

// The label column.
const LABEL = 13;

/**
 * @param {any} ui the terminal kit
 * @param {import('../model/policy.mjs').PolicyModel} model
 */
export function terminalPolicy(ui, model) {
  const { mode, baseline, tune, unsaved, file } = model;
  const label = (words) => ui.text(words, { weight: 'semibold' });
  // The control's unsaved mark and its default where the value differs.
  const note = (field) => [ui.marker(field.changed && unsaved), field.default ? ui.dim(ui.say(field.default)) : null];
  const control = (key) => ui.select(tune[key].control);
  return [
    ui.line(ui.head('POLICY'), ui.dim(' · how readily the router changes models · edit, then Save')),
    ui.text(' '),
    ui.field(LABEL, label('Mode'), [
      ui.line(ui.select(mode.control), ui.dim(`  ${mode.note}`)),
      ui.help(ui.say(mode.hint)),
      mode.session ? ui.help(ui.say(mode.session), { color: ui.color('warning') }) : null,
    ]),
    ui.field(LABEL, label('Start'), [
      ui.line('at ', ui.select(baseline.control), ' ', ...note(baseline)),
      ui.help(ui.say(baseline.hint)),
    ]),
    ui.field(LABEL, label('Going down'), [
      ui.line('after ', control('downgradeVotes'), ' agreeing turns ', ...note(tune.downgradeVotes)),
      ui.line('if a cache write pays back within ', control('horizon'), ' ', ...note(tune.horizon)),
    ]),
    ui.field(LABEL, label('Going up'), [ui.help(ui.say(model.up))]),
    ui.field(LABEL, label('Activities'), [
      ui.line('apply at ', control('activityMass'), ' certainty or more ', ...note(tune.activityMass)),
      ui.help(model.activitiesHint),
    ]),
    ui.field(LABEL, label('Credits'), [
      ui.line('cap one cold cache write at ', control('cashCapUsd'), ' ', ...note(tune.cashCapUsd)),
      ui.help(model.creditsHint),
    ]),
    ui.text(' '),
    ui.Button({ key: 'reset-policy', label: model.reset.label, onPress: model.reset.press }),
    ui.text(' '),
    ui.line(
      ui.head('FILE'),
      `  ${file.path}  `,
      file.copy ? ui.Button({ key: 'copy-path', label: ui.say(file.copy.label), onPress: file.copy.press }) : null,
    ),
    ui.dim(ui.say(model.subagents)),
  ];
}
