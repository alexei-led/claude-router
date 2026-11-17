// The Classifier tab as terminal rows: one row per classifier to compare, then the active one's settings and
// readings, this session's agreement and the counts across sessions. Drawn from the model `classifierTab` builds
// (panel.mjs classifierOf).
import { toneColor } from '../tokens.mjs';
import { select } from './policy.mjs';
import { dimLines } from './wrap.mjs';

/**
 * @param {any} ui the terminal painter
 * @param {any} model the Classifier model (panel.mjs classifierOf)
 * @param {{ columns: number | null }} opts
 */
export function terminalClassifier(ui, model, { columns }) {
  const { active } = model;
  const { wait, health, sends, credentials } = active;
  const rows = model.rows.map((row) =>
    ui.line(
      ui.cell(
        17,
        ui.Button({
          key: row.key,
          label: `${row.active ? '◉' : '○'} ${row.label.padEnd(10)}`,
          variant: row.active ? 'primary' : 'secondary',
          onPress: row.press,
        }),
      ),
      ui.cell(21, row.where.local ? ui.text(row.where.text, { color: 'green' }) : ui.dim(row.where.text)),
      ui.cell(8, row.probe ?? ui.dim('—')),
      ui.cell(10, row.p95 ?? ui.dim('—')),
      ui.text(row.state.text, { color: toneColor(row.state.tone, 'terminal') }),
      row.setup ? ui.Button({ key: row.setup.key, label: row.setup.label, onPress: row.setup.press }) : null,
    ),
  );
  return [
    ui.line(ui.head('CLASSIFIER'), ui.dim(' · asked once per new turn · a pick saves at once')),
    ui.dim(`${''.padEnd(17)}${'prompt goes to'.padEnd(21)}${'probe'.padEnd(8)}${'p95'.padEnd(10)}status`),
    ...rows,
    ...dimLines(ui, `  ${model.probeNote.terminal}`, columns),
    ui.text(' '),
    ui.line(ui.head(active.label.toUpperCase()), ui.dim(' · active')),
    ui.line(
      ui.cell(12, active.deadline.label),
      ui.cell(12, select(ui, active.deadline.control)),
      wait.slow ? ui.text(wait.text, { color: 'yellow' }) : ui.dim(wait.text),
    ),
    ui.dim(`${''.padEnd(12)}${active.deadline.help.terminal}`),
    ui.line(ui.cell(12, sends.label), sends.text.terminal),
    ui.dim(`            ${sends.help.terminal}`),
    ui.line(
      ui.cell(12, health.label),
      health.paused ? ui.text(health.paused, { color: 'yellow' }) : health.steady,
      ` · ${health.failures}`,
      health.last ? ui.dim(` · ${health.last}`) : null,
    ),
    ui.line(
      ui.cell(12, credentials.label),
      ui.Button({
        key: credentials.button.key,
        label: credentials.button.label,
        hotkey: credentials.button.hotkey,
        onPress: credentials.button.press,
      }),
      ui.dim(`  ${credentials.note}`),
    ),
    ...(active.session ? [ui.text(' '), ui.head(active.session.head), ui.text(active.session.text)] : []),
    ...(model.store
      ? [
          ui.text(' '),
          ui.head(model.store.head),
          ...model.store.rows.map((row) => ui.text(row.text)),
          ...(model.store.unpriced ? [ui.text(model.store.unpriced)] : []),
        ]
      : []),
  ];
}
