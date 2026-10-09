import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { buildRequest, parseAnswers } from '../lib/classifier-apis.mjs';
import { ACTIVITY_CRITERIA, ACTIVITY_INSTRUCTIONS, resolveCredentials } from '../lib/classifier-contract.mjs';
import { ACTIVITIES, ACTIVITY_VALUES, DEFAULTS, loadConfig } from '../lib/config.mjs';

const config = loadConfig();
const liveClefFlashAnswer = JSON.parse(readFileSync(new URL('./fixtures/clef-flash-response.json', import.meta.url)));

test('request carries every tier with its route, an uncertain option and a continuation question', () => {
  const body = buildRequest(config, 'do x', [{ role: 'user', text: 'hi' }]);
  assert.deepEqual(Object.keys(body.questions.route.criteria), ['micro', 'low', 'medium', 'high', 'uncertain']);
  assert.deepEqual(body.questions.route.criteria.high.route, { model: 'opus', effort: 'xhigh' });
  assert.equal(body.questions.continuation.type, 'noul');
  assert.equal(body.state.currentRequest.text, 'do x');
});

test('request names the active classifier model', () => {
  for (const id of Object.keys(DEFAULTS.classifiers)) {
    const body = buildRequest(loadConfig({ userFile: { classifier: id } }), 'do x', []);
    assert.equal(body.model, DEFAULTS.classifiers[id].model, id);
  }
});

for (const [name, body] of [
  ['missing route', { answers: {} }],
  ['wrong type', { answers: { route: { type: 'score', probabilities: {} } } }],
  ['unknown choice', { answers: { route: { type: 'choice', choice: 'opus', probabilities: {} } } }],
  ['a Cloudflare error envelope', { result: null, success: false, errors: [{ code: 5007, message: 'x' }] }],
  ['a Cloudflare envelope with no answers', { result: { model: 'clef' }, success: true, errors: [] }],
]) {
  test(`rejects ${name}`, () => {
    assert.throws(() => parseAnswers(config, body), /classifier/);
  });
}

test('a Cloudflare answer reads the same as a bare one', () => {
  const advice = parseAnswers(config, liveClefFlashAnswer);
  assert.deepEqual(advice, parseAnswers(config, liveClefFlashAnswer.result));
  assert.equal(advice.choice, 'micro');
  assert.equal(advice.probabilities.micro, 0.5923);
  assert.equal(advice.continuation, 0.0164);
});

test('missing probabilities and continuation degrade to zero and null', () => {
  const advice = parseAnswers(config, {
    answers: { route: { type: 'choice', choice: 'low', confidence: 2, probabilities: { low: 1 } } },
  });
  assert.equal(advice.probabilities.high, 0);
  assert.equal(advice.confidence, 1);
  assert.equal(advice.continuation, null);
});

test('a classifier with no key option reads its endpoint without a key', async () => {
  const { ollama } = DEFAULTS.classifiers;
  assert.deepEqual(await resolveCredentials(ollama, async () => 'ignored'), {
    apiKey: null,
    endpoint: ollama.endpoint,
    missing: null,
  });
});

test('credentials fill endpoint settings and report what is missing, key first', async () => {
  const { jev, clef } = DEFAULTS.classifiers;
  const cloudflare = (account) => `https://api.cloudflare.com/client/v4/accounts/${account}/ai/run/@cf/cloudflare/clef`;
  for (const [name, entry, settings, expected] of [
    ['Jev with its key', jev, { typesafe_api_key: 'k' }, { apiKey: 'k', endpoint: jev.endpoint, missing: null }],
    [
      'Jev without a key',
      jev,
      { cloudflare_api_token: 't' },
      { apiKey: null, endpoint: jev.endpoint, missing: 'missing-key' },
    ],
    [
      'Clef with token and account',
      clef,
      { cloudflare_api_token: 't', cloudflare_account_id: 'abc123' },
      { apiKey: 't', endpoint: cloudflare('abc123'), missing: null },
    ],
    [
      'Clef without an account',
      clef,
      { cloudflare_api_token: 't' },
      { apiKey: 't', endpoint: null, missing: 'missing-account' },
    ],
    ['Clef with nothing', clef, {}, { apiKey: null, endpoint: null, missing: 'missing-key' }],
    [
      'an account that would change the path',
      clef,
      { cloudflare_api_token: 't', cloudflare_account_id: '../x?y' },
      { apiKey: 't', endpoint: cloudflare('..%2Fx%3Fy'), missing: null },
    ],
  ]) {
    assert.deepEqual(await resolveCredentials(entry, async (option) => settings[option]), expected, name);
  }
});

test('the activity criteria name what each activity produces, one entry per answer', () => {
  assert.deepEqual(Object.keys(ACTIVITY_CRITERIA), ACTIVITY_VALUES);
  for (const activity of ACTIVITY_VALUES.filter((value) => value !== 'uncertain')) {
    assert.match(ACTIVITY_CRITERIA[activity].covers, /^Produces /, activity);
    assert.ok(ACTIVITY_CRITERIA[activity].notFor.length > 0, activity);
  }
  assert.equal(typeof ACTIVITY_INSTRUCTIONS.question, 'string');
  assert.ok(ACTIVITY_INSTRUCTIONS.judge.some((rule) => /untrusted data/.test(rule)));
});

test('the activity probe set holds ten synthetic prompts per activity', () => {
  const { probes } = JSON.parse(readFileSync(new URL('./fixtures/activity-probe.json', import.meta.url)));
  for (const activity of ACTIVITIES)
    assert.equal(probes.filter((probe) => probe.expected === activity).length, 10, activity);
  assert.equal(probes.length, ACTIVITIES.length * 10);
  for (const { text, dialogue = [] } of probes) {
    assert.equal(typeof text, 'string');
    for (const turn of dialogue) assert.ok(['user', 'assistant'].includes(turn.role) && typeof turn.text === 'string');
  }
});
