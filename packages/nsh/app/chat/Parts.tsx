import { Image, Scroll, Text, View, effect, signal, type Signal } from 'nsh';
import { AlertDialog, Button, DiffView } from 'nsh/base';
import { t } from '../core/i18n';
import { colors, radius, statusColor } from '../core/theme';
import { Icon, type IconName } from '../core/Icon';
import { Spinner, alpha, fontSize } from '../core/ui';
import { formatActivityDuration } from '../../../ui/src/components/chat/message/parts/formatActivityDuration';
import { formatEffortLabel } from '../../../ui/src/components/chat/mobileControlsUtils';
import { getProviderModelDisplayName } from '../../../ui/src/lib/modelDisplay';
import {
  isContextGroupTool,
  isSkillGroupTool,
  isUsedGroupTool,
} from '../../../ui/src/components/chat/message/parts/toolRenderUtils';
import { Markdown } from './Markdown';
import { openMessageMenu } from './actions';
import { mediaUri } from './references';
import {
  activityCounts,
  messageDuration,
  messageTps,
  toolName,
  toolSettled,
  toolState,
  type RowGroup,
} from './model';
import type { Catalog, Conversation, MessageEntry, PartEntry } from './store';
import { retryMessage } from './store';

const expansions = new Map<string, Signal<boolean>>();
const manualExpansions = new Set<string>();

function expansionFor(key: string, initial: boolean): Signal<boolean> {
  const existing = expansions.get(key);
  if (existing) return existing;
  const created = signal(initial);
  expansions.set(key, created);
  return created;
}

const textOf = (value: unknown) => (typeof value === 'string' ? value : '');

const recordOf = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

const listOf = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value) ? value.map(recordOf) : [];

const TOOL_ICONS: Record<string, IconName> = {
  read: 'file-text',
  write: 'file-edit',
  create: 'file-edit',
  edit: 'pencil',
  multiedit: 'pencil',
  apply_patch: 'pencil',
  bash: 'terminal-box',
  shell: 'terminal-box',
  glob: 'folder-open',
  grep: 'search',
  list: 'list-unordered',
  webfetch: 'global',
  fetch: 'global',
  task: 'ai-agent',
  subagent: 'ai-agent',
  skill: 'sparkling',
  question: 'question',
  todo: 'list-check-2',
  todowrite: 'list-check-2',
  todoread: 'list-check-2',
};

const toolIcon = (name: string): IconName => TOOL_ICONS[name.toLowerCase()] ?? 'tools';

const inputOf = (part: Record<string, unknown>): Record<string, unknown> => {
  const state = toolState(part);
  const raw = state.input;
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (typeof raw === 'string' && raw.trim()) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {
      return { command: raw };
    }
    return { value: raw };
  }
  return {};
};

const pick = (input: Record<string, unknown>, keys: string[]): string => {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number') return String(value);
  }
  return '';
};

export function toolSummary(part: Record<string, unknown>): string {
  const input = inputOf(part);
  return (
    pick(input, ['description', 'command', 'filePath', 'file_path', 'path', 'pattern', 'query', 'url', 'prompt']) ||
    pick(input, ['filename', 'name'])
  );
}

const pretty = (value: unknown): string => {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return '';
    try {
      return JSON.stringify(JSON.parse(trimmed), null, 2);
    } catch {
      return value;
    }
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
};

/* Diffs: Web reads `metadata.patch` / `metadata.diff` and its per-file patches.
   The native DiffView draws the same unified patch. */

type ToolDiff = { patch: string; oldValue?: string; newValue?: string };

function patchOf(value: unknown): string {
  const patch = textOf(value);
  return patch.trim() ? patch : '';
}

function toolDiff(part: Record<string, unknown>): ToolDiff | null {
  const state = toolState(part);
  const metadata = recordOf(state.metadata);
  const files = listOf(metadata.files);
  const patches = files
    .map((file) => patchOf(file.patch) || patchOf(file.diff))
    .filter(Boolean);
  const patch = patchOf(metadata.patch) || patchOf(metadata.diff) || patches.join('\n');
  if (patch) return { patch };

  const input = inputOf(part);
  const name = toolName(part).toLowerCase();
  const directPatch = patchOf(input.patch) || patchOf(input.diff);
  if (directPatch) return { patch: directPatch };

  const oldValue = pick(input, ['oldString', 'old_string', 'oldText', 'old_text']);
  const newValue = pick(input, ['newString', 'new_string', 'newText', 'new_text']);
  if (oldValue || newValue) return { patch: '', oldValue, newValue };

  if (['write', 'create', 'file_write'].includes(name)) {
    const content = pick(input, ['content', 'text']);
    if (content) return { patch: '', oldValue: '', newValue: content };
  }
  return null;
}

function patchTotals(patch: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of patch.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) added += 1;
    else if (line.startsWith('-')) removed += 1;
  }
  return { added, removed };
}

function lineTotal(value: string): number {
  if (!value) return 0;
  return value.split('\n').length;
}

function toolTotals(part: Record<string, unknown>): { added: number; removed: number } {
  const diff = toolDiff(part);
  if (!diff) return { added: 0, removed: 0 };
  if (diff.patch) return patchTotals(diff.patch);
  return { added: lineTotal(diff.newValue ?? ''), removed: lineTotal(diff.oldValue ?? '') };
}

function diffTotals(parts: () => PartEntry[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const part of parts()) {
    const raw = part.sig();
    if (textOf(raw.type) !== 'tool') continue;
    const totals = toolTotals(raw);
    added += totals.added;
    removed += totals.removed;
  }
  return { added, removed };
}

function DiffTotals(props: { totals: () => { added: number; removed: number } }) {
  return (
    <If when={props.totals().added > 0 || props.totals().removed > 0}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 3, flexShrink: 0 }}>
        <If when={props.totals().added > 0}>
          <Text style={{ fontSize: 13, color: statusColor('success') }}>+{props.totals().added}</Text>
        </If>
        <If when={props.totals().removed > 0}>
          <Text style={{ fontSize: 13, color: statusColor('error') }}>-{props.totals().removed}</Text>
        </If>
      </View>
    </If>
  );
}

function patchLanguage(part: Record<string, unknown>): string {
  const name = toolName(part).toLowerCase();
  if (name === 'bash' || name === 'shell') return 'bash';
  const path = toolSummary(part);
  const extension = path.includes('.') ? path.split('.').pop() ?? '' : '';
  return extension || 'text';
}

function ToolDiffView(props: { part: () => Record<string, unknown> }) {
  const diff = () => toolDiff(props.part());
  return (
    <If
      when={!!diff()?.patch}
      else={
        <If when={!!diff() && diff()!.oldValue !== undefined}>
          <View style={{ marginTop: 6, borderRadius: 10, overflow: 'hidden', backgroundColor: alpha(colors.muted(), 0.3) }}>
            <DiffView
              oldValue={diff()?.oldValue ?? ''}
              newValue={diff()?.newValue ?? ''}
              language={patchLanguage(props.part())}
              layout="unified"
              lineNumbers
              fontSize={11}
              lineHeight={16}
              style={{ maxHeight: 340 }}
            />
          </View>
        </If>
      }
    >
      <View
        testID={`tool-diff-${textOf(props.part().id)}`}
        style={{ marginTop: 6, borderRadius: 10, overflow: 'hidden', backgroundColor: alpha(colors.muted(), 0.3) }}
      >
        <DiffView
          patch={diff()?.patch ?? ''}
          language={patchLanguage(props.part())}
          layout="unified"
          contextLines={3}
          lineNumbers
          fontSize={11}
          lineHeight={16}
          style={{ maxHeight: 340 }}
        />
      </View>
    </If>
  );
}

function MetaLine(props: {
  entry: () => MessageEntry;
  catalog?: () => Catalog;
  show: boolean;
  duration: () => number;
}) {
  const info = () => props.entry().info();
  const model = () => {
    const providerID = textOf(info().providerID);
    const modelID = textOf(info().modelID);
    const catalog = props.catalog?.();
    const entry = catalog
      ? (catalog.providers() as Record<string, unknown>[])
          .map((provider) => ({ provider, models: recordOf(provider.models) }))
          .flatMap(({ provider, models }) =>
            Object.values(models)
              .map(recordOf)
              .filter((row) => textOf(row.id) === modelID && textOf(provider.id) === providerID)
              .map((model) => ({ provider, model })),
          )[0]
      : undefined;
    if (entry) return getProviderModelDisplayName(entry.provider, modelID, { fallbackLabel: modelID });
    return textOf(info().modelName) || modelID;
  };
  const variant = () => {
    const value = textOf(info().variant);
    return value && value.toLowerCase() !== 'default' ? formatEffortLabel(value) : '';
  };
  const duration = () => {
    const value = props.duration() || messageDuration(info());
    return value > 0 ? (value < 1000 ? `${Math.round(value)}ms` : `${(value / 1000).toFixed(1)}s`) : '';
  };
  const tps = () => messageTps(info());
  return (
    <If when={props.show && (!!model() || !!variant() || !!duration() || !!tps())}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 6, flexWrap: 'wrap' }}>
        <If when={!!model()}>
          <Text style={{ flexShrink: 1, fontSize: 11, color: colors.mutedForeground(), numberOfLines: 1 }}>
            {model()}
            {variant() ? ` · ${variant()}` : ''}
          </Text>
        </If>
        <View style={{ flex: 1 }} />
        <If when={!!duration()}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 3 }}>
            <Icon name="hourglass" size={11} tone="muted" />
            <Text style={{ fontSize: 11, color: colors.mutedForeground() }}>{duration()}</Text>
          </View>
        </If>
        <If when={!!tps()}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 3 }}>
            <Icon name="pulse" size={11} tone="muted" />
            <Text style={{ fontSize: 11, color: colors.mutedForeground() }}>{tps()}</Text>
          </View>
        </If>
      </View>
    </If>
  );
}

function Reasoning(props: { part: () => Record<string, unknown>; live: () => boolean }) {
  const text = () => textOf(props.part().text);
  const key = () => `reason:${textOf(props.part().id) || text().slice(0, 12)}`;
  const expanded = expansionFor(key(), false);
  const summary = () => {
    const line = text().trim().split('\n')[0] ?? '';
    return line.length > 80 ? `${line.slice(0, 80)}…` : line;
  };
  return (
    <View>
      <Button
        onPress={() => {
          manualExpansions.add(key());
          expanded.set(!expanded());
        }}
        activeStyle={{ backgroundColor: alpha(colors.mutedForeground(), 0.08) }}
        accessibilityLabel={expanded() ? t('chat.reasoningTrace.collapseAria') : t('chat.reasoningTrace.expandAria')}
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: 6,
          paddingVertical: 2,
          paddingHorizontal: 8,
          marginHorizontal: -8,
          borderRadius: 8,
        }}
      >
        <Icon name="brain-ai-3" size={14} tone="muted" />
        <Text style={{ fontSize: 13, color: colors.mutedForeground(), fontWeight: '500' }}>
          {t('chat.reasoningTrace.thinking')}
        </Text>
        <If when={!expanded() && !!summary()}>
          <Text style={{ flexShrink: 1, fontSize: 13, color: alpha(colors.mutedForeground(), 0.8), numberOfLines: 1 }}>
            {summary()}
          </Text>
        </If>
        <View style={{ flex: 1 }} />
        <Icon name={expanded() ? 'arrow-down-s' : 'arrow-right-s'} size={13} tone="muted" />
      </Button>
      <If when={expanded()}>
        <View style={{ borderLeftWidth: 1, borderLeftColor: alpha(colors.border(), 0.7), paddingLeft: 10, marginLeft: 1, paddingTop: 4 }}>
          <Text style={{ fontSize: 13, lineHeight: 19, color: colors.mutedForeground() }}>{text()}</Text>
        </View>
      </If>
    </View>
  );
}

function ToolDetail(props: { part: () => Record<string, unknown> }) {
  const state = () => toolState(props.part());
  const input = () => pretty(state().input);
  const output = () => textOf(state().output);
  const error = () => textOf(state().error);
  return (
    <View style={{ gap: 6, marginTop: 4, padding: 8, borderRadius: 10, backgroundColor: alpha(colors.muted(), 0.45) }}>
      <ToolDiffView part={props.part} />
      <If when={!!input()}>
        <Text style={{ fontSize: 11, fontWeight: '600', color: colors.mutedForeground() }}>
          {t('chat.permissionCard.details')}
        </Text>
        <Scroll style={{ maxHeight: 200 }} scrollbar={false}>
          <Text style={{ fontFamily: 'Menlo', fontSize: 11, lineHeight: 15, color: colors.foreground() }}>{input()}</Text>
        </Scroll>
      </If>
      <If when={!!error()}>
        <Text style={{ fontSize: 11, fontWeight: '600', color: colors.destructive() }}>
          {t('chat.permissionCard.details')}
        </Text>
        <Text style={{ fontFamily: 'Menlo', fontSize: 11, lineHeight: 15, color: colors.destructive() }}>{error()}</Text>
      </If>
      <If when={!!output()}>
        <Scroll style={{ maxHeight: 260 }} scrollbar={false}>
          <Text style={{ fontFamily: 'Menlo', fontSize: 11, lineHeight: 15, color: colors.foreground() }}>{output()}</Text>
        </Scroll>
      </If>
    </View>
  );
}

/** One tool line, Web `ToolPart`'s chip: rounded wash, meta type, expandable details. */
function ToolRow(props: { part: () => Record<string, unknown>; nested?: boolean }) {
  const name = () => toolName(props.part());
  const settled = () => toolSettled(props.part());
  const failed = () => ['error', 'failed'].includes(textOf(toolState(props.part()).status));
  const key = () => `tool:${textOf(props.part().id)}`;
  const expanded = expansionFor(key(), false);
  const summary = () => toolSummary(props.part());
  return (
    <View>
      <Button
        testID={`tool-row-${textOf(props.part().id)}`}
        onPress={() => {
          manualExpansions.add(key());
          expanded.set(!expanded());
        }}
        activeStyle={{ backgroundColor: alpha(colors.mutedForeground(), 0.08) }}
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: 6,
          paddingVertical: 2,
          paddingHorizontal: 8,
          marginHorizontal: -8,
          borderRadius: 8,
        }}
      >
        <Icon name={toolIcon(name())} size={14} tone="muted" />
        <Text style={{ flexShrink: 0, fontSize: 13, fontWeight: '500', color: colors.foreground(), numberOfLines: 1 }}>
          {name()}
        </Text>
        <If when={!!summary()}>
          <Text style={{ flexShrink: 1, fontSize: 13, color: colors.mutedForeground(), numberOfLines: 1 }}>
            {summary()}
          </Text>
        </If>
        <View style={{ flex: 1 }} />
        <If when={!settled()}>
          <Spinner size={11} />
        </If>
        <If when={settled() && failed()}>
          <Icon name="error-warning" size={13} color={() => statusColor('error')} />
        </If>
        <Icon name={expanded() ? 'arrow-down-s' : 'arrow-right-s'} size={13} tone="muted" />
      </Button>
      <If when={expanded()}>
        <ToolDetail part={props.part} />
      </If>
    </View>
  );
}

type ActivityItem =
  | { kind: 'reasoning'; key: string; part: PartEntry }
  | { kind: 'tool'; key: string; part: PartEntry }
  | { kind: 'text'; key: string; part: PartEntry };

type ActivityGroup =
  | { kind: 'reasoning'; key: string; items: ActivityItem[] }
  | { kind: 'text'; key: string; items: ActivityItem[] }
  | { kind: 'single'; key: string; items: ActivityItem[] }
  | { kind: 'context' | 'used' | 'skill'; key: string; items: ActivityItem[] };

function toolGroupKind(part: Record<string, unknown>): 'context' | 'used' | 'skill' | 'single' {
  const name = toolName(part);
  if (isContextGroupTool(name)) return 'context';
  if (isSkillGroupTool(name)) return 'skill';
  if (isUsedGroupTool(name)) return 'used';
  return 'single';
}

function groupItems(items: ActivityItem[]): ActivityGroup[] {
  const groups: ActivityGroup[] = [];
  let run: ActivityItem[] = [];
  let runKind: 'context' | 'used' | 'skill' | null = null;
  const flush = () => {
    if (!run.length || !runKind) return;
    groups.push({ kind: runKind, key: `group:${run[0]!.key}`, items: run });
    run = [];
    runKind = null;
  };
  for (const item of items) {
    if (item.kind !== 'tool') {
      flush();
      groups.push({ kind: item.kind, key: item.key, items: [item] });
      continue;
    }
    const kind = toolGroupKind(item.part.sig());
    if (kind === 'single') {
      flush();
      groups.push({ kind: 'single', key: item.key, items: [item] });
      continue;
    }
    if (runKind && runKind !== kind) flush();
    runKind = kind;
    run.push(item);
  }
  flush();
  return groups;
}

function countsSummary(items: () => ActivityItem[]): string {
  const names = items().filter((item) => item.kind === 'tool').map((item) => toolName(item.part.sig()));
  const counts = activityCounts(names);
  const out: string[] = [];
  const add = (count: number, single: string, plural: string) => {
    if (count > 0) out.push(t(count === 1 ? (single as never) : (plural as never), { count }));
  };
  add(counts.search ?? 0, 'chat.contextGroup.searchSingle', 'chat.contextGroup.searchPlural');
  add(counts.read ?? 0, 'chat.contextGroup.readSingle', 'chat.contextGroup.readPlural');
  add(counts.list ?? 0, 'chat.contextGroup.listSingle', 'chat.contextGroup.listPlural');
  add(counts.edit ?? 0, 'chat.usedGroup.editSingle', 'chat.usedGroup.editPlural');
  add(counts.command ?? 0, 'chat.usedGroup.commandSingle', 'chat.usedGroup.commandPlural');
  add(counts.other ?? 0, 'chat.usedGroup.otherSingle', 'chat.usedGroup.otherPlural');
  return out.join(', ');
}

function ToolGroup(props: {
  kind: 'context' | 'used' | 'skill';
  items: () => PartEntry[];
  key: () => string;
  active: () => boolean;
}) {
  // The turn fold is the user's disclosure: once it opens, its tool rows show
  // (Web's nested groups default closed, but the phone's one tap should reveal
  // the work it stands for).
  const expanded = expansionFor(`grouprow:${props.key()}`, true);
  const summary = () => {
    const names = props.items().map((item) => toolName(item.sig()));
    const counts = activityCounts(names);
    const out: string[] = [];
    const add = (count: number, single: string, plural: string) => {
      if (count > 0) out.push(t(count === 1 ? (single as never) : (plural as never), { count }));
    };
    add(counts.search ?? 0, 'chat.contextGroup.searchSingle', 'chat.contextGroup.searchPlural');
    add(counts.read ?? 0, 'chat.contextGroup.readSingle', 'chat.contextGroup.readPlural');
    add(counts.list ?? 0, 'chat.contextGroup.listSingle', 'chat.contextGroup.listPlural');
    add(counts.edit ?? 0, 'chat.usedGroup.editSingle', 'chat.usedGroup.editPlural');
    add(counts.command ?? 0, 'chat.usedGroup.commandSingle', 'chat.usedGroup.commandPlural');
    add(counts.other ?? 0, 'chat.usedGroup.otherSingle', 'chat.usedGroup.otherPlural');
    return out.join(', ');
  };
  const label = () =>
    props.active()
      ? t('chat.usedGroup.running')
      : props.kind === 'context'
        ? t('chat.contextGroup.explored')
        : t('chat.usedGroup.used');
  const totals = () => diffTotals(props.items);
  return (
    <View>
      <Button
        testID={`tool-group-${props.items()[0]?.key ?? props.key()}`}
        onPress={() => {
          manualExpansions.add(`grouprow:${props.key()}`);
          expanded.set(!expanded());
        }}
        activeStyle={{ backgroundColor: alpha(colors.mutedForeground(), 0.08) }}
        accessibilityLabel={expanded() ? t('chat.usedGroup.collapseAria') : t('chat.usedGroup.expandAria')}
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: 6,
          paddingVertical: 2,
          paddingHorizontal: 8,
          marginHorizontal: -8,
          borderRadius: 8,
        }}
      >
        <If when={props.active()} else={<Icon name={props.kind === 'context' ? 'search' : props.kind === 'skill' ? 'sparkling' : 'tools'} size={13} tone="muted" />}>
          <Spinner size={12} />
        </If>
        <Text style={{ flexShrink: 0, fontSize: 13, fontWeight: '500', color: colors.mutedForeground() }}>{label()}</Text>
        <If when={!!summary()}>
          <Text style={{ flexShrink: 1, fontSize: 13, color: alpha(colors.mutedForeground(), 0.85), numberOfLines: 1 }}>
            {summary()}
          </Text>
        </If>
        <View style={{ flex: 1 }} />
        <DiffTotals totals={totals} />
        <Icon name={expanded() ? 'arrow-down-s' : 'arrow-right-s'} size={13} tone="muted" />
      </Button>
      <If when={expanded()}>
        <View style={{ gap: 4, marginLeft: 8, paddingLeft: 12, paddingTop: 4, borderLeftWidth: 1, borderLeftColor: alpha(colors.border(), 0.5) }}>
          <Each of={props.items()} key={(part) => part.key}>
            {(part) => <ToolRow part={() => part().sig()} nested />}
          </Each>
        </View>
      </If>
    </View>
  );
}

function ActivityGroupRow(props: { group: () => ActivityGroup }) {
  const kind = () => props.group().kind;
  const items = () => props.group().items;
  const toolParts = () => items().filter((item) => item.kind === 'tool').map((item) => item.part);
  const active = () => toolParts().some((part) => !toolSettled(part.sig()));
  return (
    <If
      when={kind() === 'reasoning'}
      else={
        <If
          when={kind() === 'text'}
          else={
            <If
              when={kind() === 'single'}
              else={
                <ToolGroup
                  kind={kind() as 'context' | 'used' | 'skill'}
                  items={toolParts}
                  key={() => props.group().key}
                  active={active}
                />
              }
            >
              <ToolRow part={() => (items()[0] as { part: PartEntry }).part.sig()} nested />
            </If>
          }
        >
          <View style={{ paddingVertical: 2 }}>
            <Markdown text={() => textOf((items()[0] as { part: PartEntry }).part.sig().text)} />
          </View>
        </If>
      }
    >
      <Reasoning part={() => (items()[0] as { part: PartEntry }).part.sig()} live={() => false} />
    </If>
  );
}

/** One assistant run's process fold: every tool, reasoning trace and intermediate
    text collapses under one header; the trailing reply stays inline. */
function Activity(props: {
  items: () => ActivityItem[];
  key: () => string;
  live: () => boolean;
  last: () => boolean;
  duration: () => number;
}) {
  const active = () => props.items().some((item) => item.kind === 'tool' && !toolSettled(item.part.sig()));
  const initial = props.live() && props.last();
  const expanded = expansionFor(`activity:${props.key()}`, initial);
  let wasLive = initial;
  effect(() => {
    const now = props.live() && props.last();
    if (wasLive && !now && !manualExpansions.has(`activity:${props.key()}`)) expanded.set(false);
    wasLive = now;
  });
  const groups = () => groupItems(props.items());
  const summary = () => countsSummary(props.items);
  const totals = () => {
    const parts = () => props.items().filter((item) => item.kind === 'tool').map((item) => item.part);
    return diffTotals(parts);
  };
  const duration = () => (props.duration() > 0 ? formatActivityDuration(props.duration()) : '');
  const label = () =>
    active()
      ? t('chat.activity.active')
      : duration()
        ? t('chat.activity.completed', { duration: duration() })
        : t('chat.activity.completedStatus');

  return (
    <View>
      <If when={!active()}>
        <Button
          onPress={() => {
            manualExpansions.add(`activity:${props.key()}`);
            expanded.set(!expanded());
          }}
          accessibilityLabel={expanded() ? t('chat.activity.collapseAria') : t('chat.activity.expandAria')}
          activeStyle={{ backgroundColor: alpha(colors.mutedForeground(), 0.08) }}
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: 6,
            paddingVertical: 2,
            paddingHorizontal: 8,
            marginHorizontal: -8,
            borderRadius: 8,
          }}
        >
          <Icon name={expanded() ? 'arrow-down-s' : 'arrow-right-s'} size={13} tone="muted" />
          <Text style={{ flexShrink: 0, fontSize: 13, fontWeight: '500', color: colors.foreground(), numberOfLines: 1 }}>
            {label()}
          </Text>
          {/* Web `ContextToolGroup`: the "Used" title and its counts are two
              spans of one line, so the title keeps its own text node. */}
          <If when={!!summary()}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, flexShrink: 1, overflow: 'hidden' }}>
              <Text style={{ flexShrink: 0, fontSize: 13, color: colors.foreground(), numberOfLines: 1 }}>
                {t('chat.usedGroup.used')}
              </Text>
              <Text style={{ flexShrink: 1, fontSize: 13, color: colors.mutedForeground(), numberOfLines: 1 }}>
                {summary()}
              </Text>
            </View>
          </If>
          <View style={{ flex: 1 }} />
          <DiffTotals totals={totals} />
          <Icon name={expanded() ? 'arrow-down-s' : 'arrow-right-s'} size={13} tone="muted" />
        </Button>
      </If>
      <If when={active() || expanded()}>
        <View
          style={
            active()
              ? { gap: 2, paddingTop: 2 }
              : {
                  gap: 2,
                  paddingTop: 4,
                  marginLeft: 8,
                  paddingLeft: 12,
                  borderLeftWidth: 1,
                  borderLeftColor: alpha(colors.border(), 0.5),
                }
          }
        >
          <Each of={groups()} key={(group) => group.key}>
            {(group) => <ActivityGroupRow group={group} />}
          </Each>
        </View>
      </If>
    </View>
  );
}

function Attachment(props: { file: () => Record<string, unknown> }) {
  const url = () => textOf(props.file().url) || textOf(props.file().uri);
  const mime = () => textOf(props.file().mime);
  const name = () => textOf(props.file().filename) || textOf(props.file().name) || url().split('/').pop() || '';
  return (
    <If
      when={mime().startsWith('image/') && !!mediaUri(url())}
      else={
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: 6,
            paddingHorizontal: 8,
            paddingVertical: 5,
            borderRadius: 8,
            backgroundColor: alpha(colors.muted(), 0.6),
          }}
        >
          <Icon name="file-text" size={13} tone="muted" />
          <Text style={{ fontSize: 12, color: colors.foreground(), numberOfLines: 1 }}>{name()}</Text>
        </View>
      }
    >
      <Image
        src={url()}
        style={{ width: 180, height: 180, borderRadius: 12, objectFit: 'cover', backgroundColor: colors.muted() }}
      />
    </If>
  );
}

function UserMessage(props: { entry: () => MessageEntry; onRetry: () => void; onMenu: () => void }) {
  const error = () => textOf(props.entry().info().error);
  const files = () => props.entry().attachments();
  const showError = () => {
    void AlertDialog.show({
      title: t('assistants.contact.sendError.title'),
      description: error() || t('assistants.contact.sendFailed'),
      actions: [
        { id: 'close', label: t('gitView.common.close'), role: 'cancel' },
        { id: 'retry', label: t('chat.history.retry') },
      ],
    }).then((answer) => {
      if (answer.action === 'retry') props.onRetry();
    });
  };
  return (
    <View style={{ alignItems: 'flex-end' }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: 4, maxWidth: '100%' }}>
        <If when={!!error()}>
          <Button
            testID={`message-error-${props.entry().id}`}
            accessibilityLabel={t('assistants.contact.sendError.viewDetails')}
            onPress={showError}
            style={{ width: 28, height: 28, alignItems: 'center', justifyContent: 'center' }}
          >
            <Icon name="exclamation-fill" size={18} color={() => statusColor('error')} />
          </Button>
        </If>
        <View
          testID={`message-${props.entry().id}`}
          onLongPress={() => props.onMenu()}
          style={{
            maxWidth: '86%',
            paddingHorizontal: 12,
            paddingVertical: 7,
            borderRadius: radius.inset,
            borderBottomRightRadius: 4,
            backgroundColor: alpha(colors.muted(), 0.75),
          }}
        >
          <Markdown text={() => props.entry().text()} />
          <If when={files().length > 0}>
            <View style={{ gap: 6, marginTop: 6 }}>
              <Each of={files()} key="index">
                {(file) => <Attachment file={file} />}
              </Each>
            </View>
          </If>
        </View>
      </View>
    </View>
  );
}

/** Web `BusyDots`: three dots stepping in order while the reply streams. */
function TypingDots() {
  const step = signal(0);
  effect(() => {
    const timer = setInterval(() => step.set((step() + 1) % 3), 320);
    return () => clearInterval(timer);
  });
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 2, height: 14 }}>
      <Each of={[0, 1, 2]} key="index">
        {(index) => (
          <View
            style={{
              width: 3,
              height: 3,
              borderRadius: 1.5,
              backgroundColor: colors.mutedForeground(),
              opacity: step() === index() ? 1 : 0.35,
            }}
          />
        )}
      </Each>
    </View>
  );
}

function finalBodyIndex(parts: PartEntry[]): number {
  if (parts.some((part) => part.sig().type === 'tool' && !toolSettled(part.sig()))) return -1;
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const part = parts[index]!;
    const type = textOf(part.sig().type);
    if (type === 'text') {
      if (textOf(part.sig().text).trim()) return index;
      continue;
    }
    if (type === 'tool' || type === 'reasoning' || type === 'file' || type === 'agent' || type === 'subtask') break;
  }
  return -1;
}

function activityOf(entries: MessageEntry[]): { items: ActivityItem[]; body: { key: string; text: () => string } | null } {
  const items: ActivityItem[] = [];
  const last = entries[entries.length - 1];
  const bodyIndex = last ? finalBodyIndex(last.parts()) : -1;
  let body: { key: string; text: () => string } | null = null;
  for (const entry of entries) {
    const parts = entry.parts();
    for (let index = 0; index < parts.length; index += 1) {
      const part = parts[index]!;
      const raw = part.sig();
      const type = textOf(raw.type);
      if (type === 'reasoning') {
        if (textOf(raw.text).trim()) items.push({ kind: 'reasoning', key: part.key, part });
        continue;
      }
      if (type === 'tool') {
        items.push({ kind: 'tool', key: part.key, part });
        continue;
      }
      if (type === 'text') {
        if (!textOf(raw.text).trim()) continue;
        if (entry === last && index === bodyIndex) {
          body = { key: part.key, text: () => textOf(part.sig().text) };
          continue;
        }
        items.push({ kind: 'text', key: part.key, part });
      }
    }
  }
  return { items, body };
}

function runDuration(entries: () => MessageEntry[]): number {
  let start = 0;
  let end = 0;
  for (const entry of entries()) {
    const info = entry.info();
    const time = recordOf(info.time);
    const created = Number(time.created) || 0;
    if (created && (!start || created < start)) start = created;
    const done = Number(time.completed) || Number(time.streamed) || 0;
    if (done > end) end = done;
    for (const part of entry.parts()) {
      const partTime = recordOf(recordOf(part.sig().state).time);
      const partEnd = Number(partTime.end) || 0;
      if (partEnd > end) end = partEnd;
    }
  }
  return start && end >= start ? end - start : 0;
}

function AssistantMessage(props: {
  entries: () => MessageEntry[];
  live: () => boolean;
  last: () => boolean;
  catalog?: () => Catalog;
  onMenu: () => void;
}) {
  const content = () => activityOf(props.entries());
  const items = () => content().items;
  const body = () => content().body;
  const lastEntry = () => props.entries()[props.entries().length - 1];
  const error = () => (lastEntry() ? textOf(lastEntry()!.info().error) : '');
  const streaming = () => !!lastEntry()?.info().streaming;
  const showError = () => {
    void AlertDialog.show({
      title: t('assistants.contact.sendError.title'),
      description: error(),
      actions: [{ id: 'close', label: t('gitView.common.close'), role: 'cancel' }],
    });
  };
  const duration = () => runDuration(props.entries);
  return (
    <View
      testID={`message-${lastEntry()?.id ?? ''}`}
      onLongPress={() => props.onMenu()}
      style={{ gap: 8 }}
    >
      <If when={items().length > 0}>
        <Activity
          items={items}
          key={() => `run:${props.entries()[0]?.id ?? ''}`}
          live={props.live}
          last={props.last}
          duration={duration}
        />
      </If>
      <If when={!!body()}>
        <Markdown text={() => body()?.text() ?? ''} />
      </If>
      <If when={!!error()}>
        <Button
          testID={`assistant-error-${lastEntry()?.id ?? ''}`}
          onPress={showError}
          style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}
        >
          <Icon name="exclamation-fill" size={14} color={() => statusColor('error')} />
          <Text style={{ flexShrink: 1, fontSize: 12, color: colors.destructive(), numberOfLines: 3 }}>{error()}</Text>
        </Button>
      </If>
      <If when={streaming() && items().length === 0 && !body()}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <Spinner size={11} />
          <Text style={{ fontSize: 12, color: colors.mutedForeground() }}>{t('chat.assistantStatus.thinking')}</Text>
        </View>
      </If>
      <If when={streaming() && (items().length > 0 || !!body())}>
        <TypingDots />
      </If>
      <If when={!!lastEntry()}>
        <MetaLine
          entry={() => lastEntry()!}
          catalog={props.catalog}
          show={true}
          duration={duration}
        />
      </If>
    </View>
  );
}

function CompactionCard(props: { entry: () => MessageEntry; live: () => boolean }) {
  const key = () => `compaction:${props.entry().id}`;
  const expanded = expansionFor(key(), false);
  const summary = () => {
    const info = props.entry().info();
    return textOf(info.summary) || props.entry().text() || t('chat.activity.compactionCompleted');
  };
  const duration = () => messageDuration(props.entry().info());
  return (
    <View>
      <Button
        onPress={() => {
          manualExpansions.add(key());
          expanded.set(!expanded());
        }}
        accessibilityLabel={expanded() ? t('chat.activity.collapseAria') : t('chat.activity.expandAria')}
        activeStyle={{ backgroundColor: alpha(colors.mutedForeground(), 0.08) }}
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: 6,
          paddingVertical: 2,
          paddingHorizontal: 8,
          marginHorizontal: -8,
          borderRadius: 8,
        }}
      >
        <If when={props.live()} else={<Icon name="fold-vertical" size={13} tone="muted" />}>
          <Spinner size={12} />
        </If>
        <Text style={{ flexShrink: 0, fontSize: 13, fontWeight: '500', color: colors.foreground() }}>
          {props.live() ? t('chat.activity.compacting') : t('chat.activity.compactionCompleted')}
        </Text>
        <If when={!props.live() && duration() > 0}>
          <Text style={{ fontSize: 13, color: colors.mutedForeground() }}>{formatActivityDuration(duration())}</Text>
        </If>
        <View style={{ flex: 1 }} />
        <Icon name={expanded() ? 'arrow-down-s' : 'arrow-right-s'} size={13} tone="muted" />
      </Button>
      <If when={expanded()}>
        <View style={{ marginTop: 4, marginLeft: 8, paddingLeft: 12, borderLeftWidth: 1, borderLeftColor: alpha(colors.border(), 0.5) }}>
          <Text style={{ fontSize: 13, lineHeight: 19, color: colors.mutedForeground() }}>{summary()}</Text>
        </View>
      </If>
    </View>
  );
}

/** One transcript row: a user turn, an assistant run, or a compaction checkpoint. */
export function MessageRow(props: {
  conversation: Conversation;
  row: () => RowGroup;
  catalog?: () => Catalog;
}) {
  const row = () => props.row();
  const entries = () => row().ids.map((id) => props.conversation.entries.get(id)).filter((entry) => !!entry);
  const user = () => entries().find((entry) => entry.role === 'user');
  const compaction = () => entries().find((entry) => entry.role === 'compaction');
  const assistants = () => entries().filter((entry) => entry.role === 'assistant');
  return (
    <View style={{ gap: 10, paddingHorizontal: 16, paddingVertical: 6 }}>
      <If when={!!user()}>
        <UserMessage
          entry={() => user()!}
          onRetry={() => void retryMessage(props.conversation, user()!)}
          onMenu={() => void openMessageMenu(props.conversation, user()!)}
        />
      </If>
      <If when={!!compaction()}>
        <CompactionCard entry={() => compaction()!} live={() => row().live} />
      </If>
      <If when={assistants().length > 0}>
        <AssistantMessage
          entries={assistants}
          live={() => row().live}
          last={() => row().last}
          catalog={props.catalog}
          onMenu={() => void openMessageMenu(props.conversation, assistants()[assistants().length - 1]!)}
        />
      </If>
    </View>
  );
}

export const messageText = (entry: MessageEntry) => entry.text();

export const messageFontSize = fontSize.body;
