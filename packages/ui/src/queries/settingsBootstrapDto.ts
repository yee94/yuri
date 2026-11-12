export type SettingsBootstrap = {
  schemaVersion: 1;
  /** Read-only Hub discovery hint; delivered with the existing bootstrap request. */
  hasRemoteProjects?: boolean;
  defaultModel?: string;
  defaultVariant?: string;
  defaultAgent?: string;
  autoCreateWorktree?: boolean;
  gitmojiEnabled?: boolean;
  defaultFileViewerPreview?: boolean;
  zenModel?: string;
  messageStreamTransport?: 'auto' | 'ws' | 'sse';
  sttProvider?: 'local' | 'openai-compatible' | 'volcengine';
  sttServerUrl?: string;
  sttModel?: string;
  sttLocalModel?: string;
  sttLanguage?: string;
  responseStyleEnabled?: boolean;
  responseStylePreset?: ResponseStylePreset;
  responseStyleCustomInstructions?: string;
};

export type ResponseStylePreset =
  | 'concise'
  | 'detailed'
  | 'mentor'
  | 'pushback'
  | 'noFiller'
  | 'matchEnergy'
  | 'warmPeer'
  | 'custom';

export type SettingsBootstrapPatch = Omit<Partial<SettingsBootstrap>, 'schemaVersion' | 'hasRemoteProjects'>;
