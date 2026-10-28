// Real Claude Code + production Mod against a loopback Messages API. No provider credentials or paid calls.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const plugin = fileURLToPath(new URL('../../../', import.meta.url));
let active;
let serial = 0;
const server = createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (req.url.startsWith('http')) {
    res.writeHead(503).end('This loopback probe does not proxy external requests.');
    return;
  }
  if (req.method !== 'POST' || !req.url.startsWith('/v1/messages') || req.url.includes('count_tokens')) {
    res.writeHead(200, { 'content-type': 'application/json' }).end('{"input_tokens":100,"data":[]}');
    return;
  }
  const body = JSON.parse(Buffer.concat(chunks).toString());
  const afterTool = body.messages.some(
    (m) =>
      Array.isArray(m.content) && m.content.some((p) => p.type === 'tool_result' && p.tool_use_id === active.pending),
  );
  if (afterTool) active.pending = null;
  active.requests.push({
    model: body.model,
    effort: body.output_config?.effort ?? null,
    thinking: body.thinking?.type ?? null,
    afterTool,
  });
  const send = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  send('message_start', {
    message: {
      id: `msg_probe_${++serial}`,
      type: 'message',
      role: 'assistant',
      model: body.model,
      content: [],
      stop_reason: null,
      usage: {
        input_tokens: 100,
        cache_read_input_tokens: 800,
        ...(active.provider === 'zai' ? {} : { cache_creation_input_tokens: 0 }),
        output_tokens: 1,
      },
    },
  });
  if (!afterTool && body.tools?.some((t) => t.name === 'Read')) {
    active.pending = `toolu_probe_${serial}`;
    send('content_block_start', {
      index: 0,
      content_block: { type: 'tool_use', id: active.pending, name: 'Read', input: {} },
    });
    send('content_block_delta', {
      index: 0,
      delta: { type: 'input_json_delta', partial_json: JSON.stringify({ file_path: active.file }) },
    });
  } else {
    send('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
    send('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'OK' } });
  }
  send('content_block_stop', { index: 0 });
  send('message_delta', {
    delta: { stop_reason: afterTool ? 'end_turn' : 'tool_use', stop_sequence: null },
    usage: { output_tokens: 8 },
  });
  send('message_stop', {});
  res.end();
});

async function runCase(root, url, { provider, profile, expectedHigh }) {
  const dir = join(root, provider + (profile ? '-configured' : '-missing'));
  const home = join(dir, 'home');
  const config = join(home, '.claude');
  await mkdir(config, { recursive: true });
  const file = join(dir, 'probe.txt');
  await writeFile(file, 'Synthetic provider acceptance fixture.\n');
  if (profile) await writeFile(join(config, `${provider}-router.json`), profile);
  // A valid default file must never be used for a missing provider file.
  await writeFile(join(config, 'router.json'), '{}');
  const model = provider === 'zai' ? 'glm-5.3-flash[1m]' : 'deepseek-flash[1m]';
  const env = {
    PATH: process.env.PATH,
    HOME: home,
    USER: process.env.USER,
    TMPDIR: tmpdir(),
    LANG: 'en_US.UTF-8',
    CLAUDE_CONFIG_DIR: config,
    ANTHROPIC_BASE_URL: url,
    ANTHROPIC_AUTH_TOKEN: 'synthetic-loopback-only',
    ANTHROPIC_API_KEY: 'synthetic-loopback-only',
    ANTHROPIC_DEFAULT_OPUS_MODEL: model,
    ANTHROPIC_DEFAULT_SONNET_MODEL: model,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: '1',
    DISABLE_TELEMETRY: '1',
    DISABLE_ERROR_REPORTING: '1',
    HTTP_PROXY: url,
    HTTPS_PROXY: url,
    ALL_PROXY: url,
    NO_PROXY: '127.0.0.1,localhost',
  };
  active = { provider, configured: Boolean(profile), requests: [], file };
  const prompts = expectedHigh
    ? [
        '/router',
        '/router pin high',
        'Read the fixture, then reply OK.',
        '/router pin micro',
        'Read the fixture, then reply OK.',
        '/router',
      ]
    : ['/router', 'Read the fixture, then reply OK.'];
  const child = spawn(
    process.env.CLAUDE_NATIVE_BIN ?? 'claude',
    [
      '--setting-sources',
      'user',
      '--settings',
      JSON.stringify({ env: { CLAUDE_ROUTER_PROVIDER: provider } }),
      '--plugin-dir',
      plugin,
      '--tools',
      'Read',
      '--allowedTools',
      'Read',
      '--strict-mcp-config',
      '--mcp-config',
      '{"mcpServers":{}}',
      '--no-session-persistence',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--verbose',
      '--model',
      model,
      '--effort',
      'low',
      '-p',
    ],
    { cwd: dir, env, stdio: ['pipe', 'pipe', 'pipe'] },
  );
  const results = [];
  let stderr = '';
  child.stderr.on('data', (d) => {
    if (stderr.length < 5000) stderr += d;
  });
  const send = () => {
    const prompt = prompts.shift();
    if (prompt) child.stdin.write(`${JSON.stringify({ type: 'user', message: { role: 'user', content: prompt } })}\n`);
    else child.stdin.end();
  };
  createInterface({ input: child.stdout }).on('line', (line) => {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      return;
    }
    if (event.type !== 'result') return;
    results.push(event);
    if (event.is_error) child.stdin.end();
    else send();
  });
  const deadline = setTimeout(() => child.kill('SIGTERM'), 30000);
  send();
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  clearTimeout(deadline);
  assert.equal(code, 0, stderr);
  assert.ok(results.length > 0 && results.every((r) => !r.is_error), 'native session failed');
  if (expectedHigh) {
    assert.match(results[0].result, new RegExp(`${provider}-router.json`));
    assert.match(results.at(-1).result, /Observed cache: 800 read, 0 written tokens/);
    assert.deepEqual(
      active.requests.map((r) => [r.model, r.effort, r.afterTool]),
      [
        [expectedHigh, 'max', false],
        [expectedHigh, 'max', true],
        [model.replace('[1m]', ''), 'low', false],
        [model.replace('[1m]', ''), 'low', true],
      ],
    );
  } else {
    assert.match(results[0].result, /Routing unavailable/);
    assert.deepEqual(
      active.requests.map((r) => [r.model, r.effort]),
      [
        [model.replace('[1m]', ''), 'low'],
        [model.replace('[1m]', ''), 'low'],
      ],
    );
  }
  return { provider, configured: Boolean(profile), requests: active.requests, passed: true };
}

const root = await mkdtemp(join(tmpdir(), 'router-provider-acceptance-'));
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
try {
  const url = `http://127.0.0.1:${server.address().port}`;
  const reports = [];
  for (const scenario of [
    { provider: 'deepseek', profile: '{}', expectedHigh: 'deepseek-flash' },
    { provider: 'zai', profile: '{}', expectedHigh: 'glm-5.3' },
    { provider: 'deepseek', profile: null },
    { provider: 'zai', profile: '{"routes":{"high":{"model":"opus"}}}' },
  ])
    reports.push(await runCase(root, url, scenario));
  console.log(
    JSON.stringify(
      {
        scope:
          'Production Mod, isolated homes, synthetic auth, loopback only; tool continuations cross models and effort levels.',
        reports,
      },
      null,
      2,
    ),
  );
} finally {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await rm(root, { recursive: true, force: true });
}
