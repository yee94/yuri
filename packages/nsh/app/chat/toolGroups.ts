// Web `processToolGrouping` re-exported without its `toolDiffUtils` edge:
// that module imports `@pierre/diffs`, which the NSH dev bundler keeps (and
// QuickJS cannot evaluate). Only the diff-total helper needs it; the counting
// path here is the same logic.
import {
  CONTEXT_TOOL_COUNT_ORDER,
  summarizeContextTools,
  type ContextToolCountKey,
  type ContextToolCounts,
} from '../../../ui/src/components/chat/message/parts/contextToolGrouping';
import { isUsedGroupTool, normalizeContextToolName } from '../../../ui/src/components/chat/message/parts/toolRenderUtils';

export type UsedToolCountKey = 'edit' | 'command' | 'other';
export type UsedToolCounts = Record<UsedToolCountKey, number>;
export const USED_TOOL_COUNT_ORDER: readonly UsedToolCountKey[] = ['edit', 'command', 'other'];

const EDIT_TOOL_NAMES = new Set<string>(['edit', 'multiedit', 'write', 'create', 'file_write', 'apply_patch', 'patch']);
const COMMAND_TOOL_NAMES = new Set<string>(['bash', 'shell', 'cmd', 'command', 'exec', 'terminal']);

function usedToolCountKey(toolName: unknown): UsedToolCountKey | null {
  if (!isUsedGroupTool(toolName)) return null;
  const name = normalizeContextToolName(toolName);
  if (EDIT_TOOL_NAMES.has(name)) return 'edit';
  if (COMMAND_TOOL_NAMES.has(name)) return 'command';
  return 'other';
}

function summarizeUsedTools(toolNames: readonly unknown[]): UsedToolCounts {
  const counts: UsedToolCounts = { edit: 0, command: 0, other: 0 };
  for (const toolName of toolNames) {
    const key = usedToolCountKey(toolName);
    if (key) counts[key] += 1;
  }
  return counts;
}

export type ProcessToolCountKey = ContextToolCountKey | UsedToolCountKey;
export type ProcessToolCounts = ContextToolCounts & UsedToolCounts;
export const PROCESS_TOOL_COUNT_ORDER: readonly ProcessToolCountKey[] = [...CONTEXT_TOOL_COUNT_ORDER, ...USED_TOOL_COUNT_ORDER];

export function summarizeProcessTools(toolNames: readonly unknown[]): ProcessToolCounts {
  return { ...summarizeContextTools(toolNames), ...summarizeUsedTools(toolNames) };
}
