# User guide

## Start a session

Install the plugin from its marketplace, or load a checkout with `--plugin-dir /path/to/claude-router`:

```sh
claude plugin marketplace add alexei-led/claude-router
claude plugin install router@alexei-led-claude-router
```

Start with the full baseline model so Auto mode has a known starting point:

```sh
claude --model claude-sonnet-5-5
```

In Claude Code:

1. Run `/plugin configure router`.
2. Select the Jev API key option, enter the key, and save it.
3. Run `/router auto`.

The key is stored as a sensitive plugin option. Do not paste it into a model conversation. The [configuration guide](configuration.md) covers optional settings and the old v0.8 migration.

## Read the status band

The Mod adds a band above the prompt and a **Router** button. It reports whether routing is ready, choosing a route, in Manual mode, pinned, degraded, or unavailable. After a reply, it shows the actual model, effort, and reason.

| Status                                          | Meaning                                                                 |
| ----------------------------------------------- | ----------------------------------------------------------------------- |
| `Auto · ready`                                  | Auto mode is ready for a new turn.                                      |
| `choosing for this turn…`                       | Jev advice and local policy are in progress.                            |
| `key not set · keeping …`                       | No Jev key is available. The current model stays active.                |
| `Jev timeout`, `Jev auth`, or `Jev unreachable` | Jev failed. The current model stays active.                             |
| `Jev paused until …`                            | Three launched failures opened a 60-second breaker.                     |
| `context unknown · keeping native model`        | The router could not verify that a smaller window has enough room.      |
| `native fallback`                               | Claude Code substituted another available model for the selected route. |
| `requires Claude Code 2.1.289 or newer`         | This version cannot run the router controls.                            |

Tool continuations do not trigger another classification. Subagent choices remain unchanged.

## Open the router pane

Run `/router` or select **Router** above the prompt. In a terminal without a UI surface, `/router` prints a short status instead. `/router status` always prints the short status.

The pane groups information by purpose:

| Pane section            | What it shows                                                                                                                  |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Model routing           | Auto or Manual, last actual reply, requested model, effort, route reason, and any next-turn pin.                               |
| Usage                   | Claude-reported API cost, context bar, observed and estimated input, cache read/write, output, and a ten-response input trend. |
| Jev and switch estimate | Jev status and last classification time, suggested tier, policy support, and estimated switch cost.                            |
| Controls                | Auto, Manual, tier pins, and secure key configuration.                                                                         |
| Tuning                  | Jev deadline, votes before downgrade, and payback horizon. Save applies changes to future turns.                               |

### Understand usage and estimates

- **API cost reported by Claude** comes from Claude Code's native usage API. If the account is on a plan, a configured list-price estimate is not the subscription cash charge.
- **Context** compares the larger available context reading with the routed model's configured window. The router reserves 20% of that window. Values can be unknown when Claude does not provide the needed estimate.
- **Cache read / written** and **Output** are observed response counters. The cache reuse bar uses cache-read tokens divided by that response's input counters.
- **Input trend** shows up to ten observed main-conversation response sizes. It is a scale comparison, not a forecast.
- **Cache read benefit** is a configured-price estimate for cached reads before write costs. It is not a measured saving.
- **Next-turn difference** compares the candidate with the current model under five-minute and one-hour cache-write scenarios. A negative number means the candidate is estimated to cost less for that request.
- **Conservative payback** estimates later turns to recover an initial difference under assumed future cache reads and the last observed output size. It does not guarantee savings.

There is no router-side spend or savings ledger. The pane does not include Jev charges. Claude's native `/cost` is the source for its reported API cost.

## Change routing

| Command or action                        | Result                                                                      |
| ---------------------------------------- | --------------------------------------------------------------------------- |
| `/router auto`                           | Resume automatic routing.                                                   |
| `/router off`                            | Enter Manual mode and preserve Claude's selected model.                     |
| `/model <name>`                          | Select a model and enter Manual mode. Use `/router auto` to resume.         |
| `/router pin <micro\|low\|medium\|high>` | Pin the next turn and its tool continuations. Auto must already be enabled. |
| **Auto routing** button                  | Resume automatic routing.                                                   |
| **Manual model** button                  | Preserve Claude's selected model.                                           |
| A tier button in the pane                | Pin the next turn. Auto must already be enabled.                            |

A pin does not change the next turn after the pinned turn finishes. A fresh session on the baseline model starts in Auto. A fresh session on another model starts in Manual. Resuming a saved session restores its saved Auto or Manual mode.

## Tune future decisions

Select the tuning values in the pane, then select **Save tuning**. The three controls are:

- **Jev deadline:** 500, 1,000, 1,500, or 3,000 ms for the total advice attempt, including any retry.
- **Votes before cheaper tier:** 1, 2, or 3 consecutive votes.
- **Payback horizon:** 1, 3, 5, or 10 later turns used by the downgrade estimate.

The current turn keeps the settings it started with. A saved tuning change applies to later turns. The pane preserves unrelated `router.json` keys and refuses to write through a symlink. For other supported settings, see [Configuration](configuration.md).

## Move from v0.8 gateway setup

The v1 plugin has the same plugin ID, `router@alexei-led-claude-router`, but it does not start the v0.8 local gateway. Marketplace installs with auto-update receive v1 at the next start. Before the first v1 session:

1. Update the plugin: `claude plugin marketplace update alexei-led-claude-router`, then `claude plugin update router@alexei-led-claude-router`.
2. Remove the settings that v0.8 `/router:setup` wrote. The [migration checklist](configuration.md#convert-a-v08-configuration) lists them: the `jev-router[1m]` model and picker row, the loopback `ANTHROPIC_BASE_URL`, the hint header, and the router status line.
3. Convert `router.json` if you created one.
4. Restart Claude Code with a full baseline model, such as `claude-sonnet-5-5`.

Keep the plugin enabled: in v1 it is the Mod. The Jev key option keeps its saved value. If the band reads `v0.8 gateway settings remain`, step 2 is incomplete.

## Update or stop

Marketplace installs update with `claude plugin update router@alexei-led-claude-router`. For a local checkout, update the files and restart Claude Code with the same `--plugin-dir`.

To stop routing for a session, run `/router off`. To stop loading the Mod, run `claude plugin disable router@alexei-led-claude-router`, or restart without `--plugin-dir` for a checkout. The Mod keeps no session ledger and starts no process.

## Roll back to v0.8.0

v0.8.0 stays available as the signed git tag `v0.8.0` and as `@alexeiled/claude-router@0.8.0` on npm.

1. Disable the v1 plugin: `claude plugin disable router@alexei-led-claude-router`.
2. Check out the tag: `git clone --branch v0.8.0 https://github.com/alexei-led/claude-router ~/claude-router-0.8.0`.
3. If you converted `router.json`, restore the original: `mv ~/.claude/router.json.v0.8.backup ~/.claude/router.json`. v0.8.0 rejects the converted file.
4. Start Claude Code with `--plugin-dir ~/claude-router-0.8.0` and run `/router:setup`. It writes the gateway settings again. Restart.

Launch with that `--plugin-dir` each time. Do not enable v1 and v0.8 together.

## Troubleshooting

| Symptom                                 | Cause                                                                                       | Fix                                                                                                                                                                |
| --------------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Status says the Jev key is missing      | The plugin option is unset or unavailable to this process.                                  | Run `/plugin configure router`, save the option, and start a new turn.                                                                                             |
| Route stays on the current model        | Jev timed out, failed, is paused, or network policy refused the request.                    | Read the status band and `/router status`. Network policy refusal is not bypassed.                                                                                 |
| `/model` changed but routing stopped    | Choosing a model enters Manual mode.                                                        | Run `/router auto` to resume automatic routing.                                                                                                                    |
| Router reports invalid configuration    | `router.json` is invalid, or project/local settings redirect the router profile.            | Inspect `router.json`, remove project/local `HOME` or `CLAUDE_CONFIG_DIR` overrides, or run the [migration command](configuration.md#convert-a-v08-configuration). |
| Router says old settings need migration | `router.json` still contains v0.8 gateway keys.                                             | Run the [migration command](configuration.md#convert-a-v08-configuration).                                                                                         |
| Router controls are unavailable         | Claude Code is older than 2.1.289, or a gateway alias or loopback base URL is still active. | Update Claude Code and remove the old gateway model/base URL from the launcher.                                                                                    |
| Context reads as unknown                | The router lacks a reliable local estimate or current-history measurement.                  | Keep using the current model, or start a new history with a supported context estimate.                                                                            |

For the internal event flow and network deadline behavior, see [Architecture](architecture.md). For what the test traces do and do not show, see [Evaluation](evaluation.md).
