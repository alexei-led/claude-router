import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULTS } from '../lib/config.mjs';
import { REASONS, shortReason } from '../lib/display.mjs';
import { KEYWORDS, keywordEffort, keywordRaises, keywordTier, promptKeyword } from '../lib/keywords.mjs';

for (const [prompt, expected] of [
  ['maxthink fix the race', 'maxthink'],
  ['MaxThink fix the race', 'maxthink'],
  ['  \n nothink: rename it', 'nothink'],
  ['highthink, then commit', 'highthink'],
  ['lowthink', 'lowthink'],
  ['morethink? sure', 'morethink'],
  ['lessthink.', 'lessthink'],
  ['please maxthink this', null],
  ['maxthinking about it', null],
  ['maxthink-ish', null],
  ['maxthink_ok', null],
  ['ultrathink fix it', null],
  ['think harder about it', null],
  ['', null],
  [null, null],
])
  test(`the prompt ${JSON.stringify(prompt)} opens with keyword ${expected}`, () => {
    assert.equal(promptKeyword(prompt), expected);
  });

for (const [keyword, from, to] of [
  ['maxthink', 'micro', 'high'],
  ['maxthink', 'high', 'high'],
  ['nothink', 'high', 'micro'],
  ['highthink', 'low', 'medium'],
  ['highthink', 'high', 'high'],
  ['lowthink', 'medium', 'low'],
  ['lowthink', 'micro', 'micro'],
  ['morethink', 'medium', 'medium'],
  ['lessthink', 'low', 'low'],
])
  test(`${keyword} moves tier ${from} to ${to}`, () => {
    assert.equal(keywordTier(keyword, from), to);
  });

for (const [keyword, effort, expected] of [
  ['morethink', 'high', 'xhigh'],
  ['morethink', 'max', 'max'],
  ['lessthink', 'medium', 'low'],
  ['lessthink', 'low', 'low'],
  ['maxthink', 'high', 'high'],
  ['morethink', null, null],
  ['morethink', 2, 2],
])
  test(`${keyword} sends effort ${effort} on Opus as ${expected}`, () => {
    assert.equal(keywordEffort(DEFAULTS, keyword, 'opus', effort), expected);
  });

test('morethink skips an effort level the model does not list', () => {
  const config = {
    ...DEFAULTS,
    models: { ...DEFAULTS.models, opus: { ...DEFAULTS.models.opus, efforts: ['low', 'max'] } },
  };
  assert.equal(keywordEffort(config, 'morethink', 'opus', 'low'), 'max');
});

test('the up keywords raise and the down keywords lower', () => {
  assert.deepEqual(Object.keys(KEYWORDS).filter(keywordRaises), ['morethink', 'highthink', 'maxthink']);
});

for (const [keyword, band] of [
  ['maxthink', '↑ maxthink'],
  ['morethink', '↑ morethink'],
  ['nothink', '↓ nothink'],
  ['lessthink', '↓ lessthink'],
])
  test(`the band says ${band} for a ${keyword} turn, and /router says why`, () => {
    assert.equal(shortReason(keyword, null), band);
    assert.match(REASONS[keyword], new RegExp(`^${keyword} in the prompt: .+ for this turn$`));
  });
