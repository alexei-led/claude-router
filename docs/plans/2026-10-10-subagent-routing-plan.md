# Subagent routing

Version 0.1 · 2026-10-10 · Implemented behind `subagentRouting`, default `shadow`. A live `on` run is recorded in
`experiments/mod-router/results/subagent-routing-live.json`; turning `on` by default waits for the shadow data (§7).

## 0. Changes in v0.2

| Area | v0.1 | v0.2 | Why |
| --- | --- | --- | --- |
| Default | `shadow` | `on` | The maintainer chose to route subagents as the main conversation is routed |
| Which agents | built-ins listed in `types`; plugin agents only when listed | every agent whose definition names no model, says `inherit`, or sets `modelRouting: auto`; built-ins as before | A Mod can read the definition: `provider.plugin` is `plugin@marketplace`, the key of `installed_plugins.json`, whose `installPath` holds `agents/*.md` (probe D, 2026-10-10). §4.1's "plugin install path is not reachable" was wrong |
| Pinned agents | never routed | routed when they set `modelRouting: auto`; their `model` stays the no-router fallback | Claude Code ignores unknown frontmatter keys; cc-thingz 6.20.3 sets it on runner, engineer and reviewer |
| Pass reasons | `unlisted` | adds `pinned` and `unknown` (definition not found or not readable) | The Usage tab shows why an agent kept its model |
| Shadow timing | waits for the classifier | spawns first; replies before the decision are buffered | Shadow must not delay agents |

The router picks a model for each main-conversation turn. Subagents pass through unchanged
(`hooks/native-router.mjs`, `if (e.agentId) return yield* next(e)` in `turn.step`). This plan adds one model choice per
subagent, made once at `agent.spawn`, before the subagent's cache exists.

## 1. Why

Last 7 days of the maintainer's transcripts (`~/.claude`, `~/.claude-team`), at API list prices: $3.4k in total, of
which subagents were $1.53k (45%) and subagents on Opus 5.5 were $1.14k (34%). Most of that Opus use was inherited: the
agent named no model. `experiments/mod-router/results/workflow-subagent-models.json` shows the same for workflows: 22
of 24 workflow subagents ran on Opus 5.5. Subagent caching is not the problem: 98.5% of subagent calls come less than 5
minutes after the previous one, with a 95–98% hit rate.

`CLAUDE_CODE_SUBAGENT_MODEL=sonnet` already moves inherited agents to Sonnet. This plan adds a choice per task: Haiku
for exploration, Opus only for clearly hard tasks, and a model for Explore and Plan, which ignore that variable.

## 2. Verified facts

Sources: the build types for Claude Code 2.1.296 (`claude-code.d.ts`, written by the plugin-authoring skill; cited by
type name), and three observed runs of a probe Mod, `experiments/mod-router/spawn-probe`, recorded in
`experiments/mod-router/results/agent-spawn-probe.json` (rows A1–A7, B1–B5, C1–C4).

| Question                               | Answer                                                                                                                                                                                                                                                                                                      | Evidence                                                                                                                                                                                                                   |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Which `agent.spawn` fields exist       | `tool_use_id`, `prompt`, `description`, `subagentType`, `provider`, `model?`, `parentModel`, `parentAgentId?`, `permissionMode?`, `background`, `fork`, `isTeammate?`, `workflow?: { runId, agentIndex }`, `name?`, `cwd?`. The result is `{ model, agentId?, teammateId? }` or `{ deny }`. No effort field | `AgentSpawnInput`, `AgentSpawnResult`. Rows show every field but `isTeammate`, `parentAgentId`, `name` and `cwd`, which these runs did not exercise                                                                        |
| Does `e.model` show an explicit choice | Yes: the Agent tool's `model` parameter (A5, A6) and a workflow `agent({ model })` (C2). Frontmatter never shows (A2)                                                                                                                                                                                       | probe                                                                                                                                                                                                                      |
| Frontmatter precedence                 | The hook's model **beats** frontmatter: `pinned` (`model: sonnet`) ran on Opus when the hook set opus (A3). The hook also beats `CLAUDE_CODE_SUBAGENT_MODEL` (B2). Frontmatter beats the variable (B3). Explore ignores the variable (B4), but the hook moves it (B5)                                       | probe; code.claude.com/docs/en/sub-agents#choose-a-model: "If an installed mod sets a model in its agent.spawn hook, Claude Code uses that model in place of the per-invocation parameter", which comes first in the order |
| Do workflow agents fire the hook       | Yes, with `workflow` set (C1–C4). A model rewrite is **ignored**: C3 asked for Opus and ran on the main model                                                                                                                                                                                               | probe; `AgentSpawnInput.workflow`: "A hook can only refuse it"                                                                                                                                                             |
| Hook time budget                       | 10 s of the hook's own time per dispatch, 1 s for `.catch`. The clock stops during `next` and `$` calls, but a `$.clock.sleep` counts                                                                                                                                                                       | `HookBudget` (`ms: 10_000`, `catchMs: 1_000`); `next.budget.ms` read 10000 in every probe row                                                                                                                              |
| What `next(e)` answers                 | The full model id the agent ran on, equal to its first `turn.step` model in every row                                                                                                                                                                                                                       | probe                                                                                                                                                                                                                      |
| Alias resolution                       | A family alias (`opus`) resolves to the parent's exact model when the families match, `[1m]` included                                                                                                                                                                                                       | sub-agents#choose-a-model                                                                                                                                                                                                  |

Consequences:

- **Pins.** Because the hook beats frontmatter, routing an agent type that pins `model:` would override the pin. The
  input does not carry frontmatter, and no `$` call lists agent definitions. Section 4.1 chooses an allowlist.
- **Workflows.** Workflow agents cannot be routed. They pass through, and still get only the
  `CLAUDE_CODE_SUBAGENT_MODEL` default. That covers the 22 of 24 Opus workflow agents above: this plan routes
  Agent-tool spawns only.
- **Effort.** A spawn sets a model, never an effort.
- **Delay.** In `on`, a classifier call delays the subagent's start by up to its deadline, and the client's deadline
  race uses `$.clock.sleep`, which counts against the budget. The spawn path caps the deadline at 3 s. `shadow` spawns
  first and decides after, so it never delays an agent; replies that arrive before the decision are buffered and
  counted once it lands.
- **Version.** `agent.spawn` and a `.catch` on `on()` are in the 2.1.293 and 2.1.296 build types and ran live on
  2.1.296. On 2.1.289, the router's minimum, they are unverified: the registration sits in a `try`, which covers `on()`
  throwing, not an engine that refuses the module at load.

## 3. Configuration

```json
{
  "subagentRouting": "shadow",
  "subagents": {
    "types": {
      "Explore": "haiku",
      "Plan": "classify",
      "general-purpose": "classify"
    },
    "light": "haiku",
    "standard": "sonnet",
    "heavy": "opus",
    "heavyMass": 0.8
  }
}
```

- `subagentRouting`: `off` asks nothing and records nothing. `shadow` decides and records, but the agent runs on core's
  model. `on` applies the decision.
- `types`: the agent types the router may route, each mapped to a model alias (the cheap path, no classifier) or
  `classify`. A user file adds to these; `null` removes one.
- `light`, `standard`, `heavy`: the aliases `classify` chooses from.
- `heavyMass`: the classifier's `high` probability needed for `heavy`.

## 4. Decision at spawn

### 4.1 Pass-through first

In order, the router passes the spawn through unchanged and records the reason when:

1. `fork`: a fork reads the parent's cache and must stay on the parent's model.
2. `workflow`: `e.workflow`, since a rewrite is ignored. Before `explicit`: a workflow `agent({ model })` has `e.model`
   set (C2).
3. `explicit`: `e.model` is set by the Agent call.
4. `teammate`: `e.isTeammate`.
5. `unlisted`: `subagentType` is not in `types`, or is listed as `null`.

**Pin rule.** A `types` key without a colon (`Explore`, `Plan`, `general-purpose`) matches only a built-in, that is
`provider.plugin === 'engine'`. A user or project agent of the same name replaces the built-in and may pin a model, so
it passes. A key with a colon (`dev-flow:reviewer`) matches that plugin agent exactly. The defaults list only
built-ins, which name no model (A4, A7 ran on the parent's model). **Limit:** the router cannot read frontmatter, so it
routes a listed plugin agent even if that plugin later adds `model:`. List only plugin agents you have checked. User
and project agents are never routed: you own those files, so set `model:` there. Rejected options: reading agent files
(the plugin install path is not reachable from a Mod), and `*:name` patterns (they would match an unknown plugin's
pinned agent).

### 4.2 Choosing the model

- A type mapped to an alias runs on it.
- A `classify` type asks the active classifier with `clip(description + "\n" + prompt, context.maxTextChars)` and no
  turns: only the task text the parent wrote, never tool results or history. Then:
  - `P(high) ≥ heavyMass` → `heavy`;
  - else an `explore` activity above `policy.activityMass`, or tier `micro` → `light`;
  - else `standard`, including an `uncertain` tier.
- A classifier failure, timeout, pause or missing key keeps core's model (`classifier-failed`).
- The router sends the configured full id (`claude-haiku-5-5`), not an alias, so the family-alias rule cannot change
  it. A model that `availableModels` blocks keeps core's model, counted as the choice `core`.
- Spawn calls use their own classifier client per classifier, with its own breaker, and they may run concurrently: a
  parent that spawns five agents in one message gets five answers. Spawn failures never pause main-turn routing.
- The deadline is the classifier's `timeoutMs`, capped at 3 s. Only `on` waits for it before the spawn.
- The hook has a `.catch` that runs `next(e)`, so any failure is a pass-through. Recording runs after `next`, inside
  `try`.

`turn.step` keeps passing subagent steps through unchanged: a model switch inside a subagent rewrites its 50–300k
context cold on the 5m TTL.

## 5. Recording and the Usage tab

Every spawn while the mode is `shadow` or `on` gets a record keyed by `agentId`. Its replies add up in `turn.step`, and
its `turn.complete` adds the record to the totals. The totals are kept in the view and, per session, in `$.store` under
`subagents:v1:<session id>`, in the same way as the savings records. **Reset stats** clears them.

- Per routed type and mode: agents, agents whose choice differs from core's, requests, the choices by alias, classifier
  failures, respawns, `routedUsd` and `coreUsd`.
  - `shadow`: `coreUsd` is the agent's actual tokens on the model it ran on. `routedUsd` is the same tokens on the
    would-be model.
  - `on`: `routedUsd` is actual. `coreUsd` is the same tokens on core's model as the router estimates it:
    `CLAUDE_CODE_SUBAGENT_MODEL` for types other than Explore and Plan, else `parentModel`.
  - A subagent starts cold on one model, so pricing its own token counts on another model is a fair counterfactual.
    Long-context rates apply per request (`ratesAt`: Haiku 5.5 at 5× above 100k). Cache writes are priced at the
    subagent TTL: `FORCE_PROMPT_CACHING_5M`, then `CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL`, then
    `subagentPromptCacheTtl`, then `ENABLE_PROMPT_CACHING_1H`, else 5m even on a subscription. Frontmatter
    `experimental.cacheTtl` is not visible and is not counted.
- Per pass-through reason: agents, requests and their cost on the model they ran on. This shows how much subagent spend
  is routable at all.
- Retries and escalations cannot be seen in `shadow`, because the would-be model never ran. Two proxies are recorded
  in both modes, so an `on` period compares against the shadow baseline:
  - requests per agent, by type;
  - respawns: a spawn of the same type by the same parent loop within 10 minutes after one of that type finished.

The Usage tab gets a SUBAGENTS section, read across sessions: one row per type with agents, differs, requests per
agent, respawns and `core → routed` cost, then the pass-through line.

## 6. Effort in the cache key

`lib/cost.mjs` `cacheKey(modelId, effort)` gave each effort its own cache, so the policy priced an effort-only move
(opus/medium → opus/high) as a cold write. Per code.claude.com/docs/en/prompt-caching ("Changing effort level"),
Opus 5.5, Sonnet 5.5, Haiku 5.5 and Fable 5.1 keep the cache across efforts with an API key or a subscription. The key
now drops effort for those models. It keeps effort when the session runs on Bedrock (`CLAUDE_CODE_USE_BEDROCK`), Google
Cloud (`CLAUDE_CODE_USE_VERTEX`), Foundry (`CLAUDE_CODE_USE_FOUNDRY`, not listed as keeping the cache), a custom
`ANTHROPIC_BASE_URL` (it may be a Claude apps gateway), or `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS`. A HIPAA
configuration cannot be seen from a Mod. **Limit:** such a session prices effort moves as free. The same rule applies
to Routing vs your model (`compareReply`), which otherwise counts an effort-only difference as off your cache.

## 7. Rollout

1. Ship with `shadow` as the default. Nothing changes the model an agent runs on.
2. Read the SUBAGENTS section after a week of normal use. Turn `on` when, for the routed types:
   - `routedUsd` is below `coreUsd` by a margin worth the risk;
   - the `light` and `heavy` choices match what the tasks were;
   - the pass-through line shows the routable share is large enough to matter.
3. Run `on` for a week. Keep it when requests per agent and respawns per type are no higher than the shadow baseline.
   Otherwise go back to `shadow` and tune `types` or `heavyMass`.

Rollback: `"subagentRouting": "off"` in router.json, or remove the key to return to the default.

## 8. Tests

- `lib/subagents.mjs`, table-driven: each pass reason; the pin rule (an `Explore` from `project` passes, from `engine`
  routes); an alias type; `classify` → heavy, light, standard; no advice → null; a blocked model.
- Hook: fork → pass; explicit `model` → pass; a pinned frontmatter type → pass; a classifier failure → core's model;
  `shadow` → no change but the decision is recorded; `on` → the routed model; the recorded totals after the agent's
  replies and `turn.complete`.
- Cost: the effort key for 5.5 models with and without a provider exception; compareReply with an effort-only move.
- Config: defaults, the `null` removal, and validation errors for each new key.
