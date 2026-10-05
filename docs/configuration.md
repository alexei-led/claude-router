# Configuration

The router works with its built-in defaults. Configure a Jev key to enable advice. Change `router.json` only when you need to change routes, model prices, cache assumptions, or policy.

## Key and profile settings

| Item                               | Where it lives                                  | How to change it                                                               |
| ---------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------ |
| Jev API key                        | Sensitive plugin option `typesafe_api_key`      | Run `/plugin configure router`, or use **Set Jev API key** in the router pane. |
| Router settings                    | `router.json` in the active Claude Code profile | Edit the file directly, or use the pane's tuning controls.                     |
| Anthropic credentials and API cost | Claude Code                                     | The Mod leaves these to Claude Code.                                           |

The active profile directory is `CLAUDE_CONFIG_DIR` when set. Otherwise it is `~/.claude`. The Mod does not need an Anthropic proxy URL, model alias, hint header, daemon, or custom status line.

The Mod reads the key from the sensitive plugin option. It also accepts `TYPESAFE_API_KEY` from the process environment. Without a key, it keeps Claude's current model and reports degraded routing.

Project and local settings cannot set `HOME` or `CLAUDE_CONFIG_DIR` for this Mod. Those overrides make the router unavailable for the session, so a project cannot redirect the router to another profile's key or configuration.

## Built-in defaults

The default baseline is tier `low`. Each route refers to an alias in `models`.

| Tier     | Model alias | Model ID            | Effort                               |
| -------- | ----------- | ------------------- | ------------------------------------ |
| `micro`  | `haiku`     | `claude-haiku-4-5`  | None                                 |
| `low`    | `sonnet`    | `claude-sonnet-5-5` | Keeps the effort sent by Claude Code |
| `medium` | `sonnet`    | `claude-sonnet-5-5` | `xhigh`                              |
| `high`   | `opus`      | `claude-opus-5-5`   | `xhigh`                              |

Default model settings:

| Alias    | Input / output / cache read, USD per million tokens | Context window | Billing | Effort levels                           |
| -------- | --------------------------------------------------- | -------------- | ------- | --------------------------------------- |
| `opus`   | 4 / 20 / 0.2                                        | 1,000,000      | `plan`  | `low`, `medium`, `high`, `xhigh`, `max` |
| `sonnet` | 2 / 10 / 0.2                                        | 1,000,000      | `plan`  | `low`, `medium`, `high`, `xhigh`, `max` |
| `haiku`  | 1 / 5 / 0.1                                         | 200,000        | `plan`  | none                                    |

Prices are configured list-price inputs for estimates. They are not a subscription bill or a claim of savings. Haiku receives no effort field. A route without an effort keeps the session effort, clamped to what the model supports.

## Optional `router.json`

Start with the setting you need and leave the rest at defaults. For example, require three votes before moving to a cheaper tier and allow Jev up to two seconds:

```json
{
  "jev": { "timeoutMs": 2000 },
  "policy": { "downgradeVotes": 3 }
}
```

The Mod validates the whole file. Unknown keys and invalid values make routing unavailable with a general configuration error. Retired gateway keys trigger a migration instruction. The migration command reports an invalid setting path and does not print its value.

| Section          | Supported fields                                                                     | Defaults                                                        |
| ---------------- | ------------------------------------------------------------------------------------ | --------------------------------------------------------------- |
| `baselineTier`   | `micro`, `low`, `medium`, `high`                                                     | `low`                                                           |
| `routes.<tier>`  | `model`, optional `effort`                                                           | As in the route table above                                     |
| `models.<alias>` | `id`, `input`, optional `output`, `cacheRead`, `contextWindow`, `billing`, `efforts` | Three defaults above                                            |
| `cache`          | `writeMultiplier`, `ttlMs`, `warmMarginMs`                                           | `5m: 1.25`, `1h: 2`; `300000` / `3600000` ms; `30000` ms        |
| `policy`         | Fields below                                                                         | Values below                                                    |
| `jev`            | `endpoint`, `model`, `timeoutMs`                                                     | `https://api.typesafe.ai/v1/systemone`, `jev-1.13.0`, `1500` ms |
| `context`        | `recentTurns`, `maxTextChars`                                                        | `6`, `1200`                                                     |

Policy defaults:

| Field                   | Default | Meaning                                                                                            |
| ----------------------- | ------: | -------------------------------------------------------------------------------------------------- |
| `upgradeVotes`          |     `2` | Consecutive supporting votes before an upgrade.                                                    |
| `upgradeBase`           |  `0.75` | Minimum probability mass required for an upgrade.                                                  |
| `upgradeSlope`          |  `0.15` | Maximum increase to the upgrade bar from estimated switching cost.                                 |
| `upgradePivotUsd`       |   `0.5` | Cost scale used by the upgrade bar. Must be positive.                                              |
| `jumpConfidence`        |  `0.95` | Support for a two-tier jump without waiting for votes.                                             |
| `downgradeVotes`        |     `2` | Consecutive supporting votes before a downgrade.                                                   |
| `downgradeMass`         |   `0.9` | Minimum probability mass required for a downgrade.                                                 |
| `downgradeSlope`        |  `0.08` | Maximum increase to the downgrade bar from estimated switching cost.                               |
| `downgradePivotUsd`     |   `0.5` | Cost scale used by the downgrade bar. Must be positive.                                            |
| `downgradeHorizonTurns` |     `5` | Later turns included in a downgrade payback estimate.                                              |
| `continuationMass`      |   `0.7` | Advice probability that keeps the current route for a continuation.                                |
| `escalationHoldTurns`   |     `2` | Turns held after a repeated tool error escalates the route.                                        |
| `cashCapUsd`            |     `2` | Maximum estimated cold cache write for a `credits` model. It does not cap output or session spend. |

The pane exposes only three tuning controls: Jev deadline, downgrade vote count, and downgrade horizon. Select **Save tuning** to preserve other keys and apply the change to future turns. The pane refuses to write through a symlink. Other supported settings require a direct edit.

Native cache freshness is unknown after 270 seconds or after a history reset. Claude usage does not report the cache TTL. The policy evaluates price bounds for five-minute and one-hour writes, but the one-hour case is not observed fact. See the [architecture](architecture.md#cache-and-cost) for the estimate rules.

## Convert a v0.8 configuration

The `router.json` converter changes only that file. It does not remove Claude Code gateway settings. Remove them before the first native session.

A marketplace install keeps the plugin ID `router@alexei-led-claude-router`: update it and keep it enabled. If you load v1 from a checkout with `--plugin-dir` instead, disable the marketplace v0.8 install so only one router loads. Set `CLAUDE_CONFIG_DIR` to the intended profile directory first:

```sh
CLAUDE_CONFIG_DIR=/path/to/profile claude plugin disable router@alexei-led-claude-router --scope user
```

Then inspect that profile's `settings.json`. Remove the old `jev-router[1m]` model-picker row and any `model` or `env.ANTHROPIC_MODEL` value set to that alias. Remove `env.ANTHROPIC_BASE_URL` when it points to the router's loopback port. Clear `env.CLAUDE_CODE_GATEWAY_HINT_HEADERS`. Restore or remove a router-specific `statusLine` that points to the deleted script. Remove `env.ENABLE_TOOL_SEARCH` only if the old router setup added it and you do not need it for another reason. Preserve unrelated settings. Set the normal full baseline model, for example `claude-sonnet-5-5`.

No conversion is needed if you never created `router.json`. For an existing file, run the migration command from the v1 plugin directory, a checkout or the installed plugin cache:

```sh
node scripts/migrate-config.mjs ~/.claude/router.json
```

Pass the file under your active profile instead when `CLAUDE_CONFIG_DIR` points elsewhere. The command validates the converted configuration before writing it and creates an exact-byte `router.json.v0.8.backup`. It refuses to overwrite an existing backup. Route, model-price, cache, and policy overrides remain in the converted file.

The converter removes old gateway and logging settings, request-feature fields, and model output caps. It moves `gateway.baselineTier` to top-level `baselineTier`. It stops without writing when it finds an unsupported old field or invalid setting.

Node.js 22 or later is needed only for this migration command and project development. Claude Code runs the Mod. Node is not a routing service.
