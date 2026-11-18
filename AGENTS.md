# Agent rules

Rules that most often break a build or a review. The full guide is [CONTRIBUTING.md](CONTRIBUTING.md).

1. Install tools with `npm run setup`. Never run `npm install` at the root, and never add a root lockfile or a runtime dependency.
2. Before you push, run `npm run check`, `npm run typecheck`, `npm test` and `npm run test:plugin`. Report any you could not run.
3. Every function that takes the engine's `$` lives in `hooks/native-router.mjs`. Never pass `$` into `lib/`.
4. `lib/` is pure: no `$`, no file, network or clock of its own, no module state. `ui.render` hooks write no state while they draw.
5. Models in `lib/ui/model/` are plain data; renderers in `terminal/` and `graphical/` never read config or `view`. Every colour comes from `lib/ui/tokens.mjs`.
6. No `!` non-null assertion, no `@ts-ignore`, no new `any`. `biome-ignore` only with a one-line reason.
7. A bug fix starts with a regression test that fails first. Use the helpers in `test/harness.mjs`; do not hand-roll element stubs.
8. Change a golden (`test/fixtures/ui-golden/`) only for an intended UI change, with `UPDATE_GOLDEN=1`, and read the diff.
9. Use no engine API newer than `MIN_CLAUDE_CODE` in `lib/config.mjs` (2.1.321).
10. A user-visible change adds a `CHANGELOG.md` line under `## Unreleased`. Do not bump the version.
11. Never commit secrets or keys, and never show a key in output or an error. Never push to `main`; branch first.

Read CONTRIBUTING.md before you start.
