# Native Jev Router candidate

The native candidate runs inside Claude Code 2.1.289. It changes model and effort per main-conversation turn, then leaves requests, streaming, tools and the cost ledger to Claude. The released root plugin still starts the gateway. Cutover is not complete.

## Controls

Run the isolated Team candidate with `node experiments/mod-router/scripts/launch-team-native.mjs`.
It loads a temporary copy of the native Mod, overrides this launch to direct Anthropic transport,
and disables the installed gateway plugin. It uses `ce peer-team` so the Team account is retained
without changing the remembered launcher profile. Exit the candidate to remove its temporary files.

| Action                                 | Effect                                                                                                                                           |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `/router` or the Router button         | Open the native details pane.                                                                                                                    |
| `/router status`                       | Print a concise status without opening UI.                                                                                                       |
| `/router auto`                         | Enable automatic routing.                                                                                                                        |
| `/router off` or Manual model          | Preserve Claude’s selected model.                                                                                                                |
| `/model …`                             | Enter Manual, including when selecting the baseline model. Use `/router auto` to resume routing.                                                 |
| `/router pin micro\|low\|medium\|high` | Select a tier for the next turn and its tool continuations. The previous automatic incumbent resumes afterward. Auto must already be enabled.    |
| Set Jev API key                        | Fill `/plugin configure router` into an empty prompt. Press Enter, select Jev API key, enter it and save. An existing prompt draft is preserved. |

The key uses Claude’s sensitive plugin option storage. Never paste it into a model conversation. Missing credentials keep the current eligible model and show the degraded state.

Manual is a process preference and survives `/clear` and plugin reload. Pins and unsaved tuning drafts lapse on a history reset. Reload retains router state. Resume/branch behavior is still part of the pending live matrix.

## Reading the panel

| Reading                     | Meaning                                                                                                                                                                            |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Last reply / Selected       | Actual response model versus the requested model. Effort is the requested setting; actual effort is not reported by the engine.                                                    |
| API cost reported by Claude | Claude’s native `/cost` ledger. Subscription list-price equivalents are not cash charges. Jev spend is not included.                                                               |
| Context bar                 | Maximum of available observed input plus output and local input estimate, against the routed model’s configured window. The fit rule reserves 20%.                                 |
| Cache reuse                 | Last response cache-read tokens divided by all input tokens. Read and written counters appear separately.                                                                          |
| Input trend                 | The last ten observed main-conversation input sizes, scaled to their largest reading.                                                                                              |
| Jev / Last classification   | Credential/provider status and elapsed time of the last attempted classification. Busy, paused and missing-key skips are not network measurements.                                 |
| Next-turn difference        | Configured-price cache scenarios for the suggested tier versus the incumbent. Negative means cheaper; positive means added cost. It is not achieved savings.                       |
| Conservative payback        | Later turns needed to recover the conservative initial difference, assuming the last observed output size and future cache reads. No projection means no justified payback figure. |

Unknown readings stay unknown. The pane does not maintain a second cost ledger or cumulative savings counter. Cache freshness uses the five-minute minimum with a 30-second margin. The response cannot prove one-hour TTL.

## Tuning

The pane edits three existing settings. Select **Save tuning** to validate and write them to the active profile’s `router.json`. It preserves unrelated configuration keys and refuses a symlink file. The current turn retains its original tuning. Changes apply to future turns.

| Setting                        | Choices in the pane   | Effect                                                       |
| ------------------------------ | --------------------- | ------------------------------------------------------------ |
| `jev.timeoutMs`                | 500, 1000, 1500, 3000 | Total advice budget, including a possible retry.             |
| `policy.downgradeVotes`        | 1, 2, 3               | Consecutive supported votes before a cheaper tier.           |
| `policy.downgradeHorizonTurns` | 1, 3, 5, 10           | Turns used to evaluate switching cost against later savings. |

Other validated settings remain in `router.json`. `policy.cashCapUsd` caps an estimated cold cache write for credits models. It does not cap output or session spend. Default plan models do not turn it into a cash budget.

Claude versions below 2.1.289 pass through with an unavailable diagnostic. Auto and pin controls cannot bypass that gate. Project/local settings cannot redirect `HOME` or `CLAUDE_CONFIG_DIR` for router configuration. This prevents a project from selecting another profile’s classifier endpoint or tuning file.

## Verified evidence and limits

- The native controller completed a direct Opus pin, Haiku pin and Manual Sonnet reply in Team. Manual metrics updated to the actual Sonnet reply.
- Secure credential retrieval and native HTTP to real Jev succeeded in 390 ms. Jev suggested `micro`. The policy retained Sonnet on the pending downgrade vote.
- Forty-two focused Node tests cover native transport, routing, costs, metrics and the reviewed state regressions. Two native-kit tests cover terminal/desktop trees at 48–60 columns and native button actions. Strict types pass against the local generated API declarations. A rendered live pane was inspected separately.
- Direct prototype sessions accepted signed-thinking history and Read tool results across Sonnet, Opus and Haiku. Sonnet and Opus accepted histories above 589K input tokens. These probes do not replace the full controller acceptance matrix.
- All subagents currently preserve Claude’s model selection. The API does not expose whether an existing definition selected its model or inherited it. Full gateway parity is therefore unproven.
- The gateway release and launcher remain available. Full lifecycle/resource tests, remaining compatibility cases, trace evaluation, canary/rollback and native release packaging are pending. Follow the [execution plan](plans/2026-10-04-mod-router-plan.md).

The persistent CLI `/clear` check passed: one hanging HTTP request remained guarded across the
history reset, repeated advice calls returned `busy`, Manual remained set, and the socket closed
after CLI exit. Run `node experiments/mod-router/scripts/persistent-acceptance.mjs` to reproduce
it. This proves the NativeJev/host transport boundary and real router controls in that scenario;
resume/fork, reload, interrupt/unload and native provider fallback remain separate gates.

The live circuit check also passed: three settled malformed responses paused advice for 60 seconds,
the paused call made no HTTP request, and a real 503→success retry after expiry reset health.
Run `node experiments/mod-router/scripts/persistent-acceptance.mjs circuit`; it takes at least
60 seconds and uses a synthetic local advice service, not a billed model request.
