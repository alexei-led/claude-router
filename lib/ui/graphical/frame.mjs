// The pane's own parts around a tab on desktop, VS Code and mobile, drawn from panel.mjs's models: the save bar (an
// Unsaved changes card with its table, then the last notice and Undo), the About the router card behind `?`, and the
// provider profile's footnote.
import { muted, tone } from './tone.mjs';

/**
 * The save bar's elements; none when nothing is unsaved, noticed or undoable.
 * @param {any} ui the graphical painter
 * @param {any} bar the save bar model (panel.mjs saveBarOf)
 */
export function graphicalSaveBar(ui, bar) {
  const { Box, Button } = ui;
  const out = [];
  if (bar.count) {
    const { columns } = bar;
    const table = bar.listed
      ? ui.table(
          [
            { key: 'label', label: columns.label },
            { key: 'before', label: columns.before },
            { key: 'after', label: columns.after },
          ],
          bar.rows.map((row) => ({
            label: row.label,
            before: muted(ui, row.before.graphical),
            after: ui.text(row.after.graphical, { color: tone('accent'), wrap: 'truncate-end' }),
          })),
        )
      : null;
    const buttons = Box({
      flexDirection: 'row',
      flexWrap: 'wrap',
      alignItems: 'center',
      gap: 'sm',
      children: [
        Button({
          key: bar.discard.key,
          label: bar.discard.label,
          hotkey: bar.discard.hotkey,
          variant: 'secondary',
          onPress: bar.discard.press,
        }),
        Button({
          key: bar.save.key,
          label: bar.save.label,
          hotkey: bar.save.hotkey,
          variant: 'primary',
          onPress: bar.save.press,
        }),
      ],
    });
    out.push(ui.section(bar.title, { hint: bar.hint }, [table, buttons].filter(Boolean)));
  }
  const { undo } = bar;
  const undoButton = undo
    ? Button({ key: undo.key, label: undo.label, hotkey: undo.hotkey, onPress: undo.press })
    : null;
  if (bar.notice) out.push(ui.notice(bar.notice.tone, bar.notice.text, undo?.confirms ? undoButton : null));
  if (undo && !undo.confirms) out.push(ui.notice('muted', undo.last.graphical, undoButton));
  return out;
}

/**
 * The About the router card: the help's sentences as wrapped text, the tier sentence with the tiers' meters.
 * @param {any} ui the graphical painter
 * @param {{ title: string, paragraphs: { text: string, tiers?: string[] }[] }} help
 */
export function graphicalHelp(ui, help) {
  const { Box } = ui;
  return ui.section(
    help.title,
    {},
    help.paragraphs.map((paragraph) =>
      paragraph.tiers
        ? Box({
            flexDirection: 'column',
            gap: 'xs',
            children: [
              ui.text(paragraph.text, { wrap: 'wrap' }),
              Box({
                flexDirection: 'row',
                alignItems: 'center',
                gap: 'sm',
                children: paragraph.tiers.map((tier) => ui.tierMeter(tier, 'lit')),
              }),
            ],
          })
        : ui.text(paragraph.text, { wrap: 'wrap' }),
    ),
  );
}

/**
 * The provider profile and its file as a muted footnote.
 * @param {any} ui the graphical painter
 * @param {{ graphical: string }} profile
 */
export const graphicalProfile = (ui, profile) => muted(ui, profile.graphical, { size: 'footnote' });
