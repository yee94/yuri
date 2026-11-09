import type { Part } from '../ui/src/lib/opencode/v2-types';
import { isTaskToolName } from '../ui/src/components/chat/message/parts/taskToolModel';
import * as generated from './desktop-work-status-helpers.generated';
import { record, text, type Message, type Row, type RuntimeEvent } from './model';
import type { NativeTask } from './chat-tasks-model';
import type { DesktopWorkStatusChat } from './desktop-work-status-core';

const helpers = generated as typeof import('../ui/src/components/chat/work-status/workStatusSubagents');
const emptyIDs: ReadonlySet<string> = new Set<string>();
const unavailable = Object.freeze({ phase: 'unavailable' as const });

/** Same part identity as nativeMessageEntry, without importing a body renderer or adapting text. */
export function desktopWorkStatusSourcePartID(messageID: string, part: Row, index: number) {
  return `${messageID}:${text(part.id) || `${text(part.type)}:${typeof part.ordinal === 'number' ? part.ordinal : index}`}`;
}
function taskPart(messageID: string, part: Row, index: number): Part | undefined {
  if (part.type !== 'subtask' && (part.type !== 'tool' || !isTaskToolName(text(part.name) || text(part.tool)))) return;
  const id = desktopWorkStatusSourcePartID(messageID, part, index);
  if (part.type === 'tool') return { ...part, id, messageID, sessionID: '', type: 'tool', tool: text(part.name) || text(part.tool), state: record(part.state) } as Part;
  return { ...part, id, messageID, sessionID: '', type: 'subtask' } as Part;
}

/** A write-through leaf of the original Chat owner. No effects, subscriptions, clocks, requests or retained history. */
export function createDesktopWorkStatusSourceProjection(changed: (value: DesktopWorkStatusChat) => void, tasks: readonly NativeTask[] = []) {
  let retired = false;
  let value: DesktopWorkStatusChat = Object.freeze({ tasks, activity: 'unknown', taskFaces: [], liveTaskPartIDs: emptyIDs, backgroundShell: unavailable });
  const live = new Set<string>();
  let idleClock = -1;
  function publish(next: DesktopWorkStatusChat) {
    if (next.tasks === value.tasks && next.activity === value.activity && next.taskFaces === value.taskFaces && next.liveTaskPartIDs === value.liveTaskPartIDs) return;
    value = Object.freeze(next); changed(value);
  }
  function liveIDs(faces = value.taskFaces): ReadonlySet<string> {
    const next = new Set(faces.filter(face => live.has(face.id) && face.running).map(face => face.id));
    const prior = value.liveTaskPartIDs;
    if (prior.size === next.size && [...next].every(id => prior.has(id))) return prior;
    return next.size ? next : emptyIDs;
  }
  return {
    snapshot: () => value,
    /** Only the original updateTasks seam invokes this, after tool/history/revert commits. */
    commitTranscript(messages: readonly Message[], tasks: readonly NativeTask[]) {
      if (retired) return;
      const messageOrder: string[] = [], partsByMessageID: Record<string, Part[]> = {};
      for (const message of messages) {
        const parts: Part[] = [];
        const raw = message.content?.length ? message.content : message.tools;
        const offset = message.content?.length ? 0 : Number(!!message.text) + Number(!!message.reasoning);
        raw.forEach((part, index) => { const projected = taskPart(message.id, part, index + offset); if (projected) parts.push(projected); });
        if (parts.length) { messageOrder.push(message.id); partsByMessageID[message.id] = parts; }
      }
      const projected = helpers.projectTranscriptSubagents({ messageOrder, partsByMessageID });
      const taskFaces = helpers.transcriptSubagentsEqual(value.taskFaces, projected) ? value.taskFaces : projected;
      const present = new Set(taskFaces.map(face => face.id));
      for (const id of live) if (!present.has(id)) live.delete(id);
      publish({ ...value, tasks, taskFaces, liveTaskPartIDs: liveIDs(taskFaces) });
    },
    /** Called only after the original live content reducer accepts this exact tool event. */
    acceptTool(event: RuntimeEvent, message: Message) {
      if (retired || !event.type.startsWith('session.tool.') || event.created !== undefined && event.created < idleClock) return;
      const toolID = text(event.body.id);
      if (!toolID || text(event.body.assistantMessageID) !== message.id) return;
      const parts = message.content ?? message.tools, index = parts.findIndex(part => part.type === 'tool' && part.id === toolID);
      const part = parts[index];
      if (!part || !isTaskToolName(text(part.name) || text(part.tool))) return;
      const id = desktopWorkStatusSourcePartID(message.id, part, index), status = text(record(part.state).status);
      if (status === 'pending' || status === 'running' || status === 'streaming') live.add(id); else live.delete(id);
      publish({ ...value, liveTaskPartIDs: liveIDs() });
    },
    confirmActivity(working: boolean, clock?: number) {
      if (retired) return;
      if (!working) { live.clear(); idleClock = clock ?? idleClock; }
      publish({ ...value, activity: working ? 'working' : 'idle', liveTaskPartIDs: working ? value.liveTaskPartIDs : emptyIDs });
    },
    resetLive() { live.clear(); publish({ ...value, liveTaskPartIDs: emptyIDs }); },
    suspend() { live.clear(); idleClock = -1; publish({ ...value, activity: 'unknown', liveTaskPartIDs: emptyIDs }); },
    retire(tasks: readonly NativeTask[]) {
      if (retired) return;
      live.clear(); retired = true;
      publish({ tasks, activity: 'unknown', taskFaces: [], liveTaskPartIDs: emptyIDs, backgroundShell: unavailable });
    },
  };
}
