import { isFiniteNumber } from '../tokens.mjs';
import { clip, dimLines } from './wrap.mjs';

// The grid's row-label column, and the editor's label column.
const GRID_LABEL = 13;
const EDITOR_LABEL = 22;
// The FALLBACKS model column, wide enough for a models key and the row's indent.
const FALLBACK_LABEL = 12;
const HEAD_HINT = ' · which model runs, by tier and activity · edit, then Save';
// Below this many columns the grid's efforts are cut short.
const NARROW = 80;
const EFFORT_SHORT = { low: 'low', medium: 'med', high: 'high', xhigh: 'xh', max: 'max', inherit: 'inh' };

// "sonnet·high": the model's key and its effort, short enough for the grid.
const gridText = ({ model, effort }, narrow) =>
  effort === null ? model : `${model}·${narrow ? (EFFORT_SHORT[effort] ?? effort) : effort}`;

/**
 * @param {any} ui the terminal kit
 * @param {import('../model/routes.mjs').RoutesModel} model
 * @param {{ columns: number | null }} opts
 */
export function terminalRoutes(ui, model, { columns }) {
  const { mode } = model;
  const narrow = isFiniteNumber(columns) && columns < NARROW;
  const width = isFiniteNumber(columns)
    ? Math.max(1, Math.min(narrow ? 14 : 16, Math.floor((columns - GRID_LABEL) / model.tiers.length)))
    : 16;
  const cellButton = (cell) =>
    ui.cell(
      width,
      ui.Button({
        key: cell.key,
        label: fitRouteCell(
          `${cell.selected ? '▸' : ' '}${cell.route ? gridText(cell.route, narrow) : model.inheritMark.glyph}`,
          cell.marks.map((mark) => mark.glyph).join(''),
          width,
        ),
        plain: true,
        ...(cell.muted ? { dimColor: true } : {}),
        onPress: cell.press,
      }),
    );
  const { overrides } = model;
  return [
    ui.line(ui.head('ROUTES'), ui.dim(HEAD_HINT)),
    ui.line(
      ui.cell(
        26,
        ui.Select
          ? ui.Select({
              key: 'activity-mode',
              label: mode.label,
              value: mode.value,
              options: mode.options.map((option) => ({ value: option.value, label: ui.say(option.label) })),
              onSelect: mode.pick,
            })
          : `${mode.label}: ${mode.value}`,
      ),
      ui.marker(mode.changed && model.unsaved),
      ui.dim(ui.say(mode.hint)),
    ),
    ...(overrides
      ? [
          ui.line(
            overrides.warning ? ui.text(overrides.text, { color: ui.color('warning') }) : ui.dim(overrides.text),
            overrides.after ? ui.dim(` · ${overrides.after}`) : null,
          ),
        ]
      : []),
    ui.text(' '),
    ui.line(
      ui.cell(GRID_LABEL, ''),
      ...model.tiers.map(({ id, label }) => ui.cell(width, ui.tier(id, fitRouteCell(` ${ui.say(label)}`, '', width)))),
    ),
    ...model.rows.map((row) =>
      ui.line(
        ui.cell(
          GRID_LABEL,
          row.kind === 'tier' ? ui.text(ui.say(row.label), { weight: 'semibold' }) : ui.activity(row.label),
        ),
        ...row.cells.map(cellButton),
      ),
    ),
    ui.dim(`  ${model.legend.map(({ glyph, text }) => `${glyph} ${text}`).join('   ')}`),
    ui.text(' '),
    ...(model.editor ? editorLines(ui, model.editor, model.unsaved) : [ui.dim(model.hint)]),
    ui.text(' '),
    ...(model.fallbacks ? [...fallbackLines(ui, model.fallbacks), ui.text(' ')] : []),
    ...(model.cache.wrap
      ? dimLines(ui, ui.say(model.cache.text), Math.min(columns ?? 78, 78))
      : [ui.dim(ui.say(model.cache.text))]),
    ...model.steps.map((step) => ui.text(`! ${ui.say(step)}`, { color: ui.color('warning') })),
    ui.Button({ key: 'reset-routes', label: model.reset.label, hotkey: 'r', onPress: model.reset.press }),
    ui.dim(model.note),
  ];
}

/**
 * @param {any} ui
 * @param {import('../model/routes.mjs').FallbacksModel} fallbacks
 */
// FALLBACKS: a model and its status, then its targets in the order they are tried: a held one ✕, the one standing in
// ◀ runs.
function fallbackLines(ui, fallbacks) {
  const pad = ''.padEnd(FALLBACK_LABEL);
  return [
    ui.line(ui.head('FALLBACKS'), ui.dim(`  ${ui.say(fallbacks.note)}`)),
    ...fallbacks.rows.flatMap((row) => [
      ui.line(
        ui.cell(FALLBACK_LABEL, ui.text(clip(`  ${row.model}`, FALLBACK_LABEL - 1), { weight: 'semibold' })),
        ui.text(row.status.text, { color: ui.color(row.status.tone) }),
      ),
      ui.line(
        pad,
        ...row.targets.flatMap((target, index) => [
          ui.dim(`${index ? '   ' : ''}${index + 1} `),
          ui.text(target.label, target.held ? { color: ui.color('muted'), dimColor: true } : {}),
          target.held ? ui.text(' ✕', { color: ui.color('warning') }) : null,
          target.runs ? ui.text(' ◀ runs', { color: ui.color('accent') }) : null,
        ]),
      ),
    ]),
  ];
}

// A label and its marks cut to their cell with an ellipsis, keeping the marks.
function fitRouteCell(text, mark, width) {
  const label = `${text}${mark}`;
  if (label.length <= width) return label;
  if (mark.length >= width) return mark.slice(-width);
  return `${label.slice(0, Math.max(0, width - 1 - mark.length))}…${mark}`;
}

/**
 * @param {any} ui
 * @param {import('../model/routes.mjs').RouteEditor['choices']} choices
 */
// A model Select and an effort Select for one route, or their values as text on a surface without Select.
function routeSelects(ui, { key, model, effort }) {
  return [
    ui.cell(
      14,
      ui.Select
        ? ui.Select({ key: `${key}-model`, value: model.value, options: model.options, onSelect: model.pick })
        : clip(model.name, 14),
    ),
    ui.cell(
      12,
      !effort
        ? ui.dim('none')
        : ui.Select
          ? ui.Select({ key: `${key}-effort`, value: effort.value, options: effort.options, onSelect: effort.pick })
          : clip(effort.text, 12),
    ),
  ];
}

/**
 * @param {any} ui
 * @param {import('../model/routes.mjs').RouteEditor} editor
 * @param {import('../model/routes.mjs').RouteMark} unsaved
 */
// The selected cell's editor: a tier's route and its prices, or an activity's cell with its state, the ways back and
// its warnings.
function editorLines(ui, editor, unsaved) {
  const pad = ''.padEnd(EDITOR_LABEL);
  if (editor.kind === 'tier') {
    return [
      ui.line(
        ui.cell(EDITOR_LABEL, ui.line(ui.tier(editor.tier), ui.dim(' · every turn'))),
        ...routeSelects(ui, editor.choices),
        ui.marker(editor.changed && unsaved),
      ),
      ui.dim(`${pad}${editor.rates.terminal}`),
    ];
  }
  const { remove, restore } = editor;
  return [
    ui.line(
      ui.cell(EDITOR_LABEL, ui.line(ui.activity(editor.activity), ' at ', ui.tier(editor.tier))),
      ...routeSelects(ui, editor.choices),
      ui.marker(editor.changed && unsaved),
    ),
    ui.line(ui.cell(EDITOR_LABEL, ''), ui.dim(ui.say(editor.state))),
    ...(remove || restore
      ? [
          ui.line(
            ui.cell(EDITOR_LABEL, ''),
            remove ? ui.Button({ key: remove.key, label: remove.label.terminal, onPress: remove.press }) : null,
            remove && restore ? ' ' : null,
            restore ? ui.Button({ key: restore.key, label: restore.label, onPress: restore.press }) : null,
          ),
        ]
      : []),
    ...editor.warnings.map((warning) => ui.text(`${pad}! ${ui.say(warning)}`, { color: ui.color('warning') })),
  ];
}
