/** Paint line-shaped marker strokes without wrapping text or changing its layout. */
export function createSpeechMarker(target: HTMLElement) {
    let range: Range | null = null;
    let layer: HTMLSpanElement | null = null;
    let observer: ResizeObserver | null = null;

    const paint = () => {
        const rectangles = Array.from(range?.getClientRects?.() ?? [])
            .filter((rect) => rect.width > 0 && rect.height > 0)
            .sort((a, b) => a.top - b.top || a.left - b.left);
        if (rectangles.length === 0) { layer?.replaceChildren(); return; }

        const origin = target.getBoundingClientRect();
        const fontSize = getComputedStyle(range?.startContainer.parentElement ?? target).fontSize;
        const lines: { left: number; right: number; top: number; bottom: number }[] = [];
        for (const rect of rectangles) {
            // Inline formatting can report both an element box and its text box.
            const line = lines.find((candidate) => (
                Math.min(candidate.bottom, rect.bottom) - Math.max(candidate.top, rect.top)
                    >= Math.min(candidate.bottom - candidate.top, rect.height) / 2
                && rect.left <= candidate.right + 1 && rect.right >= candidate.left - 1
            ));
            if (line) {
                line.left = Math.min(line.left, rect.left);
                line.right = Math.max(line.right, rect.right);
                line.top = Math.min(line.top, rect.top);
                line.bottom = Math.max(line.bottom, rect.bottom);
            } else {
                lines.push({ left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom });
            }
        }

        if (!layer) {
            layer = document.createElement('span');
            layer.className = 'yuri-speech-marker-layer';
            layer.setAttribute('aria-hidden', 'true');
            target.setAttribute('data-speech-marker-owner', 'true');
            target.append(layer);
        }
        layer.style.fontSize = fontSize;
        const strokes = lines.map((line) => {
            const stroke = document.createElement('span');
            stroke.className = 'yuri-speech-marker-stroke';
            stroke.style.left = `${line.left - origin.left - target.clientLeft + target.scrollLeft}px`;
            stroke.style.top = `${line.top - origin.top - target.clientTop + target.scrollTop}px`;
            stroke.style.width = `${line.right - line.left}px`;
            stroke.style.height = `${line.bottom - line.top}px`;
            return stroke;
        });
        layer.replaceChildren(...strokes);
    };

    return {
        update(nextRange: Range | null) {
            range = nextRange;
            paint();
            if (range && !observer && typeof ResizeObserver !== 'undefined') {
                observer = new ResizeObserver(paint);
                observer.observe(target);
            }
        },
        stop() {
            observer?.disconnect();
            observer = null;
            range = null;
            layer?.remove();
            layer = null;
            target.removeAttribute('data-speech-marker-owner');
        },
    };
}
