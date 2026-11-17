// Word wrapping for terminal rows, which Ink's own wrap would do without the row's indent.

/**
 * `pieces` packed into lines of at most `width` cells after `indent`.
 * @param {string[][]} pieces each piece and the joiner that follows it
 * @param {number} width
 * @param {string} indent
 */
export function pack(pieces, width, indent) {
  const lines = [];
  let line = '';
  let joiner = '';
  for (const [text, next] of pieces) {
    if (line && indent.length + line.length + joiner.length + text.length > width) {
      lines.push(indent + line);
      line = text;
    } else line += (line ? joiner : '') + text;
    joiner = next;
  }
  return line ? [...lines, indent + line] : lines;
}

/**
 * A dim sentence wrapped by words to a narrow pane, keeping its indent.
 * @param {any} ui the terminal painter
 * @param {string} text
 * @param {number | null} columns
 */
export const dimLines = (ui, text, columns) => {
  const indent = /^ */.exec(text)[0];
  const words = text
    .trim()
    .split(' ')
    .map((word) => [word, ' ']);
  return (Number.isFinite(columns) ? pack(words, columns, indent) : [text]).map((line) => ui.dim(line));
};
