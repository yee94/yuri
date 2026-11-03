import { opencodeClient } from '@/lib/opencode/client';
import type { SessionGoalStatus } from '@/lib/opencode/goal';
import { refreshSessionGoal } from '@/queries/sessionGoalQueries';
import { getRuntimeTransportIdentity, getRuntimeGeneration } from '@/lib/runtime-switch';

async function command(sessionID: string, directory: string | undefined, text: string): Promise<void> {
  const transport = getRuntimeTransportIdentity();
  const generation = getRuntimeGeneration();
  const client = directory ? opencodeClient.getScopedSdkClient(directory) : opencodeClient.getSdkClient();
  await client.session.command({ sessionID, name: 'goal', text });
  if (transport === getRuntimeTransportIdentity() && generation === getRuntimeGeneration()) await refreshSessionGoal(sessionID, directory);
}

export const setSessionGoalStatus = (sessionID: string, directory: string | undefined, status: Extract<SessionGoalStatus, 'active' | 'paused'>) =>
  command(sessionID, directory, status === 'active' ? 'resume' : 'pause');

export const clearSessionGoal = (sessionID: string, directory: string | undefined) => command(sessionID, directory, 'clear');
