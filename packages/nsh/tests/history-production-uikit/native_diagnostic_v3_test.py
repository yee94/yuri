"""Pure a3 geometry calibration + fabricated v3 instrumentation witnesses. Never edits saved a3."""
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


driver = load('v3_driver', 'native-diagnostic.py')
v3 = load('v3_admission', 'native_diagnostic_v3.py')
old = load('v3_old_fixtures', 'native_diagnostic_test.py')


def geometry(rect, window='window'):
    return {'instance': 'text-view', 'windowInstance': window, 'sameWindow': True, 'modelGeometryUnambiguous': True, 'modelVisible': True,
            'effectiveHidden': False, 'effectiveAlpha': 1, 'hasTransforms': False, 'hasAnimation': False, 'hasLayerMask': False,
            'frameInWindow': copy.deepcopy(rect), 'frameInSurface': copy.deepcopy(rect), 'visibleRectInWindow': copy.deepcopy(rect),
            'presentationFrameInWindow': None, 'presentationFrameInSurface': None}


def live_protection(frame):
    outer = frame['scrolls'][0]
    return {'contract': 'control-safety-v1', 'coverageKnown': True, 'unknownCoverage': False, 'controllerTransition': False,
            'presentedControllerInstances': [], 'modalViewInstances': [], 'otherWindowInstances': [], 'headerBounds': [],
            'composerBounds': [{**geometry({'x': 40.2, 'y': 780, 'width': 321.6, 'height': 44}), 'id': 'chat-composer-compact'}],
            'outerTranscript': {'instance': outer['instance'], 'geometry': geometry(outer['frame']), 'offsetX': 0, 'offsetY': outer['offsetY'],
                                'tracking': False, 'dragging': False, 'decelerating': False, 'panState': 0, 'panTranslationX': 0, 'panTranslationY': 0}}


def protect_control_read(read, frame):
    read['windowObservation']['liveProtection'] = live_protection(frame)
    for binding in read['bindings']:
        binding['liveCoverage'] = {'known': True, 'unknownCoverage': False, 'aboveSiblingInstances': [], 'hitBelongsToOuter': True}
    return read


def final_read(capture):
    read = copy.deepcopy(capture['frames'][-1]['diagnosticIdentity'])
    read.update({'readStartNativeMs': 1510, 'readEndNativeMs': 1511, 'lastPeriodicReadEndNativeMs': 1500.2, 'observationKind': 'control-read'})
    read['windowObservation']['observationKind'] = 'control-read'
    return protect_control_read(read, capture['frames'][-1])


def fixture():
    tree, capture = old.compact_fixture(); tree[0]['type'] = 'Application'
    bounds = tree[0]['frame']; base = capture['frames'][-1]
    base['nodes'] = [
        {'id': 'body-part-hp-0488:text:0', 'instance': '12a1c9500', 'frame': {'x': 12, 'y': -10.333201090494867, 'width': 378, 'height': 701.3333129882812}, 'visible': True, 'fullyVisible': False},
        {'id': 'body-part-hp-0489:text:0', 'instance': '12a1b1880', 'frame': {'x': 80.66667175292969, 'y': 757.0001691182454, 'width': 297.3333435058594, 'height': 110.33333587646484}, 'visible': True, 'fullyVisible': True}]
    base['scrolls'][0].update({'offsetX': 0, 'offsetY': 1317.6666666666667, 'contentHeight': 4840, 'tracking': False, 'dragging': False, 'decelerating': False})
    base['scrolls'][1]['frame'] = {'x': 13, 'y': 620.0001118977864, 'width': 376, 'height': 70}
    nonce = '00000000-0000-4000-8000-000000000053'; token = 'hpdiag-ax-' + nonce + '-1'
    # These coordinates/labels are a frozen reduction of actual a3 pagination-07-before.
    rect = {'x': 52, 'y': 525.3335049947102, 'width': 338, 'height': 25}
    text = {'type': 'StaticText', 'enabled': True, 'AXUniqueId': token, 'AXLabel': 'Preserve identity', 'frame': rect}
    tree[0]['children'] = [node for node in tree[0]['children'] if node.get('type') != 'StaticText'] + [text,
        {'type': 'StaticText', 'enabled': True, 'AXUniqueId': None, 'AXLabel': '03:32', 'frame': {'x': 50.33333333333334, 'y': 14.666666666666686, 'width': 47.66666666666666, 'height': 20.33333333333333}}]
    bar = {**geometry({'x': 0, 'y': 0, 'width': 402, 'height': 64}), 'instance': 'bar', 'isNavigationBarHidden': False, 'navigationTransitionInProgress': False,
           'owningNavigationControllerInstances': ['nav'], 'currentTranscriptOwnerInstances': ['nav']}
    window = {'contract': 'window-header-v1', 'windowInstance': 'window', 'surfaceInstance': 'surface', 'windowBounds': bounds, 'surfaceInWindow': bounds,
              'windowSafeAreaInsets': {'top': 63, 'left': 0, 'right': 0, 'bottom': 34}, 'navigationBars': [bar], 'navigationBarCount': 1,
              'selectedNavigationBarInstance': 'bar', 'transcriptInstances': [base['scrolls'][0]['instance']], 'discoveryOverflow': False}
    binding = {'token': token, 'generation': 1, 'viewInstance': 'text-view', 'bodyID': 'body-part-hp-0488:text:0', 'bodyInstance': '12a1c9500',
               'outerTranscriptInstance': base['scrolls'][0]['instance'], 'assignedSequence': 1, 'valid': True, 'fingerprint': hashlib.sha256(b'Preserve identity').hexdigest(),
               'geometry': geometry(rect), 'accessibilityFrameInWindow': copy.deepcopy(rect), 'nestedScroll': False, 'isAXText': True}
    binding['ancestorInstancesToOuterTranscript'] = ['text-view', '12a1c9500', base['scrolls'][0]['instance']]
    frames = []
    for index in range(1, 31):
        frame = copy.deepcopy(base); frame.update({'sequence': index, 'nativeUptimeMs': 1000 + index * 1000 / 60, 'readEndNativeMs': 1000 + index * 1000 / 60 + .2})
        frame['windowObservation'] = {**copy.deepcopy(window), 'sequence': index, 'observationKind': 'periodic'}
        frame['diagnosticIdentity'] = {'contract': 'synthetic-ax-id-v3', 'instrumented': True, 'runNonce': nonce, 'generation': 1, 'lastPeriodicSequence': index,
            'windowObservation': frame['windowObservation'], 'observationKind': 'periodic', 'readStartNativeMs': frame['nativeUptimeMs'], 'readEndNativeMs': frame['readEndNativeMs'], 'bindings': [copy.deepcopy(binding)]}
        if index == 1:
            frame['diagnosticIdentity'].update({'generation': 0, 'bindings': []})
        frames.append(frame)
    before = copy.deepcopy(frames[27]['diagnosticIdentity']); before.update({'readStartNativeMs': 1470, 'readEndNativeMs': 1471})
    after = copy.deepcopy(frames[28]['diagnosticIdentity']); after.update({'readStartNativeMs': 1486, 'readEndNativeMs': 1487})
    for read in [before, after]:
        read['observationKind'] = 'control-read'; read['windowObservation']['observationKind'] = 'control-read'
        read['lastPeriodicReadEndNativeMs'] = frames[read['lastPeriodicSequence'] - 1]['readEndNativeMs']
        protect_control_read(read, frames[read['lastPeriodicSequence'] - 1])
    capture.update({'observerContract': 'instrumented-v3; synthetic-ax-id-v3', 'frames': frames, 'v3AXReads': [before, after],
                    'v3AXPrepare': {'prepared': True, 'runNonce': nonce, 'generation': 1, 'assignedSequence': 1, 'nativeMs': 1030}, 'v3AXReadOrder': ['read-ax', 'AX', 'read-ax']})
    return tree, capture


def all_bindings(capture):
    return [row for read in [*capture['v3AXReads'], *[frame['diagnosticIdentity'] for frame in capture['frames']]] for row in read['bindings']]


class V3Tests(unittest.TestCase):
    def test_partial_body_whole_text_token_allows_navigation_but_never_three_body_acceptance(self):
        tree, capture = fixture()
        audit = driver.text_target_audit(tree, capture)
        self.assertEqual(len(audit['targets']), 1, audit)
        source, end, body = driver.body_gesture(tree, capture, .5)
        self.assertEqual(body['nativeID'], 'body-part-hp-0488:text:0')
        self.assertAlmostEqual(source['y'] * 874, 525.3335049947102 + 12.5)
        self.assertAlmostEqual(end['y'] * 874, 780 - 1 / 3)
        self.assertFalse(audit['candidates'][-1]['accepted'])
        with self.assertRaises(ValueError): driver.choose_anchors(capture, visible_ids={body['nativeID']})
        capture.pop('observerContract')
        self.assertEqual(driver.natural_text_targets(tree, capture), [])

    def test_missing_merged_duplicate_token_and_native_duplicates_all_reject(self):
        for mode in ['missing', 'merged', 'duplicate', 'native-duplicate', 'unprepared', 'wrong-contract']:
            tree, capture = fixture(); text = tree[0]['children'][-2]
            if mode == 'missing': text['AXUniqueId'] = None
            if mode == 'merged': text['type'] = 'Button'
            if mode == 'duplicate': tree[0]['children'].append(copy.deepcopy(text))
            if mode == 'native-duplicate': capture['v3AXReads'][1]['bindings'].append(copy.deepcopy(capture['v3AXReads'][1]['bindings'][0]))
            if mode == 'unprepared': capture['v3AXPrepare']['prepared'] = False
            if mode == 'wrong-contract': capture['v3AXReads'][1]['contract'] = 'unknown'
            self.assertFalse(driver.natural_text_targets(tree, capture), mode)

    def test_binding_identity_text_nested_and_retirement_changes_fail_closed(self):
        for key, value in [('viewInstance', 'reused-pointer'), ('generation', 2), ('bodyInstance', 'other-body'), ('outerTranscriptInstance', 'other-list'), ('fingerprint', 'wrong'), ('valid', False), ('nestedScroll', True), ('isAXText', False)]:
            tree, capture = fixture()
            capture['v3AXReads'][1]['bindings'][0][key] = value
            self.assertFalse(driver.natural_text_targets(tree, capture), key)
        tree, capture = fixture(); capture['frames'][20]['diagnosticIdentity']['bindings'][0]['valid'] = False
        self.assertFalse(driver.natural_text_targets(tree, capture))
        tree, capture = fixture(); capture['v3AXReads'][1]['bindings'][0]['ancestorInstancesToOuterTranscript'].insert(1, 'new-wrapper')
        self.assertFalse(driver.natural_text_targets(tree, capture))

    def test_header_composer_clip_transform_presentation_window_safe_area_reject_whole_range(self):
        for mode in ['header', 'composer', 'clip', 'transform', 'presentation', 'window', 'safe-area', 'transition']:
            tree, capture = fixture()
            if mode in ('header', 'composer'):
                rect = {'x': 12, 'y': 26.000142415364508, 'width': 378, 'height': 488} if mode == 'header' else {'x': 80.66667175292969, 'y': 757.0001691182454, 'width': 297.3333435058594, 'height': 25}
                tree[0]['children'][-2]['frame'] = rect
                label = ('A complete neutral paragraph exercises variable natural line wrapping without removing source content. ' * (2 + 488 % 7)) if mode == 'header' else 'ANCHOR hp-0489'
                tree[0]['children'][-2]['AXLabel'] = label
                for binding in all_bindings(capture):
                    binding['geometry'] = geometry(rect); binding['accessibilityFrameInWindow'] = copy.deepcopy(rect)
                    binding['fingerprint'] = hashlib.sha256(label.strip().encode()).hexdigest()
                    if mode == 'composer':
                        binding['bodyID'] = 'body-part-hp-0489:text:0'; binding['bodyInstance'] = '12a1b1880'
                        binding['ancestorInstancesToOuterTranscript'][1] = '12a1b1880'
            if mode == 'clip':
                for binding in all_bindings(capture): binding['geometry']['visibleRectInWindow']['height'] = 20
            if mode == 'transform':
                for binding in all_bindings(capture): binding['geometry']['hasTransforms'] = True
            if mode == 'presentation':
                for binding in all_bindings(capture): binding['geometry']['presentationFrameInWindow'] = {**binding['geometry']['frameInWindow'], 'y': 520}
            if mode == 'window': capture['v3AXReads'][1]['windowObservation']['windowInstance'] = 'wrong-window'
            if mode == 'safe-area': capture['frames'][-1]['windowObservation']['windowSafeAreaInsets']['top'] = None
            if mode == 'transition': capture['v3AXReads'][1]['windowObservation']['navigationBars'][0]['navigationTransitionInProgress'] = True
            self.assertFalse(driver.natural_text_targets(tree, capture), mode)

    def test_gap_motion_missing_fresh_baseline_and_prepare_during_interval_reject(self):
        for mode in ['gap', 'motion', 'fresh', 'new-prepare', 'sequence', 'future-assignment']:
            tree, capture = fixture()
            if mode == 'gap': capture['frames'].pop(20)
            if mode == 'motion': capture['frames'][20]['scrolls'][0]['decelerating'] = True
            if mode == 'fresh': capture['v3AXPrepare']['nativeMs'] = 1400
            if mode == 'new-prepare': capture['frames'][20]['diagnosticIdentity']['bindings'][0]['generation'] = 2
            if mode == 'sequence': capture['frames'][-1]['windowObservation']['sequence'] = 1
            if mode == 'future-assignment': capture['v3AXPrepare']['nativeMs'] = 900
            self.assertFalse(driver.natural_text_targets(tree, capture), mode)

    def test_read_only_final_pre_touch_revalidation_rejects_post_flush_reuse(self):
        tree, capture = fixture(); target = driver.natural_text_targets(tree, capture)[0]
        read = final_read(capture)
        v3.revalidate(target, capture, read)
        stale = copy.deepcopy(read); stale['readStartNativeMs'] = 1600; stale['readEndNativeMs'] = 1601
        with self.assertRaisesRegex(ValueError, 'sampler stale'): v3.revalidate(target, capture, stale)
        read['bindings'][0]['viewInstance'] = 'reused'
        read['bindings'][0]['ancestorInstancesToOuterTranscript'][0] = 'reused'
        with self.assertRaisesRegex(ValueError, 'changed after capture'): v3.revalidate(target, capture, read)

    def test_mocked_snapshot_orders_prepare_then_native_baseline_then_read_AX_read_and_never_changes_AX_tree(self):
        tree, capture = fixture()
        with tempfile.TemporaryDirectory() as temporary:
            runner = driver.NativeDiagnostic({}, Path(temporary)); runner.instrumented_v3 = True
            calls = []
            def control(command, _file):
                calls.append(command)
                return capture['v3AXPrepare'] if command == 'prepare-ax' else capture['v3AXReads'][0 if calls.count('read-ax') == 1 else 1]
            with patch.object(runner, 'ax_control', side_effect=control), patch.object(runner, 'pause', side_effect=lambda _seconds: calls.append('stable-wait')), patch.object(runner, 'ax', side_effect=lambda _file: calls.append('AX') or tree), patch.object(runner, 'capture', return_value=capture):
                seen_tree, _seen_capture = runner.snapshot('v3')
            self.assertEqual(calls, ['prepare-ax', 'stable-wait', 'read-ax', 'AX', 'read-ax'])
            self.assertEqual(seen_tree, tree)
            self.assertTrue((runner.output / 'v3-v3-evidence.json').exists())
            self.assertTrue((runner.output / 'v3-candidates.json').exists())

    def test_current_control_safety_blocks_pan_and_mark_even_when_old_header_and_token_stay_identical(self):
        for mode in ['composer-covers-text', 'composer-covers-corridor', 'modal', 'unknown-cover', 'sibling-cover', 'tracking', 'dragging', 'decelerating', 'pan', 'offset', 'frame', 'missing-protection']:
            with self.subTest(mode=mode):
                tree, capture = fixture(); read = final_read(capture)
                protection = read['windowObservation']['liveProtection']; outer = protection['outerTranscript']
                if mode.startswith('composer-'):
                    rect = {**protection['composerBounds'][0]['frameInWindow'], 'y': 520 if mode == 'composer-covers-text' else 600}
                    protection['composerBounds'][0] = {**geometry(rect), 'id': 'chat-composer-compact'}
                if mode == 'modal': protection['presentedControllerInstances'] = ['new-modal']
                if mode == 'unknown-cover': protection['unknownCoverage'] = True
                if mode == 'sibling-cover': read['bindings'][0]['liveCoverage']['unknownCoverage'] = True
                if mode in ('tracking', 'dragging', 'decelerating'): outer[mode] = True
                if mode == 'pan': outer['panState'] = 2
                if mode == 'offset': outer['offsetY'] += 10
                if mode == 'frame': outer['geometry']['frameInSurface']['height'] -= 10
                if mode == 'missing-protection': del read['windowObservation']['liveProtection']
                self.assertEqual(v3.window_signature(read['windowObservation']), v3.window_signature(capture['frames'][-1]['windowObservation']))
                for position in (0, 1):
                    invalid_capture = copy.deepcopy(capture)
                    witnessed = invalid_capture['v3AXReads'][position]
                    if 'liveProtection' in read['windowObservation']:
                        witnessed['windowObservation']['liveProtection'] = copy.deepcopy(read['windowObservation']['liveProtection'])
                    else:
                        witnessed['windowObservation'].pop('liveProtection')
                    witnessed['bindings'][0]['liveCoverage'] = copy.deepcopy(read['bindings'][0]['liveCoverage'])
                    self.assertFalse(driver.natural_text_targets(tree, invalid_capture), (mode, position))
                with tempfile.TemporaryDirectory() as temporary:
                    runner = driver.NativeDiagnostic({'panDistance': .5}, Path(temporary)); runner.instrumented_v3 = True
                    with patch.object(runner, 'ax_control', return_value=read), patch.object(runner, 'gesture') as touch, patch.object(runner, 'command') as command:
                        with self.assertRaises((ValueError, KeyError)): runner.pan(tree, capture)
                        with self.assertRaises((ValueError, KeyError)): runner.mark(tree, capture, ['body-part-hp-0488:text:0'], pan=True)
                        touch.assert_not_called(); command.assert_not_called()
                    self.assertFalse(runner.touching)

    def test_each_control_read_own_exposure_is_finite_nonnegative_and_at_most_five_ms(self):
        mutations = [(1510, 1515.001), (1510, None), (float('nan'), 1511), (1510, float('inf')), (-1, 0), (1511, 1510)]
        for start, end in mutations:
            for position in [0, 1, 'pre-touch']:
                with self.subTest(start=start, end=end, position=position):
                    tree, capture = fixture(); read = final_read(capture)
                    bad = read if position == 'pre-touch' else capture['v3AXReads'][position]
                    bad['readStartNativeMs'] = start
                    if end is None: bad.pop('readEndNativeMs')
                    else: bad['readEndNativeMs'] = end
                    if position != 'pre-touch':
                        self.assertFalse(driver.natural_text_targets(tree, capture))
                    else:
                        with tempfile.TemporaryDirectory() as temporary:
                            runner = driver.NativeDiagnostic({'panDistance': .5}, Path(temporary)); runner.instrumented_v3 = True
                            with patch.object(runner, 'ax_control', return_value=read), patch.object(runner, 'gesture') as touch, patch.object(runner, 'command') as command:
                                with self.assertRaises(ValueError): runner.pan(tree, capture)
                                with self.assertRaises(ValueError): runner.mark(tree, capture, ['body-part-hp-0488:text:0'], pan=True)
                                touch.assert_not_called(); command.assert_not_called()
        read = final_read(fixture()[1]); read['readEndNativeMs'] = read['readStartNativeMs'] + 5
        v3.control_read_window(read)

    def test_slow_control_read_receipt_is_preserved_before_admission_rejects(self):
        _tree, capture = fixture(); read = final_read(capture); read['readEndNativeMs'] += 10
        ack = {'command': 'read-ax', 'identity': {}, 'processNonce': 'process', 'nonce': 'fresh', 'result': read}
        with tempfile.TemporaryDirectory() as temporary:
            runner = driver.NativeDiagnostic({'clockClient': 'clock', 'data': 'data'}, Path(temporary)); runner.instrumented_v3 = True
            runner.identity = {}; runner.process = 'process'
            with patch.object(runner, 'command', return_value=json.dumps(ack)):
                with self.assertRaisesRegex(ValueError, 'exposure'): runner.ax_control('read-ax', 'slow.json')
            self.assertEqual(json.loads((runner.output / 'slow.json').read_text()), ack)

    def test_old_989_contract_is_rejected_before_any_automatic_control_or_touch(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / 'manifest.json').write_text(json.dumps({'appBuilt': True, 'experimentOn': False, 'synthetic': True,
                'original53ptSameScenario': False, 'observerContract': 'instrumented-v3; synthetic-ax-id-v3; old-989-contract'}))
            runner = driver.NativeDiagnostic({'build': str(root)}, root)
            with patch.object(runner, 'command') as command, patch.object(runner, 'clock') as clock, patch.object(runner, 'pan') as pan:
                with self.assertRaisesRegex(ValueError, 'new v3 control safety'): runner.run()
                command.assert_not_called(); clock.assert_not_called(); pan.assert_not_called()


if __name__ == '__main__':
    unittest.main()
