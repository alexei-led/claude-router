# Changelog

## 0.7.0 (Unreleased)

### Upgrade requirements

- **Jev advises again.** Current Claude Code (2.1.x) sends hook output as a
  `system` message after your prompt. The router read only the last message,
  found no prompt, and never asked Jev: each new turn logged `no-advice` and
  stayed on its route. Now Jev sees each prompt, so routes change again:
  expect `upgrade`, `downgrade` and `continuation` reasons in the status line.
- **`router.json` is strict.** An unknown key (for example a typo such as
  `routs`), a forbidden key (`__proto__`, `constructor`, `prototype`), a
  section that is not an object, or a number out of range now stops a new
  gateway from starting. The error names the file and the field, never the
  value. A gateway that already runs keeps serving. If no gateway runs, every
  request fails to connect until you fix the file. The SessionStart hook
  prints the error; the prompt hook is quiet. `/router:status` shows it too.
- **`ROUTER_CONFIG` counts only under `~/.claude/`.** The home directory comes
  from your OS user account, not from `$HOME`. A user with no account entry
  (some containers) has no trusted home: the gateway then ignores
  `router.json` and runs on the defaults, with a warning. A path elsewhere is
  ignored, with a warning. Move the file under `~/.claude/`: the hooks and the
  status line pass no flags, so `--config` works only for a gateway that you
  start by hand.
- **`ROUTER_FORCE_TIER` is gone.** Use `scripts/gateway.mjs --force-tier <tier>`.
- **A request with an `Origin` header gets 403.** Claude Code sends none. A
  browser page, also one on another loopback port, cannot use the gateway.
- **Jev receives less text.** The prompt is capped at `context.maxTextChars`
  (1,200 by default), like each earlier turn. A longer text keeps its start
  and its end. The current message is no longer also the last earlier turn.

### Added

- `--config <path>` on `scripts/gateway.mjs`, `scripts/ensure-gateway.mjs` and
  `scripts/status.mjs`, and `--force-tier <tier>` on `scripts/gateway.mjs`.
- `decisions.jsonl`: `model` and `effort` on each decision line, `effort` on
  each `observed` line, a `failed` line for a routed turn that Anthropic
  answered with an error, and a `reason: error` line when routing fails.
- `test/fixtures/effort-support.json`: the effort levels each default model
  accepts, from a probe against the real API. A test pins the defaults to it.

### Changed

- The hook sends a stop signal only to a pid that runs `scripts/gateway.mjs`.
- `Retry-After` from Jev is also read as an HTTP date.
- The status line keeps working when `router.json` fails to load, and
  `/router:status` names the error in one line.

### Fixed

- A `system` message after the prompt (hook output, tool additions) hid the
  prompt, a tool result and a resent request from the router. Jev was not
  asked, a tool continuation looked like a new turn, and a request that Claude
  Code resent after a 400 was decided again.
- A project's `.claude/settings.json` could point the shared gateway at its own
  `router.json` (and so its own Jev endpoint) through `ROUTER_CONFIG`, while
  the hook passed the real Jev key to that gateway.
- `routes.<tier>.model: "constructor"` passed the model check; a merge key such
  as `constructor` reached the prototype chain.
- `policy.upgradePivotUsd: 0` silently stopped upgrades, and an infinite
  `policy.cashCapUsd` turned off the cold-write guard.
- A side request (title, classifier, compaction) on a session cleared its
  pending tool wait, so the gateway could exit under an open permission
  prompt. This needs the request-class header that `/router:setup` turns on
  (`CLAUDE_CODE_GATEWAY_HINT_HEADERS`); without it the gateway cannot tell a
  side request from a turn and keeps the old behavior.
