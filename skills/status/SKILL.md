---
name: status
description: Show the router routes, the Jev key state, and the model and effort of the last routed turn.
disable-model-invocation: true
allowed-tools: Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/status.mjs *)
---
Router status:

!`node ${CLAUDE_PLUGIN_ROOT}/scripts/status.mjs ${CLAUDE_SESSION_ID}`

Show this status to the user as written. Do not add commentary.
