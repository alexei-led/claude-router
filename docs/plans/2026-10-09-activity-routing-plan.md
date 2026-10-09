# Activity routing

Version 0.3 · 2026-10-10 · Approved for implementation. Target: 1.6.0 ships phases 0–2, `shadow` by default, `on`
opt-in. Phase 3 (`on` by default) waits for shadow data.

The router picks a tier for each logical turn: how hard the work is. This plan adds a second label, the **activity**:
what kind of work the turn does. A route is then chosen by tier *and* activity, so a `low` coding turn can run on
Sonnet while a `low` git turn runs on Haiku.

## 0. Changes since v0.2

v0.3 checks v0.2 against the 1.5.1 code and fixes the release shape.

| Area | v0.2 | v0.3 | Why |
| --- | --- | --- | --- |
| Base routes | §3.1 drew `low` as Sonnet · medium | Base routes stay as in 1.5: `low` is Haiku · high (since 1.4.0). The proposed matrix ships as default **activity overrides** on top of them (§3.1) | With activity `null` (off, uncertain, failed) routing must equal 1.5, as §4.3 already requires. Changing the base would change routing for every user in `off` and `shadow` |
| Releases | 1.6 shadow, 1.7 on, 1.8 default on | 1.6.0 ships phases 0–2: `shadow` default with the proposed overrides, so shadow measures exactly what `on` would do; `on` is opt-in | One minor release; Phase 3 still needs the §11 exit data |
| Phase 0 scope | config, cost, policy, route | adds `cashGate`/`gatedResult` and the plan-billing fallback in `policy.mjs`, the `comparison` block in `chooseRoute`, `display.mjs` (`tierForModel`, `routeModel`), and the loop shape: `lastRoute` keeps the tier, `lastActivity` is added in Phase 1 | These sites were still tier-keyed |
| Fresh history | inside Phase 0 | its own PR after Phase 0 | It changes tier behaviour; Phase 0 must be a provable no-op |
| Classifier criteria | — | the classifier keeps seeing the **base** route per tier (`classifier-apis.mjs` sends `route` in the criteria) | The tier question is about difficulty; overrides are the router's business |
| Rollback | `activities`, `activityRouting` | also `policy.activityMass`: 1.5 closes the `policy` keys too | Verified in `checkShape` |

## 0.1 Changes since v0.1

v0.1 was the chat draft (`kinds`, six types, one switching rule). This version reviews it against the code.

| Area | v0.1 | v0.2 | Why |
| --- | --- | --- | --- |
| Name | `kind`, then `activity` | `activity`, key `activities`, mode `activityRouting` | No clash with `type`, Task tools or typed questions |
| Labels | six, `write` | seven: `code debug explore plan review ops docs`, plus `uncertain` | Review is common and has a clear signal; `docs` is clearer than `write` |
| Override fields | whole route per cell | each field inherits: an override may set only `model` or only `effort` | Smaller files; `"code": { "high": { "effort": "max" } }` works |
| Cost model | "replace `routeModel` with `resolveRoute`" | Phase 0 refactor: costs and policy take **routes**, not tiers; the incumbent is priced at the route it actually runs | With activities, the same tier maps to different models; tier-keyed pricing misprices the incumbent |
| Continuation | keeps tier and activity | keeps tier; activity may still move **up** (explore → code), never down | explore → code inside one task is the most valuable switch |
| Switch rule | one tax gate for all | asymmetric: toward a stronger route on quality evidence, toward a cheaper one only when the cache write pays back | Same principle as tiers: up fast, down slow |
| Uncertain activity | keep incumbent | new task → the tier's base route; continuation → keep | A sticky cheap override must not carry over into an unknown task |
| Session start | not covered | fresh-history rule: no votes needed while no cache exists | There is nothing to protect yet; today turn 1 usually stays on the start model |
| Ollama | "second call or skip" | second call in the same deadline, route first; activity is optional everywhere | One failure mode: activity missing means today's behaviour |
| Evaluation | hand-label 50–100 turns | label each finished turn from its tool calls, locally, for free; plus a synthetic probe set per classifier | Continuous agreement metric, no manual work, no prompt text stored |
| UI | one band example | band, toast, Now, Routing (matrix preview + override list), Usage (activity stats) | Configuration and stats must be readable without the docs |
| Defaults | ops/explore → Haiku | evidence per cell; reuse (model, effort) pairs: 5 distinct caches, as many as today plus one | Every distinct pair is its own cache |
| Cut | — | custom activities, per-step routing, a `research` label, slash-command rules (deferred) | No evidence they pay for their complexity |
| Added | — | Phase 0 regression invariant, contract tests for partial answers, live ping-pong compatibility check, rollback note | Reliability |

## 1. Goal and non-goals

Goal: use the cheaper model where it is good enough and the stronger one where it matters, along a dimension the
tier ladder cannot express. Anthropic's charts show the gap between models depends on the work: Haiku 5.5 scores 39.2%
on Terminal-Bench 4.0 against Sonnet 5.5's 70.6%, but stays close on knowledge work (GDPval-AA 1620 vs 1844) and
computer use (OSWorld 72.4% vs ~80%). Sonnet 5.5 matches Opus 5.5 on knowledge work (1844 vs 1846).

Non-goals:

- Routing individual tool steps. A turn keeps one route. Switching mid-turn loses thinking blocks, which are bound
  to the model, and pays a cache write per hop.
- User-defined activities. The classifier question is designed and probed for a closed set.
- Subagents. They keep passing through unchanged.
- No new data leaves the machine. The classifier receives the same prompt and dialogue as today.

## 2. Model

### 2.1 Activities

The rule the classifier applies: **an activity is named by what the turn produces.**

| Activity | Produces | Includes | Not this | Typical tiers |
| --- | --- | --- | --- | --- |
| `code` | Changed code or config | Features, fixes with a known cause, refactors, migrations, dependency bumps, **writing tests**, IaC files | Cause unknown → `debug`; only running things → `ops` | low–high |
| `debug` | A found cause | Failing or flaky tests, stack traces, logs, perf investigation, "why does X…" | Cause given in the request → `code` | low–high |
| `explore` | An answer | Explain code, find where X happens, read docs, research libraries or APIs, data questions | The answer is a design decision → `plan` | micro–medium |
| `plan` | A decision or plan | Architecture, design, spec, task breakdown, trade-offs, estimates | Judging existing code → `review` | medium–high |
| `review` | Findings about existing code | PR or diff review, security review, audit | Fixing the findings → `code` | low–high |
| `ops` | Executed commands | git, PRs, build, running tests or linters, CI, deploy, scripts, environment setup | Writing new code or config → `code`; unexplained failure → `debug` | micro–low |
| `docs` | Prose for people | README, docs, comments, commit messages, PR descriptions, changelogs | Explaining in chat → `explore` | micro–medium |
| `uncertain` | — | Unclear request, not a task, or several activities with no clear lead | — | — |

Mixed turns ("fix it and commit") take **the activity of the hardest part**, here `code`. Short replies ("yes, go
ahead") take the activity of what the last assistant message proposed.

### 2.2 Route resolution

```
route(tier, activity) = { ...routes[tier], ...activities[activity]?.[tier] }
```

An override is sparse: a missing activity, a missing tier, or a missing field inherits from the tier's route. With no
overrides, every route is today's. `activity = null` (off, uncertain) resolves to the tier's route; a failed activity step keeps A0 (§5.2).

The **route**, the (model, effort) pair, is what Claude Code receives and what owns a cache. Labels never decide on
their own: if a new activity resolves to the route already running, nothing switches.

## 3. Configuration

```json
{
  "activityRouting": "on",
  "activities": {
    "code":   { "high": { "effort": "max" } },
    "review": { "low": { "model": "opus", "effort": "medium" } }
  }
}
```

A user file is merged over the built-in overrides (§3.1) per field, as `routes` is. To drop a built-in override, set
it to the tier's base route; the pane writes that for you.

- `activityRouting`: `off` asks nothing new and routes exactly as 1.5. `shadow` asks, shows, and records, and does
  not change routes. `on` applies the overrides. Also: `/router activities on|shadow|off`.
- `activities`: closed keys (the seven activities) → tier keys → `{ model?, effort? }`. `effort: null` keeps the
  session effort, as in `routes`.
- Validation follows the existing loader: unknown activity or tier, unknown model alias, invalid effort, and forbidden
  keys fail with the path. An override equal to its tier's route is reported in the pane as having no effect.
- Pane writes remove values equal to the built-in defaults, as `withRoutes` does today.
- Rollback: 1.5 rejects unknown top-level keys and unknown `policy` keys. Remove `activities`, `activityRouting` and
  `policy.activityMass` before downgrading. The CHANGELOG says so.

### 3.1 Defaults

1.6.0 ships `activityRouting: "shadow"` with the overrides below. In `shadow` they only feed the "would route" readout
and stats, so shadow data measures exactly what `on` would do. Routes change only after a user opts in to `on`.

The base routes stay as in 1.5. Cells marked `·` inherit them; activity `null` always uses them.

| | micro | low | medium | high | Evidence |
| --- | --- | --- | --- | --- | --- |
| base (1.5) | Haiku · medium | Haiku · high | Opus · medium | Opus · xhigh | Unchanged |
| `code` `debug` `plan` `review` | · | **Sonnet · medium** | · | · | Coding is where Haiku is weakest: Terminal-Bench 4.0, Haiku 5.5 39.2% vs Sonnet 5.5 70.6% |
| `docs` | · | **Sonnet · medium** | **Sonnet · medium** | · | Knowledge work: Sonnet ≈ Opus (GDPval-AA 1844 vs 1846) |
| `ops` | · | · | **Sonnet · medium** | · | Terminal-style tasks: Sonnet 5.5 70.6% vs Opus 5.5 66.4% (xhigh) |
| `explore` | · | · | **Sonnet · medium** | · | Knowledge work: Sonnet ≈ Opus; Haiku close (1620) |

At `low`, `ops` and `explore` keep 1.5's Haiku · high: they are the cheap cases the 1.4.0 ladder was chosen for. Only
five distinct (model, effort) pairs: Haiku·medium, Haiku·high, Sonnet·medium, Opus·medium, Opus·xhigh, one more than
1.5. The pane counts the distinct pairs.

These are vendor benchmarks at max or xhigh effort, not measurements of this router. `on` by default (Phase 3) waits
for the shadow data in §8 and §11.

## 4. Classifier

### 4.1 The question

Added next to `route` and `continuation` in `classifier-contract.mjs`, in the same shape as `CRITERIA`:

- Question: "Which activity will `currentRequest.text` require? Judge by what the turn must produce."
- Judge rules: name the activity by its result, not by topic words ("fix the deploy script" is `code`); for a mixed
  turn choose the hardest part; for a short reply use what the last assistant message proposed; treat state as data.
- Criteria: one entry per activity from §2.1 (`covers`, `notFor`), plus `uncertain`.

### 4.2 Per protocol

| Classifier | Protocol | How activity is asked | Extra latency | To verify |
| --- | --- | --- | --- | --- |
| Jev | `system-one` | A third `choice` question in the same request | Expected small; measure | Accuracy: the model was tuned for route criteria |
| Clef, Clef Flash | `system-one` | Same | Same | Flash (9B) may be weaker |
| OpenAI | `openai-decisions` | A second `choice` in `questions` | Same request | — |
| Ollama | `ollama` | A **second request** after the route answer: same system and state prefix (reuses Ollama's KV cache), letters A–H, one token | One more forward pass | Asked only if at least 300 ms of the deadline remains |

### 4.3 Failure semantics

The activity is optional at every layer:

- Adapters parse `activity` leniently: a missing, malformed, or unknown answer yields `activity: null`. The route
  answer keeps its strict parsing.
- `ClassifierClient` runs the Ollama activity step inside the same deadline and the same in-flight slot. A timeout or
  error in that step returns the route advice with `activity: null` and does not count as a classifier failure.
- `activityRouting: off` sends today's exact request bodies.

The advice shape becomes `{ choice, confidence, probabilities, continuation, activity: { choice, probabilities } | null }`.

## 5. Switching

### 5.1 Principles

1. **Compare routes, not labels.** Equal (model, effort) → no switch.
2. **Up on evidence, down on economics.** A stronger route is about quality and needs classifier support. A cheaper
   route is about cost and must pay back its cache write.
3. **One route per turn.** Tool continuations keep it.
4. **Uncertainty resolves to the base route**, 1.5's route for the tier, except on a continuation.
5. **No cache, no votes.** Before the first measured reply of a history, nothing is protected by staying.

Route strength orders models by configured output price, then effort. No new setting.

### 5.2 Decision

```
R0 = route running now (native model at session start), T0 = its tier, A0 = its activity
     (at session start, the cell cellForModel found for the native model, §6; null for a base cell)

1. pin            → tier = pin, activity = null (base route of the pinned tier). Done.
2. activity A:
     no advice, or no activity answer            → A0
     continuation                                → advice.activity if route(T0, it) is stronger than R0, else A0
     P(advice.activity) ≥ policy.activityMass   → advice.activity
     otherwise (uncertain, low mass)             → null
3. tier T = decide(...) as today, but every candidate tier is priced at route(t, A) and the incumbent at R0.
4. R1 = route(T, A)
     R1 == R0                → stay, reason from step 3
     T ≠ T0                  → switch; the tier gates already priced R1
     T == T0, R1 stronger    → switch if P(A) ≥ the upgrade bar for this tax (same formula as tiers)   'activity-up'
     T == T0, R1 cheaper     → switch if the downgrade economics pay back within the horizon         'activity-down'
     otherwise               → stay on R0, keep A0                                                     'activity-pending'
   With A = null (a new task with no usable activity), P(A) counts as 1: returning to the base route needs no
   evidence, only the cash gate and, when cheaper, the economics.
5. Every lateral switch (T == T0) passes the cash gate for R1, as tier switches do; blocked → stay, 'cash-gate'.
6. While an escalation hold lasts (step 3 returned 'hold'), only a stronger R1 may be taken; a cheaper one stays,
   'hold'. A hold protects the stronger route it bought.
```

Modes: `off` never asks, so A is always null and step 4 reduces to today's decision. `shadow` runs the decision with
A = null for the route it applies, and runs it again with the advice's activity for the "would route" readout and
stats only. `on` applies the decision with A.

Lateral moves need **one vote**, not a streak: an activity is a fact about this turn, not a noisy complexity estimate,
and a single `ops` turn would never get a second one. The economics already cover what votes protect against.

Other rules:

- **Escalation** after repeated tool errors keeps the activity. With A = null it is today's rule, one tier up, so
  `off` and the applied `shadow` decision stay equal to 1.5. With an activity it moves to the lowest tier above T0
  whose route(t, A) is stronger than R0; when no tier above gives a stronger route, there is no escalation and the
  failure signature is not consumed. With the defaults, `low` and `medium` docs are both Sonnet, so docs escalates to
  `high`.
- **Context fit** resolves windows through `route(t, A)`.
- **Model unavailable** falls back through the same chain as today, with resolved routes.
- **Fresh history** (session start, `/clear`, committed compaction, rewind): tier and activity moves skip the vote
  streak until the first measured reply. This also fixes today's turn-1 behaviour.

### 5.3 Why moves to Haiku are cheap and moves up cost

Configured list prices, a 150K-token context (Haiku's above-100K rates), 2K output and 5K new tokens per request:

| | Haiku 5.5 | Sonnet 5.5 | Opus 5.5 |
| --- | ---: | ---: | ---: |
| Cold cache write, 5 min | $0.09 | $0.38 | $0.75 |
| One warm request | ≈ $0.016 | ≈ $0.063 | ≈ $0.095 |

- Sonnet → Haiku for an `ops` turn: $0.09 write, $0.047 saved per request. It pays back on the second request.
  Returning to Sonnet within the 5-minute TTL writes only the new tail.
- Opus and Sonnet both read cache at $0.20/M. In long sessions, Sonnet's saving over Opus comes mostly from output
  and new tokens, not from reads.
- Moving up to a cold Sonnet or Opus costs $0.38–0.75. That is why moves up are justified on quality, not on cost.

The policy computes this per turn with `downgradeTaxUsd` and `switchingTaxUsd`. The table only shows the scale.

### 5.4 Parameters

| Key | Default | Meaning |
| --- | --- | --- |
| `policy.activityMass` | 0.6 | Minimum probability for an activity to apply |

Everything else reuses the tier policy: `upgradeBase`, `upgradeSlope`, `upgradePivotUsd`, `downgradeHorizonTurns`,
`continuationMass`. Not in the pane. Open question: the horizon counts requests, while activities run for a few turns
of several requests each. Calibrate from §8 stats before Phase 3.

## 6. Session start

- The incumbent route is the session's model. `tierForModel` becomes `cellForModel`: it searches the base routes
  (baseline first), then, only with `activityRouting: on`, the overrides, and returns `{ tier, activity }`.
- The start-mode rule is unchanged: routing starts on when some effective cell routes to the session model. In
  `off` and `shadow` only base routes count, as in 1.5.
- Any start model with a cell works: the fresh-history rule moves turn 1 to the right route without votes. With
  `on` and the default overrides, Sonnet 5.5 is the most common destination, so `claude --model claude-sonnet-5-5`
  avoids the first switch.
- `baselineTier` keeps its meaning: start here, fall back here. Its route is resolved with `activity = null`.

## 7. UI

### 7.1 Band

```
▂▄▆█ ▌low▐ code → Sonnet 5.5 · medium  ·  ↗ code  ·  Jev 82%  ·  ctx 34% · cache 91%
▂▄▆█ ▌low▐ ops → Haiku 5.5 · high      ·  ↘ ops   ·  …
▂▄▆█ ▌low▐ code (shadow) → Haiku 5.5 · high  ·  = fits
```

- The activity sits between the tier pill and the model, in neutral ink: tier colours stay the tier's.
- In `shadow` the label is dim and carries `(shadow)`. The route shown is the one actually used.
- Narrow terminals drop the activity before the reason, and never drop the tier or model. It stays segment 0 text,
  cut last.
- New short reasons: `↗ code` (activity-up), `↘ ops` (activity-down), `… ops: not worth a switch` (activity-pending).

### 7.2 Toast

`Model changed: Sonnet 5.5 · medium → Haiku 5.5 · high · ops`. As today: none for pins or effort-only changes.

### 7.3 Now tab

```
Now        ▌low  Sonnet 5.5 · medium
Activity   code 81%   ops 9% · explore 6%
Why        code at low runs on Sonnet 5.5
Route      low + code → Sonnet 5.5 · medium   (override)        base: Haiku 5.5 · high
```

The tier ladder and its support bars stay. In `shadow`, the Route line reads
`low + code would use Sonnet 5.5 · medium (shadow; using Haiku 5.5 · high)`. A cell without an override reads
`low + ops → Haiku 5.5 · high (base)`.

### 7.4 Routing tab

Keep the ROUTES table. Add two sections under it.

**ACTIVITIES**: a read-only matrix of the effective routes, `·` where a cell inherits:

```
ACTIVITIES · routing on                  micro    low      medium   high
  base                                   H·med    H·high   O·med    O·xh
  code debug plan review                 ·        S·med    ·        ·
  docs                                   ·        S·med    S·med    ·
  ops explore                            ·        ·        S·med    ·
  5 distinct routes = 5 caches
```

**OVERRIDES**: one row per override with model and effort Selects and a remove button, plus one add row (activity,
tier, model, effort). The mode Select (`off · shadow · on`) sits at the top of the section.

All of it joins the existing routing draft: **Save**, **Discard**, the `router.json` diff in the status bar, and
**Undo**. Warnings, in yellow:

- "same as base: no effect"
- "stronger than the tier above". An override at `low` that beats `medium` usually means a wrong tier.
- "new (model, effort) pair: one more cache"

### 7.5 Usage tab and replies

```
ACTIVITY · this session        turns  requests  share   mostly on
  code     ████████░░             12        71    48%   Sonnet 5.5 · medium
  explore  ███░░░░░░░              5        22    20%   Haiku 5.5 · high
  ops      ██░░░░░░░░              4         9    16%   Haiku 5.5 · high
  …
Switches   9 · 4 by tier · 5 by activity · est. writes $0.21
Agreement  classifier vs tools: 19 of 22 turns (86%)
Shadow     would route 5 turns differently · est. −$0.30 … −$0.12 at list prices
```

- REPLIES on the Now tab gets a second row: one letter per reply under its tier block
  (`c c e e o c d`), with a legend.
- The estimates follow the repo's existing wording: configured list prices, not measured savings.
- `/router` without a UI surface adds `Activity: ops (81%)` and the resolved route line.

## 8. Statistics and evaluation

### 8.1 Observed activity, from tools

At `turn.complete`, a pure function in `facts.mjs` labels the finished turn from its `tool_use` blocks:

| Observed bucket | Rule, first match |
| --- | --- |
| `code` | An edit tool on a non-doc path |
| `docs` | Edits only to `*.md`, `*.mdx`, `*.rst`, `*.txt`, `docs/**` |
| `ops` | Bash and no edits: git, gh, build, test runners, docker, kubectl, terraform, deploy scripts |
| `read` | Only Read, Grep, Glob, WebFetch, WebSearch |
| `talk` | No tools |

Predicted activities map to the buckets they allow:

- `code` → {code}
- `debug` → {code, ops, read}
- `explore` → {read, talk}
- `plan` → {talk, read, docs}
- `review` → {read, talk}
- `ops` → {ops}
- `docs` → {docs}

Agreement means the observed bucket is in the allowed set. It is a weak oracle: it tells `ops` from `code` from
`explore` well and cannot separate `plan` from `review`. That is enough to catch the costly mistake, a cheap route on
a coding turn. No text is stored, only the bucket.

### 8.2 Where stats live

- **Session**: in the view, alongside `tiers`: an `activities` array aligned with the last 30 replies, and
  per-activity counters for turns, requests, tokens and estimated cost. Reset at session start.
- **Across sessions**: one `$.store` key, `activity:stats:v1`, holding counts only:
  - a predicted × observed confusion matrix;
  - run lengths per activity;
  - lateral switches taken and refused;
  - shadow would-route counts.

  It is bounded in size and has a **Reset** button in the Usage tab.

### 8.3 Probe set

`test/fixtures/activity-probe.json` holds about 70 synthetic prompts, ten per activity, weighted to the boundary
cases:

- "fix the deploy script" vs "deploy the fix";
- "why does the test fail" vs "make the test pass";
- "yes, do it" with dialogue;
- review-then-fix.

`scripts/probe-activity.mjs`, like `probe-classifier.mjs`, sends them to one classifier and writes accuracy, a
confusion matrix, and p50/p95 latency to `experiments/mod-router/results/activity-probe-<classifier>.json`. It needs
the keys and is run by hand, not in CI. The Classifier tab shows the last probe result per classifier when one is
checked in.

## 9. Implementation

### Phase 0: routes, not tiers (no behaviour change)

| File | Change |
| --- | --- |
| `lib/config.mjs` | `resolveRoute(config, tier, activity)` and `routeSpec(config, route)` replace `routeModel`, which is removed |
| `lib/cost.mjs` | `routeEffort`, `routeCacheKey`, `inputBounds`, `switchingTaxUsd`, `shadowEconomics` and `downgradeTaxUsd` take a route `{ model, effort }` instead of a tier |
| `lib/policy.mjs` | `decide` and `fitTier` take `routeFor(tier)` and `incumbentRoute`; `cashGate`, `gatedResult` and the plan-billing fallback use routes |
| `lib/route.mjs` | `chooseRoute` (including the `comparison` block) and `continueRoute` pass resolved routes; `tierForModel` → `cellForModel` |
| `lib/display.mjs` | `cellForModel` and resolved routes instead of `tierForModel` and `routeModel` |

Invariant test: a golden decision snapshot, generated from 1.5.1 and committed before the refactor, over a scenario
matrix of `decide`, `chooseRoute` and `continueRoute`. Existing tests change only in call signatures.

### Fresh history (own PR, after Phase 0)

`decide` receives `historyMeasured` through the facts. Before the first measured reply, upgrades and downgrades need
one vote instead of a streak; mass thresholds, the cash gate, escalation and holds are unchanged. The golden snapshot
changes only in fresh-history scenarios.

### Phase 1: ask, show, record (`shadow` default)

| File | Change |
| --- | --- |
| `lib/activity.mjs` (new, pure) | `ACTIVITIES`, criteria, `acceptActivity`, the lateral rule, `observedActivity`, bucket map |
| `lib/classifier-contract.mjs` | Activity question and instructions |
| `lib/classifier-apis.mjs` | Third question in `system-one` and `openai-decisions`; Ollama `steps` |
| `lib/classifier-client.mjs` | Run adapter steps; partial advice when step 2 fails; failures count only for step 1 |
| `lib/config.mjs` | `activityRouting`, `activities`, `policy.activityMass`: shape, validation, `withActivities` for pane writes |
| `hooks/native-router.mjs` | Pass the activity through `decideTurn`; record stats at `turn.complete`; `/router activities` |
| `lib/view.mjs`, `lib/band.mjs`, `lib/panel.mjs`, `lib/display.mjs` | §7 |
| `types/index.d.ts` | `RouterActivity`, view fields, advice shape |

### Phase 2: switch (`on`)

The lateral rule in `chooseRoute`, the default overrides of §3.1, and docs: `configuration.md`, `user-guide.md`,
`architecture.md`, `native-router.md`, the README classifier table, the CHANGELOG, and regenerated SVGs
(`npm run docs:images`).

Phases 1 and 2 land as one PR: Phase 1 alone would ship a mode whose overrides do nothing. Inside that PR the work
splits after a contracts commit (types, `ACTIVITIES`, config schema): classifier stack, switching policy, observed
activity and stats, UI; then the hook wiring and docs.

## 10. Tests

| Level | What |
| --- | --- |
| Config | Valid and invalid `activities` (path in the message), field inheritance, `withActivities` strips defaults, `cellForModel` and the start mode with overrides |
| Contract | Per protocol: build includes the question only when the mode is not `off`; parse a valid activity → `activity` set; a missing, malformed or unknown one → route intact, `activity` null; fixtures next to the existing `*-response.json` |
| Client | Ollama: route OK and activity times out → partial advice, no failure counted; deadline floor skips step 2 |
| Policy | Table-driven (R0, tier advice, activity advice, cache state, context) → (route, reason): same route despite a label change; continuation up allowed, down refused; uncertain → base, up or down, with P = 1; tier and activity change together; escalation keeps the activity, skips tiers whose route is not stronger (docs: low → high) and keeps the signature when none is, and with A = null is one tier up as in 1.5; a session started on an override cell keeps it when the classifier fails; a lateral move to a credits model above the cash cap is blocked; a hold refuses a cheaper lateral move and allows a stronger one; pin ignores the activity; fresh history skips votes; a cheaper move refused at large context and taken at small |
| Invariants | `off` ≡ 1.5 decisions over all existing scenarios; `shadow` never changes a route; equal routes never switch |
| Observed | `observedActivity` buckets on synthetic histories: doc vs code paths, Bash ops vs tests, read-only, no tools |
| Hook | Activity reaches the view, toast and stats; stats survive reload; reset on a new session |
| UI | Band fitting at 60/80/120 columns with the activity segment; Routing tab matrix, warnings and diff; Usage tab in all three modes |
| Live (manual, billed) | A chain Sonnet → Haiku → Sonnet → Opus with a tool call each turn on Claude Code ≥ 2.1.289: no rejected request, thinking intact. Recorded like the existing `compat-acceptance` results |

`npm run check && npm run typecheck && npm test && npm run validate && npm run test:plugin` stays the gate.

## 11. Rollout

| Phase | Release | Default | Exit criteria |
| --- | --- | --- | --- |
| 0 | 1.6.0 | — | Golden snapshot green; no behaviour change apart from fresh history |
| 1–2 | 1.6.0 | `shadow`; `on` opt-in | Gate green; live sessions in `shadow` and `on` show the activity, the would-route readout and a lateral switch without a rejected request |
| 3 | later minor | `on` by default | Two weeks of shadow: tool agreement ≥ 80% on `code` vs `ops`/`explore`; would-route estimate negative; p95 Jev latency up by ≤ 150 ms; no rise in tool-error escalations after activity downgrades |

If shadow data shows Jev's latency or accuracy failing, a patch release sets `activityRouting` to `off` by default.

## 12. Risks and open questions

- **Classifier accuracy is unknown.** Jev was tuned for tier criteria. Mitigations: shadow first, the probe set, the
  tool agreement metric, and an accuracy readout per classifier.
- **More switches, more cache writes.** Mitigations: route equality, economics on cheaper moves, the continuation
  rule, and reused (model, effort) pairs.
- **Thinking blocks across switches.** Sonnet 5.5 and Opus 5.5 bind them to the model. A detour to Haiku and back
  must not lose or break them; the live chain in §10 checks this.
- **Probability calibration differs by classifier.** `activityMass` was not tuned on any of them. Calibrate from the
  probe per classifier, or keep one value if the probe shows it holds.
- **Horizon units.** See §5.4.
- **Slash commands and skills.** Does `turn.start` see `/commit` or the expanded prompt? If the raw command, a small
  built-in map (`/commit` → `ops`) could skip the classifier. Deferred until checked.
- **Rollback.** 1.5 rejects the new keys, including `policy.activityMass`; see §3.
