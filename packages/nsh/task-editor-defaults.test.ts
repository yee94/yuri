import { describe, expect, it } from 'vitest';
import { taskEditorDirectory, taskEditorProject, taskEditorSelection, type TaskEditorCreationContext } from './task-editor-defaults';
import { featureFixture, item, settle } from './tests/features-fixture';

const context: TaskEditorCreationContext = { projectID: 'project', directory: '/actual/worktree', selection: { providerID: 'provider', modelID: 'model', variant: 'high', agent: 'plan' } };
describe('Scheduled Task captured defaults', () => {
  it('copies the current four-tuple for creation only; editing empty fields does not inherit a new default', () => {
    expect(taskEditorSelection(undefined, context)).toEqual(context.selection);
    expect(taskEditorSelection(item, context)).toMatchObject({ providerID: 'provider', modelID: 'model', variant: '', agent: 'build' });
    expect(taskEditorSelection({ task: { execution: {} } }, context)).toEqual({ providerID: '', modelID: '', variant: '', agent: '' });
    expect(taskEditorSelection(undefined)).toEqual({ providerID: '', modelID: '', variant: '', agent: '' });
  });
  it('never defaults to the first project; preserves the actual captured worktree and switches to explicit selected project', () => {
    const projects = [{ id: 'wrong', path: '/first', name: 'First' }, { id: 'project', path: '/root', name: 'Actual' }, { id: 'other', path: '/other', name: 'Other' }];
    expect(taskEditorProject(undefined, undefined, projects)).toBe('');
    expect(taskEditorProject(undefined, context, projects)).toBe('project');
    expect(taskEditorDirectory('project', context, projects)).toBe('/actual/worktree');
    expect(taskEditorDirectory('other', context, projects)).toBe('/other');
    expect(taskEditorDirectory('unknown', context, projects)).toBe('');
    expect(taskEditorProject(item, context, projects)).toBe('project');
  });
  it('production new Task saves the captured tuple, preserves prompt/Goal and keeps initial defaults pristine', async () => {
    const f = featureFixture({ creationContext: context });
    const root = f.element('task'); await settle();
    expect(f.calls[0].path).toBe('/api/config/catalog/providers?directory=%2Factual%2Fworktree');
    (f.find(root, node => node.props.testID === 'features-task-cancel').props.onPress as () => void)(); await settle();
    expect(f.dialogs).toHaveLength(0); expect(f.done()).toBe(1);
    (f.find(root, node => node.props.testID === 'features-task-name').props.onChange as (event: { value: string }) => void)({ value: 'New task' });
    (f.find(root, node => node.type === 'TaskEditorPrompt').props.onChange as (value: string) => void)('Inspect @src/main.ts');
    (root.props.headerRight as { props: { onPress: () => void } }).props.onPress(); await settle();
    expect(f.calls.find(call => call.method === 'PUT')?.body).toMatchObject({ task: { name: 'New task', execution: { ...context.selection, prompt: 'Inspect @src/main.ts', goalEnabled: false } } });
  });
  it('switches catalog scope without resetting tuple/prompt and retries failed save with unchanged draft', async () => {
    let writes = 0;
    const f = featureFixture({ creationContext: context, request: async call => {
      if (call.path.startsWith('/api/config/catalog/providers')) return { schemaVersion: 1, providers: [] };
      if (call.path.startsWith('/api/agent')) return [];
      if (++writes === 1) throw new Error('write offline');
      return { task: (call.body as { task: unknown }).task, schedulerSynced: true };
    } });
    f.app.projects.set([{ id: 'project', path: '/root', name: 'Actual' }, { id: 'other', path: '/other', name: 'Other' }]);
    const root = f.element('task'); await settle();
    (f.find(root, node => node.props.testID === 'features-task-name').props.onChange as (event: { value: string }) => void)({ value: 'Keep task' });
    (f.find(root, node => node.type === 'TaskEditorPrompt').props.onChange as (value: string) => void)('Keep full draft');
    const project = f.find(root, node => typeof node.type === 'function' && node.type.name === 'Choice' && node.props.title === 'mobile.tabs.projects');
    (project.props.onChange as (value: string) => void)('other'); await settle();
    expect(f.calls.some(call => call.path === '/api/config/catalog/providers?directory=%2Fother')).toBe(true);
    const press = (root.props.headerRight as { props: { onPress: () => void } }).props.onPress;
    press(); await settle(); expect(f.state(root).error()).toBe('write offline');
    press(); await settle();
    const calls = f.calls.filter(call => call.method === 'PUT');
    expect(calls).toHaveLength(2); expect(calls[0].body).toEqual(calls[1].body);
    expect(calls[1]).toMatchObject({ path: '/api/projects/other/scheduled-tasks', body: { task: { execution: { ...context.selection, prompt: 'Keep full draft' } } } });
  });
});
