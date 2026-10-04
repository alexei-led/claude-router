# Architecture

Claude Code owns the model request. The router Mod asks Jev for tier advice, applies local routing policy, and changes only the next main-conversation step's model and effort. Every subagent step passes through with Claude's model selection unchanged.

## Request flow

```mermaid
sequenceDiagram
    autonumber
    actor Dev as Developer
    participant Code as Claude Code
    participant Mod as Router Mod
    participant Jev
    participant API as Anthropic
    Dev->>Code: Prompt
    Code->>Mod: turn.start and turn.step
    alt Main conversation, Auto
        Mod->>Jev: Current prompt and bounded dialogue
        Jev-->>Mod: Tier advice
        Note over Mod: Apply votes, context fit, cache costs and failure rules
        Mod-->>Code: Forward model and effort
    else Manual, subagent, or unavailable
        Mod-->>Code: Forward model and effort unchanged
    end
    Code->>API: Native authenticated request
    API-->>Code: Response stream and usage
    Code-->>Mod: Main step result
    Mod-->>Dev: Status band and details pane
```

The Mod does not construct an Anthropic request or proxy its response. Claude Code owns authentication, request fields, streaming, tools, model fallback, and its native usage ledger. No local gateway process or port is part of the runtime.

Jev receives only the current prompt and up to six recent user or assistant text messages. Each text is capped at 1,200 characters. System messages, tool inputs, and tool results are not included. The Jev key is a sensitive plugin option. The Mod does not receive Claude's Anthropic credentials.

Direct Claude Code 2.1.289 probes accepted signed-thinking history and tool results across Sonnet, Opus, and Haiku switches. Sonnet and Opus accepted histories above 589K input tokens. Deferred MCP tools worked on rewritten Haiku with a 128K output limit. These checks cover tested requests. They do not prove every Claude Code feature combination.

## Responsibilities

| Component                                     | Responsibility                                                                   |
| --------------------------------------------- | -------------------------------------------------------------------------------- |
| [Native hooks](../hooks/native-router.mjs)    | Turn identity, controls, lifecycle, per-step rewrites, and response observation. |
| [Jev contract](../lib/jev-contract.mjs)       | Bounded request payload, answer validation, and retry rules.                     |
| [Native Jev](../lib/native-jev.mjs)           | Native HTTP, deadline, in-flight admission, and circuit breaker.                 |
| [Router controller](../lib/native-router.mjs) | Context fit, model identity, cache observations, and one-turn pins.              |
| [Policy](../lib/policy.mjs)                   | Tier votes, escalation, and switching gates.                                     |
| [Native costs](../lib/native-cost.mjs)        | Cache uncertainty bounds and switching estimates.                                |
| [Native panel](../lib/native-panel.mjs)       | Route status, usage metrics, controls, and validated tuning.                     |
| Claude Code                                   | API requests, tools, authentication, stream output, and usage ledger.            |

Node.js is not part of routing. It is used for development and the optional v0.8 configuration migration.

## Decision and context

One logical turn gets one Jev classification. Tool continuations reuse the decision and add no votes. Before each step, the controller checks whether the selected model still fits after new tool output.

A move to a smaller context window needs a main-response measurement from the current history and Claude's local context estimate. The router uses the larger available reading and reserves 20% of the model window. If it cannot establish fit, it keeps the current model with `context-unknown`. It does not infer token count from character count.

An explicit context-window failure marks that model ineligible until the next history reset. An engine fallback suspends rewriting for the rest of the turn. The router does not retry an Anthropic request.

## State and controls

`$.state` stores route decisions, response observations, and UI state for the active session. Version-checked writes reject stale turn results. A private in-memory view merges state writes during one dispatch because state reads are frozen for that dispatch.

Clear, branch, rewind, and committed compaction clear cache evidence and votes. A fresh session on the configured baseline starts in Auto. A fresh session on another model starts in Manual. Resume restores the selected session's saved mode. Hot reload retains valid `$.state`. Running `/model` enters Manual, including an explicit choice of the baseline. `/router auto` resumes routing. `/router off` also enters Manual. Pins apply to the next turn and its tool continuations. The prior Auto route resumes afterward.

Subagent events pass directly to Claude Code. They do not create Jev requests or change main-conversation metrics. This is the selected scope because Mods do not expose whether a subagent model was explicit or inherited.

## Jev deadline and failure handling

Each advice attempt has a default 1,500 ms total deadline, including any transient retry. A timeout does not retry. `Retry-After` is honored only when it fits the remaining budget. Three launched failures pause Jev for 60 seconds. Missing-key, busy, and paused skips do not count as failures.

The pinned host API does not expose a per-request abort option for `$.http.fetch`. The Mod returns to the incumbent at its own deadline and blocks another advice request while that wire call remains pending. Claude Code's observed host timeout is about 30 seconds. Recorded reload and unload checks closed pending sockets after 24.7 and 28.5 seconds. Replacement closed one after 31.6 seconds. These runs do not show immediate per-call cancellation. A plugin network-policy refusal degrades routing and is never bypassed with a subprocess.

In a 20-process loopback test, timeout fallback had 1,504 ms p95 and 1,505 ms worst case. A 20-call burst made one wire request. The other 19 calls skipped as busy. The live Team canary reached Jev and received advice. See the [native acceptance records](../experiments/mod-router/results/native-http-acceptance.json) and [interruption record](../experiments/mod-router/results/native-interrupt-acceptance.json).

## Cache and cost

Cache identity uses the exact response model ID and effective effort. The known Haiku dated snapshot has an explicit mapping. An unrecognized substituted model gets no cache credit for the requested route.

The cached prefix is observed `cache_read + cache_creation`. Output tokens count only toward the next context size. Freshness uses the configured five-minute lifetime with its safety margin. Claude's usage counters do not prove one-hour cache lifetime.

The switching policy prices the candidate at a conservative cache-write bound and the incumbent at its best supported input bound. The pane shows the configured-price range and a conditional payback estimate. These are estimates, not measured savings. Claude's native `/cost` ledger owns total API cost. Jev spend is not included.

## Deployment

Load the plugin directory with Claude Code's `--plugin-dir` option. The Team launcher uses an isolated `~/.claude-team/mods/router` directory, so updating the Mod does not replace another profile's plugin cache. The Team canary passed with the native plugin, a full Sonnet baseline, and a real Jev classification.

The v0.8.0 git version remains available as the rollback source. Native routing does not require the proxy. Use the [configuration guide](configuration.md) for optional settings and migration, and the [native guide](native-router.md) for panel and control behavior.
