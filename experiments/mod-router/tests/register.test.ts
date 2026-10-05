import { expect, test } from 'claude-code/testing';

test('routes once per turn, keeps tool continuations, preserves chunks and actual usage', async ($, on) => {
  const requests: { model: string; effort?: string | number; index: number }[] = [];
  on('turn.start', (_$, e) => ({ turnId: e.turnId }));
  on('ui.log', () => ({ value: undefined }));
  on('turn.step', async function* (_$, e) {
    requests.push({ model: e.model, effort: e.effort, index: e.index });
    yield { kind: 'text', index: 0, text: 'unchanged' };
    return {
      turnId: e.turnId,
      index: e.index,
      answer: 'unchanged',
      toolUses: [],
      stopReason: 'end_turn' as const,
      usage: {
        model: 'claude-sonnet-actual',
        input_tokens: 3,
        output_tokens: 1,
        cache_read_input_tokens: 2,
        cache_creation_input_tokens: 0,
      },
    };
  });
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['other mod'] }));
  await $.turn.start({ turnId: 't', text: '[router-mod:sonnet] Reply OK.' });
  for (const index of [0, 1]) {
    const stream = $.turn.step({ turnId: 't', index, model: 'opus', effort: 'high', messageCount: index + 1 });
    let step = await stream.next();
    expect(step.value).toEqual({ kind: 'text', index: 0, text: 'unchanged' });
    while (!step.done) step = await stream.next();
    expect(step.value.usage?.cache_read_input_tokens).toBe(2);
  }
  expect(requests).toEqual([
    { model: 'claude-sonnet-5-5', effort: 'low', index: 0 },
    { model: 'claude-sonnet-5-5', effort: 'low', index: 1 },
  ]);
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'router-mod-probe',
      surface,
      component: 'AbovePrompt',
      requestId: 'band',
      viewport: { columns: 100, rows: 30 },
      props: {
        hasSurvey: false,
        isWorking: false,
        maxRows: 4,
        bodyColumns: 100,
        scroll: { offset: 0, bodyRows: 4 },
        view: {},
      },
    });
    expect(await ui.find({ type: 'Text', text: 'Router probe: claude-sonnet-actual' })).toBeDefined();
    expect(await ui.find({ type: 'Text', text: 'other mod' })).toBeDefined();
    await ui.unmount();
  }
});

test('unmarked prompts, subagents and unrelated turns pass through', async ($, on) => {
  const models: string[] = [];
  on('turn.start', (_$, e) => ({ turnId: e.turnId }));
  on('turn.step', async function* (_$, e) {
    models.push(e.model);
    yield* [];
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: null, usage: null };
  });
  await $.turn.start({ turnId: 'plain', text: 'Reply OK.' });
  const plain = $.turn.step({ turnId: 'plain', index: 0, model: 'opus', messageCount: 1 });
  await plain.next();
  await $.turn.start({ turnId: 'marked', text: '[router-mod:sonnet] Reply OK.' });
  for (const fields of [{ turnId: 'marked', agentId: 'worker' }, { turnId: 'other' }]) {
    await $.turn.step({ ...fields, index: 0, model: 'opus', messageCount: 1 }).next();
  }
  expect(models).toEqual(['opus', 'opus', 'opus']);
});

test('haiku drops inherited effort and a failed response is passed through', async ($, on) => {
  on('turn.start', (_$, e) => ({ turnId: e.turnId }));
  on('ui.log', () => ({ value: undefined }));
  on('turn.step', async function* (_$, e) {
    expect(e.model).toBe('claude-haiku-4-5');
    expect(e.effort).toBeUndefined();
    yield* [];
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: null, usage: null };
  });
  await $.turn.start({ turnId: 't', text: '[router-mod:haiku] Reply OK.' });
  const step = await $.turn.step({ turnId: 't', index: 0, model: 'opus', effort: 'max', messageCount: 1 }).next();
  expect(step.done).toBe(true);
  if (!step.done) throw new Error('unexpected response chunk');
  expect(step.value.usage).toBeNull();
});
