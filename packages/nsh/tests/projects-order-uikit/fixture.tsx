import { host, mount, Scroll, signal, Text, View } from 'nsh';
import { Button, createNavStack, NavPage, NavStack } from 'nsh/base';
import { language } from '../../i18n';
import { list, record, text, type Project, type Row } from '../../model';
import { ProjectsHome, ProjectDetail } from '../../projects';
import { native } from '../../runtime';
import { app } from '../../state';
import type { ProjectsOrderGesturePhase } from '../../projects-order-gesture';
import { projectsFixtureAdmission } from '../projects-fixture-admission';

if (host.params.projectsOrderUIKitFixture !== true) throw new Error('Requires the isolated Projects UIKit Host');
const projects: Project[] = list(host.params.projects).map(row => ({ id: text(row.id), name: text(row.name), path: text(row.path) }));
if (projects.length !== 1 || !projects[0]?.path || !projects[0]?.id) throw new Error('Invalid Projects fixture seed');
language.set('en');
type Route = { kind: 'root' } | { kind: 'home' } | { kind: 'detail'; project: Project } | { kind: 'audit' };
const nav = createNavStack<Route>([{ kind: 'root' }]), error = signal(''), opened = signal('');
const gestureAudit = signal<{ counts: Partial<Record<ProjectsOrderGesturePhase, number>>; recent: ProjectsOrderGesturePhase[] }>({ counts: {}, recent: [] });
const inspectGesture = (phase: ProjectsOrderGesturePhase) => { const previous = gestureAudit(); gestureAudit.set({ counts: { ...previous.counts, [phase]: (previous.counts[phase] ?? 0) + 1 }, recent: [...previous.recent.slice(-31), phase] }); };
function Audit() {
  const snapshot = signal<Row>({});
  const inspect = () => { void native('fixture.projectsOrder.audit').then(value => snapshot.set(record(value))).catch(failure => error.set(String(failure))); };
  inspect();
  return <NavPage title="Synthetic order audit" headerBackTitle="" class="flex-1 bg-background"><View class="flex-1 p-4 gap-3">
    <Button testID="projects-order-uikit-audit-refresh" onPress={inspect}><Text>Refresh read-only audit</Text></Button>
    <Scroll class="flex-1" contentClass="gap-3 pb-8"><Each of={['sessionOrderWrites', 'worktreeOrderWrites', 'requests', 'reads', 'rejected', 'auditReads']}>{key => <Text testID={`projects-order-uikit-count-${key()}`} accessibilityLabel={`${key()}:${String(snapshot()[key()] ?? 'loading')}`} class="text-foreground">{`${key()}:${String(snapshot()[key()] ?? 'loading')}`}</Text>}</Each>
      <Each of={['orders', 'treePaths', 'activities', 'journal']}>{key => <Text testID={`projects-order-uikit-${key()}`} accessibilityLabel={JSON.stringify(snapshot()[key()] ?? null)} class="text-foreground" style={{ fontSize: 11 }}>{`${key()}: ${JSON.stringify(snapshot()[key()] ?? null)}`}</Text>}</Each>
      <Text testID="projects-order-uikit-gesture-audit" accessibilityLabel={JSON.stringify(gestureAudit())} class="text-foreground" style={{ fontSize: 11 }}>{JSON.stringify(gestureAudit())}</Text>
    </Scroll>
  </View></NavPage>;
}
function Fixture() {
  const admission = projectsFixtureAdmission(() => app.projects.set(projects));
  const audit = () => nav.push({ kind: 'audit' });
  const callbacks = { onOpenChat: (target: { id: string }) => opened.set(`Opened ${target.id}`), onOpenFiles: () => {}, onOpenChanges: () => {}, onEditProject: () => {}, onNewSession: () => error.set('Session creation disabled in this ordering fixture') };
  return <If when={admission.ready()} else={<Text testID="projects-order-uikit-admission">{admission.error() || error() || 'Loading synthetic connection snapshot'}</Text>}><NavStack state={nav} class="flex-1">{route => {
    if (route.kind === 'audit') return <Audit />;
    if (route.kind === 'home') return <NavPage title="Projects home" headerBackTitle="" class="flex-1 bg-background" headerRight={<Button testID="projects-order-uikit-audit" onPress={audit}><Text>Audit</Text></Button>}><ProjectsHome {...callbacks} active={admission.active() && nav.routes().at(-1) === route} onOpenProject={project => nav.push({ kind: 'detail', project })} onAddProject={() => {}} /><Text testID="projects-order-uikit-opened">{opened()}</Text></NavPage>;
    if (route.kind === 'detail') return <ProjectDetail {...callbacks} active={admission.active() && nav.routes().at(-1) === route} project={route.project} onOrderGesture={inspectGesture} />;
    return <NavPage title="Projects order UIKit QA" headerBackTitle="" class="flex-1 bg-background"><View class="p-5 gap-4">
      <Text class="text-foreground">Synthetic memory only. Drag actual production rows; inspect read-only audit.</Text>
      <Button testID="projects-order-uikit-open-home" onPress={() => nav.push({ kind: 'home' })}><Text>Open production Projects home</Text></Button>
      <Button testID="projects-order-uikit-open-detail" onPress={() => nav.push({ kind: 'detail', project: projects[0]! })}><Text>Open production ProjectDetail</Text></Button>
      <Button testID="projects-order-uikit-open-audit" onPress={audit}><Text>Inspect order writes</Text></Button>
      <Text testID="projects-order-uikit-build" class="text-muted-foreground">{String(host.params.buildID)}</Text><Text testID="projects-order-uikit-error" class="text-destructive">{admission.error() || error()}</Text>
    </View></NavPage>;
  }}</NavStack></If>;
}
mount(Fixture);
