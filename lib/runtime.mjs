// Process bootstrap shared by the daemon and the hooks: configuration and data directory from the environment.
// A project's `.claude/settings.json` can set process env for a plugin hook (ROUTER_CONFIG, HOME, ...). `home`
// comes from the OS user database (`os.userInfo().homedir`), never from `$HOME`, so a project cannot redirect it.
// A `ROUTER_CONFIG` env value is honored only when it resolves inside `<home>/.claude/`; anywhere else it is
// ignored (with a warning that names the variable, never the rejected path) and the default file is used instead.
import { execFileSync } from 'node:child_process';
import { tmpdir, userInfo } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { loadConfig, TIERS } from './config.mjs';
import { readJsonFile } from './store.mjs';

// null for a UID without a passwd entry (`docker run --user <uid>`, devcontainers), where userInfo() throws. There
// the only home is $HOME, which a project can set, so there is no trusted home at all.
export function userHome(info = userInfo) {
  try {
    return info().homedir;
  } catch {
    return null;
  }
}

// Pure path resolution: no file access. `configPath` is an explicit `--config` value (unrestricted: it comes
// from a hook's own argv, which a project's settings cannot change) and wins over `env.ROUTER_CONFIG`.
// Without a trusted home the gateway runs on the defaults: starting beats an outage, and a project chooses nothing.
export function resolveConfigPath(env, { home = userHome(), configPath = null } = {}) {
  if (configPath) return { path: resolve(configPath), warning: null };
  if (!home) return { path: null, warning: 'no OS user account entry: router.json ignored, defaults used' };
  const fallback = join(home, '.claude', 'router.json');
  const requested = env.ROUTER_CONFIG;
  if (!requested) return { path: fallback, warning: null };
  const resolved = resolve(requested);
  const rel = relative(join(home, '.claude'), resolved);
  const inside = rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
  if (inside) return { path: resolved, warning: null };
  return { path: fallback, warning: 'ROUTER_CONFIG ignored: not under ~/.claude' };
}

// Whatever answers on the gateway port reports a pid; the hook signals it only if that pid runs this plugin's daemon.
// pid 0 or -1 would signal a process group or every process of the user, so neither reaches `ps` or `kill`.
export function isRouterGateway(pid, run = execFileSync) {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    return /scripts\/gateway\.mjs\b/.test(run('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }));
  } catch {
    return false; // no such process, or no ps: do not signal
  }
}

// `--flag value` from argv (e.g. `process.argv`). null when the flag is absent.
export function cliArg(argv, flag) {
  const i = argv.indexOf(flag);
  return i === -1 ? null : (argv[i + 1] ?? null);
}

export function loadRuntime(env, { home = userHome(), configPath = null, forceTier = null } = {}) {
  if (forceTier !== null && !TIERS.includes(forceTier))
    throw new Error(`--force-tier must be one of ${TIERS.join(', ')}`);
  const { path, warning } = resolveConfigPath(env, { home, configPath });
  const userFile = path ? readJsonFile(path) : null; // its own errors name the file
  let config;
  try {
    config = loadConfig({ env, userFile, forcedTier: forceTier });
  } catch (error) {
    throw new Error(`${path}: ${error.message}`);
  }
  return {
    config,
    dataDir: env.CLAUDE_PLUGIN_DATA || join(tmpdir(), 'router'),
    configPath: path,
    warning,
  };
}
