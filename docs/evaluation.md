# Evaluation

The native Mod has no measured savings result. The pane reports Claude's own usage and configured-price scenarios. It does not maintain a counterfactual bill or a cumulative savings total.

This page separates an older gateway experiment from a shadow replay of native policy. Neither result measures answer quality or proves lower real spend. [Activity routing](#activity-routing) adds two checks of the activity label, with no savings result either.

## Historical gateway experiment

These figures are retained from the earlier gateway implementation. They do not evaluate the native Mod or its current routes. The snapshot covers 26 Claude Code sessions and 1,611 requests from 2026-09-23 09:05 UTC through 2026-09-24 06:00 UTC. Jev advised on 111 prompts.

![Historical gateway model share and configured-price costs](tier-share.svg)

The original list-price comparison was:

| Scenario                                        | Estimated cost | Difference from router |
| ----------------------------------------------- | -------------: | ---------------------: |
| Always Opus at `xhigh`                          |        $166.26 | Router was 15.5% lower |
| Strongest model selected for each whole session |        $146.54 |  Router was 4.1% lower |
| Earlier gateway router                          |        $140.55 |                      — |

The session-level baseline assumes a user knows the strongest tier needed by each session and uses it for every request. All scenarios reuse the router's token and output counts. The estimate holds stronger-model output constant, so it does not capture any change in output length. The [original evaluation method](#historical-method-and-limits) lists the limits.

This is one developer's short trace at configured list prices. It does not include a quality review. Do not use these values as expected results for the native Mod.

## Native shadow replay

The native replay uses an aggregate Team-session trace from 2026-09-23 through 2026-10-04. The checked-in result is [`trace-evaluation.json`](../experiments/mod-router/results/trace-evaluation.json), produced by [`trace-eval.mjs`](../experiments/mod-router/scripts/trace-eval.mjs).

| Coverage item                                               |                            Result |
| ----------------------------------------------------------- | --------------------------------: |
| Team rows                                                   |        24,408 across 112 sessions |
| Main-conversation decision rows                             |                            11,619 |
| Main decisions with Jev advice                              |                                37 |
| Advised decisions replayed at both cache-prefix bounds      |                          37 of 37 |
| Decisions with a different route or reason between policies |                           0 of 37 |
| Differing switches and estimated switch cost                | 0; no switch cost can be computed |

The legacy replay matched the logged tier and reason for 1,704 of 1,704 replayable decisions. On the 37 advised main decisions, both policies produced the same route and reason. This replay therefore shows no native routing difference and cannot support a savings claim.

Eight advised decisions reached a switching-cost threshold calculation. The native configured-price tax ranged from $0.028660 to $3.471293 and the threshold from 0.860483 to 0.953675. These are shadow estimates for individual next requests, not bills or additive savings.

The old log records cache reads but not uncached input or cache-creation tokens. The native replay tests two prefix bounds: cache reads alone and the full observed input. All 37 decisions matched at both bounds. That is a bound-stability check, not an exact reconstruction of native cache state.

### Reproduce the native replay

Run this command with the Team `decisions.jsonl` log available in its usual Claude Code profile:

```sh
node experiments/mod-router/scripts/trace-eval.mjs
node --test experiments/mod-router/scripts/trace-eval.test.mjs
```

The script writes aggregate counts, reason histograms, route transitions, and shadow estimates. It excludes prompts, session identifiers, agent names, error text, headers, keys, and filesystem paths from the result. It reads the local profile log and writes the JSON result file.

## Activity routing

Activity routing has no measured result. The replay above predates it and covers tiers only. The pane counts turns, requests, switches, and the turns `on` would route differently, and it shows no dollar figure for them. Two checks look at the classifier's activity label.

### Tool agreement

Each finished turn is labelled from the tools the assistant used, locally and at no cost. Only the bucket and counts are kept; no text or path is stored.

| Observed bucket | Rule, first match                                                                                                                           |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `code`          | An edit tool (`Edit`, `Write`, `MultiEdit`, `NotebookEdit`) on a path that is not a doc path                                                |
| `docs`          | Edits only to paths ending `.md`, `.mdx`, `.rst`, or `.txt`, or under a `docs/` directory                                                   |
| `ops`           | A Bash command that is not read-only                                                                                                        |
| `read`          | Other tool use: reads, searches, web fetches, and Bash commands that only read, such as `ls`, `grep`, `cat`, or `git status` and `git diff` |
| `talk`          | No tool calls                                                                                                                               |

A Bash command counts as read-only only when every command in the pipeline or list is on a short list of readers. Redirects, command substitution, and `find` with `-exec` or `-delete` are not read-only, and neither is any command the list does not name.

The classifier's activity agrees with the turn when the bucket is one it allows:

| Activity  | Allowed buckets        |
| --------- | ---------------------- |
| `code`    | `code`                 |
| `debug`   | `code`, `ops`, `read`  |
| `explore` | `read`, `talk`         |
| `plan`    | `talk`, `read`, `docs` |
| `review`  | `read`, `talk`         |
| `ops`     | `ops`                  |
| `docs`    | `docs`                 |

Agreement is a weak check. It tells `ops` from `code` from `explore` well. It cannot tell `plan` from `review`, and it says nothing about whether the route was good enough. It does catch the costly mistake, a cheap route on a coding turn. The Usage tab shows the session's count as `Agreement`, over the turns that had an activity. The counts kept across sessions hold the classifier's raw answer, `uncertain` and no answer included, against the bucket. They are not shown in the pane.

### Activity probe set

`test/fixtures/activity-probe.json` holds 70 synthetic prompts, ten for each activity, weighted to the boundary cases: "fix the deploy script" against "deploy the fix", "why does the test fail" against "make the test pass", short replies after a dialogue, and a review followed by a fix. It holds no real user text.

```sh
node scripts/probe-activity.mjs [classifier]
```

The script sends each prompt to one classifier as the router would ask it, with activity routing forced to `shadow`. It reads credentials as `probe-classifier.mjs` does and needs a classifier you can reach. The run is billed on a paid classifier, and it is run by hand, not in CI. It writes accuracy, an expected-by-answered confusion matrix, p50 and p95 latency against the classifier's deadline, and error counts to `experiments/mod-router/results/activity-probe-<classifier>.json`. For Ollama the latency covers both requests. It never prints a key.

No probe result is checked in yet, so this page states no accuracy or latency for any classifier, and the pane shows none. `policy.activityMass` was not tuned on any classifier; run the probe before you trust it with a new one.

## Historical method and limits

- Costs use configured USD list prices per million tokens. They are not subscription cash charges.
- The older gateway baseline uses the router's observed tokens and cache reads. After a route change, the baseline assumes the prior context can be read from cache.
- The native replay uses the current default routes and prices, with recorded model IDs substituted. It compares the native cost bounds with a legacy cost model using the same policy state and trace facts.
- The replay cannot reconstruct exact native cache prefixes or one-hour cache evidence from the old log. The native cache model treats TTL as unknown.
- The replay applies the legacy state chain to both policy arms. It does not simulate later state changes after a different decision.
- Failure signatures and pins are not present in the trace. The relevant route decisions are excluded from comparison.
- Most main rows are tool continuations or have no Jev advice. Only 37 advised decisions support the native comparison.
- Costs cover the next request. They use the last observed output size and do not model effort-dependent output length or future answer quality.
