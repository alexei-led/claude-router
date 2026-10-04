# Native router experiments

The production router now lives in [hooks/native-router.mjs](../../hooks/native-router.mjs). This directory contains isolated probes, reproducible CLI drivers and sanitized acceptance results. It is excluded from the shipped plugin.

See the [architecture](../../docs/architecture.md), [configuration](../../docs/configuration.md) and [user guide](../../docs/user-guide.md) for the supported native setup. Main conversations are routed. Every subagent model choice passes through unchanged.

## Evidence

| Check                                                              | Recorded result                                                                                                  |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| HTTP deadline, retry, slow body and burst admission                | [HTTP acceptance](results/native-http-acceptance.json): 20 samples, p95 1504 ms; one pending request             |
| Clear, circuit expiry, reload, replacement, unload and resume/fork | `results/persistent-*-acceptance.json`, driven by [persistent-acceptance.mjs](scripts/persistent-acceptance.mjs) |
| Interrupt during the main controller's Jev wait                    | [Interrupt acceptance](results/native-interrupt-acceptance.json): late advice discarded; socket closed in 4 ms   |
| Native engine fallback                                             | [Fallback acceptance](results/native-fallback-acceptance.json): subsequent tool step kept the fallback           |
| Deferred MCP tools and large requested output setting on Haiku     | [Deferred tool/output gate](results/deferred-tool-output-gate.json): direct and rewritten requests succeeded     |
| Installed Team package and authenticated Jev                       | [Team canary](results/team-canary.json): one router, version 1.0.0, native Sonnet response                       |
| Historical decision replay                                         | [Trace evaluation](results/trace-evaluation.json): coverage and uncertainty bounds, not measured savings         |

Earlier direct probes accepted signed-thinking/tool history across Sonnet → Opus → Haiku and input contexts of 589399 tokens on Sonnet and 589481 on Opus. Their summary is in [runtime gates](results/runtime-gates.json). These observations apply to Claude Code 2.1.289 and the tested Team policy.

## Reproduce

From the repository root, with Team authentication:

```sh
node experiments/mod-router/scripts/launch-team-native.mjs
node experiments/mod-router/scripts/interrupt-acceptance.mjs
node experiments/mod-router/scripts/persistent-acceptance.mjs resume
node experiments/mod-router/scripts/persistent-acceptance.mjs unload
node experiments/mod-router/scripts/team-canary.mjs
```

The candidate launcher builds a temporary plugin and disables the installed gateway for that launch. Persistent drivers use `ce peer-team` and synthetic loopback Jev credentials. The canary uses the installed Team package and real provider requests. Circuit expiry takes at least 60 seconds. Drivers remove temporary plugins and close their child processes.

The marker prototype in `hooks/register.mjs` is historical research. Likewise `lib/legacy-*.mjs` preserves v0.8 arithmetic and request rewriting solely for comparison. No gateway, subprocess classifier or Node API is imported by the production Mod.

Mods are early access. Native usage exposes no cache TTL split. Unknown cache lifetime stays unknown. No one-hour TTL or achieved savings is inferred.

Primary references: [Mods announcement](https://claude.com/blog/claude-code-mods), [examples](https://github.com/anthropics/claude-code/tree/main/mods), [events](https://code.claude.com/docs/en/plugins/mods/events), [UI and state](https://code.claude.com/docs/en/plugins/mods/interface).
