export const normalizeBranchName = (value: string): string => value
  .trim()
  .replace(/^refs\/heads\//, '')
  .replace(/^heads\//, '')
  .replace(/\s+/g, '-')
  .replace(/^\/+|\/+$/g, '');

export const slugifyWorktreeName = (value: string): string => normalizeBranchName(value)
  .split('/').join('-')
  .replace(/[^A-Za-z0-9._-]+/g, '-')
  .replace(/-+/g, '-')
  .replace(/^-+|-+$/g, '')
  .slice(0, 80);
