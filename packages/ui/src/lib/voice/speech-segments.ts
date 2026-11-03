/** Bounded, sentence-aligned requests shared by every message speech provider. */
export function splitSpeechText(text: string): string[] {
    const chunks: string[] = [];
    let rest = text.trim();
    while (rest) {
        const paragraphEnd = rest.indexOf('\n\n');
        if (paragraphEnd > 0 && paragraphEnd <= 280) {
            chunks.push(rest.slice(0, paragraphEnd).trim());
            rest = rest.slice(paragraphEnd).trimStart();
            continue;
        }
        if (rest.length <= 280) { chunks.push(rest); break; }
        const head = rest.slice(0, 280);
        const boundaries = [...head.matchAll(/[。！？.!?；;\n](?:[”’"')\]]*)\s*|\s+/gu)];
        const boundary = boundaries.reverse().find((match) => match.index! >= 80);
        let end = boundary ? boundary.index! + boundary[0].length : 280;
        // Never split a UTF-16 surrogate pair.
        if (/[\uD800-\uDBFF]/u.test(rest[end - 1])) end -= 1;
        chunks.push(rest.slice(0, end).trim());
        rest = rest.slice(end).trimStart();
    }
    return chunks;
}
