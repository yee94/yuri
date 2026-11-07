export type PluginRuntimeSource =
  /** `target` is the config string verbatim (no implicit `@latest`). */
  | { kind: 'package'; target: string; version: string | null; outdated: boolean; updating: boolean }
  /** A loaded plugin reports its entrypoint file; one that failed to load reports the configured path. */
  | { kind: 'local'; path: string }
  | { kind: 'builtin' };

export type PluginRuntimeState = { kind: 'active' } | { kind: 'failed'; error: string; ref: string | null };

export interface PluginRuntimeInfo {
  source: PluginRuntimeSource;
  state: PluginRuntimeState;
}
