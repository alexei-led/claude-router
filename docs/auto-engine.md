# Pure automatic routing engine

`lib/auto-engine.mjs` implements the [automatic routing design](plans/2026-11-16-auto-routing-design.md).
It has no I/O. Opt-in `routingEngine: "auto"` uses the stateful adapter `lib/auto-route.mjs` in the main-turn hook; the default table engine is unchanged. Shadow remains a one-step proposal and offline replay has its own state. Evaluation and default cutover remain pending.

## Inputs

All functions take one object. Pass the original validated config, including its catalog, cache settings and
base `policy`. Do not pass `applyMode(config, mode)`: per-mode policy patches belong to the table engine only.
The automatic mode changes only the capability requirement.

A route is `{ model: alias, effort: string | number | null }`. Generated candidates use only supported strings,
or `null` for a model with `efforts: []`. A real native incumbent with an unresolved null or finite numeric effort
is valid but has unknown capability. An unsupported explicit string is not silently clamped.
Capability comes only from `models[alias].capability[effort]`, or `capability.default` on a no-effort model.
No declaration means unknown, not zero. Anthropic includes user-derived balanced base-route policy seeds, not
measured quality; all other pairs remain unknown. Users can replace them as described in
[Providers](providers.md#capability-evidence).

The facts object uses the existing controller shapes:

- `contextTokens`, `historyMeasured`, `hasImages`;
- `models`: cache key → `{ prefixTokens, lastAt, ... }`;
- `effort`: native session effort, and `lastRequest: { tokens, outputTokens, ... }`;
- `ineligible`: model IDs excluded for this history;
- `dwellAllowed`: a separate boolean for physical downgrades, required even on a new task. Set it to
  `requests - switchedAt.requests >= config.policy.minDwellRequests`, using the actual route's last switch and
  request counter. At session start, before any request/switch exists, set it to true. Missing means false.
- `downAllowed`: the existing combined dwell/checkpoint fact, required in addition to `dwellAllowed` only on the
  same task; `midTurn`, `progress` and advice continuation identify that task. Off the same task no checkpoint
  is required. Upgrades, forced refits, escalation and explicit stronger mode/catalog moves bypass dwell.
- `failure: { signature, index }` or null. The same signature at a new index is a new occurrence.
  Re-reading the same occurrence does not escalate again. History reset must reset engine state.

Advice uses the existing `{ choice, probabilities, continuation, ... }` classifier shape, or null.
`now` is the caller's timestamp in milliseconds. `availableModels` and `nativeModel` use the existing
`isModelAllowed` semantics. Pass the active provider's cache configuration, including effort-cache separation.
If the host has resolved a configured model ID to a response ID, project those IDs into the supplied catalog
before assessing cache state, as the table controller's economic config does.

## Demand, target and move

| Export             | Input                                                                                                                  | Output                                                                    |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `initialAutoState` | `{ demand = 2, routedDemand = demand, cause = 'classifier' }`                                                          | Initial state                                                             |
| `advanceDemand`    | `{ config, state, advice = null, facts, pin = null, boundedExecute = false }`                                          | `{ raw, level, reason, headroom, escalated, state }`                      |
| `assessCandidates` | `{ config, facts, now, incumbent, contextKnown = Number.isFinite(facts.contextTokens), availableModels, nativeModel }` | Candidate facts array                                                     |
| `selectTarget`     | `{ candidates, demand, mode = 'balanced', headroom = false, escalation = false }`                                      | `{ outcome, route, capability, requirement, estimate, reason, headroom }` |
| `decideMove`       | `{ config, state, demandResult, target, candidates, advice = null, facts, now, changeCause = null }`                   | `{ move, route, reason, evidence, estimate, state }`                      |
| `proposeAutoRoute` | Combined inputs above, using `incumbent` and optional `state`                                                          | `{ demand, candidates, target, move, state }`                             |

The facade initializes missing state from `config.baselineTier`. The lower-level helpers require explicit state.
State includes integer `demand`, `turn`, `votes`, `holdUntilTurn`, `escalatedSignature`, `escalatedIndex`,
`headroom`, `demandCause`, `routedDemand` and `routeCause`.
`raw` is integer demand; `level` is effective demand after the noncumulative half-step bounded-execute discount.
The caller supplies `boundedExecute: true` only for an already accepted bounded execute/ops phase, never
for a goal label alone or verify/report phases. An escalation hold protects the raised demand.

Each candidate has `route`, `requestKey` (canonical physical identity), `capability` (number or null), `eligible`, `reasons`, `incumbent`, `selectable`,
`cache`, `coldWriteUsd` and `estimate`. The incumbent is assessed even if it left the catalog.
A native unresolved effort is included in normal target comparison so it wins equal estimates, but cannot be
nominated as a new non-incumbent route. Declared-below-demand candidates still precede an unknown incumbent.
On a no-effort model, numeric native effort and the generated null-effort candidate have the same request key.

All availability, context, image, effort and cold-write cash constraints run before fallback.
An invalid incumbent and no eligible candidate produce explicit `no-route`, never an invented native route.
Target outcomes are `meets-demand`, `declared-below-demand`, `unknown-only`, `incumbent` and `no-route`.

Estimates are absolute next-turn `{ minUsd, maxUsd }` ranges: `cost.inputBounds` plus the last reply's output
length at `cost.ratesAt` prices. This estimate is effort-blind; it does not model additional thinking tokens.
Selection uses the conservative `maxUsd` bound, then the incumbent, lower sufficient declared capability and
config order. The mode margin supplies headroom through the requirement, not a tie preference. Automatic prefix
caches have no assumed TTL or warm-cache exemption.
Switch gates use the existing route-to-route `switchingTaxUsd` and `downgradeTaxUsd` math.
These are conditional estimates, not expected costs or measured savings.

## State ownership

Shadow needs only `advanceDemand → assessCandidates → selectTarget`. Retain the returned demand state and
always assess the real incumbent/cache; do not retain a hypothetical target as route history.
Pass `escalation: demand.escalated` and `headroom: demand.headroom` to `selectTarget`. After either escalation or
pending-headroom selection, copy `target.headroom` back to the returned demand state's `headroom` field.
It is true only on exhausted escalation, permitting retry if a stronger candidate becomes eligible.
Target reasons are null, `escalation`, `escalation-unknown` (unknown capability) and `escalation-exhausted`.
A declared stronger eligible request precedes unknown alternatives; neither search can return the same physical
request via another alias. The facade performs this headroom feedback automatically.

Stateful replay/auto compares effective demand with `state.routedDemand`, not the previous turn's demand.
Update routed demand and cause only when the proposed physical move actually executes; the facade returns that
prospective state in `result.state` and `result.move.state`. Its pre-move demand state remains in
`result.demand.state`. A held proposal leaves routed demand and cause unchanged, so it remains pending.
`changeCause` is null, `mode` or `catalog`; it cannot relabel a demand change as an explicit configuration move.
The live adapter and replay fingerprint the actual allowed configured aliases, including native `default` resolution.
An allowlist expansion is catalog evidence; reordering it, cache warmth and routine response-ID resolution are not.

Tier pins accept a tier string or integer 0..3. They are one-turn overrides: no mode margin and no move gates,
but normal candidate constraints, outcome precedence and incumbent ties. The facade returns the pinned route
with `move: false`, reason `pinned` and unchanged state. The caller resumes the pre-pin incumbent and state on
the next unpinned turn. With the lower-level API, pass `mode: 'balanced'` to `selectTarget` for a pinned demand.
Exact model/effort pins remain the controller's separate responsibility.

An observed native fallback records `incumbentOrigin: 'external-fallback'` and rebases the physical incumbent without
resetting demand, votes, hold or routed demand. Substituted effort remains unknown. The current turn stays native;
on the next turn, `decideMove` takes `incumbentOrigin` and permits `reentry` to a different eligible target without
mass, dwell or payback gates. Hard constraints and the cash cap still apply. Re-entry sets routed demand and cause
`reentry`, retaining the escalation hold; an equal target clears origin. Pinned fallbacks retain normal state and
apply the physical fallback provenance after restoring the pin. Replay counts external requests separately.

## Checks

Run `node --test test/auto-engine.test.mjs` for the design's §5.4 invariants and §3.3 move-evidence cases.
The tests also cover failure occurrence deduplication, raw/effective demand, pins, native efforts, cache semantics,
range/cash/context boundaries and a capability-monotonicity matrix across sparse catalogs and differing prices.
No paid API calls or classifier calls are needed.
