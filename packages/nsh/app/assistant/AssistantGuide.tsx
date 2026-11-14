import { Image, Scroll, Text, View } from 'nsh';
import { Button } from 'nsh/base';
import { t } from '../core/i18n';
import { colors, radius, space } from '../core/theme';
import { alpha } from '../core/ui';
import guideHero from './assets/guide/assistant-guide-hero-wide.jpg';
import androidDirectShare from './assets/guide/android-direct-share.jpg';
import iosShareSheet from './assets/guide/ios-share-sheet.jpg';
import selectAssistant from './assets/guide/select-assistant.jpg';

const shareSteps = [
  { image: iosShareSheet, title: 'assistants.guide.share.ios.title', description: 'assistants.guide.share.ios.description' },
  { image: androidDirectShare, title: 'assistants.guide.share.android.title', description: 'assistants.guide.share.android.description' },
  { image: selectAssistant, title: 'assistants.guide.share.pick.title', description: 'assistants.guide.share.pick.description' },
] as const;

/** Web `MobileAssistantDisabledGuide`: the hero, the enable action and the share steps. */
export function AssistantGuide(props: { onEnable: () => void }) {
  return (
    <View style={{ width: '100%', gap: 20, paddingTop: 4, paddingBottom: 24 }}>
      <View
        style={{
          width: '100%',
          maxWidth: 296,
          aspectRatio: 16 / 9,
          alignSelf: 'center',
          overflow: 'hidden',
          borderRadius: radius.inset,
          backgroundColor: colors.muted(),
        }}
      >
        <Image src={guideHero} style={{ width: '100%', height: '100%' }} />
      </View>

      <View style={{ alignItems: 'center', gap: 8, paddingHorizontal: 12 }}>
        <Text
          style={{
            maxWidth: 288,
            fontSize: 20,
            fontWeight: '600',
            lineHeight: 25,
            letterSpacing: -0.6,
            color: colors.foreground(),
            textAlign: 'center',
          }}
        >
          {t('assistants.guide.disabledTitle')}
        </Text>
        <Text
          style={{
            maxWidth: 288,
            fontSize: 13,
            lineHeight: 19,
            color: colors.mutedForeground(),
            textAlign: 'center',
          }}
        >
          {t('assistants.guide.disabledDescription')}
        </Text>
        <View style={{ marginTop: 12 }}>
          <Button
            testID="assistants-enable"
            onPress={props.onEnable}
            style={{
              minHeight: 44,
              paddingHorizontal: 20,
              borderRadius: 22,
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: colors.foreground(),
            }}
          >
            <Text style={{ fontSize: 15, fontWeight: '600', color: colors.background() }}>
              {t('assistants.guide.enableAction')}
            </Text>
          </Button>
        </View>
      </View>

      <View style={{ width: '100%' }}>
        <Text
          style={{
            paddingHorizontal: 12,
            fontSize: 13,
            fontWeight: '600',
            lineHeight: 17,
            color: colors.mutedForeground(),
          }}
        >
          {t('assistants.guide.shareTitle')}
        </Text>
        <Scroll
          horizontal
          scrollbar={false}
          contentStyle={{ gap: 12, paddingHorizontal: 12, paddingTop: 12, paddingBottom: 2 }}
        >
          <Each of={shareSteps} key="index">
            {(step) => (
              <View
                style={{
                  width: 248,
                  maxWidth: 248,
                  flexShrink: 0,
                  overflow: 'hidden',
                  borderRadius: radius.inset,
                  backgroundColor: alpha(colors.muted(), 0.9),
                }}
              >
                <View style={{ height: 132, overflow: 'hidden', backgroundColor: colors.muted() }}>
                  <Image src={step().image} style={{ width: '100%', height: '100%' }} />
                </View>
                <View style={{ paddingTop: 12, paddingHorizontal: 14, paddingBottom: 14 }}>
                  <Text style={{ fontSize: 13, fontWeight: '600', lineHeight: 16, color: colors.foreground() }}>
                    {t(step().title)}
                  </Text>
                  <Text style={{ marginTop: 4, fontSize: 12, lineHeight: 17, color: colors.mutedForeground() }}>
                    {t(step().description)}
                  </Text>
                </View>
              </View>
            )}
          </Each>
        </Scroll>
      </View>
    </View>
  );
}

/** Web `MobileAssistantSkeleton`: the floating card's placeholder lines while the catalog loads. */
export function AssistantSkeleton() {
  const bar = { backgroundColor: alpha(colors.mutedForeground(), 0.14) } as const;
  return (
    <View
      testID="assistants-loading"
      accessibilityLabel={t('common.loading')}
      style={{ padding: 20, gap: 12, borderRadius: 24, backgroundColor: alpha(colors.card(), 0.88) }}
    >
      <View style={[{ width: 40, height: 40, borderRadius: 12 }, bar]} />
      <View style={[{ marginTop: 8, width: '66%', height: 16, borderRadius: 6 }, bar]} />
      <View style={[{ width: '100%', height: 14, borderRadius: 6 }, bar]} />
      <View style={[{ width: '80%', height: 14, borderRadius: 6 }, bar]} />
    </View>
  );
}
