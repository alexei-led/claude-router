# Claude Model Router

[![CI](https://github.com/alexei-led/claude-router/actions/workflows/ci.yml/badge.svg)](https://github.com/alexei-led/claude-router/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

**A Claude Code Mod that asks Jev to choose a model and effort for each main-conversation turn.**

The Mod changes only the model and effort in Claude Code's turn hook. Claude Code sends the request, streams the reply, runs tools, and reports usage. The router does not proxy Anthropic traffic or start a local server. Subagent model choices pass through unchanged.

The router needs Claude Code 2.1.289 or newer. Current savings are not measured. The panel shows Claude's reported usage and configured-price scenarios, not a savings total. See the [evaluation](docs/evaluation.md).

## How it works

```mermaid
sequenceDiagram
  actor Dev as Developer
  participant Code as Claude Code
  participant Mod as Router Mod
  participant Jev
  participant API as Anthropic
  Dev->>Code: Prompt
  Code->>Mod: Main or subagent step
  alt Main conversation in Auto
    Mod->>Jev: Bounded prompt and dialogue
    Jev-->>Mod: Tier advice
    Mod-->>Code: Selected model and effort
  else Manual or subagent
    Mod-->>Code: Original model and effort
  end
  Code->>API: Native request and tools
  API-->>Code: Response stream and usage
  Mod-->>Dev: Status band and router pane
```

Jev classifies a new logical turn once. Tool continuations keep that choice. A local policy applies vote, context, failure, and cache-cost rules before the Mod changes the next step. Claude Code owns request construction, model credentials, tools, streaming, and the API cost ledger.

| Tier     | Default model | Effort                   |
| -------- | ------------- | ------------------------ |
| `micro`  | Haiku 4.5     | No effort setting        |
| `low`    | Sonnet 5.5    | Keeps the session effort |
| `medium` | Sonnet 5.5    | `xhigh`                  |
| `high`   | Opus 5.5      | `xhigh`                  |

These are routing defaults. They do not claim equal model quality.

## Install

You need Claude Code 2.1.289 or newer and a Jev API key from [typesafe.ai](https://typesafe.ai).

```sh
claude plugin marketplace add alexei-led/claude-router
claude plugin install router@alexei-led-claude-router
```

Start Claude Code on the full baseline model, for example `claude --model claude-sonnet-5-5`. Then run `/plugin configure router`, save the Jev API key, and run `/router auto`.

Upgrading from 0.8? Remove the gateway settings that 0.8 `/router:setup` wrote before the first 1.0 session, or requests go to a gateway that 1.0 no longer starts. Follow the [migration steps](docs/user-guide.md#move-from-v08-gateway-setup).

## Run from a checkout

Start Claude Code with this directory as a local plugin and the full Sonnet baseline model:

```sh
claude --plugin-dir "$PWD" --model claude-sonnet-5-5
```

In Claude Code, run `/plugin configure router` and save your Jev API key in the sensitive plugin option. Then run `/router auto`. The Mod adds its status band and `/router` pane. No status-line setup or gateway environment variables are needed.

Run `/model` to select a model and enter Manual mode. Run `/router auto` to resume. For controls, metrics, tuning, and troubleshooting, see the [user guide](docs/user-guide.md).

## Documentation

- [User guide](docs/user-guide.md): install, use the controls, read the panel, and troubleshoot.
- [Configuration](docs/configuration.md): the optional profile `router.json`, defaults, and v0.8 migration.
- [Architecture](docs/architecture.md): Mod event flow, state, safeguards, and runtime boundaries.
- [Native router details](docs/native-router.md): panel semantics, tuning, and accepted limits.
- [Evaluation](docs/evaluation.md): historical gateway results and the native shadow replay.
- [Changelog](CHANGELOG.md): user-visible changes by version.
