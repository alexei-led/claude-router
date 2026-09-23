# claude-router

[![CI](https://github.com/alexei-led/claude-router/actions/workflows/ci.yml/badge.svg)](https://github.com/alexei-led/claude-router/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@alexeiled/claude-router)](https://www.npmjs.com/package/@alexeiled/claude-router)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js ≥22](https://img.shields.io/node/v/@alexeiled/claude-router.svg)](https://nodejs.org/)

A Claude Code plugin that auto-picks the right model and effort for each turn.

A local gateway on `127.0.0.1` receives each request from Claude Code. For a
new user turn, the gateway asks Jev (TypeSafe) which tier the turn needs. Then
the gateway rewrites `model`, `effort` and `thinking` in the request and sends
it to Anthropic. All other data goes through unchanged. The gateway has no
runtime dependencies and needs Node 22 or later.

## How it works

```
Claude Code  --model router  ──▶  gateway 127.0.0.1:43170  ──▶  api.anthropic.com
                                   │
   only requests for `router`:     ├─ facts.mjs    prompt, continuation, failures
                                   ├─ jev.mjs      one Choice (tier) + one Noul (continuation?)
                                   ├─ policy.mjs   stickiness, escalation, cost-gated votes
                                   ├─ rewrite.mjs  model, effort, thinking per model family
                                   └─ store.mjs    session memory, decisions.jsonl
   responses go through unchanged; the gateway reads `usage` (context size, cache TTL)
```

The tiers are `micro` (Haiku), `low` (Sonnet, the baseline), `medium` (Opus at
high effort) and `high` (Opus at xhigh effort). The exact model IDs are in
`~/.claude/router.json` and default to the current generation of each family.

A tool continuation keeps the route of its turn — the gateway does not ask Jev.
Side requests, for example session titles, get the baseline tier. A request for
any other model goes through unchanged. This is how `/router:<tier>` pins and
subagents with their own `model` work.

Module dependencies point in one direction: `gateway.mjs` (HTTP) →
`router.mjs` (orchestration) → `facts`, `jev`, `policy` → `cost`, `rewrite`,
`store`. The modules `facts`, `cost`, `rewrite`, `sse` and `policy` are pure.
Only `store` writes files. The Jev transport is injected.

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

The `SessionStart` hook starts the gateway when the port does not answer.
A claude.ai login continues to work: the gateway forwards the authorization
header and the `anthropic-beta` OAuth value unchanged.

## Update

```sh
claude plugin update router@alexei-led-claude-router
pkill -f scripts/gateway.mjs   # stop the old gateway
```

The next session starts the updated gateway automatically. The Jev API key
stays in the macOS Keychain — no need to re-enter it. Run `/router:setup` once
after an update: the status line command path contains the plugin version and
must be refreshed.

## Documentation

- [User guide](docs/user-guide.md): daily use, pins, decision log, troubleshooting.
- [Configuration](docs/configuration.md): each key, and where the API key and the configuration file are.
- [Design](docs/design.md): decisions, the switching policy, test results.

## Develop

```sh
npm install
git config --local core.hooksPath scripts/git-hooks   # pre-commit: biome + gitleaks; pre-push: check, test, pack, gitleaks
npm test          # node:test
npm run check     # biome lint and format
npm run validate  # claude plugin validate
claude --plugin-dir . --model router   # with ANTHROPIC_BASE_URL and TYPESAFE_API_KEY set
```

Releases: push a signed tag `v<version>` that matches `package.json`. The
release workflow publishes `@alexeiled/claude-router` to npm with trusted
publishing and creates the GitHub release. See
[docs/design.md](docs/design.md#release).
