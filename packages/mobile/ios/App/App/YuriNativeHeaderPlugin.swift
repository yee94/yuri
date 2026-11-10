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
    private var webOffset: CGFloat = 0
    private var offsetGeneration = 0
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
            if !enabled { self.resetIme() }
            self.imeSync = enabled
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
        view.alpha = 0
        view.accessibilityElementsHidden = true
        view.translatesAutoresizingMaskIntoConstraints = false
        // Sibling of the main scrollView: the content translation never moves it.
        main.addSubview(view)
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
        header.alpha = header.engaged ? 1 - collapse : 0
    }

    private func setEngaged(_ value: Bool) {
        guard let header else { return }
        header.engaged = value
        if value { renderCollapse() } else { header.alpha = 0 }
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
        guard imeSync, let main = webView, let window = main.window,
              let end = (note.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? NSValue)?.cgRectValue else { return }
        let duration = (note.userInfo?[UIResponder.keyboardAnimationDurationUserInfoKey] as? NSNumber)?.doubleValue ?? 0.25
        let curveRaw = (note.userInfo?[UIResponder.keyboardAnimationCurveUserInfoKey] as? NSNumber)?.uintValue ?? 7
        let hiding = note.name == UIResponder.keyboardWillHideNotification
        let frame = main.convert(window.convert(end, from: nil), from: window)
        let overlap = hiding ? 0 : max(0, main.bounds.maxY - frame.minY)
        // willChangeFrame and willHide both report a close; a repeat must not
        // restart it (that would drop the held lift before the page offset).
        guard overlap != keyboardOverlap else { return }
        let previous = keyboardOverlap
        keyboardOverlap = overlap
        let open = overlap > 0
        emitImeState(open: open, phase: "start", height: overlap, duration: duration)
        engageHeader()
        // Same model as Android: the content is translated by -overlap for as
        // long as the keyboard is up; the page offset only re-lays the page
        // into that visible region. Translation never depends on the offset.
        let animate = { [weak self] in
            guard let self else { return }
            UIView.animate(withDuration: duration, delay: 0, options: [UIView.AnimationOptions(rawValue: curveRaw << 16), .beginFromCurrentState]) {
                self.setLift(overlap)
            } completion: { [weak self] _ in
                guard let self, self.keyboardOverlap == overlap else { return }
                self.settle(overlap)
            }
        }
        if overlap < webOffset {
            // Release the larger page offset first while translation still
            // holds the old keyboard height (mirror covers the header), then
            // the keyboard animation carries the content down.
            setLift(previous)
            requestOffset(overlap) { [weak self] in
                guard let self, self.keyboardOverlap == overlap else { return }
                animate()
            }
        } else {
            animate()
        }
    }

    private func settle(_ overlap: CGFloat) {
        requestOffset(overlap) { [weak self] in
            guard let self, self.keyboardOverlap == overlap else { return }
            self.emitImeState(open: overlap > 0, phase: "settled", height: overlap, duration: 0)
            self.releaseHeader()
        }
    }

    /// Page absorbs `px` points at its top; completion runs after it painted.
    private func requestOffset(_ px: CGFloat, completion: @escaping () -> Void) {
        guard let main = webView else { return }
        offsetGeneration += 1
        let token = offsetGeneration
        if px == webOffset { return completion() }
        main.callAsyncJavaScript("return window.__yuriImeOffset ? await window.__yuriImeOffset(px) : 0", arguments: ["px": Double(px)], in: nil, in: .page) { [weak self] _ in
            guard let self, token == self.offsetGeneration else { return }
            self.webOffset = px
            completion()
        }
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
            guard let self, token == self.headerGeneration else { return }
            self.setEngaged(false)
        }
    }

    private func resetIme() {
        offsetGeneration += 1
        keyboardOverlap = 0
        setLift(0)
        if webOffset != 0 {
            webOffset = 0
            webView?.evaluateJavaScript("window.__yuriImeOffset&&window.__yuriImeOffset(0)")
        }
        releaseHeader()
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
