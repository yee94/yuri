import { platform, safeArea, token, Text, View } from 'nsh';
import { TabBar } from 'nsh/mobile';
import { Button } from 'nsh/base';
import { Icon } from './Icon';
import { glassEdge } from './glass-surface';

export interface NativeTabItem { title: string; icon: string; glyph: Parameters<typeof Icon>[0]['name'] }

/** iOS keeps the system TabBar (Liquid Glass); elsewhere a floating glass pill with edge, shadow and highlight. */
export function NativeTabBar(props: { testID?: string; items: NativeTabItem[]; selectedIndex: number; onChange: (index: number) => void; onHeight: (height: number) => void }) {
  if (platform.os === 'ios') {
    return <TabBar testID={props.testID}
      style={{ position: 'absolute', left: 0, right: 0, bottom: 0, backgroundColor: 'transparent' }}
      onLayout={event => props.onHeight(event.bounds.size.height)}
      selectedIndex={props.selectedIndex} onChange={e => props.onChange(e.index)}
      items={props.items.map(item => ({ title: item.title, icon: item.icon }))} />;
  }
  return <View testID={props.testID} style={{ position: 'absolute', left: 0, right: 0, bottom: 0, paddingLeft: 16, paddingRight: 16, paddingTop: 8, paddingBottom: safeArea().bottom + 8, pointerEvents: 'box-none' }}
    onLayout={event => props.onHeight(event.bounds.size.height)}>
    <View class="flex-row items-center" style={{ height: 64, borderRadius: 32, padding: 6, glassEffect: 'regular', backdropFilter: 'blur(24px) saturate(1.25)', ...glassEdge() }}>
      {props.items.map((item, index) => {
        const selected = () => index === props.selectedIndex;
        return <Button class="flex-1 items-center justify-center" accessibilityLabel={item.title} role="tab" selected={selected()}
          style={{ flexBasis: 0, flexGrow: 1, flexShrink: 1, minWidth: 0, height: 52, borderRadius: 26, gap: 2, ...(selected() ? glassEdge() : {}), backgroundColor: selected() ? token('accent') : 'transparent', borderWidth: 0.5, borderColor: selected() ? glassEdge().borderColor : 'transparent', boxShadow: selected() ? glassEdge().boxShadow : 'none' }}
          onPress={() => props.onChange(index)}>
          <View style={{ opacity: selected() ? 1 : 0.55 }}><Icon name={item.glyph} size={22} color={String(token('foreground'))} /></View>
          <Text style={{ fontSize: 11, lineHeight: 13, fontWeight: selected() ? '600' : '500', color: token('foreground'), opacity: selected() ? 1 : 0.55 }}>{item.title}</Text>
        </Button>;
      })}
    </View>
  </View>;
}
