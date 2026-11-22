# Model evidence

Auto routing ranks candidates by declared `models.<alias>.capability`. Evidence fills that map for models and
efforts the profile does not declare; unknown stays unknown, and a profile's own declaration always wins.

## Where the data comes from

Two layers:

- **Bundled evidence** (`lib/evidence.mjs`, generated from MIT and CC-BY sources: models.dev, LiteLLM,
  LiveBench, Terminal-Bench, LMArena) ships with the package. It can be published and is refreshed by the
  weekly evidence check.
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

## Limits

The overlay is personal routing input. It is not redistributed, not committed, and not used to build a
competing dataset or service. Anything shipped in the package comes from the MIT/CC-BY sources listed above.
