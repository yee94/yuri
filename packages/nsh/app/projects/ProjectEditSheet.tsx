import { Scroll, Text, View, effect, signal, untracked } from 'nsh';
import { Button, Input, Sheet } from 'nsh/base';
import { t } from '../core/i18n';
import { colors } from '../core/theme';
import { Icon } from '../core/Icon';
import { PrimaryButton, alpha } from '../core/ui';
import {
  PROJECT_COLOR_OPTIONS,
  PROJECT_ICON_OPTIONS,
  projectTint,
  type ProjectCardModel,
} from './ProjectCard';
import type { ProjectItem } from './model';

const sheetPopup = {
  backgroundColor: colors.background(),
  borderTopLeftRadius: 26,
  borderTopRightRadius: 26,
  maxHeight: '88%',
} as const;
const backdrop = { backgroundColor: alpha('#000000', 0.32) } as const;
const body = { padding: 18, gap: 16, paddingBottom: 'env(safe-area-inset-bottom)' } as const;
const field = {
  minHeight: 48,
  borderRadius: 12,
  paddingHorizontal: 12,
  fontSize: 16,
  color: colors.foreground(),
  backgroundColor: colors.muted(),
  placeholderColor: colors.mutedForeground(),
} as const;
const label = { fontSize: 13, fontWeight: '600', color: colors.foreground() } as const;

/** Web `ProjectEditDialog`'s identity fields: name, `PROJECT_ICONS`, `PROJECT_COLORS`. */
export function ProjectEditSheet(props: {
  project: () => ProjectItem | null;
  busy: () => boolean;
  onClose: () => void;
  onSave: (meta: { label: string; icon: string | null; color: string | null }) => void;
}) {
  const name = signal('');
  const icon = signal<string | null>(null);
  const color = signal<string | null>(null);

  effect(() => {
    const project = props.project();
    untracked(() => {
      if (!project) return;
      name.set(project.name);
      icon.set(project.icon ?? null);
      color.set(project.color ?? null);
    });
  });

  const preview = (): ProjectCardModel => ({
    name: name().trim() || props.project()?.name || '',
    count: props.project()?.sessionCount ?? 0,
    expanded: true,
    ...(icon() ? { icon: PROJECT_ICON_OPTIONS.find((entry) => entry.key === icon())?.icon } : {}),
    ...(color() ? { tint: projectTint(color() ?? undefined) } : {}),
  });

  return (
    <Sheet
      open={!!props.project()}
      closeOnSwipe={!props.busy()}
      onOpenChange={(event) => {
        if (!event.open && !props.busy()) props.onClose();
      }}
      popupStyle={sheetPopup}
      backdropStyle={backdrop}
    >
      <View>
        <View style={{ paddingHorizontal: 18, paddingTop: 16, gap: 12 }}>
          <Text style={{ fontSize: 18, fontWeight: '600', color: colors.foreground() }}>
            {t('projectEditDialog.title')}
          </Text>
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: 10,
              padding: 12,
              borderRadius: 14,
              backgroundColor: alpha(colors.muted(), 0.7),
            }}
          >
            <View
              style={{
                width: 38,
                height: 38,
                borderRadius: 19,
                alignItems: 'center',
                justifyContent: 'center',
                backgroundColor: alpha(colors.background(), 0.8),
              }}
            >
              <Icon
                name={() => preview().icon ?? 'code-box'}
                size={18}
                color={() => preview().tint ?? colors.mutedForeground()}
              />
            </View>
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={{ fontSize: 14, fontWeight: '600', color: colors.foreground(), numberOfLines: 1 }}>
                {preview().name}
              </Text>
              <Text style={{ fontSize: 12, color: colors.mutedForeground(), numberOfLines: 1 }}>
                {props.project()?.path ?? ''}
              </Text>
            </View>
          </View>
        </View>
        <Scroll style={{ maxHeight: 460 }} keyboardShouldPersistTaps="handled" contentStyle={body}>
          <View style={{ gap: 6 }}>
            <Text style={label}>{t('projectEditDialog.field.name')}</Text>
            <Input
              testID="project-name-input"
              value={name()}
              onChange={(event) => name.set(event.value)}
              autoCapitalize="none"
              autoCorrect={false}
              style={field}
            />
          </View>

          <View style={{ gap: 8 }}>
            <Text style={label}>{t('projectEditDialog.field.icon')}</Text>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
              <Each of={PROJECT_ICON_OPTIONS} key={(entry) => entry.key}>
                {(entry) => (
                  <Button
                    testID={`project-icon-${entry().key}`}
                    onPress={() => icon.set(icon() === entry().key ? null : entry().key)}
                    accessibilityLabel={entry().label}
                    style={{
                      width: 40,
                      height: 40,
                      borderRadius: 12,
                      alignItems: 'center',
                      justifyContent: 'center',
                      backgroundColor: icon() === entry().key ? colors.foreground() : alpha(colors.muted(), 0.9),
                    }}
                  >
                    <Icon
                      name={entry().icon}
                      size={17}
                      color={() => (icon() === entry().key ? colors.background() : colors.mutedForeground())}
                    />
                  </Button>
                )}
              </Each>
            </View>
          </View>

          <View style={{ gap: 8 }}>
            <Text style={label}>{t('projectEditDialog.field.color')}</Text>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
              <Each of={PROJECT_COLOR_OPTIONS} key={(entry) => entry.key}>
                {(entry) => (
                  <Button
                    testID={`project-color-${entry().key}`}
                    onPress={() => color.set(color() === entry().key ? null : entry().key)}
                    accessibilityLabel={entry().label}
                    style={{
                      width: 40,
                      height: 40,
                      borderRadius: 20,
                      alignItems: 'center',
                      justifyContent: 'center',
                      borderWidth: 2,
                      borderColor: color() === entry().key ? colors.foreground() : 'transparent',
                    }}
                  >
                    <View
                      style={{
                        width: 22,
                        height: 22,
                        borderRadius: 11,
                        backgroundColor: projectTint(entry().key) ?? colors.mutedForeground(),
                      }}
                    />
                  </Button>
                )}
              </Each>
            </View>
          </View>

          <PrimaryButton
            label={() => t('projectEditDialog.actions.save')}
            disabled={() => !name().trim() || props.busy()}
            busy={props.busy}
            onPress={() => props.onSave({ label: name().trim(), icon: icon(), color: color() })}
          />
          <Button onPress={props.onClose} style={{ minHeight: 44, alignItems: 'center', justifyContent: 'center' }}>
            <Text style={{ fontSize: 15, color: colors.mutedForeground() }}>{t('projectEditDialog.actions.cancel')}</Text>
          </Button>
        </Scroll>
      </View>
    </Sheet>
  );
}
