export function collectionValuesEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((value, index) => collectionValuesEqual(value, right[index]));
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
  const a = Object.entries(left), b = Object.entries(right);
  return a.length === b.length && a.every(([key, value]) => Object.hasOwn(right, key) && collectionValuesEqual(value, (right as Record<string, unknown>)[key]));
}

export function collectionWriteRejected(error: unknown): boolean {
  if (!error || typeof error !== 'object' || !('status' in error)) return false;
  return typeof error.status === 'number' && error.status >= 400 && error.status < 500 && error.status !== 408;
}
