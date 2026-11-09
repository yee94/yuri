"""Offline native-type replay of a captured window. Never runs UIKit or reads device state."""
import argparse
import hashlib
import json
from pathlib import Path
import statistics
import struct
import subprocess
import random


def protocol_probe(args):
    source = args.source.read_text()
    source += '''
@MainActor @inline(never) func probeNull(_ value: Any, operation: String) throws -> Bool {
    switch operation {
    case "arrayProtocol": return value is any HistorySnapshotArrayCopy
    case "objectProtocol": return value is any HistorySnapshotObjectCopy
    case "nullClassCast": return value is NSNull
    case "nullExactType": return type(of: value) == NSNull.self
    default: return try HistorySnapshotValue.freeze(value) == .null
    }
}
'''
    swift = args.output / 'SnapshotProbe.swift'
    swift.write_text(source)
    main_source = args.output / 'Main.swift'
    main_source.write_text('''import Foundation
import Darwin
@main struct Probe {
 @MainActor static func main() throws {
  let value: Any = NSNull(), operation = CommandLine.arguments[1]
  func cpu() -> Double { var t = timespec(); clock_gettime(CLOCK_THREAD_CPUTIME_ID, &t); return Double(t.tv_sec) * 1000 + Double(t.tv_nsec) / 1000000 }
  var samples: [[String: Double]] = []
  for _ in 0..<16 {
   let c = cpu(), start = ProcessInfo.processInfo.systemUptime
   let result = try probeNull(value, operation: operation)
   let end = ProcessInfo.processInfo.systemUptime, endedCPU = cpu()
   precondition(result == ["nullClassCast", "nullExactType", "freeze"].contains(operation))
   samples.append(["wallMs": (end-start)*1000, "threadCPUMs": endedCPU-c])
  }
  print(String(data: try JSONSerialization.data(withJSONObject: samples), encoding: .utf8)!)
 }
}
''')
    binary = args.output / 'protocol-probe'
    subprocess.run(['xcrun', '--sdk', 'macosx', 'swiftc', '-O', '-swift-version', '6', '-parse-as-library', str(swift), str(main_source), '-o', str(binary)], check=True, capture_output=True)
    modes = ['arrayProtocol', 'objectProtocol', 'nullClassCast', 'nullExactType', 'freeze']
    reports = {mode: {'samples': []} for mode in modes}
    order = [(mode, index) for index in range(args.runs) for mode in modes]
    random.Random(6417).shuffle(order)
    for mode, _ in order:
        run = subprocess.run([str(binary), mode], check=True, capture_output=True, text=True)
        reports[mode]['samples'].append(json.loads(run.stdout))
    for report in reports.values():
        report['firstWallMedianMs'] = statistics.median(x[0]['wallMs'] for x in report['samples'])
        report['firstCPUMedianMs'] = statistics.median(x[0]['threadCPUMs'] for x in report['samples'])
        report['warmWallMedianMs'] = statistics.median(y['wallMs'] for x in report['samples'] for y in x[1:])
    (args.output / 'results.json').write_text(json.dumps({'scope': 'isolated same private conformance probes on NSNull; no UIKit', 'reports': reports}, indent=2))
    print(json.dumps({mode: {k: v for k, v in report.items() if k != 'samples'} for mode, report in reports.items()}, indent=2))


def word(value):
    return struct.unpack('>Q', struct.pack('>d', float(value)))[0]


def literal(value, key=''):
    if value is None:
        return 'NSNull()'
    if type(value) is bool:
        return 'true' if value else 'false'
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False).replace('\\/', '/')
    if type(value) in (int, float):
        if key in ('sequence', 'navigationBarCount', 'unsupportedSyntheticTextCount', 'animationCount'):
            return f'Int({int(value)})'
        expression = f'Double(bitPattern: {word(value)})'
        if key == 'layerOpacity':
            return f'Float({expression})'
        if key in ('readStartNativeMs', 'readEndNativeMs'):
            return expression
        if key not in ('x', 'y', 'width', 'height', 'top', 'left', 'bottom', 'right', 'alpha', 'effectiveAlpha', 'transform', 'layerTransform', 'sublayerTransform'):
            raise ValueError('Unmapped native numeric field: ' + key)
        return f'CGFloat({expression})'
    if isinstance(value, list):
        if key in ('transform', 'layerTransform', 'sublayerTransform'):
            kind = '[CGFloat]'
        elif key in ('navigationBars', 'nativeTextOwners', 'ancestorVisibility'):
            kind = '[[String: Any]]'
        else:
            kind = '[String]'
        return '(' + ('[' + ','.join(literal(x, key) for x in value) + ']' if value else '[]') + f' as {kind})'
    if isinstance(value, dict):
        kind = '[String: CGFloat]' if set(value) in ({'x', 'y', 'width', 'height'}, {'top', 'left', 'bottom', 'right'}) else '[String: Any]'
        return '([' + ','.join(json.dumps(k) + ':' + literal(v, k) for k, v in value.items()) + f'] as {kind})'
    raise ValueError(type(value))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input', type=Path, required=True)
    parser.add_argument('--source', type=Path, default=Path(__file__).with_name('SnapshotValue.swift'))
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--runs', type=int, default=12)
    parser.add_argument('--max-first-ms', type=float)
    parser.add_argument('--root-field', help='Minimise to one unchanged captured window field')
    parser.add_argument('--protocol-probe', action='store_true', help='Isolate the two actual private conformance checks, class cast and metatype equality')
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=False)
    if args.protocol_probe:
        protocol_probe(args)
        return
    window = json.loads(args.input.read_text())['result']['windowObservation']
    # Periodic read has no live-safety block or text discovery; restore exact native types below.
    window.pop('liveProtection', None)
    window['nativeTextOwners'] = []
    window['observationKind'] = 'periodic'
    if args.root_field:
        window = {args.root_field: window[args.root_field]}
    fixture = literal(window)
    probe = '''import Foundation
import Darwin
@main struct Probe {
 @MainActor static func main() throws {
  let input: [String: Any] = FIXTURE
  func cpu() -> Double { var t = timespec(); clock_gettime(CLOCK_THREAD_CPUTIME_ID, &t); return Double(t.tv_sec) * 1000 + Double(t.tv_nsec) / 1000000 }
  var measurements: [[String: Double]] = []
  var last: HistorySnapshotValue = .null
  for _ in 0..<16 {
   let c = cpu(), start = ProcessInfo.processInfo.systemUptime
   last = try HistorySnapshotValue.freeze(input)
   let end = ProcessInfo.processInfo.systemUptime, endedCPU = cpu()
   measurements.append(["wallMs": (end-start)*1000, "threadCPUMs": endedCPU-c])
  }
  var wire = Data(); last.encode(into: &wire)
  try wire.write(to: URL(fileURLWithPath: CommandLine.arguments[1]))
  print(String(data: try JSONSerialization.data(withJSONObject: measurements), encoding: .utf8)!)
 }
}
'''.replace('FIXTURE', fixture)
    (args.output / 'Probe.swift').write_text(probe)
    source = args.source.read_text()
    anchor = '        if let array = value as? any HistorySnapshotArrayCopy'
    fast = '''        if valueType == [String: Any].self, let object = value as? [String: Any] { return .object(try object.mapValues { try freeze($0) }) }
        if valueType == [[String: Any]].self, let array = value as? [[String: Any]] { return .array(try array.map { try freeze($0) }) }
        if valueType == [String: CGFloat].self, let object = value as? [String: CGFloat] { return .object(object.mapValues { .doubleBits(Double($0).bitPattern) }) }
        if valueType == [CGFloat].self, let array = value as? [CGFloat] { return .array(array.map { .doubleBits(Double($0).bitPattern) }) }
        if valueType == [String].self, let array = value as? [String] { return .array(array.map { .string($0) }) }
'''
    lines = fast.splitlines(keepends=True)
    modes = {'baseline': source, 'object-only': source.replace(anchor, lines[0] + anchor),
             'geometry-containers-only': source.replace(anchor, ''.join(lines[2:]) + anchor),
             'exact-containers': source.replace(anchor, fast + anchor),
             'null-only': source.replace(anchor, '        if valueType == NSNull.self { return .null }\n' + anchor),
             'native-adapter-no-null': source, 'native-adapter': source}
    reports = {}
    for name, text in modes.items():
        swift = args.output / (name + '.swift')
        swift.write_text(text)
        binary = args.output / name
        mode_probe = args.output / (name + '-Probe.swift')
        mode_probe.write_text(probe.replace('HistorySnapshotValue.freeze(input)', 'HistoryV4NativeSnapshotValue.freeze(input)') if name.startswith('native-adapter') else probe)
        adapter = Path(__file__).with_name('NativeSnapshotValue.swift').read_text()
        if name == 'native-adapter-no-null':
            adapter = adapter.replace('        if kind == NSNull.self { return .null }\n', '')
        mode_adapter = args.output / (name + '-Adapter.swift')
        mode_adapter.write_text(adapter)
        subprocess.run(['xcrun', '--sdk', 'macosx', 'swiftc', '-O', '-swift-version', '6', '-parse-as-library', str(swift), str(mode_adapter), str(mode_probe), '-o', str(binary)], check=True, capture_output=True)
        reports[name] = {'samples': []}
    order = [(name, index) for index in range(args.runs) for name in modes]
    random.Random(6417).shuffle(order)
    for name, index in order:
            binary = args.output / name
            wire = args.output / f'{name}-{index}.tlv'
            result = subprocess.run([str(binary), str(wire)], check=True, capture_output=True, text=True)
            values = json.loads(result.stdout)
            reports[name]['samples'].append({'first': values[0], 'warm': values[1:], 'wireSHA256': hashlib.sha256(wire.read_bytes()).hexdigest()})
    for name, report in reports.items():
        samples = report['samples']
        cold = [x['first']['wallMs'] for x in samples]
        reports[name] = {'samples': samples, 'firstMedianMs': statistics.median(cold), 'firstMaxMs': max(cold),
                         'firstCPUmedianMs': statistics.median(x['first']['threadCPUMs'] for x in samples),
                         'warmMedianMs': statistics.median(y['wallMs'] for x in samples for y in x['warm'])}
    hashes = {x['wireSHA256'] for report in reports.values() for x in report['samples']}
    if len(hashes) != 1:
        raise ValueError('native-type parity failed')
    output = {'scope': 'offline native-type window reconstruction; no UIKit or original frame acceptance',
              'inputSHA256': hashlib.sha256(args.input.read_bytes()).hexdigest(),
              'baselineSourceSHA256': hashlib.sha256(args.source.read_bytes()).hexdigest(), 'reports': reports}
    (args.output / 'results.json').write_text(json.dumps(output, indent=2))
    print(json.dumps({name: {k: v for k, v in report.items() if k != 'samples'} for name, report in reports.items()}, indent=2))
    if args.max_first_ms is not None and reports['baseline']['firstMaxMs'] > args.max_first_ms:
        raise SystemExit('RED: first native-type freeze exceeded unchanged budget; full samples preserved')


if __name__ == '__main__':
    main()
