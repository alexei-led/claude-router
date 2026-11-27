// What the graphical renderers draw with on desktop, VS Code and mobile: the element constructors, text and colour, and
// section, field, notice, choice and table natively; meter, strip, trend and stat through charts.mjs. Every surface
// that draws graphically has Svg, Select and Code (Elements['desktop' | 'vscode' | 'mobile']).
import { tierBars } from '../../display.mjs';
import { toneColor } from '../tokens.mjs';

import { charts } from './charts.mjs';
import { tierMeter } from './meter.mjs';

// The label column of a field: wide enough for the longest label, fixed so every row's control starts together.
export const LABEL_WIDTH = 22;
// A figure on its own, with its unit: set in the mono face so digits line up. Ids and prose stay proportional.
const FIGURE = /^[~≈−+-]?\$?\d[\d.,]*(?:[KMB%]|\s?(?:ms|s|min|h|d))?$/;

/** @param {string} name a tone */
const color = (name) => toneColor(/** @type {any} */ (name), 'graphical');

/** @param {any} elements */
export function graphicalKit(elements) {
  const { Box, Text, Button, Select, Svg, Code } = elements;
  const text = (children, style = {}) => Text({ ...style, children });
  const say = (words) => (typeof words === 'string' ? words : words.graphical);
  const caption = (children, extra = {}) => Text({ size: 'footnote', color: color('muted'), ...extra, children });
  const part = (one) =>
    typeof one === 'string' ? Text({ children: one, ...(FIGURE.test(one) ? { mono: true, tabular: true } : {}) }) : one;
  const row = (children, extra = {}) =>
    Box({ flexDirection: 'row', alignItems: 'center', gap: 'sm', ...extra, children: children.filter(Boolean) });
  return {
    Box,
    Button,
    Select,
    Svg,
    Code,
    text,
    say,
    // A tone's colour: a Claude Code theme key, or a mid-lightness hex where no key reads as the tone.
    color,
    // A Select over a control's options in a card's words.
    select: (control) =>
      Select({
        key: control.key,
        value: control.value,
        options: control.options.map(({ value, label }) => ({ value, label: say(label) })),
        onSelect: control.pick,
      }),
    // Muted secondary text, cut at the end unless `extra` says how it wraps.
    muted: (words, extra = {}) => Text({ color: color('muted'), wrap: 'truncate-end', ...extra, children: words }),
    ...charts(elements, { row, caption, color }),
    // Four rising bars as an Svg, lit to the tier, with its alt. Inside a Button, which holds only Text, the tier's
    // bars as glyphs in its colour.
    tierMeter: (name, state, /** @type {{ inButton?: boolean }} */ { inButton = false } = {}) =>
      inButton && name && state === 'lit'
        ? Text({ color: color(`tier:${name}`), children: tierBars(name) })
        : tierMeter(elements, name, state),
    // A bordered card: a quiet footnote title with its hint and action beside it, then the children.
    section: (title, /** @type {{ hint?: string, action?: object }} */ { hint, action } = {}, children = []) =>
      Box({
        flexDirection: 'column',
        borderStyle: 'round',
        borderColor: color('muted'),
        padding: 'md',
        gap: 'sm',
        flexShrink: 1,
        children: [
          row([
            Text({
              size: 'footnote',
              weight: 'semibold',
              color: color('muted'),
              wrap: 'truncate-end',
              children: title,
            }),
            hint ? caption(hint, { tabular: true, wrap: 'truncate-end' }) : null,
            action ?? null,
          ]),
          ...children,
        ],
      }),
    // A fixed label column, then the parts, with one caption line of help under them in the same column.
    field: (label, parts, /** @type {{ help?: string, dim?: boolean }} */ { help, dim = false } = {}) => {
      const labelCell = Box({
        width: LABEL_WIDTH,
        flexShrink: 0,
        children: [Text({ children: label, wrap: 'truncate-end', ...(dim ? { color: color('muted') } : {}) })],
      });
      const value = row(parts.filter((one) => one !== null && one !== '').map(part));
      return help
        ? Box({
            flexDirection: 'column',
            gap: 'xs',
            children: [row([labelCell, value]), row([Box({ width: LABEL_WIDTH, flexShrink: 0 }), caption(help)])],
          })
        : row([labelCell, value]);
    },
    // A warning or note in its tone's colour with its action beside it.
    notice: (name, message, action) =>
      row([Text({ color: color(name), wrap: 'wrap', children: message }), action ?? null], { flexWrap: 'wrap' }),
    // A segmented row of Buttons, wrapping, the chosen ones primary: see `choice`.
    choice: (spec) => choice({ Button, Text, row }, spec),
    // A header row of muted labels, then a row per record, every row's columns lined up: see `table`.
    table: (columns, rows) => table({ Box, row, caption, part }, columns, rows),
  };
}

// A header row of muted labels, then a row per record, every row's columns lined up: a column with a width keeps it, the
// others share what is left; a right-aligned column ends flush. A record with `span` is one full-width part under the
// rows before it, such as an open row's note.
function table({ Box, row, caption, part }, columns, rows) {
  const cell = (column, child) =>
    Box({
      ...(column.width ? { width: column.width, flexShrink: 0 } : { flexGrow: 1, flexShrink: 1, minWidth: 0 }),
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: column.align === 'right' ? 'flex-end' : 'flex-start',
      overflow: 'hidden',
      children: [child],
    });
  const line = (children) => row(children, { gap: 'md', flexWrap: 'nowrap' });
  return Box({
    flexDirection: 'column',
    gap: 'xs',
    children: [
      line(columns.map((column) => cell(column, caption(column.label, { wrap: 'truncate-end' })))),
      ...rows.map((record) =>
        record.span ? record.span : line(columns.map((column) => cell(column, part(record[column.key] ?? '')))),
      ),
    ],
  });
}

// A segmented row of Buttons, wrapping, the chosen ones primary. An option's own key and hotkey win over the derived key,
// for controls that keep the key an earlier build gave them. An option with an icon draws it, its label and its hint
// (muted) inside the Button; the icon may be a list of Text.
function choice({ Button, Text, row }, { key, options, selected, onPick, gap = 'xs' }) {
  const chosen = Array.isArray(selected) ? selected : [selected];
  return row(
    options.map((option) =>
      Button({
        key: option.key ?? `${key}-${option.value}`,
        ...(option.icon
          ? {
              children: [
                ...[option.icon].flat(),
                Text({ children: option.label }),
                option.hint ? Text({ color: color('muted'), tabular: true, children: option.hint }) : null,
              ].filter(Boolean),
            }
          : { label: option.label }),
        ...(option.hotkey ? { hotkey: option.hotkey } : {}),
        variant: chosen.includes(option.value) ? 'primary' : 'secondary',
        onPress: () => onPick(option.value),
      }),
    ),
    { gap, flexWrap: 'wrap' },
  );
}
