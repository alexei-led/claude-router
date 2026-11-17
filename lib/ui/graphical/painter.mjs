// The painter for desktop, VS Code and mobile. It draws section, field, notice and choice natively, meter, strip and
// stat through charts.mjs;
// the rest (table and the line-drawing primitives the tab bodies still call) is the terminal kit's until each tab moves
// over, so a body not yet converted draws unchanged inside the new frame.
import { tierBars } from '../../display.mjs';
import { kit } from '../terminal/kit.mjs';

import { charts } from './charts.mjs';
import { tierMeter } from './meter.mjs';
import { tone } from './tone.mjs';

// The label column of a field: wide enough for the longest label, fixed so every row's control starts together.
const LABEL_WIDTH = 22;
// A figure on its own, with its unit: set in the mono face so digits line up. Ids and prose stay proportional.
const FIGURE = /^[~≈−+-]?\$?\d[\d.,]*(?:[KMB%]|\s?(?:ms|s|min|h|d))?$/;

/** @param {any} elements */
export function graphicalKit(elements) {
  const base = kit(elements);
  const { Box, Text, Button } = elements;
  const caption = (children, extra = {}) => Text({ size: 'footnote', color: tone('muted'), ...extra, children });
  const part = (one) =>
    typeof one === 'string' ? Text({ children: one, ...(FIGURE.test(one) ? { mono: true, tabular: true } : {}) }) : one;
  const row = (children, extra = {}) =>
    Box({ flexDirection: 'row', alignItems: 'center', gap: 'sm', ...extra, children: children.filter(Boolean) });
  return {
    ...base,
    ...charts(elements, { row, caption }),
    // Four rising bars as an Svg, lit to the tier, with its alt. Inside a Button, which holds only Text, the tier's
    // bars as glyphs in its colour.
    tierMeter: (name, state, /** @type {{ inButton?: boolean }} */ { inButton = false } = {}) =>
      inButton && name && state === 'lit'
        ? Text({ color: tone(`tier:${name}`), children: tierBars(name) })
        : tierMeter(elements, name, state),
    // A bordered card: a quiet footnote title with its hint and action beside it, then the children.
    section: (title, /** @type {{ hint?: string, action?: object }} */ { hint, action } = {}, children = []) =>
      Box({
        flexDirection: 'column',
        borderStyle: 'round',
        borderColor: tone('muted'),
        padding: 'md',
        gap: 'sm',
        flexShrink: 1,
        children: [
          row([
            Text({ size: 'footnote', weight: 'semibold', color: tone('muted'), wrap: 'truncate-end', children: title }),
            hint ? caption(hint, { wrap: 'truncate-end' }) : null,
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
        children: [Text({ children: label, wrap: 'truncate-end', ...(dim ? { color: tone('muted') } : {}) })],
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
    // A warning or note in its tone's colour with its action beside it. The terminal's two-space indent is dropped.
    notice: (name, message, action) =>
      row([Text({ color: tone(name), wrap: 'wrap', children: message.trim() }), action ?? null], { flexWrap: 'wrap' }),
    // A segmented row of Buttons, wrapping, the chosen ones primary. An option's own key and hotkey win over the
    // derived key, for controls that keep the key an earlier build gave them. An option with an icon draws it, its
    // label and its hint (muted) inside the Button; the icon may be a list of Text.
    choice: ({ key, options, selected, onPick }) => {
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
                    option.hint ? Text({ color: tone('muted'), tabular: true, children: option.hint }) : null,
                  ].filter(Boolean),
                }
              : { label: option.label }),
            ...(option.hotkey ? { hotkey: option.hotkey } : {}),
            variant: chosen.includes(option.value) ? 'primary' : 'secondary',
            onPress: () => onPick(option.value),
          }),
        ),
        { gap: 'xs', flexWrap: 'wrap' },
      );
    },
  };
}
