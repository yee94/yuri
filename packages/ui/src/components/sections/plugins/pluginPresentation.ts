/** Separate a package selector without splitting a scoped package name or a local path. */
export function splitPluginSpec(spec: string, isPackage = true): { name: string; version: string | null } {
  if (!isPackage) return { name: spec, version: null };
  const at = spec.lastIndexOf('@');
  return at > 0
    ? { name: spec.slice(0, at), version: spec.slice(at + 1) || null }
    : { name: spec, version: null };
}
