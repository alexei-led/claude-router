---
name: setup
description: Point Claude Code at the router gateway. Adds `model` and `ANTHROPIC_BASE_URL` to the user settings.
disable-model-invocation: true
allowed-tools: Read, Edit, Write
---
Configure Claude Code for the router gateway. Do these steps:

1. Read `~/.claude/settings.json`. If the file does not exist, start from `{}`.
2. Set the key `model` to `"router"`.
3. Set the key `env.ANTHROPIC_BASE_URL` to `"http://127.0.0.1:43170"`. If `~/.claude/router.json` sets `gateway.port`, use that port.
4. Keep every other key unchanged. Write the file.
5. Tell the user: restart Claude Code, then the router serves each turn. To stop the routing, remove the two keys.

Do not change any other file.
