import { graphicalKit } from './graphical/painter.mjs';
import { kit } from './terminal/kit.mjs';
import { isGraphical } from './tokens.mjs';

/** @typedef {string | object} Part A string, drawn as plain text, or an element. */
/**
 * What the band and pane draw with on every surface, besides the element constructors and text primitives. Every
 * method returns an element.
 * @typedef {object} Painter
 * @property {(opts: { points: number[], labels: string[], alt: string, tone: import('./tokens.mjs').Tone }) => object} trend
 * @property {(tone: import('./tokens.mjs').Tone, text: string, action?: object) => object} notice
 * @property {(tier: import('./tokens.mjs').Tier | null, state: 'lit' | 'pending' | 'off', opts?: { inButton?: boolean }) => object} tierMeter
 */
/**
 * The graphical painter's cards and figures on top: desktop, VS Code and mobile only.
 * @typedef {Painter & {
 *   section: (title: string, opts: { hint?: string, action?: object }, children: object[]) => object,
 *   field: (label: string, parts: Part[], opts?: { help?: string, dim?: boolean }) => object,
 *   meter: (opts: { label?: string, value: number, tone: import('./tokens.mjs').Tone, text: string, caption?: string }) => object,
 *   strip: (strip: { per: number, cells: Record<string, number>[], from?: number | null } | null | undefined, opts: { columns: number | null, now: number, since?: number | null }) => object | null,
 *   stat: (opts: { value: string, caption?: string, delta?: string, tone?: import('./tokens.mjs').Tone }) => object,
 *   choice: (opts: { key: string, options: { value: string, label: string, hint?: string, key?: string, hotkey?: string, icon?: object | object[] }[], selected: string | string[] | null, onPick: (value: string) => void, gap?: string }) => object,
 *   table: (columns: { key: string, label: string, align?: 'left' | 'right', width?: number }[], rows: Record<string, Part>[]) => object,
 * }} GraphicalPainter
 */

/**
 * The painter for a surface: the terminal's, or the graphical one on desktop, VS Code and mobile.
 * @param {any} elements
 * @param {string} [surface]
 */
export const paintersOf = (elements, surface) => (isGraphical(surface) ? graphicalKit(elements) : kit(elements));

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
