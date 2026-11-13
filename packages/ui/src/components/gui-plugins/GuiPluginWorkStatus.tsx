import React from 'react';
import { useEvent } from '@reactuses/core';
import { GuiPluginHostContext } from '@/lib/gui-plugins/react';
import type { GuiPluginHost } from '@/lib/gui-plugins/host';
import type { GuiWorkStatusEntry, GuiWorkStatusInput, GuiWorkStatusMount } from '@/lib/gui-plugins/work-status';

const WorkStatusMount = React.memo(function WorkStatusMount({ host, entry, input }: {
  host: GuiPluginHost;
  entry: GuiWorkStatusEntry;
  input: GuiWorkStatusInput;
}) {
  const container = React.useRef<HTMLDivElement>(null);
  const mounted = React.useRef<GuiWorkStatusMount | null>(null);
  const mount = useEvent((node: HTMLElement) => host.mountWorkStatus(entry, node, input));

  React.useLayoutEffect(() => {
    if (!container.current) return;
    const handle = mount(container.current);
    mounted.current = handle;
    return () => { mounted.current = null; handle.dispose(); };
  }, [host, entry.key, entry.generation, input.sessionId, input.directory, input.scope, mount]);

  React.useLayoutEffect(() => { mounted.current?.update(input); }, [input]);

  return <div ref={container} data-gui-plugin-mount="work-status" data-gui-work-status={entry.key} className="min-w-0 empty:hidden" />;
});

const WorkStatusItems = React.memo(function WorkStatusItems({ host, input }: { host: GuiPluginHost; input: GuiWorkStatusInput }) {
  const entries = React.useSyncExternalStore(host.workStatus.subscribe, host.workStatus.getSnapshot, host.workStatus.getSnapshot);
  return <>{entries.map((entry) => <WorkStatusMount key={entry.key} host={host} entry={entry} input={input} />)}</>;
});

export const GuiPluginWorkStatus = React.memo(function GuiPluginWorkStatus({ input }: { input: GuiWorkStatusInput }) {
  const host = React.useContext(GuiPluginHostContext);
  return host ? <WorkStatusItems host={host} input={input} /> : null;
});
