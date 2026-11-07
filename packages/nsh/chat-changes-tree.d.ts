type TreeFile = { path: string; index: string; working_dir: string };
export type ChangesTreeDirectoryNode = {
  id: string; path: string; name: string;
  children: Map<string, ChangesTreeDirectoryNode>;
  directFiles: TreeFile[];
  files: TreeFile[];
};
export type FlattenedTreeRow =
  | { key: string; kind: 'directory'; depth: number; directory: ChangesTreeDirectoryNode }
  | { key: string; kind: 'file'; depth: number; file: TreeFile };
export function buildChangesTree(entries: TreeFile[]): ChangesTreeDirectoryNode;
export function flattenChangesTree(root: ChangesTreeDirectoryNode, expandedDirectories: Set<string>): FlattenedTreeRow[];
