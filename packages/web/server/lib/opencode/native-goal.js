import { Goal } from '@opencode/schema/goal';
import { Schema } from 'effect';

const decodeGoal = Schema.decodeUnknownSync(Schema.NullOr(Goal.State));

export async function getNativeSessionGoal(client, sessionID, directory, signal) {
  try {
    const goal = await client.rpc(Goal.Definition).get({ sessionID }, { ...(directory ? { location: { directory } } : {}), ...(signal ? { signal } : {}) });
    return decodeGoal(goal);
  } catch (error) {
    // A server without this plugin cannot own a goal. Transport/auth failures remain unknown.
    if (error?.type === 'rpc.unavailable' || error?.type === 'rpc.method_not_found') return null;
    throw error;
  }
}
