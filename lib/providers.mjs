// Execution presets, not classifier services. Prices are API list-price estimates, never a plan bill.
// Sources and the limits of these starting routes are in docs/configuration.md#provider-profiles.
const EFFORTS = ['low', 'high', 'max'];
const AUTOMATIC = {
  mode: 'automatic',
  effortScope: 'unknown',
  writeMultiplier: {},
  ttlMs: {},
  warmMarginMs: 0,
};
const route = (model, effort) => ({ model, effort });
const agents = (light, heavy) => ({
  types: { Explore: light, Plan: 'classify', 'general-purpose': 'classify' },
  light,
  standard: heavy,
  heavy,
  heavyMass: 0.8,
});

export const PROVIDER_DEFAULTS = {
  minimax: {
    models: {
      flash: {
        id: 'MiniMax-M3.1-Flash[1m]',
        input: 0.15,
        output: 0.6,
        cacheRead: 0.015,
        contextWindow: 1_000_000,
        billing: 'credits',
        // xhigh is documented but some Claude Code versions serialize it as high; use max instead.
        efforts: ['low', 'medium', 'high', 'max'],
        strength: 1,
        imageInput: true,
      },
    },
    routes: {
      micro: route('flash', 'low'),
      low: route('flash', 'medium'),
      medium: route('flash', 'high'),
      high: route('flash', 'max'),
    },
    activities: Object.fromEntries(
      ['code', 'debug', 'plan', 'review'].map((a) => [a, { medium: route('flash', 'max') }]),
    ),
    subagents: agents('flash', 'flash'),
    cache: AUTOMATIC,
  },
  mimo: {
    models: {
      flash: {
        id: 'mimo-v2.6-flash[1m]',
        input: 0.14,
        output: 0.28,
        cacheRead: 0.0028,
        contextWindow: 1_000_000,
        billing: 'credits',
        // The Anthropic endpoint documents binary thinking, not granular effort. Keep its default thinking.
        efforts: [],
        strength: 1,
        imageInput: true,
      },
      pro: {
        id: 'mimo-v2.6-pro[1m]',
        input: 0.435,
        output: 0.87,
        cacheRead: 0.0036,
        contextWindow: 1_000_000,
        billing: 'credits',
        efforts: [],
        strength: 2,
        imageInput: true,
      },
    },
    routes: {
      micro: route('flash', null),
      low: route('flash', null),
      medium: route('pro', null),
      high: route('pro', null),
    },
    activities: Object.fromEntries(['ops', 'explore', 'docs'].map((a) => [a, { medium: route('flash', null) }])),
    subagents: agents('flash', 'pro'),
    cache: AUTOMATIC,
  },
  kimi: {
    // One model throughout the conversation: K3-family thinking/signatures must survive tool continuations.
    models: {
      k3: {
        id: 'kimi-k3.1-pro[1m]',
        input: 2,
        output: 10,
        cacheRead: 0.2,
        contextWindow: 1_048_576,
        billing: 'credits',
        efforts: EFFORTS,
        strength: 1,
        imageInput: true,
      },
    },
    routes: {
      micro: route('k3', 'low'),
      low: route('k3', 'high'),
      medium: route('k3', 'high'),
      high: route('k3', 'max'),
    },
    activities: Object.fromEntries(['code', 'debug', 'plan', 'review'].map((a) => [a, { medium: route('k3', 'max') }])),
    subagents: agents('k3', 'k3'),
    cache: AUTOMATIC,
  },
  deepseek: {
    models: {
      flash: {
        id: 'deepseek-flash[1m]',
        input: 0.3,
        output: 1.2,
        cacheRead: 0.006,
        contextWindow: 1_000_000,
        billing: 'credits',
        efforts: EFFORTS,
        strength: 1,
        imageInput: true,
      },
    },
    routes: {
      micro: route('flash', 'low'),
      low: route('flash', 'high'),
      medium: route('flash', 'high'),
      high: route('flash', 'max'),
    },
    activities: Object.fromEntries(
      ['code', 'debug', 'plan', 'review'].map((a) => [a, { medium: route('flash', 'max') }]),
    ),
    subagents: agents('flash', 'flash'),
    cache: AUTOMATIC,
  },
  zai: {
    models: {
      flash: {
        id: 'glm-5.3-flash[1m]',
        input: 0.15,
        output: 0.5,
        cacheRead: 0.03,
        contextWindow: 1_000_000,
        billing: 'credits',
        efforts: EFFORTS,
        strength: 1,
        imageInput: true,
      },
      glm: {
        id: 'glm-5.3[1m]',
        input: 1.4,
        output: 4.4,
        cacheRead: 0.26,
        contextWindow: 1_000_000,
        billing: 'credits',
        efforts: EFFORTS,
        strength: 2,
        imageInput: false,
      },
    },
    routes: {
      micro: route('flash', 'low'),
      low: route('flash', 'high'),
      medium: route('glm', 'high'),
      high: route('glm', 'max'),
    },
    activities: {
      ...Object.fromEntries(['code', 'debug', 'plan', 'review'].map((a) => [a, { medium: route('glm', 'max') }])),
      ...Object.fromEntries(
        ['ops', 'explore', 'docs'].map((a) => [a, { medium: route('flash', 'high'), high: route('flash', 'max') }]),
      ),
    },
    subagents: agents('flash', 'glm'),
    cache: AUTOMATIC,
  },
};

// A provider is an identifier, never a path. Unknown providers may supply a complete standalone profile.
export function providerName(value) {
  if (value == null || value === '') return 'anthropic';
  if (typeof value !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(value))
    throw new Error('invalid router provider identifier');
  return value;
}

export function providerFile(value) {
  const provider = providerName(value);
  return provider === 'anthropic' ? 'router.json' : `${provider}-router.json`;
}

export const canonicalModel = (id) => (typeof id === 'string' ? id.replace(/\[1m\]$/, '') : id);

export function executionDefaults(provider, defaults) {
  if (provider === 'anthropic') return defaults;
  return {
    ...defaults,
    models: {},
    routes: {},
    activities: {},
    subagentRouting: 'off',
    subagents: { types: {}, light: '', standard: '', heavy: '', heavyMass: 0.8 },
    cache: AUTOMATIC,
    ...(Object.hasOwn(PROVIDER_DEFAULTS, provider) ? { subagentRouting: 'on', ...PROVIDER_DEFAULTS[provider] } : {}),
  };
}
