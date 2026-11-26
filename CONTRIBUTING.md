# Contributing

This guide is for people and for AI coding agents. [AGENTS.md](AGENTS.md) is the short rule list; this file is the full one.

## What this is

Router is a Claude Code Mod: hooks that choose the model and effort of each turn. It has zero runtime npm dependencies. All engine calls live in `hooks/native-router.mjs`; the logic lives in `lib/`. Dev tools are installed under `tools/`, never at the repo root.

## Set up and commands

Needs Node 22 or newer (`engines`; CI runs 24.15.0) and `claude` on `PATH` for `validate`, `test:plugin` and `test:providers`. Run `npm run setup` once. It installs Biome and TypeScript into `tools/`. Never run `npm install` at the root: the plugin root keeps no lockfile, so Claude Code installs nothing with the plugin, and a test fails on a root lockfile.

To run the router from a checkout, start Claude Code in it with the directory as a local plugin and the full Haiku baseline model. Load only one copy of the router in a session:

```sh
claude --plugin-dir "$PWD" --model claude-haiku-5-5
```

In Claude Code, run `/plugin configure router` and save your classifier key in the sensitive plugin option. The Mod adds its status band and `/router` pane; no status-line setup or gateway environment variables are needed. The [user guide](docs/user-guide.md) covers the controls.

Before a push, run the same checks as CI. `validate` and `test:plugin` load the Mod in the Claude Code engine, which refuses some faults that lint and unit tests miss:

```sh
npm run check && npm run typecheck && npm test && npm run validate && npm run test:plugin
```

| Command                | What it checks                                                                          | When                          |
| ---------------------- | --------------------------------------------------------------------------------------- | ----------------------------- |
| `npm run setup`        | Installs Biome and TypeScript into `tools/` (`npm ci --prefix tools --ignore-scripts`)                   | Once per clone                |
| `npm run check`        | Biome lint and format; a warning fails                                                  | Before every commit           |
| `npm run typecheck`    | `tsc` over `lib/` and `hooks/`, `strictNullChecks`, `noUncheckedIndexedAccess`          | Before every commit           |
| `npm test`             | Unit tests (`test/*.test.mjs`, `experiments/mod-router/scripts/*.test.mjs`), 8 s each   | While you work               |
| `npm run test:ci`      | The same files with the CI reporter that annotates changed lines                        | Only to reproduce CI output   |
| `npm run test:plugin`  | Engine tests: `test/*.test.ts` run only here, through `claude plugin test`              | Before pushing                |
| `npm run validate`     | `claude plugin validate` on the plugin and marketplace manifests                        | Before pushing                |
| `npm run format`       | Rewrites formatting with Biome                                                          | When `check` reports format   |
| `npm run docs:images`  | Redraws `docs/*.svg` from the real renderers                                            | Only when the terminal UI changed |
| `npm run docs:desktop-images` | Redraws `docs/images/*.png` (desktop, VS Code and mobile band and pane) through headless Chrome | Only when the graphical UI changed |
| `npm run test:providers` | Real Claude Code and the Mod against a loopback Messages API; no credentials or paid calls | Before pushing a provider change |
| `npm run docs:modes`   | Rewrites the matrix in `docs/routing-modes.md`; `npm test` fails when it is stale        | After a change to modes or default routes |
| `npm run prices:check` | Compares `lib/prices.mjs` with each vendor's price page (`--write` rewrites it)          | When prices may have changed  |
| `npm run probe:results` | Regenerates `lib/probe-results.mjs` from the activity probe results                     | After a probe run             |
| `npm run pack:dry`     | `npm pack --dry-run`: what the package would ship                                       | Before pushing                |

`scripts/git-hooks/` holds `pre-commit` (staged Biome, ShellCheck, gitleaks) and `pre-push` (`check`, `typecheck`, `test`, `pack:dry`, `validate`, `test:plugin`, gitleaks). Enable them with `git config core.hooksPath scripts/git-hooks`; they need `gitleaks` installed.

**Claude Code floor.** The minimum version is `MIN_CLAUDE_CODE` in `lib/config.mjs` (2.1.321). CI installs exactly that build for `validate` and `test:plugin`. Never use an engine API that exists only in a newer build; `BACKLOG.md` lists what waits for a higher floor. `test:plugin` uses the `claude` on your `PATH`, so a green run on a newer build does not prove the floor.

## Architecture

Read [docs/architecture.md](docs/architecture.md) first, in particular Responsibilities and UI layout. The dependency direction is one way:

```
hooks/native-router.mjs  ->  lib/*.mjs  ->  lib/ui/model/  ->  lib/ui/terminal/ | lib/ui/graphical/
```

| You change                | Put it in                                                                                   |
| ------------------------- | ------------------------------------------------------------------------------------------- |
| A routing rule            | `lib/policy.mjs`, `lib/route.mjs`, `lib/activity.mjs`; docs in `docs/architecture.md`        |
| A config key              | `DEFAULTS` and validation in `lib/config.mjs`; document it in `docs/configuration.md`        |
| A `/router` word          | One row in `lib/subcommands.mjs`, one `case` in `runSubcommand` in the hook                  |
| A pane tab                | `lib/panel.mjs` tab table, a model in `lib/ui/model/`, a renderer in `terminal/` and `graphical/` |
| A band segment            | `lib/ui/model/band.mjs`; the band renderers only draw segments                               |
| A colour                  | `lib/ui/tokens.mjs`                                                                          |

Rules that keep the layers apart:

- `lib/` is pure: no `$`, no `node:fs` or `fetch` (the hook passes them in), no module state.
- `$` is never passed across an import. Every function that takes `$` lives in `hooks/native-router.mjs`; the engine does not follow `$` into an imported function (see the comment at the top of the hook).
- Models are plain data and renderers draw them. `terminal/` and `graphical/` never read config or `view`; if a renderer needs a fact, the model carries it.
- Every colour comes from `lib/ui/tokens.mjs`. A renderer that writes its own colour escapes the theme.
- A `ui.render` hook is pure: it writes no state while it draws.
- One source of truth per rule. `SUBCOMMANDS` feeds the command, its argument hint and its typeahead; add to the table, not to three places.

## Code style

- Biome formats: 2 spaces, single quotes, 120 columns (`biome.json`). Run `npm run format`.
- ESM `.mjs` with JSDoc types. `tsc` runs with `strictNullChecks` and `noUncheckedIndexedAccess`: no `!`, no `@ts-ignore`, avoid `any`, and model a value that can be missing as missing.
- Import Node built-ins with the `node:` prefix.
- A name says what the thing means. A comment says why, not what.
- No speculative options, flags or compatibility shims. Delete dead code; never comment it out. No `TODO` in place of in-scope work: put deferred ideas in `BACKLOG.md`.
- `biome-ignore` needs a one-line reason (see `lib/project-routing.mjs`).
- An error names the setting, never its value. Never log or show a key.

## Tests

- Name a test as a sentence of behaviour: `a resumed subagent keeps its first spawn's model`.
- One area per file, named after the unit: `test/<unit>.test.mjs`.
- A matrix is one `test()` per row, not a loop in one test.
- Use the helpers in `test/harness.mjs`: `harness()` (the engine stand-in), `recorder`, `quiet`, `find`, `texts`, `press`. Its element stubs refuse what the engine refuses; do not hand-roll your own.
- Mock only boundaries: network, files, clock, processes. Inject `now`; never wait on a real timer, and never depend on the time zone or machine load. A test with a real child process needs a generous deadline.
- A bug fix starts with a regression test that fails for the right reason. Run it before the fix and read the failure.
- Assert what a person sees: the label equals what pressing the button runs. Do not assert styling props.
- Goldens in `test/fixtures/ui-golden/*.txt` pin terminal output. Change them only for an intended UI change: `UPDATE_GOLDEN=1 node --test test/ui-golden.test.mjs`, then read the diff. Route goldens (`test/route-golden.test.mjs`) use `GOLDEN_WRITE=1` instead.
- `test/*.test.ts` are engine tests, for what only the engine can refuse. They run under `npm run test:plugin`, not `npm test`.

## Lessons from review

- A label or doc that names a model must be tested against what actually runs. Pin labels went wrong more than once (`CHANGELOG.md` 1.25.0, Fixed).
- Fixing the quoted line is not enough. Search for the same construct everywhere.
- Measure through the hook before you assume a rule holds; a unit test of `lib/` does not prove what the engine does.
- `shownConfig` is the mode-adjusted display config. Do not read it where the configured route runs.
- `turn.start` also fires for subagents. Check `agentId` (the hook starts a main turn only when it is undefined).
- A resumed subagent's spawn can only be refused: it keeps the model of its first spawn.
- A workflow agent's own type does not apply: it is always `workflow-subagent` (`lib/subagents.mjs`).

## Pull requests

- Branch from `main` (a `git worktree` is fine). One concern per PR; small commits with conventional prefixes (`fix:`, `feat:`, `docs:`, `test:`, `refactor:`) and a body that says why.
- Before pushing run `npm run check`, `typecheck`, `test` and `test:plugin`.
- A user-visible change adds a line to `CHANGELOG.md` under `## Unreleased` (create it if absent), in the user's words. Do not bump the version; the maintainer cuts releases.
- Update the docs your change makes stale: [user guide](docs/user-guide.md), [configuration](docs/configuration.md), [architecture](docs/architecture.md).
- Run `npm run docs:images` only when the terminal UI changed, and commit the changed `docs/*.svg`. Run `npm run docs:desktop-images` only when the graphical UI changed (`lib/ui/graphical/`, `lib/ui/model/`), and commit the changed `docs/images/*.png`; it needs Chrome (`CHROME` names the binary) and ImageMagick to shrink the PNGs.
- CI runs four jobs, each with annotations on the changed lines: `Lint (biome)`, `Types (tsc)`, `Unit tests (node --test)`, `Plugin (validate and engine tests)`. Fork PRs need a maintainer to approve the first run.
- Never commit secrets, keys or a root lockfile. Never push to `main`.

## Pointers

Start with the [architecture](docs/architecture.md), then the [user guide](docs/user-guide.md) and [configuration](docs/configuration.md). Coding agents start with [AGENTS.md](AGENTS.md).

- [User guide](docs/user-guide.md): install, use the controls, read the panel, and troubleshoot.
- [Providers](docs/providers.md): provider names, router files, built-in defaults, and custom profiles.
- [Configuration](docs/configuration.md): router-file settings, classifier keys, cache policies, and migrations.
- [Architecture](docs/architecture.md): Mod event flow, state, safeguards, and runtime boundaries.
- [Activity routing](docs/activity-routing.md): the default matrix by activity, why each cell, and how to change or turn it off.
- [Routing modes](docs/routing-modes.md): `cost`, `balanced` and `quality`, where the mode comes from, and every decision per mode.
- [Native router details](docs/native-router.md): panel semantics, tuning, and accepted limits.
- [Automatic routing engine](docs/auto-engine.md): the opt-in `auto` engine's inputs, rules and limits.
- [Model evidence](docs/evidence.md): benchmark data and probes behind the `auto` engine's capability map.
- [Provider experiments](docs/provider-experiments.md): MiniMax, MiMo and Kimi evidence behind the default routes.
- [Evaluation](docs/evaluation.md): limits, text-free trace export and replay, and the paired benchmark proposal.
- [Changelog](CHANGELOG.md): user-visible changes by version.
