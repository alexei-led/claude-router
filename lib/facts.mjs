// Facts the policy needs, derived from one Messages request body plus what the router remembers
// about the conversation. Pure: body and memory in, plain object out.
import { createHash } from 'node:crypto';

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash']);
const FAILURE_WINDOW = 40;
const REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>/g;

export function factsFromRequest(body, memory, { recentTurns, maxTextChars }) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const last = messages.at(-1);
  const lastBlocks = blocks(last?.content);
  const turns = [];
  const errors = [];
  const edits = [];
  messages.forEach((message, index) => {
    const content = blocks(message.content);
    if (message.role === 'user') {
      for (const block of content)
        if (block.type === 'tool_result' && block.is_error) errors.push({ index, signature: signatureOf(block) });
    } else if (message.role === 'assistant') {
      for (const block of content) if (block.type === 'tool_use' && EDIT_TOOLS.has(block.name)) edits.push(index);
    }
    const text = textOf(content);
    if (text && (message.role === 'user' || message.role === 'assistant'))
      turns.push({ role: message.role, text: text.slice(0, maxTextChars) });
  });
  return {
    turns: turns.slice(-recentTurns),
    prompt: last?.role === 'user' ? textOf(lastBlocks) : '',
    continuation: last?.role === 'user' && lastBlocks.some((b) => b.type === 'tool_result'),
    // The same history length and the same last message: Claude Code resent the request (429, 529, a dropped stream).
    turnKey: last?.role === 'user' ? `${messages.length}:${hash(JSON.stringify(last.content))}` : null,
    failure: repeatedFailure(errors, edits, messages.length - 1),
    // The effort Claude Code sent: a route without its own effort keeps it, and it is part of the cache key.
    effort: body.output_config?.effort ?? null,
    lastRoute: memory.lastRoute,
    lastRequest: memory.lastRequest,
    models: memory.models,
  };
}

// Two errors with the same signature and an edit attempt between them, all inside the recent window.
function repeatedFailure(errors, edits, lastIndex) {
  const recent = errors.filter((e) => lastIndex - e.index <= FAILURE_WINDOW);
  for (let j = recent.length - 1; j > 0; j -= 1) {
    for (let i = j - 1; i >= 0; i -= 1) {
      if (recent[i].signature !== recent[j].signature) continue;
      if (edits.some((k) => k > recent[i].index && k < recent[j].index))
        return { signature: recent[j].signature, index: recent[j].index };
    }
  }
  return null;
}

function signatureOf(block) {
  return textOf(blocks(block.content)).toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ').slice(0, 120);
}

function hash(text) {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

function blocks(content) {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return Array.isArray(content) ? content : [];
}

function textOf(content) {
  return content
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text.replace(REMINDER, ''))
    .join('\n')
    .trim();
}
