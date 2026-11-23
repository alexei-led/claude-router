import {
  acceptActivity,
  acceptPhase,
  chooseActivity,
  compareRoutes,
  lateralMove,
  opsWorkActivity,
  routingActivity,
  sameRequest,
} from './activity.mjs';
import { ACTIVITIES, rank, resolveRoute, routeSpec, sameRoute, TIERS } from './config.mjs';
import * as costs from './cost.mjs';
import { clip, completedSince, extractFacts, stripReminders } from './facts.mjs';
import { clearedModel, heldIds } from './failover.mjs';
import { keywordEffort, keywordTier } from './keywords.mjs';
import { CONTEXT_FILL, decide, fitTier, initialState, sameTaskOf } from './policy.mjs';
import { canonicalModel } from './providers.mjs';

// Exact observed API snapshot, not a rule that merges different dated versions.
const SNAPSHOTS = { 'claude-haiku-4-5': 'claude-haiku-4-5-20251001' };

// A request this much smaller than the last means the history was compacted or rewound: the cached prefixes the
// observations describe are gone, so they are dropped rather than priced as warm.
export const HISTORY_SHRINK = 0.8;

// Whether the engine served the requested model, allowing for a dated snapshot of it.
export function isSameModel(requested, served) {
  if (typeof requested !== 'string' || typeof served !== 'string') return false;
  const [a, b] = [canonicalModel(requested), canonicalModel(served)];
  return a === b || SNAPSHOTS[a] === b;
}

// A decision that serves only its own turn: a pin, or a prompt keyword. No review, observed move or later turn moves
// from it, and the next turn starts again from the route before it.
export const servesOneTurn = (decision) => Boolean(decision?.pinned || decision?.keyword);

// The engine may echo our own routed model on a continuation; any third model is its fallback.
export function isNativeFallback(loop, model) {
  if (loop.suspended) return true;
  const known = [loop.engineModel, loop.decision?.model].filter(Boolean);
  return known.length > 0 && !known.some((id) => isSameModel(id, model));
}

// The tier and activity whose route runs model `id`, or null when no route names it. Base routes first, baseline
// first; activity overrides only when they apply, with `activityRouting: on`.
export function cellForModel(config, id) {
  const order = [config.baselineTier, ...TIERS.filter((other) => other !== config.baselineTier)];
  const runs = (candidate, kind) => isSameModel(routeSpec(config, resolveRoute(config, candidate, kind)).id, id);
  const tier = order.find((t) => runs(t, null));
  if (tier) return { tier, activity: null };
  if (config.activityRouting !== 'on') return null;
  for (const t of order)
    for (const activity of ACTIVITIES)
      if (config.activities[activity]?.[t] && runs(t, activity)) return { tier: t, activity };
  return null;
}

// The route a session model runs when no route names it: that model at the session's effort. Null for a model with a
// cell, and for one the config does not list.
export function ownRoute(config, model) {
  if (cellForModel(config, model)) return null;
  const key = Object.keys(config.models).find((k) => isSameModel(config.models[k].id, model));
  return key ? { model: key, effort: null } : null;
}

export function emptyLoop(config, model) {
  const cell = config.routingEngine === 'auto' ? null : cellForModel(config, model);
  return {
    lastRoute: cell?.tier ?? config.baselineTier,
    lastActivity: cell?.activity ?? null,
    // The route (models key, effort) the last routed decision ran for `lastRoute`, kept as it ran: a routing mode or
    // a route edit changes the config, never the route in use. Null until the first decision, except on a session
    // model no route names (ownRoute): it starts at the baseline tier but keeps running until a decision moves it.
    // Taken as the baseline's route, repeated failures on it "escalated" to a weaker model.
    route: config.routingEngine === 'auto' ? null : ownRoute(config, model),
    state: initialState(),
    models: {},
    resolutions: {},
    lastRequest: null,
    historyMeasured: false,
    lastMessageCount: null,
    generation: 0,
    hasRoutedDecision: false,
    turnId: null,
    decision: null,
    ineligible: [],
    // Routed main requests so far, the one that started on the running route (`switchedAt`: requests and message
    // count then), and the request count at the last classifier answer (`reviewedAt`). Dwell and reviews count these.
    requests: 0,
    servedRoute: null,
    switchedAt: null,
    reviewedAt: 0,
    // The message count at the last review applied inside a turn: tool calls before it were already judged, so only
    // later ones can move the route up again (observedMove).
    observedFrom: 0,
    // Each configured model's simulated cache, by models key, for the routing-vs-no-routing readout (compareModels in
    // savings.mjs).
    yoursBy: {},
  };
}

const freshState = (state) => ({ ...state, votes: [], holdUntilTurn: 0, escalatedSignature: null });

export function resetHistory(loop) {
  return {
    ...loop,
    generation: loop.generation + 1,
    models: {},
    resolutions: {},
    historyMeasured: false,
    state: freshState(loop.state),
    ...(loop.decision ? { decision: { ...loop.decision, floorActivity: null } } : {}),
    // The active turn keeps its route, pin and fallback suspension; the next turn decides afresh.
    ineligible: [],
    yoursBy: {},
  };
}

// Legacy physical observations cannot prove a manual-only prefix. Never regrant startup on ambiguous history.
export const hasRoutedDecision = (loop) =>
  typeof loop.hasRoutedDecision === 'boolean'
    ? loop.hasRoutedDecision
    : Boolean(loop.decision || loop.auto || loop.requests > 0);

export function prepareLoop(loop, messageCount) {
  const prepared = { ...loop, hasRoutedDecision: hasRoutedDecision(loop) };
  if (loop.lastMessageCount === null || messageCount >= loop.lastMessageCount)
    return { ...prepared, lastMessageCount: messageCount };
  // Compaction or a rewind shortened the history: message cursors past its end move to it, so checks and edits made
  // from here on count. The request-based dwell is kept.
  const cursor = (count) => Math.min(count ?? 0, messageCount);
  return {
    ...resetHistory(prepared),
    lastMessageCount: messageCount,
    switchedAt: loop.switchedAt && { ...loop.switchedAt, messageCount: cursor(loop.switchedAt.messageCount) },
    observedFrom: cursor(loop.observedFrom),
  };
}

export function nativeFacts(config, loop, { messages, prompt, effort, turnId, contextTokens, progress = false }) {
  const facts = extractFacts({ messages, output_config: { effort } }, loop, config.context);
  if (typeof prompt === 'string') facts.prompt = clip(stripReminders(prompt), config.context.maxTextChars);
  // A move down on the same task waits out the dwell and for a checkpoint since the last model change: a passed check,
  // or the success the running route's activity can show (completedSince).
  const since = loop.switchedAt ?? { requests: 0, messageCount: 0 };
  const downAllowed =
    !progress &&
    (loop.requests ?? 0) - since.requests >= config.policy.minDwellRequests &&
    completedSince(messages, since.messageCount, activityOf(config, loop));
  // A loop saved without the field counts as measured, keeping the vote streak.
  return {
    ...facts,
    downAllowed,
    ...(progress ? { progress: true } : {}),
    pin: null,
    contextTokens,
    turnKey: turnId,
    historyMeasured: loop.historyMeasured !== false,
  };
}

export function isModelAllowed(requested, allowed, native) {
  if (allowed === undefined) return true;
  if (!Array.isArray(allowed) || !allowed.every((v) => typeof v === 'string')) return false;
  const id = canonicalModel(requested);
  const nativeModel = canonicalModel(native);
  const available = allowed.map(canonicalModel);
  if (available.includes('default') && id === nativeModel) return true;
  const family = /^claude-(fable|opus|sonnet|haiku)-/.exec(id)?.[1];
  const specific = available.filter((v) => family && v.startsWith(`claude-${family}-`));
  if (specific.length) return specific.some((v) => id === v || id.startsWith(`${v}-`));
  return available.some(
    (v) => id === v || (id.startsWith('claude-') && id.startsWith(`${v}-`)) || (family && v === family),
  );
}

export function economicConfig(config, loop) {
  const models = Object.fromEntries(
    Object.entries(config.models).map(([alias, model]) => [
      alias,
      { ...model, id: Object.hasOwn(loop.resolutions, model.id) ? loop.resolutions[model.id] : model.id },
    ]),
  );
  return { ...config, models };
}

// `activityRouting` decides which activity the route may use: none in `off`, the chosen one in `on`.
export function chooseRoute(config, loop, input) {
  const { pin, facts } = input;
  // A pin outranks a keyword. The keyword's effort move applies to whatever route runs, a stand-in's too, unless the
  // route sends the session's effort.
  const keyword = pin ? null : (input.keyword ?? null);
  const applied = routeTurn(config, loop, { ...input, keyword });
  if (keyword && typeof applied.route?.effort === 'string')
    applied.effort = keywordEffort(config, keyword, applied.route.model, applied.effort);
  const floor = opsFloor(config, applied.floorActivity);
  if (
    applied.activity === floor.activity &&
    floor.retained.includes(applied.tier) &&
    sameRoute(applied.route, resolveRoute(config, applied.tier, 'ops'))
  )
    applied.activity = 'ops';
  // A route standing in for a held-out model serves this turn only, as a pin does: once the hold ends, the next turn
  // runs the route it held out without passing a switching gate. Nor does the turn keep the votes or the escalation
  // `decide` recorded for the held route, which never ran: the same failure still escalates once the hold ends. A
  // keyword turn keeps none of them either: `decide` judged the router's own pick, which the keyword replaced.
  const heldOut = applied.reason === 'model-held';
  const kept = pin || keyword || !applied.tier || heldOut;
  return {
    ...loop,
    state: heldOut || keyword ? { ...loop.state, turn: loop.state.turn + 1 } : applied.state,
    hasRoutedDecision: true,
    lastRoute: kept ? loop.lastRoute : applied.tier,
    lastActivity: kept ? activityOf(config, loop) : applied.activity,
    route: kept ? (loop.route ?? null) : applied.route,
    turnId: facts.turnKey,
    decision: {
      ...applied,
      ...(keyword ? { keyword } : {}),
      goal: !pin && config.activityRouting === 'on' ? acceptActivity(config, input.advice) : null,
      taskPhase: !pin && config.activityRouting === 'on' ? acceptPhase(config, input.advice) : null,
    },
    suspended: false,
    reviewedAt: loop.requests ?? 0,
  };
}

// An absent engineering cell inherits the generic row, which is not necessarily a floor for a custom ops row.
// Protect only a declared weaker inherited preference; explicit cells (even use-tier) and unknown strength stay
// authoritative. Project per tier before any price/fit/gate calculation, then report a retained ops cell as ops.
function opsFloor(config, activity) {
  const retained = [];
  if (config.activityRouting !== 'on' || !activity) return { config, activity, retained };
  const declared = config.configuredActivities ?? config.activities;
  const cells = { ...config.activities[activity] };
  for (const tier of TIERS) {
    if (Object.hasOwn(declared[activity] ?? {}, tier)) continue;
    const ops = resolveRoute(config, tier, 'ops');
    if ((compareRoutes(config, resolveRoute(config, tier, activity), ops) ?? 0) >= 0) continue;
    cells[tier] = ops;
    retained.push(tier);
  }
  return {
    config: retained.length
      ? { ...config, configuredActivities: declared, activities: { ...config.activities, [activity]: cells } }
      : config,
    activity,
    retained,
  };
}

// The activity of the route running now. Outside `on` there is none, even one a turn in `on` left in the loop before
// the mode changed: `off` is the 1.5 decision.
const activityOf = (config, loop) => (config.activityRouting === 'on' ? (loop.lastActivity ?? null) : null);

// The ids of the models held out at `now`: an API error held the model, or its account (failover.mjs). `accountHolds`
// are the stored account holds, read by the caller. A caller that recorded the ids (`held`, replay) passes them
// instead: a trace does not reconstruct holds from the loop.
const heldOf = (config, loop, accountHolds, now, held = /** @type {string[] | null} */ (null)) =>
  held ?? heldIds(config, loop.held, accountHolds, now);
const isHeld = (held, id) => held.some((model) => isSameModel(model, id));
// A model this turn cannot send to: one whose context window a request exceeded, or a held-out one.
const withheld = (loop, held, id) => loop.ineligible.includes(id) || isHeld(held, id);
// Whether a model reads only its own thinking history: a switch into or out of it from another model would break it.
const needsOwnHistory = (config, id) =>
  Object.values(config.models).some((model) => model.requiresOwnHistory && isSameModel(model.id, id));
const crossesOwnHistory = (config, from, to) =>
  !isSameModel(from, to) && (needsOwnHistory(config, from) || needsOwnHistory(config, to));
// Every tier, nearest to `tier` first; of two as near, the stronger.
const nearestTiers = (tier) =>
  [...TIERS].sort((a, b) => Math.abs(rank(a) - rank(tier)) - Math.abs(rank(b) - rank(tier)) || rank(b) - rank(a));

// The first target of `source`'s fallback chain that `usable` accepts, as the route and effort it runs and the step it
// is, or null. A bare entry takes the source's effort, an `alias@effort` entry its own.
function chainStandIn(config, source, sentEffort, usable) {
  const chain = config.fallbacks?.[source.model] ?? [];
  const wanted = costs.routeEffort(config, source, sentEffort);
  for (const [index, entry] of chain.entries()) {
    const [alias, named = null] = entry.split('@');
    const route = { model: alias, effort: named };
    if (usable(routeSpec(config, route)))
      return {
        route,
        effort: costs.routeEffort(config, route, wanted),
        fallback: { from: source.model, step: index + 1, of: chain.length },
      };
  }
  return null;
}

// The incumbent runs the route in use, not the one config gives its cell now. It is rebuilt from config for a loop from
// before 1.15, a route whose model left the config or can no longer run (`usable`), and a route kept for an activity
// that no longer applies (activity routing turned off).
function incumbentOf(config, loop, facts, last, usable) {
  const tier = TIERS.includes(facts.lastRoute) ? facts.lastRoute : config.baselineTier;
  const inUse = loop.route && usable(loop.route) && (loop.lastActivity ?? null) === last.activity ? loop.route : null;
  return {
    tier,
    activity: last.activity,
    floorActivity: last.floorActivity,
    route: inUse ?? resolveRoute(config, tier, last.activity),
  };
}

const NO_CELL = { tier: null, activity: null, floorActivity: null };

// One decision (plan §5.2) for the cell `{ tier, activity }` it lands on. Outside `on` the activity is null throughout.
function routeTurn(
  config,
  loop,
  {
    facts,
    advice,
    pin,
    keyword = null,
    nativeModel,
    contextKnown,
    availableModels,
    accountHolds,
    held = /** @type {string[] | null} */ (null),
    now,
  },
) {
  const heldNow = heldOf(config, loop, accountHolds, now, held);
  const last = {
    tier: loop.lastRoute,
    activity: activityOf(config, loop),
    floorActivity: config.activityRouting === 'on' ? (loop.decision?.floorActivity ?? null) : null,
  };
  const incumbent = incumbentOf(config, loop, facts, last, (route) => {
    const model = Object.hasOwn(config.models, route.model) ? config.models[route.model] : null;
    return Boolean(
      model && isModelAllowed(model.id, availableModels, nativeModel) && !withheld(loop, heldNow, model.id),
    );
  });
  let result = chooseCell(config, loop, { facts, advice, pin, keyword, now }, incumbent);
  // Restoring last/native provenance can change the floor again, so each candidate resolves its own projection.
  const preferredRoute = (cell) => resolveRoute(opsFloor(config, cell.floorActivity).config, cell.tier, cell.activity);
  // A decision that stays on the incumbent's cell keeps running its route; only a taken lateral move, a pin or a keyword
  // runs the cell's route from config. So a mode change reaches the request only through the gates.
  const stays = (cell) =>
    cell.tier === incumbent.tier &&
    (cell.activity ?? null) === incumbent.activity &&
    cell.lateral !== 'taken' &&
    !['pinned', keyword].includes(cell.reason);
  const routeOf = (cell) => (stays(cell) ? incumbent.route : preferredRoute(cell));
  const specOf = (cell) => routeSpec(config, routeOf(cell));
  // Without a reliable reading of the context, a route with a smaller window than the last one might overflow. Before
  // the first decision the session's own model ran, not the mode's route for its cell.
  const lastSpec =
    (!loop.decision && Object.values(config.models).find((m) => isSameModel(m.id, nativeModel))) || specOf(last);
  const shrinks = (spec) => (!contextKnown || !loop.historyMeasured) && spec.contextWindow < lastSpec.contextWindow;
  const shrinksUnmeasured = (cell) => shrinks(specOf(cell));
  const takes = (spec) =>
    !shrinks(spec) &&
    (!facts.hasImages || spec.imageInput !== false) &&
    isModelAllowed(spec.id, availableModels, nativeModel) &&
    !withheld(loop, heldNow, spec.id);
  const room = (spec) => !contextKnown || costs.nextContextTokens(facts) <= spec.contextWindow * CONTEXT_FILL;
  const runs = (cell) => takes(specOf(cell));
  const heldOut = (cell) => isHeld(heldNow, specOf(cell).id);
  const roomFor = (cell) => room(specOf(cell));
  const fits = (cell) => runs(cell) && roomFor(cell);
  if (contextKnown) result = fitContext(config, facts, result, { routeOf, preferredRoute });
  // A lateral outcome describes the cell the lateral rule chose; a context or availability override replaces it.
  if (shrinksUnmeasured(result)) result = { ...result, ...last, reason: 'context-unknown', lateral: null };
  // The route that stands in for a held-out cell's model this turn: a fallback chain's target, which need not be in any
  // tier. The cell stays the intended one, so the stand-in never becomes `loop.route`.
  /** @type {ReturnType<typeof chainStandIn>} */
  let standIn = null;
  let kept = null;
  if (!fits(result)) {
    // A cell labelled with another activity would run, and stick, a route this turn did not choose.
    const native = cellForModel(config, nativeModel);
    const acceptedActivity = result.floorActivity ?? result.activity;
    const tierCell = (tier) => ({ tier, activity: acceptedActivity, floorActivity: result.floorActivity });
    const source = heldOut(result) ? routeOf(result) : null;
    standIn = source && chainStandIn(config, source, facts.effort, (spec) => takes(spec) && room(spec));
    if (standIn) result = { ...result, reason: 'model-held', lateral: null };
    else {
      const sourceId = source && routeSpec(config, source).id;
      // A held-out model is back soon: the nearest tier stands in for it, not the last or the cheapest route. A model
      // that reads only its own history is neither stood in for nor a stand-in.
      const cells = source
        ? nearestTiers(result.tier)
            .map(tierCell)
            .filter((cell) => !crossesOwnHistory(config, sourceId, specOf(cell).id))
        : [last, native && { ...native, floorActivity: null }, ...TIERS.map(tierCell)];
      const fallback = cells.find(
        (cell) => cell && (cell.activity === null || cell.activity === acceptedActivity) && fits(cell),
      );
      // With no cell to fit, the session model cannot take over a history only the held route reads: it stays.
      if (!fallback && source && crossesOwnHistory(config, sourceId, nativeModel)) kept = source;
      // Only the window failed: no route is withheld, the conversation is just too full for every one of them.
      const reason = runs(result) ? 'context-full' : source ? 'model-held' : 'model-unavailable';
      result = { ...result, ...(fallback ?? NO_CELL), reason, lateral: null };
    }
  }
  const sent = standIn?.route ?? kept ?? (result.tier ? routeOf(result) : null);
  const effort = standIn?.effort ?? (sent ? costs.routeEffort(config, sent, facts.effort) : facts.effort);
  const candidate = pin ?? (keyword ? result.tier : advice?.choice);
  const comparison =
    contextKnown && loop.lastRequest && TIERS.includes(candidate) && candidate !== loop.lastRoute
      ? compareSwitch(config, loop, {
          candidate,
          result,
          to: preferredRoute({ ...result, tier: candidate, activity: result.floorActivity ?? result.activity }),
          from: incumbent.route,
          facts,
          now,
        })
      : null;
  return {
    ...result,
    route: sent,
    model: sent ? routeSpec(config, sent).id : nativeModel,
    effort,
    comparison,
    pinned: Boolean(pin),
    requestedPin: pin ?? null,
    ...(standIn ? { fallback: standIn.fallback } : {}),
  };
}

// The cell, moved to the tier whose route the conversation fits when its own does not.
function fitContext(config, facts, cell, { routeOf, preferredRoute }) {
  const acceptedActivity = cell.floorActivity ?? cell.activity;
  const routeFor = (tier) =>
    tier === cell.tier ? routeOf(cell) : preferredRoute({ ...cell, tier, activity: acceptedActivity });
  const fitted = fitTier(config, cell.tier, costs.nextContextTokens(facts), routeFor);
  return fitted === cell.tier
    ? cell
    : { ...cell, tier: fitted, activity: acceptedActivity, reason: 'context-fit', lateral: null };
}

// What a move to the candidate tier's route `to` would cost and save against the route `from` in use.
function compareSwitch(config, loop, { candidate, result, to, from, facts, now }) {
  const projected = economicConfig(opsFloor(config, result.floorActivity).config, loop);
  const forecast = costs.switchEconomics(projected, to, from, facts, now);
  return {
    candidate,
    incumbent: loop.lastRoute,
    ...costs.nextTurnRange(projected, to, from, facts, now),
    paybackTurns: forecast?.paybackTurns ?? null,
    outputTokens: loop.lastRequest.outputTokens,
  };
}

// Nomination carries its source into the gates; only their accepted outcome owns future refit intent.
function chooseCell(config, loop, { facts, advice, pin, keyword, now }, incumbent) {
  // A keyword moves the tier the router chose, past the switching gates; routeTurn's context and availability checks
  // still apply to it.
  if (keyword) {
    const cell = chooseCell(config, loop, { facts, advice, pin, keyword: null, now }, incumbent);
    const tier = keywordTier(keyword, cell.tier ?? config.baselineTier);
    return { ...cell, tier, activity: cell.floorActivity ?? cell.activity, reason: keyword, lateral: null };
  }
  if (pin && TIERS.includes(pin))
    return {
      tier: pin,
      activity: null,
      floorActivity: null,
      reason: 'pinned',
      lateral: null,
      escalated: false,
      state: { ...loop.state, turn: loop.state.turn + 1 },
    };
  const work = !pin && config.activityRouting === 'on' ? opsWorkActivity(config, advice) : null;
  const proposal = opsFloor(config, work);
  const selection =
    !pin && config.activityRouting === 'on'
      ? chooseActivity(proposal.config, advice, incumbent, facts.effort, facts)
      : { activity: null, floorActivity: null };
  const chosen = opsFloor(config, selection.floorActivity);
  return decideCell({
    config: chosen.config,
    projected: economicConfig(chosen.config, loop),
    facts,
    advice,
    state: loop.state,
    now,
    incumbent,
    activity: selection.floorActivity ?? selection.activity,
    floorActivity: selection.floorActivity,
    phaseDerived: Boolean(
      work &&
        selection.floorActivity === work &&
        incumbent.floorActivity !== work &&
        chosen.retained.includes(incumbent.tier),
    ),
  });
}

// Steps 3-6 of plan §5.2: the tier as `decide` picks it, every candidate priced at its route for `activity` and the
// incumbent at the route it runs; then, when the tier stays and the route would change, the lateral rule. Equal routes
// never switch: a label alone decides nothing.
function decideCell({
  config,
  projected,
  facts,
  advice,
  state,
  now,
  incumbent,
  activity,
  floorActivity,
  phaseDerived,
}) {
  const routeFor = (tier) => resolveRoute(config, tier, activity);
  // Failures move to the lowest tier whose route is stronger than the one running, or another request that does not
  // order against it: after a mode change the next tier's route can be the weaker one.
  const escalates = (t) => {
    const order = compareRoutes(config, routeFor(t), incumbent.route, facts.effort);
    return (
      (order !== null && order > 0) ||
      (order === null && !sameRequest(config, routeFor(t), incumbent.route, facts.effort))
    );
  };
  const escalateTo = (tier) => TIERS.slice(rank(tier) + 1).find(escalates) ?? null;
  const step = decide({
    config: projected,
    facts,
    advice,
    state,
    baseline: config.baselineTier,
    now,
    costs,
    routeFor,
    incumbentRoute: incumbent.route,
    escalateTo,
  });
  // `decide` takes the failure's signature whenever it escalates, before the cash gate can hold the move; a later
  // context or availability override keeps the flag.
  const escalated = step.state.escalatedSignature !== state.escalatedSignature;
  const route = routeFor(step.tier);
  // Without a classifier answer the running route stays, whatever the mode's route for the cell, during a hold too.
  if (!advice) return { ...step, activity: incumbent.activity, floorActivity, lateral: null, escalated };
  if (step.tier !== incumbent.tier || sameRequest(config, route, incumbent.route, facts.effort))
    return { ...step, activity, floorActivity, lateral: null, escalated };
  const lateral = lateralMove({
    config: projected,
    from: incumbent.route,
    to: route,
    // Returning to the base route needs no evidence, nor does the incumbent's own cell whose configured route changed
    // (a routing mode, a route edit). A new phase-derived physical projection is not an operator edit, even when
    // its label is unchanged: that proposal still needs the lower of the actual goal/phase supports.
    mass:
      !phaseDerived &&
      (activity === null ||
        activity === incumbent.activity ||
        (floorActivity && floorActivity === incumbent.floorActivity))
        ? 1
        : (routingActivity(config, advice)?.mass ?? 0),
    hold: step.reason === 'hold',
    sameTask: sameTaskOf(config, advice, facts),
    facts,
    now,
    costs,
  });
  const routedActivity = lateral.move ? activity : incumbent.activity;
  return {
    ...step,
    activity: routedActivity,
    floorActivity: lateral.move ? floorActivity : incumbent.floorActivity,
    reason: lateral.reason,
    estimate: lateral.estimate,
    lateral: lateral.move ? 'taken' : 'refused',
    escalated,
  };
}

// The route a decision runs: the one it recorded, or for a decision from before 1.15 its cell's route in config.
const runningRoute = (config, decision) =>
  decision.route && Object.hasOwn(config.models, decision.route.model)
    ? decision.route
    : resolveRoute(config, decision.tier, decision.activity ?? null);

// Whether some activity's route at the decision's tier is stronger than the one running: only then can the turn's own
// tool calls move it (observedMove), so a step on the strongest route skips reading the transcript.
export function canMoveUp(config, decision, effort) {
  if (config.activityRouting !== 'on' || !decision?.tier || servesOneTurn(decision)) return false;
  const from = runningRoute(config, decision);
  return ACTIVITIES.some((a) => (compareRoutes(config, resolveRoute(config, decision.tier, a), from, effort) ?? 0) > 0);
}

// A move up inside a turn: the classifier labels a turn from its prompt, and a prompt that reads as ops or explore can
// still end up editing code. Once the turn's tool calls show an activity (observedActivity in facts.mjs) whose route at the
// tier is stronger, the remaining steps take that route. The tools are the evidence, so the move needs no classifier
// probability. At probability 1 the switching tax never holds it back (the upgrade bar tops out near 0.9): only the
// cash gate, priced at the context-fitted route, can. Only up: a move down comes from a classifier review, past its
// checks. Returns the loop, unchanged when nothing moves.
export function observedMove(
  config,
  loop,
  { observed, facts, contextKnown, accountHolds, held = /** @type {string[] | null} */ (null), now },
) {
  const decision = loop.decision;
  if (!canMoveUp(config, decision, facts.effort) || !ACTIVITIES.includes(observed)) return loop;
  const from = runningRoute(config, decision);
  // The gates price the route that will run: the one the context fits, not the tier's first choice.
  const routeFor = (candidate) => resolveRoute(config, candidate, observed);
  const tier = fitTier(config, decision.tier, costs.nextContextTokens(facts), routeFor);
  const to = routeFor(tier);
  if ((compareRoutes(config, to, from, facts.effort) ?? 0) <= 0) return loop;
  // A held-out model stays out for the rest of the turn too: routeTurn already kept the turn off it.
  if (isHeld(heldOf(config, loop, accountHolds, now, held), routeSpec(config, to).id)) return loop;
  // Without a reliable reading of the context, a smaller window might overflow, as in routeTurn.
  const window = (route) => routeSpec(config, route).contextWindow;
  if ((!contextKnown || !loop.historyMeasured) && window(to) < window(from)) return loop;
  const projected = economicConfig(config, loop);
  const lateral = lateralMove({ config: projected, from, to, mass: 1, hold: false, facts, now, costs });
  if (!lateral.move) return loop;
  return {
    ...loop,
    lastActivity: observed,
    // The route in use belongs to `lastRoute`: a move the context fitted to another tier leaves it to be rebuilt.
    route: tier === loop.lastRoute ? to : null,
    decision: {
      ...decision,
      tier,
      activity: observed,
      floorActivity: null,
      route: to,
      model: routeSpec(config, to).id,
      effort: costs.routeEffort(config, to, facts.effort),
      reason: lateral.reason,
      estimate: lateral.estimate,
    },
  };
}

// A tool continuation keeps the turn's route and activity; only the context, the model list, or the turn's own tool
// calls (observedMove) can move it. A move never lands on a model held out at `now`.
export function continueRoute(
  current,
  loop,
  {
    nativeModel,
    contextTokens,
    contextKnown,
    availableModels,
    effort,
    hasImages = false,
    accountHolds,
    held = /** @type {string[] | null} */ (null),
    now,
  },
) {
  if (!loop.decision) return loop;
  const heldNow = heldOf(current, loop, accountHolds, now, held);
  // A fit to another tier serves this turn only: `loop.route` stays the route of `lastRoute`, as the tier does.
  let decision = loop.decision;
  const work =
    current.activityRouting === 'on' && !decision.pinned && ['debug', 'code'].includes(decision.floorActivity)
      ? decision.floorActivity
      : null;
  const floor = opsFloor(current, work);
  const config = floor.config;
  const activity = work ?? decision.activity ?? null;
  const tierActivity = (tier) => (floor.retained.includes(tier) ? 'ops' : activity);
  if (!work && decision.floorActivity) decision = { ...decision, floorActivity: null };
  if (contextKnown && decision.tier) {
    // The route the turn runs, which a mode change or a held move can keep apart from config, stays while the context
    // fits it; past that, the routes config gives each tier, its own tier's first.
    const running = runningRoute(config, decision);
    const routeOf = (tier) => resolveRoute(config, tier, activity);
    const fits = contextTokens <= routeSpec(config, running).contextWindow * CONTEXT_FILL;
    const fitted = fits ? decision.tier : fitTier(config, decision.tier, contextTokens, routeOf);
    if (!fits && !sameRoute(routeOf(fitted), running)) {
      const route = routeOf(fitted);
      decision = {
        ...decision,
        tier: fitted,
        activity: tierActivity(fitted),
        route,
        model: routeSpec(config, route).id,
        effort: costs.routeEffort(config, route, effort),
        reason: 'context-fit',
      };
    }
  }
  if (hasImages && decision.tier && routeSpec(config, runningRoute(config, decision))?.imageInput === false) {
    const runningWindow = routeSpec(config, runningRoute(config, decision)).contextWindow;
    const tier = [...TIERS].reverse().find((t) => {
      const model = routeSpec(config, resolveRoute(config, t, activity));
      return (
        model.imageInput !== false &&
        isModelAllowed(model.id, availableModels, nativeModel) &&
        !withheld(loop, heldNow, model.id) &&
        (contextKnown ? contextTokens <= model.contextWindow * CONTEXT_FILL : model.contextWindow >= runningWindow)
      );
    });
    const route = tier ? resolveRoute(config, tier, activity) : null;
    decision = {
      ...decision,
      tier: tier ?? null,
      activity: tier ? tierActivity(tier) : null,
      floorActivity: tier ? work : null,
      route,
      model: route ? routeSpec(config, route).id : nativeModel,
      effort: route ? costs.routeEffort(config, route, effort) : effort,
      reason: 'model-unavailable',
    };
  }
  if (!isModelAllowed(decision.model, availableModels, nativeModel) || withheld(loop, heldNow, decision.model)) {
    const heldOnly = isHeld(heldNow, decision.model) && isModelAllowed(decision.model, availableModels, nativeModel);
    const nativeHeld = isHeld(heldNow, nativeModel);
    const nativeUsable = !nativeHeld && !crossesOwnHistory(config, decision.model, nativeModel);
    // Without a reliable reading, a stand-in with a smaller window than the running model's might overflow (as at a
    // turn's start).
    const runningWindow = routeSpec(config, runningRoute(config, decision))?.contextWindow ?? 0;
    const fitsContext = (spec) =>
      contextKnown && loop.historyMeasured
        ? contextTokens <= spec.contextWindow * CONTEXT_FILL
        : spec.contextWindow >= runningWindow;
    // A model that cannot run falls back to the session model, unless that one is held: then a tier stands in.
    const standIn =
      heldOnly || nativeHeld
        ? heldReplacement(config, decision, effort, {
            held: heldOnly,
            usable: (spec) =>
              isModelAllowed(spec.id, availableModels, nativeModel) &&
              !withheld(loop, heldNow, spec.id) &&
              !crossesOwnHistory(config, decision.model, spec.id) &&
              (!hasImages || spec.imageInput !== false) &&
              fitsContext(spec),
            tierRoute: (tier) => resolveRoute(config, tier, tierActivity(tier)),
          })
        : null;
    if (standIn) decision = standIn;
    // A held model nothing can replace, and no session model to move the history to, keeps the turn.
    else if (!heldOnly || nativeUsable)
      decision = {
        ...decision,
        tier: null,
        activity: null,
        floorActivity: null,
        route: null,
        model: nativeModel,
        effort,
        reason: 'model-unavailable',
        fallback: undefined,
      };
  }
  // A route a fit or a stand-in moved the keyword turn to takes the keyword's effort move too, as its first step did.
  if (decision.keyword && decision.route !== loop.decision.route && typeof decision.route?.effort === 'string')
    decision = { ...decision, effort: keywordEffort(config, decision.keyword, decision.route.model, decision.effort) };
  return { ...loop, decision };
}

// The decision for a turn whose running model became held mid-turn (`held`), or cannot run while the session model is
// held, or null when no route can stand in: a held model's fallback chain, then the nearest tier that runs.
function heldReplacement(config, decision, effort, { held, usable, tierRoute }) {
  const source =
    decision.route && Object.hasOwn(config.models, decision.route.model)
      ? decision.route
      : decision.tier && tierRoute(decision.tier);
  const chained = held && source && chainStandIn(config, source, effort, usable);
  if (chained)
    return {
      ...decision,
      route: chained.route,
      model: routeSpec(config, chained.route).id,
      effort: chained.effort,
      reason: 'model-held',
      fallback: chained.fallback,
    };
  const tier = nearestTiers(decision.tier ?? config.baselineTier).find((t) => usable(routeSpec(config, tierRoute(t))));
  if (!tier) return null;
  const route = tierRoute(tier);
  return {
    ...decision,
    tier,
    route,
    model: routeSpec(config, route).id,
    effort: costs.routeEffort(config, route, effort),
    reason: held ? 'model-held' : 'model-unavailable',
    fallback: undefined,
  };
}

export function observeResponse(config, loop, { usage, requestedModel, effort, stopReason, now }) {
  // Every request counts toward dwell and reviews; a request on another (model, effort) than the last starts a dwell,
  // and so does the first one this loop serves: checks from before it ran on a route the router did not choose.
  const served = `${requestedModel}@${effort ?? 'session'}`;
  const requests = (loop.requests ?? 0) + 1;
  const switched = loop.servedRoute !== served;
  let next = {
    ...loop,
    requests,
    servedRoute: served,
    switchedAt: switched ? { requests, messageCount: loop.lastMessageCount ?? 0 } : (loop.switchedAt ?? null),
  };
  if (stopReason === 'model_context_window_exceeded') {
    next = { ...next, ineligible: [...new Set([...next.ineligible, requestedModel])] };
  }
  if (!usage?.model) return next;
  const sameModel = isSameModel(requestedModel, usage.model);
  if (!sameModel) next = { ...next, suspended: true };
  const counts = ['input_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens', 'output_tokens'];
  if (!counts.every((key) => Number.isFinite(usage[key]) && usage[key] >= 0)) return next;
  const tokens = usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens;
  if (tokens === 0) return next;
  // A real reply from the model ends its run of failed retries (failover.mjs).
  if (sameModel) {
    const held = clearedModel(next.held, requestedModel);
    if (held !== next.held) next = { ...next, held };
  }
  const resolutions = sameModel
    ? { ...next.resolutions, [requestedModel]: usage.model }
    : Object.fromEntries(Object.entries(next.resolutions).filter(([model]) => model !== requestedModel));
  let models = next.models;
  if (next.lastRequest && tokens < next.lastRequest.tokens * HISTORY_SHRINK) models = {};
  // A substituted model's effort is not reported, so do not credit its estimated cache.
  if (sameModel)
    models = {
      ...models,
      [costs.cacheKey(config, usage.model, effort)]: {
        lastAt: now,
        prefixTokens: usage.cache_read_input_tokens + usage.cache_creation_input_tokens,
      },
    };
  return {
    ...next,
    historyMeasured: true,
    models,
    resolutions,
    lastRequest: {
      model: usage.model,
      tokens,
      outputTokens: usage.output_tokens,
      cacheReadTokens: usage.cache_read_input_tokens,
      cacheWriteTokens: usage.cache_creation_input_tokens,
      at: now,
    },
  };
}
