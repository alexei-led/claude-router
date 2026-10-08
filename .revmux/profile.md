# Project profile: Router (claude-model-router)

## What it is

- A Claude Code Mod: `hooks/native-router.mjs` registers engine hooks and rewrites only `model` and `effort` of main-conversation requests. Subagent turns pass through.
- `lib/*.mjs` is pure logic: config, `router.json` rewrites and Undo (`config-file`), policy, cost estimates (`cost`), the classifier contract and client (`classifier-contract`, `classifier-client`), route control (`route`), the view shape (`view`), band and pane rendering (`band`, `panel`, `display`). Only the hooks module touches the host, and only through `$`: no Node APIs, no process, no port.
- `hooks/native-router.mjs` is one file by engine rule: `$` is never passed across an import, so every helper that takes `$` (view and mode state, settings and credentials, `router.json` I/O, `decideTurn`, `paneActions`) lives there. `register()` keeps the mutable runtime in one `router` object it passes to those helpers.
- Shipped as npm `@alexeiled/claude-router` and marketplace plugin `router@alexei-led-claude-router`. One maintainer, small user base, but it sits in every routed turn of every user.
- `experiments/mod-router/` is a research probe with acceptance scripts. It is not shipped; `results/*.json` are recorded evidence.
- Languages: JavaScript ESM, TypeScript declarations and engine tests, Markdown, some bash and GitHub Actions YAML.

## Real failures

- The hooks module does not load or a hook throws. The engine then skips the Mod silently. Known triggers: a binding that shadows `next`, `$.command.run` inside a `command.run` hook, `$` passed to a function imported from another file (`claude plugin validate` refuses it), a `ui.render` tree the surface refuses.
- A turn goes to the wrong model or effort; a request is rewritten after an engine fallback or substitution; routing to a smaller window overflows context.
- A switch rewrites a large prompt cache the policy did not price. A cold write at 400K tokens costs dollars.
- A pane save loses or reverts the user's `router.json`, or writes through a symlink.
- The Jev key (sensitive plugin option) reaches UI, logs, state or an error message. Errors name the field, never the value.
- Mode handling breaks: `/model` must enter Manual, `/clear` starts Auto, resume restores the session's mode.
- Docs or UI claim measured savings. The project reports only Claude's readings and configured-price estimates.
- A version, tag or CHANGELOG mismatch fails the signed-tag release workflow.

## Blast radius

- `hooks/` and the policy, cost and router modules in `lib/`: every routed turn, with cost and correctness at stake.
- Band and pane rendering: a refused tree falls back to the engine's own UI. Major only if it throws or shows a wrong model or route.
- `experiments/`: maintainer-only evidence. A break blocks reproducing release evidence and has no user impact.
- `docs/` and `README.md`: a wrong command, setting name or default misleads users.

## Reporting bar

- Report a concrete trigger with its consequence; a test that no longer exercises what its name claims; a doc statement the code contradicts.
- Do not report formatting or import order (Biome enforces it), style preferences, hardening without a trigger, backward-compatibility shims, feature ideas, or renames for taste.
- A pure-function edge case matters only when the hook can feed it that input.
- Missing tests for code this change did not touch are pre-existing, not findings.

## Where the rules live

- `docs/architecture.md`: event flow, state, failure handling, cache and cost rules.
- `docs/configuration.md`: `router.json` schema and defaults. `docs/native-router.md` and `docs/user-guide.md`: controls, band and pane. `docs/evaluation.md`: what the evidence supports.
- `CHANGELOG.md`: user-visible changes; the release workflow publishes the dated section as release notes.
- Checks: `npm run check`, `npm run typecheck` (tsc on `lib/` only; `hooks/` needs the engine's types), `npm test`, `npm run validate`, `npm run test:plugin`, `npm run pack:dry`, mirrored in `scripts/git-hooks/pre-push` and `.github/workflows/ci.yml`.
- The Claude Code plugin API contract is the engine's own types, laid in `.claude-plugin/types/` when the plugin loads with `--plugin-dir`.

## Deliberate conventions

- Smallest correct change; no speculative flags, abstractions or compatibility shims; the dev dependencies are Biome and TypeScript (typecheck only).
- Dev tools live in `tools/` (`tools/package.json`, `tools/package-lock.json`; `npm run setup` installs them). The plugin root has no lockfile and its `package.json` declares no dependencies, so Claude Code installs nothing with the plugin; `test/plugin-root.test.mjs` fails if either comes back.
- Tests mock only system boundaries: `$` host calls, clock, HTTP, filesystem. Table-driven where cases form a matrix.
- `router.view` is a write-through cache of `$.state`, because state reads are frozen within one dispatch.
- Classifier failures fail open: keep the current model and never block a turn. A network-policy refusal is never bypassed.
- Model prices are configured list prices in `lib/config.mjs`; a change must also change `test/fixtures/` with its source and date.
- The UI says "Router"; "Jev" appears only where it explains a classifier reading or failure.
- Pane saves write only what the person edited, and only differences from the built-in defaults.
- Commits are signed; releases are signed annotated tags on `main`.
