// Files: user config, per-session memory and the decision log. The only module that touches the filesystem.
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

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

function memoryPath(dir, sessionId) {
  return join(dir, 'sessions', `${String(sessionId).replace(/[^\w.-]/g, '_')}.json`);
}
