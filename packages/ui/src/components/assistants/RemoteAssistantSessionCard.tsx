import { useQuery } from '@tanstack/react-query';
import { gitBranchesQueryOptions } from '@/queries/gitBranchQueries';
import { useRemoteProjectRuntime, useRemoteHostSummaries } from '@/queries/remoteProjectQueries';
import type { HostRuntimeEntry } from '@/lib/remote-projects/registry';
import type { Session } from '@/lib/opencode/v2-types';
import type { AssistantContactSessionCardPart } from '@/queries/assistantDTO';
import { SessionCardView } from './AssistantSessionCard';

type Props = { card: AssistantContactSessionCardPart };

function RemoteCardBranches({ card, entry, liveSession, liveType }: Props & { entry: HostRuntimeEntry; liveSession?: Session; liveType?: string }) {
  const branches = useQuery(gitBranchesQueryOptions(card.directory, undefined, undefined, undefined, entry));
  return <SessionCardView card={card} liveSession={liveSession} liveType={liveType} branch={branches.data?.current?.trim() || null} />;
}

export default function RemoteAssistantSessionCard({ card }: Props) {
  const { catalog, registry } = useRemoteProjectRuntime(true);
  const target = card.target!;
  const validHub = catalog?.hubId === target.hubId;
  const summaries = useRemoteHostSummaries(validHub ? registry : undefined, target.hostId);
  let entry: HostRuntimeEntry | undefined;
  try { if (validHub && registry) entry = registry.resolve({ ...target, directory: card.directory }); } catch { /* Unavailable targets keep their receipt, never read locally. */ }
  const row = entry ? summaries.data?.directories.find((row) => row.directory === card.directory)?.sessions.find((session) => session.id === card.sessionID) : undefined;
  const liveType = !summaries.data?.stale ? (row?.metadata as { yuri?: { sessionStatus?: { type?: string } } } | undefined)?.yuri?.sessionStatus?.type : undefined;
  if (!entry) return <SessionCardView card={card} branch={null} />;
  return <RemoteCardBranches key={JSON.stringify(entry.queryScope)} card={card} entry={entry} liveSession={row} liveType={liveType} />;
}
