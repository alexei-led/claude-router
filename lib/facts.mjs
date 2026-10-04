import { createHash } from 'node:crypto';
import { extractFacts } from './facts-pure.mjs';

export function factsFromRequest(body, memory, options) {
  return extractFacts(body, memory, options, (last, index) => {
    const hash = createHash('sha256').update(JSON.stringify(last.content)).digest('hex').slice(0, 16);
    return `${index + 1}:${hash}`;
  });
}
