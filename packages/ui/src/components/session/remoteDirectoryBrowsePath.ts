const lastSeparatorIndex = (value: string): number => Math.max(value.lastIndexOf('/'), value.lastIndexOf('\\'));

export const trimDirectoryPath = (value: string): string => {
  const trimmed = value.replace(/[\\/]+$/, '');
  return trimmed || value.slice(0, 1);
};

const separatorFor = (value: string): string => (value.includes('\\') && !value.includes('/') ? '\\' : '/');

export const asDirectoryInput = (value: string): string => (/[\\/]$/.test(value) ? value : `${value}${separatorFor(value)}`);

export const parentDirectoryInput = (directory: string): string => {
  const trimmed = trimDirectoryPath(directory);
  const index = lastSeparatorIndex(trimmed);
  if (index <= 0) return trimmed.slice(0, 1) || '/';
  return trimmed.slice(0, index + 1);
};

/**
 * Splits the path input into the directory to list and the leaf segment used to filter it.
 * An untouched input (the default home) lists the directory itself; typed input lists its parent
 * and filters by the trailing segment, matching the local explorer.
 */
export const resolveRemoteBrowse = (input: string, typed: boolean): { directory: string; filter: string } => {
  const index = lastSeparatorIndex(input);
  if (!typed || index < 0) return { directory: input ? trimDirectoryPath(input) : '', filter: '' };
  return { directory: trimDirectoryPath(input.slice(0, index + 1)), filter: input.slice(index + 1) };
};
