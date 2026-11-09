"""Pure v3 synthetic AX-ID admission. No device, metadata writes, or strict verdicts."""
import hashlib
import math


def require(value, reason):
    if not value:
        raise ValueError(reason)


def control_read_window(read):
    start, end = read.get('readStartNativeMs'), read.get('readEndNativeMs')
    require(all(type(value) in (int, float) and math.isfinite(value) and value >= 0 for value in (start, end)) and 0 <= end - start <= 5,
            'Control read exposure missing/nonfinite/negative or exceeds 5ms')


def inside(rect, bounds):
    return isinstance(rect, dict) and isinstance(bounds, dict) and all(isinstance(rect.get(k), (float, int)) and math.isfinite(rect[k]) for k in ('x', 'y', 'width', 'height')) and rect['width'] > 0 and rect['height'] > 0 and rect['x'] >= bounds['x'] and rect['y'] >= bounds['y'] and rect['x'] + rect['width'] <= bounds['x'] + bounds['width'] and rect['y'] + rect['height'] <= bounds['y'] + bounds['height']


def same_rect(left, right):
    # Numeric conversion tolerance only; never the displacement/visibility threshold.
    return isinstance(left, dict) and isinstance(right, dict) and all(isinstance(left.get(k), (int, float)) and isinstance(right.get(k), (int, float)) and abs(left[k] - right[k]) <= 1e-6 for k in ('x', 'y', 'width', 'height'))


def one_binding(read, token):
    rows = [row for row in read.get('bindings', []) if row.get('token') == token]
    require(len(rows) == 1 and rows[0].get('valid') is True, 'Need exactly one valid native token binding')
    return rows[0]


def identity(row):
    keys = ('token', 'generation', 'viewInstance', 'bodyInstance', 'bodyID', 'outerTranscriptInstance', 'fingerprint', 'assignedSequence')
    require(all(row.get(key) is not None for key in keys), 'Incomplete native binding identity')
    chain = row.get('ancestorInstancesToOuterTranscript')
    require(isinstance(chain, list) and len(chain) >= 3 and chain[0] == row['viewInstance'] and row['bodyInstance'] in chain and chain[-1] == row['outerTranscriptInstance'] and len(set(chain)) == len(chain), 'Missing/invalid actual text-to-body-to-transcript chain')
    return (*[row[key] for key in keys], tuple(chain))


def window_signature(window):
    bar_keys = ('instance', 'windowInstance', 'frameInWindow', 'frameInSurface', 'isNavigationBarHidden', 'navigationTransitionInProgress', 'modelGeometryUnambiguous', 'modelVisible', 'effectiveHidden', 'effectiveAlpha', 'hasTransforms', 'hasAnimation', 'hasLayerMask')
    return [window.get('windowInstance'), window.get('surfaceInstance'), window.get('windowBounds'), window.get('surfaceInWindow'), window.get('windowSafeAreaInsets'), window.get('selectedNavigationBarInstance'), window.get('transcriptInstances'), window.get('discoveryOverflow'), window.get('navigationBarCount'),
            [{key: bar.get(key) for key in bar_keys} for bar in window.get('navigationBars', [])]]


def safe_geometry(geometry):
    require(geometry.get('sameWindow') is True and geometry.get('modelGeometryUnambiguous') is True and geometry.get('modelVisible') is True, 'Text/bar model geometry unavailable or obscured')
    require(geometry.get('hasTransforms') is False and geometry.get('hasAnimation') is False and geometry.get('hasLayerMask') is False and geometry.get('effectiveHidden') is False and geometry.get('effectiveAlpha') == 1, 'Transformed/animated/masked/transparent text or bar')
    require(inside(geometry.get('frameInWindow'), geometry.get('visibleRectInWindow')), 'Whole native text/bar is clipped; no cropped target')
    for key, model in [('presentationFrameInWindow', 'frameInWindow'), ('presentationFrameInSurface', 'frameInSurface')]:
        if geometry.get(key) is not None:
            require(same_rect(geometry[key], geometry.get(model)), 'Presentation/model coordinates differ')


def control_safety(read, binding, frame):
    """Use live native protection/motion from this control read, never inferred from a newer periodic frame."""
    control_read_window(read)
    window = read['windowObservation']; protection = window['liveProtection']
    require(protection.get('contract') == 'control-safety-v1' and protection.get('coverageKnown') is True and protection.get('unknownCoverage') is False,
            'Current modal/coverage protection unknown')
    for key in ('presentedControllerInstances', 'modalViewInstances', 'otherWindowInstances'):
        require(protection.get(key) == [], 'Current presented controller/modal/other window blocks admission')
    require(protection.get('controllerTransition') is False, 'Current controller transition blocks admission')
    coverage = binding['liveCoverage']
    require(coverage.get('known') is True and coverage.get('unknownCoverage') is False and coverage.get('hitBelongsToOuter') is True and coverage.get('aboveSiblingInstances') == [], 'Current text coverage/hit route unknown or blocked')
    outer = protection['outerTranscript']; outer_geometry = outer['geometry']
    require(window['transcriptInstances'] == [outer['instance']] == [binding['outerTranscriptInstance']], 'Current outer transcript is not uniquely bound')
    expected = [row for row in frame['scrolls'] if row.get('id') == 'transcript' or row.get('ownerID') == 'transcript']
    require(len(expected) == 1 and expected[0]['instance'] == outer['instance'], 'Current outer transcript differs from captured owner')
    require(all(outer.get(key) is False for key in ('tracking', 'dragging', 'decelerating')) and type(outer.get('panState')) is int and outer['panState'] in (0, 3, 4, 5), 'Current outer pan/tracking/dragging/deceleration is not idle')
    for key in ('offsetX', 'offsetY', 'panTranslationX', 'panTranslationY'):
        require(type(outer.get(key)) in (int, float) and math.isfinite(outer[key]), 'Current outer motion/offset unknown')
    require(all(type(expected[0].get(key)) in (int, float) and outer[key] == expected[0][key] for key in ('offsetX', 'offsetY')) and same_rect(outer_geometry.get('frameInSurface'), expected[0]['frame']), 'Current outer offset/frame changed after capture')
    def protected_box(geometry):
        require(geometry.get('windowInstance') == window['windowInstance'] and geometry.get('sameWindow') is True and geometry.get('modelGeometryUnambiguous') is True and geometry.get('modelVisible') is True and geometry.get('effectiveHidden') is False and geometry.get('effectiveAlpha') == 1 and all(geometry.get(key) is False for key in ('hasTransforms', 'hasAnimation', 'hasLayerMask')), 'Current protection geometry transformed/hidden/unknown')
        rect = geometry['frameInWindow']
        require(all(type(rect.get(key)) in (int, float) and math.isfinite(rect[key]) for key in ('x', 'y', 'width', 'height')) and rect['width'] > 0 and rect['height'] > 0, 'Current protection bounds invalid')
        for key, model in [('presentationFrameInWindow', 'frameInWindow'), ('presentationFrameInSurface', 'frameInSurface')]:
            if geometry.get(key) is not None:
                require(same_rect(geometry[key], geometry.get(model)), 'Current protection presentation/model differs')
        return rect
    protected_box(outer_geometry)
    composer_roots = protection['composerBounds']; headers = protection['headerBounds']
    require(isinstance(composer_roots, list) and isinstance(headers, list) and all(type(row.get('modelVisible')) is bool for row in [*composer_roots, *headers]), 'Current composer/header discovery incomplete')
    active = [row for row in composer_roots if row['modelVisible']]
    require(len(active) == 1 and active[0].get('id') in ('chat-composer-expanded', 'chat-composer-compact'), 'Need one current visible native Composer protection root')
    composer_top = protected_box(active[0])['y']
    bars = window['navigationBars']
    require(window.get('discoveryOverflow') is False and len(bars) == window['navigationBarCount'] == 1 and bars[0]['instance'] == window['selectedNavigationBarInstance'], 'Current native header owner unknown')
    bar = bars[0]
    require(bar.get('navigationTransitionInProgress') is False and bar['owningNavigationControllerInstances'] == bar['currentTranscriptOwnerInstances'] and len(bar['currentTranscriptOwnerInstances']) == 1, 'Current header transition/ownership unsafe')
    insets = window['windowSafeAreaInsets']; bounds = window['windowBounds']
    require(all(type(insets.get(key)) in (int, float) and math.isfinite(insets[key]) and insets[key] >= 0 for key in ('top', 'left', 'right', 'bottom')), 'Current safe-area unknown')
    top = bounds['y'] + insets['top']
    if bar.get('isNavigationBarHidden') is False:
        header = protected_box(bar); top = max(top, header['y'] + header['height'])
    else:
        require(bar.get('isNavigationBarHidden') is True and bar.get('effectiveHidden') is True and bar.get('modelGeometryUnambiguous') is True and all(bar.get(key) is False for key in ('hasTransforms', 'hasAnimation', 'hasLayerMask')), 'Current hidden header state unknown')
    for header in headers:
        if header['modelVisible']:
            rect = protected_box(header); top = max(top, rect['y'] + rect['height'])
    viewport = outer_geometry['visibleRectInWindow']
    require(isinstance(viewport, dict), 'Current outer visible clip unknown')
    left = max(bounds['x'] + insets['left'], viewport['x']); right = min(bounds['x'] + bounds['width'] - insets['right'], viewport['x'] + viewport['width'])
    top = max(top, viewport['y']); bottom = min(composer_top, bounds['y'] + bounds['height'] - insets['bottom'], viewport['y'] + viewport['height'])
    area = {'x': left, 'y': top, 'width': right - left, 'height': bottom - top}
    safe_geometry(binding['geometry'])
    require(inside(binding['geometry']['frameInWindow'], area) and inside(binding['accessibilityFrameInWindow'], area), 'Whole text intersects current composer/header/viewport protection')
    return area


def revalidate(target, capture, read, gesture=None):
    """A final read after flush must still name the exact admitted object before any touch begins."""
    control_read_window(read)
    frame = capture['frames'][-1]; latest = frame['diagnosticIdentity']
    before = one_binding(latest, target['diagnosticToken'])
    current = one_binding(read, target['diagnosticToken'])
    require(read['contract'] == 'synthetic-ax-id-v3' and read['instrumented'] is True and read['runNonce'] == latest['runNonce'] and read['generation'] == latest['generation'], 'Final pre-touch read is another instrumentation run/generation')
    require(read.get('observationKind') == read['windowObservation'].get('observationKind') == 'control-read', 'Final pre-touch control read cannot be a replayed periodic sample')
    require(identity(before) == identity(current), 'Binding changed after capture flush')
    require(read['readStartNativeMs'] >= latest['readEndNativeMs'] and read['windowObservation']['sequence'] == read['lastPeriodicSequence'], 'Final pre-touch read not current/native-sequenced')
    require(isinstance(read.get('lastPeriodicReadEndNativeMs'), (int, float)) and 0 <= read['readStartNativeMs'] - read['lastPeriodicReadEndNativeMs'] <= 50, 'Final pre-touch native sampler stale after flush')
    require(window_signature(read['windowObservation']) == window_signature(latest['windowObservation']), 'Window/header changed after capture flush')
    require(current.get('nestedScroll') is False and current.get('isAXText') is True, 'Final pre-touch text entered nested/non-AX state')
    safe_geometry(current['geometry'])
    require(same_rect(current['geometry']['frameInWindow'], before['geometry']['frameInWindow']) and same_rect(current['accessibilityFrameInWindow'], before['accessibilityFrameInWindow']), 'Admitted text moved after capture flush')
    area = control_safety(read, current, frame)
    prior = capture['v3AXReads'][-1]
    require(same_rect(area, control_safety(prior, one_binding(prior, target['diagnosticToken']), frame)), 'Current protected range changed after actual AX; new admission required')
    if gesture is not None:
        bounds = read['windowObservation']['windowBounds']
        for point in gesture:
            require(all(type(point.get(key)) in (int, float) and math.isfinite(point[key]) for key in ('x', 'y')), 'Invalid planned pan point')
            x, y = bounds['x'] + point['x'] * bounds['width'], bounds['y'] + point['y'] * bounds['height']
            require(area['x'] <= x <= area['x'] + area['width'] and area['y'] <= y <= area['y'] + area['height'], 'Planned pan intersects current composer/header/viewport protection')


def audit(tree, capture, chrome, matching, moving):
    frame = capture['frames'][-1]
    nodes = matching.flat(tree); bounds = tree[0]['frame']
    candidates = []; accepted = []; common_reason = None
    try:
        require(capture.get('synthetic') is True and capture.get('observerContract', '').startswith('instrumented-v3;'), 'Explicit synthetic instrumented-v3 capture required')
        before, after = capture['v3AXReads']
        control_read_window(before); control_read_window(after)
        prepare = capture['v3AXPrepare']
        require(prepare.get('prepared') is True and capture.get('v3AXReadOrder') == ['read-ax', 'AX', 'read-ax'], 'Missing explicit prepare/read-AX-read evidence')
        require(before['contract'] == after['contract'] == 'synthetic-ax-id-v3' and before['instrumented'] is after['instrumented'] is True, 'Wrong native AX read contract')
        require(before['runNonce'] == after['runNonce'] == prepare['runNonce'] and before['generation'] == after['generation'] == prepare['generation'], 'Prepare/run/generation changed around actual AX')
        assigned = [row for row in capture['frames'] if row['sequence'] == prepare['assignedSequence']]
        require(len(assigned) == 1 and assigned[0]['readEndNativeMs'] <= prepare['nativeMs'] and prepare['assignedSequence'] < before['lastPeriodicSequence'], 'Prepare assignment is not after its actual periodic sequence')
        require(before['readStartNativeMs'] <= before['readEndNativeMs'] <= after['readStartNativeMs'] <= after['readEndNativeMs'], 'Native AX read brackets invalid')
        latest = frame['diagnosticIdentity']; window = frame['windowObservation']
        require(latest['runNonce'] == before['runNonce'] and latest['generation'] == before['generation'], 'Current sampler belongs to another prepare')
        require(window['contract'] == 'window-header-v1' and window['sequence'] == frame['sequence'], 'Window/header sequence mismatch')
        require(latest.get('observationKind') == window.get('observationKind') == 'periodic' and all(read.get('observationKind') == read['windowObservation'].get('observationKind') == 'control-read' and read['lastPeriodicSequence'] == read['windowObservation']['sequence'] for read in [before, after]), 'Control reads must not masquerade as periodic samples')
        require(isinstance(window['windowInstance'], str) and isinstance(window['surfaceInstance'], str) and all(abs(bounds[key] - frame['windowBounds'][key]) <= 1e-6 for key in ('width', 'height')), 'AX/native window identity or size mismatch')
        for read in [before, after]:
            linked = [row for row in capture['frames'] if row['sequence'] == read['lastPeriodicSequence']]
            require(len(linked) == 1 and 0 <= read['readStartNativeMs'] - linked[0]['readEndNativeMs'] <= 50, 'Control read references stale/missing periodic sequence')
        require(window.get('discoveryOverflow') is False and window['windowBounds'] == frame['windowBounds'] and window['surfaceInWindow'] == frame['surfaceInWindow'], 'Window observation overflow or coordinate disagreement')
        require(all(window_signature(read['windowObservation']) == window_signature(window) for read in [before, after]), 'Window/header changed around actual AX')
        bars = window['navigationBars']
        require(len(bars) == window['navigationBarCount'] == 1 and bars[0]['instance'] == window['selectedNavigationBarInstance'], 'Need unique current-window navigation bar owner')
        bar = bars[0]
        require(bar['navigationTransitionInProgress'] is False and bar['sameWindow'] is True and bar['modelGeometryUnambiguous'] is True, 'Navigation transition/header geometry unknown')
        require(bar['owningNavigationControllerInstances'] == bar['currentTranscriptOwnerInstances'] and len(bar['currentTranscriptOwnerInstances']) == 1, 'Navigation controller/current transcript ownership not unique')
        require(bar.get('hasTransforms') is False and bar.get('hasAnimation') is False and bar.get('hasLayerMask') is False, 'Unsafe header transform/animation/mask')
        inset = window['windowSafeAreaInsets']
        require(all(isinstance(inset.get(key), (float, int)) and math.isfinite(inset[key]) and inset[key] >= 0 for key in ('top', 'left', 'right', 'bottom')), 'Unknown native safe area')
        header_bottom = frame['windowBounds']['y'] + inset['top']
        if bar['isNavigationBarHidden'] is False:
            safe_geometry(bar)
            header_bottom = max(header_bottom, bar['frameInWindow']['y'] + bar['frameInWindow']['height'])
        else:
            require(bar['isNavigationBarHidden'] is True and bar['effectiveHidden'] is True, 'Hidden navigation bar state not authoritative')
        def to_ax(rect):
            return {**rect, 'x': rect['x'] - frame['windowBounds']['x'] + bounds['x'], 'y': rect['y'] - frame['windowBounds']['y'] + bounds['y']}
        header_ax = header_bottom - frame['windowBounds']['y'] + bounds['y']
        header_ax = max(header_ax, chrome['headerBottomAX'] or header_ax)
        chrome = {**chrome, 'headerBottomAX': header_ax, 'headerGeometrySource': 'instrumented-v3 unique public UINavigationBar/window safe-area and AX controls'}
        end = frame['nativeUptimeMs']
        baseline = [row for row in capture['frames'] if end - 300 <= row['nativeUptimeMs'] <= end]
        require(len(baseline) >= 3 and end - baseline[0]['nativeUptimeMs'] >= 250 and baseline[0]['nativeUptimeMs'] > prepare['nativeMs'], 'Missing fresh post-prepare 250ms native window')
        first = min(before['lastPeriodicSequence'], baseline[0]['sequence'])
        rows = [row for row in capture['frames'] if first <= row['sequence'] <= frame['sequence']]
        require(before['lastPeriodicSequence'] <= after['lastPeriodicSequence'] <= frame['sequence'] and rows[0]['sequence'] == first, 'Native read-to-periodic coverage missing')
        base_transcript = moving.transcript(frame)
        for previous, current in zip(rows, rows[1:]):
            require(current['sequence'] == previous['sequence'] + 1 and 0 < current['nativeUptimeMs'] - previous['nativeUptimeMs'] and current['readEndNativeMs'] - previous['nativeUptimeMs'] <= 50, 'Native gap around v3 AX admission')
        for row in rows:
            transcript = moving.transcript(row)
            require(not row.get('nativeFailure') and not row.get('presentedController') and not any(transcript[key] for key in ('tracking', 'dragging', 'decelerating')), 'Moving/covered native admission window')
            require(transcript['instance'] == base_transcript['instance'] and same_rect(transcript['frame'], base_transcript['frame']) and transcript['offsetY'] == base_transcript['offsetY'], 'Transcript identity/geometry/offset changed around AX')
            require(window_signature(row['windowObservation']) == window_signature(window), 'Periodic header/window changed around AX')
            require(0 <= row['readEndNativeMs'] - row['nativeUptimeMs'] <= 5, 'Native admission read exposure ambiguous')
        viewport = base_transcript['frame']
        area = to_ax({**viewport, 'x': viewport['x'] + frame['surfaceInWindow']['x'], 'y': viewport['y'] + frame['surfaceInWindow']['y']})
    except (ValueError, KeyError, TypeError, IndexError) as error:
        common_reason = str(error)
    for node in nodes:
        if node.get('type') != 'StaticText':
            continue
        token = node.get('AXUniqueId'); reasons = []; targets = []
        try:
            require(common_reason is None, common_reason)
            require(isinstance(token, str) and token.startswith('hpdiag-ax-' + before['runNonce'] + '-'), 'Missing registered AX token; system time/generic geometry cannot authorize')
            require(sum(other.get('AXUniqueId') == token for other in nodes) == 1, 'Actual AX token missing/merged/duplicate')
            require(node.get('enabled') is True and inside(node.get('frame'), bounds) and inside(node['frame'], area), 'Whole enabled AX text not visible in window/transcript')
            binding = one_binding(latest, token); signature = identity(binding)
            require(binding['generation'] == prepare['generation'] and binding['assignedSequence'] == prepare['assignedSequence'], 'Token assignment generation/sequence mismatch')
            require(all(identity(one_binding(read, token)) == signature for read in [before, after]), 'Token pointer/generation/body/transcript changed across AX')
            require(all(identity(one_binding(row['diagnosticIdentity'], token)) == signature for row in rows), 'Native binding retired/replaced during AX interval')
            require(binding.get('nestedScroll') is False and binding.get('isAXText') is True, 'Nested scroll/non-AX-text token rejected')
            require(window['transcriptInstances'] == [binding['outerTranscriptInstance']] == [base_transcript['instance']], 'Binding outer transcript differs from actual unique native transcript')
            fingerprint = hashlib.sha256((node.get('AXLabel') or '').strip().encode()).hexdigest()
            require(fingerprint == binding['fingerprint'], 'AX label no longer equals exact synthetic native label')
            safe_geometry(binding['geometry'])
            require(binding['geometry']['windowInstance'] == window['windowInstance'], 'Text belongs to another window')
            native_ax = to_ax(binding['accessibilityFrameInWindow'])
            require(same_rect(node['frame'], native_ax) and same_rect(node['frame'], to_ax(binding['geometry']['frameInWindow'])), 'Actual AX range differs from bound complete native text geometry')
            for read in [before, after, *[row['diagnosticIdentity'] for row in rows]]:
                current = one_binding(read, token)
                require(current.get('nestedScroll') is False and current.get('isAXText') is True, 'Binding entered nested scroll/non-AX state')
                safe_geometry(current['geometry'])
                require(same_rect(current['geometry']['frameInWindow'], binding['geometry']['frameInWindow']) and same_rect(current['accessibilityFrameInWindow'], binding['accessibilityFrameInWindow']), 'Bound text moved/resized around AX')
            require(same_rect(control_safety(before, one_binding(before, token), frame), control_safety(after, one_binding(after, token), frame)), 'Protected range changed around actual AX')
            rect = node['frame']
            require(rect['y'] >= header_ax and rect['y'] + rect['height'] <= chrome['composerTopAX'], 'Whole text intersects actual safe header/composer; no cropping')
            require(rect['x'] >= bounds['x'] + inset['left'] and rect['x'] + rect['width'] <= bounds['x'] + bounds['width'] - inset['right'] and rect['y'] + rect['height'] <= bounds['y'] + bounds['height'] - inset['bottom'], 'Whole text intersects native safe-area edges')
            bodies = [body for body in frame['nodes'] if body['id'] == binding['bodyID'] and body['instance'] == binding['bodyInstance']]
            require(len(bodies) == 1 and bodies[0]['visible'], 'Bound actual body missing/duplicate/not visible')
            target = {'nativeID': binding['bodyID'], 'nativeInstance': binding['bodyInstance'], 'nativeFrame': bodies[0]['frame'], 'messageID': binding['bodyID'][10:17],
                      'axFrame': rect, 'point': {'x': (rect['x'] + rect['width'] / 2 - bounds['x']) / bounds['width'], 'y': (rect['y'] + rect['height'] / 2 - bounds['y']) / bounds['height']},
                      'nestedScroll': False, 'correspondence': 'instrumented-v3 actual unique AX token + native weak object binding', 'diagnosticToken': token, 'bindingGeneration': binding['generation'], 'chatState': chrome['state'], 'headerGeometrySource': chrome['headerGeometrySource']}
            targets.append(target); accepted.append(target)
        except (ValueError, KeyError, TypeError, IndexError) as error:
            reasons.append(str(error))
        candidates.append({'axToken': token, 'axLabel': node.get('AXLabel'), 'axFrame': node.get('frame'), 'accepted': bool(targets), 'exclusionReasons': reasons, 'nativeMatches': targets})
    return {'chrome': chrome, 'candidates': candidates, 'targets': accepted, 'instrumentation': 'synthetic AX identifier metadata writes; navigation only, not three-body/strict acceptance', 'reason': common_reason}
