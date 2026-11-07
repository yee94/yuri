export type McpScope = 'user' | 'project';

export interface McpDraft {
  name: string;
  scope: McpScope;
  type: 'local' | 'remote';
  command: string[];
  url: string;
  environment: Array<{ key: string; value: string }>;
  headers: Array<{ key: string; value: string }>;
  oauthEnabled: boolean;
  oauthClientId: string;
  oauthClientSecret: string;
  oauthScope: string;
  oauthRedirectUri: string;
  timeout: string;
  enabled: boolean;
}
