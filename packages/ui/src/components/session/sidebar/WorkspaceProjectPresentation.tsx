import { formatPathForDisplay } from '@/lib/utils';

export function WorkspaceProjectPaths({ paths, homeDirectory }: { paths: readonly string[]; homeDirectory?: string | null }) {
  return (
    <ul className="flex min-w-0 flex-col gap-1">
      {paths.map((path) => (
        <li key={path} data-workspace-project-path className="min-w-0 break-all">
          {formatPathForDisplay(path, homeDirectory)}
        </li>
      ))}
    </ul>
  );
}
