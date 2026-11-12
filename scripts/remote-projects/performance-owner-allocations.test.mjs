import { describe, it, expect } from 'vitest';
import { allocationStacks, compareAllocations } from './performance-owner-allocations.mjs';

const node = (name, selfSize, children = []) => ({ callFrame: { functionName: name, url: 'file:///fixture/packages/web/source.js', lineNumber: 0 }, selfSize, children });
const record = head => ({ profile: { head }, memory: { rss: 100, heapUsed: 20 }, resources: { Timeout: 2 }, heapSpaces: [] });
describe('sampled allocation diagnostics', () => {
  it('counts self size once, not the inclusive subtree multiple times', () => {
    expect([...allocationStacks({ head: node('root', 10, [node('child', 20)]) }).values()]).toEqual([10, 20]);
  });
  it('preserves negative differences and newly sampled stacks', () => {
    const delta = compareAllocations(record(node('root', 30, [node('gone', 20)])), record(node('root', 10, [node('new', 40)])));
    expect(delta.sampledBytesBefore).toBe(50); expect(delta.sampledBytesAfter).toBe(50);
    expect(delta.deltas.map(value => value.deltaSampledBytes)).toEqual([40, -20, -20]);
    expect(delta.memoryDeltaBytes).toEqual({ rss: 0, heapUsed: 0 });
  });
  it('keeps caller paths separate and strips machine-specific repository prefixes', () => {
    const result = allocationStacks({ head: node('root', 0, [node('callerA', 0, [node('shared', 10)]), node('callerB', 0, [node('shared', 20)])]) });
    expect(result.size).toBe(2);
    expect([...result.keys()].every(stack => !stack.includes('/fixture/'))).toBe(true);
  });
});
