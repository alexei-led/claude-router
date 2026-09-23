// Files: user config, per-session memory and the decision log. The only module that touches the filesystem.
import {
  appendFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

export const LOG_LIMIT_BYTES = 20 * 1024 * 1024;
const SESSION_TTL_MS = 30 * 24 * 3_600_000;

export function readJsonFile(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error(`cannot read ${path}: ${error.message}`);
  }
}

export function loadMemory(dir, sessionId, fallback) {
  try {
    return { ...fallback, ...JSON.parse(readFileSync(memoryPath(dir, sessionId), 'utf8')) };
  } catch {
    return fallback;
  }
}

export function saveMemory(dir, sessionId, memory) {
  mkdirSync(join(dir, 'sessions'), { recursive: true });
  const path = memoryPath(dir, sessionId);
  writeFileSync(`${path}.tmp`, JSON.stringify(memory));
  renameSync(`${path}.tmp`, path);
}

export function appendLog(dir, entry) {
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, 'decisions.jsonl'), `${JSON.stringify(entry)}\n`);
}

// Keeps one previous generation: `<file>.1`. Only for files written by path, not held open.
export function rotate(path, limitBytes = LOG_LIMIT_BYTES) {
  try {
    if (statSync(path).size > limitBytes) renameSync(path, `${path}.1`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

// Bounds the data directory of a long-running gateway: the decision log and a month of session memory.
// gateway.log is the daemon's open stderr, so the hook that starts the daemon rotates it instead.
export function housekeeping(dir, now = Date.now()) {
  rotate(join(dir, 'decisions.jsonl'));
  const sessions = join(dir, 'sessions');
  let names;
  try {
    names = readdirSync(sessions);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  for (const name of names) {
    const path = join(sessions, name);
    if (now - statSync(path).mtimeMs > SESSION_TTL_MS) rmSync(path, { force: true });
  }
}

function memoryPath(dir, sessionId) {
  return join(dir, 'sessions', `${String(sessionId).replace(/[^\w.-]/g, '_')}.json`);
}
