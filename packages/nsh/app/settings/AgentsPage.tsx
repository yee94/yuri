import { Scroll, Text, View } from 'nsh';
import { NavPage } from 'nsh/base';
import { t } from '../core/i18n';
import { colors, space } from '../core/theme';
import { QuietButton, Surface, fontSize } from '../core/ui';
import { agents, catalogError, catalogLoading, loadCatalog } from '../core/models';
import { tabBarInset } from '../shell/nav';
import { Empty, Group, Loading, Row } from './ui';

/** `/settings/agents`: the agents the connected instance exposes. */
export function AgentsPage() {
  if (agents().length === 0 && !catalogLoading()) void loadCatalog();

  return (
    <NavPage
      title={t('settings.page.agents.title')}
      headerBackTitle={t('mobile.settings.placeholder.title')}
      hidesBottomBarWhenPushed
      class="flex-1"
      style={{ backgroundColor: colors.background() }}
    >
      <Scroll class="flex-1" contentStyle={{ paddingBottom: tabBarInset() + 28 }}>
        <View
          style={{
            width: '100%',
            maxWidth: 452,
            alignSelf: 'center',
            paddingHorizontal: space.pageInset,
            gap: 20,
            paddingTop: 8,
          }}
        >
          <If when={!!catalogError()}>
            <Surface style={{ padding: 14, gap: 8 }}>
              <Text style={{ fontSize: 13, color: colors.destructive() }}>{catalogError()}</Text>
              <QuietButton label={() => t('assistants.actions.retry')} onPress={() => void loadCatalog(true)} />
            </Surface>
          </If>

          <Group label={t('settings.page.agents.title')}>
            <If when={catalogLoading() && agents().length === 0}>
              <Loading />
            </If>
            <If when={!catalogLoading() && agents().length === 0}>
              <Empty text={t('common.unavailable')} />
            </If>
            <Each of={agents()} key={(agent) => agent.name}>
              {(agent) => (
                <Row
                  testID={`agent-${agent().name}`}
                  label={() => agent().name}
                  description={() => agent().description}
                  value={() => agent().mode}
                  icon="node-tree"
                />
              )}
            </Each>
          </Group>
        </View>
      </Scroll>
    </NavPage>
  );
}
