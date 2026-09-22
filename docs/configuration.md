# Configuration

## Where each value is

| Value | Location | Reason |
| ----- | -------- | ------ |
| TypeSafe API key | `TYPESAFE_API_KEY` in the environment of the gateway | One name in all places. The key is never in a file. |
| The key for an installed plugin | The plugin option `typesafe_api_key`. Claude Code asks for it when you enable the plugin and stores it in the macOS Keychain. The `SessionStart` hook gives it to the gateway as `TYPESAFE_API_KEY`. | Claude Code exports plugin options as `CLAUDE_PLUGIN_OPTION_<KEY>`. The gateway does not read that name. |
| Claude Code settings | `~/.claude/settings.json`: `model` and `env.ANTHROPIC_BASE_URL`. `/router:setup` writes them. | Claude Code reads the base URL at start. A plugin cannot set it. |
| Routing configuration | `~/.claude/router.json`, user scope only | A cloned repository must not change your routing or your spend. |

The gateway ignores project files. To use another file, set
`ROUTER_CONFIG=/path/to/file.json`. The gateway reads the file at start. After
an edit, stop the gateway with `pkill -f scripts/gateway.mjs`. The next session
starts it again.

## Claude Code settings

`/router:setup` writes this to `~/.claude/settings.json`:

```json
{
  "model": "router",
  "env": { "ANTHROPIC_BASE_URL": "http://127.0.0.1:43170" }
}
```

Two optional keys in `env`:

- `CLAUDE_CODE_GATEWAY_HINT_HEADERS: "1"`. Claude Code then tells the gateway
  the class of each request. Requests of the class `main` get routing. All
  other classes (`auxiliary`, `subagent`, `workflow`, `compaction`) get
  `gateway.auxiliaryTier`. A subagent with `model: inherit` runs on that tier.
  Without the header, the gateway identifies side requests by their shape, and
  subagents get routing like the main conversation.
- `ANTHROPIC_CUSTOM_MODEL_OPTION: "router"`. The `/model` picker then shows a
  `router` row.

## Configuration file

Each key is optional. A key in the file replaces the default with the same
path. Nested objects merge.

```json
{
  "gateway": { "port": 43170, "alias": "router", "baselineTier": "low", "auxiliaryTier": "low" },
  "routes": {
    "high":   { "model": "fable",  "effort": "xhigh" },
    "medium": { "model": "opus",   "effort": "high" },
    "low":    { "model": "sonnet" },
    "micro":  { "model": "haiku" }
  },
  "models": {
    "sonnet": { "id": "claude-sonnet-4-6", "input": 3, "cacheRead": 0.3, "contextWindow": 1000000, "billing": "plan", "efforts": ["low", "medium", "high", "max"] }
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

`id` is the model id that the gateway sends to Anthropic. `input` and
`cacheRead` are list prices in USD per million tokens. `contextWindow` is the
size of the context window in tokens. `billing` is `plan` for models that use
the subscription limits, or `credits` for models that bill usage credits.
`policy.cashCapUsd` applies to `credits` models only. `efforts` lists the
levels that the model accepts. An empty list means that the gateway removes
effort and thinking from the request.

### policy

| Key | Meaning |
| --- | ------- |
| `gateway.baselineTier` | The tier when nothing else decides: Jev abstains, Jev fails, or the session is new. |
| `gateway.auxiliaryTier` | The tier for side requests, for example session titles. |
| `upgradeVotes` | The number of consecutive votes above the current tier before an upgrade of one tier. |
| `upgradeBase`, `upgradeSlope`, `upgradePivotUsd` | The required probability mass: `base + slope * tax / (tax + pivot)`. The `tax` is the extra input cost to read the context on the new model. |
| `jumpConfidence` | The mass that lets a jump of two tiers skip the vote delay. |
| `downgradeVotes`, `downgradeMass` | The number of consecutive votes, and the mass at or below the candidate, for a downgrade. |
| `continuationMass` | The Jev probability for "this prompt continues the task" that keeps the current route. |
| `escalationHoldTurns` | The number of turns to hold one tier up after two failed repairs of the same error. |
| `cashCapUsd` | The cold cache-write cost above which the gateway refuses an automatic route to a `credits` model. |

## Environment variables

| Variable | Effect |
| -------- | ------ |
| `TYPESAFE_API_KEY` | The Jev key. |
| `ROUTER_CONFIG` | The path of the configuration file. |
| `ROUTER_FORCE_TIER` | `micro`, `low`, `medium` or `high`. Skips Jev and the policy and always routes to that tier. For tests. |
| `CLAUDE_PLUGIN_DATA` | Set by Claude Code for hooks. The directory holds `sessions/`, `decisions.jsonl` and `gateway.log`. |
