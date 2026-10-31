// Billed, opt-in native smoke test. Synthetic isolated home, Read-only tools, fixed upstreams, bounded output.
// node experiments/mod-router/scripts/provider-live.mjs <minimax|mimo|kimi> <budget-usd>
// The loopback forwarder exists only for this experiment; the shipped router never proxies requests.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../../../lib/config.mjs';
import { canonicalModel } from '../../../lib/providers.mjs';
import { usageUsd } from '../../../scripts/probe-provider-routes.mjs';

const ENDPOINTS = {
  minimax: 'https://api.minimax.io/anthropic/v1/messages',
  mimo: 'https://api.xiaomimimo.com/anthropic/v1/messages',
  kimi: 'https://api.moonshot.ai/anthropic/v1/messages',
};
const [provider, limit] = process.argv.slice(2);
const budgetUsd = Number(limit);
if (!Object.hasOwn(ENDPOINTS, provider) || !(budgetUsd > 0 && budgetUsd <= 1))
  throw new Error('Expected minimax|mimo|kimi and a USD ceiling in (0, 1].');
const config = loadConfig({ provider });
const key = JSON.parse(readFileSync(join(homedir(), '.claude', 'secrets.json'), 'utf8'))[provider];
assert.ok(typeof key === 'string' && key, 'Missing provider credential');
const claudeVersion = execFileSync(process.env.CLAUDE_NATIVE_BIN ?? 'claude', ['--version'], {
  encoding: 'utf8',
}).trim();
const report = {
  provider,
  date: new Date().toISOString(),
  claudeVersion,
  budgetUsd,
  accountedUsd: 0,
  requests: [],
  turns: [],
};
const server = createServer(async (req, res) => {
  try {
    if (req.method !== 'POST' || !req.url.startsWith('/v1/messages') || req.url.includes('count_tokens')) {
      res.writeHead(req.url.startsWith('http') ? 503 : 200, { 'content-type': 'application/json' });
      res.end('{"input_tokens":100,"data":[]}');
      return;
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    const spec = Object.values(config.models).find((m) => canonicalModel(m.id) === body.model);
    assert.ok(spec, 'Refusing an unconfigured model');
    body.max_tokens = Math.min(body.max_tokens ?? 2048, 2048);
    const reserveUsd =
      ((Buffer.byteLength(JSON.stringify(body)) + 4096) * spec.input + body.max_tokens * spec.output) / 1e6;
    assert.ok(report.accountedUsd + reserveUsd <= budgetUsd, 'Budget reservation exceeded');
    // Reserve before awaiting HTTP: concurrent/failed work never receives free budget.
    report.accountedUsd += reserveUsd;
    const row = {
      turn: report.turns.length,
      model: body.model,
      effort: body.output_config?.effort ?? null,
      thinking: body.thinking?.type ?? null,
      topLevelCacheControl: body.cache_control ?? null,
      maxTokens: body.max_tokens,
      afterTool: body.messages.some((m) => Array.isArray(m.content) && m.content.some((p) => p.type === 'tool_result')),
      reservedUsd: reserveUsd,
    };
    report.requests.push(row);
    const start = Date.now();
    const response = await fetch(ENDPOINTS[provider], {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(90000),
      headers: {
        'content-type': 'application/json',
        'anthropic-version': '2023-06-01',
        'x-api-key': key,
        authorization: `Bearer ${key}`,
      },
      body: JSON.stringify(body),
    });
    row.status = response.status;
    if (!response.ok) {
      await response.body.cancel();
      res
        .writeHead(response.status)
        .end('{"type":"error","error":{"type":"api_error","message":"Synthetic provider probe failed"}}');
      return;
    }
    res.writeHead(response.status, { 'content-type': response.headers.get('content-type') ?? 'text/event-stream' });
    let sse = '';
    for await (const chunk of response.body) {
      sse += Buffer.from(chunk).toString();
      res.write(Buffer.from(chunk));
    }
    row.ms = Date.now() - start;
    const usage = {};
    for (const line of sse.split('\n')) {
      if (!line.startsWith('data: ')) continue;
      try {
        const data = JSON.parse(line.slice(6));
        if (data.message?.model) row.served = data.message.model;
        Object.assign(usage, data.message?.usage, data.usage);
      } catch {
        /* SSE end markers are not JSON. */
      }
    }
    row.usage = usage;
    row.estimatedUsd = usageUsd(spec, usage);
    if (row.estimatedUsd !== null) report.accountedUsd += row.estimatedUsd - reserveUsd;
    res.end();
  } catch {
    if (!res.headersSent) res.writeHead(503);
    res.end('{"type":"error","error":{"type":"api_error","message":"Probe refused or timed out"}}');
  }
});
const root = await mkdtemp(join(tmpdir(), 'router-live-provider-'));
let child;
try {
  const home = join(root, 'home');
  const dir = join(home, '.claude');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${provider}-router.json`), '{}');
  await writeFile(join(root, 'fixture.txt'), 'NATIVE_PROVIDER_TOOL_OK\n');
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const model = config.models[config.routes.micro.model].id;
  const env = {
    PATH: process.env.PATH,
    HOME: home,
    USER: process.env.USER,
    TMPDIR: tmpdir(),
    LANG: 'en_US.UTF-8',
    CLAUDE_CONFIG_DIR: dir,
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
  const prompts = [
    '/router pin high',
    'Use Read to read fixture.txt now. Reply only with its marker.',
    '/router pin micro',
    'Use Read to read fixture.txt again now, even though it was already read. Reply only with its marker.',
  ];
  child = spawn(
    process.env.CLAUDE_NATIVE_BIN ?? 'claude',
    [
      '--setting-sources',
      'user',
      '--settings',
      JSON.stringify({ env: { CLAUDE_ROUTER_PROVIDER: provider } }),
      '--plugin-dir',
      fileURLToPath(new URL('../../../', import.meta.url)),
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
    { cwd: root, env, stdio: ['pipe', 'pipe', 'pipe'] },
  );
  child.stderr.resume();
  const send = () => {
    const prompt = prompts.shift();
    if (prompt) child.stdin.write(`${JSON.stringify({ type: 'user', message: { role: 'user', content: prompt } })}\n`);
    else child.stdin.end();
  };
  let reads = 0;
  createInterface({ input: child.stdout }).on('line', (line) => {
    let data;
    try {
      data = JSON.parse(line);
    } catch {
      return;
    }
    if (data.type === 'assistant')
      reads += (data.message?.content ?? []).filter((p) => p.type === 'tool_use' && p.name === 'Read').length;
    if (data.type !== 'result') return;
    report.turns.push({ error: Boolean(data.is_error), text: data.result, reads });
    reads = 0;
    if (data.is_error) child.stdin.end();
    else send();
  });
  const deadline = setTimeout(() => child.kill('SIGTERM'), 240000);
  send();
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  clearTimeout(deadline);
  report.exitCode = code;
  report.passed =
    code === 0 &&
    report.turns.length === 4 &&
    report.turns.every((t) => !t.error) &&
    [report.turns[1], report.turns[3]].every((t) => t?.text?.trim() === 'NATIVE_PROVIDER_TOOL_OK' && t.reads > 0) &&
    report.requests.every((r) => {
      const route = r.turn === 1 ? config.routes.high : r.turn === 3 ? config.routes.micro : null;
      return (
        route &&
        r.status === 200 &&
        r.served === r.model &&
        r.model === canonicalModel(config.models[route.model].id) &&
        (route.effort === null || r.effort === route.effort)
      );
    }) &&
    report.requests.some((r) => r.afterTool);
  const out = new URL(`../results/provider-native-${provider}.json`, import.meta.url);
  await writeFile(out, `${JSON.stringify(report, null, 2)}\n`);
  console.log(
    JSON.stringify({
      provider,
      passed: report.passed,
      requests: report.requests.length,
      accountedUsd: report.accountedUsd,
    }),
  );
  if (!report.passed) process.exitCode = 1;
} finally {
  child?.kill('SIGTERM');
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await rm(root, { recursive: true, force: true });
}
