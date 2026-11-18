# Claude Model Router

[![CI](https://github.com/alexei-led/claude-router/actions/workflows/ci.yml/badge.svg)](https://github.com/alexei-led/claude-router/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

**A Claude Code Mod that chooses a model and effort for each main-conversation turn, advised by a prompt classifier: Jev; Cloudflare's Clef, Clef Flash or Clef Omni; OpenAI; or a local Ollama model.**

The Mod changes only the model and effort in Claude Code's turn hook. Claude Code sends the request, streams the reply, runs tools, and reports usage. The router does not proxy model traffic or start a local server; an Ollama classifier calls an Ollama server that you run. Subagents get one model each when they start, chosen the same way: every agent whose definition names no model, says `model: inherit`, or sets `modelRouting: auto`. Their steps are never re-routed. See [Subagent routing](docs/configuration.md#subagent-routing).

## Providers

Use the provider that already works with Claude Code. Select its router profile, not a new endpoint:

```sh
CLAUDE_ROUTER_PROVIDER=deepseek claude --model 'deepseek-flash[1m]'
```

Create `~/.claude/deepseek-router.json` containing `{}` to use DeepSeek defaults.
With `CLAUDE_CONFIG_DIR`, put the file in that directory instead.

| Built-in profile | Router file | Default models |
| --- | --- | --- |
| Anthropic, the default | `router.json` | Haiku 5.5, Sonnet 5.5, Opus 5.5; Fable 5.2 for routes you set |
| `deepseek` | `deepseek-router.json` | DeepSeek Flash, routed by effort |
| `zai` | `zai-router.json` | GLM-5.3-Flash and GLM-5.3 |
| `minimax` | `minimax-router.json` | MiniMax-M3.1-Flash, routed by effort |
| `mimo` | `mimo-router.json` | MiMo-V2.6-Flash and MiMo-V2.6-Pro, no routed effort |
| `kimi` | `kimi-router.json` | Kimi-K3.1-Pro, routed by effort |

OpenRouter, Ollama, other local servers and other compatible hosted providers use custom `<provider>-router.json` files.
They have no built-in model defaults. A selected file must exist and validate, or the router leaves Claude Code's model unchanged.

See [Providers](docs/providers.md) for **default routes and activities**, **custom profiles**, and the **`--settings` flag alternative**.
Execution provider selection is separate from classifier selection. Observed usage stays visible even when a provider's cache behavior makes savings comparisons unavailable.

## Supported classifiers

The active classifier is asked at the start of each logical turn, for the tier, task goal and current phase, and again in the background every 4 requests while the turn runs (`policy.reviewEveryRequests`). Pick one on the pane's **Classifier** tab or in the selected router file; only the active one receives prompt text. With subagent routing `on` (the default), it is also asked once per routed subagent, with the task's description and prompt; set `"subagentRouting": "off"` to keep that text local.

| Classifier | Service                                    | Credential                          | Prompt text goes to       | How it is asked for the activity                                      |
| ---------- | ------------------------------------------ | ----------------------------------- | ------------------------- | --------------------------------------------------------------------- |
| Jev        | [typesafe.ai](https://typesafe.ai)         | Jev API key                         | typesafe.ai               | Goal and phase `choice` questions in the same request                 |
| Clef       | Cloudflare Workers AI, 27B                 | Cloudflare API token and account ID | Cloudflare                | The same                                                              |
| Clef Flash | Cloudflare Workers AI, 9B                  | Cloudflare API token and account ID | Cloudflare                | The same                                                              |
| Clef Omni  | Cloudflare Workers AI, 30B MoE             | Cloudflare API token and account ID | Cloudflare                | The same                                                              |
| OpenAI     | OpenAI, `gpt-6-luna`         | OpenAI API key                      | OpenAI (`api.openai.com`) | Goal and phase choices in `questions`, in the same request                 |
| Ollama     | A local [Ollama](https://ollama.com) model | None                                | Stays on this machine     | Goal only in a second request; no phase or continuation answer |

Jev 1.14 is the default; a configured model override stays in force. [Configuration](docs/configuration.md#classifiers) gives the endpoints, timeouts, and how to add another service that speaks one of the supported protocols.

![The Router band above the Claude Code prompt in eight states](docs/router-band.svg)

The band above the prompt shows the tier, activity, model, and reason for each turn. `/router` opens a pane to pin a tier, edit the model and effort of each tier, and tune the policy. See the [user guide](docs/user-guide.md#read-the-status-band).

In the desktop app, VS Code and mobile, the band is one fixed row with nothing revealed on hover: a tier meter icon, the route, activity and reason on the left; the readings, a **Pin next turn** dropdown and **Router** on the right. The pane has a header, five tabs (Now, Routes, Policy, Classifier, Usage), one warnings slot and a save bar. <!-- TODO: desktop screenshots (band, Now, Routes, Policy, Classifier, Usage) -->

In the terminal, the picture above shows the band, whose controls appear on its own row on hover; the pane's warnings share one slot under the tab row, and a pending pin shows on its pin button (press it again to unpin).

The router needs Claude Code 2.1.321 or newer. Savings are not measured. The pane's Usage tab estimates what routing cost against no routing (your own model on the main thread, Claude Code's pick for each subagent) for the same tokens at configured list prices, for this session, today, 7 or 30 days, this month or all; it is not a bill and does not judge answer quality. See the [evaluation](docs/evaluation.md).

## How it works

```mermaid
sequenceDiagram
  actor Dev as Developer
  participant Code as Claude Code
  participant Mod as Router Mod
  participant Cls as Classifier
  participant API as Model provider
  Dev->>Code: Prompt
  opt Subagent spawn
    Code->>Mod: agent.spawn
    Mod-->>Code: One model for the agent (on), or none (off)
  end
  Code->>Mod: Main or subagent step
  alt Main conversation, routing on
    Mod->>Cls: Bounded prompt and dialogue
    Cls-->>Mod: Tier advice
    Mod-->>Code: Selected model and effort
  else Routing off or subagent step
    Mod-->>Code: Original model and effort
  end
  Code->>API: Native request and tools
  API-->>Code: Response stream and usage
  Mod-->>Dev: Status band and router pane
```

The active classifier labels each new logical turn. With `table` or `shadow`, the router checks tier and activity routes as the task runs: a turn labelled `ops` that edits code can move up to the `code` route, and a background classifier review can move the tier or activity. With `auto`, it keeps its own demand and route state instead of using activity route-table moves. A cheaper route on the same task waits for a dwell and a checkpoint its work can show: a passed test, build or lint run, or for commands, docs and read-only work the success the router can see. A notification is treated as progress, but cannot justify a downgrade because it may belong to an older task. `/router decisions` lists why each turn ran where it did. See [Changes during a task](docs/user-guide.md#changes-during-a-task). A local policy applies vote, context, failure, and cache-cost rules before the Mod changes the next step. Claude Code owns request construction, model credentials, tools, streaming, and the API cost ledger.

With the Anthropic profile, the base routes are:

| Tier     | Default model | Effort   |
| -------- | ------------- | -------- |
| `micro`  | Haiku 5.5     | `medium` |
| `low`    | Haiku 5.5     | `high`   |
| `medium` | Opus 5.5      | `medium` |
| `high`   | Opus 5.5      | `xhigh`  |

These are routing defaults. They do not claim equal model quality. [Configuration](docs/configuration.md#built-in-defaults) gives the published results behind them and the `router.json` lines that restore the 1.3 Sonnet ladder.

Activity routing classifies the task's goal (`code`, `debug`, `explore`, `plan`, `review`, `ops`, or `docs`) separately from the current phase. Bounded verification or execution can use the `ops` route without relabeling the goal. A route is then picked by tier and effective activity. It is on by default since 1.7. A `·` cell uses the tier's own route, the base route:

The Anthropic profile uses these activity defaults. Other profiles have [their own defaults](docs/providers.md#activity-overrides).

| Activity                          | `micro`        | `low`             | `medium`         | `high`       |
| --------------------------------- | -------------- | ----------------- | ---------------- | ------------ |
| Base route                        | Haiku · medium | Haiku · high      | Opus · medium    | Opus · xhigh |
| `code`, `debug`, `plan`, `review` | ·              | **Sonnet · high** | ·                | ·            |
| `ops`                             | ·              | ·                 | **Haiku · high** | ·            |
| `explore`, `docs`                 | ·              | ·                 | ·                | ·            |

`/router activities off` stops asking and keeps the base routes. [Activity routing](docs/activity-routing.md) explains each cell and how to change it. The label is optional: on `uncertain` or a weak label the base route is used if the move passes the cache check, when the activity answer fails the running activity stays and the tier answer still applies, and when the classifier fails the running route stays. See [Route by activity](docs/user-guide.md#route-by-activity), and [Evaluation](docs/evaluation.md#activity-routing) for how it is checked. Its default overrides rest on published vendor results and a list-price replay of one developer's sessions, not measured savings.

## Choose a routing engine

Set `routingEngine` in the selected profile file: `table` (default), `shadow` or `auto`. For example, use `{"routingEngine":"shadow"}` or `{"routingEngine":"auto"}`; omit it for `table`. `/router auto` turns routing on for the session; it does not select the engine. `/router off` turns it off, while `/router mode cost|balanced|quality` selects the routing mode.

- **`table` (default):** uses deterministic tier-by-activity routes. The routing mode transforms those routes before the table policy.
- **`shadow`:** table requests remain unchanged. `/router decisions` shows one-step `alt` proposals. `/router trace export` writes bounded replay inputs; for the work profile (`CLAUDE_CONFIG_DIR=~/.claude-team`), from a source checkout, replay `~/.claude-team/router-traces.json` and any dated rollover files with `node scripts/replay-traces.mjs`.
- **`auto`:** selects a model and effort from declared per-effort capabilities, classifier demand, mode margins and hard/cache constraints. Configure a classifier credential when its provider requires a key; Ollama needs none. Without classifier advice, demand cannot be updated, but a qualifying startup move may still occur. Capability declarations determine whether candidate adequacy is known. Evaluation and cutover remain pending.

See [routing engines](docs/configuration.md#routing-engine) for startup, fallback and pin behavior, and [routing modes](docs/routing-modes.md) for mode effects.

For mixed Anthropic and DeepSeek sessions, use the explicit [model-proxy profile](docs/providers.md#mix-anthropic-and-deepseek-with-model-proxy) with a separately started local proxy. No built-in mixed-provider defaults are installed.

## Install

You need Claude Code 2.1.321 or newer and credentials for one [supported classifier](#supported-classifiers).

```sh
claude plugin marketplace add alexei-led/claude-router
claude plugin install router@alexei-led-claude-router
```

For the default Anthropic profile, start on a catalog model such as `claude --model claude-haiku-5-5`. For other providers, [select a provider profile](docs/providers.md#select-a-provider). Run `/plugin configure router` and save credentials for the active classifier, or run `ollama serve` with a pulled local model and select Ollama. With `table` or `shadow`, a new session starts with routing on only when its model is used by a tier or enabled activity override. With `auto`, any model in the selected catalog starts with routing on. `/router auto` turns routing on for the selected engine; see [engine selection](docs/configuration.md#routing-engine).

Claude Code updates the plugin at startup when auto-update is on for this marketplace. Otherwise run `claude plugin marketplace update alexei-led-claude-router`, then `claude plugin update router@alexei-led-claude-router`.

Upgrading from 0.8? Remove the gateway settings that 0.8 `/router:setup` wrote before the first 1.0 session, or requests go to a gateway that 1.0 no longer starts. Follow the [migration steps](docs/user-guide.md#move-from-v08-gateway-setup).

## Run from a checkout

Start Claude Code with this directory as a local plugin and the full Haiku baseline model:

```sh
claude --plugin-dir "$PWD" --model claude-haiku-5-5
```

In Claude Code, run `/plugin configure router` and save your classifier key in the sensitive plugin option. The Mod adds its status band and `/router` pane. No status-line setup or gateway environment variables are needed.

Run `/router` to open the pane. `/router auto` turns routing on for the session; `/router off` turns it off, and `/router mode cost|balanced|quality` selects the routing mode. None changes `routingEngine`, which stays in the selected profile file. Run `/model` to select a model (which turns routing off). See the [user guide](docs/user-guide.md).

Before a push, run the same checks as CI. `npm run setup` installs Biome and TypeScript into `tools/`; the plugin root keeps no lockfile, so Claude Code installs nothing with the plugin. `npm run validate` and `npm run test:plugin` need the `claude` CLI: they load the Mod in the Claude Code engine, which refuses some faults that lint and unit tests miss.

```sh
npm run setup
npm run check && npm run typecheck && npm test && npm run validate && npm run test:plugin
```

## Contributing

Pull requests from forks run CI automatically (a maintainer may have to approve the first run). Each check is its own job, and failures show as annotations on the changed lines: `Lint (biome)`, `Types (tsc)`, `Unit tests (node --test)`, and `Plugin (validate and engine tests)`. Run them locally before pushing:

```sh
npm run setup
npm run check && npm run typecheck && npm test && npm run validate && npm run test:plugin
```

`npm run format` fixes biome formatting. A maintainer can request an AI review by adding the `ai-review` label.

### Code quality

- `npm run check` is Biome with `--error-on-warnings`, so a warning fails like an error. Besides the recommended rules it catches unawaited or misused promises, an `await` on a non-promise, an incomplete `switch` over a union, unused imports and variables, import cycles, throws of non-Error values, a lost `cause` when an error is rethrown, shadowed bindings, conditions the types prove constant, and read-modify-write updates split by an `await` (`useAtomicUpdates`). Use `biome-ignore` only with a one-line reason for code that is deliberate.
- `npm run typecheck` is `tsc` over `lib` and `hooks` with `useUnknownInCatchVariables`, `strictFunctionTypes`, `noImplicitReturns`, `noFallthroughCasesInSwitch`, `noUnusedLocals`/`noUnusedParameters`, `verbatimModuleSyntax` and `erasableSyntaxOnly`.
- `npm run typecheck:strict` adds `strictNullChecks` and `noUncheckedIndexedAccess`. It is a tracking script, not a gate: run it on the files you touch and do not add errors.

## Documentation

- [User guide](docs/user-guide.md): install, use the controls, read the panel, and troubleshoot.
- [Providers](docs/providers.md): provider names, router files, built-in defaults, and custom profiles.
- [Configuration](docs/configuration.md): router-file settings, classifier keys, cache policies, and migrations.
- [Architecture](docs/architecture.md): Mod event flow, state, safeguards, and runtime boundaries.
- [Activity routing](docs/activity-routing.md): the default matrix by activity, why each cell, and how to change or turn it off.
- [Routing modes](docs/routing-modes.md): `cost`, `balanced` and `quality`, where the mode comes from, and every decision per mode.
- [Native router details](docs/native-router.md): panel semantics, tuning, and accepted limits.
- [Evaluation](docs/evaluation.md): limits, text-free trace export and replay, and the paired benchmark proposal.
- [Changelog](CHANGELOG.md): user-visible changes by version.
