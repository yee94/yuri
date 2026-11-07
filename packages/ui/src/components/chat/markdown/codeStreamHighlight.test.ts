import { describe, expect, test, vi } from 'vitest';

import {
    applyPrefixDiffHtmlLines,
    firstDifferingIndex,
    shouldPreserveStreamingFence,
    stampOpenFenceHtml,
    STREAM_FENCE_ATTR,
    STREAM_LINE_ATTR,
    STREAM_SRC_ATTR,
    upgradeStreamingFenceHighlight,
} from './codeStreamHighlight';

const lineHtml = (code: HTMLElement): string[] => (
    Array.from(code.children)
        .filter((node): node is HTMLElement => node instanceof HTMLElement)
        .map((node) => node.innerHTML)
);

describe('prefix-diff streaming highlight', () => {
    test('50 growing-line updates retain the trailing blank line without removing its separator', () => {
        const code = document.createElement('code');
        applyPrefixDiffHtmlLines(code, ['', '']);
        const trailingLine = code.lastChild;
        const separator = trailingLine!.previousSibling;
        const removeSpy = vi.spyOn(CharacterData.prototype, 'remove');
        try {
            for (let index = 0; index < 50; index += 1) {
                applyPrefixDiffHtmlLines(code, [`<span>const value = ${index}</span>`, '']);
                expect(code.lastChild).toBe(trailingLine);
                expect(trailingLine!.previousSibling).toBe(separator);
                expect(code.textContent).toBe(`const value = ${index}\n`);
            }
            expect(removeSpy).not.toHaveBeenCalled();
        } finally {
            removeSpy.mockRestore();
        }
    });

    test('updates multiple changed lines in place and retains an unchanged suffix', () => {
        const code = document.createElement('code');
        applyPrefixDiffHtmlLines(code, ['one', 'two', 'three', '']);
        const lines = Array.from(code.children);
        const result = applyPrefixDiffHtmlLines(code, ['ONE', 'TWO', 'three', '']);
        expect(result).toEqual({ reused: 0, replaced: 2, added: 0, removed: 0 });
        expect(Array.from(code.children)).toEqual(lines);
        expect(code.textContent).toBe('ONE\nTWO\nthree\n');
    });

    test('initial highlighting never exposes an empty connected code body between DOM writes', () => {
        const code = document.createElement('code');
        code.textContent = 'const a = 1\nconst b = 2\n';
        document.body.append(code);
        const replacementText: string[] = [];
        const replace = code.replaceChildren.bind(code);
        const replaceSpy = vi.spyOn(code, 'replaceChildren').mockImplementation((...nodes) => {
            replacementText.push(nodes.map((node) => typeof node === 'string' ? node : node.textContent ?? '').join(''));
            replace(...nodes);
        });
        try {
            applyPrefixDiffHtmlLines(code, ['<span>const a = 1</span>', '<span>const b = 2</span>', '']);
            expect(replacementText).toEqual(['const a = 1\nconst b = 2\n']);
            expect(code.textContent).toBe('const a = 1\nconst b = 2\n');
        } finally {
            replaceSpy.mockRestore();
            code.remove();
        }
    });

    test('keeps source newlines when plain streaming code becomes highlighted', () => {
        const code = document.createElement('code');
        code.textContent = 'const a = 1\nconst b = 2\n';
        applyPrefixDiffHtmlLines(code, ['<span>const a = 1</span>', '<span>const b = 2</span>', '']);
        expect(code.textContent).toBe('const a = 1\nconst b = 2\n');
    });

    test('keeps unchanged token nodes across repeated stream updates', () => {
        const code = document.createElement('code');
        const prefix = '<span>console.log("hello")</span>';
        applyPrefixDiffHtmlLines(code, [prefix, '<span>const n = 1</span>']);
        const token = code.children[0]!.firstChild;
        const second = code.children[1];
        for (let n = 2; n < 10; n += 1) {
            const result = applyPrefixDiffHtmlLines(code, [prefix, `<span>const n = ${n}</span>`]);
            expect(result.reused).toBe(1);
            expect(code.children[0]!.firstChild).toBe(token);
            expect(code.children[1]).toBe(second);
        }
    });

    test('firstDifferingIndex finds the suffix start', () => {
        expect(firstDifferingIndex(['a', 'b'], ['a', 'b', 'c'])).toBe(2);
        expect(firstDifferingIndex(['a', 'x'], ['a', 'y'])).toBe(1);
        expect(firstDifferingIndex(['a'], ['a'])).toBe(1);
        expect(firstDifferingIndex([], ['a'])).toBe(0);
    });

    test('reuses leading line nodes and only appends the suffix', () => {
        const code = document.createElement('code');
        applyPrefixDiffHtmlLines(code, [
            '<span style="color:red">const</span>',
            '<span>x = 1</span>',
        ]);
        const first = code.children[0];
        const second = code.children[1];
        const result = applyPrefixDiffHtmlLines(code, [
            '<span style="color:red">const</span>',
            '<span>x = 1</span>',
            '<span>y = 2</span>',
        ]);
        expect(result).toEqual({ reused: 2, replaced: 0, added: 1, removed: 0 });
        expect(code.children[0]).toBe(first);
        expect(code.children[1]).toBe(second);
        expect(lineHtml(code)).toEqual([
            '<span style="color:red">const</span>',
            '<span>x = 1</span>',
            '<span>y = 2</span>',
        ]);
    });

    test('replaces only the first differing line and truncates the suffix', () => {
        const code = document.createElement('code');
        applyPrefixDiffHtmlLines(code, ['one', 'two', 'three']);
        const first = code.children[0];
        const result = applyPrefixDiffHtmlLines(code, ['one', 'TWO']);
        expect(result).toEqual({ reused: 1, replaced: 1, added: 0, removed: 1 });
        expect(code.children[0]).toBe(first);
        expect(lineHtml(code)).toEqual(['one', 'TWO']);
        expect(code.textContent).toBe('one\nTWO');
        expect(code.children[1]?.getAttribute(STREAM_LINE_ATTR)).toBe('1');
        applyPrefixDiffHtmlLines(code, []);
        expect(code.childNodes.length).toBe(0);
        applyPrefixDiffHtmlLines(code, ['new', 'tail', '']);
        expect(code.textContent).toBe('new\ntail\n');
    });

    test('a no-op update keeps every node', () => {
        const code = document.createElement('code');
        applyPrefixDiffHtmlLines(code, ['a', 'b']);
        const nodes = Array.from(code.children);
        const result = applyPrefixDiffHtmlLines(code, ['a', 'b']);
        expect(result).toEqual({ reused: 2, replaced: 0, added: 0, removed: 0 });
        expect(Array.from(code.children)).toEqual(nodes);
    });

    test('plain-text first paint is replaced by line spans', () => {
        const code = document.createElement('code');
        code.textContent = 'const x = 1';
        const result = applyPrefixDiffHtmlLines(code, ['<span>const x = 1</span>']);
        expect(result.added).toBe(1);
        expect(code.textContent).toBe('const x = 1');
        expect(code.children[0]?.getAttribute(STREAM_LINE_ATTR)).toBe('0');
    });

    test('open fences are stamped for the incremental pass', () => {
        expect(stampOpenFenceHtml('<pre><code>x</code></pre>')).toContain(`${STREAM_FENCE_ATTR}="true"`);
        const already = `<pre ${STREAM_FENCE_ATTR}="true"><code>x</code></pre>`;
        expect(stampOpenFenceHtml(already)).toBe(already);
    });

    test('stamps the last pre when earlier closed fences exist', () => {
        const html = '<pre><code>done</code></pre><pre><code>live</code></pre>';
        const stamped = stampOpenFenceHtml(html);
        expect(stamped.startsWith('<pre><code>done')).toBe(true);
        expect(stamped).toContain(`<pre ${STREAM_FENCE_ATTR}="true"><code>live`);
    });

    test('morph preserve copies the incoming fence text and skips the subtree', () => {
        const from = document.createElement('pre');
        from.setAttribute(STREAM_FENCE_ATTR, 'true');
        const fromCode = document.createElement('code');
        fromCode.textContent = 'const x = 1';
        from.appendChild(fromCode);

        const to = document.createElement('pre');
        to.setAttribute(STREAM_FENCE_ATTR, 'true');
        const toCode = document.createElement('code');
        toCode.textContent = 'const x = 12';
        to.appendChild(toCode);

        expect(shouldPreserveStreamingFence(from, to)).toBe(true);
        expect(fromCode.getAttribute(STREAM_SRC_ATTR)).toBe('const x = 12');
        expect(shouldPreserveStreamingFence(document.createElement('pre'), to)).toBe(false);
    });

    test('upgradeStreamingFenceHighlight patches via prefix-diff and ignores worker failure', async () => {
        const root = document.createElement('div');
        root.innerHTML = `<pre ${STREAM_FENCE_ATTR}="true"><code class="language-ts">const x = 1</code></pre>`;
        const code = root.querySelector('code');
        expect(code).toBeTruthy();

        await upgradeStreamingFenceHighlight(root, async () => ['<span>const x = 1</span>']);
        expect(lineHtml(code!)).toEqual(['<span>const x = 1</span>']);
        const first = code!.children[0];

        code!.setAttribute(STREAM_SRC_ATTR, 'const x = 1\nconst y = 2');
        await upgradeStreamingFenceHighlight(root, async () => [
            '<span>const x = 1</span>',
            '<span>const y = 2</span>',
        ]);
        expect(code!.children[0]).toBe(first);
        expect(lineHtml(code!)).toEqual([
            '<span>const x = 1</span>',
            '<span>const y = 2</span>',
        ]);

        await upgradeStreamingFenceHighlight(root, async () => null);
        expect(lineHtml(code!)).toEqual([
            '<span>const x = 1</span>',
            '<span>const y = 2</span>',
        ]);
    });

    test('preserving a growing fence adopts completed language metadata without replacing its lines', async () => {
        const root = document.createElement('div');
        root.innerHTML = `<pre ${STREAM_FENCE_ATTR}="true" data-md-lang="typ"><code class="language-typ">const value = 1</code></pre>`;
        const from = root.querySelector('pre')!;
        const code = from.querySelector('code')!;
        const languages: string[] = [];
        const highlight = async (_source: string, language: string) => {
            languages.push(language);
            return [`<span data-language="${language}">const value = 1</span>`];
        };
        await upgradeStreamingFenceHighlight(root, highlight);
        const line = code.firstChild;
        const incoming = document.createElement('pre');
        incoming.setAttribute(STREAM_FENCE_ATTR, 'true');
        incoming.setAttribute('data-md-lang', 'typescript');
        incoming.innerHTML = '<code class="language-typescript">const value = 1</code>';
        expect(shouldPreserveStreamingFence(from, incoming)).toBe(true);
        await upgradeStreamingFenceHighlight(root, highlight);
        expect(languages).toEqual(['typ', 'typescript']);
        expect(from.getAttribute('data-md-lang')).toBe('typescript');
        expect(code.className).toBe('language-typescript');
        expect(code.firstChild).toBe(line);
    });

    test('does not apply a stale language result when the same source gains authoritative fence metadata', async () => {
        const root = document.createElement('div');
        root.innerHTML = `<pre ${STREAM_FENCE_ATTR}="true" data-md-lang="typ"><code>const value = 1</code></pre>`;
        const from = root.querySelector('pre')!;
        const code = from.querySelector('code')!;
        let complete!: (lines: string[]) => void;
        const pending = upgradeStreamingFenceHighlight(root, () => new Promise(resolve => { complete = resolve; }));
        const incoming = document.createElement('pre');
        incoming.setAttribute(STREAM_FENCE_ATTR, 'true');
        incoming.setAttribute('data-md-lang', 'typescript');
        incoming.innerHTML = '<code>const value = 1</code>';
        shouldPreserveStreamingFence(from, incoming);
        complete(['<span>stale grammar</span>']);
        await pending;
        expect(code.children.length).toBe(0);
        expect(code.getAttribute(STREAM_SRC_ATTR)).toBe('const value = 1');
        const highlight = vi.fn(async () => ['<span>const value = 1</span>']);
        await upgradeStreamingFenceHighlight(root, highlight);
        expect(highlight).toHaveBeenCalledWith('const value = 1', 'typescript', undefined);
        expect(code.textContent).toBe('const value = 1');
    });

    test('worker failure still advances source text and retains highlighted prefix lines', async () => {
        const root = document.createElement('div');
        root.innerHTML = `<pre ${STREAM_FENCE_ATTR}="true"><code>one</code></pre>`;
        const code = root.querySelector('code')!;
        await upgradeStreamingFenceHighlight(root, async () => ['<span>one</span>']);
        const first = code.firstChild;
        code.setAttribute(STREAM_SRC_ATTR, 'one\n<script>\n');
        await upgradeStreamingFenceHighlight(root, async () => null);
        expect(code.textContent).toBe('one\n<script>\n');
        expect(code.querySelector('script')).toBeNull();
        expect(code.firstChild).toBe(first);
        // A later successful retry can still upgrade the plain suffix.
        await upgradeStreamingFenceHighlight(root, async () => ['<span>one</span>', '<span>&lt;script&gt;</span>', '']);
        expect(code.children[1]?.firstChild?.nodeName).toBe('SPAN');
    });

    test('does not commit a worker result after a newer source arrives', async () => {
        const root = document.createElement('div');
        root.innerHTML = `<pre ${STREAM_FENCE_ATTR}="true"><code>old</code></pre>`;
        const code = root.querySelector('code')!;
        let complete!: (lines: string[]) => void;
        const pending = upgradeStreamingFenceHighlight(root, () => new Promise((resolve) => { complete = resolve; }));
        code.setAttribute(STREAM_SRC_ATTR, 'new');
        complete(['<span>old</span>']);
        await pending;
        expect(code.children.length).toBe(0);
        expect(code.getAttribute(STREAM_SRC_ATTR)).toBe('new');
        await upgradeStreamingFenceHighlight(root, async () => ['<span>new</span>']);
        expect(code.textContent).toBe('new');
    });
});
