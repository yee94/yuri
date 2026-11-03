export interface SpeechCue {
    text: string;
    start: number;
    end: number;
    startTime: number;
    endTime: number;
}

const normalize = (text: string) => text.replace(/[^\p{L}\p{N}]/gu, '').toLowerCase();

/** Provider subtitles are metadata, never synthesis or playback boundaries. */
export function createSpeechTimeline(text: string) {
    const points: number[] = [];
    let content = '';
    for (let offset = 0; offset < text.length;) {
        const character = String.fromCodePoint(text.codePointAt(offset)!);
        const normalized = normalize(character);
        for (let index = 0; index < normalized.length; index++) points.push(offset);
        content += normalized;
        offset += character.length;
    }
    const subtitles: Array<{ text: string; startTime: number; endTime: number }> = [];
    let subtitleCharacters = 0;
    let cues: SpeechCue[] = [];
    return {
        append(value: unknown) {
            if (!value || typeof value !== 'object') throw new Error('Invalid speech subtitle');
            const { text: sentence, words } = value as { text?: unknown; words?: unknown };
            if (typeof sentence !== 'string' || sentence.length > 10000 || !Array.isArray(words) || words.length > 10000) {
                throw new Error('Invalid speech subtitle');
            }
            if (!words.length || !sentence.trim()) return;
            let startTime = Infinity;
            let endTime = 0;
            let previous = -1;
            for (const word of words) {
                if (!word || typeof word !== 'object' || typeof word.word !== 'string'
                    || !Number.isFinite(word.startTime) || !Number.isFinite(word.endTime)
                    || word.startTime < 0 || word.endTime < word.startTime || word.endTime > 7200
                    || word.startTime < previous) throw new Error('Invalid speech subtitle timestamp');
                startTime = Math.min(startTime, word.startTime);
                endTime = Math.max(endTime, word.endTime);
                previous = word.startTime;
            }
            if (subtitles.some((cue) => cue.startTime === startTime && cue.text === sentence)) return;
            subtitleCharacters += sentence.length;
            if (subtitles.length >= 1000 || subtitleCharacters > 20000) throw new Error('Speech subtitle limit exceeded');
            subtitles.push({ text: sentence, startTime, endTime });
            subtitles.sort((a, b) => a.startTime - b.startTime);
            // Subtitles may arrive out of order. Align in media order, not arrival
            // order, including repeated passages and Markdown/numeric punctuation.
            let cursor = 0;
            cues = [];
            for (const subtitle of subtitles) {
                const needle = normalize(subtitle.text);
                const start = needle ? content.indexOf(needle, cursor) : -1;
                if (start < 0) continue;
                const first = points[start];
                const last = points[start + needle.length - 1];
                let end = last + (text.codePointAt(last)! > 0xffff ? 2 : 1);
                end += text.slice(end).match(/^[^\p{L}\p{N}]*/u)![0].length;
                cues.push({ ...subtitle, start: first, end });
                cursor = start + needle.length;
            }
        },
        at(position: number): SpeechCue | undefined {
            let low = 0;
            let high = cues.length;
            while (low < high) {
                const middle = (low + high) >>> 1;
                if (cues[middle].startTime <= position) low = middle + 1;
                else high = middle;
            }
            const cue = cues[low - 1];
            return cue && position <= cue.endTime ? cue : undefined;
        },
        lastBefore(position: number): SpeechCue | undefined {
            for (let index = cues.length - 1; index >= 0; index--) {
                if (cues[index].endTime <= position) return cues[index];
            }
            return undefined;
        },
    };
}
