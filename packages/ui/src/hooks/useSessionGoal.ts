import { useSessionGoalQuery } from '@/queries/sessionGoalQueries';
import { useUIStore } from '@/stores/useUIStore';

export function useSessionGoal(sessionId: string, directory?: string) {
  const query = useSessionGoalQuery(sessionId, directory);
  const enabled = useUIStore((state) => state.sessionGoalEnabled);
  return { goal: query.data ?? null, enabled, error: query.error };
}
