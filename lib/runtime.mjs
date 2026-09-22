// Process bootstrap shared by the daemon and the SessionStart hook: configuration and data directory from the environment.
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from './config.mjs';
import { readJsonFile } from './store.mjs';

export function loadRuntime(env) {
  const configPath = env.ROUTER_CONFIG ?? join(homedir(), '.claude', 'router.json');
  return {
    config: loadConfig({ env, userFile: readJsonFile(configPath) }),
    dataDir: env.CLAUDE_PLUGIN_DATA || join(tmpdir(), 'router'),
  };
}
