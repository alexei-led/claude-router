import { routeLabel, shortReason } from './display.mjs';
import { orTerminal } from './ui/fallback.mjs';
import { renderGraphicalBand } from './ui/graphical/band.mjs';
import { supportText } from './ui/model/band.mjs';
import { terminalBand } from './ui/terminal/band.mjs';
import { isGraphical } from './ui/tokens.mjs';

/** Draws the band for the surface: native on desktop, VS Code and mobile, the terminal's row otherwise. */
export function renderBand(elements, config, view, usage, opts, actions) {
  return orTerminal(
    opts.surface,
    (surface) => {
      const { columns, agentId, agent = null, now = Date.now() } = opts;
      return isGraphical(surface)
        ? renderGraphicalBand(elements, config, view, usage, { columns, agentId, agent, now, surface }, actions)
        : terminalBand(elements, config, view, usage, { columns, agentId, agent, now }, actions);
    },
    opts.onFallback,
  );
}

export function switchToast(config, previous, next, estimate) {
  const label = (decision) => routeLabel(decision.model, decision.effort);
  const support = supportText(config, estimate);
  // "Model changed: Sonnet 5.5 · medium → Haiku 5.5 · high · ↓ ops"
  const why = shortReason(next.reason, next.activity);
  return `Model changed: ${label(previous)} → ${label(next)} · ${why}${support ? ` (${support})` : ''}`;
}
