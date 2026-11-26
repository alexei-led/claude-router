// The words `/router` takes: one table that the command, its argument hint and the prompt's typeahead all read, so a
// word added in one place cannot be missing in another. The handlers sit beside the command in the hook; a test runs
// the command with every word and value here.
import { ACTIVITY_MODES, ROUTING_ENGINES, ROUTING_MODES, TIERS } from './config.mjs';
import { LINE_MODES } from './route-line.mjs';

/**
 * @typedef {object} Subcommand
 * @property {string} name
 * @property {string} description one line, drawn beside the word in the typeahead
 * @property {string[]} [values] what may follow the word; the typeahead offers each
 * @property {Record<string, string>} [about] what each value does, one line drawn beside it in the typeahead
 * @property {string} [source] a name for values that are not fixed: the hook gives the typeahead the ones that apply now
 * @property {string} [hint] how the argument hint spells what follows the word; the values when absent
 */

/** @type {readonly Subcommand[]} */
export const SUBCOMMANDS = [
  { name: 'on', description: 'Routing on for the current engine' },
  { name: 'off', description: 'Routing off: Claude’s model is kept' },
  {
    name: 'engine',
    description: 'The routing engine',
    values: ROUTING_ENGINES,
    about: {
      table: 'Tier routes, moved by classifier votes (the default)',
      shadow: 'Tier routes; the automatic engine’s proposals are recorded beside them',
      auto: 'Model and effort chosen from the catalog by classifier demand',
    },
  },
  { name: 'pin', description: 'Pin the next turn to a tier', values: TIERS, hint: '<tier>' },
  {
    name: 'mode',
    description: 'Routing mode',
    values: [...ROUTING_MODES, 'default'],
    hint: '<mode>',
    about: {
      cost: 'Cheaper: the tier below where it is cheaper, else one effort level less',
      balanced: 'Every tier runs its route as configured',
      quality: 'Stronger: one effort level more, else the tier above',
      default: 'Drop this session’s mode: the project’s or profile’s applies',
    },
  },
  {
    name: 'activities',
    description: 'Activity routing',
    values: ACTIVITY_MODES,
    about: { off: 'Each tier runs one route', on: 'An activity can change its tier’s route' },
  },
  {
    name: 'line',
    description: 'The route line after a turn',
    values: LINE_MODES,
    about: {
      off: 'No route line',
      moves: 'A route line when the route moved (the default)',
      all: 'A route line after every turn',
    },
  },
  { name: 'decisions', description: 'The last routing decisions', hint: '[n]' },
  { name: 'holds', description: 'The models and accounts held out of routing' },
  { name: 'release', description: 'End a hold early', source: 'held', hint: '<model|account>' },
  {
    name: 'trace',
    description: 'Export the shadow traces',
    values: ['export'],
    hint: 'export',
    about: { export: 'Export the shadow traces' },
  },
];

const slot = (sub) => sub.hint ?? (sub.values ? `<${sub.values.join('|')}>` : undefined);

/** The command's argument hint: `[auto|off|pin <tier>|…|activities <off|on>|…]`. */
export const argumentHint = () =>
  `[${SUBCOMMANDS.map((sub) => (slot(sub) ? `${sub.name} ${slot(sub)}` : sub.name)).join('|')}]`;

/**
 * The typeahead rows for the token at the cursor: the words after `/router `, or the values after a word that takes
 * them. Claude Code asks for rows only while a token is under the caret, never after `/router mode `, so a word that
 * takes values is offered once per value, `mode cost`, each row a whole command. A word whose values none apply now
 * (`release` with nothing held) is offered as itself. Nothing when the token is not in an argument of `/router`, or
 * nothing matches.
 * @param {{ text: string, start: number, token: string }} input
 * @param {{ describe?: (name: string, value: string) => string | undefined, sources?: Record<string, string[]> }} [options]
 *   `sources` holds the values of each `source` word that apply now
 * @returns {{ text: string, label?: string, description?: string }[]}
 */
export function routerSuggestions({ text, start, token }, { describe, sources } = {}) {
  const lead = text.slice(0, start).match(/^\/router\s+(?:(\S+)\s+)?$/);
  if (!lead) return [];
  const typed = token.toLowerCase();
  const matching = (candidate) => candidate.toLowerCase().startsWith(typed);
  const valuesOf = (sub) => sub.values ?? (sub.source ? sources?.[sub.source] : undefined) ?? [];
  const about = (sub, value) => describe?.(sub.name, value) ?? sub.about?.[value] ?? sub.description;
  if (!lead[1])
    return SUBCOMMANDS.filter((sub) => matching(sub.name)).flatMap((sub) => {
      const values = valuesOf(sub);
      if (values.length)
        return values.map((value) => {
          const command = `${sub.name} ${value}`;
          return { text: command, label: command, description: about(sub, value) };
        });
      return [
        { text: sub.name, label: slot(sub) ? `${sub.name} ${slot(sub)}` : sub.name, description: sub.description },
      ];
    });
  const word = SUBCOMMANDS.find((item) => item.name === lead[1]);
  if (!word) return [];
  return valuesOf(word)
    .filter(matching)
    .map((value) => ({ text: value, label: value, description: about(word, value) }));
}
