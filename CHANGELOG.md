# Changelog

## 0.7.2 (2026-09-25)

### Fixed

- `router.json` accepted a `policy.downgradePivotUsd` of 0 and a
  `policy.downgradeSlope` that is not a number. A zero pivot made the
  downgrade bar `NaN` whenever a switch cost nothing, and then no downgrade
  ever passed. Both values now stop a new gateway from starting, as the
  upgrade keys already did; `/router:status` names the field.

### Changed

- The downgrade bar counts what a cheaper model saves, not only its cache
  write. The tax used to count the input of the next request alone. It now
  nets the output and cache-read savings of the next
  `policy.downgradeHorizonTurns` turns (default 5). From a warm Opus at
  `xhigh` to a cold Sonnet, with 104k of context and 4k of output, the bar
  drops from 0.935 to 0.922 (1-hour TTL). It never goes below 0.90. A model
  without an `output` price keeps the input-only tax.

## 0.7.1 (2026-09-24)

### Fixed

- A downgrade paid no attention to its own cost. The switching policy
  checked confidence and vote count for a lower tier, never the price of
  getting there: a candidate whose cache was cold next to a warm incumbent
  could downgrade into a full cache write bigger than what the smaller
  model saved. The downgrade bar now grows with the switching tax the same
  way the upgrade bar does: `0.90 + 0.08 × tax / (tax + $0.50)`, up to
  0.98. A downgrade to an already-warm candidate is unaffected.

## 0.7.0 (2026-09-24)

### Upgrade requirements

- **Jev advises again.** Current Claude Code (2.1.x) sends hook output as a
  `system` message after your prompt. The router read only the last message,
  found no prompt, and never asked Jev: each new turn logged `no-advice` and
  stayed on its route. Now Jev sees each prompt, so routes change again:
  expect `upgrade`, `downgrade` and `continuation` reasons in the status line.
- **The gateway adapts the history for Sonnet and Haiku.** Claude Code builds
  each request for Opus. For a model without a request feature, the gateway
  now removes it, as Claude Code does after a 400: Sonnet and Haiku lose
  `tool_addition`/`tool_removal` blocks and per-turn control (the beta and the
  `output_config` on messages); Haiku also gets each `system` message as a
  `<system-reminder>` in the user message. A model that you add in
  `router.json` without `features` gets all three removed.
- **`high` runs at `xhigh` again.** On Opus, the per-turn effort that Claude
  Code puts on messages overrides the request's effort, so `medium` and `high`
  both ran at your session effort. A route with its own effort now sets it on
  the messages too.
- **`/router:micro` pins again.** Claude Code 2.1.x ignores `model: haiku` in the
  skill and sends the turn to the alias; the gateway now reads the command and
  serves the turn on `micro`, reason `pinned`. The next prompt goes back to Jev
  from the route before the pin.
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
- `models.<alias>.features` and `test/fixtures/model-features.json`: the request
  features each model accepts, from a live probe; a test pins the defaults.

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
- The first Haiku turn of a session failed with `400 role 'system' is not
supported on this model`, and a later one made Claude Code flatten the
  history for the rest of the session: Opus then lost its features, and the
  router saw a shorter history and reset its votes. Sonnet answered the first
  turn with two 400s before Claude Code retried without the features.
- `/router:micro` did not switch the model with Claude Code 2.1.x.
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
