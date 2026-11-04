// Checks lib/prices.mjs against each vendor's official price page and reports what changed.
//   node scripts/check-prices.mjs [--write] [--report <file>]
// Exit 0: every checked price matches. 1: a price changed (--write rewrites lib/prices.mjs and formats it).
// 2: a page could not be fetched or read, and nothing changed. A page that needs a browser (`manual`) is listed for a
// person to check, never failed. The parsers read the tables by their column names, so a reordered table still reads;
// a renamed one fails loudly instead of returning a wrong price.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PRICE_SOURCES, PRICES } from '../lib/prices.mjs';

const PRICES_FILE = fileURLToPath(new URL('../lib/prices.mjs', import.meta.url));
const BIOME = fileURLToPath(new URL('../tools/node_modules/.bin/biome', import.meta.url));
const FIELDS = ['input', 'output', 'cacheRead', 'longContext', 'offPeak'];
// Claude Code writes Claude caches at these multiples of input (lib/config.mjs cache.writeMultiplier).
const CLAUDE_WRITE = { '5m': 1.25, '1h': 2 };

// Markdown tables as { header, rows } with plain cell text: no bold, escapes, footnote marks or links.
export function tables(markdown) {
  const cell = (text) =>
    text
      .replace(/<sup>.*?<\/sup>/g, '')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\*\*|\\/g, '')
      .trim();
  const out = [];
  let current = null;
  for (const line of markdown.split('\n')) {
    if (!line.trimStart().startsWith('|')) {
      current = null;
      continue;
    }
    const cells = line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(cell);
    if (cells.every((c) => /^:?-+:?$/.test(c))) continue;
    if (current) current.rows.push(cells);
    else {
      current = { header: cells, rows: [] };
      out.push(current);
    }
  }
  return out;
}

const dollars = (text) => {
  const match = /\$\s*([0-9]+(?:\.[0-9]+)?)/.exec(text ?? '');
  if (!match) throw new Error(`no price in "${text}"`);
  return Number(match[1]);
};
const columnOf = (table, pattern) => {
  const index = table.header.findIndex((h) => pattern.test(h));
  if (index < 0) throw new Error(`no column ${pattern} in [${table.header.join(' | ')}]`);
  return index;
};
const tableWith = (markdown, patterns) => {
  const table = tables(markdown).find((t) => patterns.every((p) => t.header.some((h) => p.test(h))));
  if (!table) throw new Error(`no table with columns ${patterns.join(', ')}`);
  return table;
};
const rowOf = (table, label) => {
  const row = table.rows.find((r) => r[0] === label);
  if (!row) throw new Error(`no row "${label}"`);
  return row;
};

// One price row by label, its columns found by name.
function rowPrices(table, label, columns) {
  const row = rowOf(table, label);
  return Object.fromEntries(
    Object.entries(columns).map(([field, pattern]) => [field, dollars(row[columnOf(table, pattern)])]),
  );
}

const CLAUDE = {
  'claude-opus-5-5': 'Claude Opus 5.5',
  'claude-sonnet-5-5': 'Claude Sonnet 5.5',
  'claude-haiku-5-5': 'Claude Haiku 5.5',
};
const CLAUDE_COLUMNS = {
  input: /^Base input/i,
  write5m: /^5m cache writes/i,
  write1h: /^1h cache writes/i,
  cacheRead: /^Cache hits/i,
  output: /^Output/i,
};

// Anthropic's model table. A model priced by prompt length has two rows, "(for prompts up to N tokens)" and
// "(for prompts over N tokens)": the router keeps the first and one multiplier for every rate above N.
export function parseAnthropic(markdown) {
  const table = tableWith(markdown, Object.values(CLAUDE_COLUMNS));
  const out = {};
  for (const [id, name] of Object.entries(CLAUDE)) {
    const tiered = table.rows.filter((r) => r[0].startsWith(`${name} (for prompts`));
    const base = tiered.length
      ? rowPrices(table, tiered.find((r) => /up to/.test(r[0]))?.[0], CLAUDE_COLUMNS)
      : rowPrices(table, name, CLAUDE_COLUMNS);
    for (const ttl of ['5m', '1h'])
      if (Math.abs(base[`write${ttl}`] - base.input * CLAUDE_WRITE[ttl]) > 1e-9)
        throw new Error(`${name} ${ttl} cache writes are no longer ${CLAUDE_WRITE[ttl]}x input: cache.writeMultiplier`);
    const price = { input: base.input, output: base.output, cacheRead: base.cacheRead, longContext: null };
    if (tiered.length) {
      const overRow = tiered.find((r) => /over/.test(r[0]));
      const over = rowPrices(table, overRow?.[0], CLAUDE_COLUMNS);
      const multiplier = over.input / base.input;
      if (Object.keys(CLAUDE_COLUMNS).some((f) => Math.abs(over[f] - base[f] * multiplier) > 1e-9))
        throw new Error(`${name}: the long-context rates are not one multiple of the base rates`);
      const above = Number(/over ([0-9,]+) tokens/.exec(overRow[0])[1].replaceAll(',', ''));
      price.longContext = { above, multiplier: round(multiplier) };
    }
    out[id] = price;
  }
  return out;
}

const DAYS = { Sunday: 0, Monday: 1, Tuesday: 2, Wednesday: 3, Thursday: 4, Friday: 5, Saturday: 6 };

// DeepSeek's table has three label columns (field, sub-field, peak or off-peak) and one column per model; its
// footnote names the peak hours.
export function parseDeepseek(markdown) {
  const table = tables(markdown).find((t) => t.header[0] === 'MODEL');
  if (!table) throw new Error('no model table');
  const column = table.header.findIndex((h) => /^deepseek-flash\b/.test(h));
  if (column < 0) throw new Error('no deepseek-flash column');
  const rate = (field, period) => {
    const row = table.rows.find((r) => r[1].includes(field) && r[2] === period);
    if (!row) throw new Error(`no ${field} ${period} row`);
    return dollars(row[column]);
  };
  const fields = { input: 'CACHE MISS', cacheRead: 'CACHE HIT', output: 'OUTPUT TOKENS' };
  const peak = Object.fromEntries(Object.entries(fields).map(([f, label]) => [f, rate(label, 'PEAK')]));
  const offPeak = Object.fromEntries(Object.entries(fields).map(([f, label]) => [f, rate(label, 'OFF-PEAK')]));
  const multiplier = offPeak.input / peak.input;
  if (Object.keys(fields).some((f) => Math.abs(offPeak[f] - peak[f] * multiplier) > 1e-9))
    throw new Error('off-peak rates are not one multiple of the peak rates');
  const rule = /Peak hours are ([^.]*?) UTC, (\w+) through (\w+)/.exec(markdown);
  if (!rule || !(rule[2] in DAYS) || !(rule[3] in DAYS)) throw new Error('peak-hour rule not found or reworded');
  const peakHoursUtc = [...rule[1].matchAll(/(\d{2}):00 - (\d{2}):00/g)].map((m) => [Number(m[1]), Number(m[2])]);
  if (!peakHoursUtc.length) throw new Error(`peak hours not read from "${rule[1]}"`);
  const peakDays = [];
  for (let d = DAYS[rule[2]]; ; d = (d + 1) % 7) {
    peakDays.push(d);
    if (d === DAYS[rule[3]]) break;
  }
  return { 'deepseek-flash[1m]': { ...peak, offPeak: { multiplier: round(multiplier), peakDays, peakHoursUtc } } };
}

// Kimi renders its tables from data in the page: each row is the model's link, then its prices in column order
// (input, output, cached input, 5m writes, 1h writes).
export function parseKimi(html) {
  const match = /`kimi-k3\.1-pro`\}\),`([^`]*)`,`([^`]*)`,`([^`]*)`/.exec(html);
  if (!match) throw new Error('no kimi-k3.1-pro row');
  return { 'kimi-k3.1-pro[1m]': { input: dollars(match[1]), output: dollars(match[2]), cacheRead: dollars(match[3]) } };
}

export function parseMinimax(markdown) {
  const columns = { input: /^Input/i, output: /^Output/i, cacheRead: /caching Read/i };
  return {
    'MiniMax-M3.1-Flash[1m]': rowPrices(tableWith(markdown, Object.values(columns)), 'MiniMax-M3.1-Flash', columns),
  };
}

export function parseZai(markdown) {
  const columns = { input: /^Input$/i, cacheRead: /^Cached Input$/i, output: /^Output$/i };
  const table = tableWith(markdown, Object.values(columns));
  return {
    'glm-5.3[1m]': rowPrices(table, 'GLM-5.3', columns),
    'glm-5.3-flash[1m]': rowPrices(table, 'GLM-5.3-Flash', columns),
  };
}

const PARSERS = {
  anthropic: parseAnthropic,
  deepseek: parseDeepseek,
  kimi: parseKimi,
  minimax: parseMinimax,
  zai: parseZai,
};
const round = (n) => Math.round(n * 1e9) / 1e9;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// What the pages change: `read` maps model ids to the fields a page gave. A field the parser does not read keeps the
// listed value; `null` says the page shows none, which removes a listed tier or off-peak rule.
export function compare(prices, read) {
  const next = structuredClone(prices);
  const changes = [];
  for (const [id, page] of Object.entries(read)) {
    if (!next[id]) throw new Error(`${id} is not in lib/prices.mjs`);
    for (const field of FIELDS) {
      if (!(field in page)) continue;
      const [from, to] = [next[id][field] ?? null, page[field]];
      if (same(from, to)) continue;
      changes.push({ id, source: next[id].source, field, from, to });
      if (to === null) delete next[id][field];
      else next[id][field] = to;
    }
  }
  return { next, changes };
}

// The module with only its two data objects replaced: its comments and helper stay as written.
export function render(text, sources, prices) {
  const start = text.indexOf('export const PRICE_SOURCES');
  const end = text.indexOf('\n// A model');
  if (start < 0 || end < 0) throw new Error('lib/prices.mjs lost its markers');
  const data = `export const PRICE_SOURCES = ${JSON.stringify(sources, null, 2)};\n\nexport const PRICES = ${JSON.stringify(prices, null, 2)};\n`;
  return `${text.slice(0, start)}${data}${text.slice(end)}`;
}

async function fetchText(url) {
  const response = await fetch(url, {
    headers: { 'user-agent': 'claude-router-price-check' },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.text();
}

async function main(argv) {
  const write = argv.includes('--write');
  const reportAt = argv.indexOf('--report');
  const today = new Date().toISOString().slice(0, 10);
  const failures = [];
  const manual = [];
  const read = {};
  for (const [name, source] of Object.entries(PRICE_SOURCES)) {
    if (source.manual || !PARSERS[name]) {
      manual.push(
        `- ${name}: check by hand at ${source.url} (the page needs a browser); last checked ${source.checked}`,
      );
      continue;
    }
    try {
      const page = PARSERS[name](await fetchText(source.url));
      for (const [id, price] of Object.entries(page)) {
        if (PRICES[id]?.source !== name) throw new Error(`${id} does not belong to ${name}`);
        for (const v of [price.input, price.output, price.cacheRead])
          if (!(Number.isFinite(v) && v > 0)) throw new Error(`${id} has an implausible price ${v}`);
        read[id] = price;
      }
    } catch (error) {
      failures.push(`- ${name} (${source.url}): ${error.message}`);
    }
  }
  const { next, changes } = compare(PRICES, read);
  const changedSources = new Set();
  for (const change of changes) changedSources.add(change.source);
  const sources = structuredClone(PRICE_SOURCES);
  for (const name of changedSources) sources[name].checked = today;
  const lines = [`# Price check ${today}`, ''];
  if (changes.length) {
    lines.push('Official prices differ from `lib/prices.mjs`:', '');
    for (const name of changedSources) {
      lines.push(`**${name}** (${PRICE_SOURCES[name].url})`, '');
      for (const c of changes.filter((change) => change.source === name))
        lines.push(`- ${c.id} ${c.field}: ${JSON.stringify(c.from)} → ${JSON.stringify(c.to)}`);
      lines.push('');
    }
  } else lines.push('Every checked price matches its official page.', '');
  if (failures.length) lines.push('Pages that could not be read:', '', ...failures, '');
  if (manual.length) lines.push('Not checked automatically:', '', ...manual, '');
  const report = lines.join('\n');
  if (reportAt >= 0) writeFileSync(argv[reportAt + 1], report);
  process.stdout.write(`${report}\n`);
  if (changes.length && write) {
    writeFileSync(PRICES_FILE, render(readFileSync(PRICES_FILE, 'utf8'), sources, next));
    execFileSync(BIOME, ['format', '--write', PRICES_FILE], { stdio: 'inherit' });
  }
  return changes.length ? 1 : failures.length ? 2 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  process.exitCode = await main(process.argv.slice(2));
