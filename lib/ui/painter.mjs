import { graphicalKit } from './graphical/painter.mjs';
import { kit } from './terminal/kit.mjs';
import { isGraphical } from './tokens.mjs';

/** @typedef {string | object} Part A string, drawn as plain text, or an element. */
/**
 * What the band and pane draw with. Every method returns an element.
 * @typedef {object} Painter
 * @property {(title: string, opts: { hint?: string, action?: object }, children: object[]) => object} section
 * @property {(label: string, parts: Part[], opts?: { help?: string, dim?: boolean }) => object} field
 * @property {(opts: { label?: string, value: number, tone: import('./tokens.mjs').Tone, text: string, caption?: string, cells?: number }) => object} meter
 * @property {(strip: { per: number, cells: Record<string, number>[], from?: number | null } | null | undefined, opts: { columns: number | null, now: number, since?: number | null }) => object | null} strip
 * @property {(opts: { value: string, caption?: string, delta?: string, tone?: import('./tokens.mjs').Tone }) => object} stat
 * @property {(opts: { key: string, options: { value: string, label: string, hint?: string, tone?: import('./tokens.mjs').Tone, key?: string, hotkey?: string, icon?: object | object[] }[], selected: string | string[] | null, onPick: (value: string) => void, gap?: string }) => object} choice
 * @property {(columns: { key: string, label: string, align?: 'left' | 'right', width?: number }[], rows: Record<string, Part>[]) => object} table
 * @property {(opts: { points: number[], labels: string[], alt: string, tone: import('./tokens.mjs').Tone }) => object} trend
 * @property {(tone: import('./tokens.mjs').Tone, text: string, action?: object) => object} notice
 * @property {(tier: import('./tokens.mjs').Tier | null, state: 'lit' | 'pending' | 'off', opts?: { inButton?: boolean }) => object} tierMeter
 */

/**
 * The painter for a surface: the terminal's, or the graphical one on desktop, VS Code and mobile.
 * @param {any} elements
 * @param {string} [surface]
 */
export const paintersOf = (elements, surface) => (isGraphical(surface) ? graphicalKit(elements) : kit(elements));
