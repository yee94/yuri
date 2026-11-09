"""Build/run only the pure Foundation model. Never starts UIKit, NSH, a device, or a Host."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile


def run(command):
    result = subprocess.run(command, capture_output=True, text=True)
    if result.returncode:
        raise RuntimeError(result.stderr or result.stdout)
    return result.stdout


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--input', required=True, type=Path)
    parser.add_argument('--output', required=True, type=Path)
    parser.add_argument('--frames', type=int, default=18000)
    parser.add_argument('--mode', choices=['typed', 'native', 'normal'], default='typed')
    parser.add_argument('--batches', nargs='+', type=int, choices=[8, 16, 32], default=[8, 16, 32])
    args = parser.parse_args()
    if not 1 <= args.frames <= 18000 or args.input.stat().st_size > 4 * 1024 * 1024:
        raise ValueError('bounded small nine-binding input and 1...18000 generated frames required')
    args.output.mkdir(parents=True, exist_ok=False)
    root = Path(__file__).resolve().parent
    swift = ['SnapshotValue.swift', 'SegmentWriter.swift', 'CapturePipeline.swift', 'Profile.swift']
    sources = swift + ['stream_reader.py', 'stream_reader_test.py']
    hashes = {name: hashlib.sha256((root / name).read_bytes()).hexdigest() for name in sources}
    summary = {'schema': 'history-v4-pure-pressure-v1', 'complete': False, 'sourceSHA256': hashes,
        'mode': args.mode, 'inputBytes': args.input.stat().st_size, 'inputSHA256': hashlib.sha256(args.input.read_bytes()).hexdigest(),
        'scope': 'generated full deep values; no UIKit timing or original capture reads', 'reports': []}
    result_file = args.output / 'results.json'

    def save():
        temporary = args.output / 'results.pending.json'
        temporary.write_text(json.dumps(summary, indent=2))
        temporary.replace(result_file)

    save()
    try:
        with tempfile.TemporaryDirectory(prefix='history-v4-pressure-', dir=os.environ.get('NSH_TEST_TEMP_ROOT')) as temporary:
            temporary = Path(temporary)
            binary = temporary / 'profile'
            # Compile the exact snapshotted source bytes; detect later worktree changes before claiming complete.
            for name in sources:
                (temporary / name).write_bytes((root / name).read_bytes())
            run(['xcrun', '--sdk', 'macosx', 'swiftc', '-O', '-swift-version', '6', '-parse-as-library',
                *[str(temporary / name) for name in swift], '-o', str(binary)])
            for batch in args.batches:
                with tempfile.TemporaryDirectory(prefix=f'batch-{batch}-', dir=temporary) as trial:
                    trial = Path(trial)
                    segments = trial / 'segments'
                    text = run([str(binary), str(args.input.resolve()), str(segments), str(args.frames), str(batch), args.mode])
                    report = json.loads(text)
                    report_file = trial / 'report.json'
                    report_file.write_text(text)
                    checked = run(['python3', str(temporary / 'stream_reader_test.py'), str(segments / report['manifest']), str(report_file)])
                    report['reader'] = json.loads(checked)
                    report['totalDiskBytes'] = sum(file.stat().st_size for file in segments.iterdir())
                    assert report['frames'] == args.frames and report['lastDurableSequence'] == args.frames
                    assert report['peakBatchFrames'] <= batch
                    assert report['peakQueuedAllocatorBudget'] <= 2 * report['batchAllocatorBudget'] + 16384
                    assert report['maxRSSBytes'] < 512 * 1024 * 1024
                    # Keep the small final manifest as a cost/index record, not as a usable capture after test cleanup.
                    manifest = json.loads((segments / report['manifest']).read_bytes())
                    (args.output / f'batch-{batch}-manifest-summary.json').write_text(json.dumps(manifest, indent=2))
                    summary['reports'].append(report)
                    save()
                    print(json.dumps(report), flush=True)
            for name in sources:
                if hashlib.sha256((root / name).read_bytes()).hexdigest() != hashes[name]:
                    raise RuntimeError('source changed during pressure: ' + name)
        summary['complete'] = True
        save()
        print(json.dumps({'complete': True, 'results': str(result_file)}), flush=True)
    except Exception as error:
        summary['failure'] = str(error)
        save()
        raise


if __name__ == '__main__':
    main()
