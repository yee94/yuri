import copy
import hashlib
import importlib.util
import io
import json
import struct
import sys
import tempfile
import unittest
from unittest.mock import patch
from pathlib import Path

spec = importlib.util.spec_from_file_location('history_v4_reader', Path(__file__).with_name('stream_reader.py'))
reader = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = reader
spec.loader.exec_module(reader)


def encode(value):
    if value is None:
        return b'\0'
    if type(value) is bool:
        return b'\2' if value else b'\1'
    if type(value) is int:
        return b'\3' + value.to_bytes(8, 'big', signed=True)
    if isinstance(value, reader.DoubleBits):
        return b'\4' + value.bits.to_bytes(8, 'big')
    if type(value) is str:
        raw = value.encode('utf-8')
        return b'\5' + len(raw).to_bytes(4, 'big') + raw
    if type(value) is list:
        return b'\6' + len(value).to_bytes(4, 'big') + b''.join(map(encode, value))
    if type(value) is dict:
        return b'\7' + len(value).to_bytes(4, 'big') + b''.join(encode(key)[1:] + encode(value[key]) for key in sorted(value))
    raise TypeError(type(value))


class ReaderTests(unittest.TestCase):
    def frame(self):
        return {'ordinal': 1, 'kind': 'frame', 'sequence': 1, 'value': {'sequence': 1, 'windowObservation': {'sequence': 1},
            'diagnosticIdentity': {'observationKind': 'periodic', 'windowObservationRef': 1}}}

    def test_bits_and_nested_values(self):
        value = {'bits': [reader.DoubleBits(x) for x in [0x8000000000000000, 0x7ff8000000000042, 0x7ff0000000000000]], 'other': [None, False, True, -55, '中文']}
        self.assertEqual(reader.decode(io.BytesIO(encode(value))), value)

    def test_reference_strictly_same_seq_and_control_never_uses_it(self):
        good = self.frame()
        self.assertEqual(reader.expand(good)['value']['diagnosticIdentity']['windowObservation'], {'sequence': 1})
        for mode in ['wrong-ref', 'missing', 'duplicate-inline', 'wrong-window', 'control']:
            bad = copy.deepcopy(good)
            identity = bad['value']['diagnosticIdentity']
            if mode == 'wrong-ref': identity['windowObservationRef'] = 0
            if mode == 'missing': identity.pop('windowObservationRef')
            if mode == 'duplicate-inline': identity['windowObservation'] = {'sequence': 1}
            if mode == 'wrong-window': bad['value']['windowObservation']['sequence'] = 2
            if mode == 'control': bad['kind'] = 'control'
            with self.subTest(mode=mode), self.assertRaises(ValueError):
                reader.expand(bad)

    def test_unknown_tag_truncation_and_duplicate_key(self):
        for raw in [b'\x09', b'\x04\0', b'\x07\0\0\0\2\0\0\0\1a\0\0\0\0\1a\0']:
            with self.assertRaises(ValueError):
                reader.decode(io.BytesIO(raw))

    def test_manifest_schema_hash_order_and_durable_prefix(self):
        with tempfile.TemporaryDirectory(prefix='history-v4-reader-') as temporary:
            directory = Path(temporary)
            value = encode(self.frame())
            segment = b'HNSV4\n' + len(value).to_bytes(4, 'big') + value
            metadata = encode(None)
            (directory / 'segment-000001.hns4').write_bytes(segment)
            (directory / 'fence-000001.metadata.hns4').write_bytes(metadata)
            good = {'schema': reader.SCHEMA, 'nonce': '00000000-0000-4000-8000-000000000001', 'revision': 1, 'lastOrdinal': 1, 'lastSequence': 1,
                'metadataFile': 'fence-000001.metadata.hns4', 'metadataSHA256': hashlib.sha256(metadata).hexdigest(),
                'segments': [{'file': 'segment-000001.hns4', 'sha256': hashlib.sha256(segment).hexdigest(), 'bytes': len(segment),
                    'firstOrdinal': 1, 'lastOrdinal': 1, 'lastSequence': 1}]}
            manifest = directory / 'fence-000001.json'
            manifest.write_text(json.dumps(good))
            self.assertEqual(len(list(reader.records(manifest))), 1)
            for mode in ['v3', 'hash', 'missing', 'boundary', 'record-order', 'path', 'metadata']:
                bad = copy.deepcopy(good)
                if mode == 'v3': bad['schema'] = 1
                if mode == 'hash': bad['segments'][0]['sha256'] = '0' * 64
                if mode == 'missing': bad['segments'][0]['file'] = 'segment-000002.hns4'
                if mode == 'boundary': bad['lastSequence'] = 2
                if mode == 'record-order': bad['segments'][0]['firstOrdinal'] = 2
                if mode == 'path': bad['segments'][0]['file'] = '../segment-000001.hns4'
                if mode == 'metadata': bad['metadataSHA256'] = '0' * 64
                manifest.write_text(json.dumps(bad))
                with self.subTest(mode=mode), self.assertRaises(ValueError):
                    list(reader.records(manifest))

    def test_v3_automatic_driver_rejects_v4_before_any_control(self):
        spec = importlib.util.spec_from_file_location('v4_reject_driver', Path(__file__).parent.parent / 'native-diagnostic.py')
        driver = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(driver)
        with tempfile.TemporaryDirectory(prefix='history-v4-driver-reject-') as temporary:
            root = Path(temporary)
            (root / 'manifest.json').write_text(json.dumps({'appBuilt': True, 'experimentOn': False, 'observerContract': reader.SCHEMA}))
            runner = driver.NativeDiagnostic({'build': str(root)}, root)
            with patch.object(runner, 'command') as command, patch.object(runner, 'clock') as clock, patch.object(runner, 'pan') as pan:
                with self.assertRaises(ValueError):
                    runner.run()
                command.assert_not_called()
                clock.assert_not_called()
                pan.assert_not_called()


def profile(path, report):
    digest = hashlib.sha256()
    frames = events = terminators = bad = gaps = 0
    for record in reader.records(path):
        if record['kind'] == 'frame':
            frames += 1
            value = record['value']
            seq = record['sequence']
            bindings = value['diagnosticIdentity']['bindings']
            assert len(bindings) == 9
            assert bindings[0]['geometry']['frameInWindow']['x'].number == seq + .125
            assert value['doubleBitsFixture'] == [reader.DoubleBits(0x8000000000000000), reader.DoubleBits(0x7ff8000000000042), reader.DoubleBits(0x7ff0000000000000)]
            assert value['nativeFailure'] == (seq % 101 == 0)
            expected_time = seq * 16.666 + (125.0 if seq % 97 == 0 else 0.0)
            assert value['nativeUptimeMs'].number == expected_time
            assert value['readEndNativeMs'].number == expected_time + (7.0 if seq % 83 == 0 else 1.0)
            bad += int(seq % 83 == 0)
            gaps += int(seq % 97 == 0)
            if report['frames'] <= 128 or seq % 128 == 1 or seq == report['frames']:
                digest.update(encode(value))
        elif record['kind'] == 'terminator':
            terminators += 1
            assert record['value']['lastCapturedSequence'] == report['frames']
        else:
            events += 1
    assert frames == report['frames']
    assert digest.hexdigest() == report['sampledExpandedSHA256']
    assert report['lastDurableSequence'] == frames
    assert events == frames // 17 + frames // 113
    if report['stop'] is not None:
        assert terminators == 1
    print(json.dumps({'validatedFrames': frames, 'badFramesPreserved': bad, 'gapFramesPreserved': gaps,
        'terminators': terminators, 'sampledExactExpandedHash': True, 'mode': report['mode']}))


if __name__ == '__main__':
    if len(sys.argv) == 3:
        profile(Path(sys.argv[1]), json.loads(Path(sys.argv[2]).read_text()))
    else:
        unittest.main()
