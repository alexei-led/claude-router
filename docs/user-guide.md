# User guide

## Start a session

Install the plugin from its marketplace, or load a checkout with `--plugin-dir /path/to/claude-router`:

```sh
claude plugin marketplace add alexei-led/claude-router
claude plugin install router@alexei-led-claude-router
```

For another execution provider, follow [Providers](providers.md). That guide covers profile names, defaults and custom files.
The following startup example uses the default Anthropic profile.

Start with the full baseline model so routing has a known starting point:

```sh
claude --model claude-haiku-5-5
```

In Claude Code:

1. Run `/plugin configure router`.
2. Enter the credentials of the classifier you use, and save them:
   - **Jev** (the default): the Jev API key from typesafe.ai.
   - **Clef**, **Clef Flash** or **Clef Omni** on Cloudflare Workers AI: the Cloudflare API token and the Cloudflare account ID. One token covers all three models.
   - **OpenAI**: an OpenAI API key. The prompt text goes to OpenAI.
   - **Ollama**: no credential. Run `ollama serve` and pull the model; the prompt text stays on this machine.
3. To use another classifier, open the pane's **Classifier** tab and select its row. See [Choose the classifier](#choose-the-classifier).
4. Check the band above the prompt: `Routing on · ready`. On a model that no tier routes to, and that no activity override uses with activity routing `on`, the session starts with routing off and the band says why; run `/router auto` to route.

Keys are stored as sensitive plugin options. Do not paste them into a model conversation. The [configuration guide](configuration.md) covers settings and migrations.

In this guide, `router.json` means the selected router file. For example, with `CLAUDE_ROUTER_PROVIDER=zai`, edits go to `zai-router.json`.
The pane shows its provider and file path.

## Read the status band

Router draws one line above the prompt. The line ends with a **Router** button that opens the pane. When the band is narrow, the less important parts drop first: classifier figures and the switch cost, then context and cache, then the activity, then the reason. The meter and the model always stay, except behind a classifier warning: the warning and its **Set up** button come first, and the route gives way to them.

![Eight band states: routed to high, two rows on a Claude plan with the hover row, two rows on an API key, a pending pin, a missing classifier key, routing off, an activity move with activity routing on, and cost mode](router-band.svg)

Read the first line from left to right:

- **Tier meter** `▂▄▆█`: one bar per tier, lit up to the current tier in its color, like signal strength. The same bars name the tiers everywhere: `▂` micro, `▂▄` low, `▂▄▆` medium, `▂▄▆█` high.
- **Model**: the model and effort that run this turn, such as `Opus 5.5 · xhigh`. **fallback** after it means Claude Code answered with another model.
- **Activity**: the kind of work, in orange italic: `code`, `debug`, `explore`, `plan`, `review`, `ops` (commands: git, builds, tests, CI) or `docs`. See [Route by activity](#route-by-activity). When the reason already names the activity, the band does not repeat it.
- **Reason**: a glyph and a few words. `↑` moved up, `↓` moved down, `=` stayed, `…` waits, `!` a problem, `⏵` a pin: `↑ clearly stronger`, `↓ cheaper fits`, `= fits`, `… cheaper, waiting`, `↑ code` for an activity move.
- **Classifier support**: what the active classifier, such as Jev or Clef Flash, gave the switch against the bar the policy required, such as `Jev 88% ≥ 82%`. When whole percents would read as equal, it shows tenths: `Jev 81.0% < 81.4%`.
- **Switch cost**: `switch ≈ $0.48`, the policy's price for the switch it weighed this turn, mostly the prompt cache the other model must write. For a move to a cheaper model it is net of what that model saves over the next turns. The higher the cost, the higher the bar a stronger model must clear.
- **ctx** and **cache**: a gauge of context use on the model that runs next, and the share of input read from the cache on the last reply. The gauge turns yellow at 60% and red at 80%.

| Band shows                                   | Meaning                                                                                                                  |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `▂▄▆█ Opus 5.5 · xhigh   ready`              | Routing is on and ready for a new turn.                                                                                  |
| `▂▄▆█ choosing…   Jev ≤ 1.5 s`               | The classifier and local policy are running, within the classifier's deadline. The spinner says `Choosing model`.        |
| `⏵ next ▂▄▆ Opus·medium ✕`                   | A pin is set for the next turn. **✕** cancels it.                                                                        |
| `⚠ Jev: no API key [ Set up ]`               | The active classifier lacks a setting; routing keeps the model (`= no advice`). **Set up** opens the secure plugin dialog. |
| `⚠ Clef: no account ID [ Set up ]`           | Clef has its API token but no Cloudflare account ID. **Set up** opens the dialog.                                        |
| `⚠ Jev timed out [ Details ]`                | The classifier failed: timed out, unreachable, rejected the key, or paused. **Details** opens the pane.                  |
| `○ Opus 5.5 · xhigh [ Turn on ]  routing off` | Routing is off: Claude's model answers every turn. **Turn on** turns it back on. The footer also shows `routing off`.   |
| `✕ Opus 5.5 · xhigh [ Fix ]  routing unavailable` | Nothing routes: a missing/invalid provider file, an old Claude Code, or leftover v0.8 settings. **Fix** opens the pane. |
| `agent ■ Haiku 5.5  ↓ from Opus 5.5 (Claude Code’s pick)` | You are viewing a subagent's transcript: the model it runs on, and who picked it; see below.        |

**Turn on** and **Fix** sit next to the model and stay at any width.

### The hover row and two rows

While routing is on, hover over the band for a second row: a pin per tier, low to high, each named by what it runs (`▂▄ Haiku·high`); **Turn off**; and **2 rows** or **1 row**. A pin forces that tier for the next turn only. On a narrow band the pins lose their model names first; **Turn off** and the row choice stay. The hover row needs a pointer: from the keyboard, run `/router off`, or open the pane and press `f`.

**2 rows** adds the session under the route, in the same numbers as the pane's SESSION block. On a Claude plan it leads with the plan windows Claude Code reports:

```text
plan 5h ▰▰▰▰▱▱▱▱ 48% ↻18:00   7d 43%   session ≈$6.40 API value   −$1.84 (−22%) vs Opus 5.5   64 replies
```

On an API key, or a provider billed in credits, the same row reads `session $6.40 billed   −$1.84 (−22%) vs Opus 5.5   64 replies`. Read it as: this session's replies cost $6.40 at list prices, $1.84 less than the same tokens on Opus 5.5, the model `/model` selected. The band names that model while every main reply was priced against it and no subagent ran. Otherwise it reads `vs unrouted`: your model on every main-thread reply and Claude Code's own pick for every subagent, priced on the same tokens. Minus is cheaper, plus is dearer; past double it reads as a ratio, `+$2.48 (×5.0)`. `≈` marks [API value](#how-dollars-are-paid): plan quota, not a charge. A profile that mixes plan and credits models adds the billed part, `billed $4.10`. Before the tenth routed reply the count reads `3 replies so far`, because one model switch and its cache write can still decide a short run. Some situations change the middle part:

- `effort low 4 · high 2`: the profile runs one model and routing moves only the effort, so no saving is estimated; see [Providers](providers.md).
- `3 of 20 not compared`: some replies have no comparison, such as on a provider whose cache hit rate cannot be known; no saving is shown.

The router's total counts the replies it routes and the subagents. Claude Code's `/cost` also counts side calls the router does not see, such as titles and compaction, and its server-side tools; run `/cost` for the whole session cost.

When the row is short, the reset time, the counts and the words drop first; the 5h window and the session total stay. Router remembers the one- or two-row choice across sessions. When Router changes the model between turns, a toast reads `Model changed: old → new · reason`. A pin does not raise one, and neither does a change of effort alone.

The band steps aside while a survey needs the space.

Inside a turn the router checks the route again as the work changes; see [Changes during a task](#changes-during-a-task). A subagent gets at most one model, when it starts, and keeps it for every step: For the Anthropic profile, these are Haiku for exploration, Opus for clearly hard tasks, and Sonnet for the rest. Other profiles have [their own defaults](providers.md#activity-overrides). An agent that pins a model in its definition keeps it, unless it sets `modelRouting: auto`. The Usage tab's **SUBAGENTS** section shows what each agent type ran on and cost, and the Now tab adds this session's agents to its total. See [Subagent routing](configuration.md#subagent-routing).

In a subagent's transcript the band names the model the agent runs on and who picked it. `agent ■ Haiku 5.5  ↓ from Opus 5.5 (Claude Code’s pick)` means the router chose a cheaper model than Claude Code would have; `↑` means a stronger one. A hollow `□` means the agent ran on Claude Code's pick, because the router agreed or did not route it, and says why: `agent □ Opus 5.5  = Claude Code’s pick: the workflow sets it`. A narrow band drops the comparison first. The band falls back to `agent · model chosen at spawn` when the router has no record of the agent, such as after a plugin reload, and to `agent · keeps its own model (subagent routing off)`.

## Open the router pane

Run `/router` or select **Router** above the prompt. Without a UI surface, as in `claude -p`, `/router` prints a short status instead. The pane has five tabs. Select a tab or press its digit while the pane has focus.

| Tab          | What it answers                                                                                                                                             |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 Now        | What runs next turn, and why, with a **pin** per tier; the plan windows; this session's cost against no routing; context and cache.                     |
| 2 Routes     | Which model runs: one grid of tiers by activities, the activity routing mode, and an editor for the selected cell.                                          |
| 3 Policy     | How readily the router changes models: the start tier, going down, going up, the activity threshold, the credits cap; the `router.json` path.               |
| 4 Classifier | Which classifier to ask: one row per classifier to compare, the active one's deadline, wait, health and credentials, and the counts kept across sessions.   |
| 5 Usage      | What routing cost against no routing this session, today, over 7 or 30 days, this month or in all: by activity, model or tier, and what is worth a look.    |

The top line of every tab, `ROUTER  [ ◉ on ] [ ○ off ]  Jev ready · 347 ms`, shows the routing mode, switches it, and says whether the classifier is ready. Press `o` or `f` while the pane has focus. The tabs under it carry their digits, `[ 1 Now ] [ 2 Routes ] …`, and **?** shows what the numbers mean above the tab. When routing is unavailable, the top line reads `ROUTER  unavailable  Claude’s model is kept` with the reason under it, and offers no on or off: see [Troubleshooting](#troubleshooting).

![The Now tab in four blocks. NEXT TURN: the tier meter, model and activity, the reason with the classifier support and the switch cost, one pin per tier. PLAN: the 5-hour and 7-day windows with their resets. SESSION: the total with one running subagent as API value, the difference against unrouted, the main thread and the subagents as bars, and a strip of every reply colored by tier. CONTEXT: the window fill and the cache reuse](router-pane-now.svg)

The **Now** tab has four blocks, each with its name in capitals.

**NEXT TURN** answers "what runs next turn, and why". The first line is the tier meter, the model and effort, and the classifier's activity with its share, such as `code 84%  debug 8%`. When an activity override runs, a line under it names the tier's own route. **why** gives the reason in the band's words and, beside it, the classifier's support against the bar the policy set and the switch cost: `↑ clearly stronger   Jev 88% ≥ 82% · switch ≈ $0.48`. **pin** has one button per tier, low to high, each named by what it runs, such as `▂▄ Haiku·high 3%`, with the support the classifier gave it on the last turn; `▶` marks the tier that runs now. A press forces that tier for the next turn only, and `⏵ next turn ▂▄▆ Opus·medium [ unpin ]` shows the pin until it applies. With routing off, the block names Claude's model, `routing off · /model choice`, and the pins say they need routing on; nothing from an earlier routed turn stays.

**PLAN** appears on a Claude plan: Claude Code's 5-hour and 7-day windows as gauges, with when each resets. They turn yellow at 75% and red at 90%.

**SESSION** sums this session, the main thread and its subagents: `since 14:18 · 86 replies · 6 agents · 9 switches`, and `● 1 running` while a subagent is in the middle of a turn (an agent that waits on its own background command is not counted until it resumes). The counts include the replies of the turn still running.

```text
SESSION  since 14:18 · 86 replies · 6 agents · 9 switches  ● 1 running
  ≈$8.97  API value · plan quota, not billed  [ Usage ]
  −$4.09 (−31%) vs unrouted ≈$13.06
  main   ≈$6.45  ████████████████  −$4.17 vs Opus 5.5 · xhigh
  agents ≈$2.52  ██████░░░░░░░░░░  +$0.08 vs their picks
  tiers ███████████████████████████████████████████  2 replies per cell
        ▂▄ 41   ▂▄▆ 12   ▂▄▆█ 33
```

- The first line is the total and how it is paid: `API value · plan quota, not billed` on a plan, `billed at list prices` on an API key or credits, and `API value · $4.10 of it billed as credits` when a profile mixes the two. See [How dollars are paid](#how-dollars-are-paid). **Usage** opens the Usage tab on this session.
- The second line is the difference and what the same tokens would have cost: `vs Opus 5.5 ≈$13.06` when every main reply was priced against your model and no subagent ran, else `vs unrouted ≈$13.06`. The parts add up: main and agents make the total, and their differences make the session's difference (−$4.17 + $0.08 = −$4.09). Before the tenth main reply a line follows: `3 replies so far: one model switch can still move this a lot`. A narrow pane drops the amount first.
- **main** compares the main thread with your model, **agents** compares the subagents with Claude Code's picks. The bars share one scale.
- An effort-only profile shows `effort routing on one model: no saving is estimated` and its effort mix instead. When some replies have no comparison, the block says how many and shows no saving.
- When cache rebuilds cost more than the cheaper models saved, `▲ switches cost more than they saved` follows, with **Policy** to raise the bar for a switch.
- **tiers** is a strip that colors every reply since Claude Code started the session by the tier that served it; a dot marks replies routing did not serve, such as those with routing off. Each cell is one reply up to 48 cells. Past that, and on a pane too narrow for the cells, pairs of cells merge and the strip says how many replies a cell holds. After Claude Code restarts a resumed session, the strip starts again and says since when, such as `since 15:02`. The replies per tier, low to high, follow as their meters.
- Replies on a model without a list price reach the strip but have no cost: the block says `no priced replies: cost unknown`.

**CONTEXT** gives the context gauge on the model that runs next, with the tokens against its window, and the cache reuse of the last reply and of the session. **details** adds the counters and estimates in [Understand usage and estimates](#understand-usage-and-estimates).

### Save and undo changes

The settings tabs follow one of two rules, and the section captions say which:

- **Routes** and **Policy**: one draft for both, edited as a set, then saved. Changes stay a draft until **Save** (`s`). **Discard** (`d`) drops them. The draft stays when you change tab or close the pane: the tab whose settings changed reads **Routes ●** or **Policy ●**. Those two tabs list the `router.json` lines that **Save** will write; the other tabs show the count with **Save** and **Discard**. A new session drops the draft.
- **Classifier**: a row or a deadline is written to `router.json` when you select it.

Every write applies from the next turn and can be undone. **Undo** (`u`) puts back the settings the last write changed, from any tab, and leaves any other edit to `router.json` alone. A new session clears it. Green notices confirm a write or an undo; a red one names why nothing was written.

### Compare routing with no routing

![The Usage tab over 7 days: the period buttons, the difference against unrouted first, then a cost table whose rows add up (the main thread with its cheaper-model saving and cache rebuilds, the subagents, the total), the tokens, the cost by activity with code opened to its routes, the cost by day, and the cell worth a look with a link to Routes](router-pane-usage.svg)

The Usage tab keeps observed routed spend and, when the cache history permits it, compares it with **unrouted**: your model on every main-thread reply and Claude Code's own pick for every subagent, priced on the same tokens. Your model is the model `/model` (or `--model`) selected, at the session effort, when a reply ran. The router prices observed tokens at the list prices in `router.json`.

The top row picks the period: **Session**, **Today**, **7d** (today and the six days before), **30d**, **Month** (since the first of this month) and **All**. Press `p` for the next one. The pane remembers the choice across sessions. Session holds this session's replies, and the line under the row names your model, or every model when `/model` changed during the session. The other periods add up the replies of every session on those calendar days. Each session counts against its own model, and the line reads `all projects · Oct 7 – Oct 13 · each session vs its own model`.

When the period is comparable, the difference comes first, then one table whose cents add up:

```text
−$12.29 (−37%) vs unrouted

                              cost    vs unrouted    unrouted
main · 221 replies         ≈$15.33        −$11.78     ≈$27.11
  cheaper models                          −$12.29
  cache rebuilds                           +$0.51   4% of the saving
agents · 15                 ≈$5.60         −$0.51      ≈$6.11
─────────────────────────────────────────────────────────────
7 days · ≈ API value       ≈$20.93        −$12.29     ≈$33.22
```

| Row              | What it is                                                                                                   |
| ---------------- | ------------------------------------------------------------------------------------------------------------ |
| main             | The main thread's routed replies, against the same tokens on your model with one cache that never switched. |
| cheaper models   | What routing saved on replies that ran on models cheaper than yours.                                         |
| stronger models  | What replies on models stronger than yours cost on top. Shown only when not zero.                            |
| cache rebuilds   | What rewriting the prompt cache after a model switch cost, and its share of the saving.                      |
| agents           | The subagents, against the same tokens on Claude Code's pick for each.                                       |
| total            | The period's cost, its difference, and what unrouted would have cost: `billed` or `≈ API value`.          |

Each row reads across: cost − unrouted = the difference. Down the table, main and agents make the total, and cheaper models, stronger models and cache rebuilds make main's difference. A profile that mixes plan and credits models adds `billed as credits` under the total. Below 10 routed replies the difference adds `3 replies so far: one model switch can still move this a lot`, because one switch and its cache write can decide a short run.

When some replies have no comparison, the tab says `3 of 20 replies have no comparison: no saving is shown.`, and the table shows the cost alone. Counts, tokens, breakdowns and trends still include those replies; a row with incomplete coverage shows `—` against no routing, and **What if** stays unavailable rather than inventing a baseline. This is common with automatic provider caches, whose future hit rates are unknown. An effort-only profile says `Effort routing on one model: no saving is estimated; the cost is what was billed.`

#### How dollars are paid

Every dollar in the band, `/router`, the Now tab and Usage is the same measure: the reply's tokens at the list prices in `router.json`. How it is paid decides its label:

- **On a Claude plan** it is quota, not a charge: an API value, shown with `≈`, such as `≈$8.97 API value`. The plan's windows are on the band and the Now tab.
- **On an API key, or a provider billed in credits**, it is what is billed: `$8.97 billed`.
- **A profile that mixes the two**, such as the [model-proxy profile](providers.md#mix-anthropic-and-deepseek-with-model-proxy) with Opus on the plan and DeepSeek in credits, gets one sum and one comparison, and says which part is billed: `≈$24.10 API value · billed $4.10`.

The router reads the plan from Claude Code's plan windows, from the first reply on; until then a plan session reads as billed, with nothing spent yet. `billing` in `router.json` sets only the credits cap on cold cache writes. The router's dollars leave out what it does not see: titles, compaction, server-side tools and classifier charges. For the whole session cost, run Claude Code's `/cost`.

A line of counts follows the table: replies, turns, input tokens, the share of the input read from the cache, and output tokens. With routing off or unavailable and no routed reply this session, the tab says the replies use your model and are not counted.

**BY** splits the period's cost by **Activity**, **Model** or **Tier**. Press `g` for the next grouping. Each row gives the replies, the routed cost and its difference against no routing. The last column is the route most of the row's replies used, or, by model, the row's share of the cost. By tier the rows run low to high, each named by its meter. Select **▸** to open a row. An activity lists its routes, and a model or a tier lists its activities. A line under them gives the row's cheaper, stronger and cache-rebuild parts and its tokens. A narrow pane drops the last column first.

The next line draws the routed cost as blocks: **COST BY HOUR** over today's hours for Session and Today, **COST BY WEEK** for a period longer than 45 days, and **COST BY DAY** otherwise. A dot is a bucket without replies. **What if** (`c`) shows instead the period's tokens priced on each model alone, beside the routed cost and your model. It answers whether a cheaper default would have cost less than routing. A model without a price for some reply is left out. **Trend** (`c`) goes back.

From 20 routed replies in the period, **WORTH A LOOK** lists up to three findings:

- the activity and tier that carried a quarter or more of the cost
- the cache rebuilds, when they used 15% or more of the cheaper-model saving
- the activity and tier that ran most above your model

Each line has a button to the tab that changes it. **Routes** opens that cell in the grid, and **Policy** the switching thresholds. The tab never says which model to use, because it does not measure answer quality.

**All** also counts the totals that earlier versions kept without dates, and says so under the total: `includes $4.10 routed before dated records, kept without a breakdown`. The breakdown and the trend start at the first dated day. The router keeps the daily records for 400 days.

**Delete history**, at the bottom, asks once more, then deletes the usage, activity and subagent records of every session and clears this session's counts. Nothing brings them back. To look at a shorter span, pick a period instead.

These are estimates, not a bill. They hold the tokens and the output length the same, although another model may write more or less, and they do not measure answer quality. Your model's cache reads the previous prompt inside the cache lifetime Claude Code uses, one hour on a Claude plan, and never less than the API actually read. A route that changes only the effort, such as Opus at `xhigh` to Opus at `medium`, costs no less per token: it shows only its cache writes. [Evaluation](evaluation.md#routing-vs-no-routing) explains the method.

![What if on the Usage tab for this session, by tier: the same tokens on Haiku 5.5, Sonnet 5.5 and Opus 5.5 as your model beside what routing spent, as bars with the difference against yours](router-pane-usage-whatif.svg)

### Understand usage and estimates

- **Plan windows** are Claude Code's 5-hour and 7-day readings of the plan quota used. A reset time that has passed is not shown, because the reading is then stale.
- **Context** compares the larger available context reading with the configured window of the model that runs next. Values can be unknown when Claude does not provide the needed estimate. A route never moves to a model whose window the context would fill past 80%.
- **Cache** reuse is cache-read tokens divided by the last response's input counters.
- **Classifier support**, such as **Jev support**, is the probability the classifier gave each tier on the last classified turn. **why** on the Now tab compares the support for a switch with the bar the policy required, and shows the estimated switch cost.
- **Route switches** on the Now tab count the turns whose route differed from the turn before: a change of model or effort, so a move from Sonnet to Haiku inside `low` counts too, although its strip color stays. They are the switches the Usage tab counts, and a pin is not one. **Cache rebuilds** is the cache-write cost of those switches inside the saving.
- **Input per reply**, under **details** on the Now tab, scales the input sizes of the last 30 replies from the lowest to the highest reading. It is a scale comparison, not a forecast.
- **Cache hits saved** is a configured-price estimate for cached reads before write costs. It is not a measured saving.
- **Next-turn difference** compares the candidate with the current model under five-minute and one-hour cache-write scenarios. A negative number means the candidate is estimated to cost less for that request.
- **Payback** estimates later turns to recover an initial difference under assumed future cache reads and the last observed output size. It does not guarantee savings.

On the Usage tab, **SUBAGENTS** covers the same period as the rest of the tab: this session, or every session in every project that uses this router install (`all projects`), since the last **Delete history**. Each agent is one square, colored by the model it ran on: filled (`■`) when the router moved it off the model Claude Code would have picked, hollow (`□`) when it ran on Claude Code's pick, because the router agreed or did not route it. The models and their agents follow the squares, then how many the router moved, and what routing saved or cost on the routed agents against Claude Code's picks, in the session's words: `routing −$0.10 (−13%) vs Claude Code’s picks on 3 routed agents`. 7d, 30d, Month and All add the agents per day. **ROUTED** lists each agent type the router picked a model for: its squares, agents, cost, and **vs CC**, the same tokens on Claude Code's pick. A row opens to its models, each with how many agents the router kept, moved up or moved down, and to its requests per agent, respawns and classifier failures. **NOT ROUTED** lists the agents Claude Code picked a model for, by reason, with why: `the workflow sets it`, `your model` for a fork, `its agent file sets it`. A row without any priced request says `no price`. Records from before 1.14.0 have no date or model: Session and All add them as one line, and an empty Today or 7d says so. See [Subagent routing](configuration.md#subagent-routing). On the Now tab, **details** adds the context and cache counters, the output of the last reply, the input per reply, and the estimates above.

The router keeps no bill. Its dollars are estimates at configured list prices and leave out classifier charges and the side calls it does not see; run `/cost` for Claude Code's own session cost.

## Route by activity

A tier says how hard the work is. The activity says what kind of work it is. The classifier names it for each new turn, by what the turn produces:

| Activity  | The turn produces                                               |
| --------- | --------------------------------------------------------------- |
| `code`    | Changed code or config, including tests                         |
| `debug`   | A found cause: failing tests, stack traces, "why does X..."     |
| `explore` | An answer: explain code, find where something happens, research |
| `plan`    | A decision or plan: design, task breakdown, trade-offs          |
| `review`  | Findings about existing code: a PR, a diff, an audit            |
| `ops`     | Executed commands: git, builds, test runs, CI, deploys          |
| `docs`    | Prose for people: README, docs, comments, commit messages       |

A mixed turn such as "fix it and commit" takes the hardest part, here `code`. The router then picks the route by tier and activity. With the default overrides, a `low` coding turn runs on Sonnet 5.5 at `high`, a `low` git turn stays on Haiku 5.5 at `high`, and a `medium` git turn moves from Opus 5.5 to Haiku 5.5 at `high`. [Activity routing](activity-routing.md) explains the default matrix, why each cell is there, and how to change it.

The mode decides what happens with the label:

| Mode  | What the router does                                                                       |
| ----- | ------------------------------------------------------------------------------------------ |
| `on`  | The default. Applies the activity overrides.                                               |
| `off` | Does not ask the activity: the classifier is asked for the tier only. The base routes run. |

To turn activity routing off, run `/router activities off`, or set **Activity routing** at the top of the Routes tab and press **Save**. Routing itself stays on: only the activity overrides stop. Upgrading from 1.6, which asked the activity but ran the base routes, run `/router activities off` to keep 1.6's routes. A `router.json` that still sets `"shadow"`, for activity or subagent routing, is read as not setting it, so the default, `on`, runs.

When an override runs, **NEXT TURN** on the Now tab adds a line with the tier's own route: `code at low runs on Sonnet 5.5 · high · tier route Haiku 5.5 · high`.

How the router moves inside a tier:

- It compares routes, not labels. If the new activity resolves to the route already running, nothing switches.
- A move to a stronger route needs the classifier's support, as an upgrade between tiers does. A move to a cheaper one must pay back its cache write within the payback horizon. One vote is enough for either, because the activity is a fact about this turn.
- An activity applies only when the classifier gives it at least 60% probability (`policy.activityMass`). Below that, or on `uncertain`, a new task goes back to its base route if the move passes the same checks. On the running task the activity can move either way while the turn runs; see [Changes during a task](#changes-during-a-task).
- A pinned turn uses the pin's base route and shows no activity.
- When the classifier gives no answer at all (a timeout, a failure, a pause, or a missing key), the running route stays. When it answers the tier but gives no usable activity, only the running activity stays: the tier answer still applies, so the turn can change tier and keeps its activity there. In `off` the base route always runs.
- A fresh session starts with routing on when the session model is a tier's route. With activity routing `on`, a model that only an activity override uses also counts: Sonnet 5.5 on the defaults. In `off` it does not.

The band's activity label appears only when the activity applies, so a weak or `uncertain` answer shows none. The two-row band and the **Replies** strip show the activities of recent replies.

### Changes during a task

The classifier labels a turn from its prompt, and the work can change after that: a brief that reads as `ops` may turn into an hour of coding, and a hard fix may end in routine commands. The router therefore checks the route again while a task runs, for the tier and the activity, in both directions.

- **On every later step of a turn** it reads the turn's tool calls. A turn labelled `ops` or `explore` that edits a code file moves at once to the tier's `code` route (`docs` when it edits only Markdown or `docs/` files). The tools are the evidence, so this needs no classifier support, and the cache cost does not hold it back; only the cash cap on a credits-billed model can. This move only goes up. The toast and the band show it as `↗ coding`.
- **Every 4 requests inside a turn** (`policy.reviewEveryRequests`) it asks the classifier again, in the background, with the turn's prompt and the recent dialogue. A step never waits for the answer: it applies at the first step after it arrives. Each review sends the classifier the same kind of text a new turn does. `0` turns reviews off.
- **A new prompt that continues the task** is decided the same way as a review. Claude Code stamps each prompt with where it came from. A task notification, an observer's report or a programmatic follow-up is always progress on the running task: the classifier is asked about your last request, with the notification as the newest dialogue line, so it judges the work still to do rather than the notification's wording. A message from you or another agent, or "go on", counts as the running task when the classifier scores it as a continuation. After a resume the router does not know your last request yet, so a notification is judged as it reads.

On the running task:

- A stronger tier takes the usual votes: two agreeing answers, or one for a clear two-tier jump. A stronger activity takes one answer whose probability clears the cache check. Repeated tool errors still escalate at once.
- A cheaper tier or activity also waits for a checkpoint: at least 8 requests since the last model change (`policy.minDwellRequests`), and a success since then that fits the work the route runs for. A passed test, build, lint or type-check always counts. A check is a test runner, type checker or linter (`pytest`, `tsc`, `eslint`), or a launcher running one (`npm test`, `go test`, `make lint`), alone or after `&&`. A check piped into another command (`npm test | tail`), followed by `;` or `|| true`, or sent to the background does not count, because its exit status can hide a failure or is not known yet. Without a passed check, the route's activity decides what counts:
  - `ops`: the last command that ran something succeeded, with no file edit or delegated agent since.
  - `docs`: the last edit succeeded and touched only Markdown, text or `docs/` files, with no command run beside it.
  - `explore`, `plan`, `review`: a turn finished, nothing was edited, written, run or delegated, and the last tool result was not an error.
  - `code`, `debug` and a route with no activity: only a passed check counts.

  A failed check blocks every one of these, and so does a check whose result is not the check's own (chained, redirected, piped, after `;` or `||`, or in the background). While no checkpoint is met, the route stays: for a tier the band shows `… down after a checkpoint`; a held activity keeps the running one and shows `= fits`. A cheaper activity also needs 90% probability (`policy.downgradeMass`).
- A cheaper tier lands where the answer as a whole points: when the classifier says `micro` 63% and `low` 30%, the turn moves to `low`, which 93% of the answer supports, instead of staying until `micro` alone reaches 90%.
- A pinned turn does not move. A new task, a prompt the classifier does not score as a continuation, is routed as a fresh turn. Ollama does not answer the continuation question, so every prompt is a new task to it; reviews inside a turn still apply.

These thresholds are starting values. They are not tuned on data yet.

### Read the activity on the pane

- **Now**: the first line of **NEXT TURN** names the classifier's activity with its share and the next answer, such as `code 84%  debug 8%`. An `uncertain` answer is shown dim: it applies no activity. In `on`, a line under it names the cell when the route is an override, such as `code at low runs on Sonnet 5.5 · high · tier route Haiku 5.5 · high`, and **why** reads `↑ code` or `↓ ops` when the activity moved the route; a refused move, a hold, or a tier change keeps its reason.
- **Routes**: see [Edit routes and policy](#edit-routes-and-policy). Each activity is a row of the grid, and a cell shows the model the activity runs at that tier.
- **Usage**: **BY** with **Activity** lists the period's replies, cost and difference against no routing per activity, and `mostly on`, the route most of its replies used, such as `Sonnet 5.5 · high`; opening a row lists its routes. Replies whose turn had no applied activity count as `no activity`. The **cache rebuilds** row counts the route switches by tier and by activity together. See [Compare routing with no routing](#compare-routing-with-no-routing).
- **Classifier**: **THIS SESSION** gives **Agreement**, how often the tools a turn used fit the classifier's activity (see [Evaluation](evaluation.md#tool-agreement)).

On the **Classifier** tab, **ACROSS SESSIONS · since the last reset** shows the counts kept across sessions, once there are any: the turns labelled from their tools, **Agreement** over them, **Code/ops/explore**, the same agreement over the turns the classifier answered `code`, `ops` or `explore` (omitted when there are none), the two most frequent mismatches as `predicted → observed count` (`code → read 3`), **Activity moves**, the moves to another route inside a tier, taken and refused for any reason, **Escalations**, such as `after a cheaper activity move: 1 in 12 moves`, the tool-error escalations that followed a move to a cheaper route in `on` while the turns stayed on it in `on` (turning routing off, a turn with routing off, or a turn in `off` ends the watch, a pin in between does not, and an escalation the credits cap held counts). Each of these lines appears only when it has data. The active classifier's p95 wait across sessions shows on its **Deadline** line instead (not recorded with activity routing `off`). This agreement compares the classifier's raw answer, so it can differ from the session's. The pane reads these counts when the session starts and when it opens, and adds this session's turns as they finish; another session's new latency and escalation readings show the next time the pane opens. **Delete history** on the Usage tab deletes these counts with the usage and subagent records, for this session and across sessions.

`/router` without a UI surface adds an `Activity: ops (81%)` line, the resolved route, and `Agreement across sessions: 19 of 22 turns (86%) · code/ops/explore 9 of 10 (90%)`. It also prints the session in the band's words, such as `Session: $6.40 billed · −$1.84 (−22%) vs no routing · 64 replies`, after a `Plan: 5h 48% · 7d 43%` line on a Claude plan.

## Change routing

| Command or action                        | Result                                                                                                    |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `/router`                                | Open the pane.                                                                                            |
| `/router auto`                           | Resume automatic routing.                                                                                 |
| `/router off`                            | Turn routing off and keep Claude's selected model.                                                        |
| `/router pin <micro\|low\|medium\|high>` | Pin the next turn and its tool continuations. Routing on must already be enabled.                         |
| `/router activities <off\|on>`           | Set the [activity routing](#route-by-activity) mode. Saved to `router.json` at once; **Undo** reverts it. |
| `/router mode <cost\|balanced\|quality>`  | Set this session's [routing mode](routing-modes.md) from the next turn. A resume keeps it.               |
| `/router mode default`                   | Clear the session's mode: the project's or the profile's applies again.                                  |
| `/router decisions [n]`                  | Print this session's last `n` routing decisions, 20 by default. See [Routing decisions](#routing-decisions). |
| `/model <name>`                          | Select a model and turn routing off. Use `/router auto` to turn it back on.                               |
| **Turn on** / **Turn off** on the band   | The same as `/router auto` and `/router off`.                                                             |
| **on** / **off** on the pane (`o` / `f`) | The same as `/router auto` and `/router off`.                                                             |
| **pin** on the Now tab                   | Pin that tier for the next turn. Routing on must already be enabled.                                      |

A routing mode moves each tier's route one step toward cost or quality; pins and `micro` turns are not moved. The band and the Now tab show the mode and where it comes from, such as `cost (session)`. When the mode kept the cell's model and changed only its effort, as `cost` does for Opus at `high`, the band adds `effort only`: the cost estimates price the same tokens on both routes, so that change shows no difference there, though real output length can differ. A change applies from the next turn, and the route in use moves only through the usual checks, so on a running task a cheaper route can wait a few requests and for a checkpoint. **Mode** on the Policy tab sets the profile's mode. See [Routing modes](routing-modes.md).

### Routing decisions

Each routed turn adds rows to the session's decision record in `$.store` (`decisions:v1:<session id>`): one when the turn starts, one per classifier review or tool-based move inside it, and one when it ends. A row holds the prompt's origin (`composer`, `task-notification`, …, or `unknown`), the classifier's tier and activity with their shares, whether it counted as the running task, the tier, activity, route and reason chosen, and at the end the turn's tool bucket and how many replies were priced. It holds no prompt, tool or file text. `/router decisions [n]` prints them. Each session keeps its newest 60 rows; records of the 20 most recent other sessions stay, for at most 30 days. **Delete history** deletes them all.

A pin does not change the next turn after the pinned turn finishes. A fresh session on a model that a tier routes to, or with activity routing `on` a model an activity override uses (Sonnet 5.5 on the defaults), starts with routing on. A fresh session on any other model starts with routing off. `/clear` starts the new session with routing on. Resuming a saved session restores its saved routing on or off.

## Edit routes and policy

![The Routes tab: the activity routing mode, then one grid of tiers by activities with the tiers' own models on top, built-in overrides marked °, unsaved edits ●; the editor of the selected cell, code at high, with Use tier model; the prompt caches in use; and the unsaved router.json changes with Save and Discard](router-pane-routes.svg)

The **Routes** tab is one grid. Columns are tiers, from `micro` to `high`. The **every turn** row holds each tier's own model and effort. Each activity below it is a row: a cell shows the model the activity runs at that tier, or `·` when it runs the tier's model. Cells read as `models key·effort`, such as `sonnet·high`; a narrow pane shortens the effort (`opus·xh`). `°` marks a built-in default override and **●** an unsaved edit. In the picture, `medium` was changed to Sonnet 5.5 at `xhigh` and `coding` at `high` to Opus 5.5 at `max`.

Select a cell, with the pointer or Tab and Enter, to edit it under the grid:

- **A tier cell** (every turn) has a model and an effort, with the model's list prices and window.
- **An activity cell** has a model and an effort, and says what the cell is: `built-in default`, `your override`, `runs the tier’s model`, or `same as the tier’s model: no effect`. **Use tier model** drops the override, so the cell runs the tier's model; for a built-in default, Save writes the tier's route for that cell, because the built-in one would come back otherwise. **Restore default** puts a changed or dropped built-in override back. A yellow note flags a cell stronger than the tier above, and a cell that is the only one on its cache.

The model list comes from the aliases in `router.json` `models`, limited by the `availableModels` setting. `inherit` keeps the effort Claude Code sends. A model without effort levels, such as a custom one with `"efforts": []`, shows `none`.

**Activity routing** at the top sets `off` or `on`, and says what the mode does. A yellow line says when the overrides do not run: activity routing `off`, or routing off or unavailable.

The Routes tab describes the selected profile's cache policy. With Anthropic explicit caching, it counts the cache identities used by the routes. A model switch can require a cold write of the conversation.

Automatic-cache profiles, including DeepSeek and z.ai, do not assume a fixed lifetime or guaranteed sharing across efforts. They use hit/miss input prices without a separate write premium. See [cache settings](configuration.md#provider-cache-behavior).

A yellow line flags neighbouring tiers with the same model and effort. That step changes nothing.

**Reset routes to defaults** (`r`) loads the built-in tier routes and start tier into the draft; **Save** then removes your route overrides from `router.json`. Activity edits and the mode stay in the draft.

A new model ID needs an entry in `router.json` `models` with its price, context window, and effort levels. See [Configuration](configuration.md).

### Tune future decisions

![The Policy tab: each control inside its sentence, the start tier, going down, going up, the activity threshold and the credits cap, with the default beside a changed value, the router.json file and the subagent routing mode, and the unsaved change with Save and Discard](router-pane-policy.svg)

The **Policy** tab writes each control inside the sentence it completes, and names the default beside a value that differs from it. One **Save** writes them with any route changes:

- **Start** at a tier: the tier a session starts from when its model is no tier's model (`baselineTier`).
- **Going down** after 1, 2, or 3 agreeing turns in a row, and only if a cache write pays back within 1, 3, 5, or 10 later turns. A new or reset history needs one vote.
- **Going up** needs the classifier's support at 75%, raised up to 90% as the switch costs more. Read-only here; see [Configuration](configuration.md).
- **Activities** apply at 50%, 60%, 70%, or 80% certainty or more. Below it a new task runs its tier's model; the running task follows [Changes during a task](#changes-during-a-task). See [Activity routing](activity-routing.md#change-a-cell).
- **Credits** caps one cold cache write on a `credits` model at $0.50, $1, $2, or $5. With no `credits` model in `router.json`, the tab says the cap has no effect.

**Reset policy to defaults** loads the built-in values; **Save** then removes your policy overrides. The current turn keeps the settings it started with. A save preserves unrelated `router.json` keys and refuses to write through a symlink. When validation fails, the pane names the setting and leaves the file unchanged. The tab ends with the `router.json` path, a **copy** button, and the [subagent routing](configuration.md#subagent-routing) mode, which is set in `router.json`.

## Choose the classifier

Router asks one classifier per turn. Six are built in:

| Classifier | Service                        | Credentials                                    | Deadline |
| ---------- | ------------------------------ | ---------------------------------------------- | -------: |
| Jev        | typesafe.ai                    | Jev API key                                    | 1,500 ms |
| Clef       | Cloudflare Workers AI, 27B     | Cloudflare API token and Cloudflare account ID | 3,000 ms |
| Clef Flash | Cloudflare Workers AI, 9B      | Cloudflare API token and Cloudflare account ID | 3,000 ms |
| Clef Omni  | Cloudflare Workers AI, 30B MoE | Cloudflare API token and Cloudflare account ID | 3,000 ms |
| OpenAI     | OpenAI, `gpt-6-luna`           | OpenAI API key                                 | 3,000 ms |
| Ollama     | Local Ollama, `qwen3.5:9b`     | None                                           | 5,000 ms |

The three Clef models take the same request and the same Cloudflare credentials, so a switch between them changes only cost, speed and answers. Cloudflare bills input tokens only, per million: Clef Flash $0.038, Clef Omni $0.15, Clef $0.24 (list prices on 2026-10-13). A routing request is a few thousand tokens. In Cloudflare's own benchmarks no one model wins every task: Clef Omni leads on intent classification (BANKING77, CLINC150 with out-of-scope prompts), Clef on most of TypeSafe's workflow evals, and Clef Flash on tool-call tasks. Router has not measured Clef Omni on its own prompts yet. Clef Omni also reads images, audio and video; Router sends it text only.

![The Classifier tab: one row per classifier with where the prompt goes, its activity probe, its p95 wait and its status, a missing Jev API key with Set up; the active classifier's deadline against its wait, the host that receives the prompt, health and credentials; the agreement with tools across sessions; and Undo after a switch](router-pane-classifier.svg)

You can save credentials for all of them; only the active one is asked. The **Classifier** tab has one row per classifier, as columns to compare: `◉` marks the active one; then where the prompt goes (`this machine` for Ollama); its last checked-in [activity probe](evaluation.md#activity-probe-set), the test prompts with a known activity it answered right, such as `70/70`, and their p95 wait; and whether its credentials are complete. A row that lacks one names it, such as `○ no API token`, and has its own **Set up** button. The probe columns read `—` when you configured a model other than the probed one.

Select a row to switch. The choice is written to `router.json` at once and applies from the next turn. **Undo** in the status bar returns to the previous classifier. A turn that is already being classified finishes with the classifier it started with. The new classifier starts with a clean failure count.

Under the rows, a block for the active classifier:

- **Deadline:** 500, 1,000, 1,500, 3,000, or 5,000 ms for the active classifier's total advice attempt, including any retry. Each classifier keeps its own deadline, saved at once, with **Undo**. Beside it is the classifier's p95 wait: across sessions, such as `p95 ≤ 400 ms over 15 turns`, or from its probe before any turn. It turns yellow when the wait is slower than the deadline. Past the deadline the turn keeps its model.
- **Sends** names the service that receives prompt text. **Health** shows a pause, recent failures, and the last wait.
- **Credentials**: **Edit** opens Claude Code's secure plugin configuration, where you enter them.

With activity routing `on`, the activity question goes in the same request as the tier question (Ollama makes a second call), with the same text and nothing more. **Sends** names the service that receives the prompt and recent dialogue. With Clef, Clef Flash or Clef Omni that is Cloudflare, not typesafe.ai; with OpenAI it is OpenAI; with Ollama it stays on this machine. Give the Cloudflare token Workers AI permissions only.

The routing policy thresholds were tuned against Jev's probabilities. Clef's, OpenAI's, and Ollama's probabilities have not been compared with Jev's, so the same prompt can switch tiers at a different point. Watch **Classifier support** for a few sessions before you rely on a new classifier.

### Use Ollama

This section configures Ollama as the **classifier**, not the model that answers your prompts. To route coding models on Ollama, use a [custom execution-provider profile](providers.md#add-another-provider).

Ollama runs the classifier on this machine, so classification text stays local. It needs no key.

1. Install Ollama and pull a model: `ollama pull qwen3.5:9b`.
2. Start the server: `ollama serve`. The router calls `http://127.0.0.1:11434`.
3. On the pane's **Classifier** tab, select the **Ollama** row, or set `"classifier": "ollama"` in `router.json`.

The model is the `model` field of `classifiers.ollama` in [Configuration](configuration.md#ollama). To use another tag, pull it and set `"classifiers": { "ollama": { "model": "<tag>" } }`.

## Move from v0.8 gateway setup

The v1 plugin has the same plugin ID, `router@alexei-led-claude-router`, but it does not start the v0.8 local gateway. With auto-update on, Claude Code installs v1 at the next start. Before the first v1 session:

1. Update the plugin: `claude plugin marketplace update alexei-led-claude-router`, then `claude plugin update router@alexei-led-claude-router`.
2. Remove the settings that v0.8 `/router:setup` wrote. The [migration checklist](configuration.md#convert-a-v08-configuration) lists them: the `jev-router[1m]` model and picker row, the loopback `ANTHROPIC_BASE_URL`, the hint header, and the router status line.
3. Convert `router.json` if you created one.
4. Restart Claude Code with a full baseline model, such as `claude-haiku-5-5`.

Keep the plugin enabled: in v1 it is the Mod. The Jev key option keeps its saved value. If the band reads `v0.8 gateway settings remain`, step 2 is incomplete.

## Update or stop

Claude Code updates a marketplace install at startup when auto-update is on for the marketplace. To update now, run `claude plugin marketplace update alexei-led-claude-router`, then `claude plugin update router@alexei-led-claude-router`, and restart. For a local checkout, update the files and restart Claude Code with the same `--plugin-dir`.

To stop routing for a session, run `/router off`. To keep tier routing but stop the activity overrides, run `/router activities off`. To stop loading the Mod, run `claude plugin disable router@alexei-led-claude-router`, or restart without `--plugin-dir` for a checkout. The Mod keeps no session ledger and starts no process.

## Troubleshooting

| Symptom                                     | Cause                                                                                                 | Fix                                                                                                                                                                          |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Status says `no API key` or `no API token`  | The active classifier's plugin option is unset or unavailable to this process.                        | Select **Set up** in the pane, or run `/plugin configure router`. Save the option and start a new turn.                                                                      |
| Status says `no account ID`                 | Clef, Clef Flash or Clef Omni is active without the Cloudflare account ID.                            | Run `/plugin configure router` and save the Cloudflare account ID.                                                                                                           |
| Route stays on the current model            | The classifier timed out, failed, is paused, or network policy refused it.                            | Read the status band and the pane header. Network policy refusal is not bypassed.                                                                                            |
| `/model` changed but routing stopped        | Choosing a model turns routing off.                                                                   | Run `/router auto` to turn routing back on.                                                                                                                                  |
| Selected provider file is missing | The provider name selects a file that does not exist. | Create that file in the active Claude Code profile directory. Use `{}` only for built-in profiles. See [Providers](providers.md). |
| A custom profile containing `{}` fails | No built-in model catalog exists for that provider name. | Define all four routes and their model entries. See the [custom profile example](providers.md#add-another-provider). |
| Router reports invalid configuration | The selected file is invalid, or project/local settings redirect the profile. | Inspect the file shown in the pane. Remove project/local `HOME`, `CLAUDE_CONFIG_DIR`, or `CLAUDE_ROUTER_PROVIDER` overrides. |
| Router says old settings need migration     | `router.json` still contains v0.8 gateway keys or the 1.1 `jev` section.                              | Run the [migration command](configuration.md#convert-an-older-routerjson).                                                                                                   |
| `⚠ OpenAI rejected the key` | The OpenAI key is wrong, revoked, or lacks access to `gpt-6-luna`.                                    | Run `/plugin configure router` and save a valid OpenAI API key.                                                                                                              |
| `⚠ Ollama unreachable`      | No Ollama server listens on `127.0.0.1:11434`.                                                        | Run `ollama serve`, then start a new turn.                                                                                                                                   |
| `⚠ Ollama timed out`        | The model is loading after an idle period, or the machine is slow.                                    | Wait for one more turn. If it recurs, raise `classifiers.ollama.timeoutMs` in `router.json`.                                                                                 |
| `⚠ Ollama request failed`   | The tag in `model` is not pulled, or Ollama rejected a request setting.                               | Run `ollama pull <model>` for the tag in `model`, or choose another model.                                                                                                   |
| Band reads `v0.8 gateway settings remain`   | The `jev-router[1m]` model or the `127.0.0.1:43170` base URL is still set.                            | Run `/router`: it lists the keys. Remove them as in the [migration checklist](configuration.md#convert-a-v08-configuration) and restart.                                     |
| Router controls are unavailable             | Claude Code is older than 2.1.289.                                                                    | Update Claude Code.                                                                                                                                                          |
| Pane reads `ROUTER  unavailable`            | Old gateway settings, an old Claude Code, or an invalid `router.json`. The line under it names which. | Fix the cause it names and restart. Until then every turn keeps Claude's model, and `/router auto`, `off`, `pin`, and `activities` reply with the reason and change nothing. |
| Context reads as unknown                    | The router lacks a reliable local estimate or current-history measurement.                            | Keep using the current model, or start a new history with a supported context estimate.                                                                                      |

For the internal event flow and network deadline behavior, see [Architecture](architecture.md). For what the test traces do and do not show, see [Evaluation](evaluation.md).
