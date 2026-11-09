#!/usr/bin/env python3
"""Main-only <=90s real production smoke; import/tests never operate a device."""
import argparse
import hashlib
import importlib.util
import itertools
import json
import re
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import time


def require(value, reason):
    if not value:
        raise ValueError(reason)


def flat(nodes):
    return [item for node in nodes for item in [node, *flat(node.get('children') or [])]]


def visible(frame, bounds):
    return frame is not None and frame['width'] > 0 and frame['height'] > 0 and frame['x'] >= bounds['x'] and frame['y'] >= bounds['y'] and frame['x'] + frame['width'] <= bounds['x'] + bounds['width'] and frame['y'] + frame['height'] <= bounds['y'] + bounds['height']


def target(tree, identifier):
    require(tree and tree[0]['AXLabel'] == 'History Production QA', 'Wrong foreground App')
    require(not any(node.get('AXUniqueId') == 'hp-native-error' for node in flat(tree)), 'Native failure overlay')
    candidates = [node for node in flat(tree) if node.get('AXUniqueId') == identifier and node.get('enabled') and visible(node.get('frame'), tree[0]['frame'])]
    require(len(candidates) == 1, 'Need one enabled fully visible actual AX target: ' + identifier)
    frame, bounds = candidates[0]['frame'], tree[0]['frame']
    return {'x': (frame['x'] + frame['width'] / 2 - bounds['x']) / bounds['width'], 'y': (frame['y'] + frame['height'] / 2 - bounds['y']) / bounds['height']}


def body_targets(tree, capture):
    """Match public AX text ranges to actual native body views; AX need not expose testIDs."""
    require(tree and tree[0]['AXLabel'] == 'History Production QA', 'Wrong foreground App')
    require(capture['frames'] and not capture['overflow'] and not capture['nativeFailure'], 'Missing/invalid native body capture')
    frame = capture['frames'][-1]; bounds = tree[0]['frame']
    require(not frame.get('presentedController'), 'Presented controller obscures production body')
    window, surface = frame['windowBounds'], frame['surfaceInWindow']
    require(abs(bounds['width'] - window['width']) <= .5 and abs(bounds['height'] - window['height']) <= .5, 'AX/native window coordinate mismatch')
    def ax_rect(rect):
        return {**rect, 'x': rect['x'] + surface['x'] - window['x'] + bounds['x'], 'y': rect['y'] + surface['y'] - window['y'] + bounds['y']}
    transcript_rows = [row for row in frame['scrolls'] if row['id'] == 'transcript' or row.get('ownerID') == 'transcript']
    if not transcript_rows:
        return []
    require(len(transcript_rows) == 1, 'Ambiguous native transcript')
    viewport = ax_rect(transcript_rows[0]['frame'])
    bodies = [node for node in frame['nodes'] if node['id'].startswith('body-part-') and node['visible']]
    matches = []
    for text in flat(tree):
        label = text.get('AXLabel') or ''
        marker = re.match(r'^ANCHOR (hp-\d{4})(?!\d)(?:\s|$)', label)
        if text.get('type') != 'StaticText' or not text.get('enabled') or not label.strip() or not visible(text.get('frame'), bounds) or not visible(text['frame'], viewport):
            continue
        candidates = [node for node in bodies if (marker is None or re.search(r'(?<![a-zA-Z0-9])' + re.escape(marker.group(1)) + r'(?!\d)', node['id'])) and visible(text['frame'], ax_rect(node['frame']))]
        require(len(candidates) <= 1, 'Public AX body range maps to multiple native bodies')
        if not candidates:
            continue
        rect = text['frame']; node = candidates[0]
        identity = re.search(r'hp-\d{4}(?!\d)', node['id'])
        require(identity is not None, 'Native body has no synthetic message identity')
        point = {'x': rect['x'] + rect['width'] / 2, 'y': rect['y'] + rect['height'] / 2}
        # A code block's own Scroll must not be mistaken for the transcript gesture surface.
        nested_scroll = any(scroll.get('id') != 'transcript' and scroll.get('ownerID') != 'transcript' and visible({'x': point['x'], 'y': point['y'], 'width': .001, 'height': .001}, ax_rect(scroll['frame'])) for scroll in frame['scrolls'])
        matches.append({'messageID': identity.group(), 'correspondence': 'ANCHOR + native geometry' if marker else 'public natural text range + unique native geometry', 'axFrame': rect, 'nativeID': node['id'], 'nativeInstance': node['instance'], 'nativeFrame': ax_rect(node['frame']),
                        'point': {'x': (point['x'] - bounds['x']) / bounds['width'], 'y': (point['y'] - bounds['y']) / bounds['height']}, 'nestedScroll': nested_scroll})
    return matches


def chat_ready(tree, capture):
    bounds = tree[0]['frame']
    controls = {node.get('AXUniqueId') for node in flat(tree) if node.get('enabled') and visible(node.get('frame'), bounds)}
    return {'chat-header-metadata', 'chat-selection'}.issubset(controls) and bool(body_targets(tree, capture))


def gesture_points(tree, capture):
    # Gesture begins on actual visible body text, never guessed empty space or a repeated icon.
    nodes = [node for node in body_targets(tree, capture) if not node['nestedScroll']]
    require(nodes, 'No actual visible AX body text range verified against native body for transcript scrolling')
    node = min(nodes, key=lambda item: (item['axFrame']['y'], item['axFrame']['x'], item['nativeID']))
    source = node['point']
    destination = {'x': source['x'], 'y': min(.76, source['y'] + .24)}
    require(destination['y'] - source['y'] >= .1, 'No visible safe downward pan corridor')
    return source, destination, node


def moving_module():
    spec = importlib.util.spec_from_file_location('history_moving', Path(__file__).with_name('moving-check.py'))
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    return module


class AnchorUnavailable(ValueError):
    pass


def anchors(capture):
    require(not capture['overflow'] and not capture['nativeFailure'], 'Native capture overflow/failure')
    frame = capture['frames'][-1]
    candidates = [node for node in frame['nodes'] if node['id'].startswith('body-part-') and node['fullyVisible']]
    # Choose before input, deterministically by actual geometry; no quality/post-outcome search.
    candidates.sort(key=lambda node: (node['frame']['y'], node['id']))
    module = moving_module()
    for combination in itertools.combinations(candidates, 3):
        try:
            module.independent(combination)
            return [node['id'] for node in combination]
        except ValueError:
            continue
    raise AnchorUnavailable('Fewer than three complete independent body anchors; no copy-icon fallback')


def candidate_windows(capture, marks):
    """Enumerate every actual request, never choose the least-moving frame or anchors."""
    module = moving_module(); frames = capture['frames']; windows = []
    for request in capture['host']['journal']:
        if request['phase'] != 'request' or '/message?' not in request['path'] and not request['path'].endswith('/message'):
            continue
        responses = [event for event in capture['host']['journal'] if event['phase'] == 'history-response' and event['requestID'] == request['requestID']]
        if len(responses) != 1:
            continue
        prior = [mark for mark in marks if mark.get('phase') == 'assessment' and mark['nativeMs'] < request['nativeUptimeMs'] <= mark.get('assessmentEndNativeMs', -1)]
        if not prior:
            continue
        mark = prior[-1]
        # Exact changed-state runs; no deletion of release/decel or gaps from inside a run.
        runs, run, identity = [], [], None
        for frame in frames:
            try:
                view = module.transcript(frame); pan = view['pan']
                eligible = view['tracking'] and view['dragging'] and not view['decelerating'] and pan['state'] == 2 and pan['generation'] > 0
                key = (view['instance'], pan['instance'], pan['generation'], pan['boundaryRevision']) if eligible else None
            except (KeyError, ValueError):
                key = None
            if key != identity or key is None:
                if run:
                    runs.append(run)
                run = []
            identity = key
            if key is not None:
                run.append(frame)
        if run:
            runs.append(run)
        matching = [run for run in runs if len(run) >= 3 and mark['nativeMs'] < run[0]['nativeUptimeMs'] <= request['nativeUptimeMs'] <= responses[0]['nativeUptimeMs'] <= run[-1]['readEndNativeMs']]
        windows.append({'requestID': request['requestID'], 'markNonce': mark['nonce'], 'firstSequence': matching[0][0]['sequence'] if len(matching) == 1 else None,
                        'lastSequence': matching[0][-1]['sequence'] if len(matching) == 1 else None,
                        'invalidReason': None if len(matching) == 1 else 'No unique continuous changed run bracketing request/response'})
    return windows


class Smoke:
    def __init__(self, config, output):
        self.config, self.output = config, output
        self.started = time.monotonic(); self.work_end = self.started + 70; self.hard_end = self.started + 90
        self.actions, self.clocks, self.marks = [], [], []
        self.recorder = None; self.recorder_log = None; self.launched = False; self.touching = False
        self.last_touch = None; self.process = None; self.ax_index = 0
        self.phase = 'startup'; self.phases = []

    def save(self, name, data):
        (self.output / name).write_text(json.dumps(data, indent=2))

    def ensure_recording(self):
        if self.recorder is not None:
            status = self.recorder.poll()
            if status is not None:
                self.save('recorder-exit.json', {'returncode': status, 'phase': self.phase, 'driverMonotonicMs': time.monotonic_ns() / 1e6,
                                                 'verdict': 'invalid', 'log': 'recorder.log', 'finalization': 'not inferred; preserve source files'})
                raise ValueError('Recorder exited before requested finalization; see recorder.log (returncode %s)' % status)

    def command(self, argv, timeout=5, cleanup=False):
        if not cleanup:
            self.ensure_recording()
        remaining = (self.hard_end if cleanup else self.work_end) - time.monotonic()
        require(remaining > .1, 'Smoke deadline reached')
        action = {'argv': [str(arg) for arg in argv], 'sendDriverMonotonicMs': time.monotonic_ns() / 1e6, 'clock': 'Python monotonic; not native receive ACK', 'phase': self.phase}
        self.actions.append(action)
        try:
            result = subprocess.run(action['argv'], capture_output=True, text=True, timeout=min(timeout, remaining))
            action.update({'returnDriverMonotonicMs': time.monotonic_ns() / 1e6, 'returncode': result.returncode, 'stdout': result.stdout, 'stderr': result.stderr})
            if not cleanup:
                self.ensure_recording()
            require(result.returncode == 0, 'Official command failed: ' + str(argv[0]))
            return result.stdout.strip()
        finally:
            self.save('actions.json', self.actions)

    def wait_json(self, file, predicate, seconds=5):
        deadline = min(self.work_end, time.monotonic() + seconds)
        while time.monotonic() < deadline:
            self.ensure_recording()
            try:
                result = json.loads(file.read_text())
                if predicate(result):
                    return result
            except (FileNotFoundError, json.JSONDecodeError):
                pass
            time.sleep(.02)
        raise ValueError('Missing actual fresh ready/ACK: ' + str(file.name))

    def ax(self):
        self.ensure_recording()
        self.ax_index += 1
        # Use stdlib HTTP, never launch a server/helper or contact a business Host.
        import urllib.request
        require(time.monotonic() < self.work_end, 'AX deadline')
        with urllib.request.urlopen(self.config['helperOrigin'].rstrip('/') + '/helper/' + self.config['udid'] + '/ax', timeout=min(3, self.work_end - time.monotonic())) as response:
            tree = json.load(response)
        self.save('ax-%02d.json' % self.ax_index, tree)
        self.ensure_recording()
        require(tree and tree[0]['AXLabel'] == 'History Production QA', 'Wrong foreground application')
        require(not any(node.get('AXUniqueId') == 'hp-native-error' for node in flat(tree)), 'Native failure overlay')
        return tree

    def tap(self, tree, identifier):
        point = target(tree, identifier)
        self.command([*self.config['serveSim'], 'tap', str(point['x']), str(point['y']), '-d', self.config['udid'], '--url', self.config['helperOrigin']])

    def clock(self):
        ack = json.loads(self.command([self.config['clockClient'], self.config['data'], 'clock']))
        require(ack.get('processNonce') == self.process and ack['identity'] == self.identity, 'Wrong process/build clock')
        self.clocks.append(ack); self.save('native-sync.json', self.clocks)

    def capture(self, name):
        self.command([self.config['clockClient'], self.config['data'], 'flush'])
        data = Path(self.config['data']) / 'capture.json'
        shutil.copyfile(data, self.output / name)
        capture = json.loads((self.output / name).read_text())
        require(capture.get('processNonce') == self.process and capture['identity'] == self.identity and not capture['overflow'] and not capture['nativeFailure'], 'Stale/wrong/invalid native capture')
        require(capture['host']['startupSweeps'] >= 1 and capture['host']['rejected'] == capture['host']['mutations'] == 0, 'Startup/Host audit failed')
        return capture

    def settled_capture(self, name):
        deadline = min(self.work_end, time.monotonic() + 2.5)
        capture = self.capture(name)
        attempt = 0
        while True:
            view = moving_module().transcript(capture['frames'][-1])
            if not any(view[key] for key in ('tracking', 'dragging', 'decelerating')):
                return capture
            self.ensure_recording()
            require(time.monotonic() < deadline, 'Previous navigation gesture has not reached actual native rest')
            time.sleep(.05); attempt += 1
            capture = self.capture(name.replace('.json', '-rest-%02d.json' % attempt))

    def pan(self, tree, capture):
        source, destination, body = gesture_points(tree, capture)
        self.save('gesture-body-%02d.json' % len(self.phases), {'phase': self.phase, 'source': source, 'destination': destination, 'body': body,
                                                             'nativeSequence': capture['frames'][-1]['sequence'], 'scope': 'actual AX text/native correspondence; not a three-anchor mark'})
        self.last_touch = source
        self.touching = True
        self.command([*self.config['serveSim'], 'gesture', json.dumps({'type': 'begin', **source}), '-d', self.config['udid'], '--url', self.config['helperOrigin']])
        for index in range(1, 13):
            self.last_touch = {'x': source['x'], 'y': source['y'] + (destination['y'] - source['y']) * index / 12}
            self.command([*self.config['serveSim'], 'gesture', json.dumps({'type': 'move', **self.last_touch}), '-d', self.config['udid'], '--url', self.config['helperOrigin']])
        self.command([*self.config['serveSim'], 'gesture', json.dumps({'type': 'end', **destination}), '-d', self.config['udid'], '--url', self.config['helperOrigin']])
        self.touching = False

    def run(self):
        c = self.config
        build = Path(c['build']); manifest = json.loads((build / 'manifest.json').read_text())
        require(manifest['appBuilt'] and manifest['experimentOn'] is False and manifest['bundleID'].startswith('example.nsh.history-production.run-'), 'Need isolated OFF artifact')
        require(manifest.get('observerContract', '').startswith('pan-read-v1;'), 'Need a new pan-read-v1 artifact; frozen normal 1bb480cd must not be reused for this driver')
        self.identity = {key: manifest[key] for key in ('buildID', 'bundleSHA256', 'executableSHA256')}
        self.save('artifact-manifest.json', manifest)
        require(hashlib.sha256(Path(c['clockClient']).read_bytes()).hexdigest() == manifest['toolBinaries']['clock-client'], 'Wrong clock-client binary')
        self.save('driver-tools.json', {name: hashlib.sha256(Path(c[name]).read_bytes()).hexdigest() for name in ('clockClient', 'recordBinary', 'recordCheck')})
        self.save('driver-source-hashes.json', {name: hashlib.sha256(Path(__file__).with_name(name).read_bytes()).hexdigest() for name in ('smoke.py', 'moving-check.py')})
        for file, expected in [(build / manifest['app'] / 'HistoryProductionUIKit', manifest['executableSHA256']), (build / manifest['app'] / 'nsh/bundle.nshc', manifest['bundleSHA256'])]:
            require(hashlib.sha256(file.read_bytes()).hexdigest() == expected, 'Artifact hash mismatch')
        # Archive the prior run; never reset/truncate capture files to simulate a fresh process.
        data = Path(c['data']); old_nonce = None
        for name in ('capture.json', 'ready.json', 'failure.json'):
            if (data / name).exists():
                shutil.copyfile(data / name, self.output / ('previous-' + name))
        if (data / 'ready.json').exists():
            old_nonce = json.loads((data / 'ready.json').read_text()).get('processNonce')
        self.launched = True
        self.command(['xcrun', 'simctl', 'launch', '--terminate-running-process', c['udid'], manifest['bundleID']])
        ready = self.wait_json(data / 'ready.json', lambda value: bool(value.get('processNonce')) and value['processNonce'] != old_nonce)
        require(ready['identity'] == self.identity, 'Fresh ready build mismatch')
        self.process = ready['processNonce']; self.save('app-ready.json', ready)
        recording = self.output / 'recording'
        self.recorder_log = (self.output / 'recorder.log').open('w')
        self.recorder = subprocess.Popen([c['recordBinary'], 'capture', c['udid'], str(c['width']), str(c['height']), '70', str(recording), c['developerDir'], '--live-source-authorized'], stdout=self.recorder_log, stderr=subprocess.STDOUT)
        record_ready = self.wait_json(recording / 'ready.json', lambda value: value.get('status') == 'source-reading')
        self.save('record-ready.json', record_ready)
        for _ in range(3):
            self.clock()
        tree = self.ax()
        session = 'project-session-history-production-500'
        if not any(node.get('AXUniqueId') == session and visible(node.get('frame'), tree[0]['frame']) for node in flat(tree)):
            self.tap(tree, 'projects-toggle-history-project'); tree = self.ax()
        self.tap(tree, session)
        # Await actual Chat AX, without mutating navigation or delaying a history response.
        deadline = min(self.work_end, time.monotonic() + 4)
        probe = 0
        while True:
            tree = self.ax()
            controls = {node.get('AXUniqueId') for node in flat(tree) if node.get('enabled') and visible(node.get('frame'), tree[0]['frame'])}
            if {'chat-header-metadata', 'chat-selection'}.issubset(controls):
                probe += 1
                initial = self.capture('chat-probe-%02d.json' % probe)
                if chat_ready(tree, initial):
                    self.save('chat-ready.json', {'processNonce': self.process, 'identity': self.identity, 'nativeSequence': initial['frames'][-1]['sequence'],
                                                  'bodyCorrespondence': body_targets(tree, initial), 'scope': 'production controls + actual native body/public AX text; no AX testID assumption'})
                    break
            require(time.monotonic() < deadline, 'Production Chat body did not become visible')
            time.sleep(.05)
        self.save('chat.json', initial)
        found = False
        for index in range(c.get('maxGestures', 6)):
            self.phase = 'navigation-rest'
            before = self.settled_capture('before-%02d.json' % index)
            try:
                selected = anchors(before)
            except AnchorUnavailable:
                selected = None
            self.phase = 'assessment' if selected else 'exploration'
            entry = {'index': index, 'phase': self.phase, 'beforeNativeMs': before['frames'][-1]['readEndNativeMs'], 'beforeSequence': before['frames'][-1]['sequence'],
                     'scope': 'premarked assessment attempt' if selected else 'navigation-only; insufficient three independent bodies; never acceptance', 'anchors': selected}
            self.phases.append(entry); self.save('phases.json', self.phases)
            if selected:
                mark = json.loads(self.command([c['clockClient'], c['data'], 'mark', *selected]))
                require(mark['anchors'] == selected, 'Native mark ACK mismatch')
                mark['phase'] = 'assessment'
                self.marks.append(mark); self.save('marks.json', self.marks)
            tree = self.ax()
            footer = [node for node in flat(tree) if node.get('AXUniqueId') == 'history-load-older' and node.get('enabled') and visible(node.get('frame'), tree[0]['frame'])]
            if footer:
                self.tap(tree, 'history-load-older')
            else:
                self.pan(tree, before)
            after = self.capture('after-%02d.json' % index)
            entry['afterNativeMs'] = after['frames'][-1]['readEndNativeMs']; entry['afterSequence'] = after['frames'][-1]['sequence']
            old_responses = {event['requestID'] for event in before['host']['journal'] if event['phase'] == 'history-response'}
            entry['newResponseIDs'] = [event['requestID'] for event in after['host']['journal'] if event['phase'] == 'history-response' and event['requestID'] not in old_responses]
            entry['newOlderResponseIDs'] = [event['requestID'] for event in after['host']['journal'] if event['phase'] == 'history-response' and event['requestID'] not in old_responses and isinstance(event.get('requestCursor'), str)]
            if selected:
                mark['assessmentEndNativeMs'] = entry['afterNativeMs']; self.save('marks.json', self.marks)
            self.save('phases.json', self.phases)
            if selected and entry['newOlderResponseIDs']:
                found = True; break
        require(found, 'No older page response in a premarked three-independent-body assessment within navigation/time budget; exploration is not acceptance')
        self.phase = 'post-observation'
        # Full existing acquisition window remains four seconds; actual clocks/PTS, never nominal fps.
        last_mark_time = self.clocks[-1]['hostReceiveMs']
        until = time.monotonic() + 4.5
        require(until < self.work_end, 'Insufficient remaining full observation window')
        while time.monotonic() < until:
            self.ensure_recording()
            time.sleep(.02)
        for _ in range(3):
            self.clock()
        require(self.clocks[-1]['hostSendMs'] > last_mark_time, 'No fresh after exchange')
        self.capture('capture.json'); self.ax()
        return {'verdict': 'smoke-captured-awaiting-checkers', 'processNonce': self.process, 'stationaryAcceptance': 'not evaluated', 'original53pt': 'unresolved'}

    def finish(self, result):
        self.phase = 'cleanup'
        errors = []
        if self.touching:
            try:
                self.command([*self.config['serveSim'], 'gesture', json.dumps({'type': 'end', **self.last_touch}), '-d', self.config['udid'], '--url', self.config['helperOrigin']], timeout=2, cleanup=True)
                self.touching = False
            except Exception as error:
                errors.append('touch cleanup: ' + str(error))
        if self.process:
            if result['verdict'] == 'invalid':
                try:
                    ack = json.loads(self.command([self.config['clockClient'], self.config['data'], 'clock'], timeout=2, cleanup=True))
                    require(ack.get('processNonce') == self.process and ack['identity'] == self.identity, 'Wrong cleanup clock identity')
                    self.clocks.append(ack); self.save('native-sync.json', self.clocks)
                except Exception as error:
                    errors.append('after-clock: ' + str(error))
            try:
                self.command([self.config['clockClient'], self.config['data'], 'flush'], timeout=2, cleanup=True)
                shutil.copyfile(Path(self.config['data']) / 'capture.json', self.output / 'final-capture.json')
            except Exception as error:
                errors.append('flush: ' + str(error))
        if self.recorder is not None:
            if self.recorder.poll() is None:
                self.recorder.send_signal(signal.SIGINT)
            try:
                self.recorder.wait(timeout=max(.1, min(7, self.hard_end - time.monotonic())))
                manifest = json.loads((self.output / 'recording/manifest.json').read_text())
                ledger = (self.output / 'recording/source.jsonl').read_text().splitlines()
                require(self.recorder.returncode == 0 and manifest['status'] == 'complete' and json.loads(ledger[-1])['type'] == 'finalized', 'Recorder not finalized')
            except Exception as error:
                errors.append('finalize: ' + str(error))
                if self.recorder.poll() is None:
                    self.recorder.kill(); self.recorder.wait(timeout=1)
            self.recorder_log.close()
        if self.launched:
            try:
                self.command(['xcrun', 'simctl', 'terminate', self.config['udid'], json.loads((Path(self.config['build']) / 'manifest.json').read_text())['bundleID']], timeout=3, cleanup=True)
            except Exception as error:
                errors.append('terminate isolated App: ' + str(error))
        if errors:
            result = {'verdict': 'invalid', 'reason': result, 'cleanupErrors': errors}
        result['elapsedSeconds'] = time.monotonic() - self.started
        result['stationaryAcceptance'] = 'not evaluated'; result['original53pt'] = 'unresolved'
        self.save('smoke-result.json', result)
        return result

    def diagnostics(self):
        """Offline after the bounded device lifetime; red or invalid/inconclusive only."""
        capture_file = self.output / 'final-capture.json'
        if not capture_file.exists():
            return
        capture = json.loads(capture_file.read_text())
        windows = candidate_windows(capture, self.marks)
        self.save('moving-windows.json', windows)
        for index, window in enumerate(windows):
            if window['invalidReason']:
                self.save('moving-%02d.json' % index, {'verdict': 'invalid', 'reason': window['invalidReason'], 'original53pt': 'unresolved'})
                continue
            command = [sys.executable, str(Path(__file__).with_name('moving-check.py')), str(capture_file), '--manifest', str(self.output / 'artifact-manifest.json'),
                       '--sync', str(self.output / 'native-sync.json'), '--recording', str(self.output / 'recording'), '--record-check', self.config['recordCheck'], '--record-binary', self.config['recordBinary'],
                       '--mark-nonce', window['markNonce'], '--first-sequence', str(window['firstSequence']), '--last-sequence', str(window['lastSequence']), '--request-id', str(window['requestID'])]
            checked = subprocess.run(command, capture_output=True, text=True, timeout=130)
            (self.output / ('moving-%02d.stdout' % index)).write_text(checked.stdout)
            (self.output / ('moving-%02d.stderr' % index)).write_text(checked.stderr)
            try:
                verdict = json.loads(checked.stdout)
            except json.JSONDecodeError:
                verdict = {'verdict': 'invalid', 'reason': 'Moving checker did not emit JSON'}
            self.save('moving-%02d.json' % index, verdict)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', required=True, type=Path)
    parser.add_argument('--output', required=True, type=Path)
    parser.add_argument('--execute-main-only', action='store_true')
    args = parser.parse_args()
    require(args.execute_main_only, 'Only main may explicitly execute device smoke; omit flag for no device actions')
    config = json.loads(args.config.read_text())
    require(isinstance(config['serveSim'], list) and config['serveSim'] and all(isinstance(arg, str) for arg in config['serveSim']), 'serveSim must be an installed official CLI argv array')
    require(1 <= config.get('maxGestures', 6) <= 8 and all(isinstance(config[key], int) and config[key] > 0 for key in ('width', 'height')), 'Invalid bounded smoke config')
    from urllib.parse import urlparse
    parsed = urlparse(config['helperOrigin'])
    require(parsed.scheme == 'http' and parsed.hostname in ('127.0.0.1', 'localhost') and not parsed.username and not parsed.password and parsed.path in ('', '/'), 'Only existing local simulator helper origin')
    args.output.mkdir(parents=True, exist_ok=False)
    smoke = Smoke(config, args.output)
    smoke.save('config.json', config)
    def deadline(_signal, _frame):
        raise TimeoutError('70-second device work deadline; preserving evidence and cleaning up')
    previous_handler = signal.signal(signal.SIGALRM, deadline)
    signal.setitimer(signal.ITIMER_REAL, max(.01, smoke.work_end - time.monotonic()))
    try:
        result = smoke.run()
    except (Exception, KeyboardInterrupt) as error:
        result = {'verdict': 'invalid', 'reason': str(error)}
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, previous_handler)
        result = smoke.finish(result)
    try:
        smoke.diagnostics()
    except (ValueError, KeyError, TypeError, OSError, subprocess.SubprocessError) as error:
        smoke.save('moving-diagnostic-error.json', {'verdict': 'invalid', 'reason': str(error)})
    print(json.dumps(result, indent=2))
    return 0 if result['verdict'] == 'smoke-captured-awaiting-checkers' else 2


if __name__ == '__main__':
    sys.exit(main())
