# Native router migration

Target: 1.0.0. Approved scope: route the main Claude Code conversation through Mods and preserve all subagent model choices.

## Completed design

Jev supplies bounded advice. The local policy selects a tier. A `turn.step` hook changes only model and effort. Claude Code owns Anthropic authentication, request construction, streaming, tools and its cost ledger. The native panel provides status, observed usage, conservative switching estimates and validated tuning.

No proxy feature remains required for this scope. The gateway, daemon scripts, request rewriting, SSE parser and old tier skills are removed from the native package. Historical comparison fixtures remain under `experiments/` and are not shipped. Version 0.8.0 remains the legacy reference in git.

Architecture and operations are maintained in [architecture](../architecture.md), [user guide](../user-guide.md) and [configuration](../configuration.md).

## Completion evidence

| Area                     | Evidence                                                                                                                                |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| Routing and cache policy | Exact model identity, effort separation, unknown TTL, context guards, pins, Manual mode and subagent pass-through regressions           |
| HTTP                     | Twenty samples: p95 1504 ms, worst 1505 ms; bounded retries and one unfinished request                                                  |
| Lifecycle                | Persistent clear, circuit, reload, replacement, unload and resume/fork; main-turn SDK interrupt discards late advice                    |
| Compatibility            | Billed pin chain Opus → Haiku → Sonnet with tools; Sonnet/Opus input over 589K; deferred ToolSearch and Haiku output; native fallback   |
| Evaluation               | Sanitized historical trace replay with prefix bounds and coverage limitations; no measured savings claim                                |
| Package                  | Native hooks only; no daemon, gateway or runtime subprocess; manifests and packed contents validated                                    |
| Team                     | Separate local plugin, direct Anthropic launch, old gateway disabled; fresh/resumed model controls preserved; v0.8.0 rollback rehearsed |
| UI                       | Native terminal/desktop kit and strict types; status, bars, metrics, secure-key handoff and tuning                                      |

Reproducible drivers and results are indexed in [experiments](../../experiments/mod-router/README.md).

## Limits

The pinned API cannot identify whether a subagent inherited its model or chose it explicitly. Both pass through. Overriding them requires a reliable API signal.

Native usage has no 5m/1h split. Switching estimates use conservative cost scenarios. Session usage comes from Claude's native ledger. Jev charges are not included.

Mods are early access, with a minimum tested Claude Code version of 2.1.289. Future host changes require compatibility validation.
