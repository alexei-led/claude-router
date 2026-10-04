# Claude Model Router on Jev: native Mods design and execution plan

Status: native controller and panel implemented; direct Team validation in progress. The release target is 1.0.0. Full cutover remains gated on the acceptance matrix.
Scope: implementation and validation in an isolated candidate. Root packaging, launchers and profiles have not been switched. See the [candidate guide](../native-router.md) for current controls and evidence.

## Goal and evidence

Replace the Anthropic gateway with native Claude Code routing and UI. Keep Jev, routing tiers, turn pins, context fit, escalation holds and cache-aware hysteresis. Anthropic credentials, streaming, tools and the cost ledger remain owned by Claude Code.

The [prototype](../../experiments/mod-router/README.md) proves model/effort rewriting and per-step usage on 2.1.289. Direct Team sessions accepted Sonnet/Opus requests over 589K tokens and tool use across Sonnet → Opus → Haiku. The native controller classified a real Jev request in 390 ms. Full model IDs are required. The remaining lifecycle and compatibility cases below still gate cutover.

Codex owns edits and verification. Claude Team is the read-only design peer. Implementation starts with evidence collection, not profile cutover.

## Architecture

Use one thin Mods adapter around the existing pure policy. The request path is: turn facts → bounded Jev advice → policy → `turn.step` model/effort → native transport → observed usage → reactive UI.

| Keep or adapt                                                                                          | Change                                                                                                                                                                               |
| ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [config.mjs](../../lib/config.mjs), [policy.mjs](../../lib/policy.mjs), [cost.mjs](../../lib/cost.mjs) | Keep legacy cache behavior. Add native cache evidence in a separate pure module, with an explicit policy boundary used only by the native caller                                     |
| [jev.mjs](../../lib/jev.mjs)                                                                           | Extract pure payload/parser/retry decisions from the Fetch/timer wrapper. Keep the gateway wrapper and existing exports. Select one native classifier transport after runtime probes |
| [facts.mjs](../../lib/facts.mjs), [router.mjs](../../lib/router.mjs)                                   | Extract a transport-free controller and native facts adapter. Keep gateway-specific hashing and persistence outside it                                                               |
| New native hooks and state declarations                                                                | Own model rewriting, lifecycle observation, commands, UI and per-loop state                                                                                                          |
| [rewrite.mjs](../../lib/rewrite.mjs), gateway, SSE reader and daemon scripts                           | Keep during acceptance and rollback. Delete from the native release only after compatibility passes                                                                                  |
| Statusline, setup and tier skills                                                                      | Replace gateway setup with Mod readiness checks and native controls. Update documented command names deliberately                                                                    |

The Mod cannot import Node APIs. Its pure dependency graph must remain free of Node imports. A classifier helper, if selected, stays a separate Node executable. No new runtime dependencies or general extension framework are needed.

Legacy gateway callers continue using the existing cost path. Native uncertainty and fallback inputs cannot change their decisions. Existing regression expectations remain unchanged. Any extraction or internal policy seam must demonstrate parity before the native controller uses it.

## Classifier transport decision

Native `$.http.fetch` is the selected candidate. Its response is `{status, ok, headers, text}`. The installed interface has no timeout/signal option. Loopback measurements confirmed socket closure near 30 seconds and immediate closure when a hot reload replaces the module. Other lifecycle transitions still need the full matrix.

The deadline is 1500 ms for the whole advice attempt, including one possible retry and response-body processing. Race against a cancellable timer. Retry only settled transient errors while budget remains. Never retry a timed-out or still-pending request. One launched attempt contributes at most one breaker failure. Busy suppression is a distinct reason. Preserve the existing three-failure, 60-second circuit.

Use native HTTP only if one unfinished request per session can be maintained through interrupt, clear, resume, branch, reload and unload. `$.state` survives reload but resets on clear/resume/branch. Neither a module flag nor a state lease establishes this bound by itself. Do not build persistent locking to compensate.

If native lifecycle cancellation fails, choose one-shot `scripts/jev-cli.mjs` through `$.process.run`, with stdin and a remaining-budget `timeoutMs`. Reuse `askJev` and its abort logic. Measure spawn overhead and process termination. Select one transport for production. Do not ship automatic transport failover.

Use the declared sensitive `typesafe_api_key` option as the normal credential source. Retain a documented environment override only if existing setup requires it. Never put the key on argv, in diagnostics or in persisted state. A network/process policy refusal produces visible degraded routing. A helper must not bypass a policy restriction.

The local `PluginOptions` declaration exposes manifest options directly to `register(on, options)`. Secure-option retrieval and one harmless classification to the real Jev host passed in the Team candidate. Loopback tests separately use a synthetic credential.

## Controller and lifecycle contract

- Key decisions by session ID, history generation, loop ID and turn ID. Classify a logical turn once. Tool continuations and replayed steps reuse the decision without adding votes.
- Publish advice only if its session, generation and turn still match. Late results cannot change route, breaker state or UI for a newer turn.
- Pins apply to the next turn and all its tool continuations. They do not rewrite the automatic incumbent. The next unpinned turn resumes from that incumbent.
- Keep subagent facts and decisions isolated. Explicit agent model choices pass through. Evidence phase must identify how the gateway treats inherited and explicit agent models before declaring parity. Document any native eligibility limit before cutover.
- Preserve Claude's fallback. An `e.model` difference from the session model is a candidate detection signal, not a confirmed contract. Prove it in runtime probes. Never force the original route over a fallback.
- Observe native `session.end`, `session.compact`, current `session.id()` and state defaults. Do not rely on user-tier `classic.*` hooks: Team `sec-default` skips them. Confirm native event delivery under Team.
- Invalidate warmth, votes, holds and pending advice on a genuine history break. Keep the last context size as a conservative floor until a new measurement exists. Reload preserves valid state without duplicate commands or UI handlers.
- Compaction invalidates state only after it commits. A skipped compaction or precomputed summary is not a history break. Agent compaction affects that agent alone.
- A window-exceeded response marks the candidate unusable for the current history. Pass the failure through without replaying the Anthropic request. Inspect the exposed failure contract before prescribing a status-code handler.
- Jev failure keeps the eligible automatic incumbent. With no incumbent, use an allowed native fallback. Context fit and native fallback still take precedence. This is a native-only behavior change: a classifier outage must not itself trigger a downgrade.
- Storage failure must not prevent native request delivery. Persist preferences or bounded diagnostics only, not transcript text, cross-session warmth or a second dollar ledger.

## Cache and cost contract

Cache identity uses the exact observed model snapshot, effective effort and history generation. Never strip date suffixes generically. Use explicit, checked configured-to-snapshot mappings. Do not search historical snapshots for the warmest entry. Unknown or changed resolution gets unknown cache evidence.

Record per-step observed counters. Total input is `input + cache_read + cache_creation`. Observed cached prefix is `cache_read + cache_creation`. Output contributes to estimated next context but is not already cached. All-zero usage writes no warmth. Agent usage does not update main warmth. Native session cost is authoritative, so neither duplicate observations nor repeated billed requests create a second Mod ledger.

Evidence is `fresh estimate` within the five-minute minimum minus the existing 30-second margin, or `unknown`. A hit after five minutes does not establish one-hour TTL. Hits refresh expiry, and shared prefixes can be refreshed elsewhere. Unknown does not mean confirmed cold. [Cache semantics](https://platform.claude.com/docs/en/build-with-claude/prompt-caching).

For display, calculate a 5m–1h write-cost range and label it as an estimate. For policy, unknown TTL/warmth must not manufacture a saving: evaluate candidate-worst versus incumbent-best input cost within supported cache scenarios. Feed that conservative switching tax into the existing formulas and five-turn downgrade horizon. The cash cap uses the cold-write upper bound. Keep thresholds and escalation rules. This is an intentional policy-input change, with tests and evaluation.

The cap applies to the estimated cold cache write on a credits model. It does not cap generated output or total session spend.

Future payback remains a scenario estimate. Subscription dollars are list-price equivalents, not charges. Do not advertise measured savings without a comparable baseline. If uncertainty is too broad, show unavailable evidence instead of a precise amount.

Reference fixture: input 2000, cache read 140000, cache creation 8000, output 1500. Next context is 151500, observed cached prefix 148000. At current configured prices, 5m point estimates give Sonnet input $0.03835, cold Haiku input $0.189375, five-turn downgrade tax $0.052925 and payback 7 turns. Haiku's 1h cold-write upper bound is $0.303. Point estimates are examples, not the uncertainty decision rule.

The decision-rule fixtures for that same evidence are:

| Scenario                                          | Switching tax | Five-turn downgrade tax | Threshold |
| ------------------------------------------------- | ------------- | ----------------------- | --------- |
| Sonnet → Haiku, candidate-worst/incumbent-best    | $0.26640      | $0.16830                | 0.9201466 |
| Sonnet → Opus, candidate-worst/incumbent-best     | $1.17540      | Not applicable          | 0.8552346 |
| Legacy Sonnet → Opus, both cold at 5m             | $0.37875      | Not applicable          | 0.8146515 |
| Legacy Sonnet → Opus, fresh 148K incumbent prefix | $0.71915      | Not applicable          | 0.8384817 |

These are fixture-specific comparisons, not a general claim that thresholds move by at most 0.04.

The incumbent lower bound charges its uncached suffix at ordinary input price, rather than a cache-write multiplier. Its lower input cost is $0.03660; the conservative Haiku next-turn difference is $0.25890, with payback after 12 later turns. The preceding 5m point estimate remains a separate scenario.

Evaluation means running unchanged-rule parity fixtures and these uncertainty scenarios, then comparing switch counts, gate reasons and estimated cost ranges on available sanitized traces. Use authorized Team traces only. Existing `decisions.jsonl` lacks separate uncached/write counters. Exact native-prefix replay needs additional evidence. Mark missing evidence, supplement with complete probe fixtures, and report replay coverage. Trace comparisons are shadow scenarios, not measured counterfactual savings.

## Context fit

Use same-loop observed context plus output and the engine's local summary estimate. Take the maximum. Never reduce from an unrelated session measurement. Re-evaluate before every step, including after large tool results. The existing fit policy reserves 20% of the model window.

Before switching to a smaller window, require adequate current-history evidence. Incomplete, truncated or missing estimates must not allow a downgrade. Do not use chars/3 as a bound: raw transcript excludes system/tool overhead and contains media. A large resume without usable evidence keeps the allowed native model and reports `context unknown`. Test newly enlarged tool results and first requests after resume or compaction.

## UI and controls

The band answers: what is serving, why, and whether action is needed. No money in the band. No notifications for ordinary continuations. Preserve other Mods' drawing and focus.

| State                     | Proposed band text                                                             |
| ------------------------- | ------------------------------------------------------------------------------ |
| Ready                     | `Jev Router · Auto · ready`                                                    |
| Choosing                  | `Jev Router · choosing for this turn…`                                         |
| Routed                    | `Jev Router · Sonnet · xhigh · staying: cache cost`                            |
| Pinned                    | `Jev Router · Opus · pinned for next turn`                                     |
| Observed substitution     | `Jev Router · requested Sonnet → serving Opus · native fallback`               |
| Manual from `/model`      | `Jev Router · manual Sonnet · /router auto to resume`                          |
| Manual from `/router off` | `Jev Router · routing paused · /router auto to resume`                         |
| Degraded                  | `Jev Router · Jev unavailable · keeping Sonnet`                                |
| Circuit paused            | `Jev Router · Jev paused · retry in 42s`                                       |
| Context unavailable       | `Jev Router · context unknown · keeping native model`                          |
| Unavailable               | `Jev Router · gateway still configured · open /router`                         |
| Unsupported version       | Startup diagnostic: `Native Mods unavailable · use the pinned gateway version` |

Examples describe proposed behavior, not implemented screenshots. Until a response arrives, distinguish selected model from observed serving model. Do not claim actual effective effort when the engine does not report it.

Use two control modes, Auto and Manual. `/model` and `/router off` both enter Manual, with different displayed reasons. `/router` opens details. `/router auto` explicitly enables routing. `/router off` clears pending pins. `/router pin <micro|low|medium|high>` sets one next-turn pin. Details show mode, reason, classifier health, observed versus estimated context, cache counters/age/uncertainty and cost range. State each action's lifetime beside its control. Pins cannot silently enable Auto.

Do not derive mode solely from baseline equality. Choosing that same model can still mean a fixed model. Observe the supported `/model` or configuration path and latch Manual. Returning to baseline does not enable Auto. Manual must survive clear/resume/branch and reload, including a manual choice of the baseline itself. Phase 0 tests a process-lifetime channel: `$.env.get/set` is declared on 2.1.289 and writes the current process environment, not a profile file. Validate its permissions, persistence, child inheritance and cleanup before using one non-secret internal control value. Module memory alone does not survive reload. If no reliable channel is available, leave this as a cutover blocker rather than weaken the control contract. Do not introduce a fake API model alias.

Disable/unload leaves a valid native session model. Headless users receive concise status output without opening a pane. Terminal tests cover narrow width, keyboard controls and focus. Desktop tests cover the same semantics.

## Execution phases

Only Codex writes these files. Claude reviews each bounded result read-only.

| Phase                           | Owned files and work                                                                                                                                                     | Acceptance evidence                                                                                                                                                                                | Stop or rollback                                                                                                 |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| 0. Runtime gates                | `experiments/mod-router/` probes and sanitized results, read-only launcher ownership mapping                                                                             | Installed types and credentials. HTTP/process timing and termination. Team events. Manual mode lifecycle. Fallback/agent eligibility. Early signed-thinking/tool/large-context/Haiku compatibility | No production change. Choose helper if native cancellation fails. Stop on policy refusal or incompatible routing |
| 1. Pure policy boundary         | New pure Jev/controller/facts/native-cache modules and tests, minimal extraction from `lib/jev.mjs` and explicit native-only policy seam                                 | Existing 242 expectations pass. Legacy decision parity. Pure Mod-safe dependency graph. Native uncertainty and exact-ID/context fixtures, defined trace evaluation                                 | Gateway decisions stay unchanged. Do not modify its shared cost path to enable native behavior                   |
| 2. Native controller/classifier | New hooks/types, selected classifier adapter or helper, native tests                                                                                                     | Once-per-turn advice, bounded retry/circuit, no late writes, isolated loops, history resets, fallback preserved, no Node imports in Mod graph                                                      | Local `--plugin-dir` candidate. Do not enable both routers                                                       |
| 3. UI and controls              | Native render/command modules, tests and minimal operator docs                                                                                                           | Truthful band. Documented command scope. `/model` respected. Requested/actual mismatch. Terminal/desktop focus and narrow layouts                                                                  | Disable candidate. Native session model remains usable                                                           |
| 4. Direct integration           | E2E probes/fixtures and candidate per-launch settings in an isolated directory                                                                                           | Gateway stopped. No alias, proxy base URL or hint headers. Jev success/failure. 1M context, thinking, tools, per-turn controls, output limits, reset/unload and multi-session isolation            | Compatibility failure blocks full cutover. Do not claim parity from restricted evidence                          |
| 5. Team canary                  | Codex-owned `experiments/mod-router/scripts/launch-team-native.*` candidate and per-launch settings, migration instructions, separately scoped launcher source if needed | Old plugin disabled. Fresh/resumed sessions. One active router. Measured fallback latency/cache behavior. Rehearsed return to old launch                                                           | Disable native candidate and restore old launch. Keep gateway code available                                     |
| 6. Package and cleanup          | Root hooks/manifest, package/check scripts, README/user guide/config/architecture, obsolete scripts/skills                                                               | Root validate, native tests, lint/types, package contents and relevant E2E pass. Clear install/update/uninstall. Correct version and migration notes                                               | Retain a pinned old version and tested rollback instructions                                                     |

Profile changes occur only at Team cutover. Team plugin directories are shared symlinks, so installing through them can affect personal Claude. Use an isolated plugin path and per-launch settings first. Before installation, identify the physical destination and exact plugin IDs. Do not rewrite personal config or organizational policy.

Launcher ownership is external to this repository: `$HOME/.local/bin/ce` resolves to `$HOME/.claude/scripts/ce`, as verified by `readlink`. Codex owns the isolated candidate wrapper here. Phase 0 identifies the maintained launcher source and its repository read-only, without reading personal profile contents. Any later launcher-source change is separately scoped to that source. The existing `ce team` path is the rollback and is not edited during probes.

Phase 0 driver: use a dedicated Team agterm probe session for clear/resume/branch/compact/interrupt and manual model selection. It runs a local probe Mod, not another design peer. Codex records its exact session/pane IDs and drives only that probe. Use stream-json for headless timing and scripted conversations. Probe events and loopback connection/close timings go to sanitized JSONL without prompts, keys or headers. Never acknowledge a runtime permission or trust dialog automatically.

Run early compatibility probes before extraction or UI work. Cover signed thinking and tools across Sonnet → Opus, a Sonnet/Opus request above 200K, and Haiku effort/output limits. A failed probe prevents commitment to the full native route set. Phase 4 then runs the complete matrix.

## Required acceptance matrix

| Area             | Cases                                                                                                                                                                                                                                         |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Jev              | Success, missing key, invalid payload, 503 then success, `Retry-After`, hang, slow body, timeout, policy refusal and breaker recovery                                                                                                         |
| Timing/resources | 1500 ms advice budget, initially 150 ms scheduling allowance measured rather than assumed, p95 and worst case, one unfinished request across lifecycle transitions, no process leak                                                           |
| Routing          | Pins, continuations/replay, no duplicate votes, explicit model including baseline, classifier failure preserving incumbent, native fallback, unmapped actual model and concurrent agent/main turns                                            |
| Cache/cost       | 0/270-second boundaries, unknown TTL, 5m/1h bounds, snapshots, efforts, partial/zero cache, history/settings changes and worked fixtures                                                                                                      |
| Context/history  | Large fresh/resumed history, missing estimates, large tools/media, compact skip/precompute/commit, rewind, clear, branch, reload and interruption                                                                                             |
| Compatibility    | 1M beta, signed thinking, output limits, tool additions, per-turn controls and custom agents                                                                                                                                                  |
| UI/integration   | Ready/choosing/degraded/manual/context-unknown, unsupported version diagnostic, Manual survival through resets/reload, requested versus actual, keyboard/focus/narrow width, desktop, headless, disable/unload, direct transport and rollback |

## Review and remaining gates

The visible peer review settled: no TTL inference from hit ratios, generic snapshot stripping, second cost ledger, persistent lock framework or policy bypass. Cost examples were checked with the current implementation. [State lifecycle](https://code.claude.com/docs/en/plugins/mods/interface) and [Team policy](https://github.com/anthropics/claude-code/blob/main/mods/sec-default/hooks/register.ts) rule out several initially proposed shortcuts.

Remaining runtime gates are deliberate implementation tasks: classifier cancellation/latency, accessible lifecycle/fallback signals, `/model` mode scope, agent eligibility, estimator coverage and compatibility. Transport choice and full cutover depend on these results. None is represented as already tested.

### Current cutover gates

- Current full Node suite: 285 passed. Biome checked 65 files. Mod prototype tests: 3 passed; strict prototype types pass. Native terminal/desktop kit previously passed 2 tests.
- Main conversation routing, Manual response metrics, per-turn tuning capture, clear draft reset and secure-key handoff are implemented. The live Manual reply and authenticated Jev request passed.
- Approved scope: Mods route the main conversation and preserve every subagent choice. The pinned API cannot distinguish a definition-selected model from inheritance, so arbitrary subagent rerouting is excluded from this migration.
- Full lifecycle/resource matrix, actual native fallback, remaining request-feature probes, shadow trace evaluation, Team canary/rollback and root packaging remain open.
- The previously failing daemon stderr assertion passes in the current full suite. No production fix is claimed from that single green run.
- Duplicate agterm probe and its stub server were closed. The main workspace and active native candidate remain open until validation finishes.

Native HTTP timeout acceptance has 20 fresh-process samples: p95 1504 ms, worst 1505 ms. Burst probes observed one open connection, with no connections remaining after completion. Persistent headless `/clear` now proves the one-request guard survives the state/history reset and the socket closes after CLI exit. Real 60-second circuit expiry and 503→success recovery also passed. Resume/fork, reload, interrupt and unload remain distinct resource gates. See the checked-in persistent acceptance results and their repository-owned driver.

Claude Team's design review approved the runtime evidence phase. Its gateway-isolation and mode-reset findings are reflected above. The added worst-case arithmetic has been independently checked. The implemented candidate still requires the remaining acceptance gates before production release.

### Release 1.0.0 completion evidence

- Runtime: reproduce the native Team launch from repository-owned scripts, complete the persistent lifecycle/resource matrix, and verify Manual persistence.
- Compatibility: prove actual native fallback and remaining per-turn, output-limit and tool-change cases without replaying model requests.
- Evaluation: record sanitized trace coverage, route transitions, policy gate reasons and conservative cache-cost scenarios; do not claim measured savings from shadow estimates.
- Canary: run fresh and resumed direct Team sessions with exactly one router and rehearse rollback to the pinned gateway launch.
- Release: switch root packaging to native routing, validate the packed artifact, update migration/operator docs and changelog, review the final diff, then publish v1.0.0 through the repository's signed-tag release workflow and verify npm/GitHub results.

Codex is the sole writer. The visible ce Team peer analyzes, tests and reviews each bounded result. The user authorized completing these gates and publishing version 1.0.0 for alexei-led/claude-router.
