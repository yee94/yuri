"""Explicit v4 only. Bounded segment/record reads; never json.load a capture.

DoubleBits retains IEEE payload bits until a consumer explicitly requests a number.
The iterator yields every record, including bad frames, events, controls and terminators.
"""
import argparse
import hashlib
import io
import json
import re
import struct
import uuid
from dataclasses import dataclass
from pathlib import Path

SCHEMA = 'history-native-segments-v4'
MAX_RECORD = 64 * 1024 * 1024


@dataclass(frozen=True)
class DoubleBits:
    bits: int

    @property
    def number(self):
        return struct.unpack('>d', struct.pack('>Q', self.bits))[0]


def require(condition, reason):
    if not condition:
        raise ValueError(reason)


def exact(stream, count):
    require(0 <= count <= MAX_RECORD, 'length budget')
    value = stream.read(count)
    require(len(value) == count, 'truncated value')
    return value


def uint(stream, width):
    return int.from_bytes(exact(stream, width), 'big')


def text(stream):
    return exact(stream, uint(stream, 4)).decode('utf-8', errors='strict')


def decode(stream, depth=0, budget=None):
    if budget is None:
        budget = [250000]
    budget[0] -= 1
    require(budget[0] >= 0, 'value node budget')
    require(depth < 128, 'value nesting budget')
    tag = uint(stream, 1)
    if tag == 0:
        return None
    if tag in (1, 2):
        return tag == 2
    if tag == 3:
        return int.from_bytes(exact(stream, 8), 'big', signed=True)
    if tag == 4:
        return DoubleBits(uint(stream, 8))
    if tag == 5:
        return text(stream)
    require(tag in (6, 7), 'unknown type tag')
    count = uint(stream, 4)
    require(count <= MAX_RECORD, 'container budget')
    if tag == 6:
        return [decode(stream, depth + 1, budget) for _ in range(count)]
    result = {}
    previous = None
    for _ in range(count):
        key = text(stream)
        require(previous is None or key > previous, 'duplicate or noncanonical object key')
        result[key] = decode(stream, depth + 1, budget)
        previous = key
    return result


def expand(record):
    value = record['value']
    if record['kind'] == 'frame':
        seq = record['sequence']
        require(type(seq) is int and value.get('sequence') == seq, 'frame seq')
        window, identity = value.get('windowObservation'), value.get('diagnosticIdentity')
        require(isinstance(window, dict) and window.get('sequence') == seq and isinstance(identity, dict), 'window seq')
        require(identity.get('observationKind') == 'periodic' and type(identity.get('windowObservationRef')) is int
                and identity['windowObservationRef'] == seq and 'windowObservation' not in identity, 'same-seq window ref')
        identity = dict(identity)
        del identity['windowObservationRef']
        identity['windowObservation'] = window
        value = {**value, 'diagnosticIdentity': identity}
    elif record['kind'] in ('control', 'clock'):
        # Control reads must carry their own current window, never periodic refs.
        def validate(current):
            if isinstance(current, dict):
                require('windowObservationRef' not in current, 'control periodic ref forbidden')
                if current.get('observationKind') == 'control-read' and 'bindings' in current:
                    require(isinstance(current.get('windowObservation'), dict)
                            and current['windowObservation'].get('observationKind') == 'control-read', 'control current window missing')
                for item in current.values():
                    validate(item)
            elif isinstance(current, list):
                for item in current:
                    validate(item)
        validate(value)
    return {**record, 'value': value}


def checked_file(directory, name, pattern, sha256, expected_bytes=None):
    require(isinstance(name, str) and re.fullmatch(pattern, name), 'unsafe file reference')
    path = directory / name
    require(not path.is_symlink() and path.is_file(), 'missing or symlink reference')
    if expected_bytes is not None:
        require(path.stat().st_size == expected_bytes, 'file length mismatch')
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        while chunk := stream.read(1024 * 1024):
            digest.update(chunk)
    require(digest.hexdigest() == sha256, 'file hash mismatch')
    return path


def manifest_file(path):
    path = Path(path)
    require(not path.is_symlink() and path.stat().st_size <= 16 * 1024 * 1024, 'manifest budget')
    def unique(pairs):
        result = {}
        for key, value in pairs:
            require(key not in result, 'duplicate manifest key')
            result[key] = value
        return result
    manifest = json.loads(path.read_bytes(), object_pairs_hook=unique)
    require(manifest.get('schema') == SCHEMA, 'explicit v4 schema required')
    require(set(manifest) == {'schema', 'nonce', 'revision', 'lastOrdinal', 'lastSequence', 'segments', 'metadataFile', 'metadataSHA256'}, 'manifest fields')
    require(type(manifest['revision']) is int and manifest['revision'] > 0 and type(manifest['lastOrdinal']) is int
            and manifest['lastOrdinal'] >= 0 and type(manifest['lastSequence']) is int and 0 <= manifest['lastSequence'] <= 18000, 'manifest boundaries')
    require(isinstance(manifest['segments'], list) and len(manifest['segments']) <= 25000, 'segment index budget')
    require(isinstance(manifest['nonce'], str) and str(uuid.UUID(manifest['nonce'])).lower() == manifest['nonce'].lower(), 'fence nonce')
    require(manifest['metadataFile'] == f"fence-{manifest['revision']:06d}.metadata.hns4", 'metadata revision')
    metadata = checked_file(path.parent, manifest['metadataFile'], r'fence-[0-9]{6}\.metadata\.hns4', manifest['metadataSHA256'])
    require(metadata.stat().st_size <= MAX_RECORD, 'metadata budget')
    with metadata.open('rb') as stream:
        manifest['metadata'] = decode(stream)
        require(not stream.read(1), 'metadata trailing bytes')
    return manifest


def records(path):
    path = Path(path)
    manifest = manifest_file(path)
    ordinal = sequence = 0
    for index, segment in enumerate(manifest['segments'], 1):
        require(set(segment) == {'file', 'sha256', 'bytes', 'firstOrdinal', 'lastOrdinal', 'lastSequence'}, 'segment fields')
        require(segment['file'] == f'segment-{index:06d}.hns4' and segment['firstOrdinal'] == ordinal + 1, 'segment order')
        file = checked_file(path.parent, segment['file'], r'segment-[0-9]{6}\.hns4', segment['sha256'], segment['bytes'])
        with file.open('rb') as stream:
            require(exact(stream, 6) == b'HNSV4\n', 'segment magic')
            while first := stream.read(4):
                require(len(first) == 4, 'truncated record length')
                payload = io.BytesIO(exact(stream, int.from_bytes(first, 'big')))
                record = decode(payload)
                require(not payload.read(1), 'record trailing bytes')
                require(isinstance(record, dict) and set(record) == {'ordinal', 'kind', 'sequence', 'value'}, 'record fields')
                require(type(record['ordinal']) is int and record['ordinal'] == ordinal + 1, 'record ordinal')
                require(type(record['sequence']) is int, 'sequence type')
                if record['kind'] == 'frame':
                    require(type(record['sequence']) is int and record['sequence'] == sequence + 1 and sequence < 18000, 'frame ordering')
                    sequence += 1
                else:
                    require(record['kind'] in ('event', 'control', 'clock', 'host', 'terminator') and record['sequence'] == sequence, 'nonframe sequence')
                ordinal += 1
                yield expand(record)
        require(segment['lastOrdinal'] == ordinal and segment['lastSequence'] == sequence, 'segment end boundary')
    require(manifest['lastOrdinal'] == ordinal and manifest['lastSequence'] == sequence, 'manifest prefix boundary')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Validate v4 stream without loading a capture or enabling input')
    parser.add_argument('manifest')
    args = parser.parse_args()
    counts = {}
    for record in records(args.manifest):
        counts[record['kind']] = counts.get(record['kind'], 0) + 1
    print(json.dumps({'schema': SCHEMA, 'counts': counts, 'automaticInput': False, 'strictAcceptance': False}))
