# MiniMax, MiMo and Kimi evidence

Checked 2026-10-31. The [default routes](providers.md#built-in-defaults) are conservative starting policies,
not an optimal activity matrix or measured savings. These execution providers are separate from the classifier.

## Contracts and selection

| Provider | Selected model(s) | Documented controls used | Why |
| --- | --- | --- | --- |
| MiniMax | MiniMax-M3.1-Flash | low, medium, high, max | Current effort-capable model; cheaper than M3. M3 ignores effort. |
| MiMo | MiMo-V2.6-Flash / Pro | No routed effort | Flash for volume, Pro for harder work. Anthropic docs establish binary thinking, not depth levels. |
| Kimi | Kimi-K3.1-Pro | low, high, max | Cheaper successor to K3; one model avoids mixing preserved-thinking histories. |

MiniMax also documents `xhigh`, but some Claude Code versions serialize it as `high`. The preset omits it
rather than claim an extra distinct compute setting. Raw `xhigh` acceptance was checked, not native normalization.
Kimi K2.7 is not used as a cheap tier: its lifecycle notice closes access for new users on 2026-10-31
and plans retirement by the end of December 2026. Existing K3 users must start a fresh conversation to migrate to K3.1.

The local model-cards catalog was an initial reference: MiniMax M3 verified 2026-07-14 and Kimi K3/K2.7
verified 2026-09-13. It has no M3.1 Flash, K3.1 or MiMo record. Current official endpoint docs supersede
older catalog controls and K2 context claims.

### Primary sources

- MiniMax [Messages](https://platform.minimax.io/docs/api-reference/text-chat-anthropic),
  [SDK compatibility](https://platform.minimax.io/docs/api-reference/text-anthropic-api),
  [pricing](https://platform.minimax.io/docs/pricing/overview),
  [automatic caching](https://platform.minimax.io/docs/api-reference/text-prompt-caching),
  [Claude Code](https://platform.minimax.io/docs/m-plan/claude-code),
  [Flash release](https://www.minimax.io/blog/minimax-m31f).
- MiMo [Anthropic API](https://mimo.mi.com/docs/en-US/api/chat/anthropic-api),
  [model selection](https://mimo.mi.com/docs/quick-start/summary/model),
  [pricing](https://mimo.mi.com/docs/en-US/pricing),
  [Claude Code](https://mimo.mi.com/docs/integration/claudecode),
  [deep thinking](https://mimo.mi.com/docs/en-US/quick-start/usage-guide/text-generation/deep-thinking).
- Kimi [Messages](https://platform.kimi.ai/docs/api/messages),
  [models and lifecycle](https://platform.kimi.ai/docs/models),
  [K3.1 guide](https://platform.kimi.ai/docs/guide/kimi-k3-1-pro-quickstart),
  [pricing](https://platform.kimi.ai/docs/pricing/chat),
  [caching](https://platform.kimi.ai/docs/guide/context-caching),
  [K3 session guidance](https://forum.moonshot.ai/t/kimi-k3-is-here-our-most-capable-model/480).

Vendor results motivate the model choices, not the exact activity overrides. No independent head-to-head
repository benchmark establishes which effort each activity needs. Token prices are not prices per successful task.

## Live checks

All prompts and fixtures were synthetic. No real repository code, private conversations or credentials
are included in artifacts. Credential files stay local. JSON checks save final answers and usage, never reasoning text.

### Raw controls

[`provider-controls.json`](../experiments/mod-router/results/provider-controls.json) records 20 HTTP 200 requests:
old/new MiniMax, both MiMo models, and old/new Kimi. The body used a prime-number JSON prompt,
`max_tokens: 2048`, `thinking: {type: "adaptive"}`, and the recorded `output_config.effort`.
All responses named the requested model.

HTTP acceptance alone cannot distinguish honored fields from ignored fields. In particular, M3 success does not
make it effort-controllable, and MiMo low/high/max success does not establish different reasoning depths.
The production MiMo preset therefore lists no effort levels. Xiaomi's documented default thinking remains on;
Claude Code may still send its session effort and adaptive thinking, accepted in the native smoke test.

### Activity and mode microchecks

`node scripts/probe-provider-routes.mjs <provider> <budget-usd>` is billed and opt-in.
It asks one deterministic JSON task for each distinct activity/model/effort route across all tiers and modes,
using [the checked-in tasks](../test/fixtures/provider-tasks.json). Every mode/tier cell references its measured route.
The tests check small code-contract outputs, a boundary bug, an import graph, topological planning, SQL injection,
replica status and a configuration reference. They are **not code editing or repository-quality benchmarks**.

| Provider | Distinct calls | Exact JSON checks passed | Estimated API-list cost |
| --- | ---: | ---: | ---: |
| MiniMax | 28 | 28 | $0.001472 |
| MiMo | 14 | 12 | $0.001001 |
| Kimi | 21 | 21 | $0.024376 |

Results: [MiniMax](../experiments/mod-router/results/provider-routes-minimax.json),
[MiMo](../experiments/mod-router/results/provider-routes-mimo.json),
[Kimi](../experiments/mod-router/results/provider-routes-kimi.json).

MiMo Flash returned objects instead of module-name strings for `explore`, and added prose to an otherwise correct
`plan` array. Those are retained failures, not retried or hidden by a permissive parser. Pro passed both.
One sample does not justify moving every exploration or planning task to Pro.
MiniMax/Kimi low effort also passed these easy tasks, so the sample does not prove high/max necessary for harder work.

### Native streaming and tools

Claude Code **2.1.316** loaded the production Mod in isolated homes. Each provider ran a pinned high turn,
a Read tool continuation, a pinned micro turn, and another Read continuation: four upstream requests.
The test forwarded only these synthetic requests to fixed provider endpoints, capped output at 2,048 tokens,
and verified the requested/served model, supported routed effort and final marker.

| Provider | Observed transition | Result |
| --- | --- | --- |
| MiniMax | M3.1 Flash max → low | Passed |
| MiMo | Pro → Flash, session effort retained | Passed |
| Kimi | K3.1 Pro max → low, same model | Passed |

Artifacts: [MiniMax](../experiments/mod-router/results/provider-native-minimax.json),
[MiMo](../experiments/mod-router/results/provider-native-mimo.json),
[Kimi](../experiments/mod-router/results/provider-native-kimi.json).
Repeat with `node experiments/mod-router/scripts/provider-live.mjs <provider> <budget-usd>` (billed).
This temporary diagnostic forwarder is **not** part of the shipped router.

All three reported positive cache reads on tool continuations. MiniMax/MiMo streamed usage omitted cache-creation
counts; the engine compatibility check covers omitted-counter normalization. Kimi reported ordinary-price five-minute
cache fills and cache reads; the native request contained no top-level one-hour cache control.
No cross-effort hit-rate or TTL guarantee follows from these few requests.

The operator approved a $5 ceiling. Raw controls, microchecks and two native smoke passes together accounted for
approximately **$0.0625** at published list prices, including the superseded first native pass.
The [spend record](../experiments/mod-router/results/provider-experiment-spend.json) includes the superseded pass's
captured console totals so the aggregate can be reproduced. This is not a provider invoice or subscription-quota estimate.
The scripts enforce **per-invocation** ceilings only; the supervisor tracked the aggregate manually, not with a shared
runtime ledger. Each repeat needs a fresh spending authorization.

## Offline checks

`npm run test:providers` uses Claude Code and a loopback-only API with dummy credentials, not paid calls.
It covers all five non-Anthropic built-ins, profile selection, high/micro transitions, tools, omitted usage,
missing files and invalid configuration. Unit tests cover every new tier × activity × mode, pinning,
file isolation, reset/undo, metadata, lack of MiMo effort controls and the single-model Kimi catalog.
The tables in [Providers](providers.md#new-provider-modes) are generated and checked against the actual route transform.

Cost mode now steps to the next supported lower effort, skipping gaps: `max → high → low` on Kimi,
DeepSeek and z.ai. Previously upward projection could return the original effort and make cost mode a no-op.
MiMo has no effort lever; adjacent equal routes intentionally remain equal.

## Limits and upgrade triggers

Not tested: native images/video, near-1M context, compaction or rewind with provider thinking signatures,
forced tool choice, sustained rate limits, subscription eligibility, or real per-activity task quality and savings.
Raw API vision support is documented, not an end-to-end screenshot result.

MiMo Token Plan terms restrict general API/backend automation; use the documented PAYG endpoint and prices
for these experiments. A Claude Code integration does not establish that every non-coding automation qualifies
for a subscription. Check your plan terms and endpoint separately.

Keep these small presets until a representative coding/debug/review workload measures task success, retries,
total input/output, latency and cost per accepted change. Expand activity overrides only when that evidence
supports a difference. Do not add K2/K3 mixing or unsupported effort controls to make the tables look richer.
