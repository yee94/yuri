import { host, mount, Scroll, Text, View, type ViewStyle } from 'nsh';
import { ProjectsHome } from '../../projects';
import { app } from '../../state';
import { language } from '../../i18n';
import { projectsFixtureAdmission } from '../projects-fixture-admission';
import { installCapture, LayoutProbe, layoutEvent, layoutRef } from './probe';

const sample = (name: string) => ({ testID: name, ref: layoutRef(name), onLayout: (event: Parameters<typeof layoutEvent>[1]) => layoutEvent(name, event) });
function Box(props: { name: string; style?: ViewStyle; children?: import('nsh').JSX.Element }) {
  return <View {...sample(props.name)} style={props.style}><LayoutProbe name={props.name} />{props.children}</View>;
}
function Card(props: { name: string }) {
  return <Box name={props.name} style={{ height: 54, borderWidth: 1 }}><Text>{props.name}</Text></Box>;
}
function Minimal(props: { variant: 'original' | 'split' | 'content-padding' }) {
  const key = `minimal-${props.variant}`;
  return <Box name={`${key}-viewport`} style={{ height: 170 }}>
    <Scroll {...sample(`${key}-scroll`)} style={{ flex: 1 }} contentStyle={{ paddingBottom: 0, ...(props.variant === 'content-padding' ? { paddingHorizontal: 18 } : {}) }}>
      {props.variant === 'original' ? <Box name={`${key}-shell`} style={{ maxWidth: 452, width: '100%', alignSelf: 'center', paddingHorizontal: 18 }}><Card name={`${key}-card`} /></Box>
        : props.variant === 'split' ? <Box name={`${key}-shell`} style={{ maxWidth: 452, width: '100%', alignSelf: 'center' }}><Box name={`${key}-content`} style={{ paddingHorizontal: 18 }}><Card name={`${key}-card`} /></Box></Box>
          : <Box name={`${key}-content`} style={{ alignSelf: 'stretch' }}><Card name={`${key}-card`} /></Box>}
    </Scroll>
  </Box>;
}
function Fixture() {
  installCapture(); language.set('en');
  if (host.params.mode === 'minimal') return <View {...sample('minimal-root')} style={{ flex: 1 }}><LayoutProbe name="minimal-root" /><Minimal variant="original" /><Minimal variant="split" /><Minimal variant="content-padding" /></View>;
  const admission = projectsFixtureAdmission(() => app.projects.set([{ id: 'order-project', name: 'Synthetic Projects geometry', path: '/fixture/repo' }]));
  return <If when={admission.ready()} else={<Text>{admission.error() || 'Loading synthetic geometry'}</Text>}><View {...sample('production-parent')} style={{ flex: 1, paddingLeft: 'env(safe-area-inset-left)', paddingRight: 'env(safe-area-inset-right)' }}><LayoutProbe name="production-parent" /><ProjectsHome active={admission.active()} onOpenChat={() => {}} onOpenProject={() => {}} onOpenFiles={() => {}} onOpenChanges={() => {}} onAddProject={() => {}} onEditProject={() => {}} /></View></If>;
}
mount(Fixture);
