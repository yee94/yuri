import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export function allocationStacks(profile) {
  const stacks = new Map();
  const visit = (node, parents) => {
    const frame = node.callFrame;
    const url = frame.url?.replace(/^.*\/(packages|scripts|node_modules)\//, '$1/') ?? '';
    const name = `${frame.functionName || '(anonymous)'} ${url}:${frame.lineNumber + 1}`;
    const stack = [...parents, name];
    if (node.selfSize) stacks.set(stack.join('\n'), (stacks.get(stack.join('\n')) ?? 0) + node.selfSize);
    for (const child of node.children ?? []) visit(child, stack);
  };
  visit(profile.head, []);
  return stacks;
}

export function compareAllocations(before, after) {
  const left = allocationStacks(before.profile); const right = allocationStacks(after.profile);
  const keys = new Set([...left.keys(), ...right.keys()]);
  const deltas = [...keys].map(stack => ({ stack, beforeSampledBytes: left.get(stack) ?? 0,
    afterSampledBytes: right.get(stack) ?? 0, deltaSampledBytes: (right.get(stack) ?? 0) - (left.get(stack) ?? 0) }))
    .sort((a, b) => b.deltaSampledBytes - a.deltaSampledBytes);
  return { memoryDeltaBytes: Object.fromEntries(Object.keys(after.memory).map(key => [key, after.memory[key] - before.memory[key]])),
    resourcesBefore: before.resources, resourcesAfter: after.resources,
    heapSpacesBefore: before.heapSpaces, heapSpacesAfter: after.heapSpaces,
    sampledBytesBefore: [...left.values()].reduce((sum, bytes) => sum + bytes, 0),
    sampledBytesAfter: [...right.values()].reduce((sum, bytes) => sum + bytes, 0),
    deltas };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const directory = path.resolve(process.argv[2]); const rounds = {};
  for (const direction of ['ascending', 'descending']) {
    const read = async label => JSON.parse(await fs.readFile(path.join(directory, `${direction}-${label}.allocations.json`), 'utf8'));
    const start = await read('switching-start'); const after = await read('switching-zero-after');
    const idle20 = await read('switching-idle-20s'); const idle60 = await read('switching-idle-60s');
    rounds[direction] = { switching: compareAllocations(start, after),
      idle20Recovery: compareAllocations(after, idle20), idle60Recovery: compareAllocations(after, idle60),
      totalAfterIdle60: compareAllocations(start, idle60) };
  }
  await fs.writeFile(path.join(directory, 'allocation-analysis.json'), JSON.stringify({
    classification: 'diagnostic; sampled live JS allocation stacks are not RSS attribution, object retainers or proof of leak', rounds,
  }, null, 2));
  console.log(JSON.stringify(Object.fromEntries(Object.entries(rounds).map(([direction, comparisons]) => [direction,
    Object.fromEntries(Object.entries(comparisons).map(([key, value]) => [key, {
      memoryDeltaBytes: value.memoryDeltaBytes, resourcesBefore: value.resourcesBefore, resourcesAfter: value.resourcesAfter,
      sampledBytesBefore: value.sampledBytesBefore, sampledBytesAfter: value.sampledBytesAfter,
      topGrowingStacks: value.deltas.slice(0, 5), topShrinkingStacks: value.deltas.slice(-5),
    }]))])), null, 2));
}
