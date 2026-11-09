"""Pure fixtures/mocked drivers only. No device, engine, helper or Host access."""
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch


def load(name, file):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(file))
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    return module


moving = load('moving', 'moving-check.py')
smoke = load('smoke', 'smoke.py')


def fixture(shift=-53):
    ids = ['body-part-hp-0002-text', 'body-part-hp-0005-text', 'body-part-hp-0008-text']
    frames = []
    for index in range(1, 7):
        pan_y = (index - 1) * 2
        frames.append({'sequence': index, 'nativeUptimeMs': 1000 + index * 10, 'readEndNativeMs': 1000 + index * 10 + .2, 'screenScale': 3,
                       'surfaceInWindow': {}, 'windowBounds': {}, 'nativeFailure': False, 'presentedController': False,
                       'nodes': [{'id': identifier, 'instance': identifier + '-instance', 'fullyVisible': True, 'frame': {'x': 10, 'y': 180 + n * 130 + pan_y + (shift if index == 4 else 0), 'width': 150, 'height': 50}} for n, identifier in enumerate(ids)],
                       'scrolls': [{'id': 'transcript', 'instance': 'list', 'frame': {}, 'tracking': True, 'dragging': True, 'decelerating': False,
                                    'pan': {'instance': 'pan', 'generation': 1, 'boundaryRevision': 1, 'state': 2, 'coordinateSpace': 'surface', 'translationX': 0, 'translationY': pan_y, 'velocityX': 0, 'velocityY': 200, 'readStartNativeMs': 1000 + index * 10 + .05, 'readEndNativeMs': 1000 + index * 10 + .1}}]})
    frames[0]['nodes'] = copy.deepcopy(frames[0]['nodes'])
    frames[0]['scrolls'][0]['pan']['state'] = 0
    frames[0]['scrolls'][0]['tracking'] = False
    frames[0]['scrolls'][0]['dragging'] = False
    return {'schema': 1, 'synthetic': True, 'overflow': False, 'nativeFailure': False, 'identity': {}, 'processNonce': 'actual-process', 'frames': frames,
            'host': {'rejected': 0, 'mutations': 0, 'startupSweeps': 1, 'journalOverflow': False, 'journal': [
                {'phase': 'request', 'requestID': 17, 'nativeUptimeMs': 1031, 'path': '/api/session/history-production-500/message'},
                {'phase': 'history-response', 'requestID': 17, 'nativeUptimeMs': 1032, 'responseIDs': ['hp-' + str(n).zfill(4) for n in range(20)]}]},
            'events': [{'phase': 'mark', 'nonce': 'prior-mark', 'nativeUptimeMs': 1011, 'lastPeriodicSequence': 1, 'anchors': ids}]}


def chat_fixture(three=False):
    # Neutral text/geometry from cec5b612 a1: AX StaticText has no ID, native body does.
    capture = fixture(0); frame = capture['frames'][-1]
    bounds = {'x': 0, 'y': 0, 'width': 402, 'height': 874}
    frame.update({'windowBounds': bounds, 'surfaceInWindow': bounds})
    body = {'x': 80.66667175292969, 'y': 383.6661847432456, 'width': 297.3333435058594, 'height': 110.33333587646484}
    partial = {'x': 12, 'y': -42.6668345133462, 'width': 378, 'height': 360.3333435058594}
    frame['nodes'] = [{'id': 'body-part-hp-0498:text:0', 'instance': 'body-498', 'frame': body, 'visible': True, 'fullyVisible': True},
                      {'id': 'body-part-hp-0497:text:0', 'instance': 'body-497', 'frame': partial, 'visible': True, 'fullyVisible': False}]
    frame['scrolls'][0].update({'frame': bounds, 'tracking': False, 'dragging': False, 'decelerating': False})
    frame['scrolls'].append({'id': '', 'ownerID': 'body-part-hp-0497:text:0', 'frame': {'x': 13, 'y': 246.66650899251317, 'width': 376, 'height': 70}})
    children = [{'AXUniqueId': 'project-session-history-production-500', 'type': 'Button', 'enabled': True, 'frame': {'x': 12, 'y': 120, 'width': 300, 'height': 44}},
                {'AXUniqueId': 'chat-header-metadata', 'enabled': True, 'frame': {'x': 310, 'y': 68, 'width': 32, 'height': 32}},
                {'AXUniqueId': 'chat-selection', 'enabled': True, 'frame': {'x': 241, 'y': 787, 'width': 97, 'height': 26}},
                {'AXUniqueId': None, 'AXLabel': 'ANCHOR hp-0497\nno command is executed', 'type': 'StaticText', 'enabled': True, 'frame': {'x': 13, 'y': 246.66650899251317, 'width': 209, 'height': 70}},
                {'AXUniqueId': None, 'AXLabel': 'ANCHOR hp-0498', 'type': 'StaticText', 'enabled': True, 'frame': {**body, 'height': 25}}]
    if three:
        frame['nodes'][1].update({'frame': {'x': 12, 'y': 250, 'width': 378, 'height': 70}, 'fullyVisible': True})
        frame['nodes'].append({'id': 'body-part-hp-0494:text:0', 'instance': 'body-494', 'frame': {'x': 12, 'y': 170, 'width': 378, 'height': 70}, 'visible': True, 'fullyVisible': True})
        frame['scrolls'] = frame['scrolls'][:1]
        children[3]['frame'] = {'x': 13, 'y': 250, 'width': 209, 'height': 25}
        children.append({'AXUniqueId': None, 'AXLabel': 'ANCHOR hp-0494', 'type': 'StaticText', 'enabled': True, 'frame': {'x': 12, 'y': 170, 'width': 378, 'height': 25}})
    return [{'AXLabel': 'History Production QA', 'frame': bounds, 'children': children}], capture


class MovingTests(unittest.TestCase):
    def test_one_sample_53pt_red_despite_final_return(self):
        result = moving.diagnose(fixture(), 'prior-mark', 2, 6, 17)
        self.assertEqual(result['verdict'], 'moving-diagnostic-red')
        self.assertAlmostEqual(result['worst']['extraDisplacementLowerPt'], 53 - 2 / 3)
        self.assertEqual(result['samples'][-1]['extraDisplacementLowerPt'], 0)

    def test_pan_motion_alone_is_never_pass(self):
        result = moving.diagnose(fixture(0), 'prior-mark', 2, 6, 17)
        self.assertEqual(result['verdict'], 'inconclusive')

    def test_release_decel_identity_boundary_overflow_all_invalid(self):
        for key, value in [('decelerating', True), ('tracking', False), ('dragging', False)]:
            data = fixture(); data['frames'][3]['scrolls'][0][key] = value
            with self.assertRaises(ValueError):
                moving.diagnose(data, 'prior-mark', 2, 6, 17)
        for key, value in [('state', 3), ('generation', 2), ('boundaryRevision', 2), ('instance', 'recycled')]:
            data = fixture(); data['frames'][3]['scrolls'][0]['pan'][key] = value
            with self.assertRaises(ValueError):
                moving.diagnose(data, 'prior-mark', 2, 6, 17)
        data = fixture(); data['overflow'] = True
        with self.assertRaises(ValueError):
            moving.diagnose(data, 'prior-mark', 2, 6, 17)

    def test_no_missing_recycled_or_nonindependent_anchor(self):
        for action in ('missing', 'recycled', 'copy', 'same-message', 'clipped'):
            data = fixture()
            if action == 'missing': data['frames'][3]['nodes'].pop()
            if action == 'recycled': data['frames'][3]['nodes'][0]['instance'] = 'new'
            if action == 'copy':
                for frame in data['frames']: frame['nodes'][0]['id'] = 'history-copy-hp-0002'
                data['events'][0]['anchors'][0] = 'history-copy-hp-0002'
            if action == 'same-message':
                for frame in data['frames']: frame['nodes'][1]['id'] = 'body-part-hp-0002-second'
                data['events'][0]['anchors'][1] = 'body-part-hp-0002-second'
            if action == 'clipped': data['frames'][3]['nodes'][0]['fullyVisible'] = False
            with self.assertRaises(ValueError, msg=action):
                moving.diagnose(data, 'prior-mark', 2, 6, 17)

    def test_clock_ambiguity_wrong_process_reused_nonce_invalid(self):
        def pair(nonce, native):
            return {'nonce': nonce, 'identity': {}, 'processNonce': 'actual-process', 'hostClock': 'ProcessInfo.systemUptime milliseconds', 'nativeClock': 'ProcessInfo.systemUptime milliseconds', 'jsClock': 'performance.now milliseconds',
                    'hostSendMs': native - 1001, 'hostReceiveMs': native - 999, 'nativeMs': native, 'issuedNativeMs': native - .1, 'receivedNativeMs': native, 'returnedNativeMs': native + .1, 'nativeAckMs': native + .2, 'jsSendMs': 5, 'jsReceiveMs': 6}
        pairs = [pair('before', 500), pair('after', 6000)]
        self.assertEqual(moving.check_clock(pairs, fixture(), 1020, 1060)['offsetUpperMs'], 1001)
        for change in ('process', 'reuse', 'drift', 'uncertain'):
            modified = copy.deepcopy(pairs)
            if change == 'process': modified[1]['processNonce'] = 'other'
            if change == 'reuse': modified[1]['nonce'] = 'before'
            if change == 'drift': modified[1]['hostSendMs'] -= 100; modified[1]['hostReceiveMs'] -= 100
            if change == 'uncertain':
                for item in modified: item['hostSendMs'] -= 100; item['hostReceiveMs'] += 100
            with self.assertRaises(ValueError): moving.check_clock(modified, fixture(), 1020, 1060)


class DriverTests(unittest.TestCase):
    def test_null_ax_id_chat_and_native_body_correspondence(self):
        tree, capture = chat_fixture()
        self.assertTrue(smoke.chat_ready(tree, capture))
        targets = smoke.body_targets(tree, capture)
        self.assertEqual([node['messageID'] for node in targets], ['hp-0497', 'hp-0498'])
        self.assertTrue(targets[0]['nestedScroll'])
        source, destination, body = smoke.gesture_points(tree, capture)
        self.assertEqual(body['nativeID'], 'body-part-hp-0498:text:0')
        self.assertAlmostEqual(source['y'], (383.6661847432456 + 12.5) / 874)
        self.assertGreater(destination['y'], source['y'])
        with self.assertRaises(smoke.AnchorUnavailable): smoke.anchors(capture)
        tree[0]['children'][4]['AXLabel'] = 'A complete neutral paragraph exercises variable natural line wrapping.'
        self.assertEqual(smoke.gesture_points(tree, capture)[2]['messageID'], 'hp-0498')

    def test_body_label_geometry_and_production_controls_must_agree(self):
        tree, capture = chat_fixture()
        tree[0]['children'][4]['AXLabel'] = 'ANCHOR hp-0495'
        with self.assertRaises(ValueError): smoke.gesture_points(tree, capture)
        tree, capture = chat_fixture()
        capture['frames'][-1]['nodes'][0]['frame']['y'] += 100
        with self.assertRaises(ValueError): smoke.gesture_points(tree, capture)
        tree, capture = chat_fixture()
        tree[0]['children'][1]['AXUniqueId'] = 'unrelated-control'
        self.assertFalse(smoke.chat_ready(tree, capture))

    def test_stale_native_process_cannot_confirm_chat(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); data = root / 'data'; data.mkdir(); output = root / 'out'; output.mkdir()
            capture = chat_fixture()[1]; capture['processNonce'] = 'other-process'
            (data / 'capture.json').write_text(json.dumps(capture))
            driver = smoke.Smoke({'data': str(data), 'clockClient': 'never-run'}, output)
            driver.process = 'expected-process'; driver.identity = {}
            with patch.object(driver, 'command', return_value=''):
                with self.assertRaisesRegex(ValueError, 'Stale/wrong'):
                    driver.capture('probe.json')

    def test_exploration_response_is_never_postmarked_as_assessment(self):
        data = fixture()
        mark = {'nativeMs': 1011, 'nonce': 'prior-mark', 'phase': 'exploration', 'assessmentEndNativeMs': 1061}
        self.assertEqual(smoke.candidate_windows(data, [mark]), [])
        mark['phase'] = 'assessment'; mark['assessmentEndNativeMs'] = 1030
        self.assertEqual(smoke.candidate_windows(data, [mark]), [])
        del mark['assessmentEndNativeMs']
        self.assertEqual(smoke.candidate_windows(data, [mark]), [])

    def test_recorder_exit_blocks_ready_and_all_further_device_commands(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); ready = root / 'ready.json'; ready.write_text('{"status":"source-reading"}')
            driver = smoke.Smoke({}, root)
            class Recorder:
                def poll(self): return 7
            driver.recorder = Recorder()
            with patch.object(smoke.subprocess, 'run') as invoked:
                with self.assertRaisesRegex(ValueError, 'Recorder exited'):
                    driver.wait_json(ready, lambda value: True)
                with self.assertRaisesRegex(ValueError, 'Recorder exited'):
                    driver.command(['never-execute-tap'])
                invoked.assert_not_called()
            self.assertEqual(json.loads((root / 'recorder-exit.json').read_text())['returncode'], 7)
            self.assertFalse((root / 'recording/manifest.json').exists())

    def test_recorder_exit_during_command_is_detected_on_return(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); driver = smoke.Smoke({}, root)
            class Recorder:
                def __init__(self): self.reads = 0
                def poll(self):
                    self.reads += 1
                    return None if self.reads == 1 else 9
            driver.recorder = Recorder()
            result = smoke.subprocess.CompletedProcess(['mock-command'], 0, 'official return', '')
            with patch.object(smoke.subprocess, 'run', return_value=result):
                with self.assertRaisesRegex(ValueError, 'Recorder exited'):
                    driver.command(['mock-command'])
            self.assertEqual(json.loads((root / 'actions.json').read_text())[0]['returncode'], 0)
            self.assertEqual(json.loads((root / 'recorder-exit.json').read_text())['returncode'], 9)

    def test_success_orders_actual_ready_before_clock_taps_and_finishes_after_window(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); build = root / 'build'; build.mkdir(); data = root / 'data'; data.mkdir(); output = root / 'out'; output.mkdir()
            app = build / 'App.app'; (app / 'nsh').mkdir(parents=True)
            (app / 'HistoryProductionUIKit').write_bytes(b'executable'); (app / 'nsh/bundle.nshc').write_bytes(b'bytecode')
            clock = root / 'clock'; clock.write_bytes(b'clock'); record = root / 'record'; record.write_bytes(b'record'); check = root / 'check'; check.write_bytes(b'check')
            digest = lambda file: hashlib.sha256(file.read_bytes()).hexdigest()
            identity = {'buildID': 'test', 'bundleSHA256': digest(app / 'nsh/bundle.nshc'), 'executableSHA256': digest(app / 'HistoryProductionUIKit')}
            (build / 'manifest.json').write_text(json.dumps({**identity, 'observerContract': 'pan-read-v1;', 'bundleID': 'example.nsh.history-production.run-test', 'appBuilt': True, 'experimentOn': False, 'app': 'App.app', 'toolBinaries': {'clock-client': digest(clock)}}))
            config = {'build': str(build), 'data': str(data), 'clockClient': str(clock), 'recordBinary': str(record), 'recordCheck': str(check), 'udid': 'test', 'width': 300, 'height': 600, 'developerDir': 'unused', 'maxGestures': 2}
            observed = []; now = [0.0]; driver = smoke.Smoke(config, output)
            current = [False]
            def wait(file, predicate):
                observed.append(file.name)
                return {'processNonce': 'fresh', 'identity': identity} if file.name == 'ready.json' and file.parent == data else {'status': 'source-reading'}
            def clock_call():
                observed.append('clock'); now[0] += .01
                driver.clocks.append({'hostSendMs': now[0] * 1000, 'hostReceiveMs': now[0] * 1000 + 1})
            def capture(name):
                observed.append(name)
                current[0] = name.startswith(('before-01', 'after-01', 'capture'))
                value = chat_fixture(current[0])[1]
                if name.startswith('after-'): value['host']['journal'].append({'phase': 'history-response', 'requestID': 18, 'requestCursor': 'history.before.480'})
                return value
            def command(argv):
                observed.append(argv[2] if argv[0] == 'xcrun' else argv[2])
                return json.dumps({'anchors': smoke.anchors(chat_fixture(True)[1]), 'nonce': 'mark', 'nativeMs': 100}) if argv[-4] == 'mark' else ''
            class Recorder:
                def poll(self): return None
            with patch.object(driver, 'command', command), patch.object(driver, 'wait_json', wait), patch.object(driver, 'clock', clock_call), patch.object(driver, 'ax', side_effect=lambda: chat_fixture(current[0])[0]), patch.object(driver, 'tap', side_effect=lambda *args: observed.append('tap')), patch.object(driver, 'capture', capture), patch.object(driver, 'pan', side_effect=lambda *args: observed.append('pan')), patch.object(smoke.subprocess, 'Popen', return_value=Recorder()), patch.object(smoke.time, 'monotonic', side_effect=lambda: now[0]), patch.object(smoke.time, 'sleep', side_effect=lambda duration: now.__setitem__(0, now[0] + duration)):
                driver.work_end = 70
                result = driver.run()
            driver.recorder_log.close()
            self.assertEqual(result['verdict'], 'smoke-captured-awaiting-checkers')
            self.assertLess(observed.index('ready.json', 2), observed.index('clock'))
            self.assertLess(observed.index('clock'), observed.index('tap'))
            self.assertLess(observed.index('pan'), observed.index('capture.json'))
            self.assertGreaterEqual(now[0], 4.5)
            self.assertEqual([phase['phase'] for phase in driver.phases], ['exploration', 'assessment'])
            self.assertEqual(len(driver.marks), 1)
            self.assertIn('assessmentEndNativeMs', driver.marks[0])

    def test_offscreen_ax_never_becomes_tap(self):
        tree = [{'AXLabel': 'History Production QA', 'frame': {'x': 0, 'y': 0, 'width': 400, 'height': 800}, 'children': [{'AXUniqueId': 'history-load-older', 'enabled': True, 'frame': {'x': 10, 'y': -1640, 'width': 300, 'height': 44}}]}]
        with self.assertRaises(ValueError): smoke.target(tree, 'history-load-older')
        tree[0]['children'][0]['frame']['y'] = 200
        self.assertEqual(smoke.target(tree, 'history-load-older'), {'x': .4, 'y': .2775})

    def test_anchor_selection_stops_without_three_complete_bodies(self):
        data = fixture(); selected = smoke.anchors(data)
        self.assertEqual(len(selected), 3)
        data['frames'][-1]['nodes'] = data['frames'][-1]['nodes'][:2]
        with self.assertRaises(ValueError): smoke.anchors(data)

    def test_window_enumeration_does_not_remove_release(self):
        data = fixture()
        marks = [{'nativeMs': 1011, 'nonce': 'prior-mark', 'phase': 'assessment', 'assessmentEndNativeMs': 1061}]
        self.assertIsNone(smoke.candidate_windows(data, marks)[0]['invalidReason'])
        data['frames'][2]['scrolls'][0]['pan']['state'] = 3
        self.assertIsNotNone(smoke.candidate_windows(data, marks)[0]['invalidReason'])

    def test_failure_preserves_capture_clocks_and_finalizes_stops_app(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); data = root / 'data'; data.mkdir(); output = root / 'out'; output.mkdir()
            build = root / 'build'; build.mkdir(); (build / 'manifest.json').write_text(json.dumps({'bundleID': 'example.nsh.history-production.run-test'}))
            (data / 'capture.json').write_text(json.dumps(fixture()))
            (output / 'recording').mkdir()
            (output / 'recording/manifest.json').write_text('{"status":"complete"}')
            (output / 'recording/source.jsonl').write_text('{"type":"finalized"}\n')
            driver = smoke.Smoke({'data': str(data), 'build': str(build), 'clockClient': 'unused', 'udid': 'test'}, output)
            driver.process = 'actual-process'; driver.identity = {}; driver.launched = True
            class Recorder:
                returncode = 0
                def poll(self): return None
                def send_signal(self, value): self.signal = value
                def wait(self, timeout): pass
            recorder = Recorder(); driver.recorder = recorder; driver.recorder_log = (output / 'recorder.log').open('w')
            calls = []
            def command(argv, **kwargs):
                calls.append(argv)
                return json.dumps({'identity': {}, 'processNonce': 'actual-process'}) if argv[-1] == 'clock' else ''
            with patch.object(driver, 'command', command): result = driver.finish({'verdict': 'invalid', 'reason': 'insufficient anchors'})
            self.assertEqual(result['verdict'], 'invalid')
            self.assertTrue((output / 'final-capture.json').exists())
            self.assertTrue((output / 'native-sync.json').exists())
            self.assertEqual(calls[-1][:3], ['xcrun', 'simctl', 'terminate'])
            self.assertEqual(recorder.signal, smoke.signal.SIGINT)


if __name__ == '__main__':
    unittest.main()
