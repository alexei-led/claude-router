import assert from 'node:assert/strict';
import test from 'node:test';
import { buildRequest, parseAnswers } from '../lib/classifier-apis.mjs';
import { loadConfig } from '../lib/config.mjs';
import { continuedGoal } from '../lib/decisions.mjs';
import { activityDetailLines } from '../lib/display.mjs';
import { chooseRoute, emptyLoop, nativeFacts } from '../lib/route.mjs';
import { CLEARED_READINGS } from '../lib/view.mjs';
import { advice, jevResponse, user } from './helpers.mjs';

const phases = ['produce', 'reason', 'verify', 'execute', 'report', 'uncertain'];
const phase = (choice, probability = 0.95) => ({
  type: 'choice',
  choice,
  probabilities: Object.fromEntries(phases.map((p) => [p, p === choice ? probability : (1 - probability) / 5])),
});
const goal = { choice: 'code', probabilities: { code: 0.95, ops: 0.05 } };
const select = (config, answer, pin = null) => {
  const model = config.models.opus.id;
  const loop = emptyLoop(config, model);
  return chooseRoute(config, loop, {
    facts: nativeFacts(config, loop, {
      messages: [user('Run the test command.')],
      prompt: 'Run the test command.',
      effort: 'medium',
      turnId: 't',
      contextTokens: 8000,
    }),
    advice: { ...advice('medium', { medium: 0.99, low: 0.01 }), activity: goal, ...answer },
    pin,
    nativeModel: model,
    contextKnown: true,
    now: 1000,
  }).decision;
};

test('System One asks goal and phase independently with a bounded explicit anchor', () => {
  const config = loadConfig();
  const body = buildRequest(config, 'Run tests.', [], {
    activeGoal: 'Implement an endpoint.',
    currentStep: 'Run tests.',
  });
  assert.equal(body.questions.phase.type, 'choice');
  assert.deepEqual(Object.keys(body.questions.phase.criteria), phases);
  assert.equal(body.state.activeGoal.text, 'Implement an endpoint.');
  assert.equal(body.state.currentStep.text, 'Run tests.');
  assert.match(body.questions.activity.instructions.question, /goal|deliverable/i);
});

test('OpenAI asks independent phase and goal questions on the same evidence', () => {
  const config = loadConfig({ userFile: { classifier: 'openai' } });
  const body = buildRequest(config, 'Commit it.', [], { activeGoal: 'Implement the endpoint and commit it.' });
  assert.ok(body.questions.some((q) => q.name === 'phase' && q.type === 'choice'));
  assert.equal(JSON.parse(body.input).activeGoal.text, 'Implement the endpoint and commit it.');
});

test('phase is optional and malformed phase cannot weaken an otherwise valid goal', () => {
  const config = loadConfig();
  const raw = jevResponse('medium', { medium: 1 }, 0.9, { code: 0.95, ops: 0.05 });
  assert.equal(parseAnswers(config, raw).phase, null);
  for (const answer of [
    { type: 'refusal' },
    phase('unknown'),
    { ...phase('verify'), probabilities: { ...phase('verify').probabilities, unknown: 0.1 } },
    { ...phase('verify'), probabilities: { verify: 0.99 } },
    { ...phase('verify'), probabilities: Object.fromEntries(phases.map((p) => [p, 0.9])) },
    { ...phase('verify'), probabilities: { ...phase('verify').probabilities, verify: '0.95' } },
  ])
    assert.equal(parseAnswers(config, { ...raw, answers: { ...raw.answers, phase: answer } }).phase, null);
  assert.equal(
    parseAnswers(config, { ...raw, answers: { ...raw.answers, phase: phase('verify') } }).phase.choice,
    'verify',
  );
});

test('invalid continuation never replaces the goal and a low threshold never makes ambiguity positive', () => {
  const config = loadConfig();
  const raw = jevResponse('medium', { medium: 1 }, 0.9, { code: 1 });
  for (const value of [undefined, '1', -1, 2]) {
    const parsed = parseAnswers(config, {
      ...raw,
      answers: { ...raw.answers, continuation: { type: 'noul', noul: value } },
    });
    assert.equal(parsed.continuation, null);
    assert.equal(continuedGoal('old', 'new', parsed.continuation, 0.7), null);
  }
  assert.equal(continuedGoal('old', 'new', 0.5, 0.3), null);
  for (const value of [null, 0.5, 0.9]) assert.equal(continuedGoal(null, 'Yes, proceed.', value, 0.7), null);
  assert.equal(continuedGoal(null, 'Implement the service.', 0.1, 0.7), 'Implement the service.');
  assert.equal(continuedGoal('old', 'new', 0.9, 0.7), 'old');
  assert.equal(continuedGoal('old', 'new', 0.1, 0.7), 'new');
});

test('OpenAI phase choices are strict and a refused phase preserves the goal', () => {
  const config = loadConfig({ userFile: { classifier: 'openai' } });
  const raw = {
    answers: [
      {
        type: 'choice',
        name: 'route',
        choice: 'medium',
        confidence: 0.9,
        probabilities: [{ value: 'medium', probability: 1 }],
      },
      { type: 'choice', name: 'activity', choice: 'code', probabilities: [{ value: 'code', probability: 1 }] },
      {
        type: 'choice',
        name: 'phase',
        choice: 'verify',
        probabilities: phases.map((p) => ({ value: p, probability: p === 'verify' ? 1 : 0 })),
      },
    ],
  };
  assert.equal(parseAnswers(config, raw).phase.choice, 'verify');
  raw.answers[1].probabilities.push({ value: 'code', probability: 0.1 });
  assert.equal(parseAnswers(config, raw).activity, null);
  raw.answers[1].probabilities = [
    { value: 'code', probability: 0.65 },
    { value: 'unknown', probability: 0.35 },
  ];
  assert.equal(parseAnswers(config, raw).activity, null);
  raw.answers[1].probabilities = [{ value: 'code', probability: 1 }];
  raw.answers[2] = { type: 'refusal', name: 'phase' };
  assert.equal(parseAnswers(config, raw).phase, null);
  assert.equal(parseAnswers(config, raw).activity.choice, 'code');
});

test('bounded verify/execute can use ops without losing the code goal; other phases cannot', () => {
  const config = loadConfig();
  for (const name of phases) {
    const decision = select(config, { phase: phase(name) });
    assert.equal(decision.goal, 'code', name);
    assert.equal(decision.taskPhase, name === 'uncertain' ? null : name, name);
    assert.equal(decision.activity, ['verify', 'execute'].includes(name) ? 'ops' : 'code', name);
    assert.equal(decision.model, config.models[['verify', 'execute'].includes(name) ? 'haiku' : 'opus'].id, name);
  }
});

test('changing classifier does not relabel a retained ops route as the task goal', () => {
  const config = loadConfig();
  const view = {
    activity: 'ops',
    goal: 'code',
    taskPhase: 'verify',
    activityChoice: 'code',
    activityProbabilities: { code: 1 },
  };
  assert.ok(activityDetailLines(config, view).includes('Goal: code (100%)'));
  const cleared = { ...view, ...CLEARED_READINGS };
  assert.equal(cleared.goal, null);
  assert.equal(cleared.taskPhase, null);
  assert.ok(activityDetailLines(config, cleared).includes('Activity: ops'));
  assert.ok(!activityDetailLines(config, cleared).some((line) => line.startsWith('Goal: ops')));
});

test('missing, uncertain, or weak phase keeps goal routing and does not bypass activity off or a pin', () => {
  const config = loadConfig();
  for (const answer of [{}, { phase: phase('uncertain') }, { phase: phase('verify', 0.4) }]) {
    const decision = select(config, answer);
    assert.equal(decision.activity, 'code');
    assert.equal(decision.model, config.models.opus.id);
  }
  const pinned = select(config, { phase: phase('verify') }, 'medium');
  assert.equal(pinned.activity, null);
  assert.equal(pinned.goal, null);
  assert.equal(pinned.taskPhase, null);
  assert.equal(pinned.model, config.models.opus.id);
  const unknown = select(config, {
    activity: { choice: 'uncertain', probabilities: { uncertain: 1 } },
    phase: phase('verify'),
  });
  assert.equal(unknown.activity, null);
  assert.equal(unknown.model, config.models.opus.id);
  const off = loadConfig({ userFile: { activityRouting: 'off' } });
  assert.equal(select(off, { phase: phase('verify') }).activity, null);
});
