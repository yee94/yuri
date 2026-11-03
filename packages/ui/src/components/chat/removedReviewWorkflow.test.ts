import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const source = (path: string) => readFileSync(join(root, path), 'utf8');

describe('removed standalone review workflow', () => {
  test('has no dialog or handoff command entry, retaining in-session review and diff', () => {
    const input = source('components/chat/ChatInput.tsx');
    const commands = source('components/chat/CommandAutocomplete.tsx');
    const diff = source('components/views/DiffView.tsx');
    for (const text of [input, commands, diff]) {
      expect(text).not.toMatch(/ReviewFlowDialog|startReviewFlow|handoff-review/);
    }
    expect(input).toContain("renderMagicPrompt('session.review.instructions')");
    expect(commands).toContain("name: 'workspace-review'");
    expect(diff).toContain('useSessionTurnChangeFileQuery');
  });

  test('startup, queue and message actions cannot restore or forward review runs', () => {
    for (const path of [
      'App.tsx', 'apps/runtimeEndpointReset.ts', 'hooks/useQueuedMessageAutoSend.ts',
      'components/chat/ChatInput.tsx', 'components/chat/MessageList.tsx',
      'components/chat/ChatMessage.tsx', 'components/chat/message/MessageBody.tsx',
      'components/chat/SessionSurfaceContext.tsx', 'stores/useGlobalSessionsStore.ts',
      'sync/session-actions.ts',
    ]) {
      expect(source(path)).not.toMatch(/useAutoReviewStore|resumeAutoReviewRun|autoReviewRunning|reviewTransfer|sessionReviewMetadata/);
    }
  });
});
