#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { evaluateReplay } from '../lib/replay.mjs';

const args = process.argv.slice(2);
if (args.length === 1 && args[0] === '--help') {
  console.log(
    'Usage: node scripts/replay-traces.mjs [--reversal-window N] router-traces.json router-traces-*.json\nReads explicit files (shell-expanded globs), prints anonymous JSON; never changes router configuration.',
  );
} else {
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
    console.log(JSON.stringify(report, null, 2));
    if (report.status !== 'ok') process.exitCode = 1;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
