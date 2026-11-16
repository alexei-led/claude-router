import { expect, test } from 'claude-code/testing';
import { loadConfig } from '../lib/config.mjs';
import { newTrace, traceBytes, usableTrace } from '../lib/replay-trace.mjs';
import { emptyLoop } from '../lib/route.mjs';

test('replay projection and UTF-8 byte accounting run inside the Mod sandbox', () => {
  const config = loadConfig();
  const loop = emptyLoop(config, config.models.haiku.id);
  const record = newTrace(1000, { configured: config, config, loop });
  expect(usableTrace(record)).toBe(true);
  expect(traceBytes('€')).toBe(5);
  expect(traceBytes(record) > 0).toBe(true);
});
