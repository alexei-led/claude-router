// Turns the element trees the router draws on desktop, VS Code and mobile into HTML with CSS flexbox, so a browser's
// layout stands in for the Claude app's. Dev tool for the doc pictures, not shipped.
//
// Every prop is mapped or refused: an unknown element or prop throws, so a renderer that starts using something this
// file does not draw cannot silently drop it. The sizes, spacing and colours below are approximations of Claude's
// desktop app, not its real values.

const ELEMENT_TYPES = ['Box', 'Text', 'Button', 'Select', 'Svg', 'Code', 'Input', 'Link'];

/** The element table renderBand and renderPanel draw with: constructors that return plain nodes. */
export const elements = Object.fromEntries(ELEMENT_TYPES.map((type) => [type, (props = {}) => ({ type, props })]));

// Claude Code's `Space` steps in pixels. A bare number is a character cell in the terminal; here one cell is 8px.
const SPACE = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24 };
const CELL = 8;
// The `size` scale of Text.
const TEXT_SIZE = { caption: 11, footnote: 12, body: 14, heading: 17, title: 22 };
const TEXT_WEIGHT = { regular: 400, medium: 500, semibold: 600, bold: 700 };

// Two palettes for Claude Code's theme keys (the ones lib/ui/tokens.mjs draws). Approximations that read like the
// Claude desktop app in its dark and light themes; the real app uses the person's own theme.
export const PALETTES = {
  dark: {
    page: '#1f1e1d',
    surface: '#2b2a28',
    border: '#4a4843',
    control: '#3a3835',
    primary: '#c15f3c',
    onPrimary: '#ffffff',
    text: '#f1efe8',
    subtle: '#a5a299',
    suggestion: '#7da3f5',
    success: '#4fbf8a',
    warning: '#e3a93f',
    error: '#f0807a',
  },
  light: {
    page: '#f0eee6',
    surface: '#fcfbf8',
    border: '#cfcbc0',
    control: '#ebe8df',
    primary: '#b4532f',
    onPrimary: '#ffffff',
    text: '#1f1e1d',
    subtle: '#68665f',
    suggestion: '#2c5ccc',
    success: '#17744a',
    warning: '#8a5700',
    error: '#c0372c',
  },
};
const THEME_KEYS = ['text', 'subtle', 'suggestion', 'success', 'warning', 'error'];
const RAW_COLOR = /^(#[0-9a-f]{3,8}|rgba?\([\d\s.,%]+\))$/i;

const escapeHtml = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const fail = (type, prop) => {
  throw new Error(`${type}: no mapping for ${prop}`);
};

function space(type, prop, value) {
  if (typeof value === 'number') return `${value * CELL}px`;
  if (value in SPACE) return `${SPACE[value]}px`;
  return fail(type, `${prop} (not a Space step)`);
}
function size(type, prop, value) {
  if (typeof value === 'number') return `${value * CELL}px`;
  if (typeof value === 'string' && /^\d+(\.\d+)?%$/.test(value)) return value;
  return fail(type, `${prop} (not a cell count or a percent)`);
}
function color(type, prop, value) {
  if (THEME_KEYS.includes(value)) return `var(--${value})`;
  if (typeof value === 'string' && RAW_COLOR.test(value)) return value;
  return fail(type, `${prop} (neither a themed key nor a hex or rgb colour)`);
}
const BORDERS = { round: '8px', single: '2px' };

// Each Box prop as CSS declarations. Function props and `key` carry behaviour or identity, not looks.
const BOX = {
  flexDirection: (v) => (['row', 'column', 'row-reverse', 'column-reverse'].includes(v) ? `flex-direction:${v}` : null),
  // A growing Box takes its share of the room that is left (basis 0), as Yoga lays out a flexGrow with no basis; the
  // grid's percent columns and the table's equal columns rely on it.
  flexGrow: (v) => `flex-grow:${Number(v)};flex-basis:0`,
  flexShrink: (v) => `flex-shrink:${Number(v)}`,
  flexWrap: (v) => (['nowrap', 'wrap', 'wrap-reverse'].includes(v) ? `flex-wrap:${v}` : null),
  alignItems: (v) => (['flex-start', 'center', 'flex-end', 'stretch'].includes(v) ? `align-items:${v}` : null),
  alignSelf: (v) => (['flex-start', 'center', 'flex-end', 'auto'].includes(v) ? `align-self:${v}` : null),
  justifyContent: (v) =>
    ['flex-start', 'center', 'flex-end', 'space-between', 'space-around', 'space-evenly'].includes(v)
      ? `justify-content:${v}`
      : null,
  gap: (v) => `gap:${space('Box', 'gap', v)}`,
  columnGap: (v) => `column-gap:${space('Box', 'columnGap', v)}`,
  rowGap: (v) => `row-gap:${space('Box', 'rowGap', v)}`,
  width: (v) => `width:${size('Box', 'width', v)}`,
  height: (v) => `height:${size('Box', 'height', v)}`,
  minWidth: (v) => `min-width:${size('Box', 'minWidth', v)}`,
  minHeight: (v) => `min-height:${size('Box', 'minHeight', v)}`,
  padding: (v) => `padding:${space('Box', 'padding', v)}`,
  paddingX: (v) => `padding-left:${space('Box', 'paddingX', v)};padding-right:${space('Box', 'paddingX', v)}`,
  paddingY: (v) => `padding-top:${space('Box', 'paddingY', v)};padding-bottom:${space('Box', 'paddingY', v)}`,
  paddingTop: (v) => `padding-top:${space('Box', 'paddingTop', v)}`,
  paddingBottom: (v) => `padding-bottom:${space('Box', 'paddingBottom', v)}`,
  paddingLeft: (v) => `padding-left:${space('Box', 'paddingLeft', v)}`,
  paddingRight: (v) => `padding-right:${space('Box', 'paddingRight', v)}`,
  margin: (v) => `margin:${space('Box', 'margin', v)}`,
  marginX: (v) => `margin-left:${space('Box', 'marginX', v)};margin-right:${space('Box', 'marginX', v)}`,
  marginY: (v) => `margin-top:${space('Box', 'marginY', v)};margin-bottom:${space('Box', 'marginY', v)}`,
  marginTop: (v) => `margin-top:${space('Box', 'marginTop', v)}`,
  marginBottom: (v) => `margin-bottom:${space('Box', 'marginBottom', v)}`,
  marginLeft: (v) => `margin-left:${space('Box', 'marginLeft', v)}`,
  marginRight: (v) => `margin-right:${space('Box', 'marginRight', v)}`,
  borderStyle: (v) => (v in BORDERS ? `border:1px solid var(--border);border-radius:${BORDERS[v]}` : null),
  borderColor: (v) => `border-color:${color('Box', 'borderColor', v)}`,
  backgroundColor: (v) => `background:${color('Box', 'backgroundColor', v)}`,
  overflow: (v) => (['visible', 'hidden'].includes(v) ? `overflow:${v}` : null),
  display: (v) => (['flex', 'none'].includes(v) ? `display:${v}` : null),
};

function css(type, table, props) {
  const out = [];
  for (const [prop, value] of Object.entries(props)) {
    if (value === undefined) continue;
    if (!(prop in table)) fail(type, `prop ${prop}`);
    const declaration = table[prop](value);
    if (declaration === null || declaration === undefined) fail(type, `${prop} (unsupported value)`);
    if (declaration) out.push(declaration);
  }
  return out.join(';');
}

const items = (children) =>
  [children].flat(Number.POSITIVE_INFINITY).filter((one) => one !== null && one !== undefined && one !== false);
const attr = (name, value) => (value === undefined ? '' : ` ${name}="${escapeHtml(value)}"`);

const TEXT = {
  color: (v) => `color:${color('Text', 'color', v)}`,
  backgroundColor: (v) => `background:${color('Text', 'backgroundColor', v)}`,
  dimColor: (v) => (v ? 'opacity:.6' : ''),
  size: (v) => (v in TEXT_SIZE ? `font-size:${TEXT_SIZE[v]}px` : null),
  weight: (v) => (v in TEXT_WEIGHT ? `font-weight:${TEXT_WEIGHT[v]}` : null),
  bold: (v) => (v ? 'font-weight:600' : ''),
  mono: (v) => (v ? "font-family:ui-monospace,'SF Mono',Menlo,Consolas,monospace" : ''),
  tabular: (v) => (v ? 'font-variant-numeric:tabular-nums' : ''),
  italic: (v) => (v ? 'font-style:italic' : ''),
  underline: (v) => (v ? 'text-decoration:underline' : ''),
  strikethrough: (v) => (v ? 'text-decoration:line-through' : ''),
  dir: (v) => (['ltr', 'rtl'].includes(v) ? `direction:${v}` : null),
};
const TEXT_IGNORED = new Set(['wrap']);
const TRUNCATE = ['truncate', 'truncate-end', 'end'];

// A Text nested in a Text is a run inside it: the outer one decides how the line wraps, as in Claude Code's Ink.
function text(props, inside) {
  const { children, wrap, ...rest } = props;
  const style = css('Text', { ...TEXT, ...Object.fromEntries([...TEXT_IGNORED].map((p) => [p, () => ''])) }, rest);
  if (wrap !== undefined && ![...TRUNCATE, 'wrap'].includes(wrap)) fail('Text', 'wrap (unsupported value)');
  const cls = inside ? '' : TRUNCATE.includes(wrap) ? ' class="t cut"' : ' class="t"';
  return `<span${cls}${style ? ` style="${style}"` : ''}>${draw(children, true)}</span>`;
}

function button(props) {
  // `plain` drops the terminal's chrome only: a desktop draws its native button either way (Claude Code's ButtonProps).
  const { key, label, hotkey, variant, onPress, children, plain: _plain, dimColor, ...rest } = props;
  for (const prop of Object.keys(rest)) fail('Button', `prop ${prop}`);
  if (variant !== undefined && !['primary', 'secondary'].includes(variant))
    fail('Button', 'variant (unsupported value)');
  const body = label !== undefined ? escapeHtml(label) : draw(children, true);
  return `<button class="btn ${variant ?? 'plain'}"${dimColor ? ' style="opacity:.7"' : ''}${attr('data-key', key)}${attr('data-hotkey', hotkey)}>${body}</button>`;
}

function select(props) {
  const { key, label, options, value, onSelect, ...rest } = props;
  for (const prop of Object.keys(rest)) fail('Select', `prop ${prop}`);
  const shown = options.find((option) => option.value === (value ?? options[0]?.value))?.label ?? value ?? '';
  return `<div class="select"${attr('data-key', key)}><span class="cut">${label ? `<span class="dim">${escapeHtml(label)}: </span>` : ''}${escapeHtml(shown)}</span><svg width="10" height="6" viewBox="0 0 10 6"><path d="M1 1l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.5"/></svg></div>`;
}

// The markup is the router's own (meter.mjs, squares.mjs, charts.mjs), passed through; the slot sizes it.
function svg(props) {
  const { source, alt, width, height, isInteractive: _interactive, ...rest } = props;
  for (const prop of Object.keys(rest)) fail('Svg', `prop ${prop}`);
  const style = `${width === undefined ? 'width:100%' : `width:${width}px`};${height === undefined ? '' : `height:${height}px`}`;
  return `<span class="svg" role="img"${attr('aria-label', alt)} style="${style}">${source}</span>`;
}

// No syntax highlighting: the command on the key card is drawn plain in a monospaced block.
function code(props) {
  const { source, language: _language, ...rest } = props;
  for (const prop of Object.keys(rest)) fail('Code', `prop ${prop}`);
  return `<pre class="code">${escapeHtml(source)}</pre>`;
}

function box(props) {
  const { key, children, hover, position, ...rest } = props;
  if (hover !== undefined || position !== undefined) fail('Box', 'prop hover or position');
  const kids = items(children);
  // A graphical surface puts xs between the Buttons of a row Box that sets no gap.
  const row = (rest.flexDirection ?? 'row') === 'row';
  const buttons = row && rest.gap === undefined && kids.some((kid) => kid.type === 'Button');
  const style = css('Box', BOX, rest);
  return `<div class="b"${attr('data-key', key)} style="${style}${buttons ? ';gap:4px' : ''}">${kids.map((kid) => draw(kid, false)).join('')}</div>`;
}

const DRAW = { Box: box, Button: button, Select: select, Svg: svg, Code: code };

/**
 * A node, or a string, number or list of them, as HTML.
 * @param {unknown} node
 * @param {boolean} [inside] whether it sits in a Text
 */
export function draw(node, inside = false) {
  if (Array.isArray(node))
    return items(node)
      .map((one) => draw(one, inside))
      .join('');
  if (node === null || node === undefined || node === false) return '';
  if (typeof node === 'string' || typeof node === 'number') return escapeHtml(node);
  const { type, props = {} } = /** @type {{ type: string, props?: object }} */ (node);
  if (type === 'Text') return text(props, inside);
  const drawn = DRAW[type];
  if (!drawn) throw new Error(`${type}: no element of that name is drawn`);
  return drawn(props);
}

const STYLE = `
*{box-sizing:border-box}
body{margin:0;background:var(--page);color:var(--text);font:14px/1.4 -apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;-webkit-font-smoothing:antialiased}
.b{display:flex;flex-direction:row;min-width:0;min-height:0;align-items:stretch}
.t{min-width:0}
.cut{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.btn{font:inherit;font-size:13px;line-height:1;height:28px;padding:0 11px;border-radius:7px;border:1px solid var(--border);background:var(--control);color:var(--text);display:inline-flex;align-items:center;gap:6px;white-space:nowrap;flex-shrink:1;min-width:0;overflow:hidden}
.btn.primary{background:var(--primary);border-color:var(--primary);color:var(--onPrimary);font-weight:600}
.btn.plain{background:transparent}
.select{display:inline-flex;align-items:center;gap:8px;height:28px;padding:0 10px;border:1px solid var(--border);border-radius:7px;background:var(--surface);font-size:13px;min-width:0;flex-shrink:1;max-width:100%}
.dim{color:var(--subtle)}
.svg{display:block;flex-shrink:0;max-width:100%}
.svg svg{display:block;width:100%;height:100%}
.code{margin:0;padding:10px 12px;border-radius:7px;background:var(--control);border:1px solid var(--border);font:12.5px/1.5 ui-monospace,'SF Mono',Menlo,monospace;white-space:pre-wrap;word-break:break-all}
.frame{background:var(--surface);border:1px solid var(--border);border-radius:12px;overflow:hidden}
`;

/**
 * A page that holds `body` in a framed card of `width` pixels on the theme's ground.
 * @param {string} body
 * @param {{ theme: 'dark' | 'light', width: number }} options
 */
export function pageHtml(body, { theme, width }) {
  const palette = PALETTES[theme];
  if (!palette) throw new Error(`theme: no palette for ${theme}`);
  const vars = Object.entries(palette)
    .map(([name, value]) => `--${name}:${value}`)
    .join(';');
  return `<!doctype html><html><head><meta charset="utf-8"><style>:root{${vars}}${STYLE}</style></head><body><div id="root" style="padding:16px;width:${width + 32}px"><div class="frame" style="width:${width}px">${body}</div></div><script>document.documentElement.dataset.height=Math.ceil(document.getElementById('root').getBoundingClientRect().height)</script></body></html>`;
}
