# Configuration

## Where the settings are

| Setting                | Location                                                        | Written by                              |
| ---------------------- | --------------------------------------------------------------- | --------------------------------------- |
| Jev API key            | macOS Keychain, plugin option `typesafe_api_key`                | Claude Code, when you enable the plugin |
| Claude Code settings   | `~/.claude/settings.json`                                       | `/router:setup`                         |
| Router configuration   | `~/.claude/router.json`                                         | You                                     |
| Data and logs          | `~/.claude/plugins/data/router-alexei-led-claude-router/`       | The gateway                             |

- The hooks give the key to the gateway as `TYPESAFE_API_KEY`. The key is
  never in a file.
- The gateway that the hooks start reads `~/.claude/router.json`, or the file
  that `ROUTER_CONFIG` names when it is under `~/.claude/`. A project can set
  environment variables for the plugin hooks, so the hooks take your home
  directory from your OS user account, not from `$HOME`, and ignore
  `ROUTER_CONFIG` for a path outside `~/.claude/`. So a cloned repository
  cannot choose the router configuration (and with it the port, the routes or
  the Jev endpoint) through `router.json`, `ROUTER_CONFIG` or `$HOME`. The
  gateway still inherits the other environment variables of the session that
  started it.
- The gateway reads `router.json` at start. After a change, run
  `pkill -f scripts/gateway.mjs`. The next prompt starts a new gateway.

## Claude Code settings

`/router:setup` writes these keys to `~/.claude/settings.json`:

```json
{
  "model": "jev-router[1m]",
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:43170",
    "ENABLE_TOOL_SEARCH": "true",
    "CLAUDE_CODE_GATEWAY_HINT_HEADERS": "1"
  },
  "modelPicker": {
    "options": [
      {
        "model": "jev-router[1m]",
        "label": "Jev Router (auto)",
        "description": "Auto-selects the model and effort for each turn",
        "behavesAs": "claude-opus-5-5"
      }
    ]
  }
}
```

| Key                                    | Why                                                                                                                  |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `model`                                | The `[1m]` suffix tells Claude Code that the window is 1M tokens. Claude Code removes the suffix before the request. |
| `env.ANTHROPIC_BASE_URL`               | Sends the traffic of Claude Code to the gateway.                                                                     |
| `env.ENABLE_TOOL_SEARCH`               | Keeps MCP tool schemas deferred. Without it, each request carries all schemas: about 50K tokens with the claude.ai connectors. |
| `env.CLAUDE_CODE_GATEWAY_HINT_HEADERS` | Claude Code sends the [class of each request](architecture.md#request-classes).                                      |
| `modelPicker` row                      | Adds `Jev Router (auto)` to `/model`. `behavesAs` names a known model. Without it, Claude Code rejects the alias.     |
| `statusLine` (optional)                | Runs your status line command, then adds the route of the last turn.                                                 |

Setup writes the file once, as its last step. Restart Claude Code after it.
Until the restart, the session shows "There's an issue with the selected
model (jev-router[1m])".

## Router configuration

Each key in `~/.claude/router.json` is optional. A key replaces the default
at the same path, and objects merge.

The file is strict. Text that is not valid JSON, an unknown key (a typo such
as `routs`), a value of the wrong type, or a number out of range stops a new
gateway from starting. The error names the file and the field, never the
value. A gateway that already runs keeps serving. When no gateway runs, every
request fails to connect until you fix the file. The SessionStart hook prints
the error; the prompt hook is quiet. `/router:status` also shows it: it reads
the file and starts nothing.

For example, to run `low` on Sonnet at `high` effort and give Jev more time:

```json
{
  "routes": { "low": { "model": "sonnet", "effort": "high" } },
  "jev": { "timeoutMs": 2500 }
}
```

### gateway

| Key              | Default      | Meaning                                                                          |
| ---------------- | ------------ | -------------------------------------------------------------------------------- |
| `port`           | `43170`      | The loopback port of the gateway.                                                |
| `alias`          | `jev-router` | The model name that Claude Code sends.                                           |
| `baselineTier`   | `low`        | The tier when nothing else decides: a new session, or no Jev answer.             |
| `auxiliaryTier`  | `low`        | The tier for side requests, for example session titles.                          |
| `idleShutdownMs` | `7200000`    | The gateway exits after this time without requests. `0` keeps it running.        |

### routes

| Tier     | Default                              |
| -------- | ------------------------------------ |
| `high`   | `{ "model": "opus", "effort": "xhigh" }` |
| `medium` | `{ "model": "opus", "effort": "high" }`  |
| `low`    | `{ "model": "sonnet" }`              |
| `micro`  | `{ "model": "haiku" }`               |

`model` is a key of `models`. `effort` is `low`, `medium`, `high`, `xhigh` or
`max`. Without `effort`, the gateway keeps the effort that Claude Code sent.
If you change a route, also change the frontmatter of `skills/<tier>/SKILL.md`.
A test makes sure that they agree.

### models

| Alias    | `id`               | `input` | `output` | `cacheRead` | `contextWindow` | `maxOutput` | `billing` | `efforts` |
| -------- | ------------------ | ------- | -------- | ----------- | --------------- | ----------- | --------- | --------- |
| `opus`   | `claude-opus-5-5`  | 4       | 20       | 0.2         | 1,000,000       | —           | `plan`    | all five  |
| `sonnet` | `claude-sonnet-5`  | 2       | 10       | 0.2         | 1,000,000       | —           | `plan`    | all five  |
| `haiku`  | `claude-haiku-4-5` | 1       | 5        | 0.1         | 200,000         | 64,000      | `plan`    | none      |

| Field           | Meaning                                                                                              |
| --------------- | ---------------------------------------------------------------------------------------------------- |
| `id`            | The model id that the gateway sends to Anthropic.                                                    |
| `input`, `output`, `cacheRead` | List prices in USD per million tokens. `output` is optional. Only the `shadow` estimate uses it. |
| `contextWindow` | The window in tokens. A turn goes only to a model that holds the context at 80% fill.                |
| `maxOutput`     | Optional limit for `max_tokens`. Haiku 4.5 rejects more than 64K.                                     |
| `billing`       | `plan` for the subscription limits. `credits` for models that bill usage credits.                    |
| `efforts`       | The effort levels that the model accepts. An empty list removes effort and thinking.                 |

The default prices match `test/fixtures/list-prices.json`, which names its
source and date. The default `efforts` match `test/fixtures/effort-support.json`,
from a probe against the real API. A test fails when they differ.

### policy

The [switching policy](architecture.md#switching-policy) uses these values.

| Key                   | Default | Meaning                                                                               |
| --------------------- | ------- | ------------------------------------------------------------------------------------- |
| `upgradeVotes`        | `2`     | Consecutive votes above the current tier before an upgrade.                           |
| `upgradeBase`         | `0.75`  | The upgrade bar when a switch costs nothing.                                          |
| `upgradeSlope`        | `0.15`  | How much a switching cost can raise the bar: `base + slope × tax / (tax + pivot)`.    |
| `upgradePivotUsd`     | `0.5`   | The switching cost that adds half of the slope.                                       |
| `jumpConfidence`      | `0.95`  | The confidence for a jump of two tiers without the vote delay.                        |
| `downgradeVotes`      | `2`     | Consecutive votes for a lower tier before a downgrade.                                |
| `downgradeMass`       | `0.9`   | The confidence for a downgrade.                                                       |
| `continuationMass`    | `0.7`   | The Jev probability for "continues the task" that keeps the route.                    |
| `escalationHoldTurns` | `2`     | Turns that the route stays up after an escalation.                                    |
| `cashCapUsd`          | `2`     | The cold-write guard: the largest first cache write for a switch to a `credits` model. |

### cache, jev, context, log

| Key                        | Default                                | Meaning                                                  |
| -------------------------- | -------------------------------------- | -------------------------------------------------------- |
| `cache.writeMultiplier`    | `{ "5m": 1.25, "1h": 2 }`              | The price of a cache write, as a multiple of `input`.     |
| `cache.ttlMs`              | `{ "5m": 300000, "1h": 3600000 }`      | The lifetime of each cache TTL.                          |
| `cache.warmMarginMs`       | `30000`                                | A cache counts as cold this long before it expires.      |
| `jev.endpoint`             | `https://api.typesafe.ai/v1/systemone` | The Jev API.                                             |
| `jev.model`                | `jev-1.13.0`                           | The Jev model.                                           |
| `jev.timeoutMs`            | `1500`                                 | The total time for one Jev answer, one retry included.   |
| `context.recentTurns`      | `6`                                    | The number of recent turns that Jev receives.            |
| `context.maxTextChars`     | `1200`                                 | The characters of the prompt and of each turn that Jev receives. A longer text keeps its start and end. |
| `log`                      | `true`                                 | Write `decisions.jsonl`.                                 |

## Environment variables

| Variable             | Effect                                                                                          |
| -------------------- | ----------------------------------------------------------------------------------------------- |
| `TYPESAFE_API_KEY`   | The Jev key. The hooks set it from the plugin option.                                           |
| `ROUTER_CONFIG`      | Another path for the router configuration, under `~/.claude/` only. Another path is ignored, with a warning. |
| `CLAUDE_PLUGIN_DATA` | The data directory. Claude Code sets it for the plugin hooks.                                   |

## Command-line flags

A project cannot change these: they are part of the command, not of the
environment.

| Flag                  | Script                                   | Effect                                                                  |
| --------------------- | ---------------------------------------- | ----------------------------------------------------------------------- |
| `--config <path>`     | `gateway.mjs`, `ensure-gateway.mjs`, `status.mjs` | The router configuration, at any path.                         |
| `--force-tier <tier>` | `gateway.mjs`                            | `micro`, `low`, `medium` or `high`. Skips Jev and the policy. For tests. |

The flags are for a gateway that you start by hand. The hooks and the status
line do not pass them. To use another file with the hooks, keep it under
`~/.claude/` and set `ROUTER_CONFIG`.

To force a tier, stop the gateway and start it by hand with the data directory
of the plugin, so the log stays in its place:

```sh
pkill -f scripts/gateway.mjs
CLAUDE_PLUGIN_DATA=~/.claude/plugins/data/router-alexei-led-claude-router \
  node <plugin>/scripts/gateway.mjs --force-tier high
```

## Data directory

| File              | Content                                        | Retention                               |
| ----------------- | ---------------------------------------------- | --------------------------------------- |
| `decisions.jsonl` | One line for each decision and each response. | Moves to `.1` above 20 MB.              |
| `gateway.log`     | Gateway events with timestamps.                | Moves to `.1` above 20 MB, at gateway start. |
| `sessions/`       | The routing memory of each session.            | Removed after 30 days without use.      |
