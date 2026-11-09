"""Independent field oracle against the small original JSON read, not the Swift encoder's own hash."""
import copy
import importlib.util
import json
from pathlib import Path
import struct
import sys
import uuid

spec = importlib.util.spec_from_file_location('source_oracle_reader', Path(__file__).with_name('stream_reader.py'))
reader = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = reader
spec.loader.exec_module(reader)


def equal(actual, expected):
    if isinstance(expected, reader.DoubleBits):
        assert actual == expected
    elif isinstance(expected, dict):
        assert isinstance(actual, dict) and actual.keys() == expected.keys(), 'object fields differ'
        for key in expected:
            equal(actual[key], expected[key])
    elif isinstance(expected, list):
        assert isinstance(actual, list) and len(actual) == len(expected), 'array fields differ'
        for left, right in zip(actual, expected):
            equal(left, right)
    elif type(expected) is bool:
        assert type(actual) is bool and actual == expected
    elif type(expected) is float:
        # JSON has a single number type; a boxed Foundation integral number may use Int64.
        if isinstance(actual, reader.DoubleBits):
            assert actual.bits == int.from_bytes(struct.pack('>d', expected), 'big')
        else:
            assert type(actual) is int and actual == expected
    elif type(expected) is int:
        assert (type(actual) is int and actual == expected) or (isinstance(actual, reader.DoubleBits) and actual.number == expected)
    else:
        assert type(actual) is type(expected) and actual == expected


def verify(manifest, source_path):
    source_path = Path(source_path)
    assert source_path.stat().st_size <= 4 * 1024 * 1024
    source = json.loads(source_path.read_bytes())
    source = source.get('result', source)
    identity = copy.deepcopy(source)
    window = identity['windowObservation']
    identity['observationKind'] = window['observationKind'] = 'periodic'
    expected = {'sequence': 0, 'nativeUptimeMs': 0.0, 'readEndNativeMs': 0.0, 'windowObservation': window,
        'diagnosticIdentity': identity, 'nativeFailure': False,
        'doubleBitsFixture': [reader.DoubleBits(0x8000000000000000), reader.DoubleBits(0x7ff8000000000042), reader.DoubleBits(0x7ff0000000000000)]}
    frames = controls = events = 0
    for record in reader.records(manifest):
        if record['kind'] == 'frame':
            seq = record['sequence']
            expected['sequence'] = window['sequence'] = identity['lastPeriodicSequence'] = seq
            identity['bindings'][0]['geometry']['frameInWindow']['x'] = seq + .125
            expected['nativeUptimeMs'] = seq * 16.666 + (125.0 if seq % 97 == 0 else 0.0)
            expected['readEndNativeMs'] = expected['nativeUptimeMs'] + (7.0 if seq % 83 == 0 else 1.0)
            expected['nativeFailure'] = seq % 101 == 0
            equal(record['value'], expected)
            frames += 1
        elif record['kind'] == 'control':
            assert record['value'].keys() == {'nonce', 'result'}
            uuid.UUID(record['value']['nonce'])
            equal(record['value']['result'], source)
            controls += 1
        elif record['kind'] == 'event':
            equal(record['value'], {'phase': 'deep-profile-event', 'beforeSequence': record['sequence'] + 1})
            events += 1
    print(json.dumps({'allFieldsComparedToSmallSource': True, 'frames': frames, 'controls': controls, 'events': events}))


if __name__ == '__main__':
    verify(sys.argv[1], sys.argv[2])
