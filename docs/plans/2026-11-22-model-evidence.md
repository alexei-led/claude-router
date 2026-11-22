# Model evidence: benchmark-derived routing data

**Status:** draft for review. No code, configuration or data is changed by this document.

## Why

`auto` ranks candidates by declared `models.<alias>.capability`, and every value is typed by hand. The
presets seed only four Anthropic pairs; other providers and most efforts are unknown. Unknown is not zero,
so auto falls back to the cheapest unknown — the degenerate outcome the capability notice warns about.

The original automatic-routing design already names the intended source: "Built-in values ship with the
provider presets, sourced from model-cards and benchmark results, each with a note of the source"
([2026-11-16-auto-routing-design.md](2026-11-16-auto-routing-design.md) §5). This plan builds that source as
a generated, checked-in dataset instead of manual edits.

The model-cards knowledgebase explicitly does not convert benchmarks into adequacy tiers; it calls any such
mapping a provisional policy hypothesis. This plan keeps that framing: evidence values are **benchmark-derived
policy priors with provenance and confidence**, never measured task adequacy. Unknown stays unknown.

## What the router needs

| Field | Used by | Source |
| --- | --- | --- |
| `capability` per effort and activity, 0..3 half-steps | `capabilityOf`, `selectTarget`, `decideMove` | benchmark aggregation; optional local Artificial Analysis overlay |
| input/output/cacheRead, longContext, offPeak | `cost.mjs`, switching tax, cash cap | `lib/prices.mjs` (already generated from vendor pages) |
| cache write multiplier | `coldWriteUsd`, `inputBounds` | config `cache.writeMultiplier` (explicit mode); automatic providers derive it from input |
| contextWindow | context-full filter | model catalog / provider docs |
| imageInput | images filter | model catalog |
| efforts | candidate enumeration, validation | effort-support fixture / provider docs |
| speed, TTFT (optional) | future policy; not read by the engine today | AA / provider pages |

Pricing and catalog metadata already have generated or probed sources. The gap is capability: per model,
per effort, per activity.

## Data model

Generated file `lib/evidence.mjs`, same pattern as `lib/prices.mjs`:

```js
export const EVIDENCE_SOURCES = {
  artificial_analysis: { url: '…', checked: '2026-11-22', snapshot: '2026-11-22' },
  livebench: { url: '…', checked: '2026-11-22', snapshot: '…' },
  // one entry per adapter; a source that fails to fetch blocks --write, never silently skips
};

export const EVIDENCE = {
  'zai-glm-5.3': {
    aliases: ['zai-org/GLM-5.3', 'zai-org/GLM-5.3[1m]', 'glm-5.3[1m]'],
    checked: '2026-11-22',
    scores: { aa_intelligence: 57, terminalbench_v4: 42.1, swe_bench_verified: 71.2 },
    capability: {
      low: { default: 1, code: 1, ops: 1 },
      max: { default: 2.5, code: 2.5, ops: 2, docs: 1.5 },
    },
    confidence: { low: 'medium', max: 'medium' },
    sources: ['artificial_analysis', 'terminalbench'],
  },
};
```

- Keys are canonical model ids (`[1m]` stripped); `aliases` carry the exact configured ids, including
  namespaced proxy ids.
- `scores` keeps the raw inputs, so a reviewer can recompute any value without refetching.
- `capability` keys are supported efforts, or `default` for a model with `efforts: []`. Values are numbers or
  `{ default, code, debug, explore, plan, review, ops, docs }` objects; a missing activity falls back to
  `default`.
- `confidence` is `high | medium | low`: direct per-effort measurement, derived from a model-level score, or
  interpolated across anchors.
- `sources` records which adapter produced each row.

### Calibration

The router scale is demand adequacy: 0 micro, 1 low, 2 medium, 3 high, half-steps allowed. Benchmarks give
scores, not adequacy. The mapping is anchored to existing lead-approved policy seeds (for example Haiku
`high: 1`, Opus `xhigh: 3`) and documented as a policy prior:

1. Normalize each metric to a percentile across the reference models measured in the same snapshot.
2. Compose activity scores as a fixed weighted mean of the metrics that activity uses (weights in one table
   in the generator, reviewed with the data).
3. Fit one monotonic mapping per activity through the anchor pairs; round to half-steps.
4. Fill only unknown cells. A user-declared `capability` map continues to replace the evidence map in full.

No interpolation across efforts: a model measured at one effort gets a value for that effort only. Lower or
higher efforts stay unknown unless the source measured them. This is the existing "no universal effort
curve" rule.

Activity weights (proposal; sources per row are confirmed by the research matrix before implementation):

| Activity | Candidate metrics |
| --- | --- |
| code | SWE-bench Verified / Pro, Terminal-Bench, AA coding index, LiveCodeBench |
| debug | SWE-bench (fail-to-pass), AA reasoning, GPQA |
| explore | AA intelligence index, MMLU-Pro, GPQA |
| plan | AA intelligence index, GPQA, IFBench |
| review | code metrics + IFBench (weak evidence; `low` confidence) |
| ops | Terminal-Bench, tool-use / agentic benchmarks |
| docs | writing / instruction-following benchmarks (weak evidence) |
| default | AA intelligence index weighted by availability |

## Integration

1. **Seeds in the catalog.** `loadConfig` resolves each model's canonical id against `EVIDENCE` and uses its
   `capability` map when the user file declares none, exactly as preset seeds work today
   (`lib/config.mjs:316-330`). A user-declared map replaces the evidence map atomically; changing a model id
   clears inherited evidence, as today.
2. **Per-activity capability.** `models.<alias>.capability` values accept a number or an activity object; the
   validator (`lib/config.mjs:860`) checks keys, half-steps and supported efforts. `capabilityOf`
   (`lib/auto-engine.mjs:140`) takes the activity the decision uses and falls back to `default`.
3. **Activity source.** The activity is the one `takeAutoAdvice` accepts for the turn, persisted in
   `loop.auto.activity`; continuation steps reuse it. With `activityRouting: off`, the default key applies.
4. **Escalation and move gates.** All capability comparisons within one decision use the same activity, so
   "strictly stronger" stays meaningful.
5. **Traces and replay.** `replay-trace.mjs` records the resolved capability per candidate (numbers or
   activity objects) and the activity used; replay rebuilds the same model catalog from the trace. Trace
   schema versions bump if the projection changes.
6. **Diagnostics.** `/router decisions` and the pane show the source and confidence of a capability when it
   came from evidence; unknown remains visibly unknown. The unknown-only toast stays.

## Embedding and refresh

**Ship generated data in the package. Never fetch at runtime.** The hook and `lib/` stay pure and
deterministic; replay and tests must not depend on the network.

Three layers, highest precedence first:

1. **User config** — `models.<alias>.capability` in the profile. Replaces the layers below in full, as today.
2. **Local overlay** — evidence from sources whose terms do not allow redistribution. The Artificial Analysis
   free API is the case: `AA_API_KEY` in the environment, one adapter run writes
   `~/.config/claude-router/evidence.local.mjs` (never committed, never printed). The router reads it if it
   exists and merges its values only where layers 1 and 3 have none. Attribution is kept in the file header.
   Free tier is 100 requests/24h; the language-model list is paginated, so a full refresh is a handful of
   requests. Rows carry effort in the display name (`"GLM-5.3 (Max)"`) on the free tier; the Pro tier's
   explicit `effort` field and per-benchmark rows are used when the key has that access.
3. **Bundled data** — `lib/evidence.mjs`, generated from MIT/CC-BY sources only (models.dev, LiteLLM,
   LiveBench, Terminal-Bench, LMArena, AutoBench, LLMRouterBench), with filtered snapshots and hashes under
   `data/evidence/`. Safe to publish.

Refresh:

- `scripts/check-evidence.mjs` fetches each bundled source into a dated snapshot, computes
  `lib/evidence.mjs`, and reports the diff; `--write` rewrites it, formatted by Biome, like
  `scripts/check-prices.mjs`. `--local` runs the AA adapter against the key and writes the overlay.
- A scheduled workflow runs the bundled check weekly and opens a PR with the regenerated file and snapshots.
  A source that cannot be fetched fails the check; a renamed table fails loudly instead of producing wrong
  values.
- model-cards stays a cross-check for identity, aliases and pricing provenance, not a build dependency.

Alternatives rejected: fetching GitHub at runtime (network in the routing path, non-reproducible replay,
supply-chain risk); a separate npm data package (extra dependency for one JSON file); scraping AA or
OpenRouter (their terms forbid automated copying, and AA-derived rows would be redistributed by a public
repository).

## Probabilistic routing per turn — recommendation

Sampling a model per turn from benchmark-derived probabilities is not recommended for live routing in v1:

- Random switching pays cache-cold costs and makes a turn's route non-reproducible. A seeded PRNG restores
  replayability but not the cost.
- Benchmark scores do not estimate `P(adequate | model, effort, activity, task)` for this repository's tasks;
  using them as probabilities would dress a policy prior as a measurement.

Recommended instead:

1. **Deterministic risk-adjusted scoring.** Convert evidence into a per-candidate confidence (for example, a
   calibrated curve from composite percentile to adequacy probability); rank by expected cost including the
   probability and cost of rework. Deterministic, replayable, testable.
2. **Shadow distribution.** In shadow, log the top-k candidates with probability and cost so the alternative
   is visible and accumulates evidence.
3. **Sampling only as an experiment**, behind an explicit setting and a PRNG seeded from session and turn, in
   shadow first.

## Plan

1. Source matrix and adapters (research in progress). Each adapter: fetch, parse, fixture, provenance.
2. Snapshot layout, schema validator and `scripts/check-evidence.mjs --write`.
3. Calibration module with anchors and the activity weight table; generated `lib/evidence.mjs` for the
   preset models.
4. Config and engine: activity-aware capability, seeds, traces, replay, decisions display.
5. Tests: adapter fixtures, calibration invariants (monotonic, half-steps, unknown stays unknown), engine
   activity selection, config validation, replay round-trip.
6. Docs (`configuration.md`, `providers.md`, `evaluation.md`) and a CHANGELOG entry under `## Unreleased`.

## Open questions

- Which public sources are stable enough for CI and how their snapshots are filtered (the source matrix is
  being verified by the adapters workflow).
- Whether the free AA tier exposes per-effort rows as separate display names; the overlay adapter records
  what it actually receives.
- Whether the anchor set should include the user profiles' declared values or only built-in policy seeds.
