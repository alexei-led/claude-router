# Fallback chains and quota-aware holds

Status: built on branch `feat-fallback-chains`; steps 1-8 are done, the live check (step 9) and the real-failure check
of step 1 are not. Reviewed in a peer chat (Pi, GPT-6.2 Astra) on 2026-11-18; the TUI choice is
the user's (option C with a read-only chain list, 2026-11-19). Prototype:
https://claude.ai/artifact/XLmDCfDEULG6dexf223P2m (private).

## Why

API failover exists (`lib/failover.mjs`): a model whose turn ended on `rate_limit`, `overloaded`, `server_error` or
`model_not_found` is held for a fixed 5, 5, 2 or 60 minutes, and the next turns run the nearest tier's route. Gaps:

1. The stand-in is chosen by tier distance, not by what the user considers equivalent.
2. `rate_limit` mixes a short throttle, a used-up plan window and an empty balance. A used-up 5h window is retried
   every 5 minutes, and each retry loses a turn.
3. Holds are per model, but a plan quota blocks every model on the plan.
4. Holds live in the session loop, so a new session retries a quota that is still used up.
5. Nothing ends a hold early, and the pane shows a hold only as `! held out`.

## Evidence

The local transcripts (`~/.claude/projects/**/*.jsonl`, entries with `isApiErrorMessage`) give the error shapes.
Counts are from this machine on 2026-11-18.

| `error`        | Transcript fields                                                                                          | Count |
| -------------- | ---------------------------------------------------------------------------------------------------------- | ----: |
| `rate_limit`   | `apiError: "usage_limit_reached"`, `quotaLimits {status: "rejected", rateLimitType: "five_hour", resetsAt}` |    73 |
| `rate_limit`   | the same with `rateLimitType: "seven_day"`                                                                 |    17 |
| `rate_limit`   | the same with `overageDisabledReason: "org_level_disabled_until"`, text "monthly spend limit"               |   ~70 |
| `rate_limit`   | `apiErrorStatus: 429`, no `quotaLimits`, text "[1113] Insufficient balance … recharge" (z.ai)              |     1 |
| `server_error` | DNS, connection refused or lost, 502                                                                       |    72 |

A plugin cannot read these fields directly: `StopFailure` carries `error`, `error_details?` and
`last_assistant_message?`, and `$.fs.read` of the transcript rejects files over 4 MiB. The router already reads the
plan windows (`planLimits`, `lib/costs.mjs`). No `overloaded` and no per-minute provider 429 were found locally.

**Not verified:** what `error_details` holds, and whether a rejected request moves a `rateLimits` reading to 100%.
Step 1 records both before the classifier depends on them.

## Decisions

### Failure kinds

| Kind           | Recognised by                                                                                        | Held                       | Ends                                                         |
| -------------- | ---------------------------------------------------------------------------------------------------- | -------------------------- | ------------------------------------------------------------ |
| `availability` | `overloaded`, `server_error`, `model_not_found`, or `rate_limit` with no quota signal                 | the model                  | fixed time, doubled per consecutive failed retry (cap 60 min) |
| `window`       | `rate_limit`, and a `five_hour` or `seven_day` reading at `percentUsed >= 100` with a future reset    | the account                | the latest such `resetsAt` + 1 min, capped at 7 days          |
| `calendar`     | `rate_limit` with "spend limit" in `error_details` and no window at 100%, on an account with `reset` | the account                | the account's configured reset                               |
| `balance`      | `billing_error`, or a `rate_limit` whose `error_details` match balance, recharge or credit           | the account                | a release                                                    |
| none           | `authentication_failed`, `oauth_org_not_allowed`, `account_on_hold`, `invalid_request`, `unknown`, … | nothing                    | not held: another model would not help                       |

- The classifier tries, in order: (1) the plan readings, (2) `error_details` text, (3) the `error` word. Reset times
  come only from readings or config, never from localized text.
- A `window` hold applies only when the failed model's account is the plan account and every model billed to a plan
  (`billing: "plan"`) is in that one account, whether the session pays only through the plan or also through credits
  (`billingOf` is `plan` or `mixed`). Only the Anthropic plan reports `five_hour` and `seven_day` readings, so with one
  plan account the reading is unambiguous: a used-up window in an Opus-on-plan, GLM-on-credits session holds the plan,
  and the chain moves to the credits model. With plan-billed models in two or more accounts the reading cannot say
  which one it is, so the failure is `availability`.
- A `calendar` failure on an account without `reset` holds for 24 hours, then the next turn tries again.
- Availability backoff: 5 → 10 → 20 → 40 → 60 min for consecutive failed retries of that model with the same error.
  A successful reply from the model clears the streak. A quota hold is never doubled.
- When a hold ends, the model is eligible again. Nothing is resent, probed or forced: the next turn routes as usual.

### Configuration

```json
{
  "fallbacks": {
    "opus": ["glm@max", "deepseek@max"],
    "sonnet": ["glm@high"]
  },
  "models": {
    "glm": { "account": "zai" },
    "kimi": { "requiresOwnHistory": true }
  },
  "accounts": {
    "acme": { "reset": { "monthly": 1, "tz": "UTC" } }
  }
}
```

- `fallbacks`: an ordered, non-recursive list per source model alias. An entry is `alias` or `alias@effort`; the
  effort must be in the target's `efforts`. A bare entry takes `routeEffort` applied to the source's effective
  effort. No per-effort keys.
- `models.*.account`: groups models for quota holds. A model with `billing: "plan"` is in the account `plan` by
  default; any other model is its own account.
- `accounts.*.reset`: `{ "monthly": <1-28>, "tz": <IANA zone> }`, used only by `calendar`.
- `models.*.requiresOwnHistory`: a model that only reads its own thinking history. True for the Kimi preset
  (`docs/providers.md`, Kimi K3). A chain that contains such a model with any other model is a config error.
- An unknown alias, an unsupported effort, a self-reference or a duplicate is a config error, reported like the
  other `validate` errors.

### Routing

- The swap happens in `routeTurn`'s held branch (`lib/route.mjs`), after pin, activity and context-fit resolution
  and before `nearestTiers`. Targets are routes, not tier cells, and need not appear in any tier.
- A target is skipped when it is not allowed (`availableModels`), held (model or account), excluded this turn
  (`loop.ineligible`), cannot take the turn's images, or does not fit the context. A smaller window is not allowed
  while the context is unmeasured.
- The decision keeps the intended route (the cell's) apart from the sent route (the stand-in). The stand-in serves
  the turn and its continuations but never becomes `loop.route`, so it does not stick after the hold ends.
- A pin keeps its tier; the stand-in runs it. Reason `model-held` stays; the decision records the chain step.
- When every target is skipped, today's nearest-tier rule applies. That rule, and the return after a hold, also
  obey `requiresOwnHistory`: no switch into or out of such a model from another model.
- Subagents are not routed through chains. The `auto` engine gets no chains (it holds nothing today).

### Holds

- A hold: `{ kind, error, since, until | null, streak }`. `until: null` means held until released.
- Model holds (`availability`) stay in the session loop, as today.
- Account holds (`window`, `calendar`, `balance`) are written to `$.store` under `holds/<account>`, so every session
  sees them and a restart keeps them. The hook reads them at turn start; `lib/` receives them as data.
- `holdFailedModel` holds the model that last ran, which can now be a stand-in. If the stand-in fails, it, not the
  source model, gets the hold.

### Pane, band and commands (option C + read-only chains)

- **Now**, a `HELD OUT` section shown only while something is held: one row per held account or model with its kind,
  when it ends (`5h limit · back 19:00`, `no balance · until released`, `overloaded ×2 · back 14:32`), the models it
  covers, and **Release** with Undo. A footer names `router.json → fallbacks` and `/router holds`.
- **Now**, **why**: `↷ Opus 5.5 held · fallback 1 of 2`.
- **Band and toast** name the kind and the end: `Claude plan 5h limit · back 19:00 → GLM-5.3 · max`.
- **Routes**, a read-only `FALLBACKS` section under the grid: one row per model with a chain, its targets in order,
  held targets marked `✕`, the running one `◀ runs`, and the model's status. A held cell in the grid gets `↷`. No
  chain editor.
- **`/router holds`** lists holds with kind, scope, end and cause. **`/router release <model|account>`** ends one.
  Release from the pane applies on click with Undo.

## Not in scope

- Resending the failed request, or probing a held model.
- Fallback inside the proxy (claude-proxy D6/D7 stand).
- Models outside the Anthropic protocol (an OpenAI model such as GPT-6.2 Sol).
- Holding a provider's other models after a provider-level outage; each fails once.
- A chain editor in the pane, and a Health tab. Add the editor if chains change often.

## Steps

Each step lands with its tests; the gate after each is `npm run check`, `npm run typecheck`, `npm test` and
`npm run test:plugin`.

1. **Record failure payloads.** On `StopFailure`, add to the decision trace: `error`, `error_details` (first 300
   characters), the `rateLimits` readings at that moment, and the model held. Keep it in the local trace only.
   Check against one real failure of each kind available before step 2 relies on `error_details` or a 100% reading.
2. **Classifier** in `lib/failover.mjs`: `classifyFailure({ error, details, limits, billing, planAccounts, account, accounts, now })`
   → `{ kind, scope: 'model' | 'account', until }`. Table test with the transcript shapes above, including the z.ai
   balance 429 and a mixed-billing session.
3. **Config**: `fallbacks`, `account`, `requiresOwnHistory`, `accounts`, defaults, and `validate` errors. Kimi preset
   gets `requiresOwnHistory: true`. Tests for each error and for the default accounts.
4. **Holds**: hold shape, backoff, streak clearing on a successful reply, account holds in `$.store`, release.
   Regression: a stand-in that fails gets the hold.
5. **Routing**: chain walk in `routeTurn`, intended vs sent route, history rule in nearest-tier and return. Acceptance
   tests: a stand-in in no tier serves the turn and its continuation; after the hold ends routing returns to the
   source model; an account hold skips every plan model in a chain; a chain exhausted falls back to nearest tier.
6. **Commands**: `holds` and `release` in `SUBCOMMANDS` and the hook.
7. **Pane**: Now `HELD OUT` and **why**, band and toast text, Routes `FALLBACKS` and `↷`. Models in
   `lib/ui/model/`, renderers in `terminal/` and `graphical/`, colours from `lib/ui/tokens.mjs`. Update goldens with
   `UPDATE_GOLDEN=1` and read the diff.
8. **Docs**: `docs/user-guide.md` (When a model fails), `docs/configuration.md` (the four keys), `docs/providers.md`
   (Kimi and history), a `CHANGELOG.md` line under `## Unreleased`.
9. **Live check** in agterm with an isolated config: a chain run after a forced `model_not_found` (a bad model id),
   Release from the pane, and a new session that sees an account hold. Record what could not be forced (a real 5h
   limit, `overloaded`).

## Open questions

- Answered: `$.store` writes from two sessions are not versioned. The store has no atomic update, so two sessions that
  fail together can each write their own hold; the later write stands, and both say the same account is out. The user
  guide says so (`docs/user-guide.md`, When a model fails) and `applyHold` in `hooks/native-router.mjs` notes it.
- Answered: the `calendar` text match stays, and every path also works without `error_details`. `calendar` then needs
  a configured account `reset`, or it holds for 24 hours.

## Not verified

- Step 1's gate: what `error_details` holds, and whether a rejected request moves a `rateLimits` reading to 100%, were
  not checked against a real failure. The `window`, `calendar` and `balance` rules rely on both. Tests use the shapes
  in the local transcripts. The `failure` row in the decision trace records both, so the first real failure checks
  them.
- Step 9: the three live checks in agterm (a chain run after a forced `model_not_found`, Release from the pane, a new
  session that sees an account hold) were not run. A real 5h limit, an `overloaded` and a chain on a provider that
  reads another model's thinking history could not be forced.
