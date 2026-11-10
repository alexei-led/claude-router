import assert from 'node:assert/strict';
import test from 'node:test';
import {
  compare,
  parseAnthropic,
  parseDeepseek,
  parseKimi,
  parseMinimax,
  parseZai,
  render,
  tables,
} from '../scripts/check-prices.mjs';

const anthropicPage = ({ opus = '$4 / MTok', write5m = '$5 / MTok', haikuOver = '$0.50 / MTok' } = {}) => `
| Model | Base input tokens | 5m cache writes | 1h cache writes | Cache hits and refreshes | Output tokens |
| :--- | :--- | :--- | :--- | :--- | :--- |
| Claude Fable 5.2 | $8 / MTok | $10 / MTok | $16 / MTok | $0.20 / MTok<sup>2</sup> | $40 / MTok |
| Claude Opus 5.5 | ${opus} | ${write5m} | $8 / MTok | $0.20 / MTok<sup>2</sup> | $20 / MTok |
| Claude Sonnet 5.5 | $2 / MTok | $2.50 / MTok | $4 / MTok | $0.10 / MTok<sup>2</sup> | $10 / MTok |
| Claude Haiku 5.5 (for prompts up to 100,000 tokens) | $0.10 / MTok | $0.125 / MTok | $0.20 / MTok | $0.01 / MTok | $0.50 / MTok |
| Claude Haiku 5.5 (for prompts over 100,000 tokens) | ${haikuOver} | $0.625 / MTok | $1 / MTok | $0.05 / MTok | $2.50 / MTok |

| Model | Batch input | Batch output |
| :--- | :--- | :--- |
| Claude Opus 5.5 | $2 / MTok | $10 / MTok |
`;

test('Anthropic: base rows, footnote marks dropped, and one long-context multiplier for a tiered model', () => {
  const read = parseAnthropic(anthropicPage());
  assert.deepEqual(read['claude-fable-5-2'], { input: 8, output: 40, cacheRead: 0.2, longContext: null });
  assert.deepEqual(read['claude-opus-5-5'], { input: 4, output: 20, cacheRead: 0.2, longContext: null });
  assert.deepEqual(read['claude-sonnet-5-5'].cacheRead, 0.1);
  assert.deepEqual(read['claude-haiku-5-5'], {
    input: 0.1,
    output: 0.5,
    cacheRead: 0.01,
    longContext: { above: 100000, multiplier: 5 },
  });
});

test('Anthropic: a page the router cannot represent fails instead of returning a price', () => {
  for (const [name, page, message] of [
    ['a 5m write that is no longer 1.25x input', anthropicPage({ write5m: '$6 / MTok' }), /5m cache writes/],
    ['long-context rates that are not one multiple', anthropicPage({ haikuOver: '$0.40 / MTok' }), /one multiple/],
    ['a cell without a price', anthropicPage({ opus: 'contact us' }), /no price/],
    ['a renamed column', anthropicPage().replace('Cache hits and refreshes', 'Cached reads'), /no table/],
  ])
    assert.throws(() => parseAnthropic(page), message, name);
});

const deepseekPage = (
  rule = 'Peak hours are 01:00 - 04:00 and 06:00 - 10:00 UTC, Monday through Friday, excluding',
) => `
| MODEL | MODEL | MODEL | deepseek-flash(1) | deepseek-v4-pro |
| --- | --- | --- | --- | --- |
| PRICING(2) | 1M INPUT TOKENS / (CACHE HIT) | OFF-PEAK | $0.003 | $0.022 |
| PRICING(2) | 1M INPUT TOKENS / (CACHE HIT) | PEAK | $0.006 | $0.044 |
| PRICING(2) | 1M INPUT TOKENS / (CACHE MISS) | OFF-PEAK | $0.15 | $0.66 |
| PRICING(2) | 1M INPUT TOKENS / (CACHE MISS) | PEAK | $0.3 | $1.32 |
| PRICING(2) | 1M OUTPUT TOKENS | OFF-PEAK | $0.6 | $1.98 |
| PRICING(2) | 1M OUTPUT TOKENS | PEAK | $1.2 | $3.96 |

(2) Off-peak rates are half of the peak rates. ${rule} Chinese public holidays.
`;

test('DeepSeek: peak rates, the off-peak multiplier and the peak hours from the footnote', () => {
  assert.deepEqual(parseDeepseek(deepseekPage()), {
    'deepseek-flash[1m]': {
      input: 0.3,
      cacheRead: 0.006,
      output: 1.2,
      offPeak: {
        multiplier: 0.5,
        peakDays: [1, 2, 3, 4, 5],
        peakHoursUtc: [
          [1, 4],
          [6, 10],
        ],
      },
    },
  });
  assert.deepEqual(
    parseDeepseek(deepseekPage('Peak hours are 02:00 - 05:00 UTC, Sunday through Monday,'))['deepseek-flash[1m]']
      .offPeak,
    { multiplier: 0.5, peakDays: [0, 1], peakHoursUtc: [[2, 5]] },
  );
  assert.throws(() => parseDeepseek(deepseekPage('Busy hours vary.')), /peak-hour rule/);
});

test('Kimi, MiniMax and Z.ai rows read by model name and column name', () => {
  const kimi =
    'children:`kimi-k3.1-pro`}),`$2.00 / MTok`,`$10.00 / MTok`,`$0.20 / MTok`,`$2.00 / MTok`],[_jsx(_components.a,{href:`/x`,children:`kimi-k3.1-pro-highspeed`}),`$4.00 / MTok`';
  assert.deepEqual(parseKimi(kimi), { 'kimi-k3.1-pro[1m]': { input: 2, output: 10, cacheRead: 0.2 } });
  assert.throws(() => parseKimi('<table><tbody /></table>'), /no kimi-k3.1-pro row/);
  const minimax = `| **Model** | **Input** \\$ / M tokens | **Output** \\$ / M tokens | **Prompt caching Read** \\$ / M tokens |
| :- | :-: | :-: | :-: |
| **MiniMax-M3.1-Flash** | \\$0.15 | \\$0.60 | \\$0.015 |`;
  assert.deepEqual(parseMinimax(minimax), { 'MiniMax-M3.1-Flash[1m]': { input: 0.15, output: 0.6, cacheRead: 0.015 } });
  // Columns in another order still read by name.
  const zai = `| Model | Output | Cached Input Storage | Cached Input | Input |
| :- | :- | :- | :- | :- |
| GLM-5.3 | \\$4.4 | Limited-time Free | \\$0.26 | \\$1.4 |
| GLM-5.3-Flash | \\$0.50 | Limited-time Free | \\$0.03 | \\$0.15 |`;
  assert.deepEqual(parseZai(zai), {
    'glm-5.3[1m]': { input: 1.4, cacheRead: 0.26, output: 4.4 },
    'glm-5.3-flash[1m]': { input: 0.15, cacheRead: 0.03, output: 0.5 },
  });
});

test('markdown tables keep cell text without escapes, bold or links', () => {
  assert.deepEqual(tables('| **A** | [b](https://x) |\n| - | - |\n| \\$1 | c |'), [
    { header: ['A', 'b'], rows: [['$1', 'c']] },
  ]);
});

const LIST = {
  a: { source: 'x', input: 1, output: 2, cacheRead: 0.1, longContext: { above: 10, multiplier: 2 } },
  b: { source: 'y', input: 3, output: 4, cacheRead: 0.3, longContext: { above: 10, multiplier: 2 } },
};

test('compare reports each changed field, removes a tier the page dropped, and keeps fields a parser does not read', () => {
  const { next, changes } = compare(LIST, {
    a: { input: 1.5, output: 2, cacheRead: 0.1, longContext: null },
    b: { input: 3, output: 4, cacheRead: 0.3 },
  });
  assert.deepEqual(changes, [
    { id: 'a', source: 'x', field: 'input', from: 1, to: 1.5 },
    { id: 'a', source: 'x', field: 'longContext', from: { above: 10, multiplier: 2 }, to: null },
  ]);
  assert.deepEqual(next.a, { source: 'x', input: 1.5, output: 2, cacheRead: 0.1 });
  assert.deepEqual(next.b, LIST.b);
  assert.equal(LIST.a.input, 1);
  assert.deepEqual(compare(LIST, { a: { ...LIST.a } }).changes, []);
  assert.throws(() => compare(LIST, { c: { input: 1 } }), /c is not in lib\/prices.mjs/);
});

test('render replaces only the data and keeps the comments and helper', () => {
  const text =
    '// header\nexport const PRICE_SOURCES = {};\n\nexport const PRICES = {};\n\n// A model helper\nexport const f = 1;\n';
  const out = render(text, { x: { url: 'u', checked: 'd' } }, LIST);
  assert.ok(out.startsWith('// header\nexport const PRICE_SOURCES = {\n'));
  assert.ok(out.endsWith('\n// A model helper\nexport const f = 1;\n'));
  assert.deepEqual(new Function(`${out.replaceAll('export ', '')}; return PRICES;`)(), LIST);
  assert.throws(() => render('nothing', {}, {}), /lost its markers/);
});
