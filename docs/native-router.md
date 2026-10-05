# Native router: behavior and evidence

This guide describes the Mod shipped in the plugin. Claude Code 2.1.289 is the minimum tested version. The router changes `model` and `effort` on main-conversation steps. Claude Code handles the Anthropic request, credentials, stream, tool execution, and cost ledger. Subagent steps keep their original model and effort.

## Turn behavior

At the first main step of a logical turn, the Mod reads recent message text and asks Jev for a tier. It applies local policy and saves the route. Tool continuations reuse that route. Before each continuation, context fit is checked again. A large tool result can move the step to a model with a larger window.

Jev receives the current prompt and at most six preceding user or assistant text messages. Each item is limited to 1,200 characters. It does not receive system messages, tool inputs, or tool results. Claude Code's Anthropic credentials never enter the Jev request.

The default tiers are defined in [Configuration](configuration.md#built-in-defaults). Policy uses vote hysteresis, repeated tool errors, context fit, model availability, and switching-cost estimates. The [architecture](architecture.md#request-flow) explains the event boundary and failure handling.

## Controls and session modes

| Control              | Behavior                                                                |
| -------------------- | ----------------------------------------------------------------------- |
| `/router`            | Open the details pane. Without a UI surface, print short status.        |
| `/router status`     | Print short status.                                                     |
| `/router auto`       | Enable automatic routing.                                               |
| `/router off`        | Enter Manual mode and preserve Claude's selected model.                 |
| `/router pin <tier>` | Pin the next turn and tool continuations. Auto must already be enabled. |
| `/router setup`      | Open Claude Code's secure plugin configuration for the Jev key.         |
| `/model <name>`      | Select a model and enter Manual mode. `/router auto` resumes routing.   |

Mode belongs to a Claude Code session. Clear starts a new session in Auto. Resume restores the saved mode for that session. A new or forked session has a new ID: it starts in Auto on the baseline model and in Manual on another model, as a fresh launch does. A pin applies to one logical turn, then the prior Auto incumbent resumes. A history reset clears votes and cache evidence; the current turn keeps its route, pin and any native fallback.

## Router pane

The status band stays compact above the prompt. The **Router** button opens a pane with model choice, actual response, reason, metrics, estimates, controls, and tuning.

| Reading                      | Meaning and limits                                                                                                                    |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Last reply / Selected        | Actual response model versus the model requested for that step. The engine does not report actual effort.                             |
| API cost reported by Claude  | Claude Code's native usage value. A plan's list-price estimates are not subscription cash charges.                                    |
| Context bar                  | Maximum available observed and local estimated context, compared with the routed model's window. The fit rule reserves 20%.           |
| Observed / estimated input   | Claude's local context reading and the router's best current context estimate. `unknown` blocks a move to a smaller window.           |
| Cache reuse                  | Last response's cache-read tokens divided by its reported input counters.                                                             |
| Cache read / written; Output | Response usage counters. Cache warmth does not prove a particular TTL.                                                                |
| Input trend                  | Up to ten observed main-conversation input sizes, scaled to the largest one.                                                          |
| Jev / Last classification    | Classifier state and elapsed time. Missing-key, busy, and paused skips have no network latency reading.                               |
| Next-turn difference         | Configured-price range for the suggested tier versus the incumbent on the next request. Negative means estimated lower cost.          |
| Conservative payback         | Conditional later-turn estimate based on configured cache prices, future reads, and the last output size. It is not measured savings. |
| Cache read benefit           | Estimated price difference for observed cache reads before cache writes. It is not net savings.                                       |

There is no router-owned cost ledger or cumulative savings counter. Jev charges are not included. See [Evaluation](evaluation.md) for what the available trace can support.

## Tuning

The pane exposes three controls. Draft changes do not affect the active turn. **Save tuning** validates and writes them to `router.json` for future turns, preserving unrelated keys.

| Control                   | Values in the pane          | Effect                                            |
| ------------------------- | --------------------------- | ------------------------------------------------- |
| Jev deadline              | 500, 1,000, 1,500, 3,000 ms | Total advice time, including any transient retry. |
| Votes before cheaper tier | 1, 2, 3                     | Consecutive votes required for a downgrade.       |
| Payback horizon           | 1, 3, 5, 10 turns           | Later turns included in downgrade economics.      |

The panel refuses to write through a symlink. Other supported configuration fields need an edit to the active profile's `router.json`.

## Safety and failure states

- Missing Jev key, a Jev failure, or a policy refusal keeps the current model. Network refusal is never bypassed with a helper process.
- Three launched Jev failures open a 60-second pause. One in-flight request is allowed per active Mod instance. Pending host HTTP work blocks another request until it settles.
- Unsupported Claude Code versions and leftover v0.8 gateway settings (the `jev-router` model or the `127.0.0.1:43170` base URL) mark the router unavailable. `/router status` lists the settings to remove. A local gateway does not run as part of this Mod.
- A context-window error makes that model ineligible until the next history reset. The Mod does not retry an Anthropic request after a stream begins.
- Unknown context retains the current model. There is no characters-to-tokens fallback.
- Unknown model substitutions receive no cache credit for the requested model.
- Clear, rewind, branch, or committed compaction clears cache evidence and policy votes. Resume restores the selected session's mode, not its old cache evidence.

## Verified checks

The Team canary loaded the published 1.0.0 package with a full Sonnet baseline, reached the real Jev endpoint, and kept Sonnet on a `downgrade-pending` result. This was a routing smoke test, not a measured-savings trial.

Recorded acceptance checks cover the local HTTP deadline and one-request admission, session clear/resume, circuit-breaker pause, reload, replacement, unload, engine fallback, and interrupt during Jev advice. The interrupt check closed the loopback socket within 4 ms and discarded late advice without changing the active route or UI. Results are stored under [`experiments/mod-router/results`](../experiments/mod-router/results/).

A billed chain of pinned turns moved across Opus, Haiku, and Sonnet with a tool call on every turn, and no request was rejected. Claude Code builds each model's request itself; Haiku receives its own thinking mode and a 32K output cap. Sonnet and Opus accepted histories above 589K input tokens. These probes validate the tested path only. Claude Code and organization policy control other model and request combinations.

To stop routing in a session, run `/router off`. To stop loading the Mod, run `claude plugin disable router@alexei-led-claude-router` and restart.
