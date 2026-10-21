# Routing modes

One setting trades cost against answer quality: `cost`, `balanced` (the default) or `quality`. The classifier and
your routes stay as they are. The mode moves the route each tier runs by one fixed step.

| Mode | What changes |
| --- | --- |
| `cost` | A cheaper route where the turn allows it: the tier below when that tier runs a model with a lower input price, else one effort level less on the same model. Never below `low`. |
| `balanced` | Nothing: every tier runs its route as configured. |
| `quality` | One effort level more on the same model, else the route of the tier above. |

In every mode:

- `micro` turns keep the `micro` route. Only the classifier makes a turn `micro`; `cost` never does.
- A pin (`/router pin <tier>`) runs that tier's configured route. With routing off (`/router off`, `/model`),
  Claude's model runs, as before.
- A route never loses its effort: an effort level moves only within what the model lists in `models.<alias>.efforts`,
  and a route with a `null` effort (the session's) or a model without efforts has no effort step.

## Choose a mode

The mode comes from the first of these that sets one:

1. **This session:** `/router mode cost`, `/router mode balanced` or `/router mode quality`. `/router mode default`
   clears it. A resume of the session keeps it; a new session does not.
2. **The project:** `.claude/router.json` in the directory Claude Code runs in. It may hold only the mode, for
   example `{ "mode": "cost" }`. A file with any other key, a mode that is not one of the three, or JSON that does not
   parse is ignored, and the pane and `/router` say why. Add it to `.gitignore` to keep the choice to yourself.
3. **The profile:** `"mode"` in `router.json`, or **Mode** on the pane's Policy tab, which saves at once with Undo.
4. `balanced`.

The band, the Now tab and `/router` show the mode and its source, for example `cost (session)`. The prompt footer
names a mode other than balanced.

## When a change applies

A change applies from the next turn. It changes the route the router prefers; the route in use moves through the
same checks as any other switch. On the same task a cheaper route waits until `minDwellRequests` requests have run on
the route in use and a check (tests, build, lint) has passed since. A move must also pay back its cache write. Until
then the band says why the route stays. Pin a tier to run its configured route now.

## Policy per mode

Each mode except `balanced` replaces some `policy` fields while it is active. The built-in values come from
codex-router and are **not tuned** on this router:

```json
{
  "modes": {
    "cost": { "policy": { "upgradeVotes": 3, "upgradeBase": 0.85, "jumpConfidence": 0.98, "downgradeVotes": 1,
                          "downgradeMass": 0.8, "minDwellRequests": 4, "escalationHoldTurns": 1 } },
    "quality": { "policy": { "upgradeVotes": 1, "upgradeBase": 0.6, "jumpConfidence": 0.9, "downgradeVotes": 3,
                             "downgradeMass": 0.95, "minDwellRequests": 16, "escalationHoldTurns": 4 } }
  }
}
```

Your `modes` entries merge field by field over these. A mode's field beats the same field in `policy`. Only `policy`
keys are allowed, and the result must pass the same checks as `policy`.

## Every decision

The route each mode gives a session's first turn, for each classifier answer, through the router's real decision
path. Generated from the test data by `npm run docs:modes`; `test/mode-matrix.test.mjs` fails when it is stale.

<!-- mode-matrix:start -->
**Built-in routes**

| Classifier | Activities | cost | balanced | quality |
| --- | --- | --- | --- | --- |
| micro | code, debug, explore, plan, review, ops, docs, uncertain | Haiku · medium | Haiku · medium | Haiku · medium |
| low | code, debug, plan, review | Sonnet · medium | Sonnet · high | Sonnet · xhigh |
| low | explore, ops, docs, uncertain | Haiku · medium | Haiku · high | Haiku · xhigh |
| medium | code, debug, plan, review | Sonnet · high | Opus · medium | Opus · high |
| medium | explore, docs, uncertain | Haiku · high | Opus · medium | Opus · high |
| medium | ops | Haiku · medium | Haiku · high | Haiku · xhigh |
| high | code, debug, explore, plan, review, docs, uncertain | Opus · high | Opus · xhigh | Opus · max |
| high | ops | Haiku · high | Opus · xhigh | Opus · max |
| uncertain | code, debug, plan, review | Sonnet · medium | Sonnet · high | Sonnet · xhigh |
| uncertain | explore, ops, docs, uncertain | Haiku · medium | Haiku · high | Haiku · xhigh |

**`routes.high` = Opus · high**

| Classifier | Activities | cost | balanced | quality |
| --- | --- | --- | --- | --- |
| micro | code, debug, explore, plan, review, ops, docs, uncertain | Haiku · medium | Haiku · medium | Haiku · medium |
| low | code, debug, plan, review | Sonnet · medium | Sonnet · high | Sonnet · xhigh |
| low | explore, ops, docs, uncertain | Haiku · medium | Haiku · high | Haiku · xhigh |
| medium | code, debug, plan, review | Sonnet · high | Opus · medium | Opus · high |
| medium | explore, docs, uncertain | Haiku · high | Opus · medium | Opus · high |
| medium | ops | Haiku · medium | Haiku · high | Haiku · xhigh |
| high | code, debug, explore, plan, review, docs, uncertain | Opus · medium | Opus · high | Opus · xhigh |
| high | ops | Haiku · high | Opus · high | Opus · xhigh |
| uncertain | code, debug, plan, review | Sonnet · medium | Sonnet · high | Sonnet · xhigh |
| uncertain | explore, ops, docs, uncertain | Haiku · medium | Haiku · high | Haiku · xhigh |
<!-- mode-matrix:end -->

## Known trade-offs

The steps are fixed rules, with no per-activity exceptions. Two cells go against this router's own model notes
(`lib/config.mjs`), and replay data should decide them later:

- `cost` at `high` for **ops** runs Haiku 5.5 at high (the `medium` ops route), although Haiku trails Opus on
  multi-step tool work. Repeated tool errors still escalate.
- `cost` at `low` for **code, debug, plan and review** runs Sonnet 5.5 at medium, which scored below Haiku 5.5 at high
  on FrontierCode and costs more per token.

With the built-in routes, `cost` at `low` runs Haiku 5.5 at medium, the same route as `micro`.

## Records

Each decision writes one line to Claude Code's debug log (`claude --debug`): `router decision` with the mode, its
source, the classifier's tier, the tier and reason the router chose, and the route. Usage records keep each reply
under its mode (`mode|activity|tier|model@effort`).
