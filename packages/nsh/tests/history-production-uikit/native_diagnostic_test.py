"""Native diagnostic fixtures and mocked IO only; no engine, device, SDK or Host."""
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


diagnostic = load('native_diagnostic', 'native-diagnostic.py')
fixtures = load('native_diagnostic_fixtures', 'feedback_test.py')


def reading_fixture(shift=-53):
    data = fixtures.fixture(0)
    template = copy.deepcopy(data['frames'][0]); template['screenScale'] = 3
    frames = []
    for index in range(1, 121):
        frame = copy.deepcopy(template)
        frame.update({'sequence': index, 'nativeUptimeMs': 1000 + index * 1000 / 60, 'readEndNativeMs': 1000 + index * 1000 / 60 + .2})
        for node in frame['nodes']:
            if index == 60: node['frame']['y'] += shift
        view = frame['scrolls'][0]
        view.update({'offsetY': 100 + (-shift if index == 60 else 0), 'contentHeight': 2000, 'tracking': False, 'dragging': False, 'decelerating': False})
        frames.append(frame)
    data['frames'] = frames
    ids = [node['id'] for node in template['nodes']]
    data['events'] = [{'phase': 'mark', 'nonce': 'native-mark', 'nativeUptimeMs': 1501, 'lastPeriodicSequence': 30, 'anchors': ids}]
    data['host']['journal'] = [{'phase': 'request', 'requestID': 17, 'nativeUptimeMs': 1510, 'path': '/api/session/history-production-500/message'},
                              {'phase': 'history-response', 'requestID': 17, 'nativeUptimeMs': 1520, 'requestCursor': 'history.before.480', 'responseIDs': ['hp-' + str(n).zfill(4) for n in range(20)]}]
    attempt = {'mode': 'pagination', 'input': 'tap', 'target': 'history-load-older', 'endSequence': 110,
               'mark': {'nonce': 'native-mark', 'anchors': ids, 'baselineSequence': 30, 'nativeMs': 1502}}
    pairs = []
    for nonce, native in [('before', 1100), ('after', 4000)]:
        pairs.append({'nonce': nonce, 'identity': {}, 'processNonce': data['processNonce'], 'hostClock': 'ProcessInfo.systemUptime milliseconds', 'nativeClock': 'ProcessInfo.systemUptime milliseconds', 'jsClock': 'performance.now milliseconds',
                      'hostSendMs': native - 1001, 'hostReceiveMs': native - 999, 'nativeMs': native, 'issuedNativeMs': native - .1, 'receivedNativeMs': native, 'returnedNativeMs': native + .1, 'nativeAckMs': native + .2, 'jsSendMs': 5, 'jsReceiveMs': 6})
    return data, attempt, pairs


def compact_fixture():
    # Reduced actual nativeDiag a1 pagination-01 pair; no native header identity was captured.
    tree, capture = fixtures.chat_fixture(); frame = capture['frames'][-1]
    body497 = {'x': 12, 'y': 157.3333282470703, 'width': 378, 'height': 360.3333435058594}
    body498 = {'x': 80.66667175292969, 'y': 583.6663475036621, 'width': 297.3333435058594, 'height': 110.33333587646484}
    body495 = {'x': 80.66667175292969, 'y': -60.99991226196289, 'width': 297.3333435058594, 'height': 110.33333587646484}
    frame['nodes'] = [{'id': 'body-part-hp-0497:text:0', 'instance': 'old-body497', 'frame': body497, 'visible': True, 'fullyVisible': True},
                      {'id': 'body-part-hp-0498:text:0', 'instance': 'old-body498', 'frame': body498, 'visible': True, 'fullyVisible': True},
                      {'id': 'body-part-hp-0495:text:0', 'instance': 'old-body495', 'frame': body495, 'visible': True, 'fullyVisible': False}]
    frame['scrolls'] = frame['scrolls'][:2]
    frame['scrolls'][1]['frame']['y'] = 446.6666717529297
    frame['controlAncestors'] = [{'instance': 'footer-ancestor', 'class': 'NshView', 'role': 'ancestor-0-of-history-load-older', 'frame': {'x': 12, 'y': -3766, 'width': 378, 'height': 44}},
                                 {'instance': 'full-window', 'class': 'UINavigationTransitionView', 'role': 'ancestor-7-of-history-load-older', 'frame': {'x': 0, 'y': 0, 'width': 402, 'height': 874}}]
    tree[0]['children'] = [{'AXUniqueId': None, 'AXLabel': 'ANCHOR hp-0497', 'type': 'StaticText', 'enabled': True, 'frame': {**body497, 'height': 25}},
                           {'AXUniqueId': None, 'AXLabel': 'ANCHOR hp-0497\nno command is executed', 'type': 'StaticText', 'enabled': True, 'frame': {'x': 13, 'y': 446.6666717529297, 'width': 209, 'height': 70}},
                           {'AXUniqueId': None, 'AXLabel': 'ANCHOR hp-0498', 'type': 'StaticText', 'enabled': True, 'frame': {**body498, 'height': 25}},
                           {'AXUniqueId': 'compact-attach', 'type': 'Button', 'enabled': True, 'frame': {'x': 48.33332824707031, 'y': 786, 'width': 32, 'height': 32}},
                           {'AXUniqueId': 'compact-edit', 'type': 'Button', 'enabled': True, 'frame': {'x': 84.33332824707031, 'y': 780, 'width': 161.3333282470703, 'height': 44}},
                           {'AXUniqueId': 'compact-dictation', 'type': 'Button', 'enabled': True, 'frame': {'x': 249.66665649414062, 'y': 786, 'width': 32, 'height': 32}},
                           {'AXUniqueId': 'compact-latest', 'type': 'Button', 'enabled': True, 'frame': {'x': 285.66664123535156, 'y': 786, 'width': 32, 'height': 32}},
                           {'AXUniqueId': 'compact-send', 'type': 'Button', 'enabled': False, 'frame': {'x': 321.6666717529297, 'y': 786, 'width': 32, 'height': 32}}]
    return tree, capture


class NativeDiagnosticTests(unittest.TestCase):
    def test_a2_bottom_marker_uses_actual_composer_edge_not_fixed_point76(self):
        tree, capture = compact_fixture(); frame = capture['frames'][-1]
        body = frame['nodes'][2]
        body.update({'frame': {'x': 80.66667175292969, 'y': 641.6667544047036, 'width': 297.3333435058594, 'height': 110.33333587646484}, 'fullyVisible': True})
        tree[0]['children'] = [node for node in tree[0]['children'] if node.get('type') != 'StaticText']
        tree[0]['children'].append({'AXUniqueId': None, 'AXLabel': 'ANCHOR hp-0495', 'type': 'StaticText', 'enabled': True, 'frame': {**body['frame'], 'height': 25}})
        source, end, target = diagnostic.body_gesture(tree, capture, .5)
        self.assertGreater(target['intendedDistancePt'], 100)
        self.assertAlmostEqual(end['y'] * 874, 780 - 1 / 3)
        self.assertGreater(end['y'], .76)
        self.assertEqual(target['nativeID'], 'body-part-hp-0495:text:0')

    def test_alarm_delivery_during_cancel_does_not_interrupt_result_persistence(self):
        with tempfile.TemporaryDirectory() as temporary:
            runner = diagnostic.NativeDiagnostic({}, Path(temporary))
            runner.phases = [{'mode': 'pagination', 'purpose': 'exploration-only'}]
            def timer(_which, value):
                if value == 0:
                    handler = diagnostic.signal.getsignal(diagnostic.signal.SIGALRM)
                    if callable(handler): handler(diagnostic.signal.SIGALRM, None)
                return (0, 0)
            with patch.object(runner, 'run'), patch.object(diagnostic.signal, 'setitimer', side_effect=timer):
                result = diagnostic.execute_runner(runner)
            self.assertEqual(result['verdict'], 'inconclusive')
            self.assertTrue(result['deadlineExceeded'])
            self.assertIn('deadline-exceeded', result['reason'])
            self.assertEqual(json.loads((runner.output / 'phases.json').read_text()), runner.phases)
            self.assertEqual(json.loads((runner.output / 'result.json').read_text())['verdict'], 'inconclusive')

    def test_actual_pending_alarm_is_blocked_discarded_and_never_rethrown(self):
        with tempfile.TemporaryDirectory() as temporary:
            runner = diagnostic.NativeDiagnostic({}, Path(temporary)); deadline = diagnostic.WorkDeadline(runner)
            previous = diagnostic.signal.getsignal(diagnostic.signal.SIGALRM)
            mask = diagnostic.signal.pthread_sigmask(diagnostic.signal.SIG_BLOCK, {diagnostic.signal.SIGALRM})
            try:
                deadline.start()
                diagnostic.signal.raise_signal(diagnostic.signal.SIGALRM)
                self.assertIn(diagnostic.signal.SIGALRM, diagnostic.signal.sigpending())
                self.assertEqual(deadline.disarm(), [])
                self.assertTrue(deadline.expired)
                self.assertNotIn(diagnostic.signal.SIGALRM, diagnostic.signal.sigpending())
                runner.finish('deadline-exceeded')
                deadline.restore()
                self.assertTrue((runner.output / 'result.json').exists())
            finally:
                diagnostic.signal.setitimer(diagnostic.signal.ITIMER_REAL, 0)
                diagnostic.signal.signal(diagnostic.signal.SIGALRM, previous)
                diagnostic.signal.pthread_sigmask(diagnostic.signal.SIG_SETMASK, mask)

    def test_a2_inflight_flush_remains_unacknowledged_when_cleanup_fails(self):
        with tempfile.TemporaryDirectory() as temporary:
            runner = diagnostic.NativeDiagnostic({}, Path(temporary)); runner.process = 'attached'; runner.deadline_expired = True
            runner.actions = [{'argv': ['official', 'gesture', '{"type":"end"}'], 'returncode': 0}, {'argv': ['clock', 'data', 'flush'], 'status': 'in-flight', 'protocolAckObserved': False}]
            runner.phases = [{'beforeSequence': 3448, 'purpose': 'exploration-only'}]
            with patch.object(runner, 'clock', side_effect=TimeoutError('after-clock timeout')), patch.object(runner, 'capture', side_effect=TimeoutError('flush cancelled')):
                result = runner.finish('deadline-exceeded')
            self.assertEqual(result['verdict'], 'inconclusive')
            self.assertFalse(result['finalCaptureAcknowledged'])
            self.assertEqual(len(result['cleanupErrors']), 2)
            tail = json.loads((runner.output / 'actions.json').read_text())[-1]
            self.assertNotIn('returncode', tail)
            self.assertFalse(tail['protocolAckObserved'])
            self.assertTrue((runner.output / 'phases.json').exists())

    def test_outer_finish_failure_still_writes_terminal_metadata(self):
        with tempfile.TemporaryDirectory() as temporary:
            runner = diagnostic.NativeDiagnostic({}, Path(temporary))
            with patch.object(runner, 'run', side_effect=TimeoutError('work cancelled')), patch.object(runner, 'finish', side_effect=RuntimeError('cleanup exception')):
                result = diagnostic.execute_runner(runner)
            self.assertEqual(result['verdict'], 'inconclusive')
            self.assertFalse(result['finalCaptureAcknowledged'])
            self.assertIn('cleanup failed', result['lifecycle'])
            self.assertTrue(all((runner.output / name).exists() for name in ['actions.json', 'phases.json', 'attempts.json', 'result.json']))

    def test_cancelled_flush_cannot_turn_late_stdout_into_protocol_ack(self):
        with tempfile.TemporaryDirectory() as temporary:
            runner = diagnostic.NativeDiagnostic({'clockClient': 'clock', 'data': 'sandbox', 'serveSim': ['official']}, Path(temporary))
            class Cancelled:
                def __init__(self): self.returncode = None; self.calls = 0
                def communicate(self, timeout):
                    self.calls += 1
                    if self.calls == 1: raise diagnostic.subprocess.TimeoutExpired('flush', timeout)
                    return ('{"command":"flush","nonce":"late"}', '')
                def poll(self): return self.returncode
                def kill(self): self.returncode = -9
            child = Cancelled()
            with patch.object(diagnostic.subprocess, 'Popen', return_value=child):
                with self.assertRaises(TimeoutError): runner.command(['clock', 'sandbox', 'flush'])
            action = json.loads((runner.output / 'actions.json').read_text())[-1]
            self.assertEqual(action['status'], 'cancelled')
            self.assertEqual(action['returncode'], -9)
            self.assertFalse(action['protocolAckObserved'])
            self.assertIn('late', action['stdout'])

    def test_flush_ack_must_match_capture_revision_before_marking_ack(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); data_dir = root / 'data'; data_dir.mkdir()
            data = reading_fixture(0)[0]; data['revision'] = 3
            (data_dir / 'capture.json').write_text(json.dumps(data))
            for revision in [4, 3]:
                output = root / str(revision); output.mkdir()
                runner = diagnostic.NativeDiagnostic({'clockClient': 'clock', 'data': str(data_dir), 'serveSim': ['official']}, output)
                runner.identity = data['identity']; runner.process = data['processNonce']
                receipt = {'command': 'flush', 'nonce': 'fixture-ack', 'nativeMs': 3001, 'revision': revision, 'baselineSequence': 120}
                class Returned:
                    returncode = 0
                    def communicate(self, timeout): return json.dumps(receipt), ''
                with patch.object(diagnostic.subprocess, 'Popen', return_value=Returned()):
                    if revision == 4:
                        with self.assertRaisesRegex(ValueError, 'ACK revision'): runner.capture('final-capture.json')
                        self.assertFalse((output / 'final-capture.json').exists())
                        self.assertTrue((output / 'final-capture.json.unacknowledged').exists())
                        self.assertFalse(runner.actions[-1]['protocolAckObserved'])
                    else:
                        runner.capture('final-capture.json')
                        self.assertTrue(runner.actions[-1]['protocolAckObserved'])

    def test_hard_deadline_prevents_any_new_cleanup_subprocess(self):
        with tempfile.TemporaryDirectory() as temporary:
            runner = diagnostic.NativeDiagnostic({'clockClient': 'clock', 'data': 'sandbox', 'serveSim': ['official']}, Path(temporary))
            runner.hard_end = diagnostic.time.monotonic() - 1
            with patch.object(diagnostic.subprocess, 'Popen') as called:
                with self.assertRaises(TimeoutError): runner.command(['clock', 'sandbox', 'flush'], cleanup=True)
                called.assert_not_called()

    def test_saved_manual_audit_is_inconclusive_and_does_not_create_result(self):
        audit = diagnostic.load('native_audit_fixture', 'native_saved_analysis.py')
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); data = reading_fixture(0)[0]; data['events'] = []
            data['host']['journal'][1]['requestCursor'] = None
            data['host']['journal'][1]['complete'] = False
            for frame in data['frames']:
                frame['scrolls'][0]['frame'] = {'x': 0, 'y': 0, 'width': 402, 'height': 874}
            (root / 'manual-preserved-capture.json').write_text(json.dumps(data))
            (root / 'manual-preservation.json').write_text('{"purpose":"manual preservation; not acceptance"}')
            (root / 'actions.json').write_text('[{"argv":["official","gesture","{\\"type\\":\\"end\\"}"],"returncode":0},{"argv":["clock","sandbox","flush"]}]')
            (root / 'phases.json').write_text('[{"beforeSequence":30}]')
            result = audit.audit_saved(root)
            self.assertEqual(result['verdict'], 'inconclusive')
            self.assertFalse(result['manualPreservationIsFinalization'])
            self.assertEqual(result['history']['olderResponses'], 0)
            self.assertEqual(result['history']['tailResponses'], 1)
            self.assertEqual(result['native']['sampledIdleBodyStepMaxPt'], 0)
            self.assertFalse((root / 'result.json').exists())

    def test_collapsed_span_report_is_a_necessary_bound_not_a_global_fit_claim(self):
        tree, capture = compact_fixture()
        capture['frames'][-1]['nodes'].append({'id': 'history-load-older', 'instance': 'footer', 'frame': {'x': 12, 'y': -3766, 'width': 378, 'height': 44}, 'visible': False, 'fullyVisible': False})
        geometry = diagnostic.navigation_geometry(tree, capture)
        self.assertEqual(geometry['availableHeightOuterBoundPt'], 780)
        self.assertEqual(geometry['minimumFooterShiftToFullVisibilityPt'], 3766)
        triple = geometry['observedTriples'][0]
        self.assertEqual(triple['nativeCompleteCount'], 2)
        self.assertAlmostEqual(triple['spanPt'], 754.9995956420898)
        self.assertFalse(triple['impossibleEvenInOuterBound'])
        self.assertAlmostEqual(triple['necessaryTranslationIntervalPt'][0], 60.99991226196289)
        self.assertAlmostEqual(triple['necessaryTranslationIntervalPt'][1], 86.00031661987305)
        self.assertIn('header/status-bar boundary unknown', geometry['lowerEdgeSource'])
        capture['frames'][-1]['nodes'][0]['frame']['height'] = 800
        self.assertTrue(diagnostic.navigation_geometry(tree, capture)['observedTriples'][0]['impossibleEvenInOuterBound'])

    def test_explicit_navigation_overrides_stay_bounded_and_do_not_relax_anchors(self):
        diagnostic.validate_plan({'maxNavigation': 32, 'panDistance': .5, 'maxCaptureMiB': 64})
        for config in ({'maxNavigation': 65}, {'panDistance': .56}, {'maxCaptureMiB': 129}):
            with self.assertRaises(ValueError): diagnostic.validate_plan(config)
        tree, capture = compact_fixture()
        source, end, _ = diagnostic.body_gesture(tree, capture, .5)
        self.assertAlmostEqual(end['y'] - source['y'], .5)
        self.assertLessEqual(end['y'], .76)
        with self.assertRaises(ValueError): diagnostic.choose_anchors(capture)

    def test_capture_read_cap_preserves_source_and_does_not_parse_oversized_data(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); data = root / 'data'; data.mkdir(); output = root / 'out'; output.mkdir()
            source = data / 'capture.json'; source.write_bytes(b'x' * (1024 * 1024 + 1))
            runner = diagnostic.NativeDiagnostic({'data': str(data), 'clockClient': 'unused', 'maxCaptureMiB': 1}, output)
            receipt = json.dumps({'command': 'flush', 'nonce': 'fixture-flush', 'nativeMs': 1, 'revision': 1, 'baselineSequence': 1})
            with patch.object(runner, 'command', return_value=receipt):
                with self.assertRaisesRegex(ValueError, 'read-size cap'):
                    runner.capture('too-large.json')
            self.assertEqual(source.stat().st_size, 1024 * 1024 + 1)
            self.assertFalse((output / 'too-large.json').exists())

    def test_real_compact_shape_is_chat_without_fabricating_header_bounds(self):
        tree, capture = compact_fixture()
        chrome = diagnostic.chat_chrome(tree, capture)
        self.assertEqual(chrome['state'], 'compact')
        self.assertEqual(chrome['composerTopAX'], 780)
        self.assertIsNone(chrome['headerBottomAX'])
        self.assertIn('unknown', chrome['headerGeometrySource'])
        self.assertTrue(diagnostic.chat_ready(tree, capture))
        self.assertEqual(diagnostic.body_gesture(tree, capture)[2]['nativeID'], 'body-part-hp-0497:text:0')
        with self.assertRaises(ValueError): diagnostic.choose_anchors(capture)

    def test_unknown_header_rejects_generic_status_partial_and_compact_text(self):
        tree, capture = compact_fixture(); nodes = capture['frames'][-1]['nodes']
        tree[0]['children'].extend([
            {'AXUniqueId': None, 'AXLabel': '18:34', 'type': 'StaticText', 'enabled': True, 'frame': {'x': 90, 'y': 14, 'width': 20, 'height': 20}},
            {'AXUniqueId': None, 'AXLabel': 'ANCHOR hp-0495', 'type': 'StaticText', 'enabled': True, 'frame': {'x': 90, 'y': 14, 'width': 100, 'height': 20}},
            {'AXUniqueId': None, 'AXLabel': 'A complete neutral paragraph', 'type': 'StaticText', 'enabled': True, 'frame': {'x': 20, 'y': 200, 'width': 200, 'height': 20}},
            {'AXUniqueId': 'history-copy-hp-0497', 'AXLabel': '复制消息', 'type': 'Button', 'enabled': True, 'frame': {'x': 12, 'y': 525, 'width': 24, 'height': 24}},
            {'AXUniqueId': None, 'AXLabel': 'ANCHOR hp-0500', 'type': 'StaticText', 'enabled': True, 'frame': {'x': 12, 'y': 782, 'width': 100, 'height': 25}}])
        nodes.append({'id': 'body-part-hp-0500:text:0', 'instance': 'covered-body', 'frame': {'x': 12, 'y': 780, 'width': 378, 'height': 50}, 'visible': True, 'fullyVisible': True})
        targets = diagnostic.natural_text_targets(tree, capture)
        self.assertTrue(targets)
        self.assertTrue(all(target['correspondence'] == 'ANCHOR + native geometry' for target in targets))
        self.assertEqual({target['messageID'] for target in targets}, {'hp-0497', 'hp-0498'})

    def test_compact_without_verified_anchor_does_not_fall_back_to_copy(self):
        tree, capture = compact_fixture()
        for node in tree[0]['children']:
            if node.get('type') == 'StaticText': node['AXLabel'] = 'generic text without message marker'
        self.assertTrue(diagnostic.chat_ready(tree, capture))
        with self.assertRaises(ValueError): diagnostic.body_gesture(tree, capture)

    def test_a3_original_root_time_partial_body_and_covered_marker_remain_rejected(self):
        # Frozen reduced pagination-07-before observations; compact controls reuse the a1 fixture.
        tree, capture = compact_fixture(); frame = capture['frames'][-1]
        tree[0]['type'] = 'Application'
        body488 = {'x': 12, 'y': -10.333201090494867, 'width': 378, 'height': 701.3333129882812}
        body489 = {'x': 80.66667175292969, 'y': 757.0001691182454, 'width': 297.3333435058594, 'height': 110.33333587646484}
        frame['nodes'] = [
            {'id': 'body-part-hp-0488:text:0', 'instance': '12a1c9500', 'frame': body488, 'visible': True, 'fullyVisible': False},
            {'id': 'body-part-hp-0489:text:0', 'instance': '12a1b1880', 'frame': body489, 'visible': True, 'fullyVisible': True}]
        frame['scrolls'][1]['frame'] = {'x': 13, 'y': 620.0001118977864, 'width': 376, 'height': 70}
        tree[0]['children'] = [node for node in tree[0]['children'] if node.get('type') != 'StaticText'] + [
            {'type': 'StaticText', 'enabled': True, 'AXLabel': '03:32', 'frame': {'x': 50.33333333333334, 'y': 14.666666666666686, 'width': 47.66666666666666, 'height': 20.33333333333333}},
            {'type': 'StaticText', 'enabled': True, 'AXLabel': 'A complete neutral paragraph', 'frame': {'x': 12, 'y': 26.000142415364508, 'width': 378, 'height': 488}},
            {'type': 'StaticText', 'enabled': True, 'AXLabel': 'ANCHOR hp-0489', 'frame': {**body489, 'height': 25}},
            {'type': 'StaticText', 'enabled': True, 'AXLabel': 'ANCHOR hp-0488\nno command is executed', 'frame': {'x': 13, 'y': 620.0001118977864, 'width': 209, 'height': 70}}]
        audit = diagnostic.text_target_audit(tree, capture)
        self.assertTrue(diagnostic.chat_ready(tree, capture))
        self.assertEqual(audit['targets'], [])
        clock = next(row for row in audit['candidates'] if row['axLabel'] == '03:32')
        self.assertEqual([row['type'] for row in clock['ancestry']], ['Application'])
        self.assertFalse(clock['accepted'])
        self.assertTrue(any('generic geometry' in reason for reason in clock['exclusionReasons']))
        paragraph = next(row for row in audit['candidates'] if row['axFrame']['y'] > 26 and row['axFrame']['height'] == 488)
        self.assertFalse(paragraph['bodyOwnershipProvenByAncestry'])
        self.assertTrue(any('partial' in reason for reason in paragraph['exclusionReasons']))
        marker = next(row for row in audit['candidates'] if row['axLabel'] == 'ANCHOR hp-0489')
        self.assertIn('AX text extends into observed composer', marker['exclusionReasons'])
        nested = next(row for row in audit['candidates'] if row['axLabel'] == 'ANCHOR hp-0488\nno command is executed')
        self.assertIn('Nested scroll text cannot drive outer transcript', nested['exclusionReasons'])
        with tempfile.TemporaryDirectory() as temporary:
            runner = diagnostic.NativeDiagnostic({}, Path(temporary))
            with patch.object(runner, 'capture', return_value=capture), patch.object(runner, 'ax', return_value=tree):
                runner.snapshot('blocked')
            self.assertTrue((runner.output / 'blocked-geometry.json').exists())
            self.assertTrue((runner.output / 'blocked-candidates.json').exists())
        with tempfile.TemporaryDirectory() as temporary:
            saved = Path(temporary)
            (saved / 'before-ax.json').write_text(json.dumps(tree))
            (saved / 'before-capture.json').write_text(json.dumps(capture))
            report = diagnostic.inspect_saved(saved, 'before')
        self.assertTrue(report['chromeConfirmed'])
        self.assertFalse(report['navigationTargetAvailable'])
        self.assertFalse(report['threeCompleteAnchors'])
        self.assertIn('no safe navigation target', report['reason'])
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); build = root / 'build'; build.mkdir(); data = root / 'data'; data.mkdir()
            clock_file = root / 'clock'; clock_file.write_bytes(b'offline-only')
            identity = {'buildID': 'frozen', 'bundleSHA256': 'bytes', 'executableSHA256': 'exe'}
            (build / 'manifest.json').write_text(json.dumps({**identity, 'appBuilt': True, 'experimentOn': False, 'observerContract': 'pan-read-v1;', 'scenario': 'normal', 'toolBinaries': {'clock-client': hashlib.sha256(clock_file.read_bytes()).hexdigest()}}))
            (data / 'ready.json').write_text(json.dumps({'identity': identity, 'processNonce': 'offline'}))
            runner = diagnostic.NativeDiagnostic({'build': str(build), 'clockClient': str(clock_file), 'data': str(data), 'modes': ['pagination']}, root)
            with patch.object(runner, 'clock'), patch.object(runner, 'capture', return_value=capture), patch.object(runner, 'ax', return_value=tree), patch.object(runner, 'pause'), patch.object(runner, 'tap') as tap, patch.object(runner, 'pan') as pan, patch.object(runner, 'command') as command:
                runner.run()
                tap.assert_not_called(); pan.assert_not_called(); command.assert_not_called()
            self.assertFalse(runner.phases[0]['navigationTargetAvailable'])
            self.assertIn('no safe navigation target', runner.phases[0]['reason'])

    def test_blocked_navigation_reason_survives_terminal_result(self):
        with tempfile.TemporaryDirectory() as temporary:
            runner = diagnostic.NativeDiagnostic({}, Path(temporary))
            runner.phases = [{'chromeConfirmed': True, 'navigationTargetAvailable': False, 'reason': 'Chat chrome confirmed; no safe navigation target: unknown header'}]
            result = runner.finish()
            self.assertEqual(result['verdict'], 'inconclusive')
            self.assertEqual(result['reason'], runner.phases[0]['reason'])

    def test_expanded_to_compact_snapshots_allow_next_exploration_without_mark(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); runner = diagnostic.NativeDiagnostic({}, root)
            for name, pair in [('expanded', fixtures.chat_fixture()), ('compact', compact_fixture())]:
                tree, capture = pair
                with patch.object(runner, 'capture', return_value=capture), patch.object(runner, 'ax', return_value=tree):
                    observed_tree, observed_capture = runner.snapshot(name)
                self.assertTrue(diagnostic.chat_ready(observed_tree, observed_capture))
                with self.assertRaises(ValueError): diagnostic.choose_anchors(observed_capture)
            self.assertFalse(runner.attempts)
            self.assertEqual(json.loads((root / 'compact-chrome.json').read_text())['state'], 'compact')

    def test_one_sample_red_survives_final_return_without_video(self):
        data, attempt, pairs = reading_fixture()
        result = diagnostic.analyze(data, attempt, pairs)
        self.assertEqual(result['verdict'], 'diagnostic-red', result)
        self.assertAlmostEqual(result['nativeReading']['worst']['extraDisplacementLowerPt'], 53 - 2 / 3)
        self.assertEqual(result['nativeReading']['samples'][-1]['extraDisplacementLowerPt'], 0)
        self.assertEqual(result['video'], 'none')
        self.assertEqual(result['original53pt'], 'unresolved')

    def test_no_change_has_no_pass_branch(self):
        result = diagnostic.analyze(*reading_fixture(0))
        self.assertEqual(result['verdict'], 'inconclusive')

    def test_reuse_decel_gap_missing_mark_and_clock_ambiguity_inconclusive(self):
        for change in ('reuse', 'decel', 'gap', 'mark', 'clock', 'no-load'):
            data, attempt, pairs = reading_fixture()
            if change == 'reuse': data['frames'][59]['nodes'][0]['instance'] = 'other'
            if change == 'decel': data['frames'][59]['scrolls'][0]['decelerating'] = True
            if change == 'gap': del data['frames'][55:60]
            if change == 'mark': data['events'] = []
            if change == 'clock': pairs[-1]['processNonce'] = 'other-process'
            if change == 'no-load': data['host']['journal'] = []
            self.assertEqual(diagnostic.analyze(data, attempt, pairs)['verdict'], 'inconclusive', change)

    def test_ancestor_and_body_changes_remain_observations_not_owner_ack(self):
        data, attempt, pairs = reading_fixture()
        for frame in data['frames']:
            frame['controlAncestors'] = [{'instance': 'real-ancestor', 'role': 'ancestor-0-of-history-load-older', 'frame': {'x': 0, 'y': -300, 'width': 400, 'height': 53 if frame['sequence'] < 60 else 0}}]
            frame['nodes'].append({'id': 'turn-body-hp-0009', 'instance': 'growing-row', 'frame': {'x': 0, 'y': 600, 'width': 400, 'height': 50 if frame['sequence'] < 60 else 150}, 'fullyVisible': True})
        attempt['mode'] = 'body-growth'
        result = diagnostic.analyze(data, attempt, pairs)
        self.assertEqual(result['verdict'], 'diagnostic-red')
        self.assertTrue(any(change['heightDeltaPt'] == -53 and 'ownership unknown' in change['owner'] for change in result['signals']['heightChanges']))
        self.assertTrue(any(change['id'] == 'turn-body-hp-0009' for change in result['signals']['heightChanges']))
        self.assertIsNone(result['signals']['sdkAdoptionIdentity'])

    def test_a1_shape_public_text_matches_but_three_old_bodies_do_not(self):
        tree, capture = fixtures.chat_fixture()
        self.assertTrue(diagnostic.matching.chat_ready(tree, capture))
        tree[0]['children'].append({'AXUniqueId': None, 'AXLabel': '18:34', 'type': 'StaticText', 'enabled': True, 'frame': {'x': 52, 'y': 14, 'width': 45, 'height': 20}})
        self.assertEqual(diagnostic.body_gesture(tree, capture)[2]['nativeID'], 'body-part-hp-0498:text:0')
        self.assertTrue(all(target['axFrame']['y'] >= 100 for target in diagnostic.natural_text_targets(tree, capture)))
        with self.assertRaises(ValueError): diagnostic.choose_anchors(capture)

    def test_growth_target_is_excluded_from_old_anchors(self):
        _, capture = fixtures.chat_fixture(True)
        self.assertEqual(len(diagnostic.choose_anchors(capture)), 3)
        with self.assertRaises(ValueError): diagnostic.choose_anchors(capture, {'hp-0498'})

    def test_existing_smoke_config_needs_no_recording_binary(self):
        with tempfile.TemporaryDirectory() as temporary:
            file = Path(temporary) / 'config.json'
            config = {'build': 'frozen', 'clockClient': 'clock', 'data': 'sandbox', 'udid': 'main-device', 'helperOrigin': 'http://127.0.0.1:3101', 'serveSim': ['official-cli'],
                      'recordBinary': '/nonexistent/unsupported-source', 'recordCheck': '/nonexistent/checker'}
            file.write_text(json.dumps(config))
            parsed = diagnostic.config_from_saved(file)
            self.assertNotIn('recordBinary', parsed)
            self.assertNotIn('recordCheck', parsed)

    def test_command_boundary_rejects_launch_host_and_recorder(self):
        with tempfile.TemporaryDirectory() as temporary:
            runner = diagnostic.NativeDiagnostic({'clockClient': 'clock', 'data': 'sandbox', 'serveSim': ['official-cli']}, Path(temporary))
            with patch.object(diagnostic.subprocess, 'Popen') as called:
                for command in (['xcrun', 'simctl', 'launch'], ['record-source', 'capture'], ['curl', 'https://host.invalid']):
                    with self.assertRaises(ValueError): runner.command(command)
                called.assert_not_called()

    def test_normal_partial_mode_is_reported_unavailable_without_touch(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); build = root / 'build'; build.mkdir(); data = root / 'data'; data.mkdir(); output = root / 'out'; output.mkdir()
            clock = root / 'clock'; clock.write_bytes(b'frozen-clock')
            identity = {'buildID': 'frozen', 'bundleSHA256': 'bytes', 'executableSHA256': 'exe'}
            (build / 'manifest.json').write_text(json.dumps({**identity, 'appBuilt': True, 'experimentOn': False, 'observerContract': 'pan-read-v1;', 'scenario': 'normal', 'toolBinaries': {'clock-client': hashlib.sha256(clock.read_bytes()).hexdigest()}}))
            (data / 'ready.json').write_text(json.dumps({'identity': identity, 'processNonce': 'running'}))
            config = {'build': str(build), 'clockClient': str(clock), 'data': str(data), 'modes': ['partial-footer']}
            for tree, capture in (fixtures.chat_fixture(), compact_fixture()):
                runner = diagnostic.NativeDiagnostic(config, output)
                with patch.object(runner, 'clock'), patch.object(runner, 'capture', return_value=capture), patch.object(runner, 'ax', return_value=tree), patch.object(runner, 'pause'), patch.object(runner, 'tap') as touched:
                    runner.run()
                    touched.assert_not_called()
                self.assertIn('unavailable', runner.phases[0]['purpose'])
                self.assertEqual(runner.phases[0]['verdict'], 'inconclusive')

    def test_cleanup_only_ends_own_touch_clocks_and_flushes_no_app_lifecycle(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); runner = diagnostic.NativeDiagnostic({}, root)
            runner.touching = True; runner.last_touch = {'x': .4, 'y': .6}; runner.process = 'running'
            called = []
            with patch.object(runner, 'gesture', side_effect=lambda *args, **kwargs: called.append(args[0])), patch.object(runner, 'clock', side_effect=lambda **kwargs: called.append('clock')), patch.object(runner, 'capture', side_effect=lambda *args, **kwargs: called.append('flush')):
                result = runner.finish('navigation budget exhausted')
            self.assertEqual(called, ['end', 'clock', 'flush'])
            self.assertEqual(result['verdict'], 'inconclusive')
            self.assertIn('not started', result['video'])


if __name__ == '__main__':
    unittest.main()
