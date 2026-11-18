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
import { base, config, NOW, paneViews, states, usage } from './doc-samples.mjs';

const OUT = fileURLToPath(new URL('../docs/images', import.meta.url));
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const SCALE = 2;
// Flat colours need few: 64 keeps text clean and the tallest picture under 150 KB.
const COLORS = 64;
const BAND_WIDTH = 900;
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
