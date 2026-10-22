// The routing decision for every classifier tier × activity × routing mode, as the router makes it on a fresh history,
// and its Markdown table in docs/routing-modes.md. test/mode-matrix.test.mjs checks the decisions and that the docs
// match them. Run after a change of routes or modes: npm run docs:modes.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ACTIVITY_VALUES, loadConfig, ROUTING_MODES, TIERS } from '../lib/config.mjs';
import { applyMode } from '../lib/modes.mjs';
import { chooseRoute, emptyLoop, nativeFacts } from '../lib/route.mjs';

export const DOC = fileURLToPath(new URL('../docs/routing-modes.md', import.meta.url));
export const CLASSIFIED = [...TIERS, 'uncertain'];
export const ACTIVITY_ANSWERS = ACTIVITY_VALUES;
// The built-in routes, and a user-like profile: high on Opus at high effort.
export const PROFILES = {
  defaults: { label: 'Built-in routes', file: null },
  'opus-high': { label: '`routes.high` = Opus · high', file: { routes: { high: { model: 'opus', effort: 'high' } } } },
};
const START = '<!-- mode-matrix:start -->';
const END = '<!-- mode-matrix:end -->';
const NOW = 1_000_000;

// A classifier answer that clears every bar: the tier and the activity at 0.99, a new task.
function answer(tier, activity) {
  const probabilities = { micro: 0, low: 0, medium: 0, high: 0, uncertain: 0, [tier]: 0.99 };
  const spare = Object.keys(probabilities).find((key) => key !== tier);
  probabilities[spare] = 0.01;
  const shares = Object.fromEntries(ACTIVITY_VALUES.map((a) => [a, a === activity ? 0.99 : 0.01 / 7]));
  return {
    choice: tier,
    confidence: 0.99,
    probabilities,
    continuation: 0,
    activity: { choice: activity, probabilities: shares },
  };
}

// A session model no route runs, so the loop starts at the baseline tier with no activity.
export const UNROUTED_MODEL = 'claude-fable-5-1';

// The decision a session's first turn on `nativeModel` gets for classifier answer `advice`, with no history:
// `{ tier, route, model, effort }`. `config` is the mode's table; the session model names its tier in the
// `configured` routes, as the hook does.
export function decision(config, tier, activity, options) {
  return decide(config, answer(tier, activity), options);
}

export function decide(config, advice, { configured = config, nativeModel = UNROUTED_MODEL } = {}) {
  const loop = emptyLoop(configured, nativeModel);
  const facts = nativeFacts(config, loop, {
    messages: [{ role: 'user', content: 'A task.' }],
    prompt: 'A task.',
    effort: 'high',
    turnId: 't1',
    contextTokens: 20_000,
  });
  const { decision: d } = chooseRoute(config, loop, {
    facts,
    advice,
    pin: null,
    nativeModel,
    contextKnown: true,
    now: NOW,
  });
  return { tier: d.tier, route: d.route, model: d.model, effort: d.effort };
}

// Every cell of a profile: `rows[tier][activity][mode]`, for a session on `nativeModel`.
export function matrix(file, nativeModel = UNROUTED_MODEL) {
  const config = loadConfig({ userFile: file });
  return Object.fromEntries(
    CLASSIFIED.map((tier) => [
      tier,
      Object.fromEntries(
        ACTIVITY_ANSWERS.map((activity) => [
          activity,
          Object.fromEntries(
            ROUTING_MODES.map((mode) => [
              mode,
              decision(applyMode(config, { mode, source: 'profile' }), tier, activity, {
                configured: config,
                nativeModel,
              }),
            ]),
          ),
        ]),
      ),
    ]),
  );
}

const NAMES = { opus: 'Opus', sonnet: 'Sonnet', haiku: 'Haiku' };
const pair = (d) => `${NAMES[d.route.model] ?? d.route.model} · ${d.route.effort ?? 'session'}`;

// One table per profile; activities whose three routes are the same share a row.
export function markdown() {
  const out = [];
  for (const { label, file } of Object.values(PROFILES)) {
    const rows = matrix(file);
    out.push(
      `**${label}**`,
      '',
      '| Classifier | Activities | cost | balanced | quality |',
      '| --- | --- | --- | --- | --- |',
    );
    for (const tier of CLASSIFIED) {
      const groups = new Map();
      for (const activity of ACTIVITY_ANSWERS) {
        const cells = ROUTING_MODES.map((mode) => pair(rows[tier][activity][mode]));
        const key = cells.join('|');
        groups.set(key, { cells, activities: [...(groups.get(key)?.activities ?? []), activity] });
      }
      for (const { cells, activities } of groups.values())
        out.push(`| ${tier} | ${activities.join(', ')} | ${cells.join(' | ')} |`);
    }
    out.push('');
  }
  return out.join('\n').trimEnd();
}

// The docs page with the generated tables between its markers.
export function withMatrix(text) {
  const [before, rest] = text.split(START);
  const [, after] = rest.split(END);
  return `${before}${START}\n${markdown()}\n${END}${after}`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) writeFileSync(DOC, withMatrix(readFileSync(DOC, 'utf8')));
