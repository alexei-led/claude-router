import { kit } from './terminal/kit.mjs';

/** @typedef {string | object} Part A string, drawn as plain text, or an element. */
/**
 * What the band and pane draw with. Every method returns an element.
 * @typedef {object} Painter
 * @property {(title: string, opts: { hint?: string, action?: object }, children: object[]) => object} section
 * @property {(label: string, parts: Part[], opts?: { help?: string, dim?: boolean }) => object} field
 * @property {(opts: { label?: string, value: number, tone: import('./tokens.mjs').Tone, text: string, caption?: string, cells?: number }) => object} meter
 * @property {(strip: { per: number, cells: Record<string, number>[], from?: number | null } | null | undefined, opts: { columns: number | null, now: number }) => object} strip
 * @property {(opts: { value: string, caption?: string, delta?: string, tone?: import('./tokens.mjs').Tone }) => object} stat
 * @property {(opts: { key: string, options: { value: string, label: string, hint?: string, tone?: import('./tokens.mjs').Tone }[], selected: string | null, onPick: (value: string) => void }) => object} choice
 * @property {(columns: { key: string, label: string, align?: 'left' | 'right', width?: number }[], rows: Record<string, Part>[]) => object} table
 * @property {(tone: import('./tokens.mjs').Tone, text: string, action?: object) => object} notice
 */

/**
 * The painter for a surface. Until the graphical kit exists every surface draws with the terminal's.
 * @param {any} elements
 * @param {string} [_surface]
 */
export const paintersOf = (elements, _surface) => kit(elements);
