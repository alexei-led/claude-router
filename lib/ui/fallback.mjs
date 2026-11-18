import { isGraphical } from './tokens.mjs';

/**
 * Draws with `draw(surface)`. On a graphical surface with an `onFallback`, a throw is handed to it and the terminal
 * tree is drawn instead, which is what those surfaces drew before the graphical renderers. With no `onFallback` the
 * throw propagates, so a broken graphical renderer cannot pass as the terminal tree. The terminal's own throw is never
 * caught: there is nothing under it.
 * @template T
 * @param {string | undefined} surface
 * @param {(surface: string | undefined) => T} draw
 * @param {((error: unknown) => void) | undefined} onFallback
 * @returns {T}
 */
export function orTerminal(surface, draw, onFallback) {
  if (!isGraphical(surface) || !onFallback) return draw(surface);
  try {
    return draw(surface);
  } catch (error) {
    onFallback(error);
    return draw('terminal');
  }
}
