// Facts the policy needs, derived from one Messages request body plus what the router remembers
// about the conversation. Pure: body and memory in, plain object out.
import { createHash } from 'node:crypto';

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash']);
const FAILURE_WINDOW = 40;
const REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>/g;
const CLIP_MARKER = ' […] ';
// A typed /router:<tier> reaches the gateway as a command block at the start of a text block. Anchored, so a pasted
// file or quoted log that mentions the marker cannot pin a tier.
const PIN = /^<command-message>router:([a-z]+)<\/command-message>/;

export function factsFromRequest(body, memory, { recentTurns, maxTextChars }) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  // Claude Code puts hook output and tool additions in `system` messages after the user message, and keeps them in
  // the history: the turn is the last user or assistant message.
  const lastIndex = messages.findLastIndex((m) => m?.role !== 'system');
  const last = messages[lastIndex];
  const lastBlocks = blocks(last?.content);
  // The current user message goes to Jev as the prompt; `turns` holds only the dialogue before it.
  const current = last?.role === 'user' ? lastIndex : -1;
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
    if (index !== current && text && (message.role === 'user' || message.role === 'assistant'))
      turns.push({ role: message.role, text: clip(text, maxTextChars) });
  });
  return {
    turns: turns.slice(-recentTurns),
    prompt: current === -1 ? '' : clip(textOf(lastBlocks), maxTextChars),
    continuation: last?.role === 'user' && lastBlocks.some((b) => b.type === 'tool_result'),
    // The tier named by a /router:<tier> in the current message; the router checks that it is a tier.
    pin: current === -1 ? null : pinOf(lastBlocks),
    // The same position and the same last user message: Claude Code resent the request (429, 529, a dropped stream, or
    // a 400 it answers by dropping a feature from the system message after it).
    turnKey: last?.role === 'user' ? `${lastIndex + 1}:${hash(JSON.stringify(last.content))}` : null,
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

// At most `max` characters: the head and the tail of a long text, where a request and its question usually are.
function clip(text, max) {
  if (text.length <= max) return text;
  if (max <= CLIP_MARKER.length) return text.slice(0, max);
  const room = max - CLIP_MARKER.length;
  const head = Math.ceil(room / 2);
  return `${text.slice(0, head)}${CLIP_MARKER}${text.slice(text.length - (room - head))}`;
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

function pinOf(content) {
  for (const block of content) {
    const match = block.type === 'text' && typeof block.text === 'string' ? PIN.exec(block.text) : null;
    if (match) return match[1];
  }
  return null;
}
