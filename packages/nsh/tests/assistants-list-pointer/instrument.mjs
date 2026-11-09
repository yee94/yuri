import { instrumentPointerRow } from '../assistants-pointer/instrument.mjs';

export function instrumentListRow(source) {
  const patched = instrumentPointerRow(source)
    .replace("import { record } from './tests/assistants-pointer/trace';", "import { recordRow } from './tests/assistants-list-pointer/trace';")
    .replace('  const offset = signal(0);', '  const record = (event: Parameters<typeof recordRow>[0]) => recordRow(event, () => props.pinned);\n  const offset = signal(0);');
  return [['onMenu', 'menu'], ['onEdit', 'edit'], ['onDelete', 'delete'], ['onOpen', 'open']].reduce((text, [callback, event]) =>
    text.replaceAll(`props.${callback}()`, `(record('${event}'), props.${callback}())`), patched);
}
export function instrumentAssistantPage(source) {
  function replace(before, after) {
    if (source.split(before).length !== 2) throw Error('List pointer instrumentation anchor changed: ' + before);
    source = source.replace(before, after);
  }
  replace("import { AssistantSwipeRow } from './assistants-swipe';", "import { AssistantSwipeRow } from './assistants-swipe';\nimport { recordPage } from './tests/assistants-list-pointer/trace';");
  replace('    loading.set(true);', "    recordPage('load-start'); loading.set(true);");
  replace('      const snapshot = await readAssistantSnapshot(fence);', "      recordPage('snapshot-read'); const snapshot = await readAssistantSnapshot(fence);");
  replace('      enabled.set(snapshot.enabled === true);', "      recordPage('snapshot-apply'); enabled.set(snapshot.enabled === true);");
  replace('    } catch (failure) {', "    } catch (failure) {\n      recordPage('load-failed');");
  replace('    } finally { if (fence.current() && attempt === sequence) loading.set(false); }', "    } finally { recordPage('load-end'); if (fence.current() && attempt === sequence) loading.set(false); }");
  replace('  function card(entry: () => { bot: Row; pinned: boolean }) {', "  function card(entry: () => { bot: Row; pinned: boolean }) {\n    recordPage('card-created');");
  replace('onReveal={id => revealed.set(id)}', "onReveal={id => { recordPage('page-reveal'); revealed.set(id); }}");
  replace('onRefresh={() => { revealed.set(null); void load(); }}', "onRefresh={() => { recordPage('pull-refresh'); revealed.set(null); void load(); }}");
  replace('      const next = new Set(info.viewableItems', "      recordPage('viewability'); const next = new Set(info.viewableItems");
  return source;
}
