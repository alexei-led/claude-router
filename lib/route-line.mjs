// The route line: one row placed at the end of the transcript after a turn, saying which model and effort ran and why.
// Pure: which turns get a row, and what it records. The hook places it (`$.ui.place`) and draws it (`ui.render` on
// `Placed`); the words and the glyphs are the band's (ui/model/band.mjs).

export const LINE_MODES = ['off', 'moves', 'all'];
// `moves` says the route only when it is not the last turn's.
export const DEFAULT_LINE_MODE = 'moves';
const ID_PREFIX = 'rl-';
// `$.ui.place` takes 1 to 64 letters, digits, `_` and `-`.
const ID_MAX = 64;

export const lineModeOf = (stored) => (LINE_MODES.includes(stored) ? stored : DEFAULT_LINE_MODE);

/** The row's id for a turn: its id with anything `$.ui.place` refuses made `_`, so one turn has one row. */
export const lineId = (turnId) => `${ID_PREFIX}${String(turnId).replace(/[^A-Za-z0-9_-]/g, '_')}`.slice(0, ID_MAX);

/** The route a view shows: the model that served the turn, else the one chosen, and its effort; null with neither. */
export function routeOf(view) {
  const model = view?.actualModel ?? view?.selectedModel ?? null;
  return model ? { model, effort: view.effort ?? null } : null;
}

/** Whether a turn that ran `route` gets a row, after one that ran `previous` (null at a session's first routed turn). */
export function showsLine(mode, previous, route) {
  if (mode === 'off') return false;
  return mode === 'all' || !previous || previous.model !== route.model || previous.effort !== route.effort;
}

/**
 * What the row keeps: the route, the tier it ran for, why, the activity and the policy's estimate; nothing of the
 * prompt.
 * @returns {{ model: string, effort: string | number | null, tier: string | null, reason: string, activity: string | null, estimate: object | null }}
 */
export function lineOf(view, route) {
  return {
    model: route.model,
    effort: route.effort,
    tier: view.tier ?? null,
    reason: view.reason ?? 'ready',
    activity: view.activity ?? null,
    estimate: view.estimate ?? null,
  };
}
