# claude-router

[![CI](https://github.com/alexei-led/claude-router/actions/workflows/ci.yml/badge.svg)](https://github.com/alexei-led/claude-router/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@alexeiled/claude-router)](https://www.npmjs.com/package/@alexeiled/claude-router)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js ≥22](https://img.shields.io/node/v/@alexeiled/claude-router.svg)](https://nodejs.org/)

A Claude Code plugin that auto-picks the right model and effort for each turn.

**Status: experimental.** I built this to dogfood Jev, TypeSafe's routing
model, inside Claude Code. It works for me; I don't know yet if it holds up
outside my setup. Try it and open an issue with what you find.

## Why

One model for every turn is a compromise: strong enough for the hard turns
and it burns your limits on "rename this variable"; cheap enough for the easy
turns and it struggles on the hard ones. Switching models by hand works, but
it is friction you pay on every message. This plugin asks a small router
model which tier a turn needs and switches for you, automatically.

## How it works

```
Claude Code  --model jev-router  ──▶  gateway 127.0.0.1:43170  ──▶  api.anthropic.com
                                       │
only requests for `jev-router`:        ├─ facts.mjs    prompt, continuation, failures
                                       ├─ jev.mjs      one Choice (tier) + one Noul (continuation?)
                                       ├─ policy.mjs   stickiness, escalation, cost-gated votes
                                       ├─ rewrite.mjs  model, effort, thinking per model family
                                       └─ store.mjs    session memory, decisions.jsonl
   responses go through unchanged; the gateway reads `usage` (context size, cache TTL)
```

A local gateway on `127.0.0.1` receives each request from Claude Code. For a
new user turn, the gateway asks Jev which tier the turn needs, then rewrites
`model`, `effort` and `thinking` and sends the request to Anthropic. All other
data goes through unchanged. No runtime dependencies; Node 22 or later.

The tiers are `micro` (Haiku), `low` (Sonnet, the baseline), `medium` (Opus at
high effort) and `high` (Opus at xhigh effort). The exact model IDs are in
`~/.claude/router.json` and default to the current generation of each family.

A tool continuation keeps the route of its turn — the gateway does not ask Jev.
Side requests, for example session titles, get the baseline tier. A subagent
that inherits the model gets routing with its own memory. A request for any
other model goes through unchanged; this is how `/router:<tier>` pins and
subagents with their own `model` work.

See [Architecture](docs/architecture.md) for the module map, the switching
policy, and a real-usage evaluation.

## Install

1. Add the marketplace and install the plugin:

   ```sh
   claude plugin marketplace add alexei-led/claude-router
   claude plugin install router@alexei-led-claude-router
   ```

2. When Claude Code asks, enter the Jev API key from [typesafe.ai](https://typesafe.ai).
   The key goes to the macOS Keychain and persists across updates.
3. In Claude Code, run `/router:setup`. It writes `model`,
   `env.ANTHROPIC_BASE_URL` and the `/model` picker row to
   `~/.claude/settings.json`, and offers a status line segment.
4. Restart Claude Code. `/router:status` shows the routes and the last turn.

One gateway serves all Claude Code sessions on the machine. The plugin hooks
start it at session start and before each prompt when it does not answer, so a
stopped or crashed gateway comes back on the next prompt. After two hours
without requests it exits by itself.

A claude.ai login continues to work: the gateway forwards the authorization
header and the `anthropic-beta` OAuth value unchanged.

## Update

```sh
claude plugin marketplace update alexei-led-claude-router
claude plugin update router@alexei-led-claude-router
```

Then restart Claude Code or run `/reload-plugins`. The next prompt replaces the
running gateway with the new version: the old gateway releases the port at once
and finishes the responses it is streaming. A session that still runs an older
plugin never replaces a newer gateway. The Jev API key stays in the macOS
Keychain. Run `/router:setup` once after an update: the status line command
path contains the plugin version.

## Documentation

- [User guide](docs/user-guide.md): daily use, pins, decision log, troubleshooting.
- [Configuration](docs/configuration.md): each key, and where the API key and the configuration file are.
- [Architecture](docs/architecture.md): how the gateway works, the switching policy, a real-usage evaluation.

## Develop

```sh
npm install
git config --local core.hooksPath scripts/git-hooks   # pre-commit: biome + gitleaks; pre-push: check, test, pack, gitleaks
npm test          # node:test
npm run check     # biome lint and format
npm run validate  # claude plugin validate
claude --plugin-dir . --model jev-router   # with ANTHROPIC_BASE_URL and TYPESAFE_API_KEY set
```

Releases: push a signed tag `v<version>` that matches `package.json`. The
release workflow publishes `@alexeiled/claude-router` to npm with trusted
publishing and creates the GitHub release. See
[docs/architecture.md](docs/architecture.md#release).
