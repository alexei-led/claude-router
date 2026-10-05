# Configuration

The router works with its built-in defaults. Configure the key of the active classifier to enable advice. Change `router.json` only when you need to change the classifier, routes, model prices, cache assumptions, or policy.

## Key and profile settings

| Item                               | Where it lives                                  | How to change it                                                                                |
| ---------------------------------- | ----------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Jev API key                        | Sensitive plugin option `typesafe_api_key`      | Run `/plugin configure router`, or use **Set up** or **Credentials → Edit** in the router pane. |
| Cloudflare API token               | Sensitive plugin option `cloudflare_api_token`  | The same dialog. Used by Clef and Clef Flash.                                                   |
| Cloudflare account ID              | Plugin option `cloudflare_account_id`           | The same dialog, or the config menu row. Not a secret.                                          |
| Router settings and classifier     | `router.json` in the active Claude Code profile | Edit the file directly, or use the pane's Tiers and Tuning tabs.                                |
| Anthropic credentials and API cost | Claude Code                                     | The Mod leaves these to Claude Code.                                                            |

The active profile directory is `CLAUDE_CONFIG_DIR` when set. Otherwise it is `~/.claude`. The Mod does not need an Anthropic proxy URL, model alias, hint header, daemon, or custom status line.

The Mod reads each value from its plugin option first. When the option is empty, it reads the environment variable of the same name in upper case, then the one Claude Code exports for the option:

| Plugin option           | Environment variables                                                 |
| ----------------------- | --------------------------------------------------------------------- |
| `typesafe_api_key`      | `TYPESAFE_API_KEY`, `CLAUDE_PLUGIN_OPTION_TYPESAFE_API_KEY`           |
| `cloudflare_api_token`  | `CLOUDFLARE_API_TOKEN`, `CLAUDE_PLUGIN_OPTION_CLOUDFLARE_API_TOKEN`   |
| `cloudflare_account_id` | `CLOUDFLARE_ACCOUNT_ID`, `CLAUDE_PLUGIN_OPTION_CLOUDFLARE_ACCOUNT_ID` |

Export the variables before you start `claude`. Without the key or the account ID of the active classifier, the Mod keeps Claude's current model and reports which value is missing.

Project and local settings cannot set `HOME` or `CLAUDE_CONFIG_DIR` for this Mod. Those overrides make the router unavailable for the session, so a project cannot redirect the router to another profile's key or configuration.

## Built-in defaults

The default baseline is tier `low`. Each route refers to an alias in `models`.

| Tier     | Model alias | Model ID            | Effort                               |
| -------- | ----------- | ------------------- | ------------------------------------ |
| `micro`  | `haiku`     | `claude-haiku-4-5`  | None                                 |
| `low`    | `sonnet`    | `claude-sonnet-5-5` | Keeps the effort sent by Claude Code |
| `medium` | `opus`      | `claude-opus-5-5`   | `medium`                             |
| `high`   | `opus`      | `claude-opus-5-5`   | `xhigh`                              |

Default model settings:

| Alias    | Input / output / cache read, USD per million tokens | Context window | Billing | Effort levels                           |
| -------- | --------------------------------------------------- | -------------- | ------- | --------------------------------------- |
| `opus`   | 4 / 20 / 0.2                                        | 1,000,000      | `plan`  | `low`, `medium`, `high`, `xhigh`, `max` |
| `sonnet` | 2 / 10 / 0.2                                        | 1,000,000      | `plan`  | `low`, `medium`, `high`, `xhigh`, `max` |
| `haiku`  | 1 / 5 / 0.1                                         | 200,000        | `plan`  | none                                    |

Prices are configured list-price inputs for estimates. They are not a subscription bill or a claim of savings. Haiku receives no effort field. A route without an effort keeps the session effort, clamped to what the model supports. To make a tier whose default names an effort keep the session effort instead, set `"effort": null`, for example `"routes": { "high": { "model": "opus", "effort": null } }`.

## Classifiers

`classifier` names the active entry of `classifiers`. All entries use the same typed-questions API: Router sends the same request to each and reads the same answer. Cloudflare wraps that answer in `{ result, success, errors }`; Router reads both forms.

| `classifier` | Endpoint                                                                                                 | Request `model` | Key option             | `timeoutMs` |
| ------------ | -------------------------------------------------------------------------------------------------------- | --------------- | ---------------------- | ----------: |
| `jev`        | `https://api.typesafe.ai/v1/systemone`                                                                   | `jev-1.13.0`    | `typesafe_api_key`     |      `1500` |
| `clef`       | `https://api.cloudflare.com/client/v4/accounts/{cloudflare_account_id}/ai/run/@cf/cloudflare/clef`       | `clef`          | `cloudflare_api_token` |      `3000` |
| `clef-flash` | `https://api.cloudflare.com/client/v4/accounts/{cloudflare_account_id}/ai/run/@cf/cloudflare/clef-flash` | `clef-flash`    | `cloudflare_api_token` |      `3000` |

`jev` is the default. Select another one with a row in the pane's **Tuning → Classifier**, or in `router.json`:

```json
{ "classifier": "clef-flash" }
```

An entry has five fields: `label` (the name the band and pane show), `endpoint`, `model`, `keyOption`, and `timeoutMs`. `endpoint` must use `https`; plain `http` is accepted only for `localhost`, `127.0.0.1`, or `[::1]`, because the key travels with each request. A `{name}` in `endpoint` is filled from the plugin option of that name, URL-encoded. `keyOption` names the plugin option sent as the bearer token. Override one field of a built-in entry and the rest stay, for example `"classifiers": { "clef": { "timeoutMs": 4000 } }`.

You can add an entry for another service that speaks the same API. Its `keyOption` and endpoint placeholders must be one of `typesafe_api_key`, `cloudflare_api_token`, or `cloudflare_account_id`. Claude Code lets a Mod read only the options its manifest declares and environment variables it names in code, so an entry cannot bring a key of its own. Nor can it add request headers. For example, a company proxy in front of Jev:

```json
{
  "classifier": "jev-proxy",
  "classifiers": {
    "jev-proxy": {
      "label": "Jev",
      "endpoint": "https://jev-proxy.example.internal/v1/systemone",
      "model": "jev-1.13.0",
      "keyOption": "typesafe_api_key",
      "timeoutMs": 1500
    }
  }
}
```

The active classifier receives the current prompt and recent dialogue, as described in the [architecture](architecture.md#request-flow). Give a Cloudflare token Workers AI permissions only. The routing policy thresholds were tuned against Jev; another classifier's probabilities can place the same prompt differently.

To check a classifier outside Claude Code, run `node scripts/probe-classifier.mjs [classifier]` from a checkout. It reads `router.json` and the environment variables above (or `./.env`), sends the router's real request, and prints the status, latency, and parsed answer. It never prints the key or the full endpoint.

## Optional `router.json`

Start with the setting you need and leave the rest at defaults. For example, require three votes before moving to a cheaper tier and allow Jev up to two seconds:

```json
{
  "classifiers": { "jev": { "timeoutMs": 2000 } },
  "policy": { "downgradeVotes": 3 }
}
```

The Mod validates the whole file. Unknown keys and invalid values make routing unavailable with a general configuration error. Retired gateway keys and the 1.1 `jev` section trigger a migration instruction. The migration command reports an invalid setting path and does not print its value.

| Section            | Supported fields                                                                     | Defaults                                                 |
| ------------------ | ------------------------------------------------------------------------------------ | -------------------------------------------------------- |
| `baselineTier`     | `micro`, `low`, `medium`, `high`                                                     | `low`                                                    |
| `routes.<tier>`    | `model`, optional `effort` (a level, or `null` for the session effort)               | As in the route table above                              |
| `models.<alias>`   | `id`, `input`, optional `output`, `cacheRead`, `contextWindow`, `billing`, `efforts` | Three defaults above                                     |
| `cache`            | `writeMultiplier`, `ttlMs`, `warmMarginMs`                                           | `5m: 1.25`, `1h: 2`; `300000` / `3600000` ms; `30000` ms |
| `policy`           | Fields below                                                                         | Values below                                             |
| `classifier`       | An id in `classifiers`                                                               | `jev`                                                    |
| `classifiers.<id>` | `label`, `endpoint`, `model`, `keyOption`, `timeoutMs`                               | [Classifiers](#classifiers) above                        |
| `context`          | `recentTurns`, `maxTextChars`                                                        | `6`, `1200`                                              |

Policy defaults:

| Field                   | Default | Meaning                                                                                            |
| ----------------------- | ------: | -------------------------------------------------------------------------------------------------- |
| `upgradeVotes`          |     `2` | Consecutive supporting votes before an upgrade.                                                    |
| `upgradeBase`           |  `0.75` | Minimum probability mass required for an upgrade.                                                  |
| `upgradeSlope`          |  `0.15` | Maximum increase to the upgrade bar from estimated switching cost.                                 |
| `upgradePivotUsd`       |   `0.5` | Cost scale used by the upgrade bar. Must be positive.                                              |
| `jumpConfidence`        |  `0.95` | Support for a two-tier jump without waiting for votes.                                             |
| `downgradeVotes`        |     `2` | Consecutive supporting votes before a downgrade.                                                   |
| `downgradeMass`         |   `0.9` | Minimum probability mass required for a downgrade.                                                 |
| `downgradeSlope`        |  `0.08` | Maximum increase to the downgrade bar from estimated switching cost.                               |
| `downgradePivotUsd`     |   `0.5` | Cost scale used by the downgrade bar. Must be positive.                                            |
| `downgradeHorizonTurns` |     `5` | Later turns included in a downgrade payback estimate.                                              |
| `continuationMass`      |   `0.7` | Advice probability that keeps the current route for a continuation.                                |
| `escalationHoldTurns`   |     `2` | Turns held after a repeated tool error escalates the route.                                        |
| `cashCapUsd`            |     `2` | Maximum estimated cold cache write for a `credits` model. It does not cap output or session spend. |

The pane writes a subset of these settings. The **Tiers** tab sets `routes` and `baselineTier`: it writes only tiers that differ from the defaults and removes the rest. The **Tuning** tab sets `classifier` and the active classifier's `timeoutMs` at once, and `policy.downgradeVotes`, `policy.downgradeHorizonTurns`, and `policy.cashCapUsd`. Each save validates the whole file, keeps other keys, and applies from the next turn. A failed check names the setting and leaves the file unchanged. The pane refuses to write through a symlink. Model aliases and the other settings require a direct edit.

Native cache freshness is unknown after 270 seconds or after a history reset. Claude usage does not report the cache TTL. The policy evaluates price bounds for five-minute and one-hour writes, but the one-hour case is not observed fact. See the [architecture](architecture.md#cache-and-cost) for the estimate rules.

## Convert an older `router.json`

Router 1.1 kept the Jev settings in a `jev` section. The current version reads `classifiers.jev` instead and makes routing unavailable while a `jev` section remains. Run the migration command below on the file. It moves `jev.endpoint`, `jev.model`, and `jev.timeoutMs` to `classifiers.jev`, keeps everything else, and writes an exact-byte `router.json.v1.1.backup`. A file without a `jev` section needs no change.

## Convert a v0.8 configuration

The `router.json` converter changes only that file. It does not remove Claude Code gateway settings. Remove them before the first native session.

A marketplace install keeps the plugin ID `router@alexei-led-claude-router`: update it and keep it enabled. If you load v1 from a checkout with `--plugin-dir` instead, disable the marketplace install so only one router loads. Set `CLAUDE_CONFIG_DIR` to the intended profile directory first:

```sh
CLAUDE_CONFIG_DIR=/path/to/profile claude plugin disable router@alexei-led-claude-router --scope user
```

Then inspect that profile's `settings.json`. Remove the old `jev-router[1m]` model-picker row and any `model` or `env.ANTHROPIC_MODEL` value set to that alias. Remove `env.ANTHROPIC_BASE_URL` when it points to the router's loopback port. Clear `env.CLAUDE_CODE_GATEWAY_HINT_HEADERS`. Restore or remove a router-specific `statusLine` that points to the deleted script. Remove `env.ENABLE_TOOL_SEARCH` only if the old router setup added it and you do not need it for another reason. Preserve unrelated settings. Set the normal full baseline model, for example `claude-sonnet-5-5`.

No conversion is needed if you never created `router.json`. For an existing file, run the migration command that ships with the installed plugin:

```sh
node ~/.claude/plugins/cache/alexei-led-claude-router/router/1.0.0/scripts/migrate-config.mjs ~/.claude/router.json
```

Use the installed version in the path. From a checkout, run `node scripts/migrate-config.mjs ~/.claude/router.json`.

Pass the file under your active profile instead when `CLAUDE_CONFIG_DIR` points elsewhere. The command validates the converted configuration before writing it and creates an exact-byte `router.json.v0.8.backup` for a v0.8 file, or `router.json.v1.1.backup` for a 1.1 file. It refuses to overwrite an existing backup. Route, model-price, cache, and policy overrides remain in the converted file.

The converter removes old gateway and logging settings, request-feature fields, and model output caps. It moves `gateway.baselineTier` to top-level `baselineTier` and the `jev` section to `classifiers.jev`. It stops without writing when it finds an unsupported old field or invalid setting.

Node.js 22 or later is needed only for this migration command and project development. Claude Code runs the Mod. Node is not a routing service.
