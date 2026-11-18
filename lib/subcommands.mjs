// The words `/router` takes: one table that the command, its argument hint and the prompt's typeahead all read, so a
// word added in one place cannot be missing in another. The handlers sit beside the command in the hook; a test runs
// the command with every word and value here.
import { ACTIVITY_MODES, ROUTING_MODES, TIERS } from './config.mjs';

/**
 * @typedef {object} Subcommand
 * @property {string} name
 * @property {string} description one line, drawn beside the word in the typeahead
 * @property {string[]} [values] what may follow the word; the typeahead offers each
 * @property {string} [hint] how the argument hint spells what follows the word; the values when absent
 */

/** @type {readonly Subcommand[]} */
export const SUBCOMMANDS = [
  { name: 'auto', description: 'Routing on' },
  { name: 'off', description: 'Routing off: Claude’s model is kept' },
  { name: 'pin', description: 'Pin the next turn to a tier', values: TIERS, hint: '<tier>' },
  { name: 'mode', description: 'Routing mode', values: [...ROUTING_MODES, 'default'], hint: '<mode>' },
  { name: 'activities', description: 'Activity routing', values: ACTIVITY_MODES },
  { name: 'decisions', description: 'The last routing decisions', hint: '[n]' },
  { name: 'trace', description: 'Export the shadow traces', values: ['export'], hint: 'export' },
];

const slot = (sub) => sub.hint ?? (sub.values ? `<${sub.values.join('|')}>` : undefined);

/** The command's argument hint: `[auto|off|pin <tier>|…|activities <off|on>|…]`. */
export const argumentHint = (subcommands = SUBCOMMANDS) =>
  `[${subcommands.map((sub) => (slot(sub) ? `${sub.name} ${slot(sub)}` : sub.name)).join('|')}]`;

// A word is taken as its token followed by a space where more is expected, so the box asks again for the value.
const takes = (sub) => Boolean(sub.values?.length);

/**
 * The typeahead rows for the token at the cursor: the words after `/router `, or the values after a word that takes
 * them. Nothing when the token is not in an argument of `/router`, or nothing matches.
 * @param {{ text: string, start: number, token: string }} input
 * @param {{ subcommands?: readonly Subcommand[], describe?: (name: string, value: string) => string | undefined }} [options]
 * @returns {{ text: string, label?: string, description?: string }[]}
 */
export function routerSuggestions({ text, start, token }, { subcommands = SUBCOMMANDS, describe } = {}) {
  const lead = text.slice(0, start).match(/^\/router\s+(?:(\S+)\s+)?$/);
  if (!lead) return [];
  const typed = token.toLowerCase();
  const matching = (candidate) => candidate.toLowerCase().startsWith(typed);
  if (!lead[1])
    return subcommands
      .filter((sub) => matching(sub.name))
      .map((sub) => ({
        text: takes(sub) ? `${sub.name} ` : sub.name,
        label: slot(sub) ? `${sub.name} ${slot(sub)}` : sub.name,
        description: sub.description,
      }));
  const word = subcommands.find((item) => item.name === lead[1]);
  return (word?.values ?? []).filter(matching).map((value) => {
    const description = describe?.(word.name, value);
    return { text: value, label: value, ...(description ? { description } : {}) };
  });
}
