declare module 'claude-code' {
  type RouterTier = 'micro' | 'low' | 'medium' | 'high';
  type RouterCacheState = 'fresh' | 'unknown';
  // What kind of work a turn does (ACTIVITIES in lib/config.mjs); 'uncertain' only as a classifier answer.
  type RouterActivity = 'code' | 'debug' | 'explore' | 'plan' | 'review' | 'ops' | 'docs';
  type RouterActivityAnswer = RouterActivity | 'uncertain';
  type RouterActivityMode = 'off' | 'shadow' | 'on';
  // A finished turn's bucket, read from its tool calls.
  type RouterObserved = 'code' | 'docs' | 'ops' | 'read' | 'talk';
  // Classifier output. `activity` is null when not asked, or missing, malformed or failed.
  interface RouterAdvice {
    choice: RouterTier | 'uncertain';
    confidence: number;
    probabilities: Record<RouterTier | 'uncertain', number>;
    continuation: number | null;
    activity?: {
      choice: RouterActivityAnswer;
      probabilities: Record<RouterActivityAnswer, number>;
    } | null;
  }
  // What `on` would do, computed in `shadow`. `model` is a model id, as `decision.model`.
  interface RouterWouldRoute {
    activity: RouterActivity | null;
    tier: RouterTier | null;
    model: string;
    effort: string | number | null;
    reason: string;
  }
  interface RouterActivityCounts {
    turns: number;
    requests: number;
    inputTokens: number;
    outputTokens: number;
  }
  // Per-session activity stats; 'none' counts turns without an applied or accepted activity.
  interface RouterActivitySession {
    byActivity: Partial<Record<RouterActivity | 'none', RouterActivityCounts>>;
    switches: { tier: number; activity: number };
    agreement: { matched: number; total: number };
    shadow: { differs: number; turns: number };
  }
  // Cross-session counts under store key 'activity:stats:v1'. `runs` buckets run lengths 1, 2, 3, 4, 5+.
  interface RouterActivityStore {
    version: 1;
    confusion: Partial<Record<RouterActivityAnswer | 'none', Partial<Record<RouterObserved, number>>>>;
    runs: Partial<Record<RouterActivity, [number, number, number, number, number]>>;
    lateral: { taken: number; refused: number };
    shadow: { differs: number; turns: number };
  }
  interface RouterComparison {
    candidate: RouterTier;
    incumbent: RouterTier;
    minUsd: number;
    maxUsd: number;
    paybackTurns: number | null;
    outputTokens: number;
  }
  interface RouterEstimate {
    taxUsd?: number;
    threshold?: number;
    upgradeMass?: number;
    downgradeMass?: number;
    streak?: number;
    coldUsd?: number;
    cap?: number;
    cache?: RouterCacheState | { candidate: RouterCacheState; incumbent: RouterCacheState };
  }
  interface RouterTuning {
    downgradeVotes: number;
    horizon: number;
    cashCapUsd: number;
  }
  // A model alias and the effort it runs at: what Claude Code receives and what owns a cache.
  interface RouterRoute {
    model: string;
    effort?: string | null;
  }
  interface RouterRoutes {
    routes: Record<RouterTier, RouterRoute>;
    baselineTier: RouterTier;
    // The Routing tab's activity edits; a draft without them edits none. A null cell is a removed override.
    activities?: Partial<
      Record<RouterActivity, Partial<Record<RouterTier, { model?: string; effort?: string | null } | null>>>
    >;
    activityRouting?: RouterActivityMode;
  }
  interface RouterView {
    phase: 'ready' | 'choosing' | 'routed' | 'manual' | 'unavailable';
    mode: 'auto' | 'manual';
    nativeModel: string;
    activeTurnId?: string | null;
    selectedModel?: string | null;
    actualModel?: string | null;
    tier?: RouterTier | null;
    effort?: string | number | null;
    reason?: string;
    error?: string | null;
    pendingPin?: RouterTier | null;
    // Per classifier id: what its credentials lack, or null when complete.
    credentials?: Record<string, 'missing-key' | 'missing-account' | null> | null;
    contextTokens?: number | null;
    contextKnown?: boolean;
    cacheRead?: number | null;
    cacheWrite?: number | null;
    inputTokens?: number | null;
    outputTokens?: number | null;
    health?: { failures: number; pausedUntil: number; classifier?: string };
    adviceMs?: number | null;
    adviceChoice?: RouterTier | 'uncertain' | null;
    estimate?: RouterEstimate | null;
    comparison?: RouterComparison | null;
    probabilities?: Partial<Record<RouterTier | 'uncertain', number>> | null;
    // The turn's activity: the applied one in 'on', the classifier's accepted label in 'shadow'.
    activity?: RouterActivity | null;
    activityChoice?: RouterActivityAnswer | null;
    activityProbabilities?: Partial<Record<RouterActivityAnswer, number>> | null;
    wouldRoute?: RouterWouldRoute | null;
    history?: number[];
    tiers?: (RouterTier | null)[];
    // Aligned with `history` and `tiers`.
    activities?: (RouterActivity | null)[];
    activityStats?: RouterActivitySession | null;
    configPath?: string | null;
    tuning?: Partial<RouterTuning> | null;
    tuningBase?: RouterTuning | null;
    routeDraft?: (RouterRoutes & { base: RouterRoutes }) | null;
    // The last pane write to router.json: each leaf it changed with the value the file had before, none if absent.
    lastWrite?: { label: string; leaves: { path: string[]; value?: unknown }[] } | null;
    tab?: 'now' | 'routing' | 'classifier' | 'usage';
    help?: boolean;
    bandDetail?: boolean;
    notice?: string | null;
  }
  interface RouterPolicyState {
    turn: number;
    votes: { tier: RouterTier; turn: number }[];
    holdUntilTurn: number;
    escalatedSignature: string | null;
  }
  interface RouterLoop {
    lastRoute: RouterTier;
    // The activity of the route running now; absent in loops saved before 1.6.
    lastActivity?: RouterActivity | null;
    // Shadow mode only: the cell and policy state `on` would run with, so each would-route continues the last one.
    would?: { lastRoute: RouterTier; lastActivity: RouterActivity | null; state: RouterPolicyState } | null;
    state: RouterPolicyState;
    models: Record<string, { lastAt: number; prefixTokens: number }>;
    resolutions: Record<string, string>;
    lastRequest: {
      model: string;
      tokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      cacheWriteTokens: number;
      at: number;
    } | null;
    lastMessageCount: number | null;
    historyMeasured?: boolean;
    generation: number;
    turnId: string | null;
    decision: {
      tier: RouterTier | null;
      reason: string;
      state: RouterPolicyState;
      model: string;
      effort: string | number | null;
      estimate?: RouterEstimate | null;
      comparison?: RouterComparison | null;
      // The applied activity; `wouldRoute` is set only in shadow mode.
      activity?: RouterActivity | null;
      wouldRoute?: RouterWouldRoute | null;
      pinned: boolean;
      requestedPin: RouterTier | null;
    } | null;
    ineligible: string[];
    engineModel?: string;
    suspended?: boolean;
  }
  interface PluginState {
    router: {
      view: RouterView;
      loops: StateFamily<RouterLoop>;
    };
  }
}
