# claude-router

A Claude Code plugin that selects a model and an effort level for each user turn.

A local gateway on `127.0.0.1` receives each request from Claude Code. For a
new user turn, the gateway asks TypeSafe Jev which tier the turn needs. Then
the gateway changes `model`, `effort` and `thinking` in the request and sends
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

The tiers are `micro` (haiku), `low` (sonnet, the baseline), `medium` (opus at
high effort) and `high` (fable at xhigh effort).

A tool continuation is a request whose last message is a `tool_result`. It
keeps the route of the turn, and the gateway does not ask Jev. Side requests,
for example session titles, get the baseline tier. A request for any other
model goes through unchanged. This is how `/router:<tier>` pins and subagents
with their own `model` work.

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

2. When Claude Code asks, enter the TypeSafe API key. The key goes to the
   macOS Keychain.
3. In Claude Code, run `/router:setup`. It writes two keys to
   `~/.claude/settings.json`: `model` and `env.ANTHROPIC_BASE_URL`.
4. Restart Claude Code.

The `SessionStart` hook of the plugin starts the gateway when the port does not
answer. A claude.ai login continues to work: the gateway sends the
authorization header and the OAuth value of `anthropic-beta` unchanged.

## Documentation

- [User guide](docs/user-guide.md): daily use, pins, decision log, troubleshooting.
- [Configuration](docs/configuration.md): each key, and where the API key and the configuration file are.
- [Design](docs/design.md): decisions, the switching policy, test results.

## Develop

```sh
npm install
npm test          # node:test
npm run check     # biome lint and format
npm run validate  # claude plugin validate
claude --plugin-dir . --model router   # with ANTHROPIC_BASE_URL and TYPESAFE_API_KEY set
```

Releases: push a signed tag `v<version>` that matches `package.json`. The
release workflow publishes `@alexeiled/claude-router` to npm with trusted
publishing and creates the GitHub release. See
[docs/design.md](docs/design.md#release).
