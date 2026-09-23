# Configuration

## Where each value is

| Value                           | Location                                                                                                                                                                                             | Reason                                                                                                   |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| TypeSafe API key                | `TYPESAFE_API_KEY` in the environment of the gateway                                                                                                                                                 | One name in all places. The key is never in a file.                                                      |
| The key for an installed plugin | The plugin option `typesafe_api_key`. Claude Code asks for it when you enable the plugin and stores it in the macOS Keychain. The `SessionStart` hook gives it to the gateway as `TYPESAFE_API_KEY`. | Claude Code exports plugin options as `CLAUDE_PLUGIN_OPTION_<KEY>`. The gateway does not read that name. |
| Claude Code settings            | `~/.claude/settings.json`: `model`, `env.ANTHROPIC_BASE_URL`, the `modelPicker` row, the status line. `/router:setup` writes them.                                                                   | Claude Code reads the base URL at start. A plugin cannot set it.                                         |
| Routing configuration           | `~/.claude/router.json`, user scope only                                                                                                                                                             | A cloned repository must not change your routing or your spend.                                          |

The gateway ignores project files. To use another file, set
`ROUTER_CONFIG=/path/to/file.json`. The gateway reads the file at start. After
an edit, stop the gateway with `pkill -f scripts/gateway.mjs`. The next prompt
starts it again.

## Claude Code settings

`/router:setup` writes this to `~/.claude/settings.json`:

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

With a custom `ANTHROPIC_BASE_URL`, Claude Code turns tool search off: every
MCP tool schema goes into each request, about 50K tokens with the claude.ai
connectors. `ENABLE_TOOL_SEARCH` keeps the schemas deferred, as with the
Anthropic API; `/context` lists them as "MCP tools (deferred)".

The `modelPicker` row adds `Jev Router (auto)` to the `/model` picker, next to the
built-in rows. `behavesAs` maps `jev-router` to a model that Claude Code knows.
Without it, Claude Code rejects `jev-router` because the model is not in its
catalog. Setup also removes the `ANTHROPIC_CUSTOM_MODEL_OPTION*` keys that
older versions wrote. Before 0.4.2 the alias was `router`; the gateway still
routes it, and setup replaces that row.

Setup writes the file as its last step. Restart Claude Code after it. Until
the restart, the session sends `jev-router` to Anthropic and shows "There's an
issue with the selected model (jev-router[1m])".

Claude Code does not know the model `jev-router`, so it assumes a 200K window.
The `[1m]` suffix declares 1M, the largest `contextWindow` of the default
routes; Claude Code strips it before the request. `CLAUDE_CODE_MAX_CONTEXT_TOKENS`
does not work here: Claude Code ignores it for this model. With the suffix,
Claude Code sends the 1M context beta header on every request; the gateway
drops it for a model with a smaller window (Haiku answers it with 400). The gateway sends a turn
only to a model whose window holds the context with room to spare (80%). A
large session skips Haiku (200K) and goes to Sonnet or Opus. The
`/router:status` reason for such a turn is `context-fit`.

If you agree, it also wraps the status line command:

```json
{
  "statusLine": {
    "type": "command",
    "command": "node <plugin root>/scripts/statusline.mjs claude-powerline"
  }
}
```

The wrapper runs the command after it, then adds one line for a routed
session, for example `jev-router ▸ opus-5-5 · xhigh · upgrade`. Without a command
after it, it prints only that line. The path contains the plugin version, so
run `/router:setup` again after a plugin update.

`CLAUDE_CODE_GATEWAY_HINT_HEADERS: "1"` makes Claude Code send the gateway
hint headers:

- `x-claude-code-request-class`. The classes `main`, `subagent` and `workflow`
  get routing. `auxiliary` and `compaction` are side requests and get
  `gateway.auxiliaryTier`.
- `x-claude-code-context-compacted` on the first request after a compaction.
  The gateway then drops the cached prefixes of every model, the pending
  votes and the escalation hold.
- `x-claude-code-agent-type`, for example `Explore` or `Plan`. It goes to
  `decisions.jsonl` only.

Without the headers, the gateway identifies side requests by their shape. A
main request with fewer messages than the last one is a compaction or a
rewind, with or without the headers: the gateway drops the same state. A
context that shrank by more than 20% with no fewer messages is context
editing; it drops only the cached prefixes.

A subagent with `model: inherit` sends `x-claude-code-agent-id` even without
the hint headers. Each subagent keeps its own routing memory, so its turns do
not change the route of the main conversation.

## Configuration file

Each key is optional. A key in the file replaces the default with the same
path. Nested objects merge.

```json
{
  "gateway": {
    "port": 43170,
    "alias": "jev-router",
    "baselineTier": "low",
    "auxiliaryTier": "low",
    "idleShutdownMs": 7200000
  },
  "routes": {
    "high": { "model": "opus", "effort": "xhigh" },
    "medium": { "model": "opus", "effort": "high" },
    "low": { "model": "sonnet" },
    "micro": { "model": "haiku" }
  },
  "models": {
    "sonnet": {
      "id": "claude-sonnet-5",
      "input": 2,
      "output": 10,
      "cacheRead": 0.2,
      "contextWindow": 1000000,
      "billing": "plan",
      "efforts": ["low", "medium", "high", "xhigh", "max"]
    }
  },
  "policy": {
    "upgradeVotes": 2,
    "upgradeBase": 0.75,
    "upgradeSlope": 0.15,
    "upgradePivotUsd": 0.5,
    "jumpConfidence": 0.95,
    "downgradeVotes": 2,
    "downgradeMass": 0.9,
    "continuationMass": 0.7,
    "escalationHoldTurns": 2,
    "cashCapUsd": 2
  },
  "jev": { "model": "jev-1.13.0", "timeoutMs": 1500 },
  "context": { "recentTurns": 6, "maxTextChars": 1200 },
  "log": true
}
```

### routes

`routes.<tier>.model` is a key of `models`. `effort` is one of `low`, `medium`,
`high`, `xhigh`, `max`, or absent. When `effort` is absent, the gateway keeps
the effort that Claude Code sent. If you change a route, also change the
frontmatter of `skills/<tier>/SKILL.md`. A test makes sure that they agree.

### models

| Alias    | ID                 | Input | Output | Cache Read | Window | Max output | Billing | Efforts       |
| -------- | ------------------ | ----- | ------ | ---------- | ------ | ---------- | ------- | ------------- |
| `opus`   | `claude-opus-5-5`  | $4    | $20    | $0.2       | 1M     | as sent    | plan    | all           |
| `sonnet` | `claude-sonnet-5`  | $2    | $10    | $0.2       | 1M     | as sent    | plan    | low–xhigh–max |
| `haiku`  | `claude-haiku-4-5` | $1    | $5     | $0.1       | 200k   | 64k        | plan    | none          |

`id` is the model id that the gateway sends to Anthropic. `input`, `output`
and `cacheRead` are list prices in USD per million tokens. `output` is
optional and feeds only the `shadow` estimate in `decisions.jsonl`; the policy
does not read it. The defaults match `test/fixtures/list-prices.json`, which
names its source and the date it was checked; a test fails when the two
differ. `contextWindow` is the
size of the context window in tokens. `maxOutput`, when set, caps the
`max_tokens` that Claude Code sends; the API rejects a request above the
model's output limit. `billing` is `plan` for models that use
the subscription limits, or `credits` for models that bill usage credits.
`policy.cashCapUsd` applies to `credits` models only. `efforts` lists the
levels that the model accepts. An empty list means that the gateway removes
effort and thinking from the request.

### policy

| Key                                              | Meaning                                                                                                                                      |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `gateway.baselineTier`                           | The tier when nothing else decides: Jev abstains, Jev fails, or the session is new.                                                          |
| `gateway.auxiliaryTier`                          | The tier for side requests, for example session titles.                                                                                      |
| `gateway.idleShutdownMs`                         | The gateway exits after this long without requests, when no turn waits for a tool result. Two hours by default; `0` keeps it running.        |
| `upgradeVotes`                                   | The number of consecutive votes above the current tier before an upgrade of one tier.                                                        |
| `upgradeBase`, `upgradeSlope`, `upgradePivotUsd` | The required probability mass: `base + slope * tax / (tax + pivot)`. The `tax` is the extra input cost to read the context on the new route; the cache is per model and effort. |
| `jumpConfidence`                                 | The mass that lets a jump of two tiers skip the vote delay.                                                                                  |
| `downgradeVotes`, `downgradeMass`                | The number of consecutive votes, and the mass at or below the candidate, for a downgrade.                                                    |
| `continuationMass`                               | The Jev probability for "this prompt continues the task" that keeps the current route.                                                       |
| `escalationHoldTurns`                            | The number of turns to hold one tier up after two failed repairs of the same error.                                                          |
| `cashCapUsd`                                     | The cold-write guard: the estimated first cache write above which the gateway refuses an automatic route to a `credits` model whose cache is not warm. Not a budget for the turn: output is not counted. |

## Environment variables

| Variable             | Effect                                                                                                  |
| -------------------- | ------------------------------------------------------------------------------------------------------- |
| `TYPESAFE_API_KEY`   | The Jev key.                                                                                            |
| `ROUTER_CONFIG`      | The path of the configuration file.                                                                     |
| `ROUTER_FORCE_TIER`  | `micro`, `low`, `medium` or `high`. Skips Jev and the policy and always routes to that tier. For tests. |
| `CLAUDE_PLUGIN_DATA` | Set by Claude Code for hooks. The directory holds `sessions/`, `decisions.jsonl` and `gateway.log`.     |

The gateway keeps the directory bounded. Above 20 MB, `decisions.jsonl` moves
to `decisions.jsonl.1` (checked every hour), and `gateway.log` moves to
`gateway.log.1` when a gateway starts. One previous generation is kept. Session
files unused for 30 days are removed.
