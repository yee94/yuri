import { validateGuiSvg } from './file-icons';

/** Yuri extends the SDK's icon names with self-contained images, normalized before publication. */
export function normalizeGuiTitlebarIcon(input: unknown): string | undefined {
    if (typeof input !== 'string' || input.length > 2 * 1024 * 1024) return undefined;
    const value = input.trim();
    if (!value) return undefined;
    try {
        if (value.startsWith('<')) return validateGuiSvg(value);
        if (!/^data:/i.test(value)) return value;
        const match = /^data:image\/(svg\+xml|png|jpeg|gif|webp|avif|x-icon|vnd\.microsoft\.icon)(?:;charset=utf-8)?(;base64)?,([\s\S]+)$/i.exec(value);
        if (!match) return undefined;
        const [, format, base64, payload] = match;
        if (base64 && !/^[A-Za-z0-9+/]+={0,2}$/.test(payload)) return undefined;
        if (format.toLowerCase() === 'svg+xml') {
            const svg = base64
                ? new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(atob(payload), (char) => char.charCodeAt(0)))
                : decodeURIComponent(payload);
            return validateGuiSvg(svg);
        }
        if (!base64 || !atob(payload).length) return undefined;
        return `data:image/${format.toLowerCase()};base64,${payload}`;
    } catch {
        return undefined;
    }
}
