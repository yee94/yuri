import importlib.util
import io
import hashlib
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('identity_probe', Path(__file__).with_name('identity_probe.py'))
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)


class IdentityProbeTests(unittest.TestCase):
    def run_case(self, mode):
        with tempfile.TemporaryDirectory(prefix='identity-probe-unit-') as temporary:
            root = Path(temporary)
            build, data, output = root / 'build', root / 'data', root / 'out'
            (build / 'tools').mkdir(parents=True)
            (data / 'segments').mkdir(parents=True)
            clock = build / 'tools/clock-client'
            clock.write_bytes(b'fake-client-not-executed')
            identity = {'buildID': 'test-build', 'bundleSHA256': 'bundle', 'executableSHA256': 'executable'}
            manifest = {**identity, 'appBuilt': True, 'observerVersion': 'v4', 'observerProfile': 'identity-only',
                'periodicSampling': False, 'historyDriverAdmission': False, 'experimentOn': False,
                'toolBinaries': {'clock-client': hashlib.sha256(clock.read_bytes()).hexdigest()}}
            (build / 'manifest.json').write_text(json.dumps(manifest))
            (data / 'ready.json').write_text(json.dumps({'identity': identity, 'processNonce': 'process', 'observerProfile': 'identity-only',
                'periodicSampling': False, 'automaticInput': False}))
            commands = []

            def execute(args, **_options):
                commands.append(args[-1])
                revision = len(commands)
                mismatch = mode == 'getter-mismatch'
                result = {'prepared': not mismatch, 'assignedCount': 1, 'readbackConfirmedCount': 0 if mismatch else 1,
                    'identityBaseline': {'withinReadBudget': True}}
                if args[-1] == 'read-ax':
                    result = {'readStartNativeMs': 10, 'readEndNativeMs': 16 if mode == 'slow-read' else 11,
                        'bindings': [{'token': 'hpdiag-ax-test-1', 'valid': not mismatch, 'assignmentReadbackKind': 'nil' if mismatch else 'ours'}]}
                nonce = f'00000000-0000-4000-8000-{revision:012d}'
                fence = {'schema': 'history-native-segments-v4', 'nonce': nonce, 'revision': revision, 'lastSequence': 16}
                name = f'fence-{revision:06d}.json'
                raw = json.dumps(fence).encode()
                (data / 'segments' / name).write_bytes(raw)
                ack = {'identity': identity if mode != 'wrong-process' else {}, 'processNonce': 'process', 'command': args[-1],
                    'nonce': nonce, 'result': result, 'revision': revision, 'durableSequence': 16, 'manifest': name,
                    'manifestSHA256': hashlib.sha256(raw).hexdigest(), 'ackNativeMs': 20}
                return SimpleNamespace(returncode=0, stdout=json.dumps(ack), stderr='')

            with patch.object(probe.subprocess, 'run', side_effect=execute), patch.object(probe.urllib.request, 'urlopen',
                    return_value=io.BytesIO(b'[{"AXLabel":"History Production QA","AXUniqueId":"hpdiag-ax-test-1"}]')):
                if mode == 'wrong-process':
                    with self.assertRaises(ValueError):
                        probe.collect(build, data, output, 'http://127.0.0.1:3200', '00000000-0000-4000-8000-000000000001')
                    self.assertTrue((output / 'prepare.json').exists())
                    self.assertEqual(commands, ['prepare-ax'])
                    return
                probe.collect(build, data, output, 'http://127.0.0.1:3200', '00000000-0000-4000-8000-000000000001')
            report = json.loads((output / 'summary.json').read_text())
            self.assertEqual(commands, ['prepare-ax', 'read-ax', 'read-ax'])
            self.assertFalse(report['automaticPan'])
            self.assertFalse(report['strictAcceptance'])
            self.assertIsNone(report['sdkAdoptionIdentity'])
            self.assertEqual(report['identityReadbacksConfirmed'], mode == 'confirmed')
            self.assertEqual(report['readExposureWithin5ms'], [mode != 'slow-read'] * 2)

    def test_confirmed_still_does_not_authorize_pan_or_adoption(self): self.run_case('confirmed')
    def test_getter_mismatch_is_preserved_without_retry(self): self.run_case('getter-mismatch')
    def test_slow_control_is_preserved_but_not_admitted(self): self.run_case('slow-read')
    def test_wrong_process_receipt_is_saved_then_rejected(self): self.run_case('wrong-process')


if __name__ == '__main__':
    unittest.main()
