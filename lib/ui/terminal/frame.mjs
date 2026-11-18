// The pane's frame on the terminal: the header with the routing state and the tab row, the warnings, the save bar's
// lines and the help.
import { toneColor } from '../tokens.mjs';

// Routing's state, its one mode control and the classifier's state on one line. While routing is unavailable, on and
// off would change nothing, so the line says why instead of offering them.
function routingState(ui, frame, actions, help) {
  const end = help ? ['  ', help] : [];
  if (frame.unavailable)
    return [
      ui.line(
        ui.head('ROUTER'),
        '  ',
        ui.text('unavailable', { color: ui.color('warning') }),
        ui.dim('  Claude’s model is kept'),
        ...end,
      ),
      ui.text(frame.unavailable.reason, { color: ui.color('warning') }),
      ...frame.unavailable.cleanup.map((line) => ui.text(line, { color: ui.color('warning') })),
    ];
  // A radio pair, marked as the Classifier tab marks its active row.
  const option = (mode, label, hotkey) =>
    ui.Button({
      key: mode,
      label: `${frame.mode === mode ? '◉' : '○'} ${label}`,
      hotkey,
      variant: frame.mode === mode ? 'primary' : 'secondary',
      onPress: () => actions.mode(mode),
    });
  const { classifier } = frame;
  return [
    ui.line(
      ui.head('ROUTER'),
      '  ',
      option('auto', 'on', 'o'),
      ' ',
      option('manual', 'off', 'f'),
      '  ',
      classifier.repeated
        ? ui.dim('see below')
        : ui.text(classifier.text, { color: toneColor(classifier.tone, 'terminal') }),
      ...end,
    ),
  ];
}

// A warning as the terminal draws it, indented; one that carries a Button, or would on another tab, leaves room for it.
const noticeLine = (ui, notice) =>
  ui.notice(
    notice.tone,
    `  ${notice.text}${notice.action === undefined ? '' : '  '}`,
    notice.action
      ? ui.Button({
          key: notice.action.key,
          label: notice.action.label,
          hotkey: notice.action.hotkey,
          onPress: notice.action.press,
        })
      : null,
  );

// The tabs carry their number keys in their labels, so every key the pane answers is on screen. A row wider than the
// pane drops the digits (the keys still answer), and then moves ? to the header line's end, so Ink never squeezes the
// spaces between the tabs away.
function header(ui, frame, tabs, tab, actions, columns) {
  const labels = (digits) =>
    tabs.map(({ id, key, label }) => `${digits ? `${key} ` : ''}${label}${frame.unsaved[id] ? ' ●' : ''}`);
  // As drawn: a Button is its label in `[ ` and ` ]`, a space after each tab.
  const width = (names, withHelp) => names.reduce((n, name) => n + name.length + 5, 0) + (withHelp ? 5 : -1);
  const fits = (names, withHelp) => !Number.isFinite(columns) || width(names, withHelp) <= columns;
  const digits = fits(labels(true), true);
  const names = labels(digits);
  const help = ui.Button({
    key: 'help',
    label: '?',
    variant: frame.helpOpen ? 'primary' : 'secondary',
    onPress: actions.help,
  });
  const helpOnRow = fits(names, true);
  return [
    ...routingState(ui, frame, actions, helpOnRow ? null : help),
    ui.line(
      ...tabs.flatMap(({ id, key }, i) => [
        i ? ' ' : null,
        ui.Button({
          key: `tab-${id}`,
          label: names[i],
          hotkey: key,
          variant: tab === id ? 'primary' : 'secondary',
          onPress: () => actions.tab(id),
        }),
      ]),
      ...(helpOnRow ? [' ', help] : []),
    ),
    ...frame.notices.filter((notice) => !notice.graphicalOnly).map((notice) => noticeLine(ui, notice)),
    ui.text(' '),
  ];
}

// The save bar as the terminal's lines: router.json's diff on the two draft tabs, the count with Save and Discard,
// then the notice and Undo.
function statusBar(ui, bar) {
  const out = [];
  if (bar.count) {
    out.push(ui.text(' '));
    if (bar.listed) {
      out.push(ui.dim('router.json changes:'));
      for (const row of bar.rows)
        out.push(
          ui.text(`- ${row.key.padEnd(30)} ${ui.say(row.before)}`, { color: toneColor('danger', 'terminal') }),
          ui.text(`+ ${row.key.padEnd(30)} ${ui.say(row.after)}`, { color: toneColor('success', 'terminal') }),
        );
    }
    const { save, discard } = bar;
    out.push(
      ui.line(
        ui.text(`${bar.pending.text}  `, { color: toneColor(bar.pending.tone, 'terminal') }),
        ui.Button({ key: save.key, label: save.label, hotkey: save.hotkey, variant: 'primary', onPress: save.press }),
        ' ',
        ui.Button({ key: discard.key, label: discard.label, hotkey: discard.hotkey, onPress: discard.press }),
        bar.listed ? null : ui.dim(`  ${bar.elsewhere}`),
      ),
    );
  }
  const undo = bar.undo
    ? ui.Button({ key: bar.undo.key, label: bar.undo.label, hotkey: bar.undo.hotkey, onPress: bar.undo.press })
    : null;
  if (bar.notice || undo) out.push(ui.text(' '));
  if (bar.notice)
    out.push(
      ui.line(
        ui.text(`${bar.notice.text}  `, { color: toneColor(bar.notice.tone, 'terminal') }),
        bar.undo?.confirms ? undo : null,
      ),
    );
  if (undo && !bar.undo.confirms) out.push(ui.line(ui.dim(`${bar.undo.last}  `), undo));
  return out;
}

// One Text per paragraph, wrapping to the pane.
const helpLines = (ui, help) => [
  ui.head(help.head),
  ...help.paragraphs.map((paragraph) => ui.text(ui.say(paragraph.text), { dimColor: true, wrap: 'wrap' })),
  ui.text(' '),
];

/**
 * The pane on the terminal: the header, the profile and help when asked, the tab's rows, then the save bar. There is no
 * Close button: Esc and the pane's own close dismiss it.
 * @param {any} ui the terminal painter
 * @param {ReturnType<typeof import('../model/frame.mjs').frameOf>} frame
 * @param {{ id: string, key: string, label: string }[]} tabs
 * @param {string} tab the shown tab's id
 * @param {any} actions
 * @param {object[]} content the tab's rows
 * @param {number | null} columns
 */
export function terminalFrame(ui, frame, tabs, tab, actions, content, columns) {
  return ui.Box({
    flexDirection: 'column',
    children: [
      ...header(ui, frame, tabs, tab, actions, columns),
      ...(frame.help ? helpLines(ui, frame.help) : []),
      ...(frame.profile ? [ui.dim(ui.say(frame.profile))] : []),
      ...content,
      ...statusBar(ui, frame.bar),
    ],
  });
}
