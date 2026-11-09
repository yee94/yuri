"""Read-only replay of the retained production negative control; never grants PASS."""

import csv
import hashlib
import json
import math
from pathlib import Path
import sys


def replay(root):
    artifacts = json.loads((root / 'artifact-sha256.json').read_text())
    inputs = json.loads((root / 'input-sha256.json').read_text())

    def checked(file, expected):
        if hashlib.sha256(file.read_bytes()).hexdigest() != expected:
            raise ValueError('Evidence hash mismatch: ' + file.name)

    names = ['round3-loading-to-completion.csv', 'timing.json', 'metadata.json']
    names += [f'frames/{index:04}.png' for index in range(297, 304)]
    for name in names:
        checked(root / name, artifacts[name])
    videos = [(Path(name), value) for name, value in inputs.items() if name.endswith('.mp4')]
    if len(videos) != 1:
        raise ValueError('Expected the single retained production recording')
    checked(videos[0][0], videos[0][1]['sha256'])

    with (root / names[0]).open() as source:
        rows = {int(row['frame']): row for row in csv.DictReader(source)}
    timing = json.loads((root / 'timing.json').read_text())
    baseline, after = [rows[index] for index in range(297, 303)], rows[303]
    for row in baseline + [after]:
        if abs(float(row['pts']) - timing[int(row['frame'])]['pts']) > 1e-8:
            raise ValueError('Pixel registration/decoded PTS mismatch')
        for marker in (1, 2, 3):
            best = float(row[f'marker{marker}_mae'])
            alternative = float(row[f'marker{marker}_alt3px_mae'])
            if not math.isfinite(best) or not math.isfinite(alternative) or best >= alternative:
                raise ValueError('Ambiguous/nonfinite retained marker match')
    if any(float(row[f'marker{marker}_dy_px']) != 0 for row in baseline for marker in (1, 2, 3)):
        raise ValueError('Retained pre-event window is not stationary')
    shifts = [float(after[f'marker{marker}_dy_px']) / 3 for marker in (1, 2, 3)]
    if not all(math.isfinite(value) for value in shifts) or len(set(shifts)) != 1:
        raise ValueError('Retained old-content blocks do not agree')
    red = max(map(abs, shifts)) > 1.1
    return {
        'verdict': 'red' if red else 'invalid',
        'markerDisplacementPt': shifts,
        'baselineFrames': [297, 298, 299, 300, 301, 302],
        'afterFrame': 303,
        'eventEncodedGapMs': (timing[303]['pts'] - timing[302]['pts']) * 1000,
        'adoption': 'not authoritatively proven',
        'acceptance': 'No positive production verdict; retained negative-control replay only',
        'verified': 'original video, seven decoded frames, registration CSV, timing and metadata hashes',
    }, 1 if red else 2


if __name__ == '__main__':
    try:
        if len(sys.argv) != 2:
            raise ValueError('Usage from repository root: python3 check-production-pixels.py <retained-review-directory>')
        result, status = replay(Path(sys.argv[1]))
    except (ValueError, OSError, KeyError, TypeError, IndexError) as error:
        result, status = {'verdict': 'invalid', 'reason': str(error)}, 2
    print(json.dumps(result, ensure_ascii=False))
    sys.exit(status)
