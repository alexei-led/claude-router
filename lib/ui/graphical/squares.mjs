// Subagent squares for desktop, VS Code and mobile: one Svg per run of agents, filled for an agent the router moved,
// outlined for one on Claude Code's pick, each in its model's colour, so moved and kept differ without colour.
import { svgColor } from '../tokens.mjs';

// A square in pixels, and the gap after it.
const SQUARE = 9;
const SQUARE_GAP = 3;

/**
 * The model's squares (`runs` of `{ tone, filled, n, text }`) as one Svg with its alt.
 * @param {any} ui the graphical kit
 * @param {{ runs: { tone: import('../tokens.mjs').Tone, filled: boolean, n: number, text: string }[] }} strip
 * @param {string} alt
 */
export function squares(ui, strip, alt) {
  const cells = strip.runs.flatMap((run) => Array.from({ length: run.n }, () => run));
  const step = SQUARE + SQUARE_GAP;
  const width = Math.max(1, cells.length * step - SQUARE_GAP);
  const rects = cells
    .map((run, i) => {
      const color = svgColor(run.tone);
      return run.filled
        ? `<rect x="${i * step}" y="0" width="${SQUARE}" height="${SQUARE}" rx="1.5" fill="${color}"/>`
        : `<rect x="${i * step + 0.75}" y="0.75" width="${SQUARE - 1.5}" height="${SQUARE - 1.5}" rx="1.5" fill="none" stroke="${color}" stroke-width="1.5"/>`;
    })
    .join('');
  const source = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${SQUARE}" viewBox="0 0 ${width} ${SQUARE}">${rects}</svg>`;
  return ui.Svg({ source, alt, width, height: SQUARE });
}
