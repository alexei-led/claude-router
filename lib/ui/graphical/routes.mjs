// The Routes tab as cards for desktop, VS Code and mobile, drawn from the model in ui/model/routes.mjs: Routes (the
// activity-routing mode in its header, the tier × activity grid, its warnings and Reset), the selected cell's editor
// directly under it, and Prompt caches.
import { isFiniteNumber } from '../tokens.mjs';

// The row-label column: "Default" and the longest activity name.
const ROW_LABEL = 12;
// The grid needs this many columns; a narrower pane, or one that reports no width, lists each row's tiers instead.
const WIDE = 80;

/**
 * @param {any} ui the graphical kit
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
        model.fallbacks ? fallbacksCard(ui, model.fallbacks) : null,
        ui.section('Prompt caches', {}, [ui.muted(ui.say(model.cache.text), { wrap: 'wrap' })]),
      ].filter(Boolean),
    }),
  ];
}

/**
 * @param {any} ui
 * @param {import('../model/routes.mjs').RouteMark} mark
 */
const markText = (ui, mark) => ui.text(mark.card ?? mark.glyph, { color: ui.color(mark.tone) });

/**
 * @param {any} ui
 * @param {import('../model/routes.mjs').RoutesModel} model
 * @param {number | null} columns
 */
function routesCard(ui, model, columns) {
  const wide = isFiniteNumber(columns) && columns >= WIDE;
  const { Box } = ui;
  const { mode, overrides } = model;
  const control = Box({
    flexDirection: 'row',
    alignItems: 'center',
    gap: 'xs',
    flexShrink: 0,
    children: [
      ui.Select({
        key: 'activity-mode',
        label: mode.label,
        value: mode.value,
        options: mode.options.map((option) => ({ value: option.value, label: ui.say(option.label) })),
        onSelect: mode.pick,
      }),
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
            ui.text(overrides.text, { color: ui.color(overrides.warning ? 'warning' : 'muted') }),
            overrides.after ? ui.muted(`· ${overrides.after}`) : null,
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
            ui.muted(model.legend.map((mark) => `${mark.card ?? mark.glyph} ${mark.text}`).join(' · '), {
              size: 'footnote',
              wrap: 'wrap',
            }),
            model.hint ? ui.muted(model.hint, { size: 'footnote', wrap: 'wrap' }) : null,
            ui.muted(model.note, { size: 'footnote', wrap: 'wrap' }),
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
        ...(cell.muted ? { color: ui.color('muted') } : {}),
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
    : ui.text(row.label, { color: ui.color('activity'), wrap: 'wrap' });

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
              color: ui.color(`tier:${tier}`),
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
 * @param {import('../model/routes.mjs').FallbacksModel} fallbacks
 */
// Fallbacks: a card with a row per model that has a chain: its status, then its targets in the order they are tried, a
// held one ✕ and the one standing in ◀ runs. Read-only.
function fallbacksCard(ui, fallbacks) {
  const { Box } = ui;
  return ui.section(
    'Fallbacks',
    { hint: ui.say(fallbacks.note) },
    fallbacks.rows.map((row) =>
      Box({
        flexDirection: 'column',
        gap: 'xs',
        children: [
          Box({
            flexDirection: 'row',
            flexWrap: 'wrap',
            alignItems: 'center',
            gap: 'sm',
            children: [
              ui.text(row.model, { weight: 'semibold' }),
              ui.text(row.status.text, { color: ui.color(row.status.tone), wrap: 'wrap' }),
            ],
          }),
          Box({
            flexDirection: 'row',
            flexWrap: 'wrap',
            alignItems: 'center',
            gap: 'sm',
            children: row.targets.map((target, index) =>
              ui.text(`${index + 1} ${target.label}${target.held ? ' ✕' : ''}${target.runs ? ' ◀ runs' : ''}`, {
                color: ui.color(target.runs ? 'accent' : target.held ? 'warning' : 'primary'),
                tabular: true,
              }),
            ),
          }),
        ],
      }),
    ),
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
    ui.Select({ key: `${key}-${id}`, value: choice.value, options: choice.options, onSelect: choice.pick });
  const children = [
    ui.field('Model', [select('model', model), editor.changed ? markText(ui, unsaved) : null]),
    ui.field('Effort', [effort ? select('effort', effort) : ui.muted('none')]),
  ];
  if (editor.kind === 'tier') {
    children.push(ui.muted(editor.rates.graphical, { tabular: true, wrap: 'wrap' }));
  } else {
    const { remove, restore } = editor;
    children.push(ui.muted(ui.say(editor.state)));
    if (remove || restore)
      children.push(
        Box({
          flexDirection: 'row',
          flexWrap: 'wrap',
          alignItems: 'center',
          gap: 'sm',
          children: [
            remove ? ui.Button({ key: remove.key, label: remove.label.graphical, onPress: remove.press }) : null,
            remove ? ui.muted(remove.note, { size: 'footnote' }) : null,
            restore ? ui.Button({ key: restore.key, label: restore.label, onPress: restore.press }) : null,
          ].filter(Boolean),
        }),
      );
    children.push(...editor.warnings.map((warning) => ui.notice('warning', ui.say(warning))));
  }
  return ui.section(editor.title, {}, children);
}
