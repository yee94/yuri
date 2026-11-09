#!/usr/bin/env python3
"""Independent <=70s native-only red diagnostic on the already-running production fixture."""
import argparse
import hashlib
import importlib.util
import itertools
import json
from pathlib import Path
import re
import signal
import subprocess
import sys
import time


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    return module


# Import only public parsing/native math, never Smoke or a recorder lifecycle.
matching = load('native_diagnostic_matching', 'smoke.py')
moving = load('native_diagnostic_moving', 'moving-check.py')
require = matching.require


def message_id(identifier):
    match = re.search(r'hp-\d{4}(?!\d)', identifier)
    return match.group() if match else None


def chat_chrome(tree, capture):
    bounds = tree[0]['frame']; frame = capture['frames'][-1]
    nodes = [node for node in matching.flat(tree) if matching.visible(node.get('frame'), bounds)]
    enabled = {node.get('AXUniqueId') for node in nodes if node.get('enabled')}
    present = {node.get('AXUniqueId') for node in nodes}
    compact = {'compact-edit', 'compact-latest', 'compact-attach'}.issubset(enabled) and 'compact-send' in present
    expanded = {'chat-header-metadata', 'chat-selection'}.issubset(enabled)
    require(compact or expanded, 'Neither actual expanded nor compact production Chat controls confirmed')
    composer_ids = {'compact-attach', 'compact-edit', 'compact-dictation', 'compact-latest', 'compact-send'} if compact else {'chat-selection', 'chat-agent-selection', 'send'}
    composer = [node['frame'] for node in nodes if node.get('AXUniqueId') in composer_ids]
    header = [node['frame'] for node in nodes if node.get('AXUniqueId') in ('chat-header-metadata', 'chat-header-options', 'BackButton')]
    # Footer ancestors and full-window wrappers do not identify a native header owner.
    top = max(rect['y'] + rect['height'] for rect in header) if header else None
    bottom = min(rect['y'] for rect in composer)
    for scroll in frame['scrolls']:
        if scroll.get('ownerID') == 'composer':
            bottom = min(bottom, scroll['frame']['y'] + frame['surfaceInWindow']['y'] - frame['windowBounds']['y'] + bounds['y'])
    return {'state': 'compact' if compact else 'expanded', 'headerBottomAX': top, 'headerGeometrySource': 'actual visible AX controls' if header else 'unknown; native capture has no identified header bounds',
            'composerTopAX': bottom, 'composerControlFrames': composer, 'nativeSequence': frame['sequence']}


def text_target_audit(tree, capture):
    """Retain every AX text candidate, including rejected geometry and actual ancestry."""
    chrome = chat_chrome(tree, capture)
    if capture.get('observerContract', '').startswith('instrumented-v3;'):
        return load('native_diagnostic_v3', 'native_diagnostic_v3.py').audit(tree, capture, chrome, matching, moving)
    complete = {node['id'] for node in capture['frames'][-1]['nodes'] if node['id'].startswith('body-part-') and node['fullyVisible']}
    candidates = []
    def walk(nodes, ancestors, path):
        for index, node in enumerate(nodes):
            current = path + [index]
            if node.get('type') == 'StaticText':
                reasons = []
                # Parse one original leaf at a time so duplicate geometry never loses its AX path.
                leaf_tree = [{**tree[0], 'children': [node]}]
                try:
                    targets = matching.body_targets(leaf_tree, capture)
                except ValueError as error:
                    targets = []; reasons.append(str(error))
                if not targets:
                    reasons.append('No unique enabled fully visible AX/native body correspondence')
                for target in targets:
                    rect = target['axFrame']
                    if rect['y'] + rect['height'] > chrome['composerTopAX']:
                        reasons.append('AX text extends into observed composer')
                    if chrome['headerBottomAX'] is None:
                        if target['correspondence'] != 'ANCHOR + native geometry':
                            reasons.append('Unknown safe header boundary; generic geometry is not body ownership proof')
                        if target['nativeID'] not in complete:
                            reasons.append('Unknown safe header boundary; corresponding native body is partial')
                    elif rect['y'] < chrome['headerBottomAX']:
                        reasons.append('AX text intersects observed header')
                    if target['nestedScroll']:
                        reasons.append('Nested scroll text cannot drive outer transcript')
                candidates.append({'axPath': current, 'axLabel': node.get('AXLabel'), 'axFrame': node.get('frame'),
                                   'ancestry': ancestors, 'bodyOwnershipProvenByAncestry': False,
                                   'nativeMatches': targets, 'exclusionReasons': reasons,
                                   'accepted': bool(targets) and not reasons})
            descriptor = {key: node.get(key) for key in ('type', 'AXUniqueId', 'frame')}
            walk(node.get('children') or [], ancestors + [descriptor], current)
    walk(tree, [], [])
    return {'chrome': chrome, 'candidates': candidates,
            'nativeBodyGeometry': navigation_geometry(tree, capture)['observedBodyRects'],
            'targets': [{**target, 'chatState': chrome['state'], 'headerGeometrySource': chrome['headerGeometrySource']}
                        for candidate in candidates if candidate['accepted'] for target in candidate['nativeMatches']]}


def natural_text_targets(tree, capture):
    return text_target_audit(tree, capture)['targets']


def chat_ready(tree, capture):
    try:
        chat_chrome(tree, capture)
        return True
    except ValueError:
        return False


def body_gesture(tree, capture, distance=.24):
    require(isinstance(distance, (int, float)) and 0 < distance <= .55, 'Pan distance must be positive and at most .55 of actual window height')
    candidates = [target for target in natural_text_targets(tree, capture) if not target['nestedScroll']]
    require(candidates, 'No verified unobscured outer-body natural text range')
    # Prefer a message marker over generic text; every point still comes from its actual AX rect.
    candidates.sort(key=lambda target: (target['correspondence'] != 'ANCHOR + native geometry', target['axFrame']['y'], target['nativeID']))
    chrome = chat_chrome(tree, capture); bounds = tree[0]['frame']; frame = capture['frames'][-1]
    viewport = moving.transcript(frame)['frame']
    viewport_bottom = viewport['y'] + viewport['height'] + frame['surfaceInWindow']['y'] - frame['windowBounds']['y'] + bounds['y']
    last_safe_y = min(chrome['composerTopAX'], viewport_bottom, bounds['y'] + bounds['height']) - 1 / frame['screenScale']
    for target in candidates:
        source = target['point']; source_y = bounds['y'] + source['y'] * bounds['height']
        end_y = min(source_y + distance * bounds['height'], last_safe_y)
        # Navigation admission only, not a UIKit threshold or the 1.1pt measurement criterion.
        if end_y - source_y < 32: continue
        end = {'x': source['x'], 'y': (end_y - bounds['y']) / bounds['height']}
        return source, end, {**target, 'intendedDistancePt': end_y - source_y, 'endBoundarySource': 'observed composer/viewport edge minus one actual screen pixel'}
    raise ValueError('No verified body corridor >=32pt; do not repeat tiny unrecognized gestures')


def navigation_geometry(tree, capture):
    chrome = chat_chrome(tree, capture); frame = capture['frames'][-1]; viewport = moving.transcript(frame)['frame']
    bounds = tree[0]['frame']; window = frame['windowBounds']; surface = frame['surfaceInWindow']
    def convert(rect):
        return {**rect, 'x': rect['x'] + surface['x'] - window['x'] + bounds['x'], 'y': rect['y'] + surface['y'] - window['y'] + bounds['y']}
    area = convert(viewport)
    lower = max(area['y'], chrome['headerBottomAX']) if chrome['headerBottomAX'] is not None else area['y']
    upper = min(area['y'] + area['height'], chrome['composerTopAX'])
    bodies = [node for node in frame['nodes'] if node['id'].startswith('body-part-')]
    triples = []
    for group in itertools.combinations(bodies, 3):
        if len({message_id(node['id']) for node in group}) != 3 or len({node['instance'] for node in group}) != 3:
            continue
        rects = [convert(node['frame']) for node in group]
        first, last = min(rect['y'] for rect in rects), max(rect['y'] + rect['height'] for rect in rects)
        start, end = lower - first, upper - last
        triples.append({'ids': [node['id'] for node in group], 'spanPt': last - first, 'nativeCompleteCount': sum(node['fullyVisible'] for node in group),
                        'necessaryTranslationIntervalPt': [start, end] if start <= end else None,
                        'impossibleEvenInOuterBound': start > end})
    footer = next((node for node in frame['nodes'] if node['id'] == 'history-load-older'), None)
    return {'chrome': chrome, 'observedBodyRects': [{'id': node['id'], 'instance': node['instance'], 'frame': convert(node['frame']), 'fullyVisible': node['fullyVisible']} for node in bodies],
            'availableHeightOuterBoundPt': upper - lower, 'lowerEdgeSource': 'actual header controls' if chrome['headerBottomAX'] is not None else 'viewport edge only; header/status-bar boundary unknown',
            'observedTriples': triples, 'footerRect': convert(footer['frame']) if footer else None,
            'minimumFooterShiftToFullVisibilityPt': max(0, lower - convert(footer['frame'])['y']) if footer else None,
            'scope': 'Observed triples only; necessary fit bound, not proof of full visual exposure or all-history impossibility; not an input offset command'}


def choose_anchors(capture, excluded=None, visible_ids=None):
    excluded = excluded or set()
    candidates = [node for node in capture['frames'][-1]['nodes'] if node['id'].startswith('body-part-') and node['fullyVisible'] and message_id(node['id']) not in excluded and (visible_ids is None or node['id'] in visible_ids)]
    candidates.sort(key=lambda node: (node['frame']['y'], node['id']))
    for group in itertools.combinations(candidates, 3):
        try:
            moving.independent(group)
            return [node['id'] for node in group]
        except ValueError:
            continue
    raise ValueError('No three complete independent old bodies (target message excluded)')


def stable_before(capture, identifiers):
    frames = capture['frames']; end = frames[-1]['nativeUptimeMs']
    rows = [frame for frame in frames if end - 300 <= frame['nativeUptimeMs'] <= end]
    require(len(rows) >= 3 and end - rows[0]['nativeUptimeMs'] >= 250, 'Missing actual 250ms native baseline')
    base = moving.transcript(rows[0]); nodes = None
    for previous, frame in zip(rows, rows[1:]):
        require(frame['sequence'] == previous['sequence'] + 1 and 0 < frame['nativeUptimeMs'] - previous['nativeUptimeMs'] and frame['readEndNativeMs'] - previous['nativeUptimeMs'] <= 50, 'Baseline native time gap')
    for frame in rows:
        view = moving.transcript(frame)
        require(view['instance'] == base['instance'] and view['frame'] == base['frame'] and not any(view[key] for key in ('tracking', 'dragging', 'decelerating')), 'Baseline viewport moving/recycled')
        selected = []
        for identifier in identifiers:
            found = [node for node in frame['nodes'] if node['id'] == identifier]
            require(len(found) == 1, 'Baseline body missing/duplicate')
            selected.append(found[0])
        moving.independent(selected)
        if nodes is None:
            nodes = selected
        require(all(node['instance'] == baseline['instance'] and node['frame']['width'] == baseline['frame']['width'] and node['frame']['height'] == baseline['frame']['height'] and abs(node['frame']['y'] - baseline['frame']['y']) <= 1.1 for node, baseline in zip(selected, nodes)), 'Baseline bodies are not stable')
    return rows[-1]['sequence']


def raw_signals(capture, start_sequence, end_sequence):
    """Unfiltered native observations are retained even when no three-anchor verdict is possible."""
    frames = [frame for frame in capture['frames'] if start_sequence <= frame['sequence'] <= end_sequence]
    require(frames, 'No native samples in phase')
    base = frames[0]
    changes = []
    for field in ('nodes', 'controlAncestors'):
        lookup = {node['instance']: node for node in base.get(field, [])}
        for frame in frames[1:]:
            for node in frame.get(field, []):
                prior = lookup.get(node['instance'])
                if prior is not None and abs(node['frame']['height'] - prior['frame']['height']) > 1.1:
                    changes.append({'sequence': frame['sequence'], 'nativeMs': frame['nativeUptimeMs'], 'instance': node['instance'], 'id': node.get('id'), 'role': node.get('role'),
                                    'source': field, 'heightBeforePt': prior['frame']['height'], 'heightAfterPt': node['frame']['height'], 'heightDeltaPt': node['frame']['height'] - prior['frame']['height'],
                                    'owner': 'observed UIView; footer wrapper ownership unknown' if field == 'controlAncestors' else 'observed production content view'})
    timeline = []
    for frame in frames:
        try:
            view = moving.transcript(frame)
            timeline.append({'sequence': frame['sequence'], 'nativeMs': frame['nativeUptimeMs'], 'readEndNativeMs': frame['readEndNativeMs'], 'instance': view['instance'], 'frame': view['frame'],
                             'contentHeight': view['contentHeight'], 'offsetY': view['offsetY'], 'tracking': view['tracking'], 'dragging': view['dragging'], 'decelerating': view['decelerating'], 'pan': view['pan']})
        except ValueError:
            timeline.append({'sequence': frame['sequence'], 'invalid': 'no unique transcript'})
    return {'startSequence': start_sequence, 'endSequence': end_sequence, 'nativeStartMs': base['nativeUptimeMs'], 'nativeEndMs': frames[-1]['readEndNativeMs'],
            'heightChanges': changes, 'scrollTimeline': timeline,
            'bodyIdentityBefore': [{key: node[key] for key in ('id', 'instance', 'frame', 'fullyVisible')} for node in base['nodes'] if node['id'].startswith(('body-part-', 'turn-body-'))],
            'bodyIdentityAfter': [{key: node[key] for key in ('id', 'instance', 'frame', 'fullyVisible')} for node in frames[-1]['nodes'] if node['id'].startswith(('body-part-', 'turn-body-'))],
            'events': [event for event in capture['events'] if base['nativeUptimeMs'] <= event.get('nativeUptimeMs', -1) <= frames[-1]['readEndNativeMs']],
            'hostEvents': [event for event in capture['host']['journal'] if base['nativeUptimeMs'] <= event.get('nativeUptimeMs', -1) <= frames[-1]['readEndNativeMs']],
            'sdkAdoptionIdentity': None, 'scope': 'raw native facts; no pixel/video coverage or causal proof'}


def reading_diagnostic(capture, mark, end_sequence):
    events = [event for event in capture['events'] if event['phase'] == 'mark' and event['nonce'] == mark['nonce']]
    require(len(events) == 1 and events[0]['anchors'] == mark['anchors'], 'Missing real native pre-action mark')
    first = events[0]['lastPeriodicSequence']
    frames = [frame for frame in capture['frames'] if first <= frame['sequence'] <= end_sequence]
    require(len(frames) >= 3 and frames[0]['sequence'] == first and frames[-1]['readEndNativeMs'] - events[0]['nativeUptimeMs'] >= 1000, 'Missing native marked one-second post window')
    stable_before({**capture, 'frames': [frame for frame in capture['frames'] if frame['sequence'] <= first]}, mark['anchors'])
    baseline = moving.transcript(frames[0]); selected = []
    for identifier in mark['anchors']:
        found = [node for node in frames[0]['nodes'] if node['id'] == identifier]
        require(len(found) == 1, 'Baseline body missing/duplicate')
        selected.append(found[0])
    moving.independent(selected)
    scale = frames[0]['screenScale']; require(moving.finite(scale) and scale > 0, 'Invalid actual scale')
    samples = []
    for previous, frame in zip(frames, frames[1:]):
        require(frame['sequence'] == previous['sequence'] + 1 and frame['nativeUptimeMs'] > previous['nativeUptimeMs'] and frame['readEndNativeMs'] - previous['nativeUptimeMs'] <= 50, 'Native sequence/time gap')
    for frame in frames:
        view = moving.transcript(frame)
        require(not frame['nativeFailure'] and not frame['presentedController'] and frame['screenScale'] == scale and frame['windowBounds'] == frames[0]['windowBounds'] and frame['surfaceInWindow'] == frames[0]['surfaceInWindow'], 'Native overlay/coordinate change')
        require(view['instance'] == baseline['instance'] and view['frame'] == baseline['frame'] and not any(view[key] for key in ('tracking', 'dragging', 'decelerating')), 'Nonstationary native reading window')
        require(0 <= frame['readEndNativeMs'] - frame['nativeUptimeMs'] <= 5, 'Native read exposure ambiguous')
        current = []
        for before in selected:
            matches = [node for node in frame['nodes'] if node['id'] == before['id']]
            require(len(matches) == 1 and matches[0]['instance'] == before['instance'] and matches[0]['frame']['width'] == before['frame']['width'] and matches[0]['frame']['height'] == before['frame']['height'], 'Old body missing/reused/resized')
            current.append(matches[0])
        moving.independent(current)
        shifts = [node['frame']['y'] - before['frame']['y'] for node, before in zip(current, selected)]
        lower = max(0, min(abs(value) for value in shifts) - 2 / scale) if all(value > 0 for value in shifts) or all(value < 0 for value in shifts) else 0
        samples.append({'sequence': frame['sequence'], 'nativeMs': frame['nativeUptimeMs'], 'deltasPt': shifts, 'extraDisplacementLowerPt': lower})
    worst = max(samples, key=lambda sample: sample['extraDisplacementLowerPt'])
    return {'verdict': 'diagnostic-red' if worst['extraDisplacementLowerPt'] > 1.1 else 'inconclusive', 'mode': 'native-reading', 'worst': worst, 'samples': samples,
            'startNativeMs': frames[0]['nativeUptimeMs'], 'endNativeMs': frames[-1]['readEndNativeMs'], 'coordinateErrorPt': 2 / scale}


def analyze(capture, attempt, clocks):
    result = {'verdict': 'inconclusive', 'strictAcceptance': 'not evaluated', 'video': 'none', 'original53pt': 'unresolved', 'attempt': attempt}
    try:
        require(not capture['overflow'] and not capture['nativeFailure'] and not capture['host']['journalOverflow'] and capture['host']['startupSweeps'] >= 1 and capture['host']['rejected'] == capture['host']['mutations'] == 0, 'Native/Host capture invalid')
        mark = attempt['mark']; end = attempt['endSequence']
        result['signals'] = raw_signals(capture, mark['baselineSequence'], end)
        events = result['signals']['hostEvents']
        if attempt['mode'] in ('pagination', 'partial-footer'):
            require(any(event['phase'] == 'history-response' and isinstance(event.get('requestCursor'), str) for event in events), 'No actual older-page response in this marked phase')
        if attempt['mode'] == 'partial-footer':
            before = next(frame for frame in capture['frames'] if frame['sequence'] == mark['baselineSequence'])
            after = next(frame for frame in capture['frames'] if frame['sequence'] == end)
            require(any(node['id'] == 'history-page-error' for node in before['nodes']) and not any(node['id'] == 'history-page-error' for node in after['nodes']), 'No actual partial error-footer retirement observed')
        if attempt['mode'] == 'body-growth':
            growth = any(change['source'] == 'nodes' and (change['id'] or '').startswith(('body-part-', 'turn-body-')) and change['heightDeltaPt'] > 1.1 for change in result['signals']['heightChanges'])
            appeared = any(event['phase'] == 'native-first-observed' and (event.get('id') or '').startswith('body-part-') for event in result['signals']['events'])
            require(growth or appeared, 'No actual body expansion/new body view observed')
        if attempt['input'] == 'pan':
            bounded = {**mark, 'phase': 'assessment', 'assessmentEndNativeMs': result['signals']['nativeEndMs']}
            windows = matching.candidate_windows(capture, [bounded])
            require(windows, 'No actual page request/response in the premarked pan interval')
            candidates = []
            for window in windows:
                if window['invalidReason']:
                    candidates.append({'verdict': 'inconclusive', 'reason': window['invalidReason']}); continue
                try:
                    item = moving.diagnose(capture, mark['nonce'], window['firstSequence'], window['lastSequence'], window['requestID'])
                    item['clock'] = moving.check_clock(clocks, capture, item['startNativeMs'], item['endNativeMs'])
                    item['verdict'] = 'diagnostic-red' if item['verdict'] == 'moving-diagnostic-red' else 'inconclusive'
                    candidates.append(item)
                except (ValueError, KeyError, StopIteration) as error:
                    candidates.append({'verdict': 'inconclusive', 'reason': str(error)})
            result['panWindows'] = candidates
            result['verdict'] = 'diagnostic-red' if any(item['verdict'] == 'diagnostic-red' for item in candidates) else 'inconclusive'
        else:
            item = reading_diagnostic(capture, mark, end)
            item['clock'] = moving.check_clock(clocks, capture, item['startNativeMs'], item['endNativeMs'])
            result['nativeReading'] = item; result['verdict'] = item['verdict']
    except (ValueError, KeyError, TypeError, StopIteration) as error:
        result['reason'] = str(error)
    return result


def visible_controls(tree, prefix):
    return [node for node in matching.flat(tree) if (node.get('AXUniqueId') or '').startswith(prefix) and node.get('enabled') and matching.visible(node.get('frame'), tree[0]['frame'])]


def expansion_target(tree):
    for prefix in ('body-reasoning-', 'tool-expand-tool-', 'body-activity-'):
        for node in visible_controls(tree, prefix):
            label = node.get('AXLabel') or ''
            if label.startswith('展开') or label.lower().startswith(('expand ', 'show ')):
                return node['AXUniqueId']
    return None


class WorkDeadline:
    """SIGALRM records expiry only; it can never throw into final record writing."""
    def __init__(self, runner):
        self.runner = runner; self.previous = None; self.cancelled = False; self.expired = False

    def expired_signal(self, _signal, _frame):
        self.expired = True; self.runner.deadline_expired = True

    def start(self):
        self.previous = signal.signal(signal.SIGALRM, self.expired_signal)
        signal.setitimer(signal.ITIMER_REAL, max(.01, self.runner.work_end - time.monotonic()))

    def disarm(self):
        errors = []; mask = signal.pthread_sigmask(signal.SIG_BLOCK, {signal.SIGALRM})
        try:
            if signal.SIGALRM in signal.sigpending(): self.expired_signal(signal.SIGALRM, None)
            try:
                signal.setitimer(signal.ITIMER_REAL, 0); self.cancelled = True
            except Exception as error:
                errors.append('cancel work alarm: ' + str(error))
            # Ignoring while blocked also discards a pending OS alarm before unblocking.
            signal.signal(signal.SIGALRM, signal.SIG_IGN)
        finally:
            signal.pthread_sigmask(signal.SIG_SETMASK, mask)
        return errors

    def restore(self):
        if self.cancelled and self.previous is not None:
            signal.signal(signal.SIGALRM, self.previous)


class NativeDiagnostic:
    def __init__(self, config, output):
        self.config, self.output = config, output
        self.started = time.monotonic(); self.work_end = self.started + 62; self.hard_end = self.started + 70
        self.actions, self.clocks, self.phases, self.attempts = [], [], [], []
        self.phase = 'attach'; self.touching = False; self.last_touch = None; self.sequence = 0; self.navigation_count = 0
        self.identity = None; self.process = None
        self.deadline_expired = False
        self.stalled_navigation = 0
        self.instrumented_v3 = False; self.ax_prepare = None; self.ax_sealed = False; self.ax_control_nonces = set()

    def save(self, name, data):
        file = self.output / name; temporary = self.output / (name + '.pending')
        temporary.write_text(json.dumps(data, indent=2)); temporary.replace(file)

    def persist_result(self, result):
        failures = []
        for name, value in [('actions.json', self.actions), ('phases.json', self.phases), ('attempts.json', self.attempts), ('native-sync.json', self.clocks)]:
            try: self.save(name, value)
            except (Exception, KeyboardInterrupt) as error: failures.append(name + ': ' + str(error))
        if failures:
            result['verdict'] = 'inconclusive'; result['persistenceErrors'] = failures
        self.save('result.json', result)

    def command(self, argv, cleanup=False):
        remaining = (self.hard_end if cleanup else self.work_end) - time.monotonic()
        if remaining <= .05 or self.deadline_expired and not cleanup:
            raise TimeoutError('Native diagnostic deadline reached')
        command = [str(arg) for arg in argv]
        c = self.config
        control_commands = ('clock', 'flush', 'mark', 'prepare-ax', 'read-ax') if self.instrumented_v3 else ('clock', 'flush', 'mark')
        clock_allowed = len(command) >= 3 and command[:2] == [c['clockClient'], c['data']] and command[2] in control_commands
        cli = c['serveSim']; touch_allowed = len(command) > len(cli) and command[:len(cli)] == cli and command[len(cli)] in ('tap', 'gesture')
        require(clock_allowed or touch_allowed, 'Native-only runner allows existing control-file client and official touch CLI only')
        event = {'phase': self.phase, 'argv': command, 'sendDriverMonotonicMs': time.monotonic_ns() / 1e6, 'clock': 'Python monotonic, not native touch receive ACK',
                 'status': 'in-flight', 'protocolAckObserved': False}
        self.actions.append(event)
        self.save('actions.json', self.actions)
        process = None
        try:
            process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            stdout, stderr = process.communicate(timeout=min(2.5 if cleanup else 4, remaining))
            event.update({'returnDriverMonotonicMs': time.monotonic_ns() / 1e6, 'returncode': process.returncode, 'stdout': stdout, 'stderr': stderr, 'status': 'returned'})
            require(process.returncode == 0, 'Control/touch command failed')
            return stdout.strip()
        except (subprocess.TimeoutExpired, KeyboardInterrupt) as error:
            event['status'] = 'cancel-requested'; event['cancellationReason'] = type(error).__name__
            if process is not None:
                try:
                    if process.poll() is None: process.kill()
                    stdout, stderr = process.communicate(timeout=max(0, min(.25, self.hard_end - time.monotonic())))
                    event.update({'stdout': stdout, 'stderr': stderr, 'returncode': process.returncode, 'status': 'cancelled'})
                except Exception as cancel_error:
                    event['cancellationError'] = str(cancel_error)
            raise TimeoutError('Control/touch subprocess cancelled without protocol ACK') from error
        except Exception as error:
            event['error'] = str(error)
            if event['status'] == 'in-flight': event['status'] = 'failed-before-return'
            raise
        finally:
            event['observedEndDriverMonotonicMs'] = time.monotonic_ns() / 1e6
            self.save('actions.json', self.actions)

    def clock(self, cleanup=False):
        c = self.config
        ack = json.loads(self.command([c['clockClient'], c['data'], 'clock'], cleanup=cleanup))
        require(ack['identity'] == self.identity and ack.get('processNonce') == self.process and all(ack['nonce'] != old['nonce'] for old in self.clocks), 'Clock wrong process/build/reused nonce')
        self.clocks.append(ack); self.save('native-sync.json', self.clocks)
        if self.actions:
            self.actions[-1]['protocolAckObserved'] = True; self.actions[-1]['clockNonce'] = ack['nonce']
            self.save('actions.json', self.actions)

    def capture(self, name, cleanup=False):
        c = self.config
        receipt = json.loads(self.command([c['clockClient'], c['data'], 'flush'], cleanup=cleanup))
        require(receipt.get('command') == 'flush' and isinstance(receipt.get('nonce'), str) and moving.finite(receipt.get('nativeMs')) and type(receipt.get('revision')) is int and type(receipt.get('baselineSequence')) is int, 'No actual flush ACK receipt')
        source = Path(c['data']) / 'capture.json'
        limit = c.get('maxCaptureMiB', 64) * 1024 * 1024
        require(source.stat().st_size <= limit, 'Native capture exceeds configured read-size cap; raw source remains in App sandbox')
        with source.open('rb') as stream:
            captured_bytes = stream.read(limit + 1)
        require(len(captured_bytes) <= limit, 'Native capture grew beyond configured read-size cap')
        unacknowledged = self.output / (name + '.unacknowledged')
        unacknowledged.write_bytes(captured_bytes)
        data = json.loads(captured_bytes)
        require(data.get('revision') == receipt['revision'] and data['frames'] and data['frames'][-1]['sequence'] == receipt['baselineSequence'], 'Capture does not match actual flush ACK revision/sequence')
        require(data['identity'] == self.identity and data.get('processNonce') == self.process, 'Native capture wrong process/build')
        require(not data['overflow'] and not data['nativeFailure'] and not data['host']['journalOverflow'] and data['host']['startupSweeps'] >= 1 and data['host']['rejected'] == data['host']['mutations'] == 0, 'Native/Host audit invalid or overflow')
        require(data['frames'] and (data['frames'][-1]['sequence'] > self.sequence or cleanup and data['frames'][-1]['sequence'] == self.sequence), 'Native sampler not advancing; restart App by main, never synthesize a drain')
        self.sequence = data['frames'][-1]['sequence']
        unacknowledged.replace(self.output / name)
        if self.actions:
            self.actions[-1]['protocolAckObserved'] = True
            self.actions[-1]['flushReceipt'] = {key: receipt[key] for key in ('nonce', 'revision', 'baselineSequence', 'nativeMs')}
            self.save('actions.json', self.actions)
        return data

    def ax(self, name):
        import urllib.request
        remaining = self.work_end - time.monotonic(); require(remaining > 0, 'AX deadline reached')
        with urllib.request.urlopen(self.config['helperOrigin'].rstrip('/') + '/helper/' + self.config['udid'] + '/ax', timeout=min(3, remaining)) as response:
            tree = json.load(response)
        self.save(name, tree)
        require(tree and tree[0]['AXLabel'] == 'History Production QA' and not any(node.get('AXUniqueId') == 'hp-native-error' for node in matching.flat(tree)), 'Wrong foreground App/native failure')
        return tree

    def pause(self, seconds):
        until = time.monotonic() + seconds
        require(until < self.work_end, 'Insufficient diagnostic observation budget')
        while time.monotonic() < until:
            if self.deadline_expired: raise TimeoutError('Native diagnostic work deadline during observation')
            time.sleep(max(0, min(.02, until - time.monotonic())))

    def tap(self, tree, identifier):
        point = matching.target(tree, identifier)
        self.command([*self.config['serveSim'], 'tap', str(point['x']), str(point['y']), '-d', self.config['udid'], '--url', self.config['helperOrigin']])

    def pan(self, tree, capture):
        source, end, body = body_gesture(tree, capture, self.config.get('panDistance', .24))
        self.save('body-target-%02d.json' % len(self.phases), {'phase': self.phase, 'body': body, 'source': source, 'end': end})
        if self.instrumented_v3:
            read = self.ax_control('read-ax', 'pre-touch-%02d-read-ax.json' % len(self.phases))
            load('native_diagnostic_v3', 'native_diagnostic_v3.py').revalidate(body, capture, read, (source, end))
        self.last_touch = source; self.touching = True
        self.gesture('begin', source)
        for index in range(1, 13):
            self.last_touch = {'x': source['x'], 'y': source['y'] + (end['y'] - source['y']) * index / 12}
            self.gesture('move', self.last_touch)
        self.gesture('end', end); self.touching = False

    def gesture(self, kind, point, cleanup=False):
        self.command([*self.config['serveSim'], 'gesture', json.dumps({'type': kind, **point}), '-d', self.config['udid'], '--url', self.config['helperOrigin']], cleanup=cleanup)

    def snapshot(self, tag):
        original_phase = self.phase
        if self.instrumented_v3:
            if not self.ax_sealed:
                self.phase = 'prepare-ax'
                # No capture/flush here: native preparation checks the existing periodic stable window.
                self.ax_prepare = self.ax_control('prepare-ax', tag + '-prepare-ax.json')
                require(self.ax_prepare.get('prepared') is True, 'Explicit prepare-ax refused: ' + str(self.ax_prepare.get('reason')))
                self.pause(.35)
            self.phase = 'v3-read-AX-read'
            before = self.ax_control('read-ax', tag + '-read-ax-before.json')
            tree = self.ax(tag + '-ax.json')
            after = self.ax_control('read-ax', tag + '-read-ax-after.json')
            capture = self.capture(tag + '-capture.json')
            evidence = {'v3AXReads': [before, after], 'v3AXPrepare': self.ax_prepare, 'v3AXReadOrder': ['read-ax', 'AX', 'read-ax']}
            self.save(tag + '-v3-evidence.json', evidence)
            capture = {**capture, **evidence}
        else:
            capture = self.capture(tag + '-capture.json'); tree = self.ax(tag + '-ax.json')
        chrome = chat_chrome(tree, capture)
        self.save(tag + '-chrome.json', chrome)
        self.save(tag + '-geometry.json', navigation_geometry(tree, capture))
        self.save(tag + '-candidates.json', text_target_audit(tree, capture))
        self.phase = original_phase
        return tree, capture

    def ax_control(self, command, filename):
        require(self.instrumented_v3 and command in ('prepare-ax', 'read-ax') and not self.touching, 'AX instrumentation/read control outside explicit v3 phase')
        ack = json.loads(self.command([self.config['clockClient'], self.config['data'], command]))
        self.save(filename, ack)
        require(ack.get('command') == command and ack.get('identity') == self.identity and ack.get('processNonce') == self.process and isinstance(ack.get('nonce'), str) and ack['nonce'] not in self.ax_control_nonces, 'AX control wrong command/process/build/reused nonce')
        self.ax_control_nonces.add(ack['nonce'])
        if self.actions:
            self.actions[-1]['protocolAckObserved'] = True
            self.save('actions.json', self.actions)
        if command == 'read-ax':
            load('native_diagnostic_v3', 'native_diagnostic_v3.py').control_read_window(ack['result'])
        return ack['result']

    def v3_before_mark(self, tree, capture, selected, pan=False):
        if not self.instrumented_v3: return
        read = self.ax_control('read-ax', 'pre-mark-%02d-read-ax.json' % len(self.phases))
        if pan:
            source, end, body = body_gesture(tree, capture, self.config.get('panDistance', .24))
            load('native_diagnostic_v3', 'native_diagnostic_v3.py').revalidate(body, capture, read, (source, end))
        targets = natural_text_targets(tree, capture)
        for identifier in selected:
            candidates = [target for target in targets if target['nativeID'] == identifier]
            require(candidates, 'No v3 admitted text for selected old body before mark')
            load('native_diagnostic_v3', 'native_diagnostic_v3.py').revalidate(candidates[0], capture, read)

    def mark(self, tree, capture, selected, pan=False):
        self.v3_before_mark(tree, capture, selected, pan=pan)
        return json.loads(self.command([self.config['clockClient'], self.config['data'], 'mark', *selected]))

    def run(self):
        c = self.config; manifest = json.loads((Path(c['build']) / 'manifest.json').read_text())
        self.instrumented_v3 = manifest.get('observerContract', '').startswith('instrumented-v3; synthetic-ax-id-v3;')
        require(manifest['appBuilt'] and manifest['experimentOn'] is False and (manifest.get('observerContract', '').startswith('pan-read-v1;') or self.instrumented_v3), 'Need installed isolated OFF pan-read-v1 or explicit synthetic instrumented-v3 artifact')
        if self.instrumented_v3:
            require(manifest.get('synthetic') is True and manifest.get('original53ptSameScenario') is False, 'v3 AX writes are restricted to this explicit synthetic diagnostic artifact')
            require(all(marker in manifest.get('observerContract', '') for marker in ('control-safety-v1;', 'identifier-immediate-readback-v1;')), 'Need new v3 control safety/readback artifact; old 989dfdee is prepare/AX-only, not automatic input')
        self.identity = {key: manifest[key] for key in ('buildID', 'bundleSHA256', 'executableSHA256')}
        self.save('artifact-manifest.json', manifest)
        require(hashlib.sha256(Path(c['clockClient']).read_bytes()).hexdigest() == manifest['toolBinaries']['clock-client'], 'Wrong frozen clock-client binary')
        ready = json.loads((Path(c['data']) / 'ready.json').read_text())
        require(ready['identity'] == self.identity and ready.get('processNonce'), 'Main must launch the installed artifact first')
        self.process = ready['processNonce']; self.save('attached-ready.json', ready)
        for _ in range(3): self.clock()
        initial = self.capture('initial-capture.json')
        require(len(initial['frames']) < 14000, 'Observer near fixed 18000 sample cap; main must relaunch, no reset/drain protocol exists')
        tree = self.ax('initial-ax.json')
        if not chat_ready(tree, initial):
            session = 'project-session-history-production-500'
            if not visible_controls(tree, session):
                self.tap(tree, 'projects-toggle-history-project'); tree = self.ax('project-ax.json')
            self.tap(tree, session); self.pause(.4)
        self.pause(.35)
        for mode in c.get('modes', ['pagination', 'partial-footer', 'body-growth']):
            if self.work_end - time.monotonic() < 5:
                self.phases.append({'mode': mode, 'purpose': 'not attempted: remaining budget', 'verdict': 'inconclusive'}); continue
            if mode == 'partial-footer' and manifest['scenario'] != 'partial':
                self.phases.append({'mode': mode, 'purpose': 'unavailable in installed ' + manifest['scenario'] + ' fixture; no synthetic 503 injection', 'verdict': 'inconclusive'}); continue
            attempted = False
            for turn in range(c.get('maxNavigation', 8) + 1):
                tag = '%s-%02d' % (mode, turn)
                self.phase = 'exploration-' + mode
                tree, before = self.snapshot(tag + '-before')
                action = 'history-load-older' if mode != 'body-growth' else expansion_target(tree)
                if mode == 'partial-footer' and not any(node.get('AXUniqueId') == 'history-page-error' for node in matching.flat(tree)):
                    action = None
                excluded = {message_id(action)} if action and mode == 'body-growth' else set()
                eligibility_reason = None
                try:
                    selected = choose_anchors(before, excluded, {target['nativeID'] for target in natural_text_targets(tree, before)}); stable_before(before, selected)
                except ValueError as error:
                    selected = None; eligibility_reason = str(error)
                available = bool(action and visible_controls(tree, action))
                entry = {'mode': mode, 'beforeSequence': before['frames'][-1]['sequence'], 'anchors': selected, 'target': action,
                         'chromeConfirmed': True, 'threeCompleteAnchors': selected is not None,
                         'anchorEligibilityReason': eligibility_reason,
                         'purpose': 'premarked-native-diagnostic' if selected and (available or mode == 'pagination') else 'exploration-navigation-only; not acceptance'}
                self.phases.append(entry); self.save('phases.json', self.phases)
                try:
                    body_gesture(tree, before, c.get('panDistance', .24))
                    pan_available = True; navigation_reason = None
                except ValueError as error:
                    pan_available = False; navigation_reason = str(error)
                tap_available = available and (selected is not None or mode in ('body-growth', 'partial-footer'))
                entry.update({'navigationTargetAvailable': tap_available or pan_available, 'navigationReason': navigation_reason})
                if not entry['navigationTargetAvailable']:
                    entry.update({'verdict': 'inconclusive', 'reason': 'Chat chrome confirmed; no safe navigation target: ' + navigation_reason})
                    self.save('phases.json', self.phases)
                    break
                if selected and (available or mode == 'pagination'):
                    self.phase = 'diagnostic-' + mode
                    mark = self.mark(tree, before, selected, pan=not available)
                    require(mark['anchors'] == selected, 'Native mark ACK mismatch')
                    self.ax_sealed = True
                    if self.actions:
                        self.actions[-1]['protocolAckObserved'] = True; self.actions[-1]['markNonce'] = mark['nonce']
                        self.save('actions.json', self.actions)
                    attempt = {'mode': mode, 'mark': mark, 'input': 'tap' if available else 'pan', 'target': action if available else None}
                    self.attempts.append(attempt); self.save('attempts.json', self.attempts)
                    if available: self.tap(tree, action)
                    else: self.pan(tree, before)
                    self.pause(1.2)
                    after = self.capture(tag + '-after-capture.json'); self.ax(tag + '-after-ax.json')
                    attempt['endSequence'] = after['frames'][-1]['sequence']; self.save('attempts.json', self.attempts)
                    self.clock(); self.save(tag + '-signals.json', raw_signals(after, mark['baselineSequence'], attempt['endSequence']))
                    attempted = True; break
                if self.navigation_count >= c.get('maxNavigation', 8):
                    entry['reason'] = 'Exploration limit reached; no three-old-body diagnostic window'; break
                view = moving.transcript(before['frames'][-1])
                if any(view[key] for key in ('tracking', 'dragging', 'decelerating')):
                    self.pause(.3); continue
                self.navigation_count += 1
                navigation_input = 'tap' if available and mode in ('body-growth', 'partial-footer') else 'pan'
                if navigation_input == 'tap': self.tap(tree, action)
                else: self.pan(tree, before)
                self.pause(.3)
                after = self.capture(tag + '-exploration-capture.json')
                entry['endSequence'] = after['frames'][-1]['sequence']
                self.save(tag + '-exploration-signals.json', raw_signals(after, entry['beforeSequence'], entry['endSequence']))
                old_requests = {event['requestID'] for event in before['host']['journal'] if event['phase'] == 'history-response'}
                new_older = [event['requestID'] for event in after['host']['journal'] if event['phase'] == 'history-response' and isinstance(event.get('requestCursor'), str) and event['requestID'] not in old_requests]
                after_view = moving.transcript(after['frames'][-1])
                entry['nativeProgress'] = {'input': navigation_input, 'offsetDeltaPt': after_view['offsetY'] - view['offsetY'], 'panGenerationDelta': after_view['pan']['generation'] - view['pan']['generation'], 'olderResponseIDs': new_older}
                self.save('phases.json', self.phases)
                if mode == 'pagination' and new_older:
                    self.phases.append({'mode': mode, 'verdict': 'inconclusive', 'purpose': 'first actual older response captured during exploration; no three-anchor mark or acceptance'})
                    attempted = True; break
                if navigation_input == 'pan' and abs(after_view['offsetY'] - view['offsetY']) <= 1.1 and not new_older:
                    self.stalled_navigation += 1
                else: self.stalled_navigation = 0
                if self.stalled_navigation >= 2:
                    entry['reason'] = 'Two navigation gestures with no observable scroll/page progress; stop instead of running to deadline'; break
            if not attempted:
                self.phases.append({'mode': mode, 'verdict': 'inconclusive', 'reason': 'No eligible premarked diagnostic action; exploration not signed as red/pass'})
            self.save('phases.json', self.phases)

    def finish(self, reason=None):
        self.phase = 'cleanup'; errors = []; final_acknowledged = False
        if self.touching:
            try: self.gesture('end', self.last_touch, cleanup=True); self.touching = False
            except Exception as error: errors.append('touch-end: ' + str(error))
        if self.process:
            try: self.clock(cleanup=True)
            except Exception as error: errors.append('after-clock: ' + str(error))
            try:
                data = self.capture('final-capture.json', cleanup=True)
                require(isinstance(data, dict) and (self.output / 'final-capture.json').exists(), 'No validated final capture returned')
                final_acknowledged = True
            except Exception as error: errors.append('final-flush: ' + str(error))
        results = []
        file = self.output / 'final-capture.json'
        try:
            if final_acknowledged and file.exists():
                capture = json.loads(file.read_text())
                for index, attempt in enumerate(self.attempts):
                    try:
                        item = analyze(capture, attempt, self.clocks) if 'endSequence' in attempt else {'verdict': 'inconclusive', 'reason': 'Incomplete native attempt'}
                    except (Exception, KeyboardInterrupt) as error:
                        item = {'verdict': 'inconclusive', 'reason': 'Offline attempt analysis failed: ' + str(error)}
                    results.append(item); self.save('diagnostic-%02d.json' % index, item)
        except (Exception, KeyboardInterrupt) as error:
            errors.append('offline result analysis: ' + str(error))
        blocking = next((row['reason'] for row in reversed(self.phases) if row.get('chromeConfirmed') and row.get('navigationTargetAvailable') is False), None)
        result = {'verdict': 'diagnostic-red' if any(row['verdict'] == 'diagnostic-red' for row in results) and not errors and not self.deadline_expired and reason is None else 'inconclusive',
                  'reason': reason or blocking, 'cleanupErrors': errors, 'attemptVerdicts': [row['verdict'] for row in results], 'elapsedSeconds': time.monotonic() - self.started,
                  'deadlineExceeded': self.deadline_expired, 'finalCaptureAcknowledged': final_acknowledged, 'lifecycle': 'work-stopped; cleanup attempted',
                  'strictAcceptance': 'not evaluated', 'video': 'none; recorder not started or consulted', 'sdkAdoptionIdentity': None, 'original53pt': 'unresolved'}
        self.persist_result(result)
        return result


def execute_runner(runner):
    deadline = WorkDeadline(runner); reason = None; alarm_errors = []
    runner.persist_result({'verdict': 'inconclusive', 'lifecycle': 'running; not finalized', 'strictAcceptance': 'not evaluated', 'original53pt': 'unresolved'})
    try:
        deadline.start(); runner.run()
    except (Exception, KeyboardInterrupt) as error:
        reason = type(error).__name__ + ': ' + str(error)
    finally:
        # No throwing signal handler remains while cleanup writes actions/phases/result.
        try: alarm_errors = deadline.disarm()
        except (Exception, KeyboardInterrupt) as error:
            alarm_errors = ['disarm work alarm: ' + str(error)]
            signal.signal(signal.SIGALRM, signal.SIG_IGN)
        runner.deadline_expired = runner.deadline_expired or deadline.expired or time.monotonic() >= runner.work_end
        if runner.deadline_expired:
            reason = 'deadline-exceeded' + (': ' + reason if reason else '')
        try:
            result = runner.finish(reason)
        except (Exception, KeyboardInterrupt) as error:
            result = {'verdict': 'inconclusive', 'reason': reason, 'cleanupErrors': ['final result cleanup: ' + str(error)], 'deadlineExceeded': runner.deadline_expired,
                      'finalCaptureAcknowledged': False, 'lifecycle': 'cleanup failed; metadata preserved', 'strictAcceptance': 'not evaluated', 'original53pt': 'unresolved'}
        if alarm_errors:
            result.setdefault('cleanupErrors', []).extend(alarm_errors); result['verdict'] = 'inconclusive'
        try: deadline.restore()
        except (Exception, KeyboardInterrupt) as error:
            result.setdefault('cleanupErrors', []).append('restore alarm handler: ' + str(error)); result['verdict'] = 'inconclusive'
        if runner.instrumented_v3:
            result['instrumentation'] = 'instrumented-v3 synthetic AX identifier metadata writes; not readonly; not original53pt closure'
        runner.persist_result(result)
    return result


def config_from_saved(file):
    source = json.loads(file.read_text())
    required = ('build', 'clockClient', 'data', 'udid', 'helperOrigin', 'serveSim')
    require(all(key in source for key in required), 'Missing native-only config field')
    config = {key: source[key] for key in required}
    config.update({key: source[key] for key in ('maxNavigation', 'modes', 'panDistance', 'maxCaptureMiB') if key in source})
    from urllib.parse import urlparse
    origin = urlparse(config['helperOrigin'])
    require(origin.scheme == 'http' and origin.hostname in ('localhost', '127.0.0.1') and origin.path in ('', '/') and not origin.username and not origin.password, 'Only existing local simulator helper')
    require(isinstance(config['serveSim'], list) and config['serveSim'] and all(isinstance(arg, str) for arg in config['serveSim']), 'Official serve-sim argv required')
    validate_plan(config)
    return config


def validate_plan(config):
    require(type(config.get('maxNavigation', 8)) is int and 0 <= config.get('maxNavigation', 8) <= 64, 'maxNavigation must be 0..64, still within the unchanged 70-second budget')
    require(type(config.get('maxCaptureMiB', 64)) is int and 1 <= config.get('maxCaptureMiB', 64) <= 128, 'maxCaptureMiB must be 1..128')
    distance = config.get('panDistance', .24)
    require(type(distance) in (int, float) and 0 < distance <= .55, 'panDistance must be positive and <= .55')
    require(set(config.get('modes', ['pagination', 'partial-footer', 'body-growth'])).issubset({'pagination', 'partial-footer', 'body-growth'}), 'Invalid native diagnostic modes')


def inspect_saved(directory, phase=None):
    if phase:
        require(re.fullmatch(r'[a-zA-Z0-9-]+', phase), 'Invalid saved phase name')
        capture = json.loads((directory / (phase + '-capture.json')).read_text())
        tree = json.loads((directory / (phase + '-ax.json')).read_text())
        evidence = directory / (phase + '-v3-evidence.json')
        if evidence.exists(): capture = {**capture, **json.loads(evidence.read_text())}
    else:
        capture = json.loads((directory / 'final-capture.json').read_text())
        files = sorted(directory.glob('ax-*.json'))
        require(files, 'No saved AX tree; native-only evidence requires --inspect-phase')
        tree = json.loads(files[-1].read_text())
    audit = text_target_audit(tree, capture)
    report = {'verdict': 'inconclusive', 'chatConfirmed': chat_ready(tree, capture), 'chromeConfirmed': chat_ready(tree, capture), 'chatChrome': audit['chrome'], 'publicTextTargets': audit['targets'], 'candidateAudit': audit['candidates'],
              'navigationGeometry': navigation_geometry(tree, capture),
              'processNonce': capture['processNonce'], 'host': {key: capture['host'][key] for key in ('startupSweeps', 'rejected', 'mutations')},
              'video': 'none; saved recorder status is not consulted', 'strictAcceptance': 'not evaluated', 'original53pt': 'unresolved'}
    if capture.get('observerContract', '').startswith('instrumented-v3;'):
        report['instrumentation'] = 'synthetic AX identifier metadata writes; not readonly; navigation only'
    try:
        report['anchors'] = choose_anchors(capture, visible_ids={target['nativeID'] for target in report['publicTextTargets']})
        report['stableBaselineSequence'] = stable_before(capture, report['anchors'])
        report['threeCompleteAnchors'] = True
    except ValueError as error:
        report['threeCompleteAnchors'] = False
        report['anchorReason'] = str(error)
    try:
        source, end, body = body_gesture(tree, capture)
        report['explorationTarget'] = {'source': source, 'end': end, 'nativeBody': body}
        report['navigationTargetAvailable'] = True
    except ValueError as error:
        report['navigationTargetAvailable'] = False
        report['explorationReason'] = str(error)
        report['reason'] = 'Chat chrome confirmed; no safe navigation target: ' + str(error)
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--inspect-saved', type=Path)
    parser.add_argument('--inspect-phase')
    parser.add_argument('--config', type=Path)
    parser.add_argument('--output', type=Path)
    parser.add_argument('--execute-main-only', action='store_true')
    parser.add_argument('--max-navigation', type=int)
    parser.add_argument('--pan-distance', type=float)
    parser.add_argument('--max-capture-mib', type=int)
    parser.add_argument('--modes', nargs='+', choices=['pagination', 'partial-footer', 'body-growth'])
    parser.add_argument('--audit-saved', type=Path)
    args = parser.parse_args()
    if args.audit_saved:
        try: report = load('native_saved_audit', 'native_saved_analysis.py').audit_saved(args.audit_saved)
        except (ValueError, KeyError, TypeError, OSError) as error:
            report = {'verdict': 'inconclusive', 'reason': str(error), 'strictAcceptance': 'not evaluated', 'original53pt': 'unresolved'}
        print(json.dumps(report, indent=2)); return 2
    if args.inspect_saved:
        print(json.dumps(inspect_saved(args.inspect_saved, args.inspect_phase), indent=2)); return 2
    require(args.execute_main_only, 'Only main may execute; worker is restricted to offline tests')
    require(args.config is not None and args.output is not None, 'Native-only execution requires config and a fresh output directory')
    config = config_from_saved(args.config)
    config.update({key: value for key, value in [('maxNavigation', args.max_navigation), ('panDistance', args.pan_distance), ('maxCaptureMiB', args.max_capture_mib), ('modes', args.modes)] if value is not None})
    validate_plan(config)
    args.output.mkdir(parents=True, exist_ok=False)
    runner = NativeDiagnostic(config, args.output); runner.save('config.json', config)
    runner.save('source-hashes.json', {name: hashlib.sha256(Path(__file__).with_name(name).read_bytes()).hexdigest() for name in ('native-diagnostic.py', 'native_diagnostic_v3.py', 'smoke.py', 'moving-check.py')})
    result = execute_runner(runner)
    print(json.dumps(result, indent=2))
    return 1 if result['verdict'] == 'diagnostic-red' else 2


if __name__ == '__main__':
    sys.exit(main())
