# Architecture

Claude Code owns the model request. The router Mod asks the active classifier (Jev by default; Cloudflare's Clef or Clef Flash; OpenAI; or a local Ollama model) for tier advice, applies local routing policy, and changes only the next main-conversation step's model and effort. Every subagent step passes through with Claude's model selection unchanged.

## Request flow

```mermaid
sequenceDiagram
    autonumber
    actor Dev as Developer
    participant Code as Claude Code
    participant Mod as Router Mod
    participant Cls as Classifier
    participant API as Anthropic
    Dev->>Code: Prompt
    Code->>Mod: turn.start and turn.step
    alt Main conversation, Auto
        Mod->>Cls: Current prompt and bounded dialogue
        Cls-->>Mod: Tier advice
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

The Mod does not construct an Anthropic request or proxy its response. Claude Code owns authentication, request fields, streaming, tools, model fallback, and its native usage ledger. No local gateway process or port is part of the runtime. The Ollama classifier calls an Ollama server that you run; the Mod starts none.

The active classifier receives only the current prompt and up to six recent user or assistant text messages. Each text is capped at 1,200 characters. System messages, tool inputs, and tool results are not included. Only the active classifier is asked: Jev sends that text to typesafe.ai, Clef and Clef Flash to Cloudflare Workers AI, OpenAI to api.openai.com. Ollama runs on this machine, so the text stays here. The Jev, Cloudflare, and OpenAI keys are sensitive plugin options; the Cloudflare account ID is a plain one that fills the endpoint. Ollama takes no key. The Mod does not receive Claude's Anthropic credentials.

Each classifier names its wire protocol, `api`, and `classifier-apis.mjs` holds one adapter per protocol. `system-one` (Jev, Clef, Clef Flash) sends the typed `state` and `questions` request and reads `answers.route`; Cloudflare's REST API wraps that answer in `{ result, success, errors }`, which the parser unwraps. `openai-decisions` (OpenAI) sends the state as `input` text and reads a `choice` answer plus a `predicate` for the continuation. `ollama` asks for one letter with thinking off and reads the log-probability of each letter from the top 20 candidates. A letter's probability is its share of the letters found there; a letter missing from the list counts as zero. The Ollama adapter asks no continuation question, so `continuation` is null there. Every adapter returns the same advice shape, so the routing policy is unchanged.

Claude Code builds each request for the model the Mod selects, so no request rewriting is needed: Haiku 4.5 got its own thinking mode and a 32K output cap. On Claude Code 2.1.289, a billed chain of pinned turns (Opus, Haiku 4.5, Sonnet at `xhigh`, Sonnet, Haiku 4.5) used a tool on every turn over the previous models' history, and no request was rejected. Sonnet and Opus accepted histories above 589K input tokens. These checks cover tested requests. They do not prove every Claude Code feature combination.

## Responsibilities

| Component                                             | Responsibility                                                                                                  |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| [Native hooks](../hooks/native-router.mjs)            | Turn identity, controls, lifecycle, per-step rewrites, response observation, pane actions, and every host call. |
| [Classifier contract](../lib/classifier-contract.mjs) | Route criteria and instructions shared by every protocol, credentials and endpoint filling, and retry rules.    |
| [Classifier APIs](../lib/classifier-apis.mjs)         | One adapter per wire protocol: request payload, answer validation, and the shared advice shape.                 |
| [Classifier client](../lib/classifier-client.mjs)     | Classifier HTTP, deadline, in-flight admission, and circuit breaker.                                            |
| [Router controller](../lib/route.mjs)                 | Context fit, model identity, engine fallback, cache observations, and one-turn pins.                            |
| [Policy](../lib/policy.mjs)                           | Tier votes, escalation, and switching gates.                                                                    |
| [Costs](../lib/cost.mjs)                              | Cache uncertainty bounds and switching estimates.                                                               |
| [Router view](../lib/view.mjs)                        | The view's initial shape and the usage readings each reply adds to it.                                          |
| [Config file](../lib/config-file.mjs)                 | Pane writes to `router.json`: the validated rewrite and what Undo restores.                                     |
| [Panel](../lib/panel.mjs)                             | Tabbed pane: route status, tier pins, the route editor, tuning, and usage.                                      |
| [Router band](../lib/band.mjs)                        | Status band segments fitted to the band's width, and route-change toasts.                                       |
| Claude Code                                           | API requests, tools, authentication, stream output, and usage ledger.                                           |

Every function that takes the engine interface `$` lives in the hooks module: the engine does not follow `$` across an import, so the modules in `lib/` stay pure.

Node.js is not part of routing. It is used for development, the optional configuration migration, and the classifier probe.

## Decision and context

One logical turn gets one classification. Tool continuations reuse the decision and add no votes. Before each step, the controller checks whether the selected model still fits after new tool output.

A move to a smaller context window needs a main-response measurement from the current history and Claude's local context estimate. The router uses the larger available reading and reserves 20% of the model window. If it cannot establish fit, it keeps the current model with `context-unknown`. It does not infer token count from character count.

An explicit context-window failure marks that model ineligible until the next history reset. An engine fallback suspends rewriting for the rest of the turn. The router does not retry an Anthropic request.

## State and controls

`$.state` stores route decisions, response observations, and UI state for the active session. Version-checked writes reject stale turn results. A private in-memory view merges state writes during one dispatch because state reads are frozen for that dispatch.

Clear, branch, rewind, and committed compaction clear cache evidence and votes. A turn in progress keeps its route, pin, and any engine fallback. `/clear` starts the new session in Auto. A fresh session on a model that a configured tier routes to starts in Auto. A fresh session on any other model starts in Manual. Session start sets the mode; the band and pane only read it, even when they draw first. Resume restores the selected session's saved mode. Hot reload retains valid `$.state`. Running `/model` enters Manual, including an explicit choice of the baseline. `/router auto` resumes routing. `/router off` also enters Manual. Pins apply to the next turn and its tool continuations. The prior Auto route resumes afterward.

Subagent events pass directly to Claude Code. They do not create classifier requests or change main-conversation metrics. This is the selected scope because Mods do not expose whether a subagent model was explicit or inherited.

## Classifier deadline and failure handling

Each advice attempt has a total deadline, including any transient retry: 1,500 ms for Jev, 3,000 ms for Clef, Clef Flash and OpenAI, and 5,000 ms for Ollama by default. Ollama's first call after its model unloads can exceed that while the model loads. A timeout does not retry. `Retry-After` is honored only when it fits the remaining budget. Three launched failures pause the classifier for 60 seconds. Missing-key, missing-account, busy, and paused skips do not count as failures. Each classifier has its own failure count, pause, and in-flight slot. A turn that started under one classifier finishes with it, even if the pane switches meanwhile. Switching the classifier, or starting a session with another one, starts the new one from a clean count.

The pinned host API does not expose a per-request abort option for `$.http.fetch`. The Mod returns to the incumbent at its own deadline and blocks another advice request while that wire call remains pending. Claude Code's observed host timeout is about 30 seconds. Recorded reload and unload checks closed pending sockets after 24.7 and 28.5 seconds. Replacement closed one after 31.6 seconds. These runs do not show immediate per-call cancellation. A plugin network-policy refusal degrades routing and is never bypassed with a subprocess.

In a 20-process loopback test, timeout fallback had 1,504 ms p95 and 1,505 ms worst case. A 20-call burst made one wire request. The other 19 calls skipped as busy. The live Team canary reached Jev and received advice. See the [native acceptance records](../experiments/mod-router/results/native-http-acceptance.json) and [interruption record](../experiments/mod-router/results/native-interrupt-acceptance.json).

## Cache and cost

Cache identity uses the exact response model ID and effective effort. The Haiku 4.5 dated snapshot has an explicit mapping; Haiku 5.5 has no dated ID. An unrecognized substituted model gets no cache credit for the requested route.

The cached prefix is observed `cache_read + cache_creation`. Output tokens count only toward the next context size. Freshness uses the configured five-minute lifetime with its safety margin. Claude's usage counters do not prove one-hour cache lifetime.

The switching policy prices the candidate at a conservative cache-write bound and the incumbent at its best supported input bound. The pane shows the configured-price range and a conditional payback estimate. These are estimates, not measured savings. Claude's native `/cost` ledger owns total API cost. Classifier spend is not included.

## Deployment

Install the plugin from the `alexei-led/claude-router` marketplace, or load a checkout with `--plugin-dir`. Load only one copy of the router in a session. The plugin ships the Mod, its pure `lib/` modules, type declarations, and the configuration migration script. It starts no process and opens no port.

Use the [configuration guide](configuration.md) for optional settings and migration, and the [native guide](native-router.md) for panel and control behavior.
