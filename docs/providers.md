# Providers

Claude Router routes models and effort within the provider that Claude Code already uses.
Set a provider name and give the router a matching JSON file. No provider-specific plugin or proxy is needed.

**Built-in profiles:** Anthropic, DeepSeek, z.ai, MiniMax, MiMo and Kimi.
**Custom profiles:** OpenRouter, Ollama, other local servers, and other hosted providers with a Claude Code-compatible Anthropic endpoint.
Custom profiles need their own model settings. They do not inherit Claude models.

This guide assumes Claude Code already works with your provider. Endpoint and credential setup are outside its scope.

## Select a provider

For DeepSeek, create `deepseek-router.json` in your Claude Code profile directory with this content:

```json
{}
```

Then start Claude Code:

```sh
CLAUDE_ROUTER_PROVIDER=deepseek claude --model 'deepseek-flash[1m]'
```

The empty file enables DeepSeek's built-in defaults. Change only the settings you want to override.

If you prefer a command-line flag, use Claude Code's existing `--settings` flag:

```sh
claude --settings '{"env":{"CLAUDE_ROUTER_PROVIDER":"deepseek"}}' --model 'deepseek-flash[1m]'
```

There is no separate `--provider` flag. A launcher can set `CLAUDE_ROUTER_PROVIDER` for each launch.

### Name-to-file mapping

The directory is `CLAUDE_CONFIG_DIR` when set, otherwise `~/.claude`.

| Provider name | Router file | Built-in model defaults |
| --- | --- | --- |
| Unset, empty, or `anthropic` | `router.json` | Haiku 5.5, Sonnet 5.5, Opus 5.5 |
| `deepseek` | `deepseek-router.json` | DeepSeek Flash |
| `zai` | `zai-router.json` | GLM-5.3-Flash, GLM-5.3 |
| `minimax` | `minimax-router.json` | MiniMax-M3.1-Flash |
| `mimo` | `mimo-router.json` | MiMo-V2.6-Flash, MiMo-V2.6-Pro |
| `kimi` | `kimi-router.json` | Kimi-K3.1-Pro |
| `openrouter` | `openrouter-router.json` | None. Supply a complete profile. |
| `ollama` | `ollama-router.json` | None. Supply a complete profile. |
| Any other valid name | `<provider>-router.json` | None. Supply a complete profile. |

Names are local profile identifiers, not a provider registry or an endpoint lookup.
For example, `local` or `my-gateway` can name a custom profile.
Names must start with a lowercase letter, contain only lowercase letters, digits and hyphens, and have at most 64 characters.

**Setting the name does not change Claude Code's endpoint, credentials or billing product.**
The router neither detects providers from URLs nor switches endpoints between turns.

### File rules

- A non-Anthropic profile file must exist. Only the Anthropic profile can run without a file.
- Missing or invalid files produce a warning and leave Claude Code's model and effort unchanged.
- The router never falls back from a selected provider file to `router.json`.
- Profiles are independent. Classifier, policy and route overrides in `router.json` do not carry over.
- Selection is fixed for the session. The pane shows the selected file and writes Save/Undo changes there.
- Project and local settings cannot redirect the profile with `CLAUDE_ROUTER_PROVIDER`, `CLAUDE_CONFIG_DIR`, or `HOME`.

Select a classifier separately. Using Ollama to run your coding model does not also select Ollama as the classifier.
For an all-local setup, [configure the Ollama classifier](user-guide.md#use-ollama) in your local provider profile.

## Built-in defaults

Anthropic is the default when no provider name is set.
Every non-Anthropic built-in requires its named file, even when you want only defaults.
A file containing `{}` is enough. MiniMax, MiMo and Kimi require Router 1.19.0 or newer.

```sh
# First create the selected profile file containing {}, then launch on a configured model:
CLAUDE_ROUTER_PROVIDER=minimax claude --model 'MiniMax-M3.1-Flash[1m]'
CLAUDE_ROUTER_PROVIDER=mimo claude --model 'mimo-v2.6-flash[1m]'
CLAUDE_ROUTER_PROVIDER=kimi claude --model 'kimi-k3.1-pro[1m]'
```

Remove a fixed `CLAUDE_CODE_EFFORT_LEVEL` override if you want the router's per-turn efforts.
When migrating Kimi, start a **fresh conversation**. Its preserved thinking/signatures are model-specific;
resuming another model's history into K3-family models is not a supported migration.
The default Kimi ladder uses one model throughout, not a K2/K3 mixture.

### Model IDs

| Profile | Alias | Model ID |
| --- | --- | --- |
| Anthropic | `haiku` | `claude-haiku-5-5` |
| Anthropic | `sonnet` | `claude-sonnet-5-5` |
| Anthropic | `opus` | `claude-opus-5-5` |
| DeepSeek | `flash` | `deepseek-flash[1m]` |
| z.ai | `flash` | `glm-5.3-flash[1m]` |
| z.ai | `glm` | `glm-5.3[1m]` |
| MiniMax | `flash` | `MiniMax-M3.1-Flash[1m]` |
| MiMo | `flash` | `mimo-v2.6-flash[1m]` |
| MiMo | `pro` | `mimo-v2.6-pro[1m]` |
| Kimi | `k3` | `kimi-k3.1-pro[1m]` |

`[1m]` is a Claude Code context hint, not a different served model.
Changing Claude Code's model-slot environment variables does not update this catalog.
If you use different models, update their IDs and metadata in the selected router file.

### Default routes

Each cell is `model alias · effort`. All profiles start at tier `low`.

| Profile | `micro` | `low` | `medium` | `high` |
| --- | --- | --- | --- | --- |
| Anthropic | haiku · medium | haiku · high | opus · medium | opus · xhigh |
| DeepSeek | flash · low | flash · high | flash · high | flash · max |
| z.ai | flash · low | flash · high | glm · high | glm · max |
| MiniMax | flash · low | flash · medium | flash · high | flash · max |
| MiMo | flash · none | flash · none | pro · none | pro · none |
| Kimi | k3 · low | k3 · high | k3 · high | k3 · max |

A provider can use one model at several efforts. Two tiers can also share the same model and effort.
`none` for MiMo means **no routed effort**, not thinking off. Claude Code may still send its session effort;
Xiaomi does not document granular reasoning levels for its Anthropic endpoint. The preset lists `efforts: []`.

### Activity overrides

With activity routing on, these cells replace the base route. Other cells keep the base route.

| Profile | Activities | Tier | Route |
| --- | --- | --- | --- |
| Anthropic | `code`, `debug`, `plan`, `review` | `low` | sonnet · high |
| Anthropic | `ops` | `medium` | haiku · high |
| DeepSeek | `code`, `debug`, `plan`, `review` | `medium` | flash · max |
| z.ai | `code`, `debug`, `plan`, `review` | `medium` | glm · max |
| z.ai | `ops`, `explore`, `docs` | `medium` | flash · high |
| z.ai | `ops`, `explore`, `docs` | `high` | flash · max |
| MiniMax | `code`, `debug`, `plan`, `review` | `medium` | flash · max |
| MiMo | `ops`, `explore`, `docs` | `medium` | flash · none |
| Kimi | `code`, `debug`, `plan`, `review` | `medium` | k3 · max |

GLM-5.3 is text-only. Image-bearing history excludes it when the router can select a compatible route.
The default models all have a context window of at least 1M tokens.
The four new model entries support image input at the provider; native image and near-limit context paths have not been tested.

Subagent routing is on for built-in profiles:

| Profile | Light | Standard | Heavy |
| --- | --- | --- | --- |
| Anthropic | haiku | sonnet | opus |
| DeepSeek | flash | flash | flash |
| z.ai | flash | glm | glm |
| MiniMax | flash | flash | flash |
| MiMo | flash | pro | pro |
| Kimi | k3 | k3 | k3 |

Subagents receive a model at spawn, not a routed effort. Their own effort setting still applies.

These defaults are starting policies, not measured quality or savings guarantees.
See [the evidence and limits](evaluation.md#provider-profiles).
For prices and cache settings, see [the configuration reference](configuration.md#provider-profiles).

## New provider modes

These are configured routes by tier and activity, before vote, context, failure, dwell and cache-cost guards.
`base/uncertain` means the tier's base route; an uncertain classifier tier keeps the incumbent tier.
A pin bypasses modes and activities. The ordinary [mode rules](routing-modes.md) apply without provider-specific code.
Generate these tables with `node scripts/provider-matrix.mjs`.

<!-- provider-matrix:start -->
**minimax**

| Tier | Activities | cost | balanced | quality |
| --- | --- | --- | --- | --- |
| micro | base/uncertain, code, debug, explore, plan, review, ops, docs | flash · low | flash · low | flash · low |
| low | base/uncertain, code, debug, explore, plan, review, ops, docs | flash · low | flash · medium | flash · high |
| medium | base/uncertain, explore, ops, docs | flash · medium | flash · high | flash · max |
| medium | code, debug, plan, review | flash · high | flash · max | flash · max |
| high | base/uncertain, code, debug, explore, plan, review, ops, docs | flash · high | flash · max | flash · max |

**mimo**

| Tier | Activities | cost | balanced | quality |
| --- | --- | --- | --- | --- |
| micro | base/uncertain, code, debug, explore, plan, review, ops, docs | flash · no routed effort | flash · no routed effort | flash · no routed effort |
| low | base/uncertain, code, debug, plan, review | flash · no routed effort | flash · no routed effort | pro · no routed effort |
| low | explore, ops, docs | flash · no routed effort | flash · no routed effort | flash · no routed effort |
| medium | base/uncertain, code, debug, plan, review | flash · no routed effort | pro · no routed effort | pro · no routed effort |
| medium | explore, ops, docs | flash · no routed effort | flash · no routed effort | pro · no routed effort |
| high | base/uncertain, code, debug, plan, review | pro · no routed effort | pro · no routed effort | pro · no routed effort |
| high | explore, ops, docs | flash · no routed effort | pro · no routed effort | pro · no routed effort |

**kimi**

| Tier | Activities | cost | balanced | quality |
| --- | --- | --- | --- | --- |
| micro | base/uncertain, code, debug, explore, plan, review, ops, docs | k3 · low | k3 · low | k3 · low |
| low | base/uncertain, code, debug, explore, plan, review, ops, docs | k3 · low | k3 · high | k3 · max |
| medium | base/uncertain, explore, ops, docs | k3 · low | k3 · high | k3 · max |
| medium | code, debug, plan, review | k3 · high | k3 · max | k3 · max |
| high | base/uncertain, code, debug, explore, plan, review, ops, docs | k3 · high | k3 · max | k3 · max |
<!-- provider-matrix:end -->

MiniMax uses all four preset effort levels. `xhigh` is omitted because some Claude Code versions send it as `high`;
`max` supplies the deeper setting. Legacy M3 ignores effort and is not a stronger tier by default.
MiMo's cost/quality modes change models where a neighbouring tier permits it; otherwise the route stays the same.
Kimi uses only `low`, `high`, `max`, the documented controls, and never promotes a session into another model.
These are starting policies, not an optimal activity matrix. See [research and experiments](provider-experiments.md).

## Add another provider

No code change or provider registration is needed.
Choose a name, create its file, and set `CLAUDE_ROUTER_PROVIDER` to that name.

Unlike built-in profiles, a custom profile cannot use only `{}`.
Define all four routes and a complete model entry for each model they reference.
Custom profiles start with subagent routing off and automatic-cache accounting.

### Example: two local models

Save the following as `ollama-router.json` in your Claude Code profile directory.
Replace the two placeholder IDs with models installed on your server.
Set each context window to the limit configured for that model.

This example assumes local models with no per-token charge and no exposed effort control.
The zero prices and 32K windows are example settings, not defaults for every Ollama model.

```json
{
  "models": {
    "fast": {
      "id": "your-fast-model",
      "input": 0,
      "output": 0,
      "cacheRead": 0,
      "contextWindow": 32768,
      "billing": "plan",
      "efforts": [],
      "strength": 1,
      "imageInput": false
    },
    "strong": {
      "id": "your-strong-model",
      "input": 0,
      "output": 0,
      "cacheRead": 0,
      "contextWindow": 32768,
      "billing": "plan",
      "efforts": [],
      "strength": 2,
      "imageInput": false
    }
  },
  "routes": {
    "micro": { "model": "fast", "effort": null },
    "low": { "model": "fast", "effort": null },
    "medium": { "model": "strong", "effort": null },
    "high": { "model": "strong", "effort": null }
  },
  "cache": { "mode": "disabled" }
}
```

Start with the fast model, after replacing its placeholder ID:

```sh
CLAUDE_ROUTER_PROVIDER=ollama claude --model your-fast-model
```

`cache.mode` controls the router's cost estimates. It does not disable a server's internal cache.
Here it avoids assuming a billed prompt cache for the local models.

The same profile format works for OpenRouter or another hosted provider.
Use that provider's model IDs, supported efforts, context limits and actual token prices instead of the local example values.
Use `billing: "credits"` for token-billed models.
Set the [cache policy](configuration.md#provider-cache-behavior) to match the provider.

### Model and effort rules

- Alias names such as `fast` and `strong` are yours to choose. Routes refer to aliases, not API IDs.
- `efforts` lists only the effort levels that Claude Code can send and the provider honors.
- With `efforts: []`, use `effort: null` in every route. This omits routed effort, not model thinking.
- With named efforts, use only levels listed for that model. API compatibility does not make effort names equivalent.
- `strength` orders models for routing. A higher price does not prove higher capability.
- Prices are USD per million tokens. Use zero only when there is no token charge.
- `imageInput` describes the model's actual input support, not the provider's general capabilities.

For the full schema, see [Configuration](configuration.md#optional-routerjson).
To enable custom subagent routes, also configure [subagent routing](configuration.md#subagent-routing).

## Check the selected profile

1. Open `/router` and check the provider name and file path.
2. Start on a model used by a configured route, or run `/router auto`.
3. Check that the band names the expected model and effort after a prompt.

If routing is unavailable, inspect the selected file first.
A typo in the provider name selects a different filename. It does not choose the default profile.

Changing a provider name requires a new session.
Pane edits stay within the selected profile and apply from the next turn.
