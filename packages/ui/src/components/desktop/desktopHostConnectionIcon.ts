import type { IconName } from '@/components/icon/icons';

export function desktopHostConnectionIcon({
  isLocal,
  isSsh,
  isRelay,
}: { isLocal: boolean; isSsh: boolean; isRelay: boolean }): IconName {
  if (isLocal) return 'connection-local';
  if (isRelay) return 'connection-relay';
  if (isSsh) return 'connection-ssh';
  return 'connection-lan';
}
