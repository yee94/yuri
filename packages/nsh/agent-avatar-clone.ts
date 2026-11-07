/**
 * Local clone for DiceBear's validated plain-data definitions/options, not a
 * structured-clone polyfill. Preserve undefined, numeric values, sparse arrays
 * and shared references; reject values outside that data contract explicitly.
 */
export function cloneAgentArtworkData<T>(value: T): T;
export function cloneAgentArtworkData(value: unknown): unknown {
  const seen = new Map<object, object>();
  function copy(input: unknown): unknown {
    if (input === null || input === undefined || typeof input === 'string' || typeof input === 'boolean' || typeof input === 'number') return input;
    if (typeof input !== 'object') throw new TypeError('Unsupported DiceBear artwork data');
    const previous = seen.get(input);
    if (previous) return previous;
    const array = Array.isArray(input);
    const prototype = Object.getPrototypeOf(input);
    if (!array && prototype !== Object.prototype && prototype !== null) throw new TypeError('DiceBear artwork requires plain data');
    const output = array ? new Array<unknown>(input.length) : {};
    seen.set(input, output);
    for (const key of Object.keys(input)) {
      const entry: unknown = Reflect.get(input, key);
      Object.defineProperty(output, key, { value: copy(entry), enumerable: true, configurable: true, writable: true });
    }
    return output;
  }
  return copy(value);
}
