import { SESSION_GOAL_OBJECTIVE_CHAR_LIMIT, type SessionGoalStatus } from '../ui/src/lib/opencode/goal';
import { record, slashCommand, type RuntimeEvent } from './model';

export { SESSION_GOAL_OBJECTIVE_CHAR_LIMIT };
/** Exact Goal.State wire leaves; Effect/SDK runtimes cannot run in QuickJS. */
export type NativeGoal = {
  id: string; objective: string; status: SessionGoalStatus; reason?: string;
  rounds: number; maxRounds: number; stalls?: number; boot: string; updatedAt: number;
};
export type GoalScope = Readonly<{ sessionID: string; directory: string }>;
export type GoalCommand = {
  name: 'goal'; text: string; delivery?: 'queue' | 'steer';
  files?: Array<{ uri: string; name?: string }>;
  agents?: Array<{ name: string }>; skills?: Array<{ id: string }>;
};
export type GoalTransport = {
  get: (scope: GoalScope) => Promise<unknown>;
  command: (scope: GoalScope, command: GoalCommand) => Promise<unknown>;
};
export type GoalRequest = (path: string, method: string, body: unknown) => Promise<unknown>;

/** SDK raw rpc.call returns { output }; session.command is a 204, not a prompt. */
export function createGoalTransport(request: GoalRequest): GoalTransport {
  return {
    async get(scope) {
      const response = record(await request(`/api/rpc/opencode.goal/get?location%5Bdirectory%5D=${encodeURIComponent(scope.directory)}`, 'POST', { input: { sessionID: scope.sessionID } }));
      if (!Object.prototype.hasOwnProperty.call(response, 'output')) throw new Error('Invalid goal RPC response');
      return response.output;
    },
    command: (scope, command) => request(`/api/session/${encodeURIComponent(scope.sessionID)}/command?directory=${encodeURIComponent(scope.directory)}`, 'POST', command),
  };
}

export function decodeNativeGoal(value: unknown): NativeGoal | null {
  if (value === null) return null;
  const goal = record(value);
  const numeric = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
  if (typeof goal.id !== 'string' || typeof goal.objective !== 'string' || typeof goal.status !== 'string' || !['active', 'paused', 'complete'].includes(goal.status)
    || !numeric(goal.rounds) || !numeric(goal.maxRounds) || !numeric(goal.updatedAt) || typeof goal.boot !== 'string'
    || goal.reason !== undefined && typeof goal.reason !== 'string' || goal.stalls !== undefined && !numeric(goal.stalls)) throw new Error('Invalid Goal.State');
  return { id: goal.id, objective: goal.objective, status: goal.status as SessionGoalStatus, rounds: goal.rounds, maxRounds: goal.maxRounds, boot: goal.boot, updatedAt: goal.updatedAt,
    ...(typeof goal.reason === 'string' ? { reason: goal.reason } : {}), ...(numeric(goal.stalls) ? { stalls: goal.stalls } : {}) };
}

export type GoalSubmission = { kind: 'ordinary' } | { kind: 'invalid'; reason: 'empty' | 'limit' } | { kind: 'command'; command: GoalCommand };
/** Call before ordinary queue admission, model routing, or optimistic transcript writes. */
export function planGoalSubmission(input: {
  text: string; armed: boolean; objectiveOverride?: string | null; inputMode?: 'normal' | 'shell';
  sessionKind?: 'session' | 'assistant'; delivery?: 'queue' | 'steer';
  files?: GoalCommand['files']; agents?: GoalCommand['agents']; skills?: GoalCommand['skills'];
}): GoalSubmission {
  if (input.inputMode === 'shell' || input.sessionKind === 'assistant') return { kind: 'ordinary' };
  const slash = slashCommand(input.text);
  if (!input.armed && slash?.name.toLowerCase() !== 'goal') return { kind: 'ordinary' };
  const text = input.armed ? input.objectiveOverride?.trim() || input.text : slash!.text;
  if (input.armed && !text.trim()) return { kind: 'invalid', reason: 'empty' };
  if (text.length > SESSION_GOAL_OBJECTIVE_CHAR_LIMIT) return { kind: 'invalid', reason: 'limit' };
  return { kind: 'command', command: { name: 'goal', text, ...(input.delivery ? { delivery: input.delivery } : {}),
    ...(input.files?.length ? { files: input.files } : {}), ...(input.agents?.length ? { agents: input.agents } : {}), ...(input.skills?.length ? { skills: input.skills } : {}) } };
}

export type GoalState = {
  goal: NativeGoal | null; resolved: boolean; loading: boolean; readError: boolean; actionError: boolean;
  busy: boolean; armed: boolean; objectiveOverride: string | null;
};
export type GoalCommandResult = 'acknowledged' | 'failed' | 'stale' | 'blocked';
export type GoalArmSnapshot = Readonly<{ armed: boolean; objectiveOverride?: string | null; revision?: number; owner?: object }>;
type GoalCommandOptions = { throwOnFailure?: boolean; refreshAfter?: boolean | 'background'; armSnapshot?: GoalArmSnapshot };
/** One Chat/scope owner. Parent supplies existing SSE and lifecycle; no socket, timer or loop. */
export function createGoalController(scope: GoalScope, transport: GoalTransport, current: () => boolean = () => true, notify: () => void = () => {}) {
  const identity: GoalScope = { ...scope };
  let state: GoalState = { goal: null, resolved: false, loading: false, readError: false, actionError: false, busy: false, armed: false, objectiveOverride: null };
  let readVersion = 0, commandVersion = 0, armVersion = 0;
  const armOwner = {};
  let flight: Promise<void> | undefined;
  const update = (patch: Partial<GoalState>) => { state = { ...state, ...patch }; notify(); };
  const captureArm = (): GoalArmSnapshot => ({ armed: state.armed, objectiveOverride: state.objectiveOverride, revision: armVersion, owner: armOwner });
  function invalidateRead() {
    readVersion++; flight = undefined;
    if (state.loading) update({ loading: false });
  }
  function cancel() {
    readVersion++; commandVersion++; flight = undefined;
    if (state.loading || state.busy) update({ loading: false, busy: false });
  }
  function refresh(): Promise<void> {
    if (!current() || !identity.sessionID) return Promise.resolve();
    if (flight) return flight;
    const version = ++readVersion;
    update({ loading: true });
    const pending = (async () => {
      try {
        const goal = decodeNativeGoal(await transport.get(identity));
        if (current() && version === readVersion) update({ goal, resolved: true, readError: false });
      } catch {
        if (current() && version === readVersion) update({ readError: true });
      } finally {
        if (version === readVersion) {
          flight = undefined;
          if (current()) update({ loading: false });
        }
      }
    })();
    flight = pending;
    return pending;
  }
  function event(event: RuntimeEvent): boolean {
    if (!current() || event.directory !== identity.directory || event.type !== 'rpc.opencode.goal.changed' || event.body.sessionID !== identity.sessionID) return false;
    try {
      const goal = decodeNativeGoal(event.body.goal);
      readVersion++; flight = undefined;
      update({ goal, resolved: true, loading: false, readError: false });
    } catch { /* Invalid events are not authoritative empty success. */ }
    return true;
  }
  async function command(value: GoalCommand, consumeArm = false, options: GoalCommandOptions = {}): Promise<GoalCommandResult> {
    if (!current() || !identity.sessionID || state.busy) return 'blocked';
    if (value.text.length > SESSION_GOAL_OBJECTIVE_CHAR_LIMIT) { update({ actionError: true }); return 'blocked'; }
    const version = ++commandVersion, capturedArm = options.armSnapshot ?? captureArm();
    readVersion++; flight = undefined;
    update({ busy: true, actionError: false, loading: false });
    try {
      await transport.command(identity, value);
      if (!current() || version !== commandVersion) return 'stale';
      if (consumeArm && capturedArm.owner === armOwner && capturedArm.revision !== undefined && armVersion === capturedArm.revision && state.armed === capturedArm.armed && state.objectiveOverride === (capturedArm.objectiveOverride ?? null)) { armVersion++; update({ armed: false, objectiveOverride: null }); }
      // An acknowledgement is not a local status transition. A failed reread must not resend it.
      readVersion++; flight = undefined;
      if (options.refreshAfter !== false) {
        const read = refresh();
        if (options.refreshAfter !== 'background') await read;
      }
      return current() && version === commandVersion ? 'acknowledged' : 'stale';
    } catch (failure) {
      if (!current() || version !== commandVersion) return 'stale';
      update({ actionError: true });
      if (options.throwOnFailure) throw failure;
      return 'failed';
    } finally {
      if (version === commandVersion && current()) update({ busy: false });
    }
  }
  return {
    scope: identity, state: () => state, refresh, event, cancel, command, captureArm, invalidateRead,
    retire() { cancel(); armVersion++; update({ goal: null, resolved: false, readError: false, actionError: false, armed: false, objectiveOverride: null }); },
    setArmed(armed: boolean, objectiveOverride: string | null = null) {
      armVersion++; update({ armed, objectiveOverride: armed ? objectiveOverride : null });
    },
    toggle: () => !state.goal || state.goal.status === 'complete' ? Promise.resolve<GoalCommandResult>('blocked') : command({ name: 'goal', text: state.goal.status === 'active' ? 'pause' : 'resume' }),
    clear: () => command({ name: 'goal', text: 'clear' }),
  };
}
export type GoalController = ReturnType<typeof createGoalController>;
