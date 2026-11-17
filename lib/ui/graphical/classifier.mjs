// The Classifier tab as cards for desktop, VS Code and mobile, drawn from the model `classifierTab` builds: one card
// per classifier (its status, readings and credentials; the active one marked, with its deadline, wait, agreement and
// health), then Across sessions.
import { select } from './policy.mjs';
import { muted, tone } from './tone.mjs';

// A reading: its label and its value in its tone.
const reading = (ui, one) =>
  ui.field(one.label, [ui.text(one.value, { color: tone(one.tone ?? 'primary'), tabular: true, wrap: 'wrap' })], {
    help: one.help,
  });

/**
 * @param {any} ui the graphical painter
 * @param {any} model the Classifier model (panel.mjs classifierOf)
 */
export function graphicalClassifier(ui, model) {
  const { Box } = ui;
  return [
    Box({
      flexDirection: 'column',
      gap: 'lg',
      children: [
        ...model.rows.map((row) => classifierCard(ui, row, model.active)),
        muted(ui, model.probeNote.graphical, { size: 'footnote', wrap: 'wrap' }),
        model.store
          ? ui.section(model.store.title, { hint: model.store.hint }, [
              ...model.store.rows.map((row) => reading(ui, row)),
              model.store.unpriced ? muted(ui, model.store.unpriced, { size: 'footnote', wrap: 'wrap' }) : null,
            ])
          : null,
      ].filter(Boolean),
    }),
  ];
}

// The header's action: the active mark under the classifier's key, or Use.
function headerAction(ui, row, active) {
  if (row.use) return ui.Button({ key: row.key, label: row.use.label, onPress: row.press });
  return ui.Box({
    key: row.key,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 'xs',
    flexShrink: 0,
    children: [
      ui.text(active.mark.glyph, { color: tone(active.mark.tone) }),
      ui.text(active.mark.text, { size: 'footnote', weight: 'semibold', color: tone(active.mark.tone) }),
    ],
  });
}

function classifierCard(ui, row, active) {
  const { Box } = ui;
  const { credentials } = row;
  const own = row.active
    ? [
        ui.field(active.deadline.label, [select(ui, active.deadline.control)], {
          help: active.deadline.help.graphical,
        }),
        ...active.readings.map((one) => reading(ui, one)),
        ui.field(active.sends.label, [active.sends.text.graphical], { help: active.sends.help.graphical }),
        reading(ui, { label: active.health.label, value: active.health.value, tone: active.health.tone }),
      ]
    : [];
  return ui.section(row.label, { action: headerAction(ui, row, active) }, [
    ui.text(row.status.text, { color: tone(row.status.tone), wrap: 'wrap' }),
    ...row.readings.map((one) => reading(ui, one)),
    ...own,
    credentials
      ? Box({
          flexDirection: 'row',
          flexWrap: 'wrap',
          alignItems: 'center',
          gap: 'sm',
          children: [
            ui.Button({
              key: credentials.key,
              label: credentials.label,
              ...(credentials.hotkey ? { hotkey: credentials.hotkey } : {}),
              onPress: credentials.press,
            }),
            credentials.note ? muted(ui, credentials.note, { size: 'footnote', wrap: 'wrap' }) : null,
          ].filter(Boolean),
        })
      : null,
  ]);
}
