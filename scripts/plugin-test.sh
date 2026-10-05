#!/usr/bin/env bash
# Runs the Mod tests inside the Claude Code engine: `claude plugin test` for the router and for the experiment probe.
# `claude plugin test <dir>` runs every *.test.ts under <dir>, nested plugins included, so a run from the root would
# also run the probe's tests against the router. The router therefore runs from a copy without experiments/.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"
command -v claude >/dev/null || {
	echo "plugin-test: claude missing; install Claude Code" >&2
	exit 1
}

stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT
while IFS= read -r -d '' file; do
	mkdir -p "$stage/$(dirname "$file")"
	cp "$file" "$stage/$file"
done < <(git ls-files -z -- . ':(exclude)experiments')

echo "plugin-test: router"
claude plugin test "$stage"
echo "plugin-test: experiments/mod-router"
claude plugin test experiments/mod-router
