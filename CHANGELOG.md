# Changelog

## Unreleased

### Added

- Cloudflare's Clef and Clef Flash classifiers on Workers AI, next to Jev. Save the Cloudflare API token and account ID in `/plugin configure router`, then select the classifier's row on the Tuning tab. The choice is saved at once, with **Undo**. Only the active classifier is asked; the others keep their keys.
- The Tuning tab opens with the classifier section: one row per classifier with its service and credentials state, the missing setting named on a row that lacks one (`no API token`) with **Set up**, the active classifier's deadline and health, the host that receives the prompt text, and what each classifier needs under **Credentials**.
- `router.json` can add a classifier entry for another service that speaks the same API, with its own label, endpoint, model, key option, and deadline.
- `scripts/probe-classifier.mjs` sends the router's real request to a classifier and prints the status, latency, and parsed answer.

### Changed

- **Action needed for a 1.1 `router.json` with a `jev` section.** Classifier settings moved from `jev` to `classifiers.jev`, and `classifier` names the active one. Routing stays unavailable until you run `node scripts/migrate-config.mjs /path/to/router.json` from the plugin directory. It keeps an exact-byte `.v1.1.backup`. A file without `jev` needs no change.
- Each classifier has its own deadline: Jev 1,500 ms, Clef and Clef Flash 3,000 ms. The deadline control moved from Policy to the classifier section and saves at once.
- The band and pane name the active classifier instead of Jev, and name the missing setting: `⚠ Jev: no API key`, `⚠ Clef: no account ID`. **Set key** is now **Set up**; **Credentials → Edit** on the Tuning tab opens the dialog for all settings.
- Each classifier has its own failure count, pause, and in-flight slot. A turn being classified when you switch finishes with its own classifier; the new one starts from a clean count.
- A classifier endpoint must use `https`, or `http` on localhost. Before, `jev.endpoint` accepted any string.

## 1.1.1 (2026-10-05)

### Fixed

- The credits cap now also guards downgrades and failure escalations. It checked only upgrades, so a downgrade or an escalation could start with a cold cache write above `policy.cashCapUsd` on a `credits` model. A blocked switch now stays on the current tier, or moves to the strongest `plan` tier above it. Default routes use `plan` models and are not affected.

## 1.1.0 (2026-10-05)

### Added

- The status band is redrawn as **Router**: a tier meter, the route, a one-word reason, classifier support, and context and cache, fitted to the band's width. It offers **Auto**, **Set key**, and pin cancel in place. Hover reveals tier pins, Manual, and an optional second row with recent replies by tier.
- A model change between turns raises a toast; a pin or an effort-only change does not. The spinner says `Choosing model` while the classifier runs. The prompt footer shows `router off` in Manual mode.
- The router pane has four tabs: Now, Tiers, Tuning, and Usage. Now shows the classifier's support for each tier next to its pin button, and the last 30 replies colored by tier.
- The Tiers tab edits each tier's model and effort and the baseline tier. It shows the `router.json` diff and how the policy prices each step up before you save. A route can set `"effort": null` to keep the session effort.
- The Tuning tab adds the credits cap.
- The user guide and README show the band and pane, drawn from the render code with `npm run docs:images`.

### Changed

- The `medium` tier defaults to Opus 5.5 at `medium` effort (was Sonnet 5.5 at `xhigh`), for a speed and cost balance. A `routes.medium` entry in `router.json` still overrides it.
- The plugin is named Router. Jev is named only where it explains a reading or a failure, so other classifiers can follow. The plugin ID is unchanged.
- `/router` takes `auto`, `off`, or `pin <tier>`. `status` and `setup` are removed: without a UI surface, `/router` prints the status, and **Set key** in the band or pane opens the secure key dialog.
- A failed save in the pane names the invalid setting instead of a generic error.

### Fixed

- `/router setup` failed with "no command.run hook answered it". Claude Code refuses `$.command.run` inside a `command.run` hook, so the key dialog now opens from a timer.
- The input trend scales from the lowest to the highest reading. Before, similar large readings drew as one solid bar.
- The band yields to surveys and no longer shows the main conversation's tier in a subagent transcript.
- Leftover v0.8 gateway settings are listed in the pane, not only in text status.

## 1.0.0 (2026-10-05)

### Changed

- Model routing now runs as a Claude Code Mod. It changes only `model` and `effort` on the main conversation. Claude Code sends Anthropic requests and handles streaming, tools, credentials, and usage. Subagent model choices pass through unchanged.
- Removed the gateway process, local proxy endpoint, gateway launcher hooks, status-line script, and gateway-only skills from the plugin package. The Mod needs no Node runtime service or router-specific Claude settings.
- Added an integrated status band and `/router` pane. It shows response usage, route reasons, configured-price comparisons, controls, one-turn pins, secure Jev key setup, and three tuning controls.
- Replaced gateway configuration with optional profile `router.json` settings. Added a backup-first migration command for v0.8 configuration files.
- The UI reports Claude's native cost reading and labels model-price comparisons as estimates. It does not claim measured savings or keep a second cost ledger.

### Migration

- The plugin ID stays `router@alexei-led-claude-router`. Marketplace installs with auto-update receive 1.0.0 at the next start; `claude plugin update router@alexei-led-claude-router` updates now. Keep the plugin enabled.
- Before the first 1.0.0 session, remove what 0.8 `/router:setup` wrote to `settings.json`: `model: "jev-router[1m]"`, the `jev-router[1m]` row in `modelPicker.options`, `env.ANTHROPIC_BASE_URL` set to `http://127.0.0.1:43170`, `env.CLAUDE_CODE_GATEWAY_HINT_HEADERS`, `env.ENABLE_TOOL_SEARCH` if setup added it, and a `statusLine` that runs the router's `scripts/statusline.mjs`. Until then, requests go to a gateway that 1.0.0 no longer starts, and the band reads `v0.8 gateway settings remain`.
- Run `node scripts/migrate-config.mjs /path/to/router.json` from the plugin directory for an existing 0.8 `router.json`. It keeps an exact-byte `.v0.8.backup` and converts supported route, model, cache and policy settings.
- Start Claude Code on the full baseline model, for example `claude-sonnet-5-5`. A `/model` choice enters Manual mode; `/router auto` resumes routing. Manual mode follows the session: `/clear` starts Auto, `/resume` restores the resumed session's mode.
- The Mod requires Claude Code 2.1.289 or newer.

## 0.8.0 (2026-10-01)

### Changed

- **Sonnet 5.5 replaces Sonnet 5.** The `sonnet` model is now
  `claude-sonnet-5-5`, at the same prices. A live probe through Claude Code
  2.1.286 shows it takes all five effort levels and all three request
  features, so the gateway no longer adapts its history.
- **`medium` runs on Sonnet 5.5 at `xhigh`**, not on Opus 5.5 at `high`.
  `/router:medium` changes with it. `high` stays Opus 5.5 at `xhigh`. From
  2026-09-23 to 2026-10-01, 15 of 16 escalations from Sonnet moved the
  session onto Opus for good, at about $31.6 of cold cache writes; most were
  triggered by environment or hook errors, not by the model. An escalation
  from `low` now stays on Sonnet.

### Upgrade

- If your `router.json` sets `models.sonnet.id` to `claude-sonnet-5`, also
  set `"features": ["mid-conversation-system"]`. The new default lists all
  three features, and Sonnet 5 answers the other two with 400.
- To keep the old `medium`, set
  `"routes": { "medium": { "model": "opus", "effort": "high" } }` and change
  `skills/medium/SKILL.md` to match.

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
