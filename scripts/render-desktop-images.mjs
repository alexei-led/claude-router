// Draws the desktop, VS Code and mobile band and pane pictures in docs/images/ from the real renderBand and renderPanel.
// Run after a graphical UI change: npm run docs:desktop-images. The element trees become HTML with CSS flexbox
// (desktop-html.mjs) and headless Chrome writes the PNGs. They are not screenshots of the Claude app: its own layout
// and theme are approximated. Set CHROME to the browser binary where it is not the macOS default.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderBand } from '../lib/band.mjs';
import { renderPanel } from '../lib/panel.mjs';
import { draw, elements, pageHtml } from './desktop-html.mjs';
import { base, config, NOW, paneViews, shadowConfig, states, usage } from './doc-samples.mjs';

const OUT = fileURLToPath(new URL('../docs/images', import.meta.url));
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const SCALE = 2;
// Flat colours need few: 64 keeps text clean and the tallest picture under 150 KB.
const COLORS = 64;
const BAND_WIDTH = 900;
// Wide enough for the routed band to keep its routing mode, narrow enough to leave the switch's support out.
const ANNOTATED_WIDTH = 1040;
const PANE_WIDTH = 780;
const PHONE_WIDTH = 390;
const THEMES = ['dark', 'light'];
const PLUGIN_ID = 'router@alexei-led-claude-router';
const noop = () => {};
const actions = new Proxy({}, { get: () => noop });
// The renderers fit text to a number of character cells; a cell is 8px here (desktop-html.mjs), less the padding.
const cells = (width) => Math.floor((width - 28) / 8);

// The band is a strip above the prompt with no padding of its own.
const padded = (html) => `<div style="padding:8px 14px">${html}</div>`;
const bandOf = (view, surface, width, extra = {}, readings = usage) =>
  renderBand(elements, config, view, readings, { columns: cells(width), now: NOW, surface, ...extra }, actions);
const paneOf = (view, surface, width, paneConfig = config) =>
  renderPanel(elements, paneConfig, view, usage, actions, {
    modelOptions: Object.keys(config.models),
    columns: cells(width),
    now: NOW,
    surface,
    pluginId: PLUGIN_ID,
  });

// Two subagents running, one moved to a cheaper model by the router and one on Claude Code's pick.
const agent = (id, type, description, choice, routedKey, coreKey, move) => ({
  id,
  type,
  description,
  record: {
    type,
    pass: null,
    choice,
    routedModel: config.models[routedKey].id,
    coreModel: config.models[coreKey].id,
    move,
  },
});
const runningAgents = [
  agent('a1', 'Explore', 'retry usages', 'haiku', 'haiku', 'opus', 'down'),
  agent('a2', 'general-purpose', 'update the changelog', 'sonnet', 'sonnet', 'sonnet', null),
];

// The callouts under the annotated band: a label and how many of the band's elements it spans, in drawing order,
// for the route group on the left and the readings and controls on the right.
const CALLOUTS = [
  [
    ['Tier', 1],
    ['Model · effort', 1],
    ['Activity', 1],
    ['Reason', 1],
    ['Mode', 1],
  ],
  [
    ['Readings', 2],
    ['Controls', 2],
  ],
];
// Runs in the page, once the browser has laid the band out: a bracket under each span of elements, then its label.
const CALLOUT_SCRIPT = `
const host = document.getElementById('callouts');
const origin = host.getBoundingClientRect();
const groups = document.querySelectorAll('[data-key=router-band] > .b');
const mark = (left, top, width, height, style, text = '') => {
  const el = document.createElement('div');
  el.style.cssText = 'position:absolute;left:' + left + 'px;top:' + top + 'px;width:' + width + 'px;height:' + height + 'px;' + style;
  el.textContent = text;
  host.append(el);
};
${JSON.stringify(CALLOUTS)}.forEach((spans, side) => {
  let next = 0;
  for (const [label, count] of spans) {
    const from = groups[side].children[next].getBoundingClientRect();
    next += count;
    const to = groups[side].children[next - 1].getBoundingClientRect();
    const left = from.left - origin.left;
    const width = to.right - from.left;
    const middle = left + width / 2;
    mark(left, 0, width, 6, 'border:solid var(--subtle);border-width:0 1px 1px');
    mark(middle, 6, 1, 10, 'background:var(--subtle)');
    mark(middle - 60, 18, 120, 18, 'text-align:center;white-space:nowrap;font-size:13px;font-weight:600', label);
  }
});`;
function annotatedBand() {
  const band = bandOf(base, 'desktop', ANNOTATED_WIDTH);
  const drawn = band.props.children.map((group) => group.props.children.length);
  const labelled = CALLOUTS.map((spans) => spans.reduce((sum, [, count]) => sum + count, 0));
  if (drawn.join() !== labelled.join())
    throw new Error(`the band draws ${drawn} elements, the callouts name ${labelled}`);
  return `${padded(draw(band))}<div id="callouts" style="position:relative;height:44px;margin:0 14px"></div><script>${CALLOUT_SCRIPT}</script>`;
}

const bandStates = {
  routed: [base, {}],
  off: [states[5][1], {}],
  setup: [states[4][1], {}],
  agents: [{ ...base, subagentsRunning: 2 }, { agents: runningAgents }],
};
const desktopPictures = [
  ...Object.entries(bandStates).map(([name, [view, extra]]) => ({
    name: `desktop-band-${name}`,
    width: BAND_WIDTH,
    body: () => padded(draw(bandOf(view, 'desktop', BAND_WIDTH, extra))),
  })),
  { name: 'desktop-band-annotated', width: ANNOTATED_WIDTH, body: annotatedBand },
  ...['now', 'routes', 'policy', 'classifier', 'usage'].map((tab) => ({
    name: `desktop-pane-${tab}`,
    width: PANE_WIDTH,
    body: () =>
      draw(
        paneOf(
          paneViews[tab],
          'desktop',
          PANE_WIDTH,
          tab === 'classifier' ? { ...config, classifier: 'clef-flash' } : config,
        ),
      ),
  })),
  {
    name: 'desktop-pane-now-decisions',
    width: PANE_WIDTH,
    body: () => draw(paneOf(paneViews.decisions, 'desktop', PANE_WIDTH, shadowConfig)),
  },
  {
    name: 'desktop-pane-usage-summary',
    width: PANE_WIDTH,
    // The top of the Usage tab: the period row and the Summary card.
    body: () => {
      const [, , body] = paneOf(paneViews.usage, 'desktop', PANE_WIDTH).props.children;
      const [column] = body?.props?.key === 'body' ? body.props.children : [];
      const [period, summary] = column?.props?.children ?? [];
      if (!summary || !draw(summary).includes('Summary'))
        throw new Error('the Usage tab does not start with its Summary');
      return draw(elements.Box({ ...column.props, padding: 'md', children: [period, summary] }));
    },
  },
  {
    name: 'desktop-key-card',
    width: PANE_WIDTH,
    // The pane's warnings slot, where the card sits above the tab's content.
    body: () => {
      const view = { ...states[4][1], tab: 'classifier', keyHelp: { id: 'jev' } };
      const [, , slot] = paneOf(view, 'desktop', PANE_WIDTH).props.children;
      if (slot?.props?.key !== 'notices') throw new Error('the pane has no warnings slot with the key card');
      return draw(slot);
    },
  },
];
// The band and the Now tab at a phone's width, in one frame.
const phonePicture = {
  name: 'mobile-band-and-now',
  width: PHONE_WIDTH,
  themes: ['dark'],
  body: () =>
    `${padded(draw(bandOf(base, 'mobile', PHONE_WIDTH)))}<hr style="border:0;border-top:1px solid var(--border);margin:0">${draw(paneOf(paneViews.now, 'mobile', PHONE_WIDTH))}`,
};

// Chrome's PNGs are 24-bit and large; ImageMagick's palette quantizing makes them small. Without it they stay as drawn.
function shrink(png) {
  try {
    execFileSync('magick', [
      png,
      '-dither',
      'None',
      '-colors',
      String(COLORS),
      '-define',
      'png:compression-level=9',
      '-strip',
      `PNG8:${png}`,
    ]);
  } catch {
    console.warn('magick not found: PNGs left at their full size');
  }
}

function chrome(args) {
  return execFileSync(CHROME, ['--headless=new', '--disable-gpu', '--hide-scrollbars', ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
}

// The page's height as the browser lays it out, so the picture is cut exactly to its content.
function heightOf(file, width) {
  const dom = chrome(['--dump-dom', `--window-size=${width + 32},800`, `file://${file}`]);
  const height = Number(/data-height="(\d+)"/.exec(dom)?.[1]);
  if (!(height > 0)) throw new Error('Chrome did not lay the page out');
  return height;
}

mkdirSync(OUT, { recursive: true });
const scratch = mkdtempSync(join(tmpdir(), 'router-desktop-'));
try {
  for (const picture of [...desktopPictures, phonePicture]) {
    const body = picture.body();
    for (const theme of picture.themes ?? THEMES) {
      const file = join(scratch, `${picture.name}-${theme}.html`);
      writeFileSync(file, pageHtml(body, { theme, width: picture.width }));
      const png = join(OUT, `${picture.name}-${theme}.png`);
      const height = heightOf(file, picture.width);
      chrome([
        `--screenshot=${png}`,
        `--window-size=${picture.width + 32},${height}`,
        `--force-device-scale-factor=${SCALE}`,
        `file://${file}`,
      ]);
      shrink(png);
      console.log(`${png.slice(OUT.length - 'docs/images'.length)}  ${Math.round(statSync(png).size / 1024)} KB`);
    }
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
