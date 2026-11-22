# Activity benchmarks: public sources for capability evidence

**Status:** research note for the evidence workstream, 2026-11-22. This document changes no code,
configuration or data. It answers one question: which public benchmarks can fill the per-activity,
per-effort `capability` cells that [2026-11-22-model-evidence.md](2026-11-22-model-evidence.md)
needs, under a license that allows a public repository to bundle a snapshot.

## Why this note

`auto` compares declared `capability` per model and effort. The bundled evidence pipeline already
has three score feeds (Terminal-Bench, LiveBench, LMArena) plus catalog and price data. The misses
are not random: they cluster on activities where no per-effort public leaderboard exists, and on
providers whose rows the big leaderboards do not carry.

This note records what was verified on 2026-11-22, what is missing, and a ranked shortlist of two
or three sources to add. It deliberately separates "has a public dataset" from "publishes current
per-model scores", because only the second kind can feed a generated `lib/evidence.mjs` without
running evaluations locally.

## Acceptance rules

A source is usable for the bundled layer only when all of these hold:

1. **Machine-readable.** JSON, CSV or another parseable export with a stable endpoint. A chart in a
   web page is not data.
2. **Redistribution-safe.** MIT, Apache-2.0, CC-BY-4.0, ODC-BY-1.0 or equivalent. No
   "all rights reserved", no unlicensed repository, no gated terms that forbid resharing.
3. **Current model coverage.** At least one row for a configured router model, ideally all six.
4. **Per-effort coverage.** Rows that distinguish low, medium, high, xhigh or max. Model-level
   aggregates are acceptable only as `medium`-confidence priors.
5. **Freshness.** A snapshot from the last three months for an active leaderboard; older data is
   marked and used only with lower confidence.
6. **Adapter cost.** Fetch, parse, validate and fixture in this repository, without a browser
   automation stack or paid evaluation run.

Out of scope by instruction or terms: **Artificial Analysis** and **OpenRouter** data may not be
fetched or bundled (their terms forbid automated copying and redistribution). They are named here
only as unavailable.

## Router models and configured efforts

| Family | Configured ids | Efforts |
| --- | --- | --- |
| Claude 5.5 | Opus 5.5, Sonnet 5.5, Haiku 5.5 (Anthropic preset) | low, medium, high, max |
| GLM-5.3 | `glm-5.3[1m]`, `glm-5.3-flash[1m]` | low, high, max |
| DeepSeek V4.1 | `deepseek-flash[1m]` (hosted V4.1 Flash 1017) | low, high, max |
| Kimi K3.1 | `kimi-k3.1-pro[1m]` | low, high, max |
| MiniMax M3.1 | `MiniMax-M3.1-Flash[1m]` | low, medium, high, max |
| MiMo V2.6 | `mimo-v2.6-flash[1m]`, `mimo-v2.6-pro[1m]` | none (default thinking only) |

Coverage counts below are by family, not by exact id. A family counts as covered when the source
publishes a row for at least one router-usable revision; the per-id footnote says what is missing.

## Coverage at a glance

| Source | Activities it can fill | Format | License | Effort rows | Router families | Freshness | Verdict | Adapter cost |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Terminal-Bench 4.x | code, ops, plan, debug (weak) | JSON per submission | Apache-2.0 | `reasoning_effort`: max/none in snapshot | 5/6 | 2026-11-12 | bundled | done |
| LiveBench 2.0 | code, explore, plan/reasoning | CSV + JSON | Apache-2.0 (code/results) | no | 6/6 | 2026-11-22 | bundled | done |
| LMArena | explore, plan, ops | JSON history | CC-BY-4.0 (recorded) | variant names (High/Max/xHigh) | 6/6 | 2026-11-19 | bundled | done |
| **ReviewBench** | **review, debug-adjacent** | **JSON API** | **MIT** | **config identity (model/effort)** | **2/6** | **2026-10-26** | **add (1)** | **S-M** |
| **harnesseval** | **review** | **JSON per run** | **MIT** | **explicit low..xhigh** | **3/6** | **2026 campaign** | **add (2)** | **M** |
| **tau2-bench** | **ops, plan (multi-turn)** | **JSON submissions** | **MIT** | **`reasoning_effort`** | **4/6, older revs** | **2026-11** | **add (3)** | **S** |
| SWE-bench Pro | code, debug | dataset only; scores web | MIT code / Apache-2.0 data | no | 1-2/6, unverified | 2026-09 | watch | L |
| LiveCodeBench | code | submissions + HTML | MIT | no | unverified | active | watch | L |
| SWE-bench Verified | code, debug | dataset | MIT | no | older | retired 2026-02 | reject | - |
| BFCL | ops, plan | CSV snapshots (stale) | Apache-2.0 | no | 0/6 current | 2025-12-16 | reject for now | L |
| WritingBench | docs | XLSX leaderboard | Apache-2.0 | no | 0/6 | 2025-11 | conditional | S (stale) |
| DeepResearch Bench | explore | JSONL + HF Space | Apache-2.0 | no | 0/6 raw | 2026-02 (v2) | watch | M |
| DoGBench | docs | partial dataset | none stated | no | older | 2026-09 | reject | - |
| DebugBench | debug (probe) | JSON dataset | Apache-2.0 | no | 0/6 | 2024 | probe | L |
| Natural Plan | plan (probe) | JSON dataset | Apache-2.0 / CC-BY-4.0 | no | 0/6 | 2024 | probe | M |
| GPQA | plan, debug (probe) | gated dataset | CC-BY-4.0 | no | run locally | 2023 | probe | L |
| GAIA, BrowseComp | explore | gated/encrypted | none stated | no | - | - | unavailable | - |
| LLMRouterBench | router policy | JSON results | no LICENSE | - | - | 2026-01 | reject | - |
| AutoBench | router policy | web/YAML | Apache-2.0 | - | - | 2026 | reject for capability | - |

"Adapter cost": S is under half a day, M is half to one and a half days, L is two to four days,
XL is a paid evaluation campaign.

## Per-activity findings

### code

**Covered by the bundled set.** Terminal-Bench is the strongest source: agentic terminal tasks,
per-submission JSON, `reasoning_effort`, 26 usable rows and all six router families except MiniMax.
LiveBench `coding` adds a second, cheaper signal with all six families but no effort rows. LMArena
`agent_overall` is a third view but measures the harness as much as the model.

**Gap.** Effort coverage is thin. Terminal-Bench rows are mostly `max` (or `none` for MiMo and
Hy4); low and medium are absent. A model measured only at max cannot fill its low or high cells,
and the existing rule ("no interpolation across efforts") leaves them unknown.

**No new source needed.** ReviewBench and harnesseval do not measure code generation. SWE-bench
Pro would add long-horizon code but publishes no machine-readable score export (see below), so it
does not beat the bundled pair for adapter effort.

### debug

**Weakest evidence after review and docs.** No public leaderboard measures debugging per model,
per effort and with current revisions.

- SWE-bench Verified was the canonical fail-to-pass signal and is **retired**: OpenAI announced in
  February 2026 that it no longer measures frontier coding because of flawed tests and
  contamination, and points to SWE-bench Pro instead (claim recorded from secondary coverage; see
  "Unverified claims").
- SWE-bench Pro (V2) is the successor, but the public leaderboard is a client-rendered page with
  no documented JSON or CSV export. The dataset is downloadable; the scores are not. Adapter cost
  is L, and the public split's task repositories are reported to carry GPL-family licenses (not
  independently verified), so a bundled snapshot of task text is not safe either.
- DebugBench is Apache-2.0 and has 4,253 instances across C++, Java and Python, but its published
  results are GPT-4-era, it needs a LeetCode judge account, and it has no leaderboard. It is a
  probe candidate, not a score feed.
- Terminal-Bench pass@2..pass@5 and the trial success distribution are the best available
  degradation signal for debug. Use them as a low-weight proxy, not as a debug measurement.

**Recommendation:** leave debug at low confidence or unknown. Add probe tasks for it; do not
import a stale benchmark to create the illusion of coverage.

### explore

**Covered indirectly.** LMArena `agent_overall` (rank, score, cost per task, output tokens per
task) is the closest public measure of sustained exploration, and the snapshot carries all six
families with effort variants for Claude and DeepSeek. LiveBench `research`, `data_analysis` and
`browser` add category scores, but at model level and without effort.

**Gap.** No benchmark isolates "read a repository and find the relevant code" for coding agents.
BrowseComp and GAIA are the natural web-exploration benchmarks but cannot be bundled: BrowseComp's
questions are XOR-encrypted with a no-reshare request and no open license; GAIA is gated, declares
no license, and forbids resharing validation or test splits.

**Optional addition:** DeepResearch Bench (Apache-2.0, 100 PhD-level tasks, RACE and FACT scores)
measures report quality and citation trust, not codebase exploration. Its leaderboard rows are
agent-level and the current-model coverage is thin. Keep it on the watch list, not the shortlist.

### plan

**Covered weakly.** LMArena text and agent ratings and LiveBench `reasoning` are the bundled
proxies. Terminal-Bench long-horizon tasks exercise planning implicitly but do not score a plan.

**Candidates:**

- tau2-bench (MIT) has multi-turn tool use in airline, retail and telecom domains, a
  `reasoning_effort` field per submission, and a JSON schema plus manifest. It is the cheapest
  machine-readable addition for multi-turn plan/ops behaviour, but its task domains are customer
  service, not software engineering, and its router-model rows use older revisions.
- BFCL (Apache-2.0) measures function calling (single-turn, live, multi-turn, irrelevance,
  hallucination). It is the most relevant tool-use benchmark for an agentic router, but the last
  official snapshot in `HuanzhiMao/BFCL-Result` is 2025-12-16 and contains Claude 4.5, GLM-4.6,
  Kimi K2 and DeepSeek V3.2, not the November 2026 models. It also has no effort field.
- Natural Plan (Apache-2.0 code, CC-BY-4.0 materials) is a clean, small, deterministic planning
  dataset (trip planning, meeting planning, calendar scheduling) that can be run locally on the six
  models. It publishes no current leaderboard, so it belongs in the probe manifest, not the
  bundled feed.

**Recommendation:** add tau2-bench as a low-confidence ops/plan signal; treat BFCL as stale until
it publishes a current snapshot; use Natural Plan tasks in the local probe if plan cells need
direct measurement.

### review

**One benchmark exists; it does not cover four of six router families.** This section is the
core finding of the note.

- **ReviewBench** (GitHub, announced October 2026) is the first credible public code-review
  benchmark. It has 219 real pull requests from 187 open-source repositories in 19 languages,
  maintainer-reviewed golden findings, and a 25-PR public test subset. The repository is MIT.
  A public JSON API exists, which makes it the only review source with a low-cost adapter.
- **harnesseval** (dsifry) is a model-by-harness-by-effort review campaign with 147 test-proven
  bugs, eight models, three harnesses and explicit low/medium/high/xhigh rows. It is MIT and
  publishes per-run JSON. It is the only review source that crosses efforts, but GLM-5.3 is a
  sidebar and the other four router families are absent.
- Academic review benchmarks (CR-Bench-v2, AACR-Bench, SWE-PRBench, CodeWikiBench) are useful
  reading but none publishes a redistributable per-model leaderboard. Several are paper-only or
  have no repository license. Treat them as context, not data.
- No source measures review for GLM-5.3, Kimi K3.1, MiniMax M3.1 or MiMo V2.6. This is the
  clearest "no benchmark exists" cell in the router.

**Important attribution rule.** ReviewBench rows are agent-plus-configuration rows, not raw model
rows. A row may be Copilot with three effort settings, Codex with a model and reasoning setting, or
a product with an undisclosed model. Only rows whose `configurationIdentity` names a model (and,
where present, an effort or reasoning field) may feed capability. Product-only rows must stay out;
they would attribute a harness result to a model the router might select.

### ops

**Best covered activity.** Terminal-Bench is close to the activity: real terminal tasks, an agent,
cost and trials. The snapshot has five of six families and max/none effort rows. tau2-bench adds
tool-call-heavy multi-turn behaviour in non-coding domains; BFCL would add function-calling detail
but is stale.

**Gap.** No public leaderboard isolates operational work on a repository (deploy, logs, CI) with
per-effort rows. Terminal-Bench remains the anchor; tau2 is a secondary prior.

### docs

**No usable public benchmark.** This is the second "no benchmark exists" cell.

- **DoGBench** (September 2026) is the exact activity: 292 real documentation items, 205 requiring
  a patch and 87 requiring abstention, 3,273 maintainer-validated rubric criteria. But the
  held-out rubrics, references and item-level scores are private, the development split has no
  stated license, and only seven agent lanes were scored. It cannot be bundled.
- **WritingBench** (Apache-2.0, 1,000 queries, six domains, five criteria per query) is the only
  permissively licensed writing benchmark with a public leaderboard. Its leaderboard is a
  `score.xlsx` in a Hugging Face Space and its newest rows are from the Claude 3.7 / o3 / Grok 3
  era. Coverage of the six router families is zero. Scraping it would add no usable cell.
- **CodeWikiBench** and similar repository-wiki benchmarks have no declared license and no
  current-model leaderboard.
- IFBench (Apache-2.0 code, ODC-BY-1.0 data) and IFEval measure instruction following, not
  documentation quality, and publish no official per-model table.

**Recommendation:** docs stays unknown until the local probe measures it. Do not add WritingBench
to the bundled layer; it is stale and measures general prose, not technical documentation. If a
public source is required, the honest answer is that none exists under a redistributable license
with current-model rows.

## Source dossiers

### Terminal-Bench (bundled)

- **URL:** `https://github.com/harbor-framework/terminal-bench` (submissions under
  `leaderboard/submissions/`); task suite `https://github.com/laude-institute/terminal-bench`.
- **Format:** one JSON file per submission; the current snapshot flattens them into 26 rows.
- **Fields:** `model_id`, `model_label`, `model_org`, `reasoning_effort`, `date`, `release_date`,
  `submission_date`, `agent`, `agent_version`, `leaderboard_version`, `source_file`,
  `n_disqualified_trials`, `preferred`, `m_accuracy`, `m_accuracy_ci95_half_width`, `m_n_trials`,
  `m_successes`, `m_total_cost_usd`, `m_total_tokens`, `m_uncached_input_tokens`,
  `m_cached_input_tokens`, `m_output_tokens`, `m_pass_at_2`, `m_pass_at_3`, `m_pass_at_4`,
  `m_pass_at_5`, `m_avg_trial_duration_sec`.
- **License:** Apache-2.0 (verified against the raw `LICENSE` in both repositories).
- **Freshness:** submissions dated through 2026-11-12 (regrade round 4.1.0); snapshot 2026-11-22.
- **Effort coverage:** `max` for Claude, GLM, Kimi, DeepSeek, OpenAI and Mistral rows; `none` for
  MiMo and Hy4; `high`/`xhigh` for some Gemini rows. No low or medium rows.
- **Router coverage:** Claude Opus/Sonnet/Haiku 5.5, GLM-5.3 and GLM-5.3-Flash, Kimi K3.1 Pro,
  DeepSeek V4.1 Flash 1017, MiMo V2.6 Flash/Pro. MiniMax M3.1 is absent.
- **Adapter:** already implemented. The only work left is de-duplicating regrade submissions
  (`-regrade` files restate an earlier run) and ignoring rows whose agent is not the configured
  harness when the router would run a different one.

### LiveBench (bundled)

- **URL:** `https://livebench.ai`; snapshot under `data/evidence/2026-11-22/livebench/`.
- **Format:** `table.csv` (one row per model, category columns), `categories.json` (category map
  and overall weights), `breakdown.json` (task parts and glosses), `cost.csv`.
- **Fields:** `model` plus `long_agentic`, `reasoning`, `coding`, `browser`, `data_analysis`,
  `research`, `design`; category groups in `categories.json`; overall weights (Long Agentic 2.0,
  Coding 1.5, Design 1.5).
- **License:** Apache-2.0 for code and results (verified from the raw `LICENSE`; the header notes
  it is inherited from FastChat). The question set has separate usage expectations and is not
  bundled.
- **Freshness:** 2026-11-22 snapshot.
- **Effort coverage:** none. Effort is not a dimension in the table.
- **Router coverage:** Claude Opus/Sonnet/Haiku 5.5, DeepSeek V4.1 Flash, GLM-5.3-Flash, Kimi
  K3.1 Pro, MiniMax M3.1 Flash, MiMo V2.6 Pro. GLM-5.3 (non-Flash) and MiMo Flash are absent.
- **Adapter:** already implemented. Category weights should be reviewed with the calibration table,
  not hard-coded twice.

### LMArena (bundled)

- **URL:** recorded source `https://lmarena.ai`; snapshot under
  `data/evidence/2026-11-22/lmarena/router-models.json`.
- **Format:** `history.<base model>.<variant>.{text_overall, agent_overall}`, each an array of
  dated observations.
- **Fields:** `publish_date`, `rank`, `rating` (text); `publish_date`, `rank`, `score`,
  `cost_per_task_p50`, `output_tokens_per_task_p50` (agent).
- **License:** the snapshot records CC-BY-4.0. The upstream terms page is a client-rendered shell;
  the license was **not re-verified on 2026-11-22** beyond the snapshot metadata. Confirm before
  the first public release of a bundle that includes it.
- **Freshness:** observations through 2026-11-19.
- **Effort coverage:** variant names: Claude Opus 5.5 (High, Max), Sonnet 5.5 (High, Max, xHigh),
  Haiku 5.5 (High), DeepSeek V4.1 (Max, High), GLM-5.3 (Max), Kimi K3.1 (Max), MiniMax and MiMo
  (default only). No low rows.
- **Router coverage:** all six families; exact ids vary by display name.
- **Adapter:** already implemented. Prefer `agent_overall` for explore/ops and keep `text_overall`
  for general capability; do not mix the two scales in one percentile.

### ReviewBench (recommended 1)

- **URL:** `https://review-bench.ai`; leaderboard API `https://review-bench.ai/api/leaderboard`
  (and `/api/leaderboard/metrics`); code `https://github.com/review-bench/ReviewBench`.
- **Format:** JSON. `reviewerMetrics[]` with one object per row. Golden findings are one JSON file
  per pull request under `golden/`.
- **Fields:** `id`, `rank`, `name`, `tableName`, `configurationDisplayLabel`,
  `configurationLabel`, `configurationIdentity`, `snapshotDate`, `durationMs`,
  `groundedPrecision`, `groundedRecall`, `augmentedPrecision`, `augmentedRecall`, `novelYield`,
  `augmentedF1`, `novelTruePositives`, `candidates`, `profile`, `rounds`, `measuredAt`,
  `featured`, `commentsPerPr`. Golden finding fields: `file`, `start_line`, `end_line`,
  `message`, `tp_fp`, `severity`, `category` (correctness, security, reliability, maintainability,
  testing), `scope`, `difficulty`, `context_required`, `producer`, `source`, plus justifications.
- **License:** MIT (verified from raw `LICENSE` and the README's explicit statement that the
  dataset, judge prompt and runner are MIT).
- **Freshness:** 42 leaderboard rows with snapshot dates from 2026-06-16 to 2026-10-26; most rows
  are from October 2026 and the Claude 5.5 rows are the newest. This is current relative to the
  November 2026 model set.
- **Effort coverage:** partial and explicit in `configurationIdentity`. Codex rows carry
  `reasoning=max` / `xhigh`; Copilot rows carry `effort=high|medium|low`; DeepSeek Harness Reviewer
  carries `model=deepseek-flash` with `effort=high`; Claude rows are mostly default.
- **Router coverage:** Claude Opus 5.5 and Sonnet 5.5 (Klaussy and Laude RevEngine rows),
  DeepSeek Flash. No GLM-5.3, Kimi K3.1, MiniMax M3.1 or MiMo V2.6.
- **Adapter effort:** S to M. Fetch the JSON, validate `configurationIdentity`, map model ids to
  canonical ids, map `reasoning`/`effort` to router efforts, drop product-only rows, keep
  `snapshotDate` and `rounds` for provenance. About 150-200 lines plus a fixture.
- **Risk:** the benchmark scores a reviewer agent, not a model; recall is sensitive to the
  harness's chunking and comment budget. Use only model-named rows, and mark derived capability
  `low` confidence unless the row also names the effort.

### harnesseval (recommended 2)

- **URL:** `https://dsifry.github.io/harnesseval/`; code and data
  `https://github.com/dsifry/harnesseval`.
- **Format:** JSON per run and per phase under `results/` (for example
  `results/phase_b_matrix.json`), plus report tables and figures. Rows contain `framework`, `url`,
  `pr_title`, `tp`, `fp`, `fn`, `precision`, `recall`, `n_findings`, `n_golden`, `tokens_in`,
  `tokens_out`, `wall_ms`, `raw_review`, `real_but_ungold`, `hallucination`,
  `adjudicated_precision`, `incremental_recall`, `decomposition`, and a `findings[]` array.
- **Model and effort:** a model-by-harness-by-effort matrix (low, medium, high, xhigh) for
  Claude Opus 5, Claude Sonnet 5, Claude Fable 5.1, GPT-5.6 Sol/Terra, with GLM-5.3 and
  GLM-5.3-Flash as a sidebar. Model and effort are encoded per configuration directory, not in
  every row of `phase_b_matrix.json`; the adapter must reconstruct the configuration key.
- **License:** MIT (README "License" section and `pyproject.toml`; there is no root `LICENSE`
  file, so cite both).
- **Freshness:** 2026 campaign; the README describes the current matrix. The exact snapshot date
  was not stated on the page, so record the file hash and fetch date in the snapshot.
- **Effort coverage:** the only review source with a full low/medium/high/xhigh axis.
- **Router coverage:** Claude 5 family (Opus 5, Sonnet 5, Fable 5.1, not 5.5 exactly) and GLM-5.3 /
  GLM-5.3-Flash. No DeepSeek V4.1, Kimi K3.1, MiniMax M3.1 or MiMo V2.6.
- **Adapter effort:** M. About 250-350 lines because the results layout is campaign-shaped
  (phase files, run directories, adjudication outputs) rather than a single tidy table. A fixture
  per configuration is required.
- **Risk:** the model revisions are one generation behind the router's Claude 5.5 and the sidebar
  GLM rows are a hosted quantized build. Treat as a review prior, not a direct measurement of the
  exact configured endpoints.

### tau2-bench (recommended 3)

- **URL:** `https://taubench.com`; submissions
  `https://github.com/sierra-research/tau2-bench/tree/main/web/leaderboard/public/submissions`;
  code `https://github.com/sierra-research/tau2-bench`.
- **Format:** `manifest.json` lists active submissions; each directory has `submission.json`
  (1.x) or a 2.0 package (`benchmark-metadata.json`, `benchmark-submission.json`, diagnostics,
  quality). `schema.json` and sibling schemas validate the files.
- **Fields:** `model_name`, `model_organization`, `submitting_organization`, `submission_date`,
  `submission_type`, `modality`, `results.<domain>.{pass_1..pass_4, cost, retrieval_config}`,
  `reasoning_effort`, `methodology`, `is_new`, `trajectories_available`.
- **License:** MIT (verified from raw `LICENSE`).
- **Freshness:** 96 entries in the submissions directory, including files dated through 2026-11
  (for example a 2026-11-19 submission). The router-model rows, however, are older revisions.
- **Effort coverage:** `reasoning_effort` is a first-class field (`max` in the example inspected).
- **Router coverage:** Claude Opus 5 (not 5.5), GLM-5 (not 5.3), Kimi K3 (not 3.1), DeepSeek V3.2
  (not V4.1). No MiniMax M3.1 or MiMo V2.6. Four families, none at the configured revision.
- **Adapter effort:** S. Fetch the manifest, read each `submission.json`, keep `reasoning_effort`
  and the pass@k cells, map names to canonical ids, record revision mismatch. About 120-180 lines.
- **Risk:** non-coding domains (airline, retail, telecom, banking knowledge) and a harness-shaped
  result. Use for ops/plan only, at low confidence, and do not let it override Terminal-Bench.

## Rejected or deferred sources

| Source | Why not bundled |
| --- | --- |
| Artificial Analysis | Terms do not allow automated copying or redistribution; local overlay only. |
| OpenRouter | Same; also a marketplace, not a benchmark. |
| SWE-bench Verified | Retired by OpenAI in February 2026 after flawed-test and contamination findings; scores still circulate but are not a stable signal. Dataset itself is MIT. |
| SWE-bench Pro | Dataset is MIT/Apache-2.0, but the leaderboard has no documented machine-readable export and the public task repositories carry GPL-family licenses. Adapter L for scores alone. |
| LiveCodeBench | MIT and active, but the leaderboard is HTML/submissions; no per-effort rows and current-model coverage not verified. Adapter L. |
| BFCL | Apache-2.0, but the last official snapshot is 2025-12-16 (Claude 4.5, GLM-4.6, Kimi K2, DeepSeek V3.2). No current rows, no effort field. |
| WritingBench | Apache-2.0 and machine-readable (XLSX), but zero current router models and general prose rather than technical docs. |
| DoGBench | Exact docs activity, but held-out data is private, the development split has no stated license, and rows are agent-level. |
| DebugBench | Apache-2.0 dataset, no current-model leaderboard, LeetCode judge dependency, 2024 results. Probe only. |
| Natural Plan | Apache-2.0 code and CC-BY-4.0 materials, but 2024 baselines and no leaderboard. Probe only. |
| GPQA | CC-BY-4.0 but gated on Hugging Face; no official per-model table. Probe only. |
| GAIA | Gated, no declared license, explicitly asks not to reshare splits. |
| BrowseComp | Encrypted test set, no open license, asks users not to reveal examples. |
| LLMRouterBench | No LICENSE file; license unresolved upstream. |
| AutoBench | Apache-2.0, but it benchmarks routers (policy choice), not per-model capability. Useful for routing policy research, not for `capability` cells. |
| OSWorld, TheAgentCompany, LHTB | Computer-use or long-horizon agent suites; license and freshness vary, no per-effort capability rows for the six router models. |
| Aider polyglot | Repository has no `LICENSE` at the usual path; license not verified, so not redistributable. |

## Ranked shortlist

**1. ReviewBench (MIT).** Fills the empty `review` activity and adds a debug-adjacent signal
(correctness, security, reliability findings). It is the only current review benchmark with a
public JSON API and explicit model/effort configuration metadata. Expected confidence: medium for
Claude Opus/Sonnet 5.5 and DeepSeek Flash review rows; unknown for the other four families.
Adapter cost: S-M.

**2. harnesseval (MIT).** Fills the effort axis that ReviewBench lacks: low, medium, high and
xhigh review rows for Claude 5 and GLM-5.3. It complements rather than replaces ReviewBench,
because its model revisions are one generation behind and its rows are campaign-shaped. Expected
confidence: low to medium. Adapter cost: M.

**3. tau2-bench (MIT).** Fills ops and multi-turn plan with tool-using agents, a JSON schema,
a manifest and a first-class `reasoning_effort` field. It is cheap to add and extends the
Terminal-Bench anchor beyond coding. Expected confidence: low, because the task domains are not
software engineering and the router-model revisions are older. Adapter cost: S.

**Not yet:** SWE-bench Pro (no score export), BFCL (stale snapshot), WritingBench (no current
models), DoGBench (private/ungeared). Those four are the next candidates if their publishers add
machine-readable current rows.

**Unfilled after the shortlist:** `debug` and `docs` remain without a bundled source. Both should
be measured by the local probe, not by importing a benchmark that does not cover the configured
models. `code`, `explore` and `ops` remain anchored by Terminal-Bench, LiveBench and LMArena.

## Adapter and calibration notes

- **Snapshot layout.** Follow the existing `data/evidence/<date>/<source>/` convention. Each
  adapter writes the raw response plus a small `_meta` block: source URL, fetch time, SHA-256,
  license, license URL and field list. No adapter writes into `lib/evidence.mjs` directly; the
  generator composes them.
- **Canonical ids.** Strip `[1m]` and provider prefixes before matching. Keep the exact configured
  id in `aliases`. A source row for a different revision (`claude-opus-5` vs `claude-opus-5.5`)
  must not silently fill the 5.5 cell; record the revision in `scores` and lower confidence.
- **Effort mapping.** Map source fields in one table, not per adapter: `reasoning` and
  `reasoning_effort` to router efforts; variant suffixes `(High)`, `(Max)`, `(xHigh)` to
  `high`, `max`, `xhigh`; product presets such as Copilot's Balanced/Lite to `medium`/`low` only
  when the source documents them. A row with no effort fills no per-effort cell; it may fill
  `default` at low confidence.
- **Attribution.** A review row names a harness, an agent or a model. Only model-named rows feed
  capability. A product row without a model stays out, even if the product is popular.
- **De-duplication.** Terminal-Bench publishes regrade files that restate an earlier submission;
  ReviewBench publishes multiple configurations of one product. Deduplicate by
  `(model, effort, agent, leaderboard_version)` and keep the newest `date`.
- **Percentiles.** Compute percentiles within one source snapshot, never across sources. A
  ReviewBench grounded F1 and a harnesseval adjudicated precision are different scales; each
  contributes its own normalized score to the activity composite.
- **Unknown stays unknown.** A missing low/high row is not a zero and not an interpolation. The
  current calibration rule already says this; the adapters must not fill gaps to make a table look
  complete.
- **Failure behavior.** A renamed table, a missing `configurationIdentity`, or a stale snapshot
  older than the configured threshold fails the check loudly. Do not fall back to a previous
  snapshot silently; the point of the weekly job is to notice drift.

### Proposed activity weight update

The weights below are a proposal for the calibration table; they are not implemented by this note.

| Activity | Anchors after the shortlist | Confidence |
| --- | --- | --- |
| code | Terminal-Bench accuracy/pass@k, LiveBench coding, LMArena agent | medium |
| debug | Terminal-Bench pass@2..5 and trial variance; ReviewBench correctness/security findings | low |
| explore | LMArena agent_overall, LiveBench research/data_analysis/browser | medium |
| plan | LMArena agent, LiveBench reasoning, tau2 multi-turn pass@k | low |
| review | ReviewBench grounded F1/recall, harnesseval adjudicated precision/recall | medium for Claude/DeepSeek, low elsewhere |
| ops | Terminal-Bench, tau2 pass@k, BFCL if refreshed | medium |
| docs | none; local probe only | unknown |
| default | LiveBench overall-weighted score, LMArena text rating | medium |

## Verification log

| Claim | How verified | Status |
| --- | --- | --- |
| Terminal-Bench Apache-2.0 | Raw `LICENSE` from `harbor-framework/terminal-bench` and `laude-institute/terminal-bench` | verified |
| Terminal-Bench fields and 26 rows | Local snapshot `data/evidence/2026-11-22/terminal-bench/rows.json` | verified |
| LiveBench Apache-2.0 | Raw `LICENSE`, header inherited from FastChat | verified |
| LiveBench categories and rows | Local snapshot `table.csv`, `categories.json`, `breakdown.json` | verified |
| LMArena CC-BY-4.0 | Snapshot metadata only; upstream terms page is a JS shell | partially verified |
| ReviewBench MIT | Raw `LICENSE` and README statement | verified |
| ReviewBench JSON API and fields | Live `GET /api/leaderboard`, 42 rows | verified |
| harnesseval MIT | README "License" section and `pyproject.toml` | verified (no root LICENSE) |
| harnesseval model/effort matrix | Project page and README | verified |
| tau2-bench MIT | Raw `LICENSE` | verified |
| tau2 submission schema | `submission.json` and `README.md` | verified |
| SWE-bench MIT | Repository README | verified |
| SWE-bench Verified retired February 2026 | Secondary coverage only (OpenAI announcement cited by press) | unverified primary |
| SWE-bench Pro MIT code / Apache-2.0 data | Raw `LICENSE`; HF card cited by search | code verified, data card not fetched |
| BFCL Apache-2.0 | Repository README | verified |
| BFCL last snapshot 2025-12-16 | `HuanzhiMao/BFCL-Result` directory listing and CSV | verified |
| WritingBench Apache-2.0 | Raw `LICENSE` | verified |
| WritingBench leaderboard is XLSX | HF Space file listing | verified |
| DoGBench private held-out data | arXiv HTML | verified |
| DoGBench license | No license statement found | unverified/absent |
| DebugBench Apache-2.0 and size | Raw `LICENSE`; paper and HF card | verified |
| Natural Plan Apache-2.0 / CC-BY-4.0 | Raw `LICENSE` (Apache-2.0); materials CC-BY per paper/search | partially verified |
| GPQA CC-BY-4.0 and gated | HF API card metadata | verified |
| GAIA gated, no license | HF card via search | partially verified |
| BrowseComp no open license | OpenAI page and downstream notices via search | partially verified |
| LLMRouterBench no LICENSE | Repository listing via search | partially verified |
| AutoBench Apache-2.0 | Raw `LICENSE` | verified |

## Unverified claims and open questions

- The exact date and text of OpenAI's SWE-bench Verified retirement come from secondary coverage;
  the primary announcement was not fetched. Treat the retirement as directionally confirmed, not
  quoted.
- LMArena's CC-BY-4.0 status rests on the bundled snapshot metadata. Re-check the current terms
  before publishing a bundle that includes its rows.
- harnesseval's snapshot date and whether every model row in the report is present in the public
  results files were not fully verified. The adapter should record file hashes and fail on a
  missing configuration rather than guess.
- ReviewBench's leaderboard API may change without notice. The adapter should pin a response
  fixture and fail loudly, not fall back to HTML scraping.
- No source in this note measures the configured MiniMax M3.1 endpoint. Terminal-Bench, LiveBench
  and LMArena cover the family, but the router's exact hosted revision may differ.
- Whether `reasoning_effort: none` in Terminal-Bench means "no reasoning" or "the model's default"
  should be confirmed with the publisher. The two readings imply different effort mapping for
  MiMo and Hy4.
