import assert from 'node:assert/strict';
import test from 'node:test';
import { ACTIVITIES } from '../lib/config.mjs';
import { matchesTask, TASKS, usageUsd } from '../scripts/probe-provider-routes.mjs';

test('provider microchecks cover every activity and reject malformed or wrong JSON', () => {
  assert.deepEqual(TASKS.map((t) => t.activity).sort(), [...ACTIVITIES].sort());
  for (const { expected } of TASKS) {
    const text = JSON.stringify(expected);
    assert.ok(matchesTask(text, expected));
    assert.ok(matchesTask(`\`\`\`json\n${text}\n\`\`\``, expected));
    assert.equal(matchesTask('{}', expected), false);
    assert.equal(matchesTask('not JSON', expected), false);
  }
});

test('probe pricing keeps unknown usage unknown and includes cache writes and reads', () => {
  const spec = { input: 1, output: 4, cacheRead: 0.1 };
  assert.equal(
    usageUsd(spec, {
      input_tokens: 100,
      output_tokens: 10,
      cache_creation_input_tokens: 20,
      cache_read_input_tokens: 1000,
    }),
    0.00026,
  );
  assert.equal(usageUsd(spec, { input_tokens: 100, output_tokens: 10 }), 0.00014);
  for (const usage of [null, {}, { input_tokens: 2 }, { input_tokens: -1, output_tokens: 1 }])
    assert.equal(usageUsd(spec, usage), null);
});
