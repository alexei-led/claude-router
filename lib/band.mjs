import { routeLabel, shortReason } from './display.mjs';
import { orTerminal } from './ui/fallback.mjs';
import { graphicalRouteLine, renderGraphicalBand } from './ui/graphical/band.mjs';
import { supportText } from './ui/model/band.mjs';
import { terminalBand, terminalRouteLine } from './ui/terminal/band.mjs';
import { isGraphical } from './ui/tokens.mjs';

/** Draws the band for the surface: native on desktop, VS Code and mobile, the terminal's row otherwise. */
export function renderBand(elements, config, view, usage, opts, actions) {
  return orTerminal(
    opts.surface,
    (surface) => {
      const { columns, agentId, agent = null, agents = [], back = false, now = Date.now() } = opts;
      return isGraphical(surface)
        ? renderGraphicalBand(
            elements,
            config,
            view,
            usage,
            { columns, agentId, agent, agents, back, now, surface },
            actions,
          )
        : terminalBand(elements, config, view, usage, { columns, agentId, agent, agents, back, now }, actions);
    },
    opts.onFallback,
  );
}

/** Draws a turn's route line for the surface (see lib/route-line.mjs). */
export function renderRouteLine(elements, config, line, opts) {
  const { columns, surface, onFallback } = opts;
  return orTerminal(
    surface,
    (drawn) =>
      isGraphical(drawn)
        ? graphicalRouteLine(elements, config, line, { columns })
        : terminalRouteLine(elements, config, line, { columns }),
    onFallback,
  );
}

export function switchToast(config, previous, next, estimate) {
  const label = (decision) => routeLabel(decision.model, decision.effort);
  const support = supportText(config, estimate);
  // "Model changed: Sonnet 5.5 · medium → Haiku 5.5 · high · ↓ ops"
  const why = shortReason(next.reason, next.activity);
  return `Model changed: ${label(previous)} → ${label(next)} · ${why}${support ? ` (${support})` : ''}`;
}
