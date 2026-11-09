import { mount, signal, Text, View } from 'nsh';
import { Button, createNavStack, Input, NavStack } from 'nsh/base';
import { createProjectsController, ProjectDetail } from './projects';
import { createWorktreeForm } from './projects-worktree-form';
import { WorktreeBranchPicker } from './projects-worktree-picker';
import { language } from './i18n';
import { projectsFixtureAdmission } from './tests/projects-fixture-admission';
import { captureHostRequest } from './state';

function FormOwnerFixture() {
  const controller = createProjectsController(), active = signal(true), counter = signal(0), audit = signal(''), result = signal('');
  const catalog = signal<Array<{ name: string; branch: string }>>([]);
  const form = createWorktreeForm({ directory: '/repo', hostKey: 'isolated-form-owner', active, current: controller.current, capture: controller.captureWorktreeOperation, worktrees: catalog });
  const control = (path: string) => { void captureHostRequest()(path).then(value => audit.set(String(value))); };
  return <View>
    <Text testID="owner-source">{form.ready() ? `source:${form.source()}` : 'context pending'}</Text><Text>{counter()}</Text><Text>{audit()}</Text><Text>{result()}</Text>
    <Text testID="owner-errors">{form.errors().branch || form.errors().folder || form.errors().request || 'fields valid'}</Text>
    <Text testID="owner-context">{form.contextLoading() ? 'branches loading' : form.contextError() || `branch count:${form.branches().length}`}</Text>
    <Text>{`known branches:${form.branches().length}`}</Text>
    <Text testID="owner-existing">{`existing:${form.existingBranch()} folder:${form.existingFolder()}`}</Text>
    <WorktreeBranchPicker kind="existing" form={form} disabled={false} fieldClass="min-h-11" quietClass="min-h-11" />
    <Button testID="owner-existing-remote" onPress={() => form.selectExisting('remotes/origin/release')}><Text>Select isolated remote</Text></Button>
    <Button testID="owner-context-retry" onPress={() => { void form.prepare(); }}><Text>Read branch context</Text></Button>
    <Button testID="owner-context-burst" onPress={() => { for (let i = 0; i < 50; i++) void form.prepare(); }}><Text>50 simultaneous reads</Text></Button>
    <Button testID="owner-branches-fail" onPress={() => control('/fixture/branches-mode/fail')}><Text>Fail branch reads</Text></Button>
    <Button testID="owner-branches-empty" onPress={() => control('/fixture/branches-mode/empty')}><Text>Empty branch reads</Text></Button>
    <Button testID="owner-branches-normal" onPress={() => control('/fixture/branches-mode/normal')}><Text>Restore branch reads</Text></Button>
    <Button testID="owner-branches-hold" onPress={() => control('/fixture/branches-mode/hold')}><Text>Hold branch reads</Text></Button>
    <Button testID="owner-branches-release" onPress={() => control('/fixture/branches-release')}><Text>Release branch read</Text></Button>
    <Button testID="owner-branches-audit" onPress={() => control('/fixture/branches-audit')}><Text>Read branch audit</Text></Button>
    <Input testID="owner-branch" value={form.branch()} onChange={event => form.editBranch(event.value)} />
    <Button testID="owner-collision" onPress={() => catalog.set([{ name: form.branch(), branch: form.branch() }])}><Text>Load a colliding name</Text></Button>
    <Button testID="owner-develop" onPress={() => form.selectSource('feature/existing')}><Text>Choose source</Text></Button>
    <Button testID="owner-edit-a" onPress={() => form.editBranch('feature/a')}><Text>Edit A</Text></Button>
    <Button testID="owner-edit-b" onPress={() => form.editBranch('feature/b')}><Text>Edit B</Text></Button>
    <Button testID="owner-edit-c" onPress={() => form.editBranch('feature/c')}><Text>Edit C</Text></Button>
    <Button testID="owner-unrelated" onPress={() => { for (let i = 0; i < 50; i++) counter.set(counter() + 1); }}><Text>50 unrelated changes</Text></Button>
    <Button testID="owner-pause" onPress={() => active.set(!active())}><Text>Toggle active</Text></Button>
    <Button testID="owner-retry" onPress={form.retryValidation}><Text>Retry validation</Text></Button>
    <Button testID="owner-audit" onPress={() => control('/fixture/audit')}><Text>Read audit</Text></Button>
    <Button testID="owner-hold" onPress={() => control('/fixture/hold')}><Text>Hold next</Text></Button>
    <Button testID="owner-release" onPress={() => control('/fixture/release')}><Text>Release prior</Text></Button>
    <Button testID="owner-submit" disabled={!form.ready() || form.validating() || form.submitting()} onPress={() => { void form.submit(() => controller.createWorktree({ id: 'p', name: 'Fixture', path: '/repo' }, form.selectedBranch(), form.selectedFolder(), form.source(), form.mode())).then(path => { if (path) result.set(`Owner created ${path}`); }); }}><Text>Submit isolated</Text></Button>
  </View>;
}

function WorktreeFixture() {
  language.set('en');
  const admission = projectsFixtureAdmission(), open = signal(true), result = signal(''), audit = signal(''), owner = signal(false);
  const nav = createNavStack(['worktree']);
  return <If when={admission.ready()} else={<Text>{admission.error() || 'Loading isolated worktree Host'}</Text>}><View class="flex-1">
    <Button testID="fixture-open-worktree" onPress={() => open.set(true)}><Text>Open worktree</Text></Button>
    <Button testID="fixture-owner" onPress={() => { open.set(false); owner.set(!owner()); }}><Text>Toggle isolated form owner</Text></Button>
    <Button testID="fixture-audit-worktree" onPress={() => { void captureHostRequest()('/fixture/audit').then(value => audit.set(String(value))); }}><Text>Audit worktree writes</Text></Button>
    <Text>{audit()}</Text><Text>{result()}</Text>
    <If when={owner()}><FormOwnerFixture /></If>
    <If when={open()}><NavStack state={nav} class="flex-1">{() => <ProjectDetail project={{ id: 'fixture', name: 'Worktree fixture', path: '/repo' }} sheet initialCreateWorktree active
      onSheetClose={() => open.set(false)} onOpenChat={() => {}} onOpenFiles={() => {}} onOpenChanges={() => {}} onEditProject={() => {}}
      onWorktreeCreated={(_, path) => { result.set(`Created ${path}`); open.set(false); }} />}</NavStack></If>
  </View></If>;
}
mount(WorktreeFixture);
