# User guide

## Start a session

Install the plugin from its marketplace, or load a checkout with `--plugin-dir /path/to/claude-router`:

```sh
claude plugin marketplace add alexei-led/claude-router
claude plugin install router@alexei-led-claude-router
```

Start with the full baseline model so Auto mode has a known starting point:

```sh
claude --model claude-haiku-5-5
```

In Claude Code:

1. Run `/plugin configure router`.
2. Enter the credentials of the classifier you use, and save them:
   - **Jev** (the default): the Jev API key from typesafe.ai.
   - **Clef** or **Clef Flash** on Cloudflare Workers AI: the Cloudflare API token and the Cloudflare account ID. One token covers both models.
3. To use Clef or Clef Flash, open the pane's **Classifier** tab and select its row. See [Choose the classifier](#choose-the-classifier).
4. Check the band above the prompt: `▂▄▆█ Auto · ready`. On a model that no tier routes to, the session starts in Manual; run `/router auto` to route.

Keys are stored as sensitive plugin options. Do not paste them into a model conversation. The [configuration guide](configuration.md) covers optional settings and migrations.

## Read the status band

Router draws one line above the prompt. The line ends with a **Router** button that opens the pane. When the band is narrow, the less important parts drop first: classifier figures, then context and cache, then the reason. The tier and model always stay, except behind a classifier warning: the warning and its **Set up** button come first, and the route gives way to them.

![Five band states: routed to high, two rows with the hover row, a pending pin, a missing classifier key, and Manual mode](router-band.svg)

Read the first line of the picture from left to right:

- **Tier meter** `▂▄▆█`: one bar per tier, lit up to the current tier in its color, like signal strength.
- **Tier and model**: the route for this turn. **fallback** means Claude Code answered with another model.
- **Reason**: one or two words with a direction, such as `↑ jump`, `↓ downgrade`, `= fits`, or `… waiting to go down`.
- **Classifier support**: what the active classifier, such as Jev or Clef Flash, gave the switch against the bar the policy required.
- **ctx** and **cache**: context use and cache reuse on the last reply. They turn yellow at 60% context and red at 80%.

| Band shows                                  | Meaning                                                                               |
| ------------------------------------------- | ------------------------------------------------------------------------------------- |
| `Auto · ready`                              | Auto mode is ready for a new turn.                                                    |
| `choosing for this turn…`                   | The classifier and local policy are running. The spinner says `Choosing model`.       |
| `⏵ next turn: high ✕`                       | A pin is set. **✕** cancels it.                                                       |
| `⚠ Jev: no API key · keeping model`         | The active classifier lacks a setting. **Set up** opens the secure plugin dialog.     |
| `⚠ Clef: no account ID · keeping model`     | Clef has its API token but no Cloudflare account ID. **Set up** opens the dialog.     |
| `⚠ Jev timed out · keeping model`           | The classifier failed: timed out, unreachable, rejected the key, or paused.           |
| `○ Router off · keeping …`                  | Manual mode. **Auto** resumes routing. The footer also shows `router off`.            |
| `✕ Router unavailable`                      | Nothing routes: an old Claude Code or leftover v0.8 settings. **Fix** opens the pane. |
| `○ Router · subagents keep their own model` | You are viewing a subagent's transcript, which Router does not route.                 |

Hover over the band for a second row: pin a tier for the next turn, switch to Manual, or show two rows. The two-row band adds a strip of recent replies colored by tier, the switch count, the switch tax, and the cache saving. Router remembers that choice across sessions. When Router changes the model between turns, a toast shows the old and new model and the reason. A pin does not raise one, and neither does a change of effort alone.

The band steps aside while a survey needs the space.

Tool continuations do not trigger another classification. Subagent choices remain unchanged.

## Open the router pane

Run `/router` or select **Router** above the prompt. Without a UI surface, as in `claude -p`, `/router` prints a short status instead. The pane has four tabs. Select a tab or press its digit while the pane has focus.

![The Now tab: the route and reason, classifier support per tier with pin buttons, recent replies by tier, and context, cache and cost](router-pane-now.svg)

The **Now** tab answers "what runs next turn, and why". The ladder lists the tiers from strongest to cheapest with the route each one uses. The bar is the support the classifier gave that tier on the last turn. The line under the ladder compares the support for a switch with the bar the policy required and shows the estimated switch tax. **pin** forces that tier for the next turn only.

![The Routing tab: model and effort per tier, the baseline tier, how each step up is priced, the policy controls, and the unsaved router.json change with Save and Discard](router-pane-routing.svg)

The **Routing** tab edits the routes and the policy. In the picture, `medium` was changed to Sonnet 5.5 at `xhigh`: the tier shows **●**, the tab reads **Routing ●**, the switch-cost lines now price `medium → high` as a model change, and the status bar lists the one `router.json` line that **Save** will write. [Edit routes and policy](#edit-routes-and-policy) explains the controls.

| Tab          | What it shows                                                                                                                                                     |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 Now        | The current tier, model, and reason; the classifier's support for each tier with a **pin** button; the last 30 replies by tier; context and cache.                |
| 2 Routing    | The model and effort for each tier, the baseline tier, the cache cost of each step up; downgrade votes, payback horizon, and credits cap; the `router.json` path. |
| 3 Classifier | The classifier rows with their credentials state, the active classifier's deadline and health, and the credentials each classifier needs.                         |
| 4 Usage      | Claude-reported cost, context and cache detail, input per reply, quota, and configured-price estimates.                                                           |

**Auto** and **Manual** stay at the top of every tab. **?** shows what the estimates leave out.

### Save and undo changes

The two settings tabs follow one rule each, and the section captions say which:

- **Routing**: edit as a set, then save. Changes stay a draft until **Save** (`s`). **Discard** (`d`) drops them. The draft stays when you change tab or close the pane: the tab reads **Routing ●**, and every tab shows the `router.json` lines that **Save** will write, with **Save** and **Discard**. A new session drops the draft.
- **Classifier**: a row or a deadline is written to `router.json` when you select it.

Every write applies from the next turn and can be undone. **Undo** (`u`) puts back the settings the last write changed, from any tab, and leaves any other edit to `router.json` alone. A new session clears it. Green notices confirm a write or an undo; a red one names why nothing was written.

### Understand usage and estimates

- **Cost** comes from Claude Code's native usage API. If the account is on a plan, a configured list-price estimate is not the subscription cash charge.
- **Context** compares the larger available context reading with the routed model's configured window. The router reserves 20% of that window. Values can be unknown when Claude does not provide the needed estimate.
- **Cache** reuse is cache-read tokens divided by the last response's input counters.
- **Classifier support**, such as **Jev support**, is the probability the classifier gave each tier on the last classified turn. The line under it compares the support for a switch with the bar the policy required, and shows the estimated switch tax.
- **Replies** colors each of the last 30 main-conversation replies by the tier that served it. A dot marks a reply the router did not choose, such as one in Manual mode.
- **Input per reply** scales the last 30 input sizes from the lowest to the highest reading. It is a scale comparison, not a forecast.
- **Cache read benefit** is a configured-price estimate for cached reads before write costs. It is not a measured saving.
- **Next-turn difference** compares the candidate with the current model under five-minute and one-hour cache-write scenarios. A negative number means the candidate is estimated to cost less for that request.
- **Payback** estimates later turns to recover an initial difference under assumed future cache reads and the last observed output size. It does not guarantee savings.

There is no router-side spend or savings ledger. The pane does not include classifier charges. Claude's native `/cost` is the source for its reported API cost.

## Change routing

| Command or action                        | Result                                                                      |
| ---------------------------------------- | --------------------------------------------------------------------------- |
| `/router`                                | Open the pane.                                                              |
| `/router auto`                           | Resume automatic routing.                                                   |
| `/router off`                            | Enter Manual mode and preserve Claude's selected model.                     |
| `/router pin <micro\|low\|medium\|high>` | Pin the next turn and its tool continuations. Auto must already be enabled. |
| `/model <name>`                          | Select a model and enter Manual mode. Use `/router auto` to resume.         |
| **Auto** / **Manual**                    | The same as `/router auto` and `/router off`.                               |
| **pin** on the Now tab                   | Pin that tier for the next turn. Auto must already be enabled.              |

A pin does not change the next turn after the pinned turn finishes. A fresh session on a model that one of the tiers routes to starts in Auto. A fresh session on any other model starts in Manual. `/clear` starts the new session in Auto. Resuming a saved session restores its saved Auto or Manual mode.

## Edit routes and policy

On the **Routing** tab, pick a model and an effort for any tier. The model list comes from the aliases in `router.json` `models`, limited by the `availableModels` setting. `session` keeps the effort Claude Code sends. A model without effort levels, such as a custom one with `"efforts": []`, shows `none`.

Changed tiers show **●**. **Reset routes to defaults** (`r`) loads the built-in routes into the draft; **Save** then removes your route overrides from `router.json`.

**Switch cost** reads the draft from the bottom tier up and shows how the policy prices each step. A model change is priced as a cold cache write. An effort change on the same model is also priced as a new messages cache; whether the API actually keeps the cache across an effort change is not measured. Two identical tiers make that step change nothing.

A new model ID needs an entry in `router.json` `models` with its price, context window, and effort levels. See [Configuration](configuration.md).

### Tune future decisions

Under **Policy** on the same tab, pick the values. One **Save** writes them with any route changes:

- **Votes to go down:** 1, 2, or 3 consecutive votes before a cheaper tier.
- **Payback horizon:** 1, 3, 5, or 10 later turns used by the downgrade estimate.
- **Credits cap:** $0.50, $1, $2, or $5 for an estimated cold cache write on a `credits` model.

**Reset policy to defaults** loads the built-in values; **Save** then removes your policy overrides. The current turn keeps the settings it started with. A save preserves unrelated `router.json` keys and refuses to write through a symlink. When validation fails, the pane names the setting and leaves the file unchanged.

## Choose the classifier

Router asks one classifier per turn. Three are built in:

| Classifier | Service                    | Credentials                                    | Deadline |
| ---------- | -------------------------- | ---------------------------------------------- | -------: |
| Jev        | typesafe.ai                | Jev API key                                    | 1,500 ms |
| Clef       | Cloudflare Workers AI, 27B | Cloudflare API token and Cloudflare account ID | 3,000 ms |
| Clef Flash | Cloudflare Workers AI, 9B  | Cloudflare API token and Cloudflare account ID | 3,000 ms |

![The Classifier tab: classifier rows with the active one marked, a missing Jev API key with Set up, the deadline, health, the receiving host, the credentials each classifier needs, and Undo after a switch](router-pane-classifier.svg)

You can save credentials for all of them; only the active one is asked. The **Classifier** tab has one row per classifier: `◉` marks the active one, followed by its service and whether its credentials are complete. A row that lacks one names it, such as `○ no API token`, and has its own **Set up** button.

Select a row to switch. The choice is written to `router.json` at once and applies from the next turn. **Undo** in the status bar returns to the previous classifier. A turn that is already being classified finishes with the classifier it started with. The new classifier starts with a clean failure count.

- **Deadline:** 500, 1,000, 1,500, or 3,000 ms for the active classifier's total advice attempt, including any retry. Each classifier keeps its own deadline, saved at once, with **Undo**.
- **Health** shows recent failures or a pause. **Sends** names the service that receives prompt text.
- **Credentials** lists what each classifier needs, such as `Jev: API key · Clef, Clef Flash: API token, account ID`. **Edit** opens Claude Code's secure plugin configuration, where you enter them.

**Sends** names the service that receives the prompt and recent dialogue. With Clef or Clef Flash that is Cloudflare, not typesafe.ai. Give the Cloudflare token Workers AI permissions only.

The routing policy thresholds were tuned against Jev's probabilities. Clef's probabilities have not been compared with Jev's, so the same prompt can switch tiers at a different point. Watch **Classifier support** for a few sessions before you rely on a new classifier.

## Move from v0.8 gateway setup

The v1 plugin has the same plugin ID, `router@alexei-led-claude-router`, but it does not start the v0.8 local gateway. With auto-update on, Claude Code installs v1 at the next start. Before the first v1 session:

1. Update the plugin: `claude plugin marketplace update alexei-led-claude-router`, then `claude plugin update router@alexei-led-claude-router`.
2. Remove the settings that v0.8 `/router:setup` wrote. The [migration checklist](configuration.md#convert-a-v08-configuration) lists them: the `jev-router[1m]` model and picker row, the loopback `ANTHROPIC_BASE_URL`, the hint header, and the router status line.
3. Convert `router.json` if you created one.
4. Restart Claude Code with a full baseline model, such as `claude-haiku-5-5`.

Keep the plugin enabled: in v1 it is the Mod. The Jev key option keeps its saved value. If the band reads `v0.8 gateway settings remain`, step 2 is incomplete.

## Update or stop

Claude Code updates a marketplace install at startup when auto-update is on for the marketplace. To update now, run `claude plugin marketplace update alexei-led-claude-router`, then `claude plugin update router@alexei-led-claude-router`, and restart. For a local checkout, update the files and restart Claude Code with the same `--plugin-dir`.

To stop routing for a session, run `/router off`. To stop loading the Mod, run `claude plugin disable router@alexei-led-claude-router`, or restart without `--plugin-dir` for a checkout. The Mod keeps no session ledger and starts no process.

## Troubleshooting

| Symptom                                    | Cause                                                                            | Fix                                                                                                                                                                |
| ------------------------------------------ | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Status says `no API key` or `no API token` | The active classifier's plugin option is unset or unavailable to this process.   | Select **Set up** in the pane, or run `/plugin configure router`. Save the option and start a new turn.                                                            |
| Status says `no account ID`                | Clef or Clef Flash is active without the Cloudflare account ID.                  | Run `/plugin configure router` and save the Cloudflare account ID.                                                                                                 |
| Route stays on the current model           | The classifier timed out, failed, is paused, or network policy refused it.       | Read the status band and the pane header. Network policy refusal is not bypassed.                                                                                  |
| `/model` changed but routing stopped       | Choosing a model enters Manual mode.                                             | Run `/router auto` to resume automatic routing.                                                                                                                    |
| Router reports invalid configuration       | `router.json` is invalid, or project/local settings redirect the router profile. | Inspect `router.json`, remove project/local `HOME` or `CLAUDE_CONFIG_DIR` overrides, or run the [migration command](configuration.md#convert-an-older-routerjson). |
| Router says old settings need migration    | `router.json` still contains v0.8 gateway keys or the 1.1 `jev` section.         | Run the [migration command](configuration.md#convert-an-older-routerjson).                                                                                         |
| Band reads `v0.8 gateway settings remain`  | The `jev-router[1m]` model or the `127.0.0.1:43170` base URL is still set.       | Run `/router`: it lists the keys. Remove them as in the [migration checklist](configuration.md#convert-a-v08-configuration) and restart.                           |
| Router controls are unavailable            | Claude Code is older than 2.1.289.                                               | Update Claude Code.                                                                                                                                                |
| Context reads as unknown                   | The router lacks a reliable local estimate or current-history measurement.       | Keep using the current model, or start a new history with a supported context estimate.                                                                            |

For the internal event flow and network deadline behavior, see [Architecture](architecture.md). For what the test traces do and do not show, see [Evaluation](evaluation.md).
