# The auto engine reads and writes holds

Status: agreed with the user (2026-11-22); chains stay table-only, return after a hold goes through normal gates.

## Why

A hold is a fact about the world, not about the engine. Today the `auto` engine is cut off from it on both
sides (BACKLOG.md "Failover gaps"):

- **Write:** `holdFailedModel` skips `applyHold` when `routingEngine === 'auto'` (hooks/native-router.mjs:3325),
  so an API error that ends a turn changes nothing. The next turn re-selects the same model and fails again.
  Auto's demand escalation is a different channel (`facts.failure`: repeated tool errors in the transcript),
  so nothing at all reacts to an API failure.
- **Read:** `accountHoldsOf` returns `{}` under `auto` (hooks/native-router.mjs:3355), which also blinds the
  pane's HELD OUT section and `/router holds`/`release` for account holds. `assessCandidates` has no hold
  constraint, and `shadowProposal` passes no holds, so the shadow `alt` column names models the table side
  just routed around. Traces record no hold state, so replay cannot reproduce a hold-aware proposal.

## Decisions

1. **Shared store, engine-specific reaction.** Every engine reads `heldIds(config, loop.held, accountHolds,
now)` and every engine writes holds on `StopFailure`. Table answers with a one-turn stand-in (chain, then
   nearest tier); auto answers with eligibility: a held candidate is never a target, and a held incumbent
   flows into the existing `forced` move. No new engine state.
2. **Reason `held-out`** in `assessCandidates`, as a hard constraint like `unavailable`. Holds are read fresh
   with `now` per decision; they never enter `facts.ineligible` (per-history) or `autoCatalogKey` (a hold is
   not a catalog edit), so engine state is not reset.
3. **Return after a hold ends** goes through the normal gates (demand, switch tax, cache economics). The
   incumbent rebases to the replacement on the forced move, as on any substitution (2026-11-16 design §3.4);
   a free return would be wrong for auto, which has no configured route to return to.
4. **Fallback chains stay table-only**, documented: under `auto` the catalog is the fallback space. A held
   incumbent's replacement is the best eligible candidate by demand/cost/cache, not the chain order.
5. **Traces** record the held model ids per operation; replay passes them through, keeping replay and the
   live shadow column in agreement.
6. **Anti-degenerate notice:** under `auto`, a catalog where no model declares `capability` (every selection
   lands in the `unknown-only` pool, cheapest-first) gets a one-time toast naming the setting. Values for the
   user's private profiles come from public Artificial Analysis results, anchored on the declared presets
   (`opus@medium: 2`, `opus@xhigh: 3`, `haiku@medium: 0`, `haiku@high: 1`).

## Change list

| Where                     | Change                                                                                                                                        |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `lib/auto-engine.mjs`     | `assessCandidates` takes `held` (ids) and marks those candidates `held-out`                                                                   |
| `lib/auto-route.mjs`      | `autoRoute` computes `heldIds` from `loop.held` + `input.accountHolds` and passes it in                                                       |
| `hooks/native-router.mjs` | drop the `=== 'auto'` gates in `holdFailedModel` and `accountHoldsOf`; pass `accountHolds` to `shadowProposal`; the unknown-capability notice |
| `lib/replay-trace.mjs`    | `traceOperation` records `held`; the reader validates it                                                                                      |
| `lib/replay.mjs`          | replay feeds the recorded holds into the auto proposal                                                                                        |
| docs                      | user guide "When a model fails", configuration, BACKLOG (close the auto half of the failover gap, keep subagent and `--continue`)             |

## Invariants

- A held model is never the target or the kept incumbent, in any mode, pin or keyword turn.
- A held incumbent produces a move this turn (`forced`), or explicit `no-route` when nothing is eligible.
- When the hold ends the model is eligible again and ordinary gates decide; no state was reset for it.
- A shadow proposal never names a held model; replay of a recorded trace reproduces that.
- Account holds are visible to every session and engine (plan windows, spend limits, balances).

## Out of scope

Model holds stay session-scoped and are lost on `--continue`; a resumed agent keeps the model its first spawn
had. Capability presets for shipped non-Anthropic catalogs are config work, sourced separately.

## Subagents (added 2026-11-22, user decision)

Subagent routing is a separate subsystem (its own type table and classifier), so holds enter it as a filter,
not as a selection policy:

- **Spawn:** `decideSpawn` reads `heldIds` (model and account holds) and keeps Claude Code's own model
  (`core`) when the routed model is held. An agent is never sent to a model known to be out, and no second
  stand-in policy is invented — core is already hold-aware through main routing.
- **Failure:** `stepAgent` records the model each agent's last request ran; a `StopFailure` for that agent
  holds it through the same `classifyFailure`. The failure writes no main-turn decision row: that evidence
  belongs to the agent's turn, which the router does not record.
