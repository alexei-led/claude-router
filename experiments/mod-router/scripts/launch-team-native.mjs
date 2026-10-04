import { spawn } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { nativeLaunchSettings, prepareNativeCandidate } from './native-candidate.mjs';

const directory = await prepareNativeCandidate();
const child = spawn(
  join(homedir(), '.claude/scripts/ce'),
  [
    'peer-team',
    '--plugin-dir',
    directory,
    '--model',
    'claude-sonnet-5-5',
    '--settings',
    JSON.stringify(nativeLaunchSettings()),
    ...process.argv.slice(2),
  ],
  { stdio: 'inherit' },
);
child.on('error', (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
child.on('close', async (code, signal) => {
  await rm(directory, { recursive: true, force: true });
  process.exitCode = code ?? (signal ? 1 : 0);
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
