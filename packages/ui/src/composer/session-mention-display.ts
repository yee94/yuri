const SESSION_MENTION_DISPLAY_MARKER = 'The user referenced these OpenCode sessions (id, title, owning directory).';

const findJsonArrayEnd = (text: string, open: number): number => {
    if (text[open] !== '[') return -1;
    let depth = 0;
    let inString = false;
    let escape = false;
    for (let index = open; index < text.length; index += 1) {
        const char = text[index];
        if (inString) {
            if (escape) { escape = false; continue; }
            if (char === '\\') { escape = true; continue; }
            if (char === '"') inString = false;
            continue;
        }
        if (char === '"') { inString = true; continue; }
        if (char === '[') depth += 1;
        else if (char === ']') {
            depth -= 1;
            if (depth === 0) return index;
        }
    }
    return -1;
};

/** Drop the model-only session retrieval card, including when OpenCode 2 joins it onto authored text. */
export const stripSessionMentionInstruction = (text: string): string => {
    let result = text;
    let index = result.indexOf(SESSION_MENTION_DISPLAY_MARKER);
    while (index !== -1) {
        const jsonStart = result.indexOf('[', index + SESSION_MENTION_DISPLAY_MARKER.length);
        const close = jsonStart === -1 ? -1 : findJsonArrayEnd(result, jsonStart);
        const end = close === -1 ? result.length : close + 1;
        const before = result.slice(0, index).replace(/[ \t]*\n*$/, '');
        const after = result.slice(end).replace(/^\n+/, '');
        result = before.length > 0 && after.length > 0 ? `${before}\n${after}` : `${before}${after}`;
        index = result.indexOf(SESSION_MENTION_DISPLAY_MARKER);
    }
    return result;
};
