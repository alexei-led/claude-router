// Node/Fetch transport for the legacy gateway. The wire contract is Mod-safe.
import { buildRequest, isTransientStatus, parseAnswers, RETRY_DELAY_MS, retryDelayMs } from './jev-contract.mjs';

export { buildRequest, parseAnswers } from './jev-contract.mjs';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Returns { choice, confidence, probabilities, continuation } or throws. One retry on a network error or a transient
// status, after Retry-After when the server sends one; a wait that would not fit the budget is not taken.
export async function askJev({ fetchFn, config, apiKey, prompt, turns, now = Date.now, sleep = delay }) {
  const deadline = now() + config.jev.timeoutMs;
  const body = JSON.stringify(buildRequest(config, prompt, turns));
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const remaining = deadline - now();
    if (remaining <= 0) throw new Error('jev timeout');
    let response;
    try {
      response = await fetchFn(config.jev.endpoint, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body,
        signal: AbortSignal.timeout(remaining),
      });
    } catch (error) {
      if (error.name === 'TimeoutError') throw new Error('jev timeout');
      if (attempt === 1) throw new Error(`jev unreachable: ${error.message}`);
      await sleep(RETRY_DELAY_MS);
      continue;
    }
    if (response.ok) return parseAnswers(await response.json());
    if (!isTransientStatus(response.status) || attempt === 1) throw new Error(`jev http ${response.status}`);
    const wait = retryDelayMs(response.headers?.get?.('retry-after'), now()) ?? RETRY_DELAY_MS;
    if (wait >= deadline - now()) throw new Error(`jev http ${response.status}, retry-after beyond the budget`);
    await sleep(wait);
  }
  throw new Error('jev unreachable');
}
