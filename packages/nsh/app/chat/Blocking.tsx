import { Text, View, signal, type Signal } from 'nsh';
import { Button, Input } from 'nsh/base';
import { t } from '../core/i18n';
import { colors, radius, statusColor } from '../core/theme';
import { Icon, type IconName } from '../core/Icon';
import { Spinner, alpha } from '../core/ui';
import { cancelForm, questionFor, replyForm, replyPermission, type Conversation } from './store';
import type { Row } from '../core/host';

const textOf = (value: unknown) => (typeof value === 'string' ? value : '');

type Draft = { selected: string[][]; custom: string[]; active: number };

const drafts = new Map<string, { draft: Signal<Draft>; responding: Signal<boolean> }>();

function draftFor(formID: string, count: number) {
  const existing = drafts.get(formID);
  if (existing) return existing;
  const created: { draft: Signal<Draft>; responding: Signal<boolean> } = {
    draft: signal<Draft>({ selected: Array.from({ length: count }, () => []), custom: Array.from({ length: count }, () => ''), active: 0 }),
    responding: signal<boolean>(false),
  };
  drafts.set(formID, created);
  return created;
}

const cardStyle = {
  marginHorizontal: 16,
  marginTop: 8,
  borderRadius: radius.inset,
  borderWidth: 0.5,
  borderColor: alpha(colors.border(), 0.6),
  backgroundColor: alpha(colors.muted(), 0.22),
  overflow: 'hidden',
} as const;

const headerStyle = {
  flexDirection: 'row',
  alignItems: 'center',
  gap: 6,
  paddingHorizontal: 12,
  paddingVertical: 8,
  borderBottomWidth: 0.5,
  borderBottomColor: alpha(colors.border(), 0.4),
} as const;

const bodyStyle = { paddingHorizontal: 12, paddingVertical: 10, gap: 8 } as const;

const footerStyle = {
  flexDirection: 'row',
  alignItems: 'center',
  flexWrap: 'wrap',
  gap: 6,
  paddingHorizontal: 12,
  paddingVertical: 8,
  borderTopWidth: 0.5,
  borderTopColor: alpha(colors.border(), 0.4),
} as const;

const toolIcon = (name: string): IconName => {
  const tool = name.toLowerCase();
  if (['edit', 'multiedit', 'str_replace_based_edit_tool'].includes(tool)) return 'pencil-ai';
  if (['write', 'create', 'file_write'].includes(tool)) return 'file-edit';
  if (['bash', 'shell', 'cmd', 'terminal', 'shell_command'].includes(tool)) return 'terminal-box';
  if (['webfetch', 'fetch', 'curl', 'wget'].includes(tool)) return 'global';
  return 'tools';
};

const toolLabel = (name: string): string => {
  const tool = name.toLowerCase();
  if (['edit', 'multiedit', 'str_replace_based_edit_tool'].includes(tool)) return 'edit';
  if (['write', 'create', 'file_write'].includes(tool)) return 'write';
  if (['bash', 'shell', 'cmd', 'terminal', 'shell_command'].includes(tool)) return 'bash';
  if (['webfetch', 'fetch', 'curl', 'wget'].includes(tool)) return 'webfetch';
  return name;
};

function Detail(props: { permission: () => Row }) {
  const metadata = () => (props.permission().metadata ?? {}) as Record<string, unknown>;
  const command = () => textOf(metadata().command) || textOf(metadata().cmd) || textOf(metadata().script);
  const filePath = () =>
    textOf(metadata().path) || textOf(metadata().file_path) || textOf(metadata().filename) || textOf(metadata().filePath);
  const url = () => textOf(metadata().url) || textOf(metadata().uri);
  const others = () =>
    Object.entries(metadata())
      .filter(([key, value]) => !['always', 'command', 'cmd', 'script', 'path', 'file_path', 'filename', 'filePath', 'url', 'uri'].includes(key) && typeof value !== 'object')
      .map(([key, value]) => `${key}: ${String(value)}`);
  return (
    <View style={{ gap: 6 }}>
      <If when={!!command()}>
        <View style={{ borderRadius: 8, padding: 8, backgroundColor: alpha(colors.muted(), 0.5) }}>
          <Text style={{ fontFamily: 'Menlo', fontSize: 12, lineHeight: 17, color: colors.foreground() }}>{command()}</Text>
        </View>
      </If>
      <If when={!!filePath()}>
        <Text style={{ fontSize: 12, color: colors.mutedForeground(), numberOfLines: 2 }}>{filePath()}</Text>
      </If>
      <If when={!!url()}>
        <Text style={{ fontSize: 12, color: colors.mutedForeground(), numberOfLines: 2 }}>{url()}</Text>
      </If>
      <If when={others().length > 0}>
        <View style={{ gap: 2 }}>
          <Each of={others()} key="index">
            {(line) => <Text style={{ fontSize: 11, color: colors.mutedForeground() }}>{line()}</Text>}
          </Each>
        </View>
      </If>
    </View>
  );
}

function PermissionCard(props: { conversation: Conversation; permission: () => Row }) {
  const responding = signal(false);
  const tool = () => textOf(props.permission().permission) || textOf(props.permission().action) || 'unknown';
  const patterns = (): string[] => {
    const value = props.permission().patterns;
    return (Array.isArray(value) ? value : []).map((entry) => textOf(entry)).filter(Boolean);
  };
  const respond = async (decision: 'once' | 'always' | 'reject') => {
    if (responding()) return;
    responding.set(true);
    try {
      await replyPermission(props.conversation, textOf(props.permission().id), decision);
    } finally {
      responding.set(false);
    }
  };
  return (
    <View style={cardStyle} testID={`permission-${textOf(props.permission().id)}`}>
      <View style={headerStyle}>
        <Icon name="question" size={13} color={() => statusColor('warning')} />
        <Text style={{ flex: 1, fontSize: 12, fontWeight: '500', color: colors.mutedForeground(), numberOfLines: 1 }}>
          {t('sessions.sidebar.session.status.permissionRequired')}
        </Text>
        <Icon name={toolIcon(tool())} size={13} tone="muted" />
        <Text style={{ fontSize: 12, color: colors.mutedForeground(), numberOfLines: 1 }}>{toolLabel(tool())}</Text>
      </View>
      <View style={bodyStyle}>
        <If when={patterns().length > 0}>
          <Text style={{ fontSize: 11, color: colors.mutedForeground() }}>{t('chat.permissionCard.patterns')}</Text>
          <View style={{ borderRadius: 8, overflow: 'hidden', backgroundColor: alpha(colors.muted(), 0.4) }}>
            <Each of={patterns()} key="index">
              {(pattern) => (
                <Text
                  style={{
                    fontFamily: 'Menlo',
                    fontSize: 11,
                    lineHeight: 16,
                    paddingHorizontal: 8,
                    paddingVertical: 5,
                    color: colors.foreground(),
                  }}
                >
                  {pattern()}
                </Text>
              )}
            </Each>
          </View>
        </If>
        <Detail permission={props.permission} />
      </View>
      <View style={footerStyle}>
        <Button
          testID="permission-allow-once"
          disabled={responding()}
          onPress={() => void respond('once')}
          style={{ flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 8, paddingVertical: 6 }}
        >
          <Icon name="check" size={13} color={() => statusColor('success')} />
          <Text style={{ fontSize: 12, color: colors.foreground() }}>{t('chat.permissionCard.allowOnce')}</Text>
        </Button>
        <Button
          testID="permission-allow-always"
          disabled={responding()}
          onPress={() => void respond('always')}
          style={{ flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 8, paddingVertical: 6 }}
        >
          <Icon name="arrow-right" size={13} color={() => statusColor('success')} />
          <Text style={{ fontSize: 12, color: colors.foreground() }}>{t('chat.permissionCard.alwaysAgree')}</Text>
        </Button>
        <Button
          testID="permission-reject"
          disabled={responding()}
          onPress={() => void respond('reject')}
          style={{ flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 8, paddingVertical: 6 }}
        >
          <Icon name="close" size={13} color={() => colors.destructive()} />
          <Text style={{ fontSize: 12, color: colors.destructive() }}>{t('chat.permissionToast.actions.deny')}</Text>
        </Button>
        <If when={responding()}>
          <Spinner size={12} />
        </If>
      </View>
    </View>
  );
}

function QuestionCard(props: { conversation: Conversation; form: () => Row }) {
  const formID = () => textOf(props.form().id);
  const question = () => questionFor(props.form());
  const state = draftFor(formID(), question().questions.length);
  const questions = () => question().questions;
  const active = () => Math.min(Math.max(state.draft().active, 0), Math.max(questions().length - 1, 0));
  const current = () => questions()[active()];
  const selected = () => state.draft().selected[active()] ?? [];
  const custom = () => state.draft().custom[active()] ?? '';
  const update = (next: Partial<Draft>) => {
    const currentDraft = state.draft();
    state.draft.set({
      selected: next.selected ?? currentDraft.selected,
      custom: next.custom ?? currentDraft.custom,
      active: next.active ?? currentDraft.active,
    });
  };
  const toggle = (label: string) => {
    const multiple = !!current()?.multiple;
    const list = selected();
    const next = multiple
      ? list.includes(label)
        ? list.filter((value) => value !== label)
        : [...list, label]
      : list.includes(label)
        ? []
        : [label];
    const selectedAll = [...state.draft().selected];
    selectedAll[active()] = next;
    update({ selected: selectedAll });
  };
  const setCustom = (value: string) => {
    const all = [...state.draft().custom];
    all[active()] = value;
    update({ custom: all });
  };
  const answers = () =>
    questions().map((entry, index) => {
      const typed = (state.draft().custom[index] ?? '').trim();
      if (typed) return [typed];
      return state.draft().selected[index] ?? [];
    });
  const complete = () => answers().every((list) => list.length > 0);
  const submit = async () => {
    if (!complete() || state.responding()) return;
    state.responding.set(true);
    try {
      await replyForm(props.conversation, props.form(), answers());
    } finally {
      state.responding.set(false);
    }
  };
  const dismiss = async () => {
    if (state.responding()) return;
    state.responding.set(true);
    try {
      await cancelForm(props.conversation, formID());
    } finally {
      state.responding.set(false);
    }
  };
  return (
    <View style={cardStyle} testID={`question-${formID()}`}>
      <View style={headerStyle}>
        <Icon name="question" size={13} color={() => statusColor('warning')} />
        <Text style={{ flex: 1, fontSize: 12, fontWeight: '500', color: colors.mutedForeground(), numberOfLines: 1 }}>
          {t('chat.questionCard.inputNeeded')}
        </Text>
        <If when={questions().length > 1}>
          <Text style={{ fontSize: 11, color: colors.mutedForeground() }}>
            {active() + 1}/{questions().length}
          </Text>
        </If>
      </View>
      <If when={questions().length > 1}>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, paddingHorizontal: 12, paddingTop: 8 }}>
          <Each of={questions()} key="index">
            {(entry, index) => (
              <Button
                onPress={() => update({ active: index() })}
                style={{
                  paddingHorizontal: 9,
                  paddingVertical: 4,
                  borderRadius: 12,
                  backgroundColor: index() === active() ? alpha(colors.foreground(), 0.12) : alpha(colors.muted(), 0.5),
                }}
              >
                <Text style={{ fontSize: 12, color: colors.foreground(), numberOfLines: 1 }}>
                  {textOf(entry().header) || textOf(entry().question) || t('chat.questionCard.questionFallback', { index: index() + 1 })}
                </Text>
              </Button>
            )}
          </Each>
        </View>
      </If>
      <View style={bodyStyle}>
        <Text style={{ fontSize: 13, fontWeight: '500', color: colors.foreground() }}>
          {textOf(current()?.question)}
        </Text>
        <If when={!!current()?.multiple}>
          <Text style={{ fontSize: 11, color: colors.mutedForeground() }}>{t('chat.questionCard.selectMultiple')}</Text>
        </If>
        <Each of={current()?.options ?? []} key="index">
          {(option) => {
            const label = textOf(option().label);
            const isSelected = () => selected().includes(label);
            const recommended = () => /\(recommended\)/i.test(label);
            return (
              <Button
                onPress={() => toggle(label)}
                disabled={state.responding()}
                activeStyle={{ backgroundColor: alpha(colors.mutedForeground(), 0.1) }}
                style={{
                  flexDirection: 'row',
                  alignItems: 'flex-start',
                  gap: 8,
                  paddingHorizontal: 8,
                  paddingVertical: 7,
                  borderRadius: 8,
                  backgroundColor: isSelected() ? alpha(colors.foreground(), 0.08) : undefined,
                }}
              >
                <View style={{ marginTop: 1 }}>
                  <If
                    when={!!current()?.multiple}
                    else={
                      <View
                        style={{
                          width: 16,
                          height: 16,
                          borderRadius: 8,
                          borderWidth: 1,
                          borderColor: colors.border(),
                          alignItems: 'center',
                          justifyContent: 'center',
                          backgroundColor: colors.background(),
                        }}
                      >
                        <If when={isSelected()}>
                          <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: colors.foreground() }} />
                        </If>
                      </View>
                    }
                  >
                    <View
                      style={{
                        width: 16,
                        height: 16,
                        borderRadius: 4,
                        borderWidth: 1,
                        borderColor: isSelected() ? colors.foreground() : colors.border(),
                        alignItems: 'center',
                        justifyContent: 'center',
                        backgroundColor: isSelected() ? colors.foreground() : colors.background(),
                      }}
                    >
                      <If when={isSelected()}>
                        <Icon name="check" size={11} color={() => colors.background()} />
                      </If>
                    </View>
                  </If>
                </View>
                <View style={{ flex: 1, gap: 2 }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                    <Text style={{ fontSize: 13, color: colors.foreground(), fontWeight: isSelected() ? '600' : '400' }}>
                      {label}
                    </Text>
                    <If when={recommended()}>
                      <Text style={{ fontSize: 10, color: colors.mutedForeground() }}>{t('chat.questionCard.recommended')}</Text>
                    </If>
                  </View>
                  <If when={!!textOf(option().description)}>
                    <Text style={{ fontSize: 11, color: colors.mutedForeground() }}>{textOf(option().description)}</Text>
                  </If>
                </View>
              </Button>
            );
          }}
        </Each>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 2 }}>
          <Icon name="edit" size={13} tone="muted" />
          <Text style={{ fontSize: 12, color: colors.mutedForeground() }}>{t('chat.questionCard.other')}</Text>
        </View>
        <Input
          value={custom()}
          onChange={(event) => setCustom(event.value)}
          placeholder={t('chat.questionCard.yourAnswer')}
          multiline
          style={{
            minHeight: 40,
            borderRadius: 10,
            paddingHorizontal: 10,
            paddingVertical: 8,
            fontSize: 13,
            color: colors.foreground(),
            backgroundColor: alpha(colors.muted(), 0.5),
            placeholderColor: colors.mutedForeground(),
          }}
        />
      </View>
      <View style={footerStyle}>
        <Button
          testID="question-submit"
          disabled={!complete() || state.responding()}
          onPress={() => void submit()}
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: 5,
            paddingHorizontal: 10,
            paddingVertical: 6,
            borderRadius: 14,
            backgroundColor: complete() ? colors.foreground() : alpha(colors.muted(), 0.8),
          }}
        >
          <Text style={{ fontSize: 12, fontWeight: '600', color: complete() ? colors.background() : colors.mutedForeground() }}>
            {t('chat.questionCard.submit')}
          </Text>
        </Button>
        <Button onPress={() => void dismiss()} disabled={state.responding()} style={{ paddingHorizontal: 8, paddingVertical: 6 }}>
          <Text style={{ fontSize: 12, color: colors.mutedForeground() }}>{t('chat.questionCard.dismiss')}</Text>
        </Button>
        <If when={state.responding()}>
          <Spinner size={12} />
        </If>
      </View>
    </View>
  );
}

/** Permission requests and question forms waiting on this session. */
export function BlockingCards(props: { conversation: Conversation }) {
  const permissions = () => props.conversation.permissions();
  const forms = () => props.conversation.forms();
  return (
    <View>
      <Each of={permissions()} key={(row) => `p:${textOf(row.id)}`}>
        {(permission) => <PermissionCard conversation={props.conversation} permission={permission} />}
      </Each>
      <Each of={forms()} key={(row) => `f:${textOf(row.id)}`}>
        {(form) => <QuestionCard conversation={props.conversation} form={form} />}
      </Each>
    </View>
  );
}
