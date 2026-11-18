# Backlog

Ideas and minor issues that can wait for the next release. Add an item when you meet one; remove it when it ships. Larger work gets a plan in `docs/plans/`.

## Routing

- **Limit-aware routing.** `session.measure` pushes plan usage (`rateLimits[].percentUsed`, `resetsAt`). Lean to the cost mode near 85% of the 5-hour plan limit and say so once. Medium effort.
- **API failover.** `StopFailure` carries `rate_limit`, `overloaded`, `server_error`, `model_not_found` and `billing_error`. Hold the failed model out for a while. Medium effort.
- **Catch manual model switches.** `PreModelSwitch` and `PostModelSwitch` report `from_model`, `to_model` and `source` (command, picker, SDK). Today only `command.run model` and `config.set model` are hooked, so a picker or SDK switch may be missed. Needs a live check first.
- **Zero-key classifier.** `$.model.complete` and `$.model.classify` use the session's own credentials, which would fill the "classifier not set up" state.
- **Early classification while typing.** Hook `prompt.edit` and warm the verdict by draft hash. Needs an opt-in because of privacy.
- **Live tool results.** `PostToolUse` and `PostToolUseFailure` give incremental failure counts instead of re-reading `$.session.messages` on every step.
- **Workflow and resumed subagents.** The 2.1.321 types say a workflow agent's model rewrite now applies, and a resumed subagent's rewrite is ignored. Verify live, then route workflow agents and mark resumed spawns as pass-through (`lib/subagents.mjs`).

## Terminal and desktop

- **Spinner shows the route** while the turn runs (`word`, `message`, `suffix` props).
- **Retry on higher** button and an inline `~high` pin (`$.prompt.fill` and a `prompt.submit` strip).
- **Dynamic `/router` description** with `command.describe`.
- **Re-render on `session.attach`** so a desktop that attaches late gets the notice. The unavailable toast has the same gap: it is raised at `session.start` and recorded for the day, so a surface that attaches after it never shows it.
- **Agent tool row "Open" button** through the `ToolUse` render component.
- **Progress element.** Once the floor passes 2.1.327, `Progress` replaces the Svg meter in `lib/ui/graphical/meter.mjs`. `session.info()`, per-plugin band rows (`AbovePromptRow`), `session.stop` and `agent.limits` need 2.1.327 too.
- **Route line extras.** The line shows the route and why. Not built: the turn's cost and saving against your model (`≈$0.04 · −$0.11 vs Opus 5.5`), a "was Sonnet 5.5 · high" form for a move, a click that opens a card, and a **Line** control on the pane's Policy tab. The setting is `/router line` only. `$.state` has no delete, so `router.lines` keeps one small record per placed row until the session ends.
- **Agent rows without a record.** The band lists only agents the router has a spawn record for, since those are the ones whose start and end it hears. An agent spawned while routing was off, or one a plugin started, gets no row. Listing them needs `agent.spawn` and `turn.complete` bookkeeping that does not depend on a record. The rows are not toned by model on the desktop, where a Button takes no colour.
- **Live check of the press.** `$.ui.view` works only while the call answers the person's own input. The test engine has no core for `ui.view`, so no test shows that a band press counts as one; confirm it in a live session on the terminal and the desktop app, and that `deny` toasts read well.
- **`/router` typeahead on the desktop.** The types do not say whether a desktop prompt box raises `prompt.autocomplete`; check it live. The typeahead also offers nothing until one character follows `/router `, because the engine's token is never empty.

## Docs

- Desktop screenshots: the README and user guide carry `TODO` markers where images belong.
- Say in `docs/native-router.md` that effort changes on tool-result steps are not sent unless the person sets `CLAUDE_CODE_MODEL_CAPABILITIES=per_turn_effort`.

## Packaging

- The marketplace install clones the whole repository, including tests and experiments. Pointing `marketplace.json` at the published npm package would ship only the 82 allowlisted files. Not tested.
- The npm allowlist could drop `CHANGELOG.md` and the dev-oriented docs.

## Tests and code quality

- `hooks/native-router.mjs` is at about 90.6% branch coverage. The trace-store reset, conflict-merge and lost-write paths need a concurrent-store test harness and an injectable clock.
- Times format in local time, so test files set `process.env.TZ`. A `now` plus a zone option on the formatters would remove that.
- The hover overlay is tested through `left` and `position: 'absolute'`. A band model that returns hover spans as data would let tests drop the layout inference.
- Not split or renamed yet: `hook-pane`, `hook-auto`, `auto-engine`, `config`, `panel`, and the feature-named view tests.
- Strict null checks (`tsconfig.strict.json`): track the remaining error count and fold the flags into `tsconfig.json` at zero.
