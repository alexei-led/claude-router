// The Classifier tab as cards for desktop, VS Code and mobile, drawn from the model `classifierTab` builds: the active
// classifier's card (its status, readings, deadline, wait, agreement, health and credentials), the others as compact
// rows in one card, then Across sessions.
import { select } from './policy.mjs';

// A compact row's fixed columns: the longest label ("Clef Flash") and status ("No account ID"), with room.
const NAME = 14;
const STATUS = 16;
// A pane narrower than this, or one that reports no width, puts a compact row's detail and Buttons on a second line.
const NARROW = 80;

// A reading: its label and its value in its tone.
const reading = (ui, one) =>
  ui.field(one.label, [ui.text(one.value, { color: ui.color(one.tone ?? 'primary'), tabular: true, wrap: 'wrap' })], {
    help: one.help,
  });

/**
 * @param {any} ui the graphical painter
 * @param {import('../model/classifier.mjs').ClassifierModel} model
 * @param {{ columns: number | null }} opts
 */
export function graphicalClassifier(ui, model, { columns }) {
  const { Box } = ui;
  const narrow = !Number.isFinite(columns) || columns < NARROW;
  return [
    Box({
      flexDirection: 'column',
      gap: 'lg',
      children: [
        classifierCard(ui, model.current, model.active),
        model.others
          ? ui.section(
              model.others.title,
              {},
              model.others.rows.map((row) => compactRow(ui, row, narrow)),
            )
          : null,
        ui.muted(ui.say(model.probeNote), { size: 'footnote', wrap: 'wrap' }),
        model.store
          ? ui.section(model.store.title, { hint: model.store.hint }, [
              ...model.store.rows.map((row) => reading(ui, row)),
              model.store.unpriced ? ui.muted(model.store.unpriced, { size: 'footnote', wrap: 'wrap' }) : null,
            ])
          : null,
      ].filter(Boolean),
    }),
  ];
}

/**
 * @param {any} ui
 * @param {import('../model/classifier.mjs').ClassifierRow} row
 * @param {import('../model/classifier.mjs').ClassifierModel['active']} active
 */
// The header's action: the active mark under the classifier's key.
function activeMark(ui, row, active) {
  return ui.Box({
    key: row.key,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 'xs',
    flexShrink: 0,
    children: [
      ui.text(active.mark.glyph, { color: ui.color(active.mark.tone) }),
      ui.text(active.mark.text, { size: 'footnote', weight: 'semibold', color: ui.color(active.mark.tone) }),
    ],
  });
}

/**
 * @param {any} ui
 * @param {import('../model/classifier.mjs').ClassifierRow} row
 * @param {import('../model/classifier.mjs').ClassifierModel['active']} active
 */
// The active classifier's full card.
function classifierCard(ui, row, active) {
  const { Box } = ui;
  const { credentials } = row;
  return ui.section(row.label, { action: activeMark(ui, row, active) }, [
    ui.text(row.status.text, { color: ui.color(row.status.tone), wrap: 'wrap' }),
    ...row.readings.map((one) => reading(ui, one)),
    ui.field(active.deadline.label, [select(ui, active.deadline.control)], { help: ui.say(active.deadline.help) }),
    ...active.readings.map((one) => reading(ui, one)),
    ui.field(active.sends.label, [ui.say(active.sends.text)], { help: ui.say(active.sends.help) }),
    reading(ui, { label: active.health.label, value: active.health.value, tone: active.health.tone }),
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
            credentials.note ? ui.muted(credentials.note, { size: 'footnote', wrap: 'wrap' }) : null,
          ].filter(Boolean),
        })
      : null,
  ]);
}

/**
 * @param {any} ui
 * @param {import('../model/classifier.mjs').ClassifierRow} row
 * @param {boolean} narrow
 */
// A classifier not in use, on one row: its name, its status, where its prompt goes with its probe result, then Set up
// where it lacks credentials and Use, right-aligned. A narrow pane puts the detail and Buttons on a second line.
function compactRow(ui, row, narrow) {
  const { Box } = ui;
  const name = Box({
    width: NAME,
    flexShrink: 0,
    children: [ui.text(row.label, { weight: 'semibold', wrap: 'truncate-end' })],
  });
  const status = Box({
    width: STATUS,
    flexShrink: 0,
    children: [ui.text(row.compact.status.text, { color: ui.color(row.compact.status.tone), wrap: 'truncate-end' })],
  });
  const detail = Box({
    flexGrow: 1,
    flexShrink: 1,
    overflow: 'hidden',
    children: [ui.muted(row.compact.detail, { tabular: true })],
  });
  const buttons = Box({
    flexDirection: 'row',
    alignItems: 'center',
    gap: 'xs',
    flexShrink: 0,
    children: [
      row.setup ? ui.Button({ key: row.setup.key, label: row.setup.label, onPress: row.setup.press }) : null,
      ui.Button({ key: row.key, label: row.use.label, onPress: row.press }),
    ].filter(Boolean),
  });
  const line = (extra, children) =>
    Box({ ...extra, flexDirection: 'row', flexWrap: 'nowrap', alignItems: 'center', gap: 'sm', children });
  const key = `row-${row.key}`;
  return narrow
    ? Box({
        key,
        flexDirection: 'column',
        gap: 'xs',
        children: [line({}, [name, status]), line({}, [detail, buttons])],
      })
    : line({ key }, [name, status, detail, buttons]);
}
