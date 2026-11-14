import { Text, View, token } from 'nsh';
import { t } from '../core/i18n';
import { colors, space } from '../core/theme';
import { Icon, type IconName } from '../core/Icon';
import { Highlighted, alpha, fontSize } from '../core/ui';
import { showToast } from '../core/toast';

export type ProjectCardModel = {
  name: string;
  path?: string;
  icon?: IconName;
  /** Web `PROJECT_COLOR_MAP` key resolved to a tint by the caller. */
  tint?: string;
  count: number;
  partial?: boolean;
  activity?: string;
  active?: boolean;
  expanded: boolean;
  /** The Remote Host's display name: the machine tag sits after the project name. */
  host?: string;
  /** Why the machine tag shows a small exclamation (Web `RemoteHostErrorIndicator`). */
  hostProblem?: string;
};

/** Web `formatProjectPathHint`: a short parent/folder hint instead of the full path. */
export function pathHint(path: string): string {
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '');
  if (!normalized) return '';
  const segments = normalized.split('/').filter(Boolean);
  if (segments.length <= 1) return normalized;
  if (segments.length === 2) return segments[0] ?? '';
  return segments.slice(-3, -1).join('/');
}

export const sessionCountLabel = (count: number) =>
  count === 1 ? t('mobile.sessions.project.sessionsSingle') : t('mobile.sessions.project.sessionsPlural', { count });

/** The floating project capsule (Web `MobileProjectCard`); `model` is read as it changes. */
export function ProjectCard(props: {
  model: () => ProjectCardModel;
  highlight?: string;
  onToggle: () => void;
  onOpenActions?: () => void;
  /** A claimed drag owns the press, so the project menu's long press stands down. */
  canOpenActionsOnLongPress?: () => boolean;
  testID?: string;
}) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'stretch', minHeight: 74 }}>
      <View
        testID={props.testID}
        role="button"
        onPress={props.onToggle}
        onLongPress={() => {
          if (props.canOpenActionsOnLongPress?.() === false) return;
          props.onOpenActions?.();
        }}
        activeStyle={{ backgroundColor: alpha(colors.mutedForeground(), 0.08) }}
        style={{
          flex: 1,
          minHeight: 74,
          flexDirection: 'row',
          alignItems: 'center',
          gap: 7,
          paddingHorizontal: 10,
          paddingVertical: 10,
        }}
      >
        <View
          style={{
            width: space.projectIcon,
            height: space.projectIcon,
            borderRadius: space.projectIcon / 2,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: alpha(colors.muted(), 0.9),
            backdropFilter: 'blur(18px) saturate(1.3)',
            glassEffect: 'regular',
          }}
        >
          <Icon
            name={() => props.model().icon ?? 'code-box'}
            size={18}
            color={() => props.model().tint ?? colors.mutedForeground()}
          />
        </View>
        <View style={{ flex: 1, gap: 4 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <Highlighted
              value={() => props.model().name}
              query={props.highlight ? () => props.highlight ?? '' : undefined}
              style={{
                flexShrink: 1,
                fontSize: fontSize.entityTitle,
                lineHeight: 18,
                letterSpacing: -0.024,
                fontWeight: '600',
                color: colors.foreground(),
                numberOfLines: 1,
              }}
            />
            <If when={!!props.model().host}>
              <View
                role="button"
                accessibilityLabel={props.model().hostProblem ?? props.model().host ?? ''}
                onPress={() => {
                  if (props.model().hostProblem) showToast({ message: props.model().hostProblem ?? '' });
                }}
                style={{ flexDirection: 'row', alignItems: 'center', gap: 3, flexShrink: 1 }}
              >
                <Icon name="computer" size={12} tone="muted" />
                <Text style={{ fontSize: fontSize.entityMeta, color: colors.mutedForeground(), numberOfLines: 1 }}>
                  {props.model().host ?? ''}
                </Text>
                <If when={!!props.model().hostProblem}>
                  <Icon name="exclamation-fill" size={13} color={() => colors.destructive()} />
                </If>
              </View>
            </If>
            <If when={!!props.model().active}>
              <View
                style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: colors.success() }}
                accessibilityLabel={t('mobile.sessions.activeProjectAria')}
              />
            </If>
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
            <Text style={{ fontSize: fontSize.entityMeta, color: colors.mutedForeground() }}>
              {sessionCountLabel(props.model().count)}
              {props.model().partial ? '+' : ''}
            </Text>
            <If when={!!props.model().activity}>
              <Text style={{ fontSize: fontSize.entityMeta, color: alpha(colors.mutedForeground(), 0.5) }}>·</Text>
              <Text style={{ fontSize: fontSize.entityMeta, color: colors.mutedForeground() }}>{props.model().activity}</Text>
            </If>
            <If when={!!props.model().path}>
              <Text style={{ fontSize: fontSize.entityMeta, color: alpha(colors.mutedForeground(), 0.5) }}>·</Text>
              <Text style={{ fontSize: fontSize.entityMeta, color: colors.mutedForeground(), numberOfLines: 1 }}>
                {pathHint(props.model().path ?? '')}
              </Text>
            </If>
          </View>
        </View>
        <Icon name={props.model().expanded ? 'arrow-down-s' : 'arrow-right-s'} size={14} tone="muted" />
      </View>
      <If when={!!props.onOpenActions}>
        <View
          role="button"
          onPress={() => props.onOpenActions?.()}
          accessibilityLabel={t('sessions.sidebar.project.actions.projectMenu')}
          activeStyle={{ backgroundColor: alpha(colors.mutedForeground(), 0.1), borderRadius: 12 }}
          style={{ width: 34, height: 34, alignSelf: 'center', marginRight: 4, alignItems: 'center', justifyContent: 'center' }}
        >
          <Icon name="more-2" size={16} tone="muted" />
        </View>
      </If>
    </View>
  );
}

/** Web `PROJECT_ICONS`: the icon picker's keys and their sprite glyphs. */
export const PROJECT_ICON_OPTIONS: Array<{ key: string; icon: IconName; label: string }> = [
  { key: 'code', icon: 'code-box', label: 'Code' },
  { key: 'terminal', icon: 'terminal-box', label: 'Terminal' },
  { key: 'rocket', icon: 'rocket', label: 'Rocket' },
  { key: 'flask', icon: 'flask', label: 'Lab' },
  { key: 'gamepad', icon: 'gamepad', label: 'Game' },
  { key: 'briefcase', icon: 'briefcase', label: 'Work' },
  { key: 'home', icon: 'home', label: 'Home' },
  { key: 'globe', icon: 'global', label: 'Web' },
  { key: 'leaf', icon: 'leaf', label: 'Nature' },
  { key: 'shield', icon: 'shield', label: 'Security' },
  { key: 'palette', icon: 'palette', label: 'Design' },
  { key: 'server', icon: 'server', label: 'Server' },
  { key: 'phone', icon: 'smartphone', label: 'Mobile' },
  { key: 'database', icon: 'database-2', label: 'Data' },
  { key: 'lightbulb', icon: 'lightbulb', label: 'Idea' },
  { key: 'music', icon: 'music', label: 'Music' },
  { key: 'camera', icon: 'camera', label: 'Media' },
  { key: 'book', icon: 'book-open', label: 'Docs' },
  { key: 'heart', icon: 'heart', label: 'Favorite' },
];

export const PROJECT_ICON_MAP: Record<string, IconName> = Object.fromEntries(
  PROJECT_ICON_OPTIONS.map((option) => [option.key, option.icon]),
);

/** Web `PROJECT_COLORS`: syntax keys, with the phone theme's nearest tokens. */
export const PROJECT_COLOR_OPTIONS: Array<{ key: string; label: string; token: string }> = [
  { key: 'keyword', label: 'Purple', token: 'chart-1' },
  { key: 'string', label: 'Green', token: 'chart-2' },
  { key: 'number', label: 'Pink', token: 'chart-3' },
  { key: 'type', label: 'Gold', token: 'chart-4' },
  { key: 'constant', label: 'Cyan', token: 'chart-5' },
  { key: 'comment', label: 'Muted', token: 'muted-foreground' },
  { key: 'error', label: 'Red', token: 'destructive' },
  { key: 'primary', label: 'Blue', token: 'primary' },
  { key: 'success', label: 'Green', token: 'success' },
];

/** Resolved when read: design tokens are not available while modules load. */
export const projectTint = (key?: string): string | undefined => {
  const option = PROJECT_COLOR_OPTIONS.find((entry) => entry.key === key);
  return option ? String(token(option.token as Parameters<typeof token>[0])) : undefined;
};

export const projectGlyph = (key?: string): IconName =>
  (key ? PROJECT_ICON_MAP[key] : undefined) ?? 'code-box';
