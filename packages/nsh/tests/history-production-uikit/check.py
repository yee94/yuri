"""Offline production-component synthetic geometry gate; original 53pt remains unresolved."""
import argparse
import hashlib
import json
import math
from pathlib import Path
import subprocess
import sys
import tempfile


def require(condition, reason):
    if not condition:
        raise ValueError(reason)


def finite(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def viewport(frame):
    candidates = [row for row in frame['scrolls'] if row['id'] == 'transcript' or row.get('ownerID') == 'transcript']
    require(len(candidates) == 1, 'Need one actual native transcript UIScrollView')
    return candidates[0]


def native_verdict(data, baseline_sequence, anchor_ids, request_id):
    require(data['schema'] == 1 and data['synthetic'] is True and not data['overflow'] and not data.get('nativeFailure', False), 'Invalid native capture schema/overflow/failure')
    require(data['host']['rejected'] == 0 and not data['host'].get('journalOverflow'), 'Unexpected native/Host protocol rejection or journal overflow')
    frames = data['frames']
    require(all(finite(frame['nativeUptimeMs']) and finite(frame['readEndNativeMs']) and frame['readEndNativeMs'] >= frame['nativeUptimeMs'] and frame['readEndNativeMs'] - frame['nativeUptimeMs'] <= 50 for frame in frames), 'Nonfinite or over-budget native read exposure')
    require(all(b['sequence'] == a['sequence'] + 1 and b['nativeUptimeMs'] > a['nativeUptimeMs'] for a, b in zip(frames, frames[1:])), 'Native sequence/time regression')
    baseline = next(frame for frame in frames if frame['sequence'] == baseline_sequence)
    start = baseline['nativeUptimeMs']
    pre = [frame for frame in frames if start - 320 <= frame['nativeUptimeMs'] < start]
    post = [frame for frame in frames if start < frame['nativeUptimeMs'] <= start + 4000]
    require(len(pre) >= 12 and start - pre[0]['nativeUptimeMs'] >= 250, 'Missing 250ms native pre-window')
    require(len(post) >= 180 and post[-1]['nativeUptimeMs'] - start >= 3000, 'Missing >=180 native post samples / >=3 seconds')
    sample = pre + [baseline] + post
    require(all(b['readEndNativeMs'] - a['nativeUptimeMs'] <= 50 for a, b in zip(sample, sample[1:])), 'Native observation gap exceeds 50ms')
    require(len(anchor_ids) == len(set(anchor_ids)) == 3, 'Specify three distinct preselected content anchors')
    marks = [event for event in data['events'] if event['phase'] == 'mark' and event['lastPeriodicSequence'] == baseline_sequence and event['anchors'] == anchor_ids]
    require(len(marks) == 1 and marks[0]['nativeUptimeMs'] >= start, 'Missing real preselected native anchor mark')
    allowed = ('body-part-', 'history-copy-', 'history-actions-')
    require(all(anchor.startswith(allowed) and 'hp-' in anchor for anchor in anchor_ids), 'Only actual production synthetic content anchors are admitted')
    anchors = []
    for identifier in anchor_ids:
        matches = [row for row in baseline['nodes'] if row['id'] == identifier]
        require(len(matches) == 1 and matches[0]['fullyVisible'], 'Missing/duplicate/clipped baseline content anchor')
        anchors.append(matches[0])
    window_events = [event for event in data['events'] if start < event.get('nativeUptimeMs', -1) < start + 4000]
    responses = [event for event in window_events if event['phase'] == 'history-response' and event['requestID'] == request_id]
    require(len(responses) == 1 and len(responses[0]['responseIDs']) == 20, 'Need actual page response identity within window')
    request = [event for event in data['events'] if event['phase'] == 'request' and event['requestID'] == request_id]
    require(len(request) == 1 and marks[0]['nativeUptimeMs'] <= request[0]['nativeUptimeMs'] <= responses[0]['nativeUptimeMs'], 'Baseline/anchor selection is not before actual history request')
    worst = 0
    base_view = viewport(baseline)
    for frame in sample:
        require(not frame.get('nativeFailure') and not frame.get('presentedController'), 'Native failure or presented overlay in observation window')
        view = viewport(frame)
        require(view['instance'] == base_view['instance'] and view['frame'] == base_view['frame'], 'Viewport instance/bounds changed')
        require(not any(view[key] for key in ('tracking', 'dragging', 'decelerating')), 'Viewport is not stationary; no inferred user-input subtraction')
        require(all(finite(view[key]) for key in ('offsetY', 'contentHeight')), 'Nonfinite native scroll geometry')
        require(not any(row['id'] == 'hp-native-error' for row in frame['nodes']), 'Native failure overlay')
        for anchor in anchors:
            matches = [row for row in frame['nodes'] if row['id'] == anchor['id']]
            require(len(matches) == 1 and matches[0]['instance'] == anchor['instance'] and matches[0]['fullyVisible'], 'Anchor recycled/missing/duplicate/clipped')
            position = matches[0]['frame']['y']
            require(finite(position) and finite(anchor['frame']['y']), 'Nonfinite anchor position')
            worst = max(worst, abs(position - anchor['frame']['y']))
    observed = [event for event in window_events if event['phase'] == 'native-first-observed' and any(identifier in event['id'] for identifier in responses[0]['responseIDs'])]
    body_growth = False
    for before in baseline['nodes']:
        if before['id'].startswith('body-part-') and 'hp-0497' in before['id'] and finite(before['frame'].get('height')):
            body_growth = any(abs(node['frame']['height'] - before['frame']['height']) > 1.1 for frame in post for node in frame['nodes'] if node['id'] == before['id'] and node['instance'] == before['instance'] and finite(node['frame'].get('height')))
    return {'geometry': 'red' if worst > 1.1 else 'pass', 'worstPt': worst, 'nativeBaselineMs': start, 'preSamples': len(pre), 'postSamples': len(post),
            'requestID': request_id, 'responseComplete': responses[0]['complete'], 'nativeObservedNewContent': len(observed),
            'nativeEffectObserved': bool(observed) or body_growth, 'nativeBodyGrowthObserved': body_growth,
            'adoption': 'SDK identity unavailable; response/UIView observation only', 'original53pt': 'unresolved'}


def run(args):
    data = json.loads(args.capture.read_text())
    manifest = json.loads(args.manifest.read_text())
    require(manifest['appBuilt'] is True and manifest['synthetic'] is True and data['scenario'] == manifest['scenario'], 'Wrong/not-built artifact')
    require(data['identity'] == {key: manifest[key] for key in ('buildID', 'bundleSHA256', 'executableSHA256')}, 'Captured native build identity mismatch')
    result = native_verdict(data, args.baseline_sequence, args.anchor, args.request_id)
    pairs = json.loads(args.sync.read_text())
    require(len(pairs) >= 2 and len({pair['nonce'] for pair in pairs}) == len(pairs), 'Need fresh independent clock nonces at both ends')
    for pair in pairs:
        require(pair['identity'] == data['identity'] and pair['nativeClock'] == 'ProcessInfo.systemUptime milliseconds' and pair['jsClock'] == 'performance.now milliseconds', 'Clock/build provenance mismatch')
        require(all(finite(pair[key]) for key in ('issuedNativeMs', 'receivedNativeMs', 'returnedNativeMs', 'nativeAckMs', 'jsSendMs', 'jsReceiveMs')), 'Nonfinite clock exchange')
        require(pair['issuedNativeMs'] <= pair['nativeMs'] == pair['receivedNativeMs'] <= pair['returnedNativeMs'] <= pair['nativeAckMs'] and pair['jsReceiveMs'] >= pair['jsSendMs'], 'Invalid request-local native/JS timestamp order')
        require(pair['returnedNativeMs'] - pair['jsReceiveMs'] <= pair['receivedNativeMs'] - pair['jsSendMs'], 'JS roundtrip is shorter than native work')
    # Invoke the existing strict live-source checker. It freshly decodes with the supplied binary.
    command = [sys.executable, str(args.record_check), str(args.recording), '--binary', str(args.record_binary.resolve()), '--sync', str(args.sync), '--native-baseline-ms', str(result['nativeBaselineMs'])]
    acquisition = subprocess.run(command, capture_output=True, text=True, timeout=120)
    acquired = json.loads(acquisition.stdout)
    result['acquisition'] = acquired
    result['tools'] = {file.name: hashlib.sha256(file.read_bytes()).hexdigest() for file in (args.record_check, args.record_binary, args.pixel_binary)}
    pixels = {'verdict': 'invalid', 'reason': 'Acquisition/clock must pass before pixel time mapping'}
    if acquisition.returncode == 0 and acquired['verdict'] == 'acquisition-valid':
        baseline = next(frame for frame in data['frames'] if frame['sequence'] == args.baseline_sequence)
        recording = json.loads((args.recording / 'manifest.json').read_text())
        lower, upper = acquired['alignment']['offsetLowerMs'], acquired['alignment']['offsetUpperMs']
        reads = [row for row in map(json.loads, (args.recording / 'source.jsonl').read_text().splitlines()) if row['type'] == 'frame' and row['accepted']]
        reference = [row for row in reads if row['readEndMs'] + upper <= result['nativeBaselineMs'] and row['readStartMs'] + lower >= result['nativeBaselineMs'] - 50]
        require(reference, 'No actual coded reference exposure wholly before the event baseline')
        window = [row for row in reads if row['readEndMs'] + upper >= result['nativeBaselineMs'] - 250 and row['readStartMs'] + lower <= result['nativeBaselineMs'] + 4000]
        bounds, surface = baseline['windowBounds'], baseline['surfaceInWindow']
        require(finite(bounds['width']) and finite(bounds['height']) and bounds['width'] > 0 and bounds['height'] > 0, 'Missing actual native window geometry')
        scale = recording['width'] / bounds['width']
        require(abs(recording['height'] / bounds['height'] - scale) < .01, 'Native/window pixel aspect mismatch')
        rois = []
        for identifier in args.anchor:
            node = next(node for node in baseline['nodes'] if node['id'] == identifier)
            frame = node['frame']
            rois.append({'x': round((frame['x'] + surface['x'] - bounds['x']) * scale), 'y': round((frame['y'] + surface['y'] - bounds['y']) * scale), 'width': min(720, round(frame['width'] * scale)), 'height': min(72, round(frame['height'] * scale))})
        plan = {'width': recording['width'], 'height': recording['height'], 'pixelsPerPoint': scale, 'referencePTS': reference[-1]['ptsMs'], 'startPTS': window[0]['ptsMs'], 'endPTS': window[-1]['ptsMs'], 'rois': rois}
        with tempfile.TemporaryDirectory(prefix='history-pixels-', dir=args.capture.parent) as temporary:
            plan_file = Path(temporary) / 'plan.json'; plan_file.write_text(json.dumps(plan))
            measured = subprocess.run([str(args.pixel_binary.resolve()), str(args.recording / 'capture.mov'), str(plan_file)], capture_output=True, text=True, timeout=240)
            require(measured.returncode == 0, 'Actual coded-frame pixel decoder failed')
            pixels = json.loads(measured.stdout); pixels['plan'] = plan
    result['pixels'] = pixels
    result['verdict'] = 'red' if result['geometry'] == 'red' or pixels['verdict'] == 'red' else 'synthetic-production-window-pass' if result['nativeEffectObserved'] and pixels['verdict'] == 'within-coded-pixel-window' and acquisition.returncode == 0 and acquired['verdict'] == 'acquisition-valid' else 'invalid'
    result['scope'] = 'Actual staged production App/Chat, synthetic memory source; not original production53pt closure or proof of arbitrary sub-sample transients'
    return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('capture', type=Path)
    parser.add_argument('--manifest', required=True, type=Path)
    parser.add_argument('--baseline-sequence', required=True, type=int)
    parser.add_argument('--request-id', required=True, type=int)
    parser.add_argument('--anchor', action='append', required=True)
    parser.add_argument('--sync', required=True, type=Path)
    parser.add_argument('--recording', required=True, type=Path)
    parser.add_argument('--record-check', required=True, type=Path)
    parser.add_argument('--record-binary', required=True, type=Path)
    parser.add_argument('--pixel-binary', required=True, type=Path)
    try:
        result = run(parser.parse_args())
    except (ValueError, KeyError, IndexError, StopIteration, OSError, subprocess.SubprocessError) as failure:
        result = {'verdict': 'invalid', 'reason': str(failure), 'original53pt': 'unresolved'}
    print(json.dumps(result, indent=2))
    sys.exit(1 if result['verdict'] == 'red' else 0 if result['verdict'] == 'synthetic-production-window-pass' else 2)
