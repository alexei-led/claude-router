// The Routes tab as cards for desktop, VS Code and mobile, drawn from the model `routesTab` builds: Routes (the
// activity-routing mode in its header, the tier × activity grid, its warnings and Reset), the selected cell's editor
// directly under it, and Prompt caches.
import { muted, tone } from './tone.mjs';

// The row-label column: "Default" and the longest activity name.
const ROW_LABEL = 12;
// The grid needs this many columns; a narrower pane, or one that reports no width, lists each row's tiers instead.
const WIDE = 80;

/**
 * @param {any} ui the graphical painter
 * @param {import('../model/routes.mjs').RoutesModel} model
 * @param {{ columns: number | null }} opts
 */
export function graphicalRoutes(ui, model, { columns }) {
  return [
    ui.Box({
      flexDirection: 'column',
      gap: 'lg',
      children: [
        routesCard(ui, model, columns),
        model.editor ? editorCard(ui, model.editor, model.unsaved) : null,
        ui.section('Prompt caches', {}, [muted(ui, ui.say(model.cache.text), { wrap: 'wrap' })]),
      ].filter(Boolean),
    }),
  ];
}

/**
 * @param {any} ui
 * @param {import('../model/routes.mjs').RouteMark} mark
 */
const markText = (ui, mark) => ui.text(mark.card ?? mark.glyph, { color: tone(mark.tone) });

/**
 * @param {any} ui
 * @param {import('../model/routes.mjs').RoutesModel} model
 * @param {number | null} columns
 */
function routesCard(ui, model, columns) {
  const wide = Number.isFinite(columns) && columns >= WIDE;
  const { Box } = ui;
  const { mode, overrides } = model;
  const control = Box({
    flexDirection: 'row',
    alignItems: 'center',
    gap: 'xs',
    flexShrink: 0,
    children: [
      ui.Select
        ? ui.Select({
            key: 'activity-mode',
            label: mode.label,
            value: mode.value,
            options: mode.options.map((option) => ({ value: option.value, label: ui.say(option.label) })),
            onSelect: mode.pick,
          })
        : muted(ui, ui.say(mode.text)),
      mode.changed ? markText(ui, model.unsaved) : null,
    ].filter(Boolean),
  });
  return ui.section('Routes', { hint: ui.say(mode.hint), action: control }, [
    overrides
      ? Box({
          flexDirection: 'row',
          flexWrap: 'wrap',
          gap: 'xs',
          children: [
            ui.text(overrides.text, { color: tone(overrides.warning ? 'warning' : 'muted') }),
            overrides.after ? muted(ui, `· ${overrides.after}`) : null,
          ].filter(Boolean),
        })
      : null,
    Box({
      key: 'routes-grid',
      flexDirection: 'column',
      gap: wide ? 'xs' : 'sm',
      children: wide ? gridRows(ui, model) : listRows(ui, model),
    }),
    ...model.steps.map((step) => ui.notice('warning', ui.say(step))),
    Box({
      flexDirection: 'row',
      alignItems: 'flex-start',
      justifyContent: 'space-between',
      gap: 'md',
      children: [
        Box({
          flexDirection: 'column',
          gap: 'xs',
          flexShrink: 1,
          children: [
            muted(ui, model.legend.map((mark) => `${mark.card ?? mark.glyph} ${mark.text}`).join(' · '), {
              size: 'footnote',
              wrap: 'wrap',
            }),
            model.hint ? muted(ui, model.hint, { size: 'footnote', wrap: 'wrap' }) : null,
            muted(ui, model.note, { size: 'footnote', wrap: 'wrap' }),
          ].filter(Boolean),
        }),
        Box({
          flexShrink: 0,
          children: [
            ui.Button({ key: 'reset-routes', label: model.reset.label, hotkey: 'r', onPress: model.reset.press }),
          ],
        }),
      ],
    }),
  ]);
}

/**
 * @param {any} ui
 * @param {import('../model/routes.mjs').GridCell} cell
 * @param {object | null} icon
 */
// A cell's Button: its route (a muted dash where it runs the tier's model), then its marks; the selected cell is
// primary. `icon` leads it where no header names the tier.
const cellButton = (ui, cell, icon = null) =>
  ui.Button({
    key: cell.key,
    variant: cell.selected ? 'primary' : 'secondary',
    onPress: cell.press,
    children: [
      icon,
      ui.text(cell.label, {
        wrap: 'truncate-end',
        tabular: true,
        ...(cell.muted ? { color: tone('muted') } : {}),
      }),
      ...cell.marks.map((mark) => markText(ui, mark)),
    ].filter(Boolean),
  });

/**
 * @param {any} ui
 * @param {import('../model/routes.mjs').GridRow} row
 */
// The tier routes' row in the heavier weight, an activity in its colour; wrapped, never cut.
const rowLabel = (ui, row) =>
  row.kind === 'tier'
    ? ui.text(ui.say(row.label), { weight: 'semibold', wrap: 'wrap' })
    : ui.text(row.label, { color: tone('activity'), wrap: 'wrap' });

/**
 * @param {any} ui
 * @param {import('../model/routes.mjs').RoutesModel} model
 */
// The grid: a header of the tiers, then a row per tier route and activity, each a fixed label column and one equal
// column per tier.
function gridRows(ui, model) {
  const { Box } = ui;
  const share = `${100 / model.tiers.length}%`;
  const row = (key, label, columns) =>
    Box({
      key,
      flexDirection: 'row',
      flexWrap: 'nowrap',
      alignItems: 'center',
      children: [
        Box({ width: ROW_LABEL, flexShrink: 0, children: label ? [label] : [] }),
        Box({
          flexDirection: 'row',
          flexWrap: 'nowrap',
          flexGrow: 1,
          flexShrink: 1,
          children: columns.map((children) =>
            Box({ width: share, flexShrink: 1, overflow: 'hidden', paddingRight: 'xs', children }),
          ),
        }),
      ],
    });
  return [
    row(
      'grid-head',
      null,
      model.tiers.map(({ id: tier, label }) => [
        Box({
          flexDirection: 'row',
          alignItems: 'center',
          gap: 'xs',
          children: [
            Box({ flexShrink: 0, children: [ui.tierMeter(tier, 'lit')] }),
            ui.text(ui.say(label), {
              size: 'footnote',
              weight: 'semibold',
              color: tone(`tier:${tier}`),
              wrap: 'truncate-end',
            }),
          ],
        }),
      ]),
    ),
    ...model.rows.map((one) =>
      row(
        `grid-${one.id}`,
        rowLabel(ui, one),
        one.cells.map((cell) => [cellButton(ui, cell)]),
      ),
    ),
  ];
}

/**
 * @param {any} ui
 * @param {import('../model/routes.mjs').RoutesModel} model
 */
// A narrow pane: each row is its label over its tiers' Buttons, wrapped, each Button led by its tier's bars.
function listRows(ui, model) {
  const { Box } = ui;
  return model.rows.map((one) =>
    Box({
      key: `grid-${one.id}`,
      flexDirection: 'column',
      gap: 'xs',
      children: [
        rowLabel(ui, one),
        Box({
          flexDirection: 'row',
          flexWrap: 'wrap',
          gap: 'xs',
          children: one.cells.map((cell) => cellButton(ui, cell, ui.tierMeter(cell.tier, 'lit', { inButton: true }))),
        }),
      ],
    }),
  );
}

/**
 * @param {any} ui
 * @param {import('../model/routes.mjs').RouteEditor} editor
 * @param {import('../model/routes.mjs').RouteMark} unsaved
 */
// The selected cell's editor: its model and effort, then its prices or its state and the ways back, then its warnings.
function editorCard(ui, editor, unsaved) {
  const { Box } = ui;
  const { key, model, effort } = editor.choices;
  const select = (id, choice) =>
    ui.Select
      ? ui.Select({ key: `${key}-${id}`, value: choice.value, options: choice.options, onSelect: choice.pick })
      : null;
  const children = [
    ui.field('Model', [select('model', model) ?? model.name, editor.changed ? markText(ui, unsaved) : null]),
    ui.field('Effort', [effort ? (select('effort', effort) ?? effort.text) : muted(ui, 'none')]),
  ];
  if (editor.kind === 'tier') {
    children.push(muted(ui, editor.rates.graphical, { tabular: true, wrap: 'wrap' }));
  } else {
    const { remove, restore } = editor;
    children.push(muted(ui, ui.say(editor.state)));
    if (remove || restore)
      children.push(
        Box({
          flexDirection: 'row',
          flexWrap: 'wrap',
          alignItems: 'center',
          gap: 'sm',
          children: [
            remove ? ui.Button({ key: remove.key, label: remove.label.graphical, onPress: remove.press }) : null,
            remove ? muted(ui, remove.note, { size: 'footnote' }) : null,
            restore ? ui.Button({ key: restore.key, label: restore.label, onPress: restore.press }) : null,
          ].filter(Boolean),
        }),
      );
    children.push(...editor.warnings.map((warning) => ui.notice('warning', ui.say(warning))));
  }
  return ui.section(editor.title, {}, children);
}
