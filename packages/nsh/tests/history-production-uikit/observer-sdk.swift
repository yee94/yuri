import UIKit

@MainActor func historyProductionControlCoverageSharingParityRegression() throws {
    let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 402, height: 874))
    let surface = UIView(frame: window.bounds), outer = UIScrollView(frame: window.bounds)
    window.addSubview(surface); surface.addSubview(outer); window.isHidden = false
    defer { window.isHidden = true }
    let text = UIView(frame: CGRect(x: 100, y: 100, width: 100, height: 100)), sibling = UIView(frame: CGRect(x: 0, y: 0, width: 20, height: 20))
    let corner = UIView(frame: CGRect(x: 100, y: 100, width: 10, height: 10))
    outer.addSubview(text); outer.addSubview(sibling); sibling.addSubview(corner)
    for variant in 0..<6 {
        sibling.clipsToBounds = variant % 2 == 0; sibling.isHidden = variant == 1
        sibling.alpha = variant == 2 ? 0.005 : 1
        sibling.transform = variant == 3 ? CGAffineTransform(translationX: 1, y: 0) : .identity
        sibling.layer.mask = variant == 4 ? CALayer() : nil
        let context = HistoryV4ControlReadContext(surface: surface, window: window)
        let legacy = HistoryProductionWindowObservation.liveCoverage(text: text, outer: outer, surface: surface, window: window)
        let shared = context.liveCoverage(text: text, outer: outer)
        assert(NSDictionary(dictionary: legacy).isEqual(to: shared), "read-local coverage changed safety output")
        for view in [text, sibling, corner, outer, surface] {
            let original = HistoryProductionWindowObservation.geometry(view, surface: surface, window: window)
            let sampled = context.geometry(view)
            let left = try HistorySnapshotValue.freeze(original), right = try HistorySnapshotValue.freeze(sampled)
            assert(left == right, "shared geometry changed a field or Double bit")
        }
        let capped = context.liveCoverage(text: text, outer: outer, capacity: 3)
        assert(capped["unknownCoverage"] as? Bool == true)
    }
}

@MainActor func historyProductionScrollInsetsValueParityRegression() throws {
    let bits: [UInt64] = [0x8000000000000000, 0x7ff8000000000042, 0x7ff0000000000000, 0xfff0000000000000]
    let values = bits.map { CGFloat(Double(bitPattern: $0)) }
    let inset = UIEdgeInsets(top: values[0], left: values[1], bottom: values[2], right: values[3])
    let typed = try HistorySnapshotValue.freeze(HistoryV4TypedGeometry.insets(inset))
    for (side, bit) in zip(["top", "left", "bottom", "right"], bits) {
        assert(typed[side] == .doubleBits(bit), "scroll inset lost CGFloat/Double bits")
    }
}

/// Compiled against the real iOS SDK only. Main owns running UIKit/device evidence.
@MainActor func historyProductionObserverSDKCompileContract() {
    let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 400, height: 850))
    let page = UIViewController(), navigation = UINavigationController(rootViewController: page)
    window.rootViewController = navigation
    let surface = UIView(frame: window.bounds), outer = UIScrollView(frame: window.bounds)
    page.view.addSubview(surface); surface.addSubview(outer)
    outer.accessibilityIdentifier = "transcript"
    let body = UIView(frame: CGRect(x: 0, y: 0, width: 300, height: 700))
    body.accessibilityIdentifier = "body-part-hp-0488:text:0"; outer.addSubview(body)
    let label = UILabel(), text = UITextView(), drawn = UIView(), code = UIScrollView()
    label.accessibilityLabel = "Preserve order"; label.isAccessibilityElement = true
    text.accessibilityLabel = "ANCHOR hp-0488"; text.isAccessibilityElement = true
    drawn.isAccessibilityElement = true; drawn.accessibilityTraits = .staticText
    drawn.accessibilityLabel = "ANCHOR hp-0488\nno command is executed"
    body.addSubview(label); body.addSubview(text); body.addSubview(code); code.addSubview(drawn)
    let observed = HistoryProductionWindowObservation.read(surface: surface, sequence: 1)
    assert(observed["contract"] as? String == "window-header-v1")
    assert(observed["sequence"] as? Int == 1)
    _ = try? JSONSerialization.data(withJSONObject: observed)
    // These calls also typecheck the detached-window and non-finite CGRect encoding branches.
    let detached = HistoryProductionWindowObservation.read(surface: UIView(), sequence: 2)
    assert(detached["windowInstance"] is NSNull)
    assert(HistoryProductionWindowObservation.rect(.null) is NSNull)
}

/// Execute only in main's UIKit test process; no engine, Host, AX writes, or gesture injection.
@MainActor func historyProductionSiblingOverflowUIKitRegression() {
    let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 400, height: 850))
    let surface = UIView(frame: window.bounds), outer = UIScrollView(frame: window.bounds)
    window.addSubview(surface); surface.addSubview(outer); window.isHidden = false
    defer { window.isHidden = true }
    let text = UIView(frame: CGRect(x: 100, y: 100, width: 100, height: 100))
    text.isUserInteractionEnabled = false; outer.addSubview(text)
    let sibling = UIView(frame: CGRect(x: 0, y: 0, width: 20, height: 20))
    sibling.isUserInteractionEnabled = false; outer.addSubview(sibling)
    let corner = UIView(frame: CGRect(x: 100, y: 100, width: 10, height: 10))
    corner.clipsToBounds = true; corner.isUserInteractionEnabled = false; sibling.addSubview(corner)
    let cornerID = HistoryProductionWindowObservation.instance(corner)
    assert(!sibling.frame.intersects(text.frame))
    assert(!corner.convert(corner.bounds, to: window).contains(CGPoint(x: 150, y: 150)))
    assert(window.hitTest(CGPoint(x: 150, y: 150), with: nil) === outer)
    let overflow = HistoryProductionWindowObservation.siblingCoverage(text: text, surface: surface, window: window)
    assert(overflow.unknown && overflow.blockers.contains(cornerID))
    let live = HistoryProductionWindowObservation.liveCoverage(text: text, outer: outer, surface: surface, window: window)
    assert(live["known"] as? Bool == false && live["unknownCoverage"] as? Bool == true)
    sibling.clipsToBounds = true
    let clipped = HistoryProductionWindowObservation.siblingCoverage(text: text, surface: surface, window: window)
    assert(!clipped.unknown && clipped.blockers.isEmpty)
    sibling.clipsToBounds = false
    let exhausted = HistoryProductionWindowObservation.siblingCoverage(text: text, surface: surface, window: window, capacity: 3)
    assert(exhausted.unknown)
    corner.isHidden = true
    let arbitraryDrawing = HistoryProductionWindowObservation.siblingCoverage(text: text, surface: surface, window: window)
    assert(arbitraryDrawing.unknown)
    // Exhaust specifically inside the discovered subtree, with every drawing bound clipped and known.
    sibling.frame = text.frame; sibling.clipsToBounds = true; corner.isHidden = false
    let second = UIView(frame: CGRect(x: 0, y: 0, width: 1, height: 1))
    second.clipsToBounds = true; second.isUserInteractionEnabled = false; sibling.addSubview(second)
    let completeSubtree = HistoryProductionWindowObservation.siblingCoverage(text: text, surface: surface, window: window)
    assert(!completeSubtree.unknown)
    let cappedSubtree = HistoryProductionWindowObservation.siblingCoverage(text: text, surface: surface, window: window, capacity: completeSubtree.inspected - 1)
    assert(cappedSubtree.unknown)
}

@MainActor func historyProductionSnapshotRejectsUIKitRegression() {
    do {
        _ = try HistorySnapshotValue.freeze(UIView())
        assertionFailure("UIKit reference admitted into snapshot")
    } catch { }
}

@MainActor func historyProductionTypedGeometryFieldParityRegression() throws {
    let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 400, height: 850))
    let surface = UIView(frame: window.bounds), parent = UIView(frame: CGRect(x: 30, y: 40, width: 200, height: 300))
    let child = UIView(frame: CGRect(x: -10, y: 250, width: 80, height: 100))
    window.addSubview(surface); surface.addSubview(parent); parent.addSubview(child)
    for variant in 0..<6 {
        parent.clipsToBounds = variant % 2 == 0
        parent.alpha = variant == 2 ? 0.3 : 1
        child.isHidden = variant == 3
        child.transform = variant == 4 ? CGAffineTransform(translationX: 7.25, y: -2.5) : .identity
        child.layer.mask = variant == 5 ? CALayer() : nil
        let legacy = try HistorySnapshotValue.freeze(HistoryProductionWindowObservation.geometry(child, surface: surface, window: window))
        let typed = HistoryV4TypedGeometry.read(child, surface: surface, window: window)
        assert(typed == legacy, "v4 geometry fields/bits differ from the public v3 read")
    }
    assert(HistoryV4TypedGeometry.rect(.null) == .null)
    assert(HistoryV4TypedGeometry.rect(.infinite) == .null)
}
