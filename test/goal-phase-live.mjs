// Billed synthetic holdout for the actual System One adapter. Run manually with --live and a private env file.
import { buildRequest, parseAnswers } from '../lib/classifier-apis.mjs';
import { resolveCredentials } from '../lib/classifier-contract.mjs';
import { loadConfig } from '../lib/config.mjs';

if (process.argv[2] !== '--live') {
  console.error('Usage: node --env-file=/path/to/private.env test/goal-phase-live.mjs --live');
  process.exit(2);
}
const cases = [
  {
    text: 'Run the unit suite; do not investigate failures yet.',
    activeGoal: 'Implement the HTTP client and its unit tests, then verify it.',
    goal: 'code',
    phase: 'verify',
  },
  { text: 'Publish the already approved release with the documented command.', goal: 'ops', phase: 'execute' },
  {
    text: 'Run the suite and repair every failure.',
    activeGoal: 'Implement the client and its tests.',
    goal: 'code',
    phase: 'produce',
  },
  {
    text: 'Inspect the stack trace to determine why the build fails, then report the cause.',
    goal: 'debug',
    phase: 'reason',
  },
  {
    text: 'Check links in the README you just wrote.',
    activeGoal: 'Write a README with validated links.',
    goal: 'docs',
    phase: 'verify',
  },
  { text: 'Do the work from /tmp/missing-brief.md.', goal: 'uncertain', phase: 'uncertain' },
  {
    text: 'Review the changes for security problems and report findings; do not edit.',
    goal: 'review',
    phase: 'reason',
  },
  { text: 'Обнови клиент API и его тесты.', goal: 'code', phase: 'produce' },
];
const config = loadConfig();
const entry = config.classifiers.jev;
const credentials = await resolveCredentials(entry, (name) => process.env[name.toUpperCase()]?.trim());
if (credentials.missing) throw new Error(credentials.missing);
let valid = 0;
let correct = 0;
for (const item of cases) {
  const response = await fetch(credentials.endpoint, {
    method: 'POST',
    headers: { authorization: `Bearer ${credentials.apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify(buildRequest(config, item.text, [], { activeGoal: item.activeGoal })),
    signal: AbortSignal.timeout(6000),
  });
  if (!response.ok) throw new Error(`classifier HTTP ${response.status}`);
  const body = await response.json();
  if (body.model !== entry.model) throw new Error('Classifier model differs from configured version');
  const parsed = parseAnswers(config, body);
  if (!parsed.activity || !parsed.phase) throw new Error('Missing goal or phase');
  valid += 1;
  const matches = parsed.activity.choice === item.goal && parsed.phase.choice === item.phase;
  if (matches) correct += 1;
  console.log(
    JSON.stringify({
      expected: [item.goal, item.phase],
      actual: [parsed.activity.choice, parsed.phase.choice],
      matches,
    }),
  );
}
console.log(
  JSON.stringify({
    model: entry.model,
    cases: cases.length,
    valid,
    correct,
    note: 'Synthetic holdout; not real-task quality or calibration.',
  }),
);
