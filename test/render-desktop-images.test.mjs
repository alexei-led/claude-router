import assert from 'node:assert/strict';
import { test } from 'node:test';
import { draw, elements, pageHtml } from '../scripts/desktop-html.mjs';

const { Box, Text, Button, Select, Svg, Code } = elements;

test('a row Box with a gap becomes a flex row with that gap in pixels', () => {
  const html = draw(
    Box({ flexDirection: 'row', gap: 'md', children: [Text({ children: 'a' }), Text({ children: 'b' })] }),
  );
  assert.match(html, /flex-direction:row/);
  assert.match(html, /gap:12px/);
  assert.match(html, />a<\/span>.*>b<\/span>/);
});

test('a column Box with a percent width and a wrapping flex keeps them', () => {
  const html = draw(Box({ flexDirection: 'column', flexWrap: 'wrap', width: '25%', children: [] }));
  assert.match(html, /flex-direction:column/);
  assert.match(html, /flex-wrap:wrap/);
  assert.match(html, /width:25%/);
});

test('a primary Button is drawn apart from a secondary one', () => {
  const primary = draw(Button({ label: 'Save', variant: 'primary' }));
  const secondary = draw(Button({ label: 'Discard', variant: 'secondary' }));
  assert.match(primary, /class="btn primary"[^>]*>Save</);
  assert.match(secondary, /class="btn secondary"[^>]*>Discard</);
});

test('a Select shows the label of its selected option', () => {
  const html = draw(
    Select({
      key: 'pin',
      value: 'low',
      options: [
        { value: 'none', label: 'Pin next turn' },
        { value: 'low', label: 'Low tier' },
      ],
    }),
  );
  assert.match(html, /Low tier/);
  assert.doesNotMatch(html, /Pin next turn/);
});

test('an Svg passes its markup through, sized by its props', () => {
  const html = draw(
    Svg({
      source: '<svg viewBox="0 0 4 4"><rect width="4" height="4"/></svg>',
      alt: 'Tier: high',
      width: 16,
      height: 12,
    }),
  );
  assert.match(html, /<svg viewBox="0 0 4 4"><rect width="4" height="4"\/><\/svg>/);
  assert.match(html, /aria-label="Tier: high"/);
  assert.match(html, /width:16px;height:12px/);
});

test('Text escapes markup and takes a theme key as its colour', () => {
  const html = draw(Text({ color: 'success', weight: 'semibold', children: '<b>' }));
  assert.match(html, /&lt;b&gt;/);
  assert.match(html, /color:var\(--success\)/);
  assert.match(html, /font-weight:600/);
});

test('a truncating Text is cut at the end of its line', () => {
  assert.match(draw(Text({ wrap: 'truncate-end', children: 'long' })), /class="t cut"/);
});

test('Code is drawn as a monospaced block', () => {
  assert.match(draw(Code({ source: 'echo 1 && x', language: 'bash' })), /<pre class="code">echo 1 &amp;&amp; x<\/pre>/);
});

test('an unknown Box prop throws and names the prop', () => {
  assert.throws(() => draw(Box({ opacity: 0.5, children: [] })), /Box: no mapping for prop opacity/);
});

test('an unknown Text prop throws', () => {
  assert.throws(() => draw(Text({ blink: true, children: 'x' })), /Text: no mapping for prop blink/);
});

test('an unknown Space step throws', () => {
  assert.throws(() => draw(Box({ gap: 'huge', children: [] })), /Box: no mapping for gap/);
});

test('an unknown theme key throws', () => {
  assert.throws(() => draw(Text({ color: 'nonsense', children: 'x' })), /no mapping for color/);
});

test('an element no renderer draws throws', () => {
  assert.throws(() => draw(elements.Input({})), /Input: no element of that name is drawn/);
  assert.throws(() => draw({ type: 'Progress', props: {} }), /Progress: no element/);
});

test('the page carries the palette of the theme asked for', () => {
  assert.match(pageHtml('', { theme: 'dark', width: 300 }), /--page:#1f1e1d/);
  assert.match(pageHtml('', { theme: 'light', width: 300 }), /--page:#f0eee6/);
  assert.throws(() => pageHtml('', { theme: 'sepia', width: 300 }), /no palette/);
});
