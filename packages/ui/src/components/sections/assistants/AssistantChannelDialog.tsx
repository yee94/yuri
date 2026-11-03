import React from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useI18n } from '@/lib/i18n';
import { getRuntimeTransportIdentity, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import type { AssistantChannelID } from './assistantChannelBrand';
import { assistantChannelEntries } from './assistantChannelBrand';
import { AssistantPlatformChannelPanel } from './AssistantPlatformChannelPanel';
import { AssistantWeixinChannelPanel } from './AssistantWeixinChannelPanel';

export function AssistantChannelDialog({
  assistantID,
  channel,
  open,
  onOpenChange,
}: {
  assistantID: string;
  channel: AssistantChannelID;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useI18n();
  const transport = React.useSyncExternalStore(
    subscribeRuntimeEndpointChanged,
    getRuntimeTransportIdentity,
    getRuntimeTransportIdentity,
  );
  const entry = assistantChannelEntries.find((candidate) => candidate.id === channel) ?? assistantChannelEntries[0]!;
  const close = () => onOpenChange(false);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="yuri-settings-workspace yuri-settings-workspace-desktop max-h-[85vh] max-w-lg overflow-y-auto">
        <DialogHeader>
          <div className="flex items-center gap-2.5">
            <img src={entry.logo} alt="" aria-hidden className="size-7 shrink-0" />
            <DialogTitle>{t(entry.nameKey)}</DialogTitle>
          </div>
        </DialogHeader>
        {/* Only an open dialog mounts channel requests and polling. */}
        {open && channel === 'wechat' ? <AssistantWeixinChannelPanel key={`${transport}:${assistantID}:${channel}`} assistantID={assistantID} /> : null}
        {open && channel !== 'wechat' ? (
          <AssistantPlatformChannelPanel key={`${transport}:${assistantID}:${channel}`} assistantID={assistantID} provider={channel} onClose={close} />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
