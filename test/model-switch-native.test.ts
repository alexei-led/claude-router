import { expect, mock, test } from 'claude-code/testing';

// The engine's own PostModelSwitch, as the model picker or an SDK set_model raises it, reaches the router: a person's
// choice turns routing off, while the engine's fallback and a resume leave it on.
test('a picker or SDK model switch turns routing off; a fallback or resume does not', async ($, on) => {
  mock.store(on);
  mock.env(on, { HOME: '/fixture', CLAUDE_CONFIG_DIR: '/fixture/team' });
  const state = new Map<string, { value: unknown; version: number }>();
  on('state.get', (_$, e) => ({ value: state.get(`${e.key}:${e.id ?? ''}`) ?? { value: undefined, version: 0 } }));
  on('state.set', (_$, e) => {
    const key = `${e.key}:${e.id ?? ''}`;
    const version = (state.get(key)?.version ?? 0) + 1;
    state.set(key, { value: e.value, version });
    return { value: { isSet: true, version } };
  });
  on('fs.exists', () => ({ value: false }));
  on('session.id', () => ({ value: 'model-switch' }));
  on('session.model', () => ({ value: 'claude-opus-5-5' }));
  on('session.cwd', () => ({ value: '/fixture/project' }));
  on('session.version', () => ({ value: { version: '2.1.332' } }));
  on('ui.log', () => ({ value: undefined }));
  on('classic.PostModelSwitch', () => ({}));
  const modes: Record<string, unknown> = {};
  for (const source of ['auto', 'resume', 'picker', 'sdk'] as const) {
    state.clear();
    await $.classic.PostModelSwitch({
      from_model: 'claude-sonnet-5-5',
      to_model: 'claude-opus-5-5',
      requested_model: 'opus',
      source,
      context_tokens: 0,
      prompt_cache_warm: false,
      cache_ttl: '5m',
      estimated_cache_write_usd: 0,
      pricing: 'catalog',
    });
    const view = state.get('view:')?.value as { mode?: string; reason?: string } | undefined;
    modes[source] = view?.mode === 'manual' ? view.reason : 'untouched';
  }
  expect(modes).toEqual({
    auto: 'untouched',
    resume: 'untouched',
    picker: 'model selected manually',
    sdk: 'model selected manually',
  });
});
