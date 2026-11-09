#!/usr/bin/env python3
"""Red-only native pan diagnostic. Never returns a stationary/production PASS."""
import argparse
import json
import math
from pathlib import Path
import re
import subprocess
import sys


def require(value, reason):
    if not value:
        raise ValueError(reason)


def finite(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def independent(nodes):
    require(len(nodes) == 3 and len({node['id'] for node in nodes}) == 3, 'Need three unique preselected body anchors')
    messages = []
    for node in nodes:
        match = re.search(r'hp-\d{4}(?!\d)', node['id'])
        require(node['id'].startswith('body-part-') and match is not None and node['fullyVisible'], 'Only complete actual body-part anchors; no repeated copy/action icons')
        messages.append(match.group())
        require(all(finite(node['frame'][key]) for key in ('x', 'y', 'width', 'height')) and node['frame']['width'] > 0 and node['frame']['height'] > 0, 'Invalid body rect')
    require(len(set(messages)) == 3 and len({node['instance'] for node in nodes}) == 3, 'Anchors must belong to three independent messages and UIView instances')
    for index, a in enumerate(nodes):
        for b in nodes[index + 1:]:
            x_overlap = min(a['frame']['x'] + a['frame']['width'], b['frame']['x'] + b['frame']['width']) - max(a['frame']['x'], b['frame']['x'])
            y_overlap = min(a['frame']['y'] + a['frame']['height'], b['frame']['y'] + b['frame']['height']) - max(a['frame']['y'], b['frame']['y'])
            require(x_overlap <= 0 or y_overlap <= 0, 'Overlapping body anchors are not independent')


def transcript(frame):
    rows = [row for row in frame['scrolls'] if row['id'] == 'transcript' or row.get('ownerID') == 'transcript']
    require(len(rows) == 1, 'Need exactly one actual transcript UIScrollView')
    return rows[0]


def diagnose(data, mark_nonce, first_sequence, last_sequence, request_id):
    require(data['schema'] == 1 and data['synthetic'] is True and not data['overflow'] and not data['nativeFailure'], 'Invalid/overflow/failure capture')
    require(data['host']['rejected'] == 0 and data['host']['mutations'] == 0 and data['host']['startupSweeps'] >= 1 and not data['host']['journalOverflow'], 'Host audit not clean')
    marks = [event for event in data['events'] if event['phase'] == 'mark' and event['nonce'] == mark_nonce]
    require(len(marks) == 1, 'Need one prior native mark, not postselected anchors')
    mark = marks[0]
    marked = next(frame for frame in data['frames'] if frame['sequence'] == mark['lastPeriodicSequence'])
    ids = mark['anchors']
    marked_nodes = []
    for identifier in ids:
        matches = [node for node in marked['nodes'] if node['id'] == identifier]
        require(len(matches) == 1, 'Duplicate/missing preselected anchor')
        marked_nodes.append(matches[0])
    independent(marked_nodes)
    frames = [frame for frame in data['frames'] if first_sequence <= frame['sequence'] <= last_sequence]
    require(len(frames) >= 3 and frames[0]['sequence'] == first_sequence and frames[-1]['sequence'] == last_sequence, 'Missing changed interval')
    require(mark['nativeUptimeMs'] < frames[0]['nativeUptimeMs'], 'Anchor selection must precede gesture interval')
    base = transcript(frames[0]); pan = base['pan']
    require(pan['generation'] > 0, 'Pan began was not actually observed')
    scale = frames[0]['screenScale']
    require(finite(scale) and scale > 0, 'Missing actual screen scale for conservative native coordinate error')
    source_events = data['host']['journal']
    requests = [event for event in source_events if event['phase'] == 'request' and event['requestID'] == request_id]
    responses = [event for event in source_events if event['phase'] == 'history-response' and event['requestID'] == request_id]
    require(len(requests) == len(responses) == 1 and len(responses[0]['responseIDs']) == 20, 'Need one actual 20-message page request and response')
    require(frames[0]['nativeUptimeMs'] <= requests[0]['nativeUptimeMs'] <= responses[0]['nativeUptimeMs'] <= frames[-1]['readEndNativeMs'], 'Page response/request outside continuous changed interval')
    for previous, frame in zip(frames, frames[1:]):
        require(frame['sequence'] == previous['sequence'] + 1 and previous['nativeUptimeMs'] < frame['nativeUptimeMs'] and frame['readEndNativeMs'] - previous['nativeUptimeMs'] <= 50, 'Native sequence/time gap')
    selected = []
    for frame in frames:
        require(not frame['nativeFailure'] and not frame['presentedController'] and frame['screenScale'] == scale and frame['surfaceInWindow'] == frames[0]['surfaceInWindow'] and frame['windowBounds'] == frames[0]['windowBounds'], 'Overlay/coordinate space changed')
        view = transcript(frame); current = view['pan']
        require(view['instance'] == base['instance'] and view['frame'] == base['frame'], 'Viewport changed/recycled')
        require(view['tracking'] is True and view['dragging'] is True and view['decelerating'] is False and current['state'] == 2, 'Only continuous changed + tracking/dragging; release/decel is invalid')
        require(current['instance'] == pan['instance'] and current['generation'] == pan['generation'] and current['boundaryRevision'] == pan['boundaryRevision'] and current['coordinateSpace'] == 'surface', 'Gesture identity/phase boundary changed')
        require(all(finite(current[key]) for key in ('translationX', 'translationY', 'velocityX', 'velocityY', 'readStartNativeMs', 'readEndNativeMs')), 'Invalid pan facts')
        require(frame['nativeUptimeMs'] <= current['readStartNativeMs'] <= current['readEndNativeMs'] <= frame['readEndNativeMs'] and frame['readEndNativeMs'] - frame['nativeUptimeMs'] <= 5, 'Ambiguous native read exposure (>5ms)')
        nodes = []
        for node in marked_nodes:
            matches = [item for item in frame['nodes'] if item['id'] == node['id']]
            require(len(matches) == 1 and matches[0]['instance'] == node['instance'], 'Anchor missing/duplicated/recycled')
            require(matches[0]['frame']['width'] == node['frame']['width'] and matches[0]['frame']['height'] == node['frame']['height'], 'Anchor body size changed')
            nodes.append(matches[0])
        independent(nodes); selected.append(nodes)
    # All native geometry and pan reads run synchronously on UIKit main with no yield.
    # Two screen pixels cover both endpoints' coordinate quantization; velocity is recorded, never integrated as a bound.
    error = 2 / scale
    measured = []
    for frame, nodes in zip(frames, selected):
        pan_delta = transcript(frame)['pan']['translationY'] - pan['translationY']
        residuals = [node['frame']['y'] - baseline['frame']['y'] - pan_delta for node, baseline in zip(nodes, selected[0])]
        lower = max(0, min(abs(value) for value in residuals) - error) if all(value > 0 for value in residuals) or all(value < 0 for value in residuals) else 0
        measured.append({'sequence': frame['sequence'], 'nativeMs': frame['nativeUptimeMs'], 'panTranslationDeltaPt': pan_delta, 'residualsPt': residuals, 'extraDisplacementLowerPt': lower})
    worst = max(measured, key=lambda row: row['extraDisplacementLowerPt'])
    return {'verdict': 'moving-diagnostic-red' if worst['extraDisplacementLowerPt'] > 1.1 else 'inconclusive', 'worst': worst, 'samples': measured,
            'nativeCoordinateErrorPt': error, 'startNativeMs': frames[0]['nativeUptimeMs'], 'endNativeMs': frames[-1]['readEndNativeMs'],
            'stationaryAcceptance': 'not evaluated', 'original53pt': 'unresolved', 'codedPixels': 'not registered against pan; native-only diagnostic'}


def check_clock(pairs, data, start, end):
    require(len(pairs) >= 2 and len({pair['nonce'] for pair in pairs}) == len(pairs), 'Need fresh distinct real clock nonces')
    lower, upper = -math.inf, math.inf
    for pair in pairs:
        require(pair['identity'] == data['identity'] and pair['processNonce'] == data['processNonce'], 'Clock belongs to another App/process')
        require(pair['hostClock'] == pair['nativeClock'] == 'ProcessInfo.systemUptime milliseconds' and pair['jsClock'] == 'performance.now milliseconds', 'Unknown clock provenance')
        require(all(finite(pair[key]) for key in ('hostSendMs', 'hostReceiveMs', 'nativeMs', 'issuedNativeMs', 'receivedNativeMs', 'returnedNativeMs', 'nativeAckMs', 'jsSendMs', 'jsReceiveMs')), 'Invalid clock numbers')
        require(pair['hostSendMs'] <= pair['hostReceiveMs'] and pair['issuedNativeMs'] <= pair['receivedNativeMs'] == pair['nativeMs'] <= pair['returnedNativeMs'] <= pair['nativeAckMs'], 'Invalid native/host clock order')
        require(pair['jsReceiveMs'] - pair['jsSendMs'] >= pair['returnedNativeMs'] - pair['receivedNativeMs'], 'Invalid real JS roundtrip')
        lower, upper = max(lower, pair['nativeMs'] - pair['hostReceiveMs']), min(upper, pair['nativeMs'] - pair['hostSendMs'])
    require(lower <= upper and upper - lower <= 50, 'Clock offset inconsistent/ambiguous')
    require(min(pair['hostReceiveMs'] for pair in pairs) + upper <= start - 250 and max(pair['hostSendMs'] for pair in pairs) + lower >= end, 'Clock does not bracket gesture interval')
    return {'offsetLowerMs': lower, 'offsetUpperMs': upper}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('capture', type=Path)
    for name in ('manifest', 'sync', 'recording', 'record-check', 'record-binary'):
        parser.add_argument('--' + name, required=True, type=Path)
    parser.add_argument('--mark-nonce', required=True)
    for name in ('first-sequence', 'last-sequence', 'request-id'):
        parser.add_argument('--' + name, required=True, type=int)
    args = parser.parse_args()
    try:
        data = json.loads(args.capture.read_text()); manifest = json.loads(args.manifest.read_text())
        require(manifest['appBuilt'] and manifest['experimentOn'] is False and data['identity'] == {key: manifest[key] for key in ('buildID', 'bundleSHA256', 'executableSHA256')}, 'Wrong artifact/default not OFF')
        result = diagnose(data, args.mark_nonce, args.first_sequence, args.last_sequence, args.request_id)
        result['clock'] = check_clock(json.loads(args.sync.read_text()), data, result['startNativeMs'], result['endNativeMs'])
        # Preserve the existing live ledger, fresh PTS decode and clock/error budget gate unchanged.
        checked = subprocess.run([sys.executable, str(args.record_check), str(args.recording), '--binary', str(args.record_binary.resolve()), '--sync', str(args.sync), '--native-baseline-ms', str(result['startNativeMs'])], capture_output=True, text=True, timeout=120)
        result['acquisition'] = json.loads(checked.stdout)
        require(checked.returncode == 0 and result['acquisition']['verdict'] == 'acquisition-valid', 'Live source/clock/PTS coverage invalid')
    except (ValueError, KeyError, TypeError, StopIteration, OSError, subprocess.SubprocessError) as error:
        result = {'verdict': 'invalid', 'reason': str(error), 'stationaryAcceptance': 'not evaluated', 'original53pt': 'unresolved'}
    print(json.dumps(result, indent=2))
    return 1 if result['verdict'] == 'moving-diagnostic-red' else 2


if __name__ == '__main__':
    sys.exit(main())
