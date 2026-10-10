# Native router: behavior and evidence

This guide describes the Mod shipped in the plugin. Claude Code 2.1.289 is the minimum tested version. The router changes `model` and `effort` on main-conversation steps. Claude Code handles the Anthropic request, credentials, stream, tool execution, and cost ledger. Subagent steps keep their original model and effort.

## Turn behavior

At the first main step of a logical turn, the Mod reads recent message text and asks the active classifier (Jev, Clef, Clef Flash, OpenAI, or Ollama) for a tier, and for the turn's activity unless `activityRouting` is `off`. It applies local policy and saves the route. Tool continuations reuse that route. Before each continuation, context fit is checked again. A large tool result can move the step to a model with a larger window.

The classifier receives the current prompt and at most six preceding user or assistant text messages. Each item is limited to 1,200 characters. It does not receive system messages, tool inputs, or tool results. Claude Code's Anthropic credentials never enter the classifier request. Jev, Clef, Clef Flash, and OpenAI receive the text on their services; Ollama receives it on this machine. [Configuration](configuration.md#classifiers) lists each host.

The default tiers are defined in [Configuration](configuration.md#built-in-defaults). Policy uses vote hysteresis, repeated tool errors, context fit, model availability, and switching-cost estimates. The [architecture](architecture.md#request-flow) explains the event boundary and failure handling.

The activity is what the turn produces: `code`, `debug`, `explore`, `plan`, `review`, `ops`, or `docs`. A route is the tier's own route, the base route, with the activity's override on top. In `on`, the default since 1.7, it applies the overrides. In `shadow` the router shows and records the activity and what `on` would route, and keeps the base route. The activity question reuses the same prompt and dialogue; no other text is sent. With `off` the classifier is asked for the tier only. [Route by activity](user-guide.md#route-by-activity) explains the modes, [Activity routing](activity-routing.md) the default matrix and its evidence, and [Configuration](configuration.md#activity-routing) the schema.

## Controls and session modes

| Control                                | Behavior                                                                                          |
| -------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `/router`                              | Open the pane. Without a UI surface, print short status.                                          |
| `/router auto`                         | Enable automatic routing.                                                                         |
| `/router off`                          | Turn routing off and keep Claude's selected model.                                                |
| `/router pin <tier>`                   | Pin the next turn and tool continuations. Routing on must already be enabled.                     |
| `/router activities <off\|shadow\|on>` | Set the activity routing mode. Written to `router.json` at once; **Undo** in the pane reverts it. |
| `/model <name>`                        | Select a model and turn routing off. `/router auto` turns it back on.                             |

The pane's **Set up** and **Credentials → Edit** buttons open Claude Code's secure plugin configuration. Claude Code refuses `$.command.run` from inside a `command.run` hook, so the Mod starts that dialog from a timer after the press returns.

Mode belongs to a Claude Code session. Clear starts a new session with routing on. Resume restores the saved mode for that session. A new or forked session has a new ID: it starts with routing on for a model that one of the tiers routes to and with routing off for any other model, as a fresh launch does. With activity routing `on`, a model that only an activity override uses also starts the session with routing on. A pin applies to one logical turn, then the prior route resumes. A history reset clears votes and cache evidence; the current turn keeps its route, pin and any native fallback.

## Router pane

The status band is one line above the prompt: a tier meter, the activity, the route, a short reason, classifier support, and context and cache use. Segments drop by priority when the band is narrow: classifier support first, then context and cache, then the activity, then the reason. Hovering reveals pins, **Turn off**, and a two-row view; while routing is off, **Turn on** sits on the band itself, so the band carries one routing control at a time. A fresh session that starts with routing off because of its model shows `<model> is not a routing tier` on the band until the mode changes. The band yields to surveys and does not describe subagent transcripts. A model change between turns raises a toast. A pin, or a step that changes only the effort, such as `medium` to `high` on the defaults, raises none. While the classifier runs, the turn's spinner says `Choosing model`. In Manual mode or when routing is unavailable, the prompt footer carries `routing off` or `routing unavailable`. The **Router** button opens the pane. The pane has four tabs, Now, Routing, Classifier, and Usage, with the routing on/off pair at the top of every tab. The [user guide](user-guide.md#open-the-router-pane) describes each tab.

| Reading                      | Meaning and limits                                                                                                                                                                                                                         |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Now / Served                 | The requested model and effort. **Served** appears only when the engine answered with another model. Actual effort is not reported.                                                                                                        |
| Classifier support           | Per-tier probabilities from the last classification, and the switch bar the policy required. Pins and skipped calls leave it empty.                                                                                                        |
| Activity                     | The classifier's activity choice with its share and the two next-best answers. Empty with routing off, a pin, or no answer.                                                                                                                |
| Route (activity)             | With `on`: the route for the tier and activity, marked `(override)` with the base route beside it, or `(base)`. With `shadow`: what `on` would use, and the route in use (`shadow; same route` when they agree).                           |
| Replies                      | The tier that served each of the last 30 main-conversation replies; a dot where the router did not choose. A second row of letters names each reply's activity: `c` code, `d` debug, `e` explore, `p` plan, `r` review, `o` ops, `w` docs. |
| Routing vs your model (Usage) | Routed replies at configured list prices against the same tokens on your model (the session's model and effort), this session and since the last reset (each session against its own model); the difference split into cheaper models, stronger than yours, and cache writes from switches. `too early` below 10 replies. Output length is held the same; answer quality is not measured. |
| Activity stats (Usage)       | Counts for this session: turns, requests and share per activity; switches by tier and by activity; tool agreement; in `shadow`, turns `on` would route differently with their summed next-request estimate at configured list prices. |
| Across sessions (Usage)      | The counts kept since the last reset: labelled turns, tool agreement on the classifier's raw answer, overall and for `code`, `ops` and `explore`, the two largest mismatches, activity moves inside a tier taken and refused, and the shadow readout. `/router` text shows the agreement. |
| Cost                         | Claude Code's native usage value. A plan's list-price estimates are not subscription cash charges.                                                                                                                                         |
| Context bar                  | Maximum available observed and local estimated context, compared with the routed model's window. The fit rule reserves 20%.                                                                                                                |
| Observed / estimated input   | Claude's local context reading and the router's best current context estimate. `unknown` blocks a move to a smaller window.                                                                                                                |
| Cache reuse                  | Last response's cache-read tokens divided by its reported input counters.                                                                                                                                                                  |
| Cache read / written; Output | Response usage counters. Cache warmth does not prove a particular TTL.                                                                                                                                                                     |
| Input per reply              | Up to 30 observed main-conversation input sizes, scaled from the lowest to the highest reading.                                                                                                                                            |
| Classifier header            | Active classifier state and elapsed time. Missing-key, missing-account, busy, and paused skips have no network latency reading.                                                                                                            |
| Next-turn difference         | Configured-price range for the suggested tier versus the incumbent on the next request. Negative means estimated lower cost.                                                                                                               |
| Conservative payback         | Conditional later-turn estimate based on configured cache prices, future reads, and the last output size. It is not measured savings.                                                                                                      |
| Cache read benefit           | Estimated price difference for observed cache reads before cache writes. It is not net savings.                                                                                                                                            |

The router keeps no bill. Routing vs your model is a configured-price estimate, not a measured saving, and leaves out classifier charges. See [Evaluation](evaluation.md) for what the available trace can support.

## Routing and classifier settings

The Routing tab edits each tier's model alias and effort, the baseline tier, the activity overrides and mode, and four policy controls as one draft. The draft does not affect the active turn, survives a tab change or closing the pane, and is dropped at a new session. **Save** validates the whole file with the same loader the Mod starts with, writes `router.json` for future turns, and keeps unrelated keys. A route, activity override, or policy value equal to the built-in default is removed from the file, so later default changes still reach it. The Classifier tab writes the classifier choice and its deadline at once, and shows each classifier's last checked-in activity probe on the model it ran, from `lib/probe-results.mjs`. **Undo** reverts the settings the last pane write changed, from any tab, until the next write or a new session.

| Control            | Values in the pane                 | Effect                                                                                   |
| ------------------ | ---------------------------------- | ---------------------------------------------------------------------------------------- |
| Deadline           | 500, 1,000, 1,500, 3,000, 5,000 ms | The active classifier's total advice time, including any transient retry. Saved at once. |
| Votes to go down   | 1, 2, 3                            | Consecutive votes for a downgrade; one before a history's first measured reply.          |
| Payback horizon    | 1, 3, 5, 10 turns                  | Later turns included in downgrade economics.                                             |
| Credits cap        | $0.50, $1, $2, $5                  | Largest estimated cold write on a `credits` model.                                       |
| Activity threshold | 50%, 60%, 70%, 80%                 | `policy.activityMass`: the least probability at which an activity applies.               |

Under the routes, **ACTIVITIES** starts with the **Activity routing** selector, `off · shadow · on`, and a hint for the mode. Below it is the effective matrix of the draft: one row per distinct set of cells, `·` where a cell uses the base route, routes abbreviated such as `S·high` for Sonnet · high, and the count of distinct routes, each counted as its own cache. Until the mode is `on` the count carries `once activity routing is on`. **OVERRIDES** reads `in use`, or in yellow `not in use:` with the reason: activity routing is `shadow` or `off`, routing is off, or routing is unavailable. Each override is a row with a model, an effort, and **remove**, and a selector adds one for a free activity and tier. A removed built-in override is saved as the tier's own route, because a file that only omitted it would get the built-in back. Yellow notes flag an override equal to its base route, one stronger than the tier above, and the only cell or tier on its (model, effort) pair, which adds a cache. **Reset routes to defaults** resets the routes only; pending override and mode edits stay in the draft. The Usage tab's **ACTIVITY** table adds each activity's `est. cost`, its replies at list prices, and the route it was `mostly on`; **ACROSS SESSIONS** adds the escalations after a cheaper activity move and the active classifier's p95 latency. The Usage tab's **Reset stats** clears the activity counts and routing vs your model, for this session and across sessions.

The classifier section lists every configured classifier as a row with its service host and whether its key and endpoint settings are complete. Selecting a row writes `classifier` to `router.json` at once, or removes it for the default, through the same validation, and resets the new classifier's failure count. A turn already being classified finishes with its own classifier; its readings stay off the pane. **Undo** returns to the previous classifier. The deadline saves at once too, and a built-in classifier's default deadline is written as no override. **Sends** names the host that receives prompt text.

The pane refuses to write through a symlink. A failed validation names the setting and leaves the file unchanged. New model aliases and the other supported fields need an edit to the active profile's `router.json`.

## Safety and failure states

- A missing key or account ID, a classifier failure, or a policy refusal keeps the current model. Network refusal is never bypassed with a helper process.
- A missing, malformed, or timed-out activity answer keeps the running activity in `on`; the tier answer still applies. In `shadow` the base route runs as always. It does not count as a classifier failure. If the whole classifier call fails, the running route stays. Activity statistics are written inside a guard: a failed store read or write loses that turn's counts and never fails a turn.
- Three launched classifier failures open a 60-second pause for that classifier. One in-flight request is allowed per classifier in each active Mod instance. Pending host HTTP work blocks another request until it settles.
- A `router.json` with v0.8 gateway keys or the 1.1 `jev` section marks the router unavailable until the [migration command](configuration.md#convert-an-older-routerjson) converts it.
- Unsupported Claude Code versions and leftover v0.8 gateway settings (the `jev-router` model or the `127.0.0.1:43170` base URL) mark the router unavailable. `/router` lists the settings to remove. A local gateway does not run as part of this Mod.
- While the router is unavailable, the pane header reads `ROUTING  unavailable  Claude’s model is kept` with the reason, and offers no on/off pair or pins. `/router` without a surface starts with `Routing unavailable: <reason>. Claude’s model is kept.`, and `/router auto`, `off`, `pin`, and `activities` reply the same and change nothing.
- A context-window error makes that model ineligible until the next history reset. The Mod does not retry an Anthropic request after a stream begins.
- Unknown context retains the current model. There is no characters-to-tokens fallback.
- Unknown model substitutions receive no cache credit for the requested model.
- Clear, rewind, branch, or committed compaction clears cache evidence and policy votes. Resume restores the selected session's mode, not its old cache evidence.

## Verified checks

The Team canary loaded the published 1.0.0 package with a full Sonnet baseline, reached the real Jev endpoint, and kept Sonnet on a `downgrade-pending` result. This was a routing smoke test, not a measured-savings trial.

On 2026-10-05, live probes of Clef and Clef Flash on Workers AI took 0.7 to 1.3 seconds per call, one call each, and returned the same answer shape as Jev inside Cloudflare's envelope. A rejected token returned HTTP 401, which the Mod reads as a rejected key. No Clef session has been evaluated for routing quality.

Recorded acceptance checks cover the local HTTP deadline and one-request admission, session clear/resume, circuit-breaker pause, reload, replacement, unload, engine fallback, and interrupt during Jev advice. The interrupt check closed the loopback socket within 4 ms and discarded late advice without changing the active route or UI. Results are stored under [`experiments/mod-router/results`](../experiments/mod-router/results/).

A billed chain of pinned turns moved across Opus, Haiku 4.5, and Sonnet with a tool call on every turn, and no request was rejected. Claude Code builds each model's request itself; Haiku 4.5 received its own thinking mode and a 32K output cap. On Claude Code 2.1.293, a turn pinned to `low` ran on Haiku 5.5 at `high` with a tool call and was served by the requested model (2026-10-08). Sonnet and Opus accepted histories above 589K input tokens. These probes validate the tested path only. Claude Code and organization policy control other model and request combinations.

To stop routing in a session, run `/router off`. To stop loading the Mod, run `claude plugin disable router@alexei-led-claude-router` and restart.
