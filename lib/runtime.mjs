// Process bootstrap shared by the daemon and the hooks: configuration and data directory from the environment.
// A project's `.claude/settings.json` can set process env for a plugin hook (ROUTER_CONFIG, HOME, ...). `home`
// comes from the OS user database (`os.userInfo().homedir`), not from `$HOME`, so a project cannot redirect it.
// A `ROUTER_CONFIG` env value is honored only when it resolves inside `<home>/.claude/`; anywhere else it is
// ignored (with a warning that names the variable, never the rejected path) and the default file is used instead.
import { execFileSync } from 'node:child_process';
import { homedir, tmpdir, userInfo } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { loadConfig, TIERS } from './config.mjs';
import { readJsonFile } from './store.mjs';

// A UID without a passwd entry (`docker run --user <uid>`, devcontainers) makes userInfo() throw. There the only
// home there is comes from $HOME; refusing to start would take every session down with it.
export function userHome(info = userInfo, envHome = homedir) {
  try {
    return info().homedir;
  } catch {
    return envHome();
  }
}

// Pure path resolution: no file access. `configPath` is an explicit `--config` value (unrestricted: it comes
// from a hook's own argv, which a project's settings cannot change) and wins over `env.ROUTER_CONFIG`.
export function resolveConfigPath(env, { home = userHome(), configPath = null } = {}) {
  const fallback = join(home, '.claude', 'router.json');
  if (configPath) return { path: resolve(configPath), warning: null };
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
  const userFile = readJsonFile(path); // its own errors name the file
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
