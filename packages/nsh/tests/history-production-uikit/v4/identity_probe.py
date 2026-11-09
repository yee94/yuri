"""Main-only prepare -> read -> AX -> read. Never launches an app, navigates, taps, marks or pans."""
import argparse
import hashlib
import json
import math
import re
from pathlib import Path
import subprocess
import urllib.parse
import urllib.request


def require(condition, reason):
    if not condition:
        raise ValueError(reason)


def bounded_json(path, limit=16 * 1024 * 1024):
    with Path(path).open('rb') as stream:
        raw = stream.read(limit + 1)
    require(len(raw) <= limit, 'JSON evidence exceeds bounded input budget')
    return json.loads(raw)


def exposure(read):
    start, end = read.get('readStartNativeMs'), read.get('readEndNativeMs')
    return (type(start) in (int, float) and type(end) in (int, float) and math.isfinite(start) and math.isfinite(end)
            and start >= 0 and 0 <= end - start <= 5)


def flatten(value):
    if isinstance(value, dict):
        yield value
        for child in value.values():
            yield from flatten(child)
    elif isinstance(value, list):
        for child in value:
            yield from flatten(child)


def collect(build, data, output, helper, udid):
    parsed = urllib.parse.urlparse(helper)
    require(parsed.scheme == 'http' and parsed.hostname in ('localhost', '127.0.0.1') and parsed.path in ('', '/')
            and not parsed.username and not parsed.password and not parsed.query and not parsed.fragment, 'Existing loopback simulator helper only')
    require(udid and all(c in '0123456789abcdefABCDEF-' for c in udid), 'Explicit simulator UUID required')
    manifest = bounded_json(build / 'manifest.json')
    require(manifest.get('appBuilt') is True and manifest.get('observerVersion') == 'v4'
            and manifest.get('observerProfile') == 'identity-only' and manifest.get('periodicSampling') is False
            and manifest.get('historyDriverAdmission') is False and manifest.get('experimentOn') is False, 'Installed identity-only OFF artifact required')
    ready = bounded_json(data / 'ready.json', 1024 * 1024)
    identity = {key: manifest[key] for key in ('buildID', 'bundleSHA256', 'executableSHA256')}
    require(ready.get('identity') == identity and ready.get('observerProfile') == 'identity-only'
            and ready.get('periodicSampling') is False and ready.get('automaticInput') is False, 'Wrong ready identity/profile; ui-parity is not an identity recorder')
    process = ready.get('processNonce')
    require(isinstance(process, str) and process, 'Missing process identity')
    clock = build / 'tools/clock-client'
    require(hashlib.sha256(clock.read_bytes()).hexdigest() == manifest['toolBinaries']['clock-client'], 'Wrong frozen clock-client')
    output.mkdir(parents=True, exist_ok=False)
    (output / 'ready.json').write_text(json.dumps(ready, indent=2))
    nonces = set()

    def control(command, name):
        result = subprocess.run([str(clock), str(data), command], capture_output=True, text=True, timeout=12)
        # Save exactly what the file-handshake client returned before validating any admission fields.
        (output / name).write_text(result.stdout)
        if result.stderr:
            (output / (name + '.stderr.txt')).write_text(result.stderr)
        require(result.returncode == 0, 'Control failed; preserve failure.json from the App and stop')
        ack = json.loads(result.stdout)
        require(ack.get('identity') == identity and ack.get('processNonce') == process and ack.get('command') == command, 'Wrong process/build/command ACK')
        require(ack.get('nonce') not in nonces and isinstance(ack.get('nonce'), str), 'Repeated/missing nonce')
        nonces.add(ack['nonce'])
        require(type(ack.get('revision')) is int and type(ack.get('durableSequence')) is int and ack.get('manifest')
                and ack.get('manifestSHA256') and type(ack.get('ackNativeMs')) in (int, float), 'No actual durable export receipt')
        require(re.fullmatch(r'fence-[0-9]{6}\.json', ack['manifest']), 'Unsafe manifest reference')
        fence_path = data / 'segments' / ack['manifest']
        require(fence_path.stat().st_size <= 16 * 1024 * 1024, 'Fence budget')
        require(hashlib.sha256(fence_path.read_bytes()).hexdigest() == ack['manifestSHA256'], 'Durable manifest hash mismatch')
        fence = bounded_json(fence_path)
        require(fence.get('schema') == 'history-native-segments-v4' and fence.get('nonce') == ack['nonce']
                and fence.get('revision') == ack['revision'] and fence.get('lastSequence') == ack['durableSequence'], 'Wrong durable fence identity')
        return ack

    prepare = control('prepare-ax', 'prepare.json')
    before = control('read-ax', 'native-before.json')
    url = helper.rstrip('/') + '/helper/' + urllib.parse.quote(udid, safe='') + '/ax'
    with urllib.request.urlopen(url, timeout=5) as response:
        raw = response.read(8 * 1024 * 1024 + 1)
    (output / 'ax.json').write_bytes(raw)
    require(len(raw) <= 8 * 1024 * 1024, 'AX tree budget exceeded; raw response preserved')
    tree = json.loads(raw)
    after = control('read-ax', 'native-after.json')
    tokens = [node.get('AXUniqueId') for node in flatten(tree)
              if isinstance(node.get('AXUniqueId'), str) and node['AXUniqueId'].startswith('hpdiag-ax-')]
    result = prepare['result']
    assigned_tokens = {binding.get('token') for binding in before['result'].get('bindings', []) if isinstance(binding.get('token'), str)}
    baseline = result.get('identityBaseline', {})
    confirmed = result.get('prepared') is True and type(result.get('assignedCount')) is int and result['assignedCount'] > 0
    confirmed = confirmed and result.get('readbackConfirmedCount') == result['assignedCount']
    reads = [before['result'], after['result']]
    confirmed = confirmed and all(exposure(read) and len(read.get('bindings', [])) >= result['assignedCount']
        and all(binding.get('valid') is True and binding.get('assignmentReadbackKind') == 'ours' for binding in read.get('bindings', [])) for read in reads)
    report = {'status': 'collected', 'identity': identity, 'processNonce': process, 'prepare': result,
        'identityReadbacksConfirmed': bool(confirmed), 'axTokenCount': len(tokens),
        'axTokensMatchingAssigned': len(set(tokens) & assigned_tokens),
        'foregroundApplicationMatches': isinstance(tree, list) and bool(tree) and tree[0].get('AXLabel') == 'History Production QA',
        'readExposureWithin5ms': [exposure(read) for read in reads], 'baseline': baseline,
        'periodicSampling': False, 'automaticPan': False, 'strictAcceptance': False, 'sdkAdoptionIdentity': None,
        'production53ptVerdict': 'unresolved', 'scope': 'identity-only evidence; durable ACK is export completion, not identity/SDK adoption or performance acceptance'}
    (output / 'summary.json').write_text(json.dumps(report, indent=2))
    print(json.dumps(report))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--build', type=Path, required=True)
    parser.add_argument('--data', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--helper-origin', required=True)
    parser.add_argument('--udid', required=True)
    args = parser.parse_args()
    collect(args.build.resolve(), args.data.resolve(), args.output.resolve(), args.helper_origin, args.udid)
