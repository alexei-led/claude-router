# User guide

After the [install](../README.md#install), work in Claude Code as usual. The
router selects the model and the effort for each turn.
[How Jev selects a tier](../README.md#how-jev-selects-a-tier) gives the rules.

## Read the status line

`/router:setup` can add one line to your status line:

```text
jev-router ▸ opus-5-5 · xhigh · upgrade
             │          │       └─ reason for the route
             │          └─ effort
             └─ model of the last turn
```

| Line                                              | Meaning                                                   |
| ------------------------------------------------- | --------------------------------------------------------- |
| `jev-router ▸ …`                                  | The route of the last turn in this session.               |
| `jev-router: no turn yet`                         | This session has no routed turn.                          |
| `router: gateway off, the next prompt starts it`  | The gateway stopped after idle time, or it crashed.       |

The line changes when Claude Code draws the status line, after each message.

## Reasons

| Reason              | Meaning                                                                        |
| ------------------- | ------------------------------------------------------------------------------ |
| `upgrade`           | Jev voted for a higher tier often enough, with enough confidence.              |
| `jump`              | Jev was confident enough to go up two tiers at once.                           |
| `downgrade`         | Jev voted for a lower tier often enough, with enough confidence.               |
| `upgrade-pending`   | Jev asked for a higher tier. The route stays until the votes are enough.       |
| `downgrade-pending` | Jev asked for a lower tier. The route stays until the votes are enough.        |
| `same-tier`         | Jev agreed with the current tier.                                              |
| `continuation`      | The prompt continues the task, so the route stays.                             |
| `uncertain`         | Jev did not select a tier, so the route stays.                                 |
| `no-advice`         | No Jev answer: no key, an error, a pause, or a prompt without text.            |
| `escalation`        | The same error came back after an edit. The route went up one tier.            |
| `hold`              | The route stays up for two turns after an escalation.                          |
| `context-fit`       | The selected model cannot hold the context. A model with a larger window serves. |
| `cash-gate`         | The cold-write guard stopped a switch to a `credits` model.                    |
| `forced`            | `ROUTER_FORCE_TIER` is set.                                                    |

`/router:status` shows the routes, the Jev state and the last turn. It gives
the reason in words and, for a vote, the estimate: the confidence, the bar,
the switching cost and the cache state (`warm`, `expired` or `unknown`).

## Pin a tier

To run one turn on a fixed tier, type the tier skill before the prompt:

```text
/router:high  redesign the auth flow
/router:micro rename foo to bar in this file
```

`/model <name>` also works, but it stops the routing for the rest of the
session.

## Read the decision log

The gateway writes one JSON line for each routed request to `decisions.jsonl`
in `~/.claude/plugins/data/router-alexei-led-claude-router/`. The log has no
prompt text.

```sh
tail -n 20 ~/.claude/plugins/data/router-*/decisions.jsonl | jq -c '{tier, reason, estimate, shadow, observed}'
```

| Field          | Content                                                                                 |
| -------------- | --------------------------------------------------------------------------------------- |
| `tier`         | The tier of the request.                                                                |
| `reason`       | The rule that decided. Tool calls show `tool-continuation`.                             |
| `advice`       | The Jev probabilities for each tier, and for "continues the task".                      |
| `estimate`     | The numbers of a vote: confidence, bar, switching cost, cache state.                    |
| `shadow`       | The cost of the Jev choice against the current route. The policy does not use it.      |
| `observed`     | The usage of the response: model, context tokens, cache reads, output.                  |
| `historyBreak` | A compaction or a rewind. The votes and the cache estimates reset.                      |
| `cacheReset`   | The context shrank by more than 20%. The cache estimates reset.                         |

`scripts/transcript-models.sh <transcript.jsonl>` shows the model of each
assistant message in a Claude Code transcript.

## Update

1. Update the marketplace and the plugin:

   ```sh
   claude plugin marketplace update alexei-led-claude-router
   claude plugin update router@alexei-led-claude-router
   ```

2. Restart Claude Code. The next prompt replaces the running gateway.
3. Run `/router:setup` once. The status line command contains the plugin
   version.

## Stop using the router

1. In `~/.claude/settings.json`, remove `model`, `env.ANTHROPIC_BASE_URL`,
   `env.ENABLE_TOOL_SEARCH`, `env.CLAUDE_CODE_GATEWAY_HINT_HEADERS` and the
   `jev-router[1m]` row of `modelPicker.options`.
2. If setup changed your status line, restore the old command.
3. Restart Claude Code.
4. To remove the plugin, run
   `claude plugin uninstall router@alexei-led-claude-router`.

The gateway stops by itself after two hours without requests.

## Troubleshooting

| Symptom                                     | Cause                                              | Fix                                                                                   |
| ------------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Claude Code rejects `jev-router`            | The session does not use the gateway.              | Run `/router:setup`, then restart Claude Code.                                        |
| Every turn has the reason `no-advice`       | No Jev key, or Jev fails.                          | Run `/router:status`. Read the `router:` lines in `gateway.log` next to the log.        |
| The effort is not the effort that you set   | The model does not accept that effort.             | The gateway uses the nearest lower level. Haiku has no effort and no thinking.        |
| 429 or 529 errors                           | Anthropic rate limits or overload.                 | Claude Code waits and tries again. The gateway sends these errors through unchanged.  |
| A `router.json` change has no effect        | The gateway reads the configuration at start.      | Run `pkill -f scripts/gateway.mjs`. The next prompt starts a new gateway.             |

To see if the gateway runs, open `http://127.0.0.1:43170/v1/models`. The list
shows the alias.
