import { Scroll, Text, View, effect, signal, untracked } from 'nsh';
import { Button } from 'nsh/base';
import { t } from '../core/i18n';
import { colors, radius } from '../core/theme';
import { Icon, type IconName } from '../core/Icon';
import { alpha, EmptyState, NativeSheet, Spinner } from '../core/ui';
import { record, textOf, unwrap } from '../core/host';
import { sessionRequest, type Conversation } from './store';

type ChangedFile = { path: string; index: string; working: string; additions: number; deletions: number; staged: boolean };

type DiffLine = { kind: 'context' | 'added' | 'removed'; text: string; oldLine: number | null; newLine: number | null };

const sheetPopup = { backgroundColor: colors.background(), borderTopLeftRadius: 26, borderTopRightRadius: 26 } as const;
const backdrop = { backgroundColor: alpha('#000000', 0.32) } as const;

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Line-level overview of one file; capped so a huge file stays responsive. */
export function diffLines(before: string, after: string, cap = 240): DiffLine[] {
  const a = before.split('\n').slice(0, cap);
  const b = after.split('\n').slice(0, cap);
  const rows: DiffLine[] = [];
  const table: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i]![j] = a[i] === b[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
  }
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      rows.push({ kind: 'context', text: a[i]!, oldLine: i + 1, newLine: j + 1 });
      i += 1;
      j += 1;
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) {
      rows.push({ kind: 'removed', text: a[i]!, oldLine: i + 1, newLine: null });
      i += 1;
    } else {
      rows.push({ kind: 'added', text: b[j]!, oldLine: null, newLine: j + 1 });
      j += 1;
    }
  }
  while (i < a.length) rows.push({ kind: 'removed', text: a[i]!, oldLine: (i += 1), newLine: null });
  while (j < b.length) rows.push({ kind: 'added', text: b[j]!, oldLine: null, newLine: (j += 1) });
  return rows;
}

/** Web's `changeGroups`: index status owns staged files, working tree the rest. */
export function changedFiles(value: unknown): ChangedFile[] {
  const body = record(value);
  if (!Array.isArray(body.files)) throw new Error('Invalid Git status');
  const stats = record(body.diffStats);
  const files: ChangedFile[] = [];
  const seen = new Set<string>();
  for (const entry of body.files) {
    const row = record(entry);
    const path = textOf(row.path);
    if (!path || seen.has(path)) continue;
    seen.add(path);
    const index = textOf(row.index).trim();
    const working = textOf(row.working_dir).trim();
    const stat = record(stats[path]);
    const base = {
      path,
      index,
      working,
      additions: typeof stat.insertions === 'number' ? stat.insertions : 0,
      deletions: typeof stat.deletions === 'number' ? stat.deletions : 0,
    };
    if (index && index !== '?' && index !== '!') files.push({ ...base, staged: true });
    if ((working && working !== '!') || index === '?') files.push({ ...base, staged: false });
  }
  return files.sort((left, right) => left.path.localeCompare(right.path) || Number(right.staged) - Number(left.staged));
}

const STATUS_ICONS: Record<string, IconName> = {
  A: 'file-add',
  '?': 'file-add',
  D: 'delete-bin',
  M: 'file-edit',
  R: 'arrow-left-right',
};

function FileRow(props: { file: () => ChangedFile; selected: () => boolean; onPress: () => void }) {
  const status = () => (props.file().staged ? props.file().index : props.file().working) || 'M';
  return (
    <Button
      testID={`changes-file-${props.file().path}`}
      onPress={props.onPress}
      activeStyle={{ backgroundColor: alpha(colors.mutedForeground(), 0.08) }}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        paddingHorizontal: 10,
        paddingVertical: 8,
        borderRadius: 10,
        backgroundColor: props.selected() ? alpha(colors.foreground(), 0.08) : undefined,
      }}
    >
      <Icon name={STATUS_ICONS[status()] ?? 'file-text'} size={14} tone="muted" />
      <Text style={{ flexShrink: 1, fontSize: 13, color: colors.foreground(), numberOfLines: 1 }}>{props.file().path}</Text>
      <View style={{ flex: 1 }} />
      <If when={props.file().additions > 0}>
        <Text style={{ fontSize: 11, color: colors.success() }}>{`+${props.file().additions}`}</Text>
      </If>
      <If when={props.file().deletions > 0}>
        <Text style={{ fontSize: 11, color: colors.destructive() }}>{`−${props.file().deletions}`}</Text>
      </If>
    </Button>
  );
}

function DiffBody(props: { lines: () => DiffLine[] }) {
  return (
    <Scroll style={{ maxHeight: 320 }} scrollbar={false}>
      <View style={{ gap: 1 }}>
        <Each of={props.lines()} key={(line) => `${line.oldLine ?? 'x'}:${line.newLine ?? 'y'}:${line.text}`}>
          {(line) => (
            <View
              style={{
                flexDirection: 'row',
                gap: 6,
                paddingHorizontal: 6,
                paddingVertical: 1,
                backgroundColor:
                  line().kind === 'added'
                    ? alpha(colors.success(), 0.14)
                    : line().kind === 'removed'
                      ? alpha(colors.destructive(), 0.14)
                      : 'transparent',
              }}
            >
              <Text style={{ width: 30, fontSize: 10, color: colors.mutedForeground(), textAlign: 'right' }}>
                {line().kind === 'removed' ? String(line().oldLine ?? '') : String(line().newLine ?? '')}
              </Text>
              <Text style={{ flexShrink: 1, fontFamily: 'Menlo', fontSize: 11, lineHeight: 15, color: colors.foreground() }}>
                {`${line().kind === 'added' ? '+' : line().kind === 'removed' ? '-' : ' '}${line().text}`}
              </Text>
            </View>
          )}
        </Each>
      </View>
    </Scroll>
  );
}

/** Header menu «Changes»: workspace git status plus a read-only diff overview. */
export function ChangesSheet(props: { conversation: Conversation; open: () => boolean; close: () => void }) {
  const loading = signal(false);
  const error = signal('');
  const files = signal<ChangedFile[]>([]);
  const branch = signal('');
  const selected = signal('');
  const diff = signal<DiffLine[] | null>(null);
  const diffLoading = signal(false);
  const diffError = signal('');

  const refresh = async () => {
    if (loading()) return;
    loading.set(true);
    error.set('');
    try {
      const value = record(await sessionRequest(props.conversation, `/api/git/status?directory=${encodeURIComponent(props.conversation.directory())}`));
      files.set(changedFiles(value));
      branch.set(textOf(value.current));
    } catch (failure) {
      error.set(errorText(failure));
      files.set([]);
    } finally {
      loading.set(false);
    }
  };

  const select = async (file: ChangedFile) => {
    selected.set(`${file.staged ? 'staged' : 'working'}:${file.path}`);
    diff.set(null);
    diffError.set('');
    diffLoading.set(true);
    try {
      const query = `directory=${encodeURIComponent(props.conversation.directory())}&path=${encodeURIComponent(file.path)}${file.staged ? '&staged=true' : ''}`;
      const value = record(await sessionRequest(props.conversation, `/api/git/file-diff?${query}`));
      if (value.isBinary === true) throw new Error(t('chat.fileAttachment.fileFallback'));
      const before = textOf(value.original);
      const after = textOf(value.modified);
      if (!textOf(value.original) && !textOf(value.modified) && typeof value.original !== 'string') throw new Error(t('mobile.changes.diffDetail.loadFailed'));
      diff.set(diffLines(before, after));
    } catch (failure) {
      diffError.set(errorText(failure));
    } finally {
      diffLoading.set(false);
    }
  };

  effect(() => {
    if (!props.open()) return;
    untracked(() => void refresh());
  });

  const staged = () => files().filter((file) => file.staged);
  const working = () => files().filter((file) => !file.staged);

  const group = (title: string, rows: () => ChangedFile[]) => (
    <If when={rows().length > 0}>
      <View style={{ paddingTop: 6 }}>
        <Text style={{ fontSize: 11, fontWeight: '600', color: colors.mutedForeground(), paddingHorizontal: 10, paddingBottom: 2 }}>
          {title}
        </Text>
        <Each of={rows()} key={(file) => `${file.staged}:${file.path}`}>
          {(file) => (
            <FileRow
              file={file}
              selected={() => selected() === `${file().staged ? 'staged' : 'working'}:${file().path}`}
              onPress={() => void select(file())}
            />
          )}
        </Each>
      </View>
    </If>
  );

  return (
    <NativeSheet
      open={props.open()}
      closeOnSwipe
      onOpenChange={(event) => {
        if (!event.open) props.close();
      }}
      popupStyle={sheetPopup}
      backdropStyle={backdrop}
    >
      <View style={{ height: 620, paddingHorizontal: 12, paddingTop: 10, paddingBottom: 'env(safe-area-inset-bottom)' }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingBottom: 6 }}>
          <View style={{ flex: 1, gap: 1 }}>
            <Text style={{ fontSize: 17, fontWeight: '600', color: colors.foreground() }}>{t('mobile.menu.changes')}</Text>
            <If when={!!branch()}>
              <Text style={{ fontSize: 11, color: colors.mutedForeground(), numberOfLines: 1 }}>
                {`${t('mobile.header.metadata.branch')}: ${branch()}`}
              </Text>
            </If>
          </View>
          <If when={loading()}>
            <Spinner size={14} />
          </If>
          <Button testID="changes-refresh" onPress={() => void refresh()} style={{ width: 30, height: 30, alignItems: 'center', justifyContent: 'center' }}>
            <Icon name="refresh" size={15} tone="muted" />
          </Button>
          <Button onPress={props.close} style={{ width: 30, height: 30, alignItems: 'center', justifyContent: 'center' }}>
            <Icon name="close" size={16} tone="muted" />
          </Button>
        </View>
        <If when={!!error()}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 10, paddingVertical: 6 }}>
            <Text style={{ flexShrink: 1, fontSize: 12, color: colors.destructive() }}>{error()}</Text>
            <Button onPress={() => void refresh()} style={{ paddingHorizontal: 8, paddingVertical: 2 }}>
              <Text style={{ fontSize: 12, fontWeight: '600', color: colors.foreground() }}>{t('chat.history.retry')}</Text>
            </Button>
          </View>
        </If>
        <If
          when={files().length > 0}
          else={
            <If when={!loading() && !error()}>
              <EmptyState icon="git-branch" title={t('gitView.empty.cleanTitle')} description={t('mobile.changes.cleanDescription')} />
            </If>
          }
        >
          <Scroll class="flex-1" scrollbar={false} contentStyle={{ paddingBottom: 10 }}>
            <View style={{ borderRadius: radius.inset, overflow: 'hidden', backgroundColor: alpha(colors.muted(), 0.25), paddingVertical: 4 }}>
              {group(t('diffView.scope.staged'), staged)}
              {group(t('diffView.scope.changed'), working)}
            </View>
            <If when={!!selected()}>
              <View style={{ marginTop: 10, borderRadius: radius.inset, overflow: 'hidden', backgroundColor: alpha(colors.muted(), 0.25), padding: 8, gap: 6 }}>
                <Text style={{ fontSize: 11, fontWeight: '600', color: colors.mutedForeground(), numberOfLines: 1 }}>{selected()}</Text>
                <If when={diffLoading()}>
                  <View style={{ paddingVertical: 12, alignItems: 'center' }}>
                    <Spinner size={13} />
                  </View>
                </If>
                <If when={!!diffError()}>
                  <Text style={{ fontSize: 12, color: colors.destructive() }}>{diffError()}</Text>
                </If>
                <If when={!!diff()}>
                  <DiffBody lines={() => diff() ?? []} />
                </If>
              </View>
            </If>
          </Scroll>
        </If>
      </View>
    </NativeSheet>
  );
}
