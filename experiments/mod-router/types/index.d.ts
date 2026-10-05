declare module 'claude-code' {
  interface PluginState {
    'router-mod-probe': {
      route: { turnId: string; model: string | null; requested: string | null; actual: string | null };
    };
  }
}
