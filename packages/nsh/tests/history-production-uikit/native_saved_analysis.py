"""Read-only native evidence audit. Manual preservation is never a flush ACK or acceptance."""
import collections
import hashlib
import json
import re
from pathlib import Path


def load_json(file):
    if file.stat().st_size > 128 * 1024 * 1024:
        raise ValueError('Saved JSON exceeds offline read cap')
    return json.loads(file.read_bytes())


def transcript(frame):
    rows = [row for row in frame['scrolls'] if row.get('id') == 'transcript' or row.get('ownerID') == 'transcript']
    return rows[0] if len(rows) == 1 else None


def triple_runs(frames, bottom=None):
    runs = []; active = []; identity = None
    for frame in frames:
        nodes = [node for node in frame['nodes'] if node['id'].startswith('body-part-') and node['fullyVisible'] and (bottom is None or node['frame']['y'] >= 0 and node['frame']['y'] + node['frame']['height'] <= bottom)]
        messages = {match.group() for node in nodes if (match := re.search(r'hp-\d{4}(?!\d)', node['id']))}
        key = tuple(sorted((node['id'], node['instance']) for node in nodes)) if len(messages) >= 3 and len({node['instance'] for node in nodes}) >= 3 else None
        if key != identity or key is None:
            if active: runs.append(active)
            active = []
        identity = key
        if key is not None: active.append(frame)
    if active: runs.append(active)
    return [{'firstSequence': run[0]['sequence'], 'lastSequence': run[-1]['sequence'], 'durationMs': run[-1]['readEndNativeMs'] - run[0]['nativeUptimeMs'],
             'movingObserved': any(any(view[field] for field in ('tracking', 'dragging', 'decelerating')) for frame in run if (view := transcript(frame))),
             'scope': 'root complete flags' if bottom is None else 'composer outer bound; header still unknown'} for run in runs]


def audit_saved(directory):
    directory = Path(directory)
    manual = directory / 'manual-preserved-capture.json'
    source = manual if manual.exists() else directory / 'final-capture.json'
    capture = load_json(source); actions = load_json(directory / 'actions.json')
    phases = load_json(directory / 'phases.json')
    preservation = load_json(directory / 'manual-preservation.json') if manual.exists() and (directory / 'manual-preservation.json').exists() else None
    start = min((phase['beforeSequence'] for phase in phases if 'beforeSequence' in phase), default=capture['frames'][0]['sequence'])
    frames = [frame for frame in capture['frames'] if frame['sequence'] >= start]
    views = [(frame, view) for frame in frames if (view := transcript(frame))]
    history = [event for event in capture['host']['journal'] if event['phase'] == 'history-response']
    requests = [event for event in capture['host']['journal'] if event['phase'] == 'request' and event.get('path', '').endswith('/message')]
    older = [event for event in history if isinstance(event.get('requestCursor'), str)]
    flushes = [event for event in capture['events'] if event['phase'] == 'flush']
    gaps = []
    for before, after in zip(frames, frames[1:]):
        gap = after['readEndNativeMs'] - before['nativeUptimeMs']
        if gap > 50:
            gaps.append({'beforeSequence': before['sequence'], 'afterSequence': after['sequence'], 'gapMs': gap,
                         'containsNativeFlush': any(before['nativeUptimeMs'] <= event['nativeUptimeMs'] <= after['readEndNativeMs'] for event in flushes)})
    idle = []; pan = []; layout = []; body_heights = collections.defaultdict(list); ancestor_heights = collections.defaultdict(list)
    viewport_instances = set(); viewport_ranges = {key: [] for key in ('x', 'y', 'width', 'height')}
    for frame, view in views:
        viewport_instances.add(view['instance'])
        for key in viewport_ranges: viewport_ranges[key].append(view['frame'][key])
        for node in frame['nodes']:
            if node['id'].startswith(('body-part-', 'turn-body-')): body_heights[(node['id'], node['instance'])].append(node['frame']['height'])
        for node in frame.get('controlAncestors', []): ancestor_heights[(node['instance'], node['role'])].append(node['frame']['height'])
    for (a, va), (b, vb) in zip(views, views[1:]):
        before = {(node['id'], node['instance']): node for node in a['nodes'] if node['id'].startswith('body-part-')}
        after = {(node['id'], node['instance']): node for node in b['nodes'] if node['id'].startswith('body-part-')}
        for key in before.keys() & after.keys():
            na, nb = before[key], after[key]
            if abs(na['frame']['height'] - nb['frame']['height']) > 1.1 or na['frame']['width'] != nb['frame']['width']: continue
            dy = nb['frame']['y'] - na['frame']['y']; offset = vb['offsetY'] - va['offsetY']
            layout.append(abs(dy + offset))
            if b['readEndNativeMs'] - a['nativeUptimeMs'] > 50: continue
            if all(not view[field] for view in (va, vb) for field in ('tracking', 'dragging', 'decelerating')): idle.append(abs(dy))
            pa, pb = va['pan'], vb['pan']
            if pa['state'] == pb['state'] == 2 and pa['generation'] == pb['generation'] and pa['boundaryRevision'] == pb['boundaryRevision'] and all(view['tracking'] and view['dragging'] and not view['decelerating'] for view in (va, vb)):
                pan.append(abs(dy - (pb['translationY'] - pa['translationY'])))
    geometry = []
    for file in sorted(directory.glob('*before-geometry.json')):
        value = load_json(file)
        geometry.append({'file': file.name, 'footerY': value['footerRect']['y'] if value['footerRect'] else None, 'availableOuterBoundPt': value['availableHeightOuterBoundPt'],
                         'triples': value['observedTriples'], 'completeBodies': [node['id'] for node in value['observedBodyRects'] if node['fullyVisible']]})
    targets = []
    for file in sorted(directory.glob('body-target-*.json')):
        value = load_json(file)
        # Actual window height is observed; the normalized coordinates are not nominal pixel/fps estimates.
        height = frames[0]['windowBounds']['height']
        targets.append({'file': file.name, 'body': value['body']['nativeID'], 'source': value['source'], 'end': value['end'], 'distancePt': (value['end']['y'] - value['source']['y']) * height})
    touches = []
    for action in actions:
        if 'gesture' in action['argv']:
            try: touches.append({'input': json.loads(action['argv'][action['argv'].index('gesture') + 1]), 'returned': action.get('returncode') == 0})
            except (ValueError, IndexError): pass
    sources = [source, directory / 'actions.json', directory / 'phases.json']
    if preservation is not None: sources.append(directory / 'manual-preservation.json')
    max_or_none = lambda values: max(values) if values else None
    return {'verdict': 'inconclusive', 'captureSource': source.name, 'manualPreservation': preservation,
            'runnerResultExists': (directory / 'result.json').exists(), 'manualPreservationIsFinalization': False,
            'sourceSHA256': {file.name: hashlib.sha256(file.read_bytes()).hexdigest() for file in sources},
            'frames': len(capture['frames']), 'scope': {'firstSequence': start, 'lastSequence': frames[-1]['sequence'], 'samples': len(frames)},
            'hostAudit': {key: capture['host'].get(key) for key in ('startupSweeps', 'rejected', 'mutations', 'tailReads', 'scenario')},
            'history': {'responses': len(history), 'olderRequests': len([event for event in requests if event.get('query', {}).get('cursor')]), 'olderResponses': len(older),
                        'tailResponses': len(history) - len(older), 'distinctResponseIDs': sorted({identifier for event in history for identifier in event['responseIDs']}),
                        'nextCursors': sorted({event['nextCursor'] for event in history if event.get('nextCursor')}), 'completeResponses': sum(event['complete'] for event in history),
                        'exactFills': [event for event in capture['host']['journal'] if event['phase'] == 'exact-fill']},
            'marks': sum(event['phase'] == 'mark' for event in capture['events']),
            'incompleteCommands': [{'index': index, 'kind': action['argv'][-1], 'status': action.get('status', 'no return observation; cancellation/ACK unknown')} for index, action in enumerate(actions) if 'returncode' not in action],
            'lastTouchCommand': touches[-1] if touches else None, 'targets': targets,
            'native': {'panGenerationMax': max(view['pan']['generation'] for _, view in views), 'panRawStateCounts': dict(collections.Counter(view['pan']['state'] for _, view in views)),
                       'offsetFirstLast': [views[0][1]['offsetY'], views[-1][1]['offsetY']], 'contentHeightRange': [min(view['contentHeight'] for _, view in views), max(view['contentHeight'] for _, view in views)],
                       'viewportInstances': len(viewport_instances), 'viewportCoordinateRanges': {key: max(values) - min(values) for key, values in viewport_ranges.items()},
                       'bodyHeightChangesAbove1_1': [{'id': key[0], 'instance': key[1], 'rangePt': max(values) - min(values)} for key, values in body_heights.items() if max(values) - min(values) > 1.1],
                       'ancestorHeightRanges': [{'instance': key[0], 'role': key[1], 'minHeight': min(values), 'maxHeight': max(values)} for key, values in ancestor_heights.items()],
                       'sampledIdleBodyStepMaxPt': max_or_none(idle), 'sampledChangedPanResidualMaxPt': max_or_none(pan), 'sampledBodyDeltaPlusOffsetMaxPt': max_or_none(layout),
                       'samplePairs': {'idleBody': len(idle), 'changedPanBody': len(pan), 'bodyPlusOffset': len(layout)},
                       'gapsAbove50ms': len(gaps), 'gapsContainingNativeFlush': sum(gap['containsNativeFlush'] for gap in gaps), 'largestGaps': sorted(gaps, key=lambda gap: gap['gapMs'], reverse=True)[:5],
                       'rootCompleteTripleRuns': triple_runs(frames), 'composer780OuterBoundTripleRuns': triple_runs(frames, 780) if any(item['availableOuterBoundPt'] == 780 for item in geometry) else None},
            'geometrySnapshots': geometry, 'strictAcceptance': 'not evaluated', 'sdkAdoptionIdentity': None, 'original53pt': 'unresolved',
            'limitations': 'Unmarked exploratory native samples only; no video or full continuous-time proof; gaps and manual preservation remain explicit'}
