#!/bin/sh
# Print model, session effort, per-turn effort, active skill and block types per assistant line.
# Usage: spike-check.sh ~/.claude/projects/<project>/<session>.jsonl
jq -r 'select(.type=="assistant") | [.timestamp[11:19], .message.model, (.effort // "-"), (.perTurnEffort // "-"), (.attributionSkill // "-"), ([.message.content[]?.type] | join(","))] | @tsv' "$1"
