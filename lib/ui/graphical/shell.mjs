// The frame the pane draws on desktop, VS Code and mobile: the title row (Router, the classifier's state, On | Off),
// the tab row, one notices slot, the body, and the save bar last. The body is whatever the tab draws, so a tab that has
// not moved to the graphical painter draws unchanged inside it.
import { tone } from './tone.mjs';

/**
 * @param {any} ui the surface's painter
 * @param {any} view
 * @param {string} tab the shown tab's id
 * @param {any} actions
 * @param {object[]} body the tab's elements
 * @param {{ tabs: string[][], unsaved: Record<string, boolean>, notices: object[], status: { tone: import('../tokens.mjs').Tone, text: string }, bar: object[] }} frame
 *   the tab ids with their hotkeys and labels, which tabs hold an unsaved draft, the warnings, the title's short
 *   state, and the save bar's rows
 */
export function renderShell(ui, view, tab, actions, body, { tabs, unsaved, notices, status, bar }) {
  const unavailable = view.phase === 'unavailable';
  const { Box, Button } = ui;
  const title = Box({
    flexDirection: 'row',
    flexWrap: 'nowrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 'md',
    children: [
      Box({
        flexShrink: 0,
        children: [ui.text('Router', { size: 'heading', weight: 'semibold' })],
      }),
      Box({
        flexDirection: 'row',
        alignItems: 'center',
        gap: 'xs',
        flexShrink: 1,
        overflow: 'hidden',
        children: [
          ui.text('●', { size: 'footnote', color: tone(status.tone) }),
          ui.text(status.text, { size: 'footnote', color: tone('muted'), wrap: 'truncate-end' }),
        ],
      }),
      // While routing is unavailable, on and off would change nothing: the status says why instead.
      unavailable
        ? null
        : ui.choice({
            key: 'power',
            options: [
              { value: 'auto', label: 'On', key: 'auto', hotkey: 'o' },
              { value: 'manual', label: 'Off', key: 'manual', hotkey: 'f' },
            ],
            selected: view.mode,
            onPick: actions.mode,
          }),
    ].filter(Boolean),
  });
  const tabRow = Box({
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 'sm',
    children: [
      ...tabs.map(([id, hotkey, label]) =>
        Button({
          key: `tab-${id}`,
          label: `${label}${unsaved[id] ? ' ●' : ''}`,
          hotkey,
          variant: tab === id ? 'primary' : 'secondary',
          onPress: () => actions.tab(id),
        }),
      ),
      Button({ key: 'help', label: '?', variant: view.help ? 'primary' : 'secondary', onPress: actions.help }),
    ],
  });
  return Box({
    flexDirection: 'column',
    gap: 'md',
    padding: 'md',
    children: [
      title,
      tabRow,
      notices.length ? Box({ key: 'notices', flexDirection: 'column', gap: 'xs', children: notices }) : null,
      Box({ key: 'body', flexDirection: 'column', children: body }),
      bar.length ? Box({ key: 'save-bar', flexDirection: 'column', gap: 'sm', children: bar }) : null,
    ].filter(Boolean),
  });
}
