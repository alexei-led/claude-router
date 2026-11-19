#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { evaluateReplay } from '../lib/replay.mjs';

const USAGE =
  'Usage: node scripts/replay-traces.mjs [--reversal-window N] router-traces.json router-traces-*.json\nReads explicit files (shell-expanded globs), prints anonymous JSON; never changes router configuration.';

// Returns the exit status; `io` is where the output goes.
export async function main(args, { log = console.log, error = console.error } = {}) {
  if (args.length === 1 && args[0] === '--help') {
    log(USAGE);
    return 0;
  }
  try {
    let reversalWindow = 3;
    const files = [];
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--reversal-window') reversalWindow = Number(args[++i]);
      else if (args[i].startsWith('--')) throw new Error('Unknown option; use --help.');
      else files.push(args[i]);
    }
    if (!files.length) throw new Error('Provide all incremental trace export files; use --help.');
    const exports = [];
    for (let i = 0; i < files.length; i++) {
      try {
        exports.push(JSON.parse(await readFile(files[i], 'utf8')));
      } catch {
        throw new Error(`Cannot read/parse export input ${i + 1}.`);
      }
    }
    const report = evaluateReplay(exports, { reversalWindow });
    log(JSON.stringify(report, null, 2));
    return report.status === 'ok' ? 0 : 1;
  } catch (e) {
    error(e.message);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  process.exitCode = await main(process.argv.slice(2));
