---
name: status
description: Show which model served the last turn, whether Jev routing is active, and the routing config.
disable-model-invocation: true
allowed-tools: Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/status.mjs *)
---

Router status:

!`node ${CLAUDE_PLUGIN_ROOT}/scripts/status.mjs ${CLAUDE_SESSION_ID}`

Show this status to the user as written. Do not add commentary.
