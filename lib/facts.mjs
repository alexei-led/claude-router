// Facts the policy needs, derived from one Messages request body plus what the router remembers
// about the conversation. Pure: body and memory in, plain object out.

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash']);
const FAILURE_WINDOW = 40;
const REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>/g;
const CLIP_MARKER = ' […] ';
const ANSI_ESCAPE = new RegExp(`${String.fromCharCode(0x1b)}\\[[0-?]*[ -/]*[@-~]`, 'g');

// Images can arrive inside a tool result, not just a user message.
export function hasImages(messages) {
  const contains = (content) =>
    blocks(content).some(
      (block) => block.type === 'image' || (block.type === 'tool_result' && contains(block.content)),
    );
  return messages.some((message) => contains(message.content));
}

export function extractFacts(body, memory, { recentTurns, maxTextChars }) {
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
    if (message.role === 'user' && messages.length - 1 - index <= FAILURE_WINDOW) {
      for (const block of content)
        if (block.type === 'tool_result' && block.is_error) {
          const signature = signatureOf(block);
          if (signature) errors.push({ index, signature });
        }
    } else if (message.role === 'assistant') {
      for (const block of content) if (block.type === 'tool_use' && EDIT_TOOLS.has(block.name)) edits.push(index);
    }
    const text = textOf(content);
    if (index !== current && text && (message.role === 'user' || message.role === 'assistant'))
      turns.push({ role: message.role, text: clip(text, maxTextChars) });
  });
  return {
    hasImages: hasImages(messages),
    turns: turns.slice(-recentTurns),
    prompt: current === -1 ? '' : clip(textOf(lastBlocks), maxTextChars),
    continuation: last?.role === 'user' && lastBlocks.some((b) => b.type === 'tool_result'),
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
export function clip(text, max) {
  if (text.length <= max) return text;
  if (max <= CLIP_MARKER.length) return text.slice(0, max);
  const room = max - CLIP_MARKER.length;
  const head = Math.ceil(room / 2);
  return `${text.slice(0, head)}${CLIP_MARKER}${text.slice(text.length - (room - head))}`;
}

function signatureOf(block) {
  const text = textOf(blocks(block.content))
    .replace(ANSI_ESCAPE, '')
    .replace(/\r\n?/g, '\n')
    .replace(/^([ \t]*at[ \t]+[^\n]+\.[a-z]+):\d+(?::\d+)?(\)?)[ \t]*$/gim, '$1:#$2')
    .replace(/^([ \t]*location:[ \t]*['"]?[^\n'"]+\.[a-z]+):\d+(?::\d+)?(['"]?)[ \t]*$/gim, '$1:#$2')
    .replace(/^([ \t]*(?:#[ \t]*)?duration_ms:?[ \t]+)\d+(?:\.\d+)?[ \t]*$/gm, '$1#')
    .replace(/^([ \t]*✕[ \t]+.+) \(\d+(?:\.\d+)? ms\)$/gm, '$1 (# ms)')
    .trim();
  if (!text) return '';
  // FNV-1a keeps the full diagnostic in a bounded key without Node APIs in the Mod sandbox.
  // Unknown runner noise is kept: changed output conservatively counts as a new failure.
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i += 1)
    hash = BigInt.asUintN(64, (hash ^ BigInt(text.charCodeAt(i))) * 0x100000001b3n);
  return hash.toString(16);
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

const FILE_EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const DOC_PATH = /\.(?:md|mdx|rst|txt)$|(?:^|[\\/])docs[\\/]/i;
const READ_COMMANDS = new Set(['cat', 'ls', 'grep', 'rg', 'find', 'head', 'tail', 'cd']);
const READ_GIT = new Set(['status', 'log', 'diff', 'show']);
const SEPARATORS = /&&|\|\||[;|&\n]/;
// find can run or delete what it finds.
const WRITING_FIND = /\s-(?:exec|execdir|ok|okdir|delete)\b/;

// A command as the classifiers read it: quoted text blanked, so a `;` or `>` inside a pattern is not shell syntax, and
// redirects of a stream into another stream or into /dev/null dropped, as they write no file. Every classifier below
// reads this one form, so they agree on what a command is.
const bareCommand = (command) =>
  command.replace(/'[^']*'|"[^"]*"/g, '""').replace(/\d?>\s*&\d|\d?>\s*\/dev\/null/g, '');

// The index of the last user prompt, a user message that is not a tool result: where the latest turn starts. -1 when
// there is none.
export function promptIndex(messages) {
  return messages.findLastIndex(
    (m) => m?.role === 'user' && !blocks(m.content).some((block) => block?.type === 'tool_result'),
  );
}

// The bucket of a finished turn, from the tool calls the assistant made after the user message at `fromIndex`:
// code, docs, shell, ops, check, read or talk. First match wins; only names and paths are read, no text is kept.
// `shell` is a candidate, not proven code: a command that writes a file's content (a redirect, `tee`, `sed -i`, a
// patch), which may be code, docs or routine work. `check` is a turn whose only commands that are not reads are
// checks (`npm test`, `tsc`): a review or a verification. Routine file commands (`rm`, `mv`, `mkdir`) stay `ops`.
export function observedActivity(messages, fromIndex) {
  const calls = [];
  for (let i = fromIndex + 1; i < messages.length; i += 1)
    if (messages[i]?.role === 'assistant')
      for (const block of blocks(messages[i].content)) if (block.type === 'tool_use') calls.push(block);
  const edited = calls.filter((c) => FILE_EDIT_TOOLS.has(c.name));
  if (edited.length > 0) return edited.every((c) => DOC_PATH.test(editPath(c))) ? 'docs' : 'code';
  const commands = calls.filter((c) => c.name === 'Bash').map((c) => commandKind(c.input?.command));
  if (commands.includes('shell')) return 'shell';
  if (commands.includes('ops')) return 'ops';
  if (commands.includes('check')) return 'check';
  return calls.length > 0 ? 'read' : 'talk';
}

// The activity routing reads from a bucket: `shell` and `check` route as `ops`, the commands they are. The finer
// buckets serve the agreement counts only, so they change no route.
export const routingBucket = (bucket) => (bucket === 'shell' || bucket === 'check' ? 'ops' : bucket);

// One Bash command as `read`, `shell` (writes a file's content), `check` (a checker whose status is its own) or
// `ops` (anything else that runs).
function commandKind(command) {
  if (readsOnly(command)) return 'read';
  if (writesFile(command)) return 'shell';
  return verifies(command) && checksOnly(command) ? 'check' : 'ops';
}

// Some command of the pipeline or list runs a check, whatever its status reports: `npm test | tail`, `npm test; true`.
function runsAnyCheck(command) {
  if (typeof command !== 'string') return false;
  return bareCommand(command)
    .split(SEPARATORS)
    .some((part) => part.trim() !== '' && runsCheck(part.trim().split(/\s+/)));
}

// Every step of an `&&` list is a check or a read: `npm test && git commit` runs something besides the check.
function checksOnly(command) {
  const bare = bareCommand(command);
  return bare.split('&&').every((step) => runsCheck(step.trim().split(/\s+/)) || readsOnly(step));
}

// A command that writes a file's content: an output redirect to a file, `tee`, an in-place `sed` or `perl`, `patch`
// or `git apply`. Quoted text is blanked first, as readsOnly does, so a `>` inside a pattern is not a redirect.
const SHELL_WRITERS = [
  /(?:^|[^<>&\d])\d?>>?\s*[^\s&|>]/,
  /(?:^|[\s;&|(])tee\b/,
  /(?:^|[\s;&|(])sed\b[^;&|]*\s(?:-[a-zA-Z]*i|--in-place)\b/,
  /(?:^|[\s;&|(])perl\b[^;&|]*\s-[a-zA-Z]*i/,
  /(?:^|[\s;&|(])patch\b/,
  /(?:^|[\s;&|(])git\s+apply\b/,
];
function writesFile(command) {
  if (typeof command !== 'string') return false;
  const bare = bareCommand(command);
  return SHELL_WRITERS.some((pattern) => pattern.test(bare));
}

function editPath(call) {
  const path = call.input?.file_path ?? call.input?.notebook_path;
  return typeof path === 'string' ? path : '';
}

// Every command of a pipeline or list only reads. Command substitution runs inside double quotes, so it is looked for
// in the whole command; a literal one in single quotes counts too. Quoted text is then blanked, so a `;` or `>` inside
// a pattern is not taken for shell syntax. Anything unrecognised counts as running something.
function readsOnly(command) {
  if (typeof command !== 'string' || /`|\$\(/.test(command)) return false;
  const bare = bareCommand(command);
  if (/[<>]/.test(bare) || WRITING_FIND.test(bare)) return false;
  return bare.split(SEPARATORS).every((part) => {
    if (!part.trim()) return true;
    const [name, sub] = part.trim().split(/\s+/);
    return name === 'git' ? READ_GIT.has(sub) : READ_COMMANDS.has(name);
  });
}

// A command whose success shows that a check passed: a checker run, or a launcher whose subcommand names a check
// (`npm test`, `npm run lint`, `go test`, `make lint`, `uv run pytest`, `python -m pytest`, `node --test`), alone or in an
// `&&` list, so the command's status is the check's. A pipeline, `;`, `||` or background job can hide a failed check,
// so none of them counts. Neither do package names, paths and file names: `npm install -D vitest`, `git diff test/x.mjs`.
const CHECKERS = new Set(['pytest', 'jest', 'vitest', 'mocha', 'tsc', 'eslint', 'biome', 'ruff', 'mypy', 'pyright']);
const LAUNCHERS = new Set([
  'npm',
  'pnpm',
  'yarn',
  'bun',
  'npx',
  'bunx',
  'uv',
  'uvx',
  'poetry',
  'cargo',
  'go',
  'make',
  'just',
  'gradle',
  'gradlew',
  'mvn',
  'dotnet',
  'swift',
  'deno',
  'node',
  'python',
  'python3',
  'tox',
]);
const RUNS = new Set(['run', 'exec', 'x', 'dlx']);
const CHECK_WORD =
  /\b(?:test|tests|pytest|jest|vitest|mocha|tsc|typecheck|lint|eslint|biome|ruff|mypy|pyright|clippy|build|check|validate)\b/;

function verifies(command) {
  if (typeof command !== 'string') return false;
  const bare = bareCommand(command);
  const steps = bare.split('&&');
  if (steps.some((step) => /\|\||[;|&\n]/.test(step))) return false;
  return steps.some((step) => runsCheck(step.trim().split(/\s+/)));
}

// A version or help request runs no check.
const INFO = /^(?:--version|-V|--help|-h|help|version)$/;

// An option before the subcommand may take a value (`npm --prefix test install`), so the subcommand must come first;
// `python -m` is the one option form read. Anything else unrecognised does not count.
function runsCheck(words) {
  while (words.length > 1 && /^\w+=/.test(words[0])) words.shift();
  const [first, ...rest] = words;
  const name = first.split('/').pop();
  if (rest.some((w) => INFO.test(w))) return false;
  if (CHECKERS.has(name)) return true;
  if (!LAUNCHERS.has(name)) return false;
  if (rest.some((w) => /^--test\b/.test(w))) return true;
  let args = (name === 'python' || name === 'python3') && rest[0] === '-m' ? rest.slice(1) : rest;
  if (RUNS.has(args[0])) args = args.slice(1);
  const sub = args[0] ?? '';
  return !sub.startsWith('-') && !sub.includes('/') && !/\.\w+$/.test(sub) && CHECK_WORD.test(sub);
}

// Whether the last verification command at or after message `fromIndex` passed: the progress checkpoint a move to a
// cheaper route on the same task waits for. False when none ran since, or the last one failed (an unresolved failure),
// or it went to the background, by request or after a timeout: its result reports the launch, not the check.
export function verifiedSince(messages, fromIndex) {
  let last = null;
  for (let i = Math.max(0, fromIndex); i < messages.length; i += 1)
    if (messages[i]?.role === 'assistant')
      for (const block of blocks(messages[i].content))
        if (block.type === 'tool_use' && block.name === 'Bash' && verifies(block.input?.command))
          last = { id: block.id, index: i, background: block.input?.run_in_background === true };
  if (!last || last.background) return false;
  for (let i = last.index + 1; i < messages.length; i += 1)
    for (const block of blocks(messages[i]?.content))
      if (block.type === 'tool_result' && block.tool_use_id === last.id)
        return !block.is_error && !BACKGROUNDED.test(textOf(blocks(block.content)));
  return false;
}

// What Claude Code's Bash tool returns for a command it moved to the background.
const BACKGROUNDED = /running in background|moved to the background/i;

const DELEGATING = new Set(['Agent', 'Task']);
const READ_ONLY_ACTIVITIES = new Set(['explore', 'plan', 'review']);

// Positive evidence that the work since message `fromIndex` reached a checkpoint, by the activity the running route
// serves: the checkpoint a move to a cheaper route on the same task waits for. A passed check (verifiedSince) always
// counts. Without one:
// - `ops`: the last command that ran something succeeded, and no edit or delegation happened.
// - `docs`: the last edit succeeded and touched only doc paths, with no other command writing or running.
// - `explore`, `plan`, `review`: a turn finished since (a newer prompt), nothing was changed or delegated, and the last
//   tool result was not an error.
// Any other activity, none, or work outside the activity's shape needs the passed check, and so does work where a check
// ran without passing last: failed, or in a form whose status is not the check's (`npm test && git push`,
// `npm test > log`, `npm test | tail`, `; `, `||`, the background). The absence of an edit alone is never evidence:
// each rule asks for a success it can see.
export function completedSince(messages, fromIndex, activity) {
  if (verifiedSince(messages, fromIndex)) return true;
  const calls = callsSince(messages, fromIndex);
  if (calls.some(({ block }) => DELEGATING.has(block.name))) return false;
  const lastResult = lastResultSince(messages, fromIndex);
  // A check that ran, in any form, and did not pass last (verifiedSince is false) blocks every shortcut.
  if (calls.some(({ block }) => block.name === 'Bash' && runsAnyCheck(block.input?.command))) return false;
  const edits = calls.filter(({ block }) => FILE_EDIT_TOOLS.has(block.name));
  const runs = calls.filter(
    ({ block }) => block.name === 'Bash' && ['ops', 'shell'].includes(commandKind(block.input?.command)),
  );
  if (activity === 'ops') {
    if (edits.length > 0 || runs.length === 0) return false;
    return succeeded(messages, runs.at(-1));
  }
  if (activity === 'docs') {
    if (runs.length > 0 || edits.length === 0) return false;
    if (!edits.every(({ block }) => DOC_PATH.test(editPath(block)))) return false;
    return succeeded(messages, edits.at(-1));
  }
  if (READ_ONLY_ACTIVITIES.has(activity)) {
    if (edits.length > 0 || runs.length > 0) return false;
    return promptIndex(messages) >= fromIndex && fromIndex >= 0 && lastResult?.is_error !== true;
  }
  return false;
}

function callsSince(messages, fromIndex) {
  const calls = [];
  for (let i = Math.max(0, fromIndex); i < messages.length; i += 1)
    if (messages[i]?.role === 'assistant')
      for (const block of blocks(messages[i].content)) if (block.type === 'tool_use') calls.push({ block, index: i });
  return calls;
}

function lastResultSince(messages, fromIndex) {
  let last = null;
  for (let i = Math.max(0, fromIndex); i < messages.length; i += 1)
    if (messages[i]?.role === 'user')
      for (const block of blocks(messages[i].content)) if (block.type === 'tool_result') last = block;
  return last;
}

// Whether the call's result came back without an error, and not as a launch into the background.
function succeeded(messages, call) {
  if (call.block.input?.run_in_background === true) return false;
  for (let i = call.index + 1; i < messages.length; i += 1)
    for (const block of blocks(messages[i]?.content))
      if (block.type === 'tool_result' && block.tool_use_id === call.block.id)
        return !block.is_error && !BACKGROUNDED.test(textOf(blocks(block.content)));
  return false;
}
