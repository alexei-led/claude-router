// Draws the band and pane pictures in docs/ from the real render functions, with sample readings.
// Run after a UI change: npm run docs:images. The layout is a plain row/column flow, not Claude Code's renderer.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../lib/config.mjs';
import { renderBand } from '../lib/native-band.mjs';
import { renderPanel } from '../lib/native-panel.mjs';

const OUT = fileURLToPath(new URL('../docs', import.meta.url));
const config = { ...loadConfig(), nativePath: '~/.claude/router.json' };
const element = (type) => (props) => ({ type, props });
const elements = { Box: element('Box'), Text: element('Text'), Button: element('Button'), Select: element('Select') };
const noop = () => {};
const actions = new Proxy({}, { get: () => noop });

const COLORS = { cyan: '#5fafd7', yellow: '#d7af5f', green: '#87d787', red: '#e06c6c', gray: '#7c7c7c' };
const FG = '#d0d0d0';
const DIM = '#7c7c7c';
const ACCENT = '#87afff';

// Layout: a node becomes lines of runs; each run is { text, fill, bold }.
const width = (line) => line.reduce((n, r) => n + [...r.text].length, 0);
const pad = (lines, w) =>
  lines.map((line) => (width(line) < w ? [...line, { text: ' '.repeat(w - width(line)) }] : line));
function lay(node, { hover }) {
  if (!node) return [];
  const { type, props } = node;
  if (type === 'Text') {
    const fill = props.dimColor ? DIM : (COLORS[props.color] ?? props.color ?? FG);
    return [[{ text: props.children ?? '', fill, bold: props.bold }]];
  }
  if (type === 'Button') {
    const text = props.plain ? props.label : `[ ${props.label} ]`;
    const fill = props.variant === 'primary' ? ACCENT : props.dimColor ? DIM : FG;
    return [[{ text, fill, bold: props.variant === 'primary' }]];
  }
  if (type === 'Select') {
    const picked = props.options.find((o) => o.value === props.value)?.label ?? props.value;
    return [[{ text: `${props.label ? `${props.label}: ` : ''}${picked} ▾`, fill: FG }]];
  }
  // Box
  if (props.display === 'none' && !hover) return [];
  const children = (Array.isArray(props.children) ? props.children : [props.children]).filter(Boolean);
  let lines;
  if (props.flexDirection === 'column') lines = children.flatMap((child) => lay(child, { hover }));
  else {
    const blocks = children.map((child) => lay(child, { hover })).filter((b) => b.length);
    const height = Math.max(1, ...blocks.map((b) => b.length));
    lines = Array.from({ length: height }, () => []);
    for (const block of blocks) {
      const w = Math.max(0, ...block.map(width));
      const padded = pad(block, w);
      for (let i = 0; i < height; i += 1) lines[i].push(...(padded[i] ?? [{ text: ' '.repeat(w) }]));
    }
  }
  return props.width ? pad(lines, props.width) : lines;
}

const CW = 7.8;
const LH = 19;
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function runsSvg(lines, x0, y0) {
  const out = [];
  lines.forEach((line, row) => {
    let col = 0;
    for (const run of line) {
      if (run.text.trim()) {
        out.push(
          `<text x="${(x0 + col * CW).toFixed(1)}" y="${y0 + row * LH}" fill="${run.fill ?? FG}"${run.bold ? ' font-weight="700"' : ''} xml:space="preserve">${esc(run.text)}</text>`,
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

const base = {
  phase: 'routed',
  mode: 'auto',
  nativeModel: 'claude-sonnet-5-5',
  selectedModel: 'claude-opus-5-5',
  actualModel: 'claude-opus-5-5',
  tier: 'high',
  effort: 'xhigh',
  reason: 'jump',
  error: null,
  keySet: true,
  adviceMs: 347,
  probabilities: { micro: 0.02, low: 0.03, medium: 0.07, high: 0.88, uncertain: 0 },
  estimate: { threshold: 0.82, upgradeMass: 0.88, taxUsd: 0.476 },
  contextTokens: 401_800,
  contextKnown: true,
  inputTokens: 402_400,
  cacheRead: 400_600,
  cacheWrite: 1_800,
  outputTokens: 499,
  history: [
    361_000, 364_000, 366_000, 369_000, 371_000, 372_000, 375_000, 378_000, 380_000, 383_000, 386_000, 388_000, 390_000,
    392_000, 395_000, 396_000, 398_000, 399_000, 401_000, 402_400,
  ],
  tiers: [...'llllllddllllhhhhhhhh'].map((c) => ({ l: 'low', d: 'medium', h: 'high' })[c]),
  pendingPin: null,
  comparison: null,
  health: { failures: 0, pausedUntil: 0 },
  configPath: '~/.claude/router.json',
  tab: 'now',
  help: false,
  bandDetail: false,
};
const usage = {
  context: { tokens: 402_400 },
  cost: { usd: 18.003 },
  rateLimits: [
    { kind: 'five_hour', percentUsed: 48 },
    { kind: 'seven_day', percentUsed: 43 },
  ],
};

// ---- band states ----
const COLUMNS = 112;
const states = [
  ['Auto: routed to the high tier on a clear jump', base, false],
  ['Two rows, with the hover row shown: recent replies by tier, pins, Manual', { ...base, bandDetail: true }, true],
  [
    'A pin waits for the next turn; ✕ cancels it',
    {
      ...base,
      tier: 'low',
      selectedModel: 'claude-sonnet-5-5',
      actualModel: 'claude-sonnet-5-5',
      effort: 'medium',
      reason: 'same-tier',
      estimate: null,
      pendingPin: 'medium',
    },
    false,
  ],
  [
    'No classifier key: Router keeps the model and offers Set key',
    {
      ...base,
      tier: 'low',
      selectedModel: 'claude-sonnet-5-5',
      actualModel: 'claude-sonnet-5-5',
      effort: 'medium',
      reason: 'no-advice',
      error: 'missing-key',
      keySet: false,
      estimate: null,
    },
    false,
  ],
  [
    'Manual: /model chose the model; Auto resumes routing',
    { ...base, mode: 'manual', reason: 'model selected manually', nativeModel: 'claude-sonnet-5-5' },
    false,
  ],
];
let y = 30;
const parts = [];
for (const [caption, view, hover] of states) {
  const tree = renderBand(elements, config, view, usage, { columns: COLUMNS }, actions);
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
    desc: 'Five band states drawn by the router code: routed to high, two rows with the hover row, a pending pin, a missing classifier key, and Manual mode.',
    body: parts.join('\n'),
    w: Math.ceil(COLUMNS * CW + 48),
    h: y - 14,
  }),
);

// ---- pane tabs ----
function pane(view, title, desc, file) {
  const tree = renderPanel(elements, config, view, usage, actions, { modelOptions: Object.keys(config.models) });
  const lines = lay(tree, { hover: false }).filter((line, i, all) => i < all.length - 1 || width(line) > 0);
  const cols = Math.max(...lines.map(width), 70);
  const w = Math.ceil(cols * CW + 48);
  const h = lines.length * LH + 40;
  const body = `<rect x="10" y="10" width="${w - 20}" height="${h - 20}" rx="6" fill="none" stroke="#3f5f8f"/>\n${runsSvg(lines, 24, 34)}`;
  writeFileSync(`${OUT}/${file}`, svg({ title, desc, body, w, h }));
}
pane(
  base,
  'Router pane, Now tab',
  'The current route with its reason, classifier support per tier with pin buttons, the last 20 replies colored by tier, and context, cache and cost.',
  'router-pane-now.svg',
);
pane(
  {
    ...base,
    tab: 'tiers',
    routeDraft: {
      routes: { ...config.routes, medium: { model: 'sonnet', effort: 'xhigh' } },
      baselineTier: 'low',
    },
  },
  'Router pane, Tiers tab',
  'Model and effort per tier with prices and windows, the baseline tier, how the policy prices each step up, and the router.json change Save routes will write.',
  'router-pane-tiers.svg',
);
console.log(`wrote router-band.svg, router-pane-now.svg and router-pane-tiers.svg to ${OUT}`);
