export type ProjectFileSearchHit = {
  name: string;
  path: string;
  relativePath: string;
  extension?: string;
  /** True when the hit came from a directory-only search. */
  isDirectory?: boolean;
};
