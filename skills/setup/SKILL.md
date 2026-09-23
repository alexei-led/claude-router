---
name: setup
description: Point Claude Code at the router gateway. Adds `model`, `ANTHROPIC_BASE_URL`, the context window and the `/model` picker row to the user settings, and offers the status line.
disable-model-invocation: true
allowed-tools: Read, Edit, Write
---

Configure Claude Code for the router gateway. Do these steps:

1. Read `~/.claude/settings.json`. If the file does not exist, start from `{}`.
2. Set the key `model` to `"router"`.
3. Set the key `env.ANTHROPIC_BASE_URL` to `"http://127.0.0.1:43170"`. If `~/.claude/router.json` sets `gateway.port`, use that port.
4. Set these keys in `env`, for the `/model` picker row:
   - `ANTHROPIC_CUSTOM_MODEL_OPTION`: `"router"`
   - `ANTHROPIC_CUSTOM_MODEL_OPTION_NAME`: `"Router (auto)"`
   - `ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION`: `"Picks Opus 5.5 / Sonnet 4.6 / Haiku 4.5 and the effort for each turn"`
5. Set the key `env.CLAUDE_CODE_MAX_CONTEXT_TOKENS` to `"1000000"`. Claude Code does not know the model `router` and assumes a 200K window without this key. If `~/.claude/router.json` changes `routes` or `models`, use the largest `contextWindow` of the models that the routes use. The gateway sends a turn only to a model whose window holds the context.
6. Keep every other key unchanged. Write the file.
7. The status line can show the model and effort of the last routed turn. The command is `node ${CLAUDE_PLUGIN_ROOT}/scripts/statusline.mjs`, followed by the current status line command if there is one (for example `node ${CLAUDE_PLUGIN_ROOT}/scripts/statusline.mjs claude-powerline`). Show the user the current `statusLine` value and the new one, and ask. Change `statusLine.command` only if the user agrees. Keep the other `statusLine` keys.
8. Tell the user:
   - Restart Claude Code. Then the router serves each turn, and `/router:status` shows the routes and the last turn.
   - The status line path contains the plugin version. After a plugin update, run `/router:setup` again.
   - To stop the routing, remove `model`, `env.ANTHROPIC_BASE_URL`, `env.CLAUDE_CODE_MAX_CONTEXT_TOKENS` and the three `ANTHROPIC_CUSTOM_MODEL_OPTION*` keys, and restore the status line command.

Do not change any other file.
