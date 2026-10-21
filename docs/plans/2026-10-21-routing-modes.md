# Routing modes: `cost | balanced | quality`

Version 0.1 · 2026-10-21 · Phase 1 (plan) · Target release 1.15.0 · Branch `feat/routing-modes`, worktree
`../claude-model-router-routing-modes`.

Design: `router-modes/design.md` (manager scratchpad), shared with codex-router and pi-model-router. This plan maps it
onto this repo, lists where the code disagrees with it, and orders the work.

## 1. Design check against the code

Every file:line claim in the design and in the repo brief, checked on `origin/main` at `12f66aa` (router 1.14.0).

| Claim | Result |
| --- | --- |
| Only config file is `${CLAUDE_CONFIG_DIR ?? ~/.claude}/router.json`, `loadNativeConfig` `hooks/native-router.mjs:542-553` | Confirmed |
| Project and local settings that set HOME or CLAUDE_CONFIG_DIR are rejected `:543-547` | Confirmed |
| No project-level router config | Confirmed. `$.session.cwd()` exists (used for agent definitions, `:1111`; the test harness returns `/fixture/project`) |
| Recursive merge for plain objects `lib/config.mjs:437-447` | Confirmed |
| `checkShape` `:459-515`, `validate` `:517-613` | Drift: `checkShape` is `:459-502` (`checkObject` `:504-512`); `validate` is `:517-580` (`validateModel`/`validateClassifier` follow) |
| Defaults `:20-135`, routes high Opus/xhigh, medium Opus/medium, low Haiku/high, micro Haiku/medium | Routes confirmed (`:27-32`); `DEFAULTS` runs to `:190` |
| Activity overrides: code, debug, plan, review at low use Sonnet/high | Confirmed (`:42-48`), and **also** `ops.medium` = Haiku/high (missing from the brief; it changes the cost matrix, §3) |
| Model table with prices and efforts `:70-99` | Confirmed. All three models list every effort |
| Session mode `auto|manual` in `$.store` key `mode:<sessionId>`, `modeOf`/`rememberMode` `:137, 257-297` | Confirmed (`:137`, `:257-268`, `:291-298`) |
| `/router` parser `routerCommand` `:451-472` | Confirmed |
| `changeMode` `:421-436` aborts in-flight requests | Confirmed (`:421-438`, abort at `:423`) |
| `saveConfig` writes profile `router.json` `:556-572` | Confirmed (`:557-567`); validation through `rewrittenConfig` in `lib/config-file.mjs` |
| Votes, dwell, escalation hold `lib/config.mjs:105-129` | Confirmed (`:105-130`) |
| `policy.mjs:98-103` mixes vote-pending with tax-raised outcomes | Confirmed: `support < threshold` and `streak < downgradeVotes` both `continue` into `downgrade-pending`. Not changed here (out of scope) |
| `cashGate` is a separate check | Confirmed (`policy.mjs:126-139`) |
| Same-tier lateral path skips vote and dwell gates (`decideCell`, `lateralMove`) | **Partly.** `decideCell` (`route.mjs:256-277`) calls `lateralMove`, whose down branch checks only the downgrade tax (`activity.mjs:64-69`). But a same-task activity *down* is already gated by dwell and verification in `chooseActivity` (`activity.mjs:49`). The ungated case is a pair change with no activity change, which today cannot happen (next row) and which a mode creates |
| Dwell resets on a pair change `route.mjs:347-357` | Confirmed: `observeResponse` keys `servedRoute` by `model@effort` |
| `lib/cost.mjs:3-15` effort keeps cache for 5.5 models, splits on Bedrock, Vertex, Foundry, custom base URL; `effortSplitsCacheOf` `:529-537` | Confirmed (`:532-540`; also `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS`) |
| Turn decision record `:715-722`, view update `:731-741` | Confirmed (`:712-729`, `:730-756`) |
| Usage aggregated in `usage:v1` by activity, tier, model | Confirmed: cell key `activity|tier|id@effort` (`lib/usage.mjs:37-39, 77`) |
| Gate `npm test`, `npm run check`, `npm run typecheck`, `npm run test:plugin` | Confirmed (`package.json`) |
| Replay tool `trace-eval.mjs` | Exists; see §2 D5 |
| Design §3: Claude must persist the route in use | **Confirmed as a real defect:** `routeTurn` rebuilds the incumbent from config, `route.mjs:167` `route: resolveRoute(config, tier0, last.activity)` |

## 2. Divergences

- **D1. No `off` effort.** `EFFORTS` is `low..max`; a route effort of `null` keeps the session's effort; a model with
  `efforts: []` sends no effort and no adaptive thinking. Nothing to reject as "effort off". Proposal: no new
  validation. `proj` maps only inside `models[alias].efforts`, so the transform never yields null; a route with a null
  effort or a no-effort model skips the effort lever. The floor is the model's lowest listed effort.
- **D2. The incumbent pair is rebuilt from config** (`route.mjs:167`). With the transform in the route table, a mode
  change would make the incumbent equal the new target, so the switch would apply with no gate. Fix: the loop keeps
  the route in use (`loop.route`, `{model alias, effort}`), and the incumbent, escalation order, switch tax, cache
  state and the lateral rule use it. A loop saved by 1.14 has no `loop.route` and falls back to today's rebuild.
  Side effect: a pane route edit mid-session also goes through the gates instead of applying on the next request.
- **D3. Pair-aware gate.** The tier did not change, so tier votes do not apply. The gap is dwell and verification:
  `lateralMove`'s down branch gets the rule `decide` uses (`policy.mjs:99`): on the same task, without
  `facts.downAllowed`, stay with `downgrade-held`. Up moves keep their evidence bar, as tier upgrades have no dwell.
  Today's activity moves are unchanged: their same-task downs already need `downAllowed`.
- **D4. `uncertain` "no transform".** In this router `uncertain` means "stay on the incumbent tier"
  (`policy.mjs:47`). With D2 the stay keeps the pair in use while the mode is unchanged. After a mode change the
  stay's target is the new mode's pair for that tier, through the pair-aware gate. Using the untransformed pair instead
  would move a cost session back toward balanced on every uncertain turn. Proposal: treat `uncertain` like any
  same-tier stay.
- **D5. No decision log.** The Mod writes no log file (no `$.log`, no `decisions.jsonl`). The per-decision record is
  `router.turnActivities` (`:713-729`) feeding the view, activity stats and usage. `trace-eval.mjs` replays the 0.8
  gateway's `~/.claude-team/.../decisions.jsonl` (tier only, no activities, `decide` only). It can replay that trace
  per mode by passing `applyMode(config, mode)` as `config`, because the table carries the transformed routes. It
  cannot replay the lateral or pair-aware path. A native per-decision log would be a new feature. Proposal: carry
  `routingMode`, `modeSource`, classified tier and route in the turn record, the view and the usage cells; add the
  per-mode loop to `trace-eval`; no log file.
- **D6. Subagents.** The design defines tier routes only. Subagents get `light|standard|heavy` at `agent.spawn`.
  Proposal: the mode does not change subagent routing in 1.15.
- **D7. When a change applies.** Each turn's config is fixed at `turn.start` (`:1642`, so a mid-turn pane save does
  not change the turn). `/router mode` mid-turn therefore applies from the next turn, as a pane save does.
- **D8. Status text reads routes from the base config** (`display.mjs:197, 214`, `panel.mjs:283`). Under a mode it
  would name the wrong route. These read the effective table.

- **D9 (found in Phase 2, open).** The lateral down rule refuses any move whose downgrade tax is above zero
  (`activity.mjs:70-72`). For a same-model effort drop on a shared cache the tax is the gap between the candidate's
  worst case and the incumbent's best case for the new tokens (`cost.mjs:85-90`): $0.0044 for Opus/xhigh → Opus/high
  with 600 new tokens, $0.028 with 7,000. It is zero only with no new tokens since the last request. So on a measured
  history the cost effort lever (high, and low) never fires; only the first reply of a history or a model-lever move
  can. Both routes write the same new tokens, so this "tax" is not a cost. Proposed fix: `switchingTaxUsd` returns 0
  when both routes have the same cache key (`routeCacheKey`). It also lowers the bar slightly for balanced tier
  switches between routes that share a cache (Opus/medium ↔ Opus/xhigh, Haiku micro ↔ low). Waiting for the manager.

## 3. Expected transform with the built-in defaults

`P` = base pair for tier and activity. O = Opus, S = Sonnet, H = Haiku.

| Tier | Activity | balanced | cost | lever | quality |
| --- | --- | --- | --- | --- | --- |
| high | none, code, debug, plan, review, explore, docs | O/xhigh | O/high | effort (P(medium) is the same model) | O/max |
| high | ops | O/xhigh | **H/high** | model (P(medium, ops) = H/high) | O/max |
| medium | none, explore, docs | O/medium | H/high | model | O/high |
| medium | code, debug, plan, review | O/medium | S/high | model (P(low, code) = S/high) | O/high |
| medium | ops | H/high | H/medium | effort (P(low) is the same model) | H/xhigh |
| low | none, ops, explore, docs | H/high | H/medium | effort (D = low) | H/xhigh |
| low | code, debug, plan, review | S/high | **S/medium** | effort | S/xhigh |
| micro | any | H/medium | H/medium | none | H/medium |

Matches the design's expected results. The two bold cells conflict with the comments in `lib/config.mjs:33-40`:
high ops was kept on Opus because Haiku trails on multi-step tool work, and Sonnet at medium scored below Haiku at high
on FrontierCode while costing more. They follow from the fixed rules; reported as risk R1.

## 4. Shape of the change

- **Transform: one pure function** in a new `lib/modes.mjs`: `modeRoute(config, mode, tier, activity)` returns the
  design §2 target, always from the base `resolveRoute`, plus `projectEffort(efforts, wanted, direction)`.
  `applyMode(config, routingMode)` returns the effective config: dense `routes` and `activities` built from
  `modeRoute` for every tier and activity, `policy` = `{...policy, ...modes[mode].policy}`, and `routingMode`
  `{ mode, source }`. Every per-turn read (policy, routes, escalation, cache keys, generation) then reads one table.
  The base config is never fed back into the transform, so repeated requests cannot keep lowering effort.
- **Where it applies:** `turn.start` stores `applyMode(router.config, resolved)` in `router.turnConfigs`, so
  `decideTurn`, `reviewMidTurn`, `moveOnObserved`, `continueRoute` and `observeRouted` all use it. A pinned turn uses
  the base config: pins bypass the mode. Routing off (`manual`, `/model`) passes through as today.
- **Pair-aware gate:** `loop.route` (D2) plus the same-task dwell rule in `lateralMove` (D3). The switch tax and
  cache key use `routeCacheKey` on the effective pair, which honours `effortSplitsCache` as generation does.
- **Mode resolution:** `session override > project file > profile config > "balanced"`.
  - Profile: `mode` in `router.json`.
  - Project: `${await $.session.cwd()}/.claude/router.json`, read at `session.start` next to the profile file. Only
    `{ "mode": ... }`; any other key, a bad value or bad JSON ignores the file with a pane notice and the reason in
    `/router` text (open choice Q1). It cannot redirect the profile (the existing check stays). Documented as
    gitignore-able.
  - Session: `$.store` key `routing-mode:<sessionId>`, cached in `router.routingModes`. Survives resume (same session
    id); a new session id starts without it.
- **Command:** `/router mode <cost|balanced|quality|default>`. Never calls `changeMode`, never aborts. `default`
  deletes the key. A failed store write keeps the override for this process and says so, as `rememberMode` does.
- **Pane:** a mode control on the Policy tab writes the profile `mode` (one-value choice, applies on click, Undo).
  When a session or project mode wins, the pane names it and how to clear it.
- **Status:** band, `/router` text, Now tab: `cost (session)`; footer (`SessionMode`) only for a non-balanced mode
  (Q3).
- **Records:** `routingMode` and `modeSource` in the turn record, the view, and usage cells (§5 Config and
  migration).

## 5. Tasks

### Code

- [x] C1. `lib/config.mjs`: `ROUTING_MODES = ['cost', 'balanced', 'quality']`; `DEFAULTS.mode = 'balanced'`;
  `DEFAULTS.modes` with the design §5 policy patches; `checkShape` for `mode` and `modes` (`modes` keys `cost` and
  `quality` only, each only `policy`, policy keys only from `DEFAULTS.policy`); `validate`: enum check, and every
  effective policy (`base`, `base + modes.cost`, `base + modes.quality`) passes the existing policy checks, moved into
  `validatePolicy(p, at)`.
- [x] C2. `lib/modes.mjs`: `projectEffort`, `modeRoute`, `applyMode`, `resolveRoutingMode({ session, project,
  profile })` returning `{ mode, source }`.
- [x] C3. `lib/route.mjs`: `loop.route` written by `chooseRoute`, `observedMove` and `continueRoute`; `routeTurn`
  uses it for the incumbent when its model is still in `config.models`, else today's rebuild.
- [x] C4. `lib/activity.mjs`: `lateralMove` takes `sameTask`; a down move on the same task without
  `facts.downAllowed` stays (`downgrade-held`). `decideCell` passes `sameTaskOf(config, advice, facts)`.
- [x] C5. `hooks/native-router.mjs`: read the project file in `loadNativeConfig` (returns `projectMode` and a
  `projectError`); `routingModeOf($, router)` and `rememberRoutingMode`; `turn.start` stores the effective config;
  a pinned turn routes on the base config.
- [x] C6. `/router mode …` in `routerCommand`, the command description and `argumentHint`.
- [x] C7. Turn record and view: `routingMode`, `modeSource` next to `tier` and `route` (`:713-756`); `detailText`
  line `Mode: cost (session)`.
- [ ] C8. `lib/display.mjs`, `lib/panel.mjs`, `lib/band.mjs`: route texts read the effective table (D8); mode and
  source in the band, the Now tab and the footer; Policy tab mode control with `withMode(file, mode)` in
  `lib/config.mjs` (balanced written as no key).
- [ ] C9. `lib/usage.mjs`: cell key `mode|activity|tier|id@effort`, record version 2; version 1 records read as
  `balanced` (every reply before 1.15 ran balanced). Breakdowns keep grouping by activity, model and tier.
- [ ] C10. `experiments/mod-router/scripts/trace-eval.mjs`: a `--mode` (or per-mode loop) replay through
  `applyMode`; tier-level only (D5).
- [ ] C11. `types/index.d.ts`: `RouterRoutingMode`, view and loop fields.

### Tests

- [x] T1. `test/modes.test.mjs`, table-driven: mode × tier × activity × supported efforts → pair. Covers §3 with the
  defaults, plus: effort null (no effort lever; quality falls to `P(T+1)`); a model with `efforts: []`; sparse efforts
  (`['low', 'high']`: cost from high stays, quality from low goes to high); effort at `max` (quality model lever, high
  stays); cost never yields micro; cost model lever only when the input price is lower (equal price → effort lever).
- [x] T2. `applyMode` is idempotent from the base: applying to the base twice gives the same table; the table never
  derives from an effective config (repeated decisions on Opus/high stay on Opus/high).
- [x] T3. Precedence: session > project > profile > default; `default` clears the session key; each source shown.
- [x] T4. Config validation errors: bad `mode`, unknown `modes` key, `modes.balanced`, unknown policy key in a patch,
  a patch value that fails policy checks (e.g. `minDwellRequests: -1`), project file with another key, bad JSON.
- [x] T5. **Key regression** (`test/route.test.mjs`): incumbent Opus/xhigh at high, switch to cost, shared cache and
  zero switch tax, continuation turn: stays until dwell and a passed verification; then moves to Opus/high; later
  requests stay on Opus/high.
- [x] T6. Same-tier mode switch on a new task (not a continuation) moves at once, as a tier downgrade would.
- [x] T7. `effortSplitsCache: true`: the effort lever is priced as a cold write; the tax can hold the incumbent; no
  effort fallback.
- [x] T8. Pin under cost mode runs the base route; routing off ignores the mode.
- [x] T9. Hook tests (`test/hook-routing.test.mjs`): `/router mode cost` does not abort an in-flight turn and applies
  next turn; resume (same session id) keeps it; a new session id does not; project file read from
  `/fixture/project/.claude/router.json`; invalid project file is ignored with a notice.
- [ ] T10. Usage: version 1 record reads as `balanced` cells; version 2 round trip; merge of mixed versions;
  `prunedUsage` still never deletes a record it cannot read.
- [ ] T11. Golden decisions (`test/decision-golden.test.mjs`) unchanged in balanced.
- [ ] T12. Pane: Policy mode control writes `mode`, Undo restores; override note.
- [ ] T13. Golden decision matrix (added by the manager, 2026-10-21): every classifier tier (micro, low, medium,
  high, uncertain) × every activity (code, debug, explore, plan, review, ops, docs, uncertain) × every mode, on the
  default config and one user-like profile (the user's `routes.high` = Opus/high). Exact pair per cell, through
  `chooseRoute` on a fresh history. Invariants: micro equal in all modes; balanced equals the 1.14 routing; cost never
  above and quality never below balanced by input price, then effort; cost never below `low` and never without an
  effort at `low` or above; pins bypass. A minimum count of cells that differ between modes. The matrix is written as
  a Markdown table into `docs/routing-modes.md` from the test data (`npm run docs:modes`), and a test fails when the
  file is stale.

### Docs

- [ ] W1. `README.md`: one paragraph and the command.
- [ ] W2. `docs/configuration.md`: `mode`, `modes` with the untuned values and the merge rule, the project file and
  gitignore note, precedence.
- [ ] W3. `docs/user-guide.md`: "Choose a routing mode" (command, pane, what changes and when, pins).
- [ ] W4. `docs/architecture.md` and `docs/native-router.md`: transform, pair-aware gate, route in use, records.
- [ ] W5. Screenshots: `npm run docs:images` (`scripts/render-doc-images.mjs` draws the band and pane SVGs from the
  real render functions); add a cost-mode band sample and refresh `router-band.svg`, `router-pane-now.svg`,
  `router-pane-policy.svg`.

### Config and migration

- [ ] M1. `router.json` without `mode` reads as `balanced`: no migration. `scripts/migrate-config.mjs` unchanged.
- [ ] M2. `$.store`: new `routing-mode:<sessionId>`; `mode:<sessionId>` unchanged.
- [ ] M3. Usage records: version 2 under the same `usage:v1:<sessionId>` keys, as 1.14.0 did for subagents
  (Q2). A 1.14 session reads a version 2 record as empty and never prunes it.
- [ ] M4. User machine changes, **listed, not applied** (the manager applies after release with approval):
  - `~/.claude/router.json` (personal, subscription): add `"mode": "<choice>"`; `balanced` needs no key.
  - `~/.claude-team/router.json` (work): add `"mode": "<choice>"`, e.g. `"cost"`.
  - Both files today set `routes.high` = Opus/high, so cost at high gives Opus/medium (same as the medium route) and
    quality at high gives Opus/xhigh.
  - `~/.claude/profiles/router.json` sets `ANTHROPIC_BASE_URL` to a gateway, so personal sessions split the cache by
    effort (`effortSplitsCacheOf`): the effort lever there costs a cache write (R2).
  - No change to `~/.claude/profiles/*` or `~/.claude/scripts/ce`.

### Live agterm verification

Isolated `CLAUDE_CONFIG_DIR` in the scratchpad, plugin loaded from a scratch copy of the worktree with
`--plugin-dir`, the installed router disabled with `--settings`, a throwaway git project.

- [ ] L1. Each mode via profile `router.json`: band and `/router` text show `cost (profile)` etc.; capture `session
  text`.
- [ ] L2. `/router mode cost` mid-session: no abort; next turn shows the new preferred route; on a continuation the
  route stays pending until dwell (band reason `downgrade-held`).
- [ ] L3. Project file `{ "mode": "quality" }` beats profile; `/router mode cost` beats project; `/router mode
  default` returns to `quality (project)`; a project file with another key is ignored with a notice.
- [ ] L4. `claude --continue` keeps the session override; a new session does not.
- [ ] L5. `/router pin high` in cost mode runs Opus/xhigh (base).
- [ ] L6. Records: the store's usage record holds `cost|…` cells; the view carries `routingMode` and `modeSource`.
- [ ] L7. Doc screenshots from `npm run docs:images` checked against the live band.
- [ ] L9. Live classifier run (added by the manager): a fixed set of ~20 prompts over the tier × activity cells
  that can be triggered, through the real Jev classifier; record the classified tier and activity and the routed
  pair under each mode. Classification mismatches are reported apart from routing bugs.
- [ ] L10. Impact: on the same prompt set, and a per-mode replay with `trace-eval.mjs` (tier-level; it cannot replay
  same-tier moves), estimated cost per mode and the model and effort mix. Then one representative multi-turn task per
  mode in an isolated agterm session: models used, switches, tokens and cost. A mode without a real difference
  somewhere is a finding.
- [ ] L8. Close test sessions; remove the scratch copy and the isolated config dir.

### Release

- [ ] R1. `CHANGELOG.md` 1.15.0 section with a migration note (usage record version 2; no config migration).
- [ ] R2. Version 1.15.0 in `package.json` and `.claude-plugin/plugin.json` (Q4 decides where).
- [ ] R3. PR from `feat/routing-modes`; stop before merge, tag or publish.

## 6. Risks

- **R1.** Cost moves high ops to Haiku/high and low coding to Sonnet/medium (§3), against this repo's own model notes.
  Fixed rules, no per-activity floors (design §6). Replay data should check them.
- **R2.** With `effortSplitsCache` (custom base URL, as the user's personal profile has) the effort lever writes a new
  cache. The tax gate prices it; in cost mode the move may be held often.
- **R3.** D2 changes balanced in one case: a pane route edit mid-session now waits for the gates.
- **R4.** `$.session.cwd()` is the launch directory in the harness; whether it moves with a Bash `cd` is not verified
  (live check L3).
- **R5.** Policy patches are untuned (design §5); cost dwell 4 and quality dwell 16 against Claude's base 8.

## 7. Open choices

- **Q1.** Invalid project file: ignore it with a notice (recommended: a repo must not turn routing off), or make
  routing unavailable as an invalid `router.json` does.
- **Q2.** Usage schema: version 2 under the same `usage:v1:` keys (recommended, the 1.14.0 subagents precedent), or a
  new `usage:v2:` prefix with a read of both.
- **Q3.** Footer label: only for a non-balanced mode (recommended), or always.
- **Q4.** Version bump: this repo bumps in a separate `router X.Y.Z` commit on main after the feature PR merges
  (`9daad7d`, `12f66aa`). Recommended: follow that; the PR carries the changelog section. Alternative: bump inside the
  PR as the common brief says.
- **Q5.** D2's side effect on pane route edits (R3): accept (recommended, one rule for every pair change), or keep
  pane edits immediate.
- **Q6.** Mode in usage cells without a new Usage view in 1.15 (recommended), or add a mode grouping to the Usage tab.
