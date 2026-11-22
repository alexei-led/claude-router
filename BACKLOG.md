# Backlog

Ideas and minor issues that can wait for the next release. Add an item when you meet one; remove it when it ships. Larger work gets a plan in `docs/plans/`.

## Routing

- **Limit-aware routing.** `session.measure` pushes plan usage (`rateLimits[].percentUsed`, `resetsAt`). Lean to the cost mode near 85% of the 5-hour plan limit and say so once. Medium effort.
- **Live checks of 1.26.0 on the 2.1.321 floor.** The `classic.StopFailure`, `classic.PostModelSwitch` and `session.attach` hooks rest on the 2.1.296 type snapshot and were run live only on 2.1.327, and failover and the late-attach toast not at all (no API error, no second surface). Check on 2.1.321: a real `overloaded` error holds the model and the next turn runs another; a picker switch turns routing off; a desktop that attaches late shows the toast once.
- **`StopFailure` skipped by the builtin security plugin on a managed machine.** Live 2026-11-22 (2.1.330): a real API error printed `its classic.StopFailure hook was skipped. "cc-plugin-sec-default" runs first and sent the event on past it`; the same notice is in transcripts from 2.1.329 (2026-11-20). The builtin `cc-plugin-sec-default@builtin` seats itself outermost on a machine with managed settings unless managed `prependPlugins` is set (ignored from user, project, local and `--settings`). `next(request)` does not throw on an API error (instrumented live), so there is no in-plugin workaround. Verified 2026-11-22 with `prependPlugins: []` in both managed plists: the same session wrote `broken (model) · availability: model not found` on a 404 and the next auto turn ran the other model (`forced`). `mdm-check` and `mdm-fix` in the chezmoi dotfiles now report and set the key; without a policy change, no engine writes a hold live and fallbacks never fire.
- **Failover gaps.** `StopFailure` carries no model id, so a main-turn hold is on the last main request the router sent and an agent's on the model its last recorded step ran. A hold lasts a fixed 5, 5, 2 or 60 minutes (no retry-after) and is lost on `--continue`; a resumed agent keeps the model its first spawn had. (Since 2026-11-22 the `auto` engine reads and writes holds, replay traces record the held ids per operation, subagent spawns read holds, and an agent's failure holds its model.)
- **Zero-key classifier.** `$.model.complete` and `$.model.classify` use the session's own credentials, which would fill the "classifier not set up" state.
- **Early classification while typing.** Hook `prompt.edit` and warm the verdict by draft hash. Needs an opt-in because of privacy.
- **Live tool results.** `PostToolUse` and `PostToolUseFailure` give incremental failure counts instead of re-reading `$.session.messages` on every step.

## Terminal and desktop

- The transcript echoes `/router pin high` and the other `/router` commands as `❯ /router `, dropping the arguments; the reply line is right. Read in 1.26.0 work: the router registers `/router` once (`name`, `description`, `argumentHint`, `immediate: true`) and never draws the echo, and the engine types say the echo normally carries the arguments. Not yet found whether `immediate` or `argumentHint` causes it. Live recipe: type `/router pin high` while idle, then remove `immediate`, reload, repeat, then restore it and remove `argumentHint`. If neither helps, report it upstream.
- **Spinner shows the route** while the turn runs (`word`, `message`, `suffix` props).
- **Retry on higher** button and an inline `~high` pin (`$.prompt.fill` and a `prompt.submit` strip).
- **Dynamic `/router` description** with `command.describe`.
- **Live checks of the 1.26.0 terminal controls.** Nobody has seen them in a real terminal below 72 columns, or driven the Now tab's pin dropdown (open it, pick a tier, pick **No pin**). Neither has anyone checked on a real desktop app the segmented tab row or the `?` button, which wraps under the tabs in a narrow pane.
- **Agent tool row "Open" button** through the `ToolUse` render component.
- **Progress element.** Once the floor passes 2.1.327, `Progress` replaces the Svg meter in `lib/ui/graphical/meter.mjs`. `session.info()`, per-plugin band rows (`AbovePromptRow`), `session.stop` and `agent.limits` need 2.1.327 too.
- **Route line extras.** The line shows the route and why. Not built: the turn's cost and saving against your model (`≈$0.04 · −$0.11 vs Opus 5.5`), a "was Sonnet 5.5 · high" form for a move, a click that opens a card, and a **Line** control on the pane's Policy tab. The setting is `/router line` only. `$.state` has no delete, so `router.lines` keeps one small record per placed row until the session ends.
- **Agent rows without a record.** The band lists only agents the router has a spawn record for, since those are the ones whose start and end it hears. An agent spawned while routing was off, or one a plugin started, gets no row. Listing them needs `agent.spawn` and `turn.complete` bookkeeping that does not depend on a record. The rows are not toned by model on the desktop, where a Button takes no colour.
- **Live check of the press.** `$.ui.view` works only while the call answers the person's own input. The test engine has no core for `ui.view`, so no test shows that a band press counts as one; confirm it in a live session on the terminal and the desktop app, and that `deny` toasts read well.
- **`/router` typeahead on the desktop.** The types do not say whether a desktop prompt box raises `prompt.autocomplete`; check it live. The typeahead also offers nothing until one character follows `/router `, because the engine's token is never empty.

## Docs

- Desktop screenshots: the README and the user guide show pictures drawn from the component tree, not screenshots of the Claude app. Real shots to take: band, Now, Routes, Policy, Classifier, Usage and the key card, each in dark and light.

## Subagents

- On Claude Code 2.1.321 the debug log shows a `ZodError` (`path model`, expected `sonnet|opus|haiku|fable`) after every routed spawn: the engine's Agent schema accepts aliases only and the router sends the configured full model id on purpose (a family alias resolves to the parent's exact model). The route applies anyway. Read in 1.26.0 work (2.1.327 bundle, minified, so inferred): the engine re-checks permissions on the rewritten input after the hook returns, and that check validates `model` against the alias enum; the spawn itself takes the hook's model with no enum check. The error looks like log noise. A family alias would not name an exact id (the parent's model, or the engine default for another family), so do not switch to it. Live check: `claude --debug-file`, spawn one routed agent, `grep ZodError`, and confirm the agent's transcript `api-request` carries the configured full id.
- The `+N` form of the band's agent rows has not been seen live with two or more concurrent agents.

## Packaging

- The marketplace install clones the whole repository, including tests and experiments. Pointing `marketplace.json` at the published npm package would ship only the 82 allowlisted files. Not tested.
- The npm allowlist could drop `CHANGELOG.md` and the dev-oriented docs.

## Tests and code quality

- `fitSegments` cannot shorten a first segment whose text parts are each no longer than the overflow (a route of short words in a window of about 14 columns); it draws the segment whole.
- `hooks/native-router.mjs` is at about 90.6% branch coverage. The trace-store reset, conflict-merge and lost-write paths need a concurrent-store test harness and an injectable clock.
- Times format in local time, so test files set `process.env.TZ`. A `now` plus a zone option on the formatters would remove that.
- The hover overlay is tested through `left` and `position: 'absolute'`. A band model that returns hover spans as data would let tests drop the layout inference.
- Not split or renamed yet: `hook-pane`, `hook-auto`, `auto-engine`, `config`, `panel`, and the feature-named view tests.
- Strict null checks (`tsconfig.strict.json`): track the remaining error count and fold the flags into `tsconfig.json` at zero.
