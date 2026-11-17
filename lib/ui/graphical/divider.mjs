// A hairline between another mod's row and the router's band, so two rows stacked above the prompt do not read as one.
const SOURCE =
  '<svg xmlns="http://www.w3.org/2000/svg" width="4000" height="1" viewBox="0 0 4000 1" preserveAspectRatio="none">' +
  '<rect width="4000" height="1" fill="rgba(127,127,127,0.35)"/></svg>';

// Real pixel markup, one pixel tall, no width prop: the line is as wide as the slot, and the clipping Box keeps it from
// growing if the height is ignored. A surface without Svg draws no divider.
export function bandDivider(elements) {
  if (!elements.Svg) return null;
  const line = elements.Box({
    overflow: 'hidden',
    children: [elements.Svg({ source: SOURCE, alt: 'Divider', height: 1 })],
  });
  // The margin sits on an outer Box so the clipping one cannot cut it. It is below only: the row below has Buttons taller
  // than its text line and the row above carries its own space.
  return elements.Box({ marginBottom: 'md', children: [line] });
}

// What `next(e)` answered counts as a row unless it is nothing: the types do not say what an empty answer is.
export const drewRow = (answer) =>
  answer !== null && answer !== undefined && answer !== false && !(Array.isArray(answer) && answer.length === 0);
