// The Policy tab as a form for desktop, VS Code and mobile, drawn from the model `policyTab` builds: one card per
// group (Routing mode, Switching down, Switching up, Activities, Credits), each field its label, its Select and one
// muted help line; then Reset on its own row, the settings file in its own card, and the subagent line.
import { muted, tone } from './tone.mjs';

// A Select over the control's options in a card's words, or its value as text on a surface without Select.
export const select = (ui, control) =>
  ui.Select
    ? ui.Select({
        key: control.key,
        value: control.value,
        options: control.options.map(({ value, title }) => ({ value, label: title })),
        onSelect: control.pick,
      })
    : control.title;

/**
 * @param {any} ui the graphical painter
 * @param {any} model the Policy model (panel.mjs policyOf)
 */
export function graphicalPolicy(ui, model) {
  const { Box } = ui;
  const field = (one) =>
    ui.field(
      one.label,
      [
        select(ui, one.control),
        one.changed ? ui.text(model.unsaved.glyph, { color: tone(model.unsaved.tone) }) : null,
        one.default ? muted(ui, one.default.graphical) : null,
      ],
      { help: one.help },
    );
  const { file } = model;
  return [
    Box({
      flexDirection: 'column',
      gap: 'lg',
      children: [
        ...model.groups.map((group) =>
          ui.section(group.title, {}, [
            ...group.fields.map(field),
            ...group.warnings.map((warning) => ui.notice('warning', warning)),
            ...group.notes.map((note) => muted(ui, note, { wrap: 'wrap' })),
          ]),
        ),
        Box({
          flexDirection: 'row',
          children: [ui.Button({ key: 'reset-policy', label: model.reset.label, onPress: model.reset.press })],
        }),
        ui.section(file.title, {}, [
          Box({
            flexDirection: 'row',
            flexWrap: 'wrap',
            alignItems: 'center',
            gap: 'sm',
            children: [
              muted(ui, file.path, { wrap: 'wrap' }),
              file.copy
                ? ui.Button({ key: 'copy-path', label: file.copy.label.graphical, onPress: file.copy.press })
                : null,
            ].filter(Boolean),
          }),
          muted(ui, model.subagents.label, { size: 'footnote', wrap: 'wrap' }),
        ]),
      ],
    }),
  ];
}
