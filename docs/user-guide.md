# User guide

## Start a session

After the install steps in the README, run `claude` as usual. Claude Code shows
`Router (auto)` as the model. The transcript records the model that answered
each message. The first session starts the gateway. The gateway continues to
run after the session ends.

To try the gateway in one session without a change to the configuration:

```sh
TYPESAFE_API_KEY=… node scripts/gateway.mjs &
ANTHROPIC_BASE_URL=http://127.0.0.1:43170 claude --plugin-dir . --model router
```

## What happens at each prompt

- A new prompt causes one Jev call. The call takes about one second and gives
  a tier. Then the policy decides if it acts on the tier.
- Tool calls inside the turn keep the route. The gateway does not ask Jev, and
  the cache of the model continues to hit.
- A prompt that continues the task keeps the route. Examples: "continue",
  "yes", "now fix the tests".
- After two failed repairs of the same error, the route goes up one tier. The
  route stays there for two turns. A repair is an edit between the two errors.
- An upgrade needs two consecutive votes for a higher tier. A jump of two
  tiers with high confidence happens at once. The required confidence goes up
  with the cost to read the context again on the new model.
- A downgrade needs two consecutive confident votes.
- A cold switch to a model that bills usage credits is refused when the cache
  write costs more than `policy.cashCapUsd`. Then the strongest plan tier
  serves the turn. Behind the gateway, Claude Code does not show its consent
  prompt for these credits, so the cap is the only guard. No default model
  bills credits; this applies once you add one in `router.json`.
- When Jev fails or times out, or when there is no key, the baseline tier
  serves the turn.
- Jev receives the prompt and the last six turns of text. Tool results are not
  sent. No other data leaves the machine, except the usual Anthropic request.

A Claude Code turn starts at about 100k tokens of system prompt and tool
definitions, so the first switch to a model is the expensive one.

## Pin a tier by hand

Type the tier skill as a command. The turn runs on the model of that skill.
The gateway sends the real model id unchanged.

```
/router:high  redesign the auth flow
/router:micro rename foo to bar in this file
```

`/model <name>` also works. It stops the routing for the rest of the session.

## See the current route

`/router:status` shows the gateway, the routes, and the model, effort and
reason of the last turn in this session.

The status line wrapper from `/router:setup` adds one line to your status line
while the session uses the router:

- `router ▸ opus-5-5 · xhigh (high)`: the model, the effort and the tier of the
  last turn.
- `router: no turn yet`: the session has no routed turn.
- `router: gateway down`: the gateway does not answer.

The line updates when Claude Code redraws the status line, after each message.

## Read the decisions

The gateway writes one line for each routed request to `decisions.jsonl` in
the plugin data directory. The directory is
`~/.claude/plugins/data/router-<marketplace>/`. For a gateway that you started
by hand, the directory is `$TMPDIR/router/`.

```sh
tail -n 20 ~/.claude/plugins/data/router-*/decisions.jsonl | jq -c '{tier, reason, estimate, observed}'
```

`tier` is the selected tier. `reason` is the rule that decided. The `observed`
lines carry the model that answered, the context tokens and the cache reads
from the response. Compare the estimated and the observed cache reads to tune
the thresholds.

`scripts/transcript-models.sh <transcript.jsonl>` shows the model for each
assistant message in a Claude Code transcript.

## Troubleshooting

- If Claude Code does not accept `router` as a model, make sure that the
  gateway runs and that `ANTHROPIC_BASE_URL` is set. The command
  `curl http://127.0.0.1:43170/v1/models` lists the alias.
- If Claude Code reports that it does not use the gateway, run
  `/router:setup` and restart Claude Code.
- If each turn runs on Sonnet, make sure that the key is set. Read the
  `router:` lines in `gateway.log` next to `decisions.jsonl`.
- If the effort is not what you set, read the `efforts` list of the model. The
  gateway lowers the effort to a level that the model accepts. Sonnet 4.6 has
  no `xhigh`. Haiku has no effort and no thinking.
- To stop the gateway, run `pkill -f scripts/gateway.mjs`. The next session
  starts it again.
