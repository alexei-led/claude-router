import { graphicalClassifier } from './ui/graphical/classifier.mjs';
import { graphicalFrame } from './ui/graphical/frame.mjs';
import { graphicalNow } from './ui/graphical/now.mjs';
import { graphicalPolicy } from './ui/graphical/policy.mjs';
import { graphicalRoutes } from './ui/graphical/routes.mjs';
import { graphicalUsage } from './ui/graphical/usage.mjs';
import { classifierOf } from './ui/model/classifier.mjs';
import { frameOf } from './ui/model/frame.mjs';
import { nowOf } from './ui/model/now.mjs';
import { policyOf } from './ui/model/policy.mjs';
import { routesOf } from './ui/model/routes.mjs';
import { usageOf } from './ui/model/usage.mjs';
import { orTerminal, paintersOf } from './ui/painter.mjs';
import { terminalClassifier } from './ui/terminal/classifier.mjs';
import { terminalFrame } from './ui/terminal/frame.mjs';
import { terminalNow } from './ui/terminal/now.mjs';
import { terminalPolicy } from './ui/terminal/policy.mjs';
import { terminalRoutes } from './ui/terminal/routes.mjs';
import { terminalUsage } from './ui/terminal/usage.mjs';
import { isGraphical } from './ui/tokens.mjs';

/**
 * A tab: the model it builds from the pane's context, and how each kind of surface draws that model. The generic ties a
 * tab's renderers to its model, so tsc catches a renderer that reads what the model no longer holds.
 * @template M
 * @param {string} id
 * @param {string} key the hotkey
 * @param {string} label
 * @param {(ctx: PaneContext) => M} modelOf
 * @param {(ui: any, model: M, ctx: PaneContext) => object[]} terminal
 * @param {(ui: any, model: M, ctx: PaneContext) => object[]} graphical
 */
const tabOf = (id, key, label, modelOf, terminal, graphical) => ({
  id,
  key,
  label,
  draw: (ui, ctx) => (isGraphical(ctx.surface) ? graphical : terminal)(ui, modelOf(ctx), ctx),
});

/** @typedef {import('./ui/model/frame.mjs').PaneContext} PaneContext */

// The tabs, in order. Routes and Policy edit one draft and save together, Classifier saves each pick at once.
const TABS = [
  tabOf('now', '1', 'Now', nowOf, terminalNow, graphicalNow),
  tabOf('routes', '2', 'Routes', routesOf, terminalRoutes, graphicalRoutes),
  tabOf('policy', '3', 'Policy', policyOf, terminalPolicy, graphicalPolicy),
  tabOf('classifier', '4', 'Classifier', classifierOf, terminalClassifier, graphicalClassifier),
  tabOf('usage', '5', 'Usage', usageOf, terminalUsage, graphicalUsage),
];

export function renderPanel(elements, config, view, usage, actions, opts = {}) {
  return orTerminal(
    opts.surface,
    (surface) => drawPanel(elements, config, view, usage, actions, { ...opts, surface }),
    opts.onFallback,
  );
}

function drawPanel(elements, config, view, usage, actions, opts) {
  /** @type {import('./ui/model/frame.mjs').PaneContext} */
  const ctx = {
    config,
    view,
    usage,
    actions,
    modelOptions: opts.modelOptions ?? Object.keys(config.models),
    columns: opts.columns ?? null,
    now: opts.now ?? Date.now(),
    surface: opts.surface,
    pluginId: opts.pluginId ?? 'router',
  };
  const ui = paintersOf(elements, ctx.surface);
  const tab = TABS.find(({ id }) => id === view.tab) ?? TABS[0];
  const graphical = isGraphical(ctx.surface);
  const content = tab.draw(ui, ctx);
  const frame = frameOf(ctx, tab.id);
  return graphical
    ? graphicalFrame(ui, frame, TABS, tab.id, actions, content)
    : terminalFrame(ui, frame, TABS, tab.id, actions, content, ctx.columns);
}
