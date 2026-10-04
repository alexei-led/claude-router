import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const pluginDir = fileURLToPath(new URL('../', import.meta.url));
const scenario = process.argv[2] ?? 'roundtrip';
let prompts = [
  '[router-mod:haiku] Remember the word LEMON for this conversation. Reply only OK. Do not use tools.',
  '[router-mod:sonnet] Which word did I ask you to remember? Reply only that word. Do not use tools.',
  '[router-mod:haiku] Which word did I ask you to remember? Reply only that word. Do not use tools.',
];
let expectedModels = ['claude-haiku-4-5', 'claude-sonnet-5-5', 'claude-haiku-4-5'];
let expectedTexts = ['OK', 'LEMON', 'LEMON'];
if (scenario === 'tools') {
  prompts = [
    '[router-mod:sonnet] Use Read to read package.json, then reply exactly TOOL_SONNET_OK.',
    '[router-mod:opus] Use Read to read package.json again, then reply exactly TOOL_OPUS_OK.',
    '[router-mod:haiku] Use Read to read package.json again, then reply exactly TOOL_HAIKU_OK.',
  ];
  expectedModels = ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-4-5'];
  expectedTexts = ['TOOL_SONNET_OK', 'TOOL_OPUS_OK', 'TOOL_HAIKU_OK'];
} else if (scenario === 'large') {
  const filler = Array.from(
    { length: 28_000 },
    (_, i) => `${i.toString(16).padStart(6, '0')} ab cd ef 01 23 45 67 89`,
  ).join('\n');
  prompts = [
    `[router-mod:sonnet] This is a context-window test. Do not analyze the filler. Reply exactly LARGE_SONNET_OK.\n<fixture>\n${filler}\n</fixture>`,
    '[router-mod:opus] Keep the large fixture in this conversation. Reply exactly LARGE_OPUS_OK.',
  ];
  expectedModels = ['claude-sonnet-5-5', 'claude-opus-5-5'];
  expectedTexts = ['LARGE_SONNET_OK', 'LARGE_OPUS_OK'];
} else if (scenario !== 'roundtrip') throw new Error(`unknown scenario ${scenario}`);
// Pass the path as a shell positional argument, so spaces and shell characters stay literal.
const child = spawn(
  'zsh',
  [
    '-lic',
    'ce team --plugin-dir "$1" --model claude-sonnet-5-5 --no-session-persistence --permission-mode default --tools "$2" --allowedTools "$2" ' +
      '--strict-mcp-config --mcp-config \'{"mcpServers":{}}\' ' +
      '--settings \'{"env":{"ANTHROPIC_BASE_URL":"https://api.anthropic.com","ANTHROPIC_MODEL":"claude-sonnet-5-5","CLAUDE_CODE_GATEWAY_HINT_HEADERS":""},"enabledPlugins":{"router@alexei-led-claude-router":false}}\' ' +
      '--input-format stream-json --output-format stream-json --verbose -p',
    'router-mod-probe',
    pluginDir,
    scenario === 'tools' ? 'Read' : '',
  ],
  { stdio: ['pipe', 'pipe', 'pipe'] },
);

let completed = 0;
let pending = '';
let actualModel = '';
let inputTokens = 0;
let toolUses = 0;
let toolResults = 0;
const timeout = setTimeout(() => {
  console.error('Live routing probe timed out after 180 seconds.');
  process.exitCode = 1;
  child.kill('SIGTERM');
}, 180_000);

function submit() {
  actualModel = '';
  inputTokens = 0;
  toolUses = 0;
  toolResults = 0;
  child.stdin.write(`${JSON.stringify({ type: 'user', message: { role: 'user', content: prompts[completed] } })}\n`);
}

child.stdout.setEncoding('utf8');
child.stderr.resume();
child.stdout.on('data', (data) => {
  pending += data;
  let newline = pending.indexOf('\n');
  while (newline !== -1) {
    const line = pending.slice(0, newline);
    pending = pending.slice(newline + 1);
    newline = pending.indexOf('\n');
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.type === 'assistant') {
      actualModel = event.message?.model ?? '';
      const usage = event.message?.usage;
      if (usage)
        inputTokens =
          (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
      toolUses +=
        event.message?.content?.filter((block) => block.type === 'tool_use' && block.name === 'Read').length ?? 0;
    }
    if (event.type === 'user' && Array.isArray(event.message?.content)) {
      toolResults += event.message.content.filter((block) => block.type === 'tool_result' && !block.is_error).length;
    }
    if (event.type !== 'result') continue;
    const expectedText = expectedTexts[completed];
    const expectedModel = expectedModels[completed];
    const passed =
      !event.is_error &&
      event.result?.trim() === expectedText &&
      (scenario !== 'tools' || (toolUses > 0 && toolResults > 0)) &&
      (scenario !== 'large' || inputTokens > 200_000) &&
      (actualModel === expectedModel || actualModel.startsWith(`${expectedModel}-`));
    console.log(
      JSON.stringify({
        scenario,
        turn: completed + 1,
        passed,
        result: event.result,
        actualModel,
        inputTokens,
        toolUses,
        toolResults,
      }),
    );
    completed += 1;
    if (!passed) {
      process.exitCode = 1;
      child.kill('SIGTERM');
    } else if (completed === prompts.length) child.stdin.end();
    else submit();
  }
});
child.on('error', (error) => {
  console.error(error.message);
  clearTimeout(timeout);
  process.exitCode = 1;
});
child.on('close', (code) => {
  clearTimeout(timeout);
  if (code !== 0 || completed !== prompts.length) {
    console.error(`Probe ended with exit ${code}, completed ${completed}/${prompts.length} turns.`);
    process.exitCode = 1;
  }
});
submit();
