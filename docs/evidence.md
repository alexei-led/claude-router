# Model evidence

Auto routing ranks candidates by declared `models.<alias>.capability`. Evidence fills that map for models and
efforts the profile does not declare; unknown stays unknown, and a profile's own declaration always wins.

## Where the data comes from

Two layers:

- **Bundled evidence** (`lib/evidence.mjs`, generated from MIT and CC-BY sources: models.dev, LiteLLM,
  LiveBench, Terminal-Bench, LMArena) ships with the package and is refreshed by the evidence check. The
  generator and data are in place; applying bundled values as default seeds is a separate, reviewed change.
  Today auto routing consumes the local overlay, and a profile's own declarations always win.
- **Local overlay** (`~/.config/claude-router/evidence.local.mjs`) holds data whose terms do not allow
  redistribution. Artificial Analysis is the case: its terms allow personal, noncommercial use with
  attribution, and forbid scraping and redistribution. The overlay is never committed and is never served to
  anyone else.

## Artificial Analysis overlay

### Get a key

1. Create a free account at <https://artificialanalysis.ai/>.
2. Open the Data API docs (<https://artificialanalysis.ai/data-api/docs>) and create an API key.
3. The free tier allows **100 requests per 24 hours** and requires attribution to
   <https://artificialanalysis.ai/>. One full refresh costs one request per page — four today.

### Keep the key outside the repository

The script reads `AA_API_KEY` from the environment first, then from `~/.config/claude-router/aa.env`:

```
mkdir -p ~/.config/claude-router
# write one line: AA_API_KEY=<the key>
chmod 600 ~/.config/claude-router/aa.env
```

Never put the key in the repository, in `router.json`, or in a shell history you share. The script never
prints it; errors name the variable, not the value.

### Refresh the overlay

```
npm run evidence:aa            # refreshes only if the overlay is older than 7 days
npm run evidence:aa -- --force # refreshes now
npm run evidence:aa -- --days=14
npm run evidence:aa -- --help
```

The script fetches the free language-model list, parses the effort from each display name (`GLM-5.3 (Max)`,
`Claude Haiku 5.5 (High)`), maps nine indices and pricing into capability, and atomically rewrites
`~/.config/claude-router/evidence.local.mjs` with mode 600. It refuses more than ten pages, so a changed API
fails loudly instead of spending the daily limit.

### What the overlay holds

- `capability.<effort>` — `{ default, code, debug, ops, explore, plan, review, docs }`, each a half-step
  0..3. `intelligence` feeds the default/explore/plan/review/docs columns; `engineering` feeds
  code/debug/ops; the strategy-and-operations index is recorded in `scores` for later use.
- `scores.<effort>` — the raw intelligence, engineering and strategy-and-operations indices plus the
  published cost per task, so a value can be audited without another request.
- `confidence` — `medium` when the row names its effort, `low` when the free row has no effort suffix and the
  adapter records it at the strongest effort with a note.
- `aliases` — the exact configured ids the canonical model answers to, including namespaced proxy ids.

Capability is derived from the index through the router's existing policy anchors (Haiku 5.5 high = 1,
Opus 5.5 medium = 2, Opus 5.5 xhigh = 3), piecewise-linearly and rounded to a half-step. It is a
benchmark-derived prior, not a measured guarantee for this repository's tasks.

### When to refresh

Weekly is enough: AA updates its evaluations at most daily, and free-tier pages change slowly. A weekly run
uses about 16 requests a month, well under the 100-per-24-hours cap. Do not run it in a loop, do not retry a
failed page more than once, and do not run it more than once a day. The default `--days=7` guard makes an
accidental manual run a no-op.

Example weekly schedule (macOS `launchd` or `cron`), keeping the key in the file above:

```
# Monday 09:17 local
17 9 * * 1  cd ~/Workspace/claude-model-router && npm run evidence:aa >> ~/.config/claude-router/aa-refresh.log 2>&1
```

### Troubleshooting

- **401** — the key is missing, revoked, or has whitespace from a copy-paste. Fix the file, never paste the
  key into a chat or an issue.
- **429** — the 24-hour limit is spent. Wait; the next scheduled run will refresh. Do not retry in a loop.
- **A model missing** — the free tier may not evaluate it yet, or its display name did not match. The adapter
  lists only attested ids; add an alias mapping deliberately.

## Local probe

Public benchmarks do not cover every `(model, effort, activity)` cell: GLM at high, DeepSeek at low, Kimi at
low and high, and the review and docs activities have no direct suite. The probe measures the missing cells
on this machine, against the endpoint the router actually uses.

### How a probe task looks

`data/probes/manifest.json` holds tasks with an `activity` (code, debug, explore, plan, review, ops, docs), a
`tier` (micro, low, medium, high — the router's demand scale), a prompt, a deterministic check (`exact`,
`json-equal`, `contains`, `regex`) and an `estimateUsd` ceiling. Tasks marked `example: true` are scaffolds:
the runner refuses them without `--include-examples`. Write real tasks before measuring; keep checks
deterministic where possible, and grade docs/review with a rubric only as a last resort and at low
confidence.

### Run it

```
# 1. See the cases and the estimated ceiling; spends nothing.
npm run evidence:probe -- --plan --model glm=zai-org/GLM-5.3@max

# 2. Run a bounded probe. Repeat --model for more pairs.
npm run evidence:probe -- --run \
  --model glm=zai-org/GLM-5.3@max \
  --model glm=zai-org/GLM-5.3@high \
  --profile ~/.claude-team \
  --repeats 3 --budget-usd 1

# 3. Re-aggregate an existing raw file without spending.
npm run evidence:probe -- --aggregate ~/.config/claude-router/evidence.probe.raw.json
```

The runner spawns the Claude Code CLI once per case with `--model` and `--effort`, one turn, no tools, and a
per-case budget. It stops before the estimated spend exceeds `--budget-usd`, after `--max-cases`, or after
three consecutive launch errors. Raw rows accumulate across runs (`--fresh` starts over) and the aggregate
lands in `~/.config/claude-router/evidence.probe.{raw,}.json` (mode 600). `--wrapper <zsh-function>` runs
the CLI through a provider wrapper such as `claude-mp-work`.

**Limitation:** a non-Anthropic provider profile cannot be probed through its wrapper yet. Claude Code
validates the session model against the ids it knows, and the router's provider ids (`glm-5.3[1m]`,
`deepseek-flash[1m]`) fail that check; a temporary route-controlled profile loses the provider catalog and
passes the request through. Probe Anthropic models directly today; provider cells come from the Artificial
Analysis overlay, and a direct HTTP probe adapter is the next step.

### How results become capability

For each `(model, effort, activity)` the probe counts passes per tier. Capability is the highest tier whose
pass rate clears 80% with at least three attempts; a next tier that clears 40% adds a half-step. With no
passing tier but enough micro attempts the value is 0; with too few attempts it stays unknown. `default`
aggregates every activity. Confidence grows with attempts: high at 12, medium at 6, low below.

The next `npm run evidence:aa` (use `--force` to bypass the age guard) merges probe results into
`evidence.local.mjs`: a probe value replaces the benchmark prior for the same cell, its statistics are kept
under `probe`, and the entry's `sources` list `probe`. Cells the probe did not measure keep their Artificial
Analysis value.

### When to run the probe

On demand, not on a schedule: after adding a model or effort, after a provider changes a snapshot, or
quarterly. Keep the task set fixed between runs so values are comparable; add tasks deliberately and
re-run the affected pairs rather than the whole grid.

## Limits

The overlay is personal routing input. It is not redistributed, not committed, and not used to build a
competing dataset or service. Anything shipped in the package comes from the MIT/CC-BY sources listed above.
