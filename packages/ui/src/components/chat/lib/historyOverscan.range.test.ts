import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { defaultRangeExtractor, type Range, type VirtualItem } from '@tanstack/react-virtual';
import { expect, test } from 'vitest';
import * as overscan from './historyOverscan';

// Exercise the production extractor, including the independently retained speech row.
const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../MessageList.tsx'), 'utf8');
const ast = ts.createSourceFile('MessageList.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let extractorSource = '';
const visit = (node: ts.Node) => {
    if (ts.isPropertyAssignment(node) && node.name.getText(ast) === 'rangeExtractor') {
        extractorSource = node.initializer.getText(ast);
    }
    ts.forEachChild(node, visit);
};
visit(ast);
const compiled = ts.transpileModule(`return (${extractorSource});`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;
const extract = (sizes: number[], offset: number, speakingIndex = -1, height = 800) => {
    let start = 0;
    const measurementsCache: VirtualItem[] = sizes.map((size, index) => {
        const item = { index, key: `row-${index}`, start, end: start + size, size, lane: 0 };
        start += size;
        return item;
    });
    return new Function('defaultRangeExtractor', 'getHistoryRenderRange', 'tanstackVirtualizer', 'speakingIndex', compiled)(
        defaultRangeExtractor,
        'getHistoryRenderRange' in overscan ? overscan.getHistoryRenderRange : undefined,
        { measurementsCache, scrollOffset: offset, scrollRect: { height } }, speakingIndex,
    ) as (range: Range) => number[];
};

test('a 16-row mobile overscan does not mount hundreds of thousands of offscreen pixels', () => {
    const range = { startIndex: 5, endIndex: 5, count: 6, overscan: 16 };
    // The viewport is already in the live tail, beyond the history frame.
    expect(extract(Array(6).fill(30000), 240000)(range)).toEqual([4, 5]);
    expect(extract(Array(6).fill(30000), 240000, 1)(range)).toEqual([1, 4, 5]);
    // Restore the neighbour window before the viewport can enter history.
    expect(extract(Array(6).fill(30000), 181500)(range)).toEqual([4, 5]);
    // Inside a very tall row, keep it, not every preceding long answer.
    expect(extract(Array(40).fill(30000), 615000)({ ...range, startIndex: 20, endIndex: 20, count: 40 })).toEqual([19, 20, 21]);
});

test('dense rows keep the existing count window and every visible row', () => {
    const range = { startIndex: 20, endIndex: 27, count: 80, overscan: 16 };
    expect(extract(Array(80).fill(100), 2000)(range)).toEqual(defaultRangeExtractor(range));
    const visible = { ...range, startIndex: 0, endIndex: 3, count: 4 };
    expect(extract(Array(4).fill(30000), 0)(visible)).toEqual([0, 1, 2, 3]);
});

test('unmeasured viewport geometry keeps the existing safe range', () => {
    const range = { startIndex: 2, endIndex: 2, count: 6, overscan: 16 };
    expect(extract(Array(6).fill(30000), 60000, -1, 0)(range)).toEqual(defaultRangeExtractor(range));
});
