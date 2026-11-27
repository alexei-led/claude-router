// Draws the band and pane pictures in docs/ from the real render functions, with sample readings.
// Run after a UI change: npm run docs:images. The layout is a plain row/column flow, not Claude Code's renderer.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderBand } from '../lib/band.mjs';
import { renderPanel } from '../lib/panel.mjs';
import { COLUMNS, classifierConfig, config, NOW, paneViews, shadowConfig, states, usage } from './doc-samples.mjs';

const OUT = fileURLToPath(new URL('../docs', import.meta.url));
const element = (type) => (props) => ({ type, props });
const elements = { Box: element('Box'), Text: element('Text'), Button: element('Button'), Select: element('Select') };
const noop = () => {};
const actions = new Proxy({}, { get: () => noop });

// The terminal draws Claude Code theme keys (lib/ui/tokens.mjs); these are a dark theme's colours for them, so the
// pictures read like a dark terminal. A real terminal uses the person's own theme.
const COLORS = {
  text: '#d0d0d0',
  subtle: '#7c7c7c',
  suggestion: '#5fafd7',
  success: '#87d787',
  warning: '#d7af5f',
  error: '#e06c6c',
};
const FG = '#d0d0d0';
const DIM = '#7c7c7c';
const ACCENT = '#87afff';
const INK = '#0d1016';
const BUTTON = '#2e3340';

// Layout: a node becomes lines of runs; each run is { text, fill, bold, italic, bg }, bg being a chip behind the text.
const width = (line) => line.reduce((n, r) => n + [...r.text].length, 0);
const pad = (lines, w) =>
  lines.map((line) => (width(line) < w ? [...line, { text: ' '.repeat(w - width(line)) }] : line));
// `runs` painted over `line` from column `at`, as an absolutely placed Box paints over the row beneath it.
function overlay(line, at, runs) {
  const cut = (from, to) => {
    const out = [];
    let col = 0;
    for (const run of line) {
      const chars = [...run.text];
      const start = Math.max(from, col);
      const end = Math.min(to, col + chars.length);
      if (start < end) out.push({ ...run, text: chars.slice(start - col, end - col).join('') });
      col += chars.length;
    }
    return out;
  };
  const end = at + width(runs);
  return [...pad([cut(0, at)], at)[0], ...runs, ...cut(end, Number.POSITIVE_INFINITY)];
}
// `columns` is the pane's width, which a bordered Box stretches to as the terminal draws it.
function lay(node, opts) {
  const { hover } = opts;
  if (!node) return [];
  const { type, props } = node;
  if (type === 'Text') {
    const fill = props.dimColor ? DIM : (COLORS[props.color] ?? props.color ?? FG);
    return [
      [
        {
          text: props.children ?? '',
          fill,
          bold: props.weight === 'semibold' || props.weight === 'bold',
          italic: props.italic,
          bg: props.backgroundColor,
        },
      ],
    ];
  }
  if (type === 'Button') {
    const text = props.plain ? props.label : `[ ${props.label} ]`;
    if (props.plain) return [[{ text, fill: props.dimColor ? DIM : FG }]];
    if (props.variant === 'primary') return [[{ text, fill: INK, bold: true, bg: ACCENT }]];
    return [[{ text, fill: props.dimColor ? DIM : FG, bg: BUTTON }]];
  }
  if (type === 'Select') {
    const picked = props.options.find((o) => o.value === props.value)?.label ?? props.value;
    return [[{ text: `${props.label ? `${props.label}: ` : ''}${picked} ▾`, fill: FG }]];
  }
  // Box
  if (props.display === 'none' && !hover) return [];
  const all = (Array.isArray(props.children) ? props.children : [props.children]).filter(Boolean);
  const children = all.filter((child) => child.props?.position !== 'absolute');
  let lines;
  if (props.flexDirection === 'column') lines = children.flatMap((child) => lay(child, opts));
  else {
    const blocks = children.map((child) => lay(child, opts)).filter((b) => b.length);
    const height = Math.max(1, ...blocks.map((b) => b.length));
    lines = Array.from({ length: height }, () => []);
    for (const block of blocks) {
      const w = Math.max(0, ...block.map(width));
      const padded = pad(block, w);
      for (let i = 0; i < height; i += 1) lines[i].push(...(padded[i] ?? [{ text: ' '.repeat(w) }]));
    }
  }
  for (const child of all.filter((one) => one.props?.position === 'absolute')) {
    const [runs] = lay(child, opts);
    if (runs && lines[child.props.top ?? 0])
      lines[child.props.top ?? 0] = overlay(lines[child.props.top ?? 0], child.props.left ?? 0, runs);
  }
  if (props.borderStyle) lines = bordered(lines, props, opts.columns);
  return props.width ? pad(lines, props.width) : lines;
}

// A bordered Box: its lines inside a single line in the border's colour, its paddingX from it on each side, as wide as
// the pane (or its widest line, with no width).
function bordered(lines, { borderColor, paddingX = 0 }, columns) {
  const fill = COLORS[borderColor] ?? borderColor ?? DIM;
  const inner = Math.max(Number.isFinite(columns) ? columns - 2 : 0, ...lines.map(width).map((w) => w + 2 * paddingX));
  const side = (glyph, rule) => ({ text: glyph, fill, rule });
  const space = { text: ' '.repeat(paddingX) };
  return [
    [side(`┌${'─'.repeat(inner)}┐`, 'top')],
    ...pad(lines, inner - 2 * paddingX).map((line) => [side('│', 'side'), space, ...line, space, side('│', 'side')]),
    [side(`└${'─'.repeat(inner)}┘`, 'bottom')],
  ];
}

const CW = 7.8;
const LH = 19;
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
// A border drawn as lines, not box-drawing glyphs: a glyph does not fill the 19px row, so a side would show as dashes.
// `base` is the text baseline of the row; the cell spans base - 14 to base + 5.
function ruleSvg({ rule, fill }, x, base, width) {
  const [top, mid, bottom] = [base - 14, base - 5, base + 5];
  const left = (x + CW / 2).toFixed(1);
  const right = (x + width - CW / 2).toFixed(1);
  const path = {
    side: `M${left} ${top}V${bottom}`,
    top: `M${left} ${bottom}V${mid}H${right}V${bottom}`,
    bottom: `M${left} ${top}V${mid}H${right}V${top}`,
  }[rule];
  return `<path d="${path}" fill="none" stroke="${fill}"/>`;
}
function runsSvg(lines, x0, y0) {
  const out = [];
  lines.forEach((line, row) => {
    let col = 0;
    for (const run of line) {
      const x = x0 + col * CW;
      const width = [...run.text].length * CW;
      if (run.rule) {
        out.push(ruleSvg(run, x, y0 + row * LH, width));
        col += [...run.text].length;
        continue;
      }
      if (run.bg && run.text.trim()) {
        out.push(
          `<rect x="${x.toFixed(1)}" y="${y0 + row * LH - 14}" width="${width.toFixed(1)}" height="18" rx="4" fill="${run.bg}"/>`,
        );
      }
      if (run.text.trim()) {
        out.push(
          `<text x="${x.toFixed(1)}" y="${y0 + row * LH}" fill="${run.fill ?? FG}"${run.bold ? ' font-weight="700"' : ''}${run.italic ? ' font-style="italic"' : ''} xml:space="preserve">${esc(run.text)}</text>`,
        );
      }
      col += [...run.text].length;
    }
  });
  return out.join('\n');
}

function svg({ title, desc, body, w, h }) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" role="img" aria-labelledby="title desc">
  <title id="title">${esc(title)}</title>
  <desc id="desc">${esc(desc)}</desc>
  <style>
    text { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace; font-size: 13px; }
    .cap { font-family: system-ui, -apple-system, 'Segoe UI', sans-serif; font-size: 12px; fill: #9a988f; }
  </style>
  <rect width="${w}" height="${h}" rx="8" fill="#1c1c1c"/>
${body}
</svg>
`;
}

let y = 30;
const parts = [];
for (const [caption, view, hover, readings = usage] of states) {
  const tree = renderBand(elements, config, view, readings, { columns: COLUMNS, now: NOW }, actions);
  const lines = lay(tree, { hover });
  parts.push(`<text class="cap" x="20" y="${y}">${esc(caption)}</text>`);
  parts.push(
    `<rect x="12" y="${y + 8}" width="${COLUMNS * CW + 24}" height="${lines.length * LH + 10}" rx="5" fill="#232323"/>`,
  );
  parts.push(runsSvg(lines, 24, y + 8 + 18));
  y += 8 + lines.length * LH + 10 + 28;
}
writeFileSync(
  `${OUT}/router-band.svg`,
  svg({
    title: 'The Router band above the Claude Code prompt',
    desc: 'Eight band states drawn by the router code: routed to high, two rows on a Claude plan with the hover controls shown, two rows on an API key, a pending pin, a missing classifier key, routing off, an activity move with activity routing on, and cost mode set for the session.',
    body: parts.join('\n'),
    w: Math.ceil(COLUMNS * CW + 48),
    h: y - 14,
  }),
);

// ---- pane tabs ----
function pane(view, title, desc, file, paneConfig = config, columns = COLUMNS) {
  // As wide as the band: a pane under 80 columns, or with no width, puts each classifier on two lines.
  const tree = renderPanel(elements, paneConfig, view, usage, actions, {
    modelOptions: Object.keys(config.models),
    columns,
    now: NOW,
  });
  const lines = lay(tree, { hover: false, columns }).filter((line, i, all) => i < all.length - 1 || width(line) > 0);
  const cols = Math.max(...lines.map(width), 70);
  const w = Math.ceil(cols * CW + 48);
  const h = lines.length * LH + 40;
  const body = `<rect x="10" y="10" width="${w - 20}" height="${h - 20}" rx="6" fill="none" stroke="#3f5f8f"/>\n${runsSvg(lines, 24, 34)}`;
  writeFileSync(`${OUT}/${file}`, svg({ title, desc, body, w, h }));
}
pane(
  paneViews.routes,
  'Router pane, Routes tab',
  'The activity routing mode, then one grid of tiers by activities: the tiers’ own models on top, each activity override in its cell with built-in defaults marked °, unsaved edits ●; the editor of the selected cell, code at high, with Use tier model; the model setups in use; and the unsaved project routing changes with Save and Discard.',
  'router-pane-routes.svg',
);
pane(
  paneViews.policy,
  'Router pane, Policy tab',
  'Each policy control inside the sentence it completes: the start tier, votes and payback horizon for going down, the support needed to go up, the activity threshold and the credits cap, with the default shown beside a changed value, the project scope and read-only profile path, and the unsaved change with Save and Discard.',
  'router-pane-policy.svg',
);
pane(
  paneViews.classifier,
  'Router pane, Classifier tab',
  'One row per classifier to compare: where the prompt goes, its activity probe, its p95 wait and whether its credentials are complete, with Set up for a missing Jev API key; the active classifier’s deadline against its wait, the host that receives the prompt, health and credentials; across sessions, bars for how often the label fits the tools and how often a cheaper move went back up, then the misses; and Undo after a switch.',
  'router-pane-classifier.svg',
  classifierConfig,
);

pane(
  paneViews.now,
  'Router pane, Now tab',
  'Each block in a single-line box. NEXT TURN: the tier meter, model and activity, the reason with the classifier support it weighed and the switch cost, and the dropdown that pins the next turn to a tier. PLAN: the 5-hour and 7-day windows with their resets. SESSION: the total of the main thread and one running subagent as a configured-rate API estimate, the difference against unrouted, the main thread and the subagents as bars on one scale, and a strip of every reply colored by tier with the replies per tier. CONTEXT: the window fill and the cache reuse.',
  'router-pane-now.svg',
);
pane(
  paneViews.decisions,
  'Router pane, Now tab, Recent decisions',
  'With the shadow engine, RECENT DECISIONS under NEXT TURN: how often shadow proposed the route that ran, then a line per turn with its start time, how long it ran, the tier meter and route that ran last, the work, its requests and why, and under a turn at most two notes: an API error and what it held out, the route shadow proposed when it differed, or a move within the turn.',
  'router-pane-now-decisions.svg',
  shadowConfig,
);
pane(
  paneViews.usage,
  'Router pane, Usage tab',
  'The last 7 days across sessions: the period row, the difference against unrouted first, then a cost table whose rows add up (the main thread with its cheaper-model saving and cache rebuilds, the subagents, the total) with each row against unrouted, the replies and tokens, the cost by activity with code opened to its routes and cost parts, the cost by day, what is worth a look with a link to Routes, subagents, and Delete history.',
  'router-pane-usage.svg',
  config,
  null,
);
pane(
  paneViews.usageWhatIf,
  'Router pane, Usage tab, What if',
  'This session by tier, with What if: the same tokens on Haiku 5.5, Sonnet 5.5 and Opus 5.5 alone against what routing spent.',
  'router-pane-usage-whatif.svg',
  config,
  null,
);
console.log(`wrote router-band.svg and the Now, Routes, Policy, Classifier and Usage pane pictures to ${OUT}`);
