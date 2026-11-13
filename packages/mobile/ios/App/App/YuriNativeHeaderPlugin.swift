import Capacitor
import UIKit
import WebKit

/// iOS half of the two-WebView keyboard experiment (Android: ImeSyncBridge +
/// NativeHeaderHost). The whole WKWebView is translated with the keyboard
/// inside the keyboard's own UIKit animation. (Its scrollView cannot be used:
/// WebKit rewrites that frame to its bounds, which cancels a transform.) The
/// header mirror is a subview and counter-translates in the same animation. A second transparent
/// WKWebView mirrors the page header and is engaged only during that motion,
/// so the header never moves; at rest the page paints its own header. While
/// the keyboard is up the content stays translated by its height and the page
/// absorbs that height at its top, so its header sits back at the top. Disabled while the native liquid
/// glass composer owns the keyboard (JS reports that through `setImeSync`).
@objc(YuriNativeHeaderPlugin)
class YuriNativeHeaderPlugin: CAPPlugin, CAPBridgedPlugin, WKScriptMessageHandler {
    let identifier = "YuriNativeHeaderPlugin"
    let jsName = "YuriNativeHeader"
    let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "update", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setImeSync", returnType: CAPPluginReturnPromise),
    ]

    private static let shell = """
    <!doctype html><html><head>
    <meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no,viewport-fit=cover">
    <style id="yuri-css"></style>
    <style>:root:root:root,:root:root:root body,:root:root:root #yuri-h{margin:0!important;padding:0!important;background:transparent!important;overflow:hidden!important;height:100%!important}
    :root:root:root body::before,:root:root:root body::after{content:none!important}</style>
    </head><body><div id="yuri-sprite" style="display:none"></div><div id="yuri-h"></div><script>
    window.__yuriSet=function(p){var d=document,r=d.documentElement;
    if(p.css!=null)d.getElementById('yuri-css').textContent=p.css;
    if(p.sprite!=null)d.getElementById('yuri-sprite').innerHTML=p.sprite;
    r.className=p.rootClass;r.style.cssText=p.rootStyle;d.body.className=p.bodyClass;
    d.getElementById('yuri-h').innerHTML=p.html;
    return new Promise(function(res){requestAnimationFrame(function(){requestAnimationFrame(function(){res(1)})})})};
    document.addEventListener('click',function(e){e.preventDefault();e.stopPropagation();
    var h=document.getElementById('yuri-h').firstElementChild,n=e.target,path=[];
    if(!h)return;while(n&&n!==h){var p=n.parentElement;if(!p)return;path.unshift(Array.prototype.indexOf.call(p.children,n));n=p}
    if(n===h)webkit.messageHandlers.yuriHeaderTap.postMessage(JSON.stringify(path))},true);
    </script></body></html>
    """

    private final class HeaderWebView: WKWebView {
        var engaged = false
        var interactive = true
        var hitBottom: CGFloat = 0
        override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
            // The fade strip and a disengaged mirror never take touches.
            guard engaged, interactive, point.y <= hitBottom else { return nil }
            return super.hitTest(point, with: event)
        }
    }

    /// Resting composer foot gap (pt); mobile.css native IME foot uses 16px.
    private static let footGap: CGFloat = 16

    private var header: HeaderWebView?
    private var headerHeight: NSLayoutConstraint?
    private var assetHandler: WebViewAssetHandler?
    private var headerReady = false
    private var pending: [String: Any]?
    private var latestSeq = 0
    private var shownSeq = -1
    private var shown = false
    private var collapse: CGFloat = 0
    private var collapseDistance: CGFloat = 0
    private var snapping = false

    private var imeSync = false
    private var keyboardOverlap: CGFloat = 0
    private var latestKeyboardNotification: Notification?
    private var imeGeneration = 0
    private var headerGeneration = 0
    private var keyboardObservers: [NSObjectProtocol] = []
    private var offsetObservation: NSKeyValueObservation?

    override func load() {
        DispatchQueue.main.async { [weak self] in
            guard let self, let controller = self.webView?.configuration.userContentController else { return }
            controller.add(WeakMessageHandler(self), name: "yuriHeaderCollapse")
            self.observeKeyboard()
            // WKWebView pans its root scroll view to reveal a focused field.
            // The page already lays itself out above the keyboard, so that pan
            // would double the lift (same rule as Keyboard disableScroll).
            self.offsetObservation = self.webView?.scrollView.observe(\.contentOffset) { [weak self] scrollView, _ in
                guard self?.imeSync == true, scrollView.contentOffset != .zero else { return }
                scrollView.contentOffset = .zero
            }
        }
    }

    deinit {
        keyboardObservers.forEach(NotificationCenter.default.removeObserver)
    }

    // MARK: JS API

    @objc func setImeSync(_ call: CAPPluginCall) {
        let enabled = call.getBool("enabled") ?? false
        DispatchQueue.main.async { [weak self] in
            guard let self else { return call.resolve() }
            guard enabled != self.imeSync else { return call.resolve() }
            if !enabled { self.resetIme() }
            self.imeSync = enabled
            if enabled {
                self.publishSafeArea()
                // Focus can move from search to chat with an already-open IME;
                // UIKit need not send another keyboard frame in that case.
                if let note = self.latestKeyboardNotification { self.handleKeyboard(note) }
            }
            call.resolve()
        }
    }

    @objc func update(_ call: CAPPluginCall) {
        var payload = call.options as? [String: Any] ?? [:]
        DispatchQueue.main.async { [weak self] in
            guard let self else { return call.resolve() }
            _ = self.installHeaderIfNeeded()
            self.latestSeq = payload["seq"] as? Int ?? 0
            if (payload["visible"] as? Bool) != true {
                self.pending = nil
                self.shown = false
                self.setEngaged(false)
                return call.resolve()
            }
            if !self.headerReady {
                if let previous = self.pending {
                    for key in ["css", "sprite"] where payload[key] == nil { payload[key] = previous[key] }
                }
                self.pending = payload
                return call.resolve()
            }
            self.apply(payload)
            call.resolve()
        }
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        if message.name == "yuriHeaderTap", let path = message.body as? String {
            guard header?.engaged == true else { return }
            notifyListeners("tap", data: ["path": path])
            return
        }
        guard message.name == "yuriHeaderCollapse", let body = message.body as? [String: Any] else { return }
        let progress = CGFloat((body["progress"] as? NSNumber)?.doubleValue ?? 0)
        setCollapse(progress, phase: body["phase"] as? String ?? "rest", rest: body["rest"] as? String ?? "expanded")
    }

    // MARK: Header mirror

    private func installHeaderIfNeeded() -> Bool {
        if header != nil { return true }
        guard let main = webView, let bridge else { return false }
        let configuration = WKWebViewConfiguration()
        let handler = WebViewAssetHandler(router: CapacitorRouter())
        handler.setAssetPath(bridge.config.appLocation.path)
        configuration.setURLSchemeHandler(handler, forURLScheme: bridge.config.localURL.scheme ?? "capacitor")
        configuration.userContentController.add(WeakMessageHandler(self), name: "yuriHeaderTap")
        assetHandler = handler
        let view = HeaderWebView(frame: .zero, configuration: configuration)
        view.isOpaque = false
        view.backgroundColor = .clear
        view.scrollView.backgroundColor = .clear
        view.scrollView.isScrollEnabled = false
        view.scrollView.contentInsetAdjustmentBehavior = .never
        // Always alpha 1 and rendered; at rest it sits behind the page (the
        // scrollView paints over it). Engaging only changes z-order, so there
        // is no first frame with an un-rasterized mirror.
        view.accessibilityElementsHidden = true
        view.translatesAutoresizingMaskIntoConstraints = false
        // Sibling of the main scrollView: the content translation never moves it.
        main.insertSubview(view, at: 0)
        let height = view.heightAnchor.constraint(equalToConstant: 1)
        NSLayoutConstraint.activate([
            view.topAnchor.constraint(equalTo: main.topAnchor),
            view.leadingAnchor.constraint(equalTo: main.leadingAnchor),
            view.trailingAnchor.constraint(equalTo: main.trailingAnchor),
            height,
        ])
        headerHeight = height
        header = view
        view.navigationDelegate = self
        view.loadHTMLString(Self.shell, baseURL: bridge.config.localURL)
        return true
    }

    private func apply(_ payload: [String: Any]) {
        guard let header else { return }
        let seq = payload["seq"] as? Int ?? 0
        // Payload sizes are device px; UIKit uses points.
        let scale = header.window?.screen.scale ?? UIScreen.main.scale
        let height = CGFloat((payload["height"] as? NSNumber)?.doubleValue ?? 1) / scale
        header.hitBottom = CGFloat((payload["hitBottom"] as? NSNumber)?.doubleValue ?? 0) / scale
        collapseDistance = CGFloat((payload["collapseDistance"] as? NSNumber)?.doubleValue ?? 0) / scale
        headerHeight?.constant = max(1, height)
        guard let data = try? JSONSerialization.data(withJSONObject: payload),
              let json = String(data: data, encoding: .utf8) else { return }
        header.callAsyncJavaScript("return await window.__yuriSet(\(json))", in: nil, in: .page) { [weak self] _ in
            guard let self, seq == self.latestSeq else { return }
            self.shownSeq = seq
            self.shown = true
            self.renderCollapse()
            self.notifyListeners("shown", data: ["seq": seq])
        }
    }

    private func setCollapse(_ progress: CGFloat, phase: String, rest: String) {
        let target = min(1, max(0, progress))
        header?.interactive = phase == "rest" && rest != "collapsed"
        if phase == "snapping" {
            guard !snapping, collapse != target else { return }
            snapping = true
            collapse = target
            let timing = UICubicTimingParameters(controlPoint1: CGPoint(x: 0.22, y: 1), controlPoint2: CGPoint(x: 0.36, y: 1))
            let animator = UIViewPropertyAnimator(duration: UIAccessibility.isReduceMotionEnabled ? 0 : 0.24, timingParameters: timing)
            animator.addAnimations { self.renderCollapse() }
            animator.addCompletion { _ in self.snapping = false }
            animator.startAnimation()
            return
        }
        if snapping && phase == "rest" { return }
        collapse = target
        renderCollapse()
    }

    /// Keyboard lift of the main WebView; the mirror cancels it to stay pinned.
    private var lift: CGFloat = 0

    private func setLift(_ value: CGFloat) {
        lift = value
        webView?.transform = CGAffineTransform(translationX: 0, y: -value)
        header?.transform = CGAffineTransform(translationX: 0, y: value - collapse * collapseDistance)
    }

    private func renderCollapse() {
        guard let header, shown else { return }
        header.transform = CGAffineTransform(translationX: 0, y: lift - collapse * collapseDistance)
        header.alpha = 1 - collapse
    }

    private func setEngaged(_ value: Bool) {
        guard let header, let main = webView else { return }
        header.engaged = value
        if value { main.bringSubviewToFront(header) } else { main.sendSubviewToBack(header) }
    }

    // MARK: Keyboard

    private func observeKeyboard() {
        let center = NotificationCenter.default
        for name in [UIResponder.keyboardWillChangeFrameNotification, UIResponder.keyboardWillHideNotification] {
            keyboardObservers.append(center.addObserver(forName: name, object: nil, queue: .main) { [weak self] note in
                self?.handleKeyboard(note)
            })
        }
    }

    private func handleKeyboard(_ note: Notification) {
        latestKeyboardNotification = note
        guard imeSync, let main = webView, let window = main.window,
              let end = (note.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? NSValue)?.cgRectValue else { return }
        let duration = (note.userInfo?[UIResponder.keyboardAnimationDurationUserInfoKey] as? NSNumber)?.doubleValue ?? 0.25
        let curveRaw = (note.userInfo?[UIResponder.keyboardAnimationCurveUserInfoKey] as? NSNumber)?.uintValue ?? 7
        let hiding = note.name == UIResponder.keyboardWillHideNotification
        let frame = main.convert(window.convert(end, from: nil), from: window)
        let keyboard = hiding ? 0 : max(0, main.bounds.maxY - frame.minY)
        // The composer foot keeps one constant CSS inset, max(gap, home
        // indicator), keyboard up or down (a keyboard-state padding switch
        // would land as a jump at the bookends). The indicator is behind the
        // keyboard, so lift less by that excess: the gap above the keyboard
        // equals the resting gap. Keep in sync with mobile.css (native IME foot).
        publishSafeArea()
        let excess = max(0, window.safeAreaInsets.bottom - Self.footGap)
        let overlap = max(0, keyboard - excess)
        // willChangeFrame and willHide both report a close; a repeat must not
        // restart it.
        guard overlap != keyboardOverlap else { return }
        keyboardOverlap = overlap
        imeGeneration += 1
        let generation = imeGeneration
        let open = overlap > 0
        engageHeader()
        publishLift(overlap)
        emitImeState(open: open, phase: "start", height: overlap, duration: duration)
        // The content is translated by -overlap for as long as the keyboard is
        // up, from the keyboard's first frame (same as Android). Unlike Android
        // the page is never re-laid into the visible region: WebKit does not
        // commit a relayout within a keyboard frame, which showed as a blank
        // band under the header at close start. No JS runs on this path.
        UIView.animate(withDuration: duration, delay: 0, options: [UIView.AnimationOptions(rawValue: curveRaw << 16), .beginFromCurrentState]) {
            self.setLift(overlap)
        } completion: { [weak self] _ in
            guard let self, self.imeSync, generation == self.imeGeneration else { return }
            self.settle(overlap)
        }
    }

    private func settle(_ overlap: CGFloat) {
        emitImeState(open: overlap > 0, phase: "settled", height: overlap, duration: 0)
        // The mirror stays engaged for the whole keyboard session: the page is
        // never re-laid, so its header sits above the screen while lifted.
        if overlap == 0 { releaseHeader() }
    }

    private func engageHeader() {
        headerGeneration += 1
        guard let header, let main = webView, shown, shownSeq == latestSeq, !header.engaged else { return }
        setEngaged(true)
        main.evaluateJavaScript("window.__yuriNativeHeader&&window.__yuriNativeHeader(true)")
    }

    private func releaseHeader() {
        guard let header, let main = webView, header.engaged else { return }
        headerGeneration += 1
        let token = headerGeneration
        main.callAsyncJavaScript("return window.__yuriNativeHeader ? await window.__yuriNativeHeader(false) : 0", in: nil, in: .page) { [weak self] _ in
            // The page resolves after its header frame painted; one UI-process
            // turn lets that layer commit land. Any longer overlap of two
            // translucent headers reads as a brightening band.
            DispatchQueue.main.async { [weak self] in
                guard let self, token == self.headerGeneration else { return }
                self.setEngaged(false)
            }
        }
    }

    private func resetIme() {
        imeGeneration += 1
        webView?.layer.removeAllAnimations()
        header?.layer.removeAllAnimations()
        keyboardOverlap = 0
        setLift(0)
        publishLift(0)
        releaseHeader()
    }

    /// The page is never re-laid for the keyboard, so its top `value` points
    /// are off screen. Geometry readers (composer full-height snap) subtract
    /// this target lift. Written once per keyboard transition, never per frame.
    private func publishLift(_ value: CGFloat) {
        webView?.evaluateJavaScript("document.documentElement.style.setProperty('--yuri-native-ime-lift','\(value)px')")
    }

    /// Translating the WKWebView moves its frame, and WebKit recomputes
    /// env(safe-area-inset-*) from that frame: lifted, top and bottom drop to 0
    /// (header slides under the status bar, the foot shrinks) and both return
    /// near the end of a close with a full relayout. Publish the window insets,
    /// which the keyboard and the lift never change, as fixed CSS variables.
    private var publishedSafeArea: UIEdgeInsets?

    private func publishSafeArea() {
        guard let main = webView, let window = main.window else { return }
        let insets = window.safeAreaInsets
        guard insets != publishedSafeArea else { return }
        publishedSafeArea = insets
        let js = "(()=>{const s=document.documentElement.style;"
            + "s.setProperty('--yuri-native-safe-top','\(insets.top)px');"
            + "s.setProperty('--yuri-native-safe-bottom','\(insets.bottom)px');"
            + "s.setProperty('--yuri-native-safe-left','\(insets.left)px');"
            + "s.setProperty('--yuri-native-safe-right','\(insets.right)px')})()"
        main.evaluateJavaScript(js)
    }

    private func emitImeState(open: Bool, phase: String, height: CGFloat, duration: Double) {
        let data = String(format: "{\"open\":%@,\"height\":%d,\"phase\":\"%@\",\"durationMs\":%d,\"nativeResize\":true}",
                          open ? "true" : "false", Int(height), phase, Int(duration * 1000))
        bridge?.triggerWindowJSEvent(eventName: "yuri:ime-state", data: data)
    }
}

extension YuriNativeHeaderPlugin: WKNavigationDelegate {
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard webView === header else { return }
        headerReady = true
        if let next = pending {
            pending = nil
            apply(next)
        }
    }

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        // The mirror never navigates; only its own shell load is allowed.
        decisionHandler(action.navigationType == .other && !headerReady ? .allow : .cancel)
    }
}

/// WKUserContentController retains handlers strongly; avoid a plugin cycle.
private final class WeakMessageHandler: NSObject, WKScriptMessageHandler {
    weak var target: WKScriptMessageHandler?
    init(_ target: WKScriptMessageHandler) { self.target = target }
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        target?.userContentController(controller, didReceive: message)
    }
}
