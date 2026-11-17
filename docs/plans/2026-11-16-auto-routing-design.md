# Automatic routing: one mode, no route table

Status: Accepted design (Claude and Pi, four review rounds). Ready for implementation planning by step.

## 1. Goal

The user sets one value: `cost`, `balanced` or `quality`. The router picks the model and effort for each main turn
from the models that are available, their prices and limits, and what it knows about the turn and the session. No
tier-by-activity route table and no per-mode step rules (`applyMode`).

Non-goals for v1:

- Subagent routing. It keeps its own rules.
- A new classifier output or a continuous optimizer.
- Learning from outcomes (per-effort token learning, capability tuning from live data).
- Per-activity capability bonuses on models.

## 2. What is wrong with plugging a scorer into `routeFor`

Draft 1 kept `policy.decide` as is and swapped `routeFor(tier)`. Review showed three defects:

- The tier `decide` returns is the **accepted routing state**, already shaped by cache tax, vote streaks and dwell
  (`lib/policy.mjs:60–104`). It is not the demand of the turn. Feeding it to a scorer mixes "what the turn needs" with
  "what we agreed to move to".
- Failure escalation searches only higher tiers (`lib/route.mjs:392`). At `high` a scorer could run Opus at `medium`
  while stronger candidates exist, and a repeated failure could not escalate.
- `cashGate` looks for a plan fallback only among the four tier winners (`lib/policy.mjs:135`). A plan model that
  is not a tier winner disappears from consideration.

So the design splits the turn into three steps with separate state.

## 3. The engine: demand → target → move

### 3.1 Demand (what the turn needs)

A discrete level `0..3` (micro, low, medium, high), kept per session:

- Source: the classifier's tier label with the existing vote and hold machinery (upgrade votes, downgrade votes and
  mass, jump confidence, escalation hold). These rules move **demand**, not the route.
- A new repeated-failure occurrence raises demand by one level and holds it. Occurrences are deduplicated by
  signature and transcript index, not by physical moves. At the top demand stays 3; escalation still searches for a
  strictly stronger eligible request. Exhausted escalation retains a headroom flag so that search can be retried.
- Activity: only an accepted bounded `execute`/ops phase lowers demand by one half-step. Nothing else in v1.
- No cache or price input here. Demand never depends on what is cheap right now.

### 3.2 Target (which candidate fits)

**Candidates:** every `(model, effort)` from `models.<alias>` that passes candidate-local hard constraints:

- available on the active provider profile and allowed;
- context fits the window with the existing margin;
- images supported when the turn has images;
- cold-write cash cap: a credits candidate whose cold write exceeds `cashCapUsd` is not eligible unless its cache is
  warm.

The result is one of four outcomes, in this order of precedence:

1. **Meets demand:** at least one candidate with a declared capability at or above the requirement. Pick by the rule
   below.
2. **Declared below demand:** no declared candidate meets it. Take the highest declared capability, cheapest on ties.
   A known-weaker candidate beats an unknown one.
3. **Unknown only:** no eligible candidate has a declared value. Take the cheapest unknown and say so.
4. **No eligible candidate.** Keep the incumbent only if it passes the same hard constraints. Otherwise return an
   explicit `no-route` outcome to the existing native fallback handling.

A fallback never brings back a filtered candidate.

**Capability:** declared, not computed. Each model lists a capability level per effort on the same `0..3` scale,
half-steps allowed:

```json
"sonnet": { "capability": { "low": 1, "medium": 2, "high": 2.5, "max": 3 } }
```

- Built-in values ship with the provider presets, sourced from model-cards and benchmark results, each with a note of
  the source.
- A model or effort with no declared value has **unknown** capability (outcome 3 below), never 0.
- No universal effort curve and no `strength + offset` arithmetic.
- Values are adequacy judgments with a source. Half-steps are allowed where evidence supports them. Presets must not
  invent half-steps only to make modes differ: when modes pick the same route, that is a correct result.

**Mode = margin on demand:**

| Mode       | Required capability  |
| ---------- | -------------------- |
| `cost`     | max(demand − 0.5, 0) |
| `balanced` | demand               |
| `quality`  | min(demand + 0.5, 3) |

The requirement is clamped to `0..3`, the range of declared levels. At `high`, `balanced` and `quality` both require 3
and `cost` requires 2.5. So `quality` at `high` takes the cheapest level-3 candidate and does not fall through to
unknowns. Escalation uses the stronger-only search below, even at maximum demand.

**Choice among qualifying candidates, one order for every mode:**

1. lowest **next-turn cost estimate**: input at the candidate's cache state (warm or cold write) plus output at the
   last reply's length, from the existing `nextTurnRange`/`switchEconomics` math. It is named as an estimate, not as
   expected turn cost;
2. on an equal estimate, the incumbent;
3. then lower declared capability (the least sufficient candidate);
4. then the order of `models` in config (deterministic).

The estimate is effort-blind: it freezes output at the last reply's length and does not model extra thinking tokens.
Least-sufficient selection avoids favoring higher effort with unseen thinking-token costs. The mode provides headroom
only through the requirement; it never overrides the incumbent preference.

**Escalation target.** A failure must not select a cheaper, weaker request merely because it meets the raised
requirement. After applying every candidate-local hard constraint, replace normal target selection with:

1. With a declared incumbent capability, consider only requests with a strictly greater declared capability.
   Among those meeting the raised mode-margin requirement, use the normal tie order. If none meet it, take the
   highest strictly stronger declared capability, cheapest on ties.
2. With an unknown incumbent capability, only a different physical request with declared capability at or above
   the raised requirement counts as stronger. Use the normal tie order among them.
3. If neither declared search succeeds, a different physical request with unknown capability is a last resort.
   Pick by the normal cost/tie order and report `escalation-unknown` (unknown capability, not proven stronger).
4. If nothing remains, keep the eligible incumbent, report `escalation-exhausted`, and retain headroom for a retry.
   A successful escalation selection clears that pending headroom. An invalid incumbent instead uses normal
   forced refit; if nothing is eligible the result remains explicit `no-route`.

Physical identity is the canonical model ID and actual effort, not the config alias. No escalation fallback can
restore a filtered candidate or nominate the same physical request as a supposedly stronger alternative.

### 3.3 Move (whether to switch now)

The target is a proposal. Whether the physical route changes this turn depends on **why** the target differs from
the incumbent. Each case has a defined evidence input. The threshold formulas are today's; only their inputs are
named here.

**Routed demand.** The session keeps the effective demand level accepted by the incumbent route, and the
cause of the last physical change (`classifier`, `escalation`, `startup`, `mode`, `catalog`, `forced`, `reentry`).
At session start, raw demand is the configured baseline, while routed demand is the actual incumbent's declared
capability at its supported/resolved native effort. Unknown or unsupported native capability conservatively uses
the baseline; no effort, mode offset or capability is invented. Runtime and replay share this initialization.
Routed demand is then set when a move executes and when the selected target is the same physical
request (`same-route`). Same-route acceptance adopts the current effective demand, including zero, without a
switch: `move: false`, hold, votes, failure markers and route cause remain unchanged. Pins, no-route,
exhausted escalation and blocked moves do not adopt demand. Classifier move cases below compare current demand
with **routed demand**, not with the previous turn's demand. So a blocked move stays pending without extra state.
For example, demand rises to 3 while routed demand is 2 and the switch-tax bar blocks the upgrade. On the next turns the case is still "demand rose",
and the mass is recomputed from the current advice against routed demand 2. The pending move ends when it executes,
when demand returns to routed demand, or when a forced or escalation move replaces it.

| Why the target differs                                                       | Evidence and gate                                                                                                                                                                                                                                                                                                                                             |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Incumbent origin is `external-fallback`, on the next main turn               | Re-entry to a different eligible target bypasses mass, dwell and payback. Hard constraints and cash cap still apply. An equal physical target accepts current effective demand and clears origin without a switch or cause change; no eligible target continues native fallback. Re-entry sets routed demand and cause `reentry`, preserving escalation hold. |
| Incumbent fails a hard constraint (context, images, availability)            | Forced move now. No confidence needed; dwell does not apply.                                                                                                                                                                                                                                                                                                  |
| New failure escalation or pending headroom selected a different request      | Move now to the stronger-only target above; not held by dwell, confidence or switch tax. Exhaustion stays with its explicit reason.                                                                                                                                                                                                                           |
| First routed decision: known incumbent below requirement                     | Declared target meets the requirement. Startup mass 1 through existing explicit-up switch-tax/cash gates and hard constraints, before classifier move branches. Reason/cause `startup`, not `mode`. The first routed decision consumes privilege even if blocked; no retry.                                                                                   |
| Demand above routed demand                                                   | Upgrade mass = current classifier probability above routed demand (`massAbove`), against the upgrade bar that rises with the route-to-route switch tax.                                                                                                                                                                                                       |
| Demand below routed demand                                                   | Support = current probability at or below demand (`massAtOrBelow`), against the downgrade bar with downgrade tax; same-task hold (`downAllowed`); dwell.                                                                                                                                                                                                      |
| Demand equals routed demand, target stronger, after a mode or catalog change | Mass 1: an explicit user or config choice, as `lateralMove` treats the base route (`lib/activity.mjs:109`). Gated by switch tax and cash cap only.                                                                                                                                                                                                            |
| Demand equals routed demand, target stronger, any other cause                | No move. A stronger route at the same demand needs a demand change or an explicit choice.                                                                                                                                                                                                                                                                     |
| Demand equals routed demand, target cheaper                                  | Economics, as `lateralMove`'s down path: must pay back its cache write within `downgradeHorizonTurns`; same-task hold; dwell.                                                                                                                                                                                                                                 |

Demand votes decide the demand change; they are not counted a second time in the move.
Startup uses the selector's existing requirement: effective demand after any accepted bounded-execute discount
plus the mode margin. It does not raise demand or cancel that discount. For example, native capability 0 with
baseline demand 1 and first low probability 0.57 can move to a declared qualifying target using startup mass 1,
even though classifier mass above 0 is below the ordinary 0.75 base. A fresh micro vote that lowers effective demand
to 0 leaves that native capability sufficient in balanced/cost mode and grants no startup move.
After the first decision, ordinary pending demand moves retain their classifier evidence and branch priority.

Firstness belongs to the genuine session or `/clear` new history, not the engine's turn counter or request count.
Every committed routed decision consumes it, including tier pins and earlier table routing. Manual/off native
requests do not, but still update cache and dwell observations. Reload, off/on, engine changes and compaction
cannot recreate eligibility. Persisted unmarked histories with request, decision or automatic-state evidence
conservatively count as consumed; a fresh explicit history marker is saved atomically with each routed decision.

### 3.4 Pins and explanation

- `/router pin <tier>` is a one-turn demand override. The target step uses that demand exactly, with no mode
  margin, and keeps normal candidate eligibility (including the cash cap), outcome precedence and incumbent ties.
  It bypasses the move step: no votes, confidence, dwell, checkpoint or switch-tax gate. A pin is not a move or a
  switch; it changes no session demand state, votes, holds, failure marker, routed demand or cause. The following
  unpinned turn resumes the pre-pin incumbent and demand. If nothing is eligible and the incumbent is invalid,
  the result is explicit `no-route`; a pin never restores a filtered candidate.
- An exact model+effort pin keeps today's meaning: that route runs.
- Every decision row carries demand, target, move reason and the next-turn estimate, for example:
  `demand 2 (balanced) → target sonnet@high cap 2.5 ~$0.04; move held: dwell 2/6`.

An observed native fallback rebases the incumbent to the request actually served, retaining demand, votes, hold and
routed demand. A substituted model's unreported effort remains unknown. Its origin is `external-fallback`, not a
policy move; external requests are counted separately. The rest of the current turn passes incoming native requests
through unchanged, even if eligibility returns. The next main turn uses the re-entry rule above. A pinned fallback
retains normal pre-pin state; restoring it must not erase the observed external physical provenance.

## 4. Running both engines safely

One config key: `routingEngine: "table" | "shadow" | "auto"`, default `table`.

- `table`: today's behaviour; the engine is not called.
- `shadow`: `table` routes. The engine runs its demand and target steps on the same turn **as a one-step proposal
  against the real incumbent** and the row records it (`alt`). It does not keep its own route history. No effect on
  requests, cache or cost. No band UI for it in v1; the pane's decision rows show it.
- `auto`: the engine routes. The route table and `applyMode` are not used.

`shadow` answers "how often and where would auto choose differently right now". The independent stateful simulation
belongs to offline replay (5.1), which answers a different question.

## 5. Evaluation

### 5.1 Replay traces and offline replay

Decision rows (max 60 per session, `lib/decisions.mjs:12`) are not enough to replay. In `shadow` mode the router also
writes an append-only **replay trace** per session. It is a narrow projection of what the router already sees, not a
generic event store. No prompt text, only:

- timestamped request events: classifier vectors (tier, activity, phase), failures, pins, resets, mode changes;
- per reply: model, effort, input, cache read, cache write and output tokens;
- the initial policy and cache state, and a snapshot of config, provider and prices at session start.

Storage is bounded by the Mod host's shared 4 MiB plugin store. In `shadow`, one `trace:v1:<session id>`
record keeps a logically append-only sequence. Retention is 30 days, with no decision-row or session-count limit;
a 1 MiB trace budget evicts oldest whole inactive sessions. Each session keeps at most 128 KiB. The writer checks
the whole store on each write and stops tracing if its measured or projected size exceeds 3 MiB. This leaves at
least 1 MiB headroom at that measurement, not a reservation against concurrent writes or growing usage ledgers.

The per-session cap stops at a whole-turn boundary. Its contiguous prefix remains usable; excluded turns and
events are counted separately as capped coverage. A usable prefix starts at sequence 1 with the initial
config/provider/prices and policy/cache state; it needs no clean-close event. A late start, resume, reload,
sequence gap, or lost write makes a trace **incomplete**. A failed write poisons the in-memory recorder; the next
successful write persists its lost-write count and reason. The host cannot guarantee a durable failure marker
when storage itself is unavailable.

An explicit export merges retained sessions into one export file (newer/longer record wins), then overwrites it.
Known taint and capped counters merge monotonically; differing initial snapshots or overlapping events add conflict taint.
At about 3 MiB the export rolls over to a new dated file; offline replay reads all export files. No prompt,
tool-result, filesystem-path text or classifier endpoints/credentials are included. Every snapshot projects only
routing fields, including configured and mode-transformed routes, model prices, provider cache semantics, native
availability, context/dwell/task-progress facts, failure signatures/occurrence indexes, and continuation/observed
move inputs. The recorder uses the existing hook/turn path and does not run in `table`.

Store writes lock and merge one key in the verified host implementation, but the API provides no multi-call quota
reservation, compare-and-set or conditional delete. Cross-process quota checks and same-session writers can race;
this is best-effort collection, not an audit log. Active records have a one-hour last-write lease against budget eviction; day-expired records always leave,
and stale active flags do not make killed sessions immortal. If all space has recent active leases, the writer
refuses and taints instead of truncating an event tail.

Replay state starts only from the initial header, then evolves by applying the recorded requests, responses,
controls, resets and config changes in order. Cache, policy and route state evolve independently; per-operation state is not a replay seed.
Reset snapshots are diagnostic comparison evidence; replay must apply the reset to its own state. Every response names its request sequence and turn/index.

Replay contract, in order:

1. **Fidelity check.** Replay with the `table` engine must reproduce the recorded routes on each complete trace.
   An unexplained mismatch on a complete trace **blocks** the evaluation until it is fixed in the recorder or the
   replay. It is not dropped from the denominator. Recorded taint or a sequence gap explains lost-write
   incompleteness; those traces are excluded, not unexplained fidelity failures. Capped prefixes remain usable and
   their excluded-turn counts are reported separately.
2. **Engine replay.** The same traces with the `auto` engine, each session stateful (own demand, cache and switch
   history).
3. **Report:** usable coverage (complete traces / all sessions, and turns), then per mode: conditional cost estimate
   per session for both engines, disagreement by demand level and activity, switches split into reversals (A→B→A
   within N turns) and one-way moves, effort mix.

What fidelity proves: the recorder and the replay of the **table** path are correct. It says nothing about the auto
engine's demand/move logic, which the table path never calls. The invariant tests (5.4) and the benchmark (5.3)
cover that. The table path's code is not changed by this work; auto shares only pure helpers (threshold formulas,
cost estimates), which keep their existing tests.

Replay freezes the original transcript, tool calls and failures. Its numbers are conditional cost estimates, not
counterfactual savings, and it measures nothing about quality.

### 5.2 Shadow in live sessions

`shadow` runs until a minimum exposure is met, not a calendar period: at least 30 complete sessions and 1,000 main
turns, with at least 200 turns in each mode that is evaluated. Output: disagreement rate on fresh data and the list of
disagreeing turns, which seeds benchmark tasks.

### 5.3 Paired benchmark (smoke gate for quality)

- 20–30 tasks with automatic pass checks (tests, lint, expected output), drawn partly from shadow disagreements.
- A held-out subset is fixed **before** any capability or margin tuning and not looked at while tuning.
- Each task runs headless with `table` and with `auto`, all three modes, two repeats.
- Report: paired discordances (pass/fail flips per task), not only pass rate; actual total cost including retries;
  wall time.
- The harness prints a cost estimate before a run.

At this size the benchmark cannot prove non-inferiority to a few points. It is a smoke gate: it catches clear
regressions and broken invariants.

### 5.4 Invariant tests (must pass before any live use)

Table-driven unit tests on the engine:

- a repeated failure always reaches a strictly stronger eligible candidate if one exists;
- a filtered candidate never comes back through a fallback;
- context too large / images / unavailable model, including when the incumbent itself fails them (`no-route`);
- outcome precedence: declared-below-demand before unknown; unknown only when nothing declared is eligible;
- `quality` at `high` never selects an unknown when a level-3 candidate is eligible;
- each move case in 3.3 uses its defined evidence input;
- `cost` never picks above `quality` for the same demand; `quality` never picks below `cost`;
- the incumbent is kept on an equal estimate, in every mode;
- a move blocked by a gate stays pending against routed demand and is re-evaluated on the next turn; it is never
  re-labelled as a mode or catalog change.

### 5.5 Cutover rule (written before the data)

The numbers below are the initial values. They are fixed in this document before any data is collected; changing
them later needs a recorded reason.

`auto` becomes the default when all hold:

- invariant tests pass;
- replay fidelity: no unexplained mismatch, usable coverage at least 80% of sessions;
- shadow exposure met (5.2);
- benchmark: no task where `auto` fails in both repeats while `table` passes in both, in any mode; held-out
  discordances reported;
- benchmark actual total cost for `balanced` at most 5% above `table` (a tolerance, not a savings claim);
- replay: reversals per 100 turns not higher than `table`.

**After cutover.** `table` stays selectable. Compare normalized rates per 100 main turns, from at least 1,000 turns on
`auto`, against the same rates from the shadow period: observed upward moves, escalations, manual pins, reversals, and
priced cost per turn.

Relative margins alone fail on a sparse baseline: with zero escalations in shadow, one escalation is "+∞%". So each
event rate has a relative margin **and** an absolute allowance, and a trigger needs a minimum event count. Cost has its
own bound, because events and dollars are different units:

- Remove the table and `applyMode` when every event rate (observed upward moves, escalations, manual pins, reversals)
  is within the larger of +20% of baseline or +0.5 events per 100 turns, **and** priced cost per turn is at most 120%
  of baseline.
- **Rollback trigger** (default back to `table`) after at least 300 turns on `auto`: a failure rate (escalations,
  observed upward moves, manual pins) above the larger of +50% of baseline or +1 event per 100 turns, **and** at least
  5 such events in the period. Any invariant broken in production triggers rollback at once.

## 6. Plan

Steps 1–4 change nothing for users on the default.

1. **Capability in the model catalog.** `models.<alias>.capability` with validation; values for every preset with
   sources; unknown handled explicitly.
2. **Engine module.** Pure functions for demand, candidate filtering, target and move, plus the invariant tests (5.4).
3. **`routingEngine` key and `shadow`.** Config validation; `alt` and engine fields in decision rows.
4. **Replay traces.** Writer in `shadow`, retention by days, incomplete marking.
5. **Replay tool.** Fidelity check first, then engine replay and the report. Synthetic trace fixtures in tests.
6. **Benchmark harness and tasks.** Headless runner, pass checks, held-out split, paired report, cost estimate.
7. **`auto`.** Engine routes; pins; docs (`configuration.md`, `routing-modes.md`, `evaluation.md`, `user-guide.md`).
8. **Cutover** by 5.5; later removal of the table and `applyMode`.

## 7. Risks

- Declared capability is a judgment. Mitigation: sources per value, unknown is explicit, benchmark smoke gate.
- The demand/move split rewires a tuned policy for `auto`. Mitigation: the table path is not changed; the same
  threshold formulas; the move cases in 3.3 each have an invariant test; benchmark smoke gate.
- With integer capabilities, `cost` and `balanced` often pick the same route. Accepted: the report shows how often
  modes coincide; presets add half-steps only with evidence.
- Replay traces add storage. Mitigation: written only in `shadow`, a narrow projection, day-based retention.
- The exposure, tolerance and rollback numbers in 5.2 and 5.5 are judgment, not statistics. Mitigation: they are
  fixed before the data and reported with the result.

## 8. Decisions made in review

- Demand, target and move are separate steps with separate state (Pi, round 1).
- Capability is declared per model and effort on the demand scale, with sources; unknown is explicit (rounds 1–2).
- Shadow is a one-step proposal against the real incumbent; stateful simulation is offline replay only (round 1).
- Unexplained fidelity mismatches block evaluation; incomplete and capped coverage are reported separately (round 2, bounded-storage amendment).
- The benchmark is a smoke gate, not proof of non-inferiority (rounds 1–2).
- One tie-break order for all modes; the mode provides headroom only through the requirement. After an equal
  estimate and incumbent preference, least-sufficient capability avoids favoring unseen thinking-token costs that
  the effort-blind estimate does not model (round 3; revised tie order).
- Moves compare against routed demand, so a blocked move stays pending with its original evidence (round 3).
- Startup raw demand uses the baseline, but accepted routed demand uses the actual known native capability.
  Unknown native capability keeps the baseline; initialization never invents a rank or mode offset.
- A same-physical selected target accepts current effective demand without a switch, including a next-turn equal
  external-fallback target. Route cause, holds and votes remain unchanged; pins and non-accepting stays do not
  adopt demand. Runtime and offline replay share this transition.
- Startup is a distinct first-routed move cause, not a mode change. After unchanged demand voting, a known native
  incumbent below the effective requirement can move to a declared qualifying target with mass 1 through the
  existing explicit-up switch-tax/cash gates, before classifier move branches. A blocked first decision consumes
  the chance. Unknown capability grants no privilege. Manual prefixes preserve eligibility; pins and prior table
  decisions consume it. Only a new session or `/clear` new history resets it, not compaction or engine lifecycle.
- Replay infers catalog evidence from the automatic catalog fingerprint, not table-only config snapshots.
  Pins retain the last accepted automatic mode/catalog so genuine edits remain explicit choices after unpinning.
- Bounded replay storage uses the host store rather than an unbounded event file or runtime subprocess:
  30-day retention, 128 KiB per session, 1 MiB total trace budget and a measured 3 MiB store guard.
  Contiguous open prefixes are usable; capped turns remain separate; failed writes taint on next success;
  exports merge incrementally. The shared-store headroom and same-session concurrency limits remain explicit.
- Post-cutover thresholds combine relative margins, absolute allowances and a minimum event count (round 3).
- Tier pins are one-turn demand overrides without a mode margin or move gate; eligibility remains mandatory and
  the pre-pin incumbent and demand resume afterwards.
- Escalation searches strictly stronger declared requests before unknown alternatives; exhaustion retains pending
  headroom. Failure occurrence deduplication uses signature and index, independent of physical moves.
- Observed native fallback rebases physical incumbent identity without resetting demand evidence. Explicit
  `external-fallback` provenance authorizes next-turn re-entry through hard constraints and cash cap, but not
  confidence, dwell or payback; equal native targets clear the marker. Substituted effort stays unknown. Re-entry
  updates routed demand and cause, preserves escalation holds, and counts external requests separately.
