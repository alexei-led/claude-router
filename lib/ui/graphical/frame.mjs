// The pane on desktop, VS Code and mobile, drawn from the models in ui/model/frame.mjs: the title row (Router, the
// classifier's state, On | Off), the tab row, one notices slot, the body, and the save bar last, which is an Unsaved
// changes card with its table, then the last notice and Undo. The About the router card behind `?` and the provider
// profile's footnote are in the body.

/**
 * The save bar's elements; none when nothing is unsaved, noticed or undoable.
 * @param {any} ui the graphical kit
 * @param {any} bar the save bar model (ui/model/frame.mjs saveBarOf)
 */
function graphicalSaveBar(ui, bar) {
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
            before: ui.muted(ui.say(row.before)),
            after: ui.text(ui.say(row.after), { color: ui.color('accent'), wrap: 'truncate-end' }),
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
  if (undo && !undo.confirms) out.push(ui.notice('muted', undo.last, undoButton));
  return out;
}

/**
 * The About the router card: the help's sentences as wrapped text, the tier sentence with the tiers' meters.
 * @param {any} ui the graphical kit
 * @param {{ title: string, paragraphs: { text: import('../model/format.mjs').Words, tiers?: string[] }[] }} help
 */
function graphicalHelp(ui, help) {
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
              ui.text(ui.say(paragraph.text), { wrap: 'wrap' }),
              Box({
                flexDirection: 'row',
                alignItems: 'center',
                gap: 'sm',
                children: paragraph.tiers.map((tier) => ui.tierMeter(tier, 'lit')),
              }),
            ],
          })
        : ui.text(ui.say(paragraph.text), { wrap: 'wrap' }),
    ),
  );
}

/**
 * The provider profile and its file as a muted footnote.
 * @param {any} ui the graphical kit
 * @param {import('../model/format.mjs').Words} profile
 */
const graphicalProfile = (ui, profile) => ui.muted(ui.say(profile), { size: 'footnote' });

/**
 * How to add a classifier's credentials where `/plugin configure` cannot open: a card with the sentence, the command
 * to copy (Code where the surface has it, else monospaced text), the alternative and the reload, then Copy command
 * and Done.
 * @param {any} ui the graphical kit
 * @param {any} help the key help model (ui/model/frame.mjs keyHelpCardOf)
 */
function graphicalKeyHelp(ui, help) {
  const { Box, Button, Code } = ui;
  return ui.section(help.title, {}, [
    ui.text(help.sentence, { wrap: 'wrap' }),
    Code ? Code({ source: help.command, language: 'bash' }) : ui.text(help.command, { mono: true, wrap: 'wrap' }),
    ui.muted(help.alternative, { wrap: 'wrap' }),
    help.note ? ui.muted(help.note, { wrap: 'wrap' }) : null,
    ui.muted(help.reload, { wrap: 'wrap' }),
    Box({
      flexDirection: 'row',
      gap: 'sm',
      children: [
        Button({ key: help.copy.key, label: help.copy.label, variant: 'primary', onPress: help.copy.press }),
        Button({ key: help.done.key, label: help.done.label, onPress: help.done.press }),
      ],
    }),
  ]);
}

/**
 * The pane on desktop, VS Code and mobile: the title row, the tab row, the warnings, the tab's cards, the save bar.
 * @param {any} ui the graphical kit
 * @param {ReturnType<typeof import('../model/frame.mjs').frameOf>} frame
 * @param {{ id: string, key: string, label: string }[]} tabs
 * @param {string} tab the shown tab's id
 * @param {any} actions
 * @param {object[]} content the tab's elements
 */
export function graphicalFrame(ui, frame, tabs, tab, actions, content) {
  const { status, unsaved } = frame;
  const { Box, Button } = ui;
  const notices = [
    ...(frame.keyHelp ? [graphicalKeyHelp(ui, frame.keyHelp)] : []),
    ...frame.notices.map((notice) =>
      ui.notice(
        notice.tone,
        notice.text,
        notice.action
          ? Button({
              key: notice.action.key,
              label: notice.action.label,
              hotkey: notice.action.hotkey,
              onPress: notice.action.press,
            })
          : null,
      ),
    ),
  ];
  const body = [
    ...(frame.help ? [graphicalHelp(ui, frame.help)] : []),
    ...(frame.profile ? [graphicalProfile(ui, frame.profile)] : []),
    ...content,
  ];
  const bar = graphicalSaveBar(ui, frame.bar);
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
          ui.text('●', { size: 'footnote', color: ui.color(status.tone) }),
          ui.text(status.text, { size: 'footnote', color: ui.color('muted'), wrap: 'truncate-end' }),
        ],
      }),
      // While routing is unavailable, on and off would change nothing: the status says why instead.
      frame.unavailable
        ? null
        : ui.choice({
            key: 'power',
            options: [
              { value: 'auto', label: 'On', key: 'auto', hotkey: 'o' },
              { value: 'manual', label: 'Off', key: 'manual', hotkey: 'f' },
            ],
            selected: frame.mode,
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
      // The kit's segmented control, as the title row's On | Off: the keys stay tab-<id> and the hotkeys the digits.
      ui.choice({
        key: 'tab',
        options: tabs.map(({ id, key, label }) => ({
          value: id,
          key: `tab-${id}`,
          hotkey: key,
          label: `${label}${unsaved[id] ? ' ●' : ''}`,
        })),
        selected: tab,
        onPick: actions.tab,
        gap: 'xs',
      }),
      Button({ key: 'help', label: '?', variant: frame.helpOpen ? 'primary' : 'secondary', onPress: actions.help }),
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
