# Evaluation

A snapshot of real work by one developer on one machine. The router ran in
Claude Code (claude-router) and in Pi (pi-model-router). Both use Jev.

![jev-router in Claude Code: where the requests went, and what the work cost](tier-share.svg)

## Claude Code

The window starts at the first request on the current models (Opus 5.5,
Sonnet 5, Haiku 4.5): 2026-09-23 09:05 UTC. It ends at 2026-09-24 06:00 UTC.
The data has 26 sessions and 1,611 requests. Jev advised 111 prompts.

| Tier     | Model and effort   | Requests | Share |
| -------- | ------------------ | -------- | ----- |
| `micro`  | Haiku 4.5          | 154      | 9.6%  |
| `low`    | Sonnet 5           | 1,239    | 76.9% |
| `medium` | Opus 5.5, `high`   | 73       | 4.5%  |
| `high`   | Opus 5.5, `xhigh`  | 145      | 9.0%  |

The cost of the same work at list prices:

| Scenario                  | Cost    | Saving with the router |
| ------------------------- | ------- | ---------------------- |
| Always Opus at `xhigh`    | $166.26 | 15.5%                  |
| Best model per session    | $146.54 | 4.1%                   |
| jev-router                | $140.55 | —                      |

"Best model per session" is a user who knows in advance the strongest tier
that Jev selected in each session, and uses it for the full session. The
result for each group of sessions:

| Strongest tier in the session | Sessions | Requests | Router  | Baseline | Saving |
| ----------------------------- | -------- | -------- | ------- | -------- | ------ |
| `low` (Sonnet)                | 23       | 573      | $39.74  | $39.74   | 0%     |
| `medium` (Opus, `high`)       | 2        | 847      | $76.89  | $84.57   | 9.1%   |
| `high` (Opus, `xhigh`)        | 1        | 191      | $23.92  | $22.23   | −7.6%  |

## Output size

The baselines keep the output tokens of the router. A stronger model at a
higher effort writes more, so the real savings are larger. If the stronger
route writes more output on the requests that the router sent lower, the
savings are:

| Output of the stronger route | vs. always Opus at `xhigh` | vs. best model per session |
| ---------------------------- | -------------------------- | -------------------------- |
| Same (1×)                    | 15.5%                      | 4.1%                       |
| 1.5×                         | 21.1%                      | 7.6%                       |
| 2×                           | 26.0%                      | 10.8%                      |

## Pi

Pi used two OpenAI profiles from 2026-09-22 21:00 to 2026-09-24 06:00 UTC,
with 25 sessions and 1,964 requests. Jev advised 148 decisions. The profiles
put correctness first: `high` served 83.6% of the requests and `medium` served
16.4%. The router cost $347.90. The best model per session cost $348.37. With
this policy, routing is cost-neutral.

## Method

- **Data.** Claude Code: `decisions.jsonl`, one `observed` line with the
  usage of each response. Pi: the session files, a router decision and the
  usage of each message. Neither source has prompt text.
- **Prices.** List prices in USD per million tokens. Claude: the defaults in
  `lib/config.mjs`. Pi: the Pi model registry, with long-context prices. For
  subscription plans, the dollars show the relative cost only.
- **Cache writes.** In Claude Code, the input that is not a cache read counts
  as a cache write at the granted TTL: 1.25× input for 5 minutes, 2× for 1
  hour.
- **Baselines.** Each baseline uses the tokens and the cache reads of the
  router. After each change of route in a conversation, the baseline also
  reads the previous context from the cache, if the cache is still warm. Thus
  the baseline does not pay for the cache writes that routing causes.
- **Tiers with one model.** Opus at `high` and at `xhigh` have the same price.
  Subagents count toward the strongest tier of their session.

## Limits

- One developer and two days make a snapshot, not a benchmark.
- Answer quality was not measured.
- For Pi, the baseline assumes that the OpenAI cache stays warm for 10
  minutes.
