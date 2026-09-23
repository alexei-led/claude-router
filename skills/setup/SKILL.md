---
name: setup
description: Point Claude Code at the router gateway. Adds `model`, `ANTHROPIC_BASE_URL`, the context window and the `/model` picker row to the user settings, and offers the status line.
disable-model-invocation: true
allowed-tools: Read, Edit, Write
---

Configure Claude Code for the router gateway. This session does not use the gateway until Claude Code restarts. When the file has `model: "router"`, this session can fail its next request. So ask all questions first, write the file once, and write it last.

1. Read `~/.claude/settings.json`. If the file does not exist, start from `{}`. Read `~/.claude/router.json` if it exists.
2. The status line can show the model and effort of the last routed turn. The command is `node ${CLAUDE_PLUGIN_ROOT}/scripts/statusline.mjs`, followed by the current status line command if there is one (for example `node ${CLAUDE_PLUGIN_ROOT}/scripts/statusline.mjs claude-powerline`). Show the user the current `statusLine` value and the new one, and ask. Change `statusLine.command` only if the user agrees. Keep the other `statusLine` keys.
3. Prepare the new settings object in memory:
   - `model`: `"router"`.
   - `env.ANTHROPIC_BASE_URL`: `"http://127.0.0.1:43170"`. If `router.json` sets `gateway.port`, use that port.
   - `env.CLAUDE_CODE_MAX_CONTEXT_TOKENS`: `"1000000"`. Claude Code does not know the model `router` and assumes a 200K window without this key. If `router.json` changes `routes` or `models`, use the largest `contextWindow` of the models that the routes use. The gateway sends a turn only to a model whose window holds the context.
   - The `/model` picker row. In `modelPicker.options`, replace the row whose `model` is `"router"`, or append it if there is none:
     `{ "model": "router", "label": "Router (auto)", "description": "Auto-selects the model and effort for each turn", "behavesAs": "claude-opus-5-5" }`.
     If `modelPicker` does not exist, set it to `{ "options": [<the row>] }`. Keep the other rows and `replaceBuiltInOptions`. `behavesAs` names a model that Claude Code knows; without it, Claude Code rejects `router` as a model that is not in its catalog. If `router.json` changes the `high` route, use the `id` of its model.
   - Remove `env.ANTHROPIC_CUSTOM_MODEL_OPTION`, `env.ANTHROPIC_CUSTOM_MODEL_OPTION_NAME` and `env.ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION`. Older versions of this setup wrote them; the `modelPicker` row replaces them.
   - The `statusLine` change from step 2, if the user agreed.
   - Keep every other key unchanged.
4. Tell the user, before you write the file:
   - Restart Claude Code now. Until the restart, this session can show "There's an issue with the selected model (router)", because it still sends requests to Anthropic and not to the gateway.
   - After the restart, the router serves each turn, and `/router:status` shows the routes and the last turn.
   - The status line path contains the plugin version. After a plugin update, run `/router:setup` again.
   - To stop the routing, remove `model`, `env.ANTHROPIC_BASE_URL`, `env.CLAUDE_CODE_MAX_CONTEXT_TOKENS` and the `router` row of `modelPicker.options`, and restore the status line command.
5. Write the whole object to `~/.claude/settings.json` with one Write call. Do not use a sequence of edits. Do nothing after this step.

Do not change any other file.
