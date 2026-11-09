export function createHost(): {
  audit(): { generates: number; commits: number; statusReads: number; posts: string[] };
  call(name: string, input: unknown): { status: number; body: unknown };
};
