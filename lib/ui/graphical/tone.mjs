// The graphical surfaces' shared text helpers: a tone's colour, and muted secondary text.
import { toneColor } from '../tokens.mjs';

export const tone = (name) => toneColor(name, 'graphical');

// Muted secondary text, cut at the end unless `extra` says how it wraps.
export const muted = (ui, words, extra = {}) =>
  ui.text(words, { color: tone('muted'), wrap: 'truncate-end', ...extra });
