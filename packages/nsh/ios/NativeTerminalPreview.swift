import Foundation

/// Exact document admission, not a general browser allowlist. One explicit load
/// admits one GET of one local entry; links, redirects, frames and popups are denied.
struct NativeTerminalNavigation {
    let entry: URL
    func allows(_ url: URL?, method: String?, mainFrame: Bool, loading: Bool) -> Bool {
        loading && mainFrame && method == "GET" && url == entry
    }
}

enum NativeTerminalDocument {
    static let scheme = "yuri-terminal"
    static let policy = "default-src 'none'; script-src 'unsafe-inline' 'wasm-unsafe-eval'; style-src 'unsafe-inline'; connect-src 'none'; img-src data:; font-src 'none'; frame-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"
    static let networkRules = """
    [{"trigger":{"url-filter":"^https?:"},"action":{"type":"block"}},
     {"trigger":{"url-filter":"^wss?:"},"action":{"type":"block"}},
     {"trigger":{"url-filter":"^file:"},"action":{"type":"block"}},
     {"trigger":{"url-filter":"^ftp:"},"action":{"type":"block"}}]
    """
    static func json(_ input: Any) throws -> String {
        let bytes = try JSONSerialization.data(withJSONObject: input, options: [.fragmentsAllowed, .sortedKeys])
        guard let value = String(data: bytes, encoding: .utf8) else { throw TerminalFailure.invalid }
        return value.replacingOccurrences(of: "<", with: "\\u003c").replacingOccurrences(of: "\u{2028}", with: "\\u2028").replacingOccurrences(of: "\u{2029}", with: "\\u2029")
    }
    static func render(javascript: Data, wasm: Data, palette: [String: String], family: String, size: Double, label: String) throws -> String {
        let allowed = Set(["background", "foreground", "cursor", "selectionBackground", "cursorAccent", "selectionForeground", "black", "red", "green", "yellow", "blue", "magenta", "cyan", "white", "brightBlack", "brightRed", "brightGreen", "brightYellow", "brightBlue", "brightMagenta", "brightCyan", "brightWhite"])
        guard javascript.count <= 4_000_000, wasm.count <= 1_500_000, wasm.starts(with: [0, 97, 115, 109]),
              let source = String(data: javascript, encoding: .utf8), !source.isEmpty,
              Set(palette.keys).isSubset(of: allowed), ["background", "foreground", "cursor", "selectionBackground"].allSatisfy({ palette[$0] != nil }),
              palette.values.allSatisfy({ $0.range(of: "^#[a-fA-F0-9]{6}([a-fA-F0-9]{2})?$", options: .regularExpression) != nil }),
              !family.isEmpty, family.utf8.count <= 1024, size.isFinite, (6...72).contains(size), label.utf8.count <= 1024 else { throw TerminalFailure.invalid }
        let escaped = source.replacingOccurrences(of: "</script", with: "<\\/script", options: .caseInsensitive)
        let config = try json(["wasm": wasm.base64EncodedString(), "palette": palette, "family": family, "size": size, "label": label])
        return """
        <!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1"><meta http-equiv="Content-Security-Policy" content="\(policy)"><style>html,body,#terminal{width:100%;height:100%;margin:0;overflow:hidden;background:\(palette["background"]!)}#input{position:absolute;left:0;bottom:0;width:1px;height:1px;opacity:.01;font-size:16px}</style></head><body><div id="terminal"></div><textarea id="input" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false"></textarea><script>\(escaped)</script><script>\(bootstrap)\nstartNativeTerminal(\(config));</script></body></html>
        """
    }
    // This is the production bootstrap, parsed statically by terminal-static.test.ts.
    static let bootstrap = #"""
    async function startNativeTerminal(config) {
      const post = value => window.webkit.messageHandlers.terminal.postMessage(value);
      try {
        window.open = () => null;
        const bytes = Uint8Array.from(atob(config.wasm), c => c.charCodeAt(0));
        const module = await WebAssembly.compile(bytes);
        const instance = await WebAssembly.instantiate(module, {env:{log(){}}});
        const terminal = new GhosttyWeb.Terminal({ghostty:new GhosttyWeb.Ghostty(instance),disableStdin:true,fontFamily:config.family,fontSize:config.size,theme:config.palette,scrollback:10000,cursorBlink:false});
        const fit = new GhosttyWeb.FitAddon(); terminal.loadAddon(fit); terminal.open(document.getElementById('terminal'));
        const input = document.getElementById('input'); input.setAttribute('aria-label',config.label);
        let key = '', cursor = 0, live = false, composing = false;
        let follow = true;
        const originalBottom = terminal.scrollToBottom.bind(terminal);
        terminal.scrollToBottom = () => { if(follow)originalBottom(); };
        terminal.onScroll(y => { follow = !terminal.hasSelection() && y <= .5; });
        terminal.onSelectionChange(() => { follow = !terminal.hasSelection() && terminal.getViewportY() <= .5; });
        const queue = []; let queuedBytes = 0, receipt = 0, blocked = false;
        const drafts = new Map(), rejectedKeys = new Set();
        const byteLength = text => { let n=0;for(const point of text){const c=point.codePointAt(0);n+=c<=127?1:c<=2047?2:c<=65535?3:4;}return n; };
        const reject = code => post({type:'inputRejected',key,code});
        const retain = items => {
          const prefixes = new Map();
          for(const item of items)prefixes.set(item.key,(prefixes.get(item.key)||'')+item.retained);
          for(const [owner,text] of prefixes){
            if(owner===key)input.value=text+input.value;
            else drafts.set(owner,text+(drafts.get(owner)||''));
          }
        };
        const removeQueued = predicate => {
          const removed=[];
          for(let i=0;i<queue.length;){
            const item=queue[i];
            if(predicate(item)){removed.push(item);queuedBytes-=item.size;queue.splice(i,1);}else i++;
          }
          return removed;
        };
        const pump = () => {
          const item=queue[0];if(!live||blocked||rejectedKeys.has(key)||!item||item.sent||item.key!==key)return;
          item.sent=true;post({type:'input',key:item.key,data:item.data,receipt:item.receipt});
        };
        const send = (data, retained=data) => {
          if(!data)return true;
          const size=byteLength(data);
          if(!live||blocked||rejectedKeys.has(key)||size>65536||queue.length>=4||queuedBytes+size>262144){reject(blocked?'input_unknown':rejectedKeys.has(key)?'input_not_accepted':size>65536?'input_too_large':'input_backpressure');return false;}
          queue.push({key,data,retained,size,receipt:++receipt,sent:false});queuedBytes+=size;pump();return true;
        };
        window.terminalInputResult = value => {
          const item=queue[0];if(blocked||!item||!item.sent||value.key!==item.key||value.receipt!==item.receipt)return;
          if(value.status==='accepted'){queue.shift();queuedBytes-=item.size;pump();return;}
          if(value.status!=='rejected'&&value.status!=='unknown')return;
          // Restore only each receipt's original Tab; prefix preserved text to
          // newer edits instead of replacing them. Unknown halts the whole lane.
          if(value.status==='unknown'){
            blocked=true;retain(removeQueued(()=>true));reject('input_unknown');
          }else{
            rejectedKeys.add(item.key);retain(removeQueued(pending=>pending.key===item.key));
            if(item.key===key)reject('input_not_accepted');
            pump();
          }
        };
        terminal.onData(send);
        input.addEventListener('compositionstart',()=>{composing=true;});
        input.addEventListener('compositionend',()=>{composing=false;if(send(input.value))input.value='';});
        input.addEventListener('input',event=>{if(!composing&&!event.isComposing){if(send(input.value))input.value='';}});
        input.addEventListener('paste',event=>{
          if(composing)return;
          const text=event.clipboardData?.getData('text')||'';if(!text)return;
          event.preventDefault();event.stopPropagation();
          const payload=terminal.hasBracketedPaste()?'\x1b[200~'+text+'\x1b[201~':text;
          if(!send(payload,text))input.value+=text;
        });
        input.addEventListener('beforeinput',event=>{
          if(composing||event.isComposing)return;
          if(input.value)return;
          if(event.inputType==='deleteContentBackward'){event.preventDefault();send('\x7f');}
          if(event.inputType==='insertLineBreak'||event.inputType==='insertParagraph'){event.preventDefault();send('\r');}
        });
        const keys={Escape:'\x1b',Tab:'\t',Enter:'\r',Backspace:'\x7f',Delete:'\x1b[3~',Home:'\x1b[H',End:'\x1b[F',PageUp:'\x1b[5~',PageDown:'\x1b[6~',ArrowUp:'\x1b[A',ArrowDown:'\x1b[B',ArrowLeft:'\x1b[D',ArrowRight:'\x1b[C'};
        input.addEventListener('keydown',event=>{
          if(composing||event.isComposing||event.keyCode===229)return;
          const letter=event.key.toLowerCase();
          const copy=(event.metaKey&&!event.ctrlKey&&!event.altKey||event.ctrlKey&&event.shiftKey&&!event.metaKey&&!event.altKey)&&letter==='c';
          if(copy&&terminal.hasSelection()){
            event.preventDefault();const text=terminal.getSelection();
            // Native copy events populate the clipboard without a PTY input.
            const handler=e=>{e.preventDefault();e.clipboardData?.setData('text/plain',text);};
            document.addEventListener('copy',handler);document.execCommand('copy');document.removeEventListener('copy',handler);return;
          }
          if(event.metaKey&&!keys[event.key])return;
          if(input.value&&['Backspace','Delete','Enter'].includes(event.key))return;
          if(event.ctrlKey&&!event.altKey&&/^[a-z]$/i.test(event.key)){event.preventDefault();send(String.fromCharCode(event.key.toUpperCase().charCodeAt(0)&31));}
          else if(keys[event.key]){event.preventDefault();send(keys[event.key]);}
        });
        document.getElementById('terminal').addEventListener('click',()=>{if(live&&!moved)input.focus();});
        document.addEventListener('click',event=>{if(event.target.closest&&event.target.closest('a'))event.preventDefault();},true);
        // Same canvas scrollback mapping/kinetic constants as TerminalViewport's
        // touch path. The document itself never scrolls and swipes don't type.
        const container = document.getElementById('terminal');
        let pointer = null, lastY = 0, lastTime = 0, startX = 0, startY = 0, moved = false, velocity = 0, remainder = 0, frame = null;
        const now = () => Date.now(), lineHeight = Math.max(12,Math.round(config.size*1.35));
        const stopKinetic = () => { if(frame!==null)window.cancelAnimationFrame(frame);frame=null; };
        const scrollPixels = delta => {
          const before=terminal.getViewportY(),total=remainder+delta,lines=Math.trunc(total/lineHeight);remainder=total-lines*lineHeight;
          if(lines)terminal.scrollLines(lines);return terminal.getViewportY()!==before;
        };
        container.addEventListener('pointerdown',event=>{
          if(event.pointerType!=='touch')return;
          stopKinetic();pointer=event.pointerId;startX=event.clientX;startY=lastY=event.clientY;lastTime=now();velocity=0;moved=false;
          try{container.setPointerCapture(pointer);}catch{}
        },{passive:false});
        container.addEventListener('pointermove',event=>{
          if(event.pointerType!=='touch'||event.pointerId!==pointer)return;
          if(Math.hypot(event.clientX-startX,event.clientY-startY)>=6)moved=true;
          const current=now(),delta=lastY-event.clientY,dt=Math.max(current-lastTime,8);lastY=event.clientY;lastTime=current;
          if(Math.abs(delta)<1)return;
          const pixels=delta*(2.2+Math.min(2.8,Math.abs(delta)/25));velocity=Math.max(-8,Math.min(8,velocity*.75+(pixels/dt)*.25));
          if(moved){if(event.cancelable)event.preventDefault();event.stopPropagation();}scrollPixels(pixels);
        },{passive:false});
        const endPointer=(event,cancelled)=>{
          if(event.pointerId!==pointer)return;
          try{container.releasePointerCapture(pointer);}catch{}pointer=null;
          if(cancelled){stopKinetic();velocity=0;return;}
          if(!moved){if(live)input.focus();return;}
          if(Math.abs(velocity)<.05)return;
          let last=now();const step=()=>{
            const current=now(),dt=Math.max(current-last,8);last=current;
            const changed=scrollPixels(velocity*dt),magnitude=Math.max(0,Math.abs(velocity)-.015*dt);velocity=Math.sign(velocity)*magnitude;
            if(!changed||magnitude<=.05){stopKinetic();velocity=0;return;}frame=window.requestAnimationFrame(step);
          };frame=window.requestAnimationFrame(step);
        };
        container.addEventListener('pointerup',event=>endPointer(event,false),{passive:false});
        container.addEventListener('pointercancel',event=>endPointer(event,true),{passive:false});
        const resize=()=>{fit.fit();if(terminal.cols>=2&&terminal.rows>=1)post({type:'resize',key,cols:terminal.cols,rows:terminal.rows});};
        const observer=new ResizeObserver(resize);observer.observe(document.getElementById('terminal'));
        window.terminalRender=value=>{
          if(!value||value.type!=='render'||typeof value.key!=='string'||!Array.isArray(value.chunks))return;
          // Keep exactly the in-flight receipt across a switch. Unsent old-Tab
          // input becomes a draft and never occupies another Tab's queue head.
          if(key!==value.key||value.live!==true)retain(removeQueued(item=>!item.sent));
          live=value.live===true;
          if(!live){input.blur();composing=false;stopKinetic();pointer=null;}
          if(key!==value.key){drafts.set(key,input.value);key=value.key;input.value=drafts.get(key)||'';drafts.delete(key);cursor=0;follow=true;stopKinetic();terminal.reset();resize();}
          const pending=value.chunks.filter(chunk=>typeof chunk.data==='string'&&chunk.id>cursor);
          pending.forEach((chunk,index)=>{cursor=chunk.id;terminal.write(chunk.data,index===pending.length-1?()=>post({type:'ack',key:value.key,cursor:chunk.id,serial:value.serial}):undefined);});
          if(value.focus&&live)input.focus();
          pump();
        };
        window.addEventListener('pagehide',()=>{live=false;stopKinetic();observer.disconnect();terminal.dispose();});
        post({type:'ready'});resize();
      }catch{post({type:'error',code:'renderer_unavailable'});}
    }
    """#
}

#if canImport(UIKit) && canImport(WebKit) && canImport(NativeShell)
import UIKit
import WebKit
import NativeShell

@MainActor private final class NativeTerminalMessageProxy: NSObject, WKScriptMessageHandler {
    weak var surface: NativeTerminalSurface?
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) { surface?.receive(message) }
}

/// Only this feature's fixed terminal document exists in this WKWebView. No NSH
/// host bridge, arbitrary HTML/JS, URL navigation or app navigation is installed.
@MainActor private final class NativeTerminalSurface: UIViewController, WKURLSchemeHandler, WKNavigationDelegate, WKUIDelegate {
    let owner: String, entry: URL, document: Data
    let current: () -> Bool, emit: ([String: Any]) -> Void
    private var web: WKWebView?, loading = true, stopped = false
    var rules: WKContentRuleList?
    var onClose: (() -> Void)?
    private var toolbar: UIStackView!, tabs: UIStackView!, keys: UIStackView!, status: UILabel!
    private var previousChrome: Data?
    init(owner: String, document: String, current: @escaping () -> Bool, emit: @escaping ([String: Any]) -> Void) {
        self.owner = owner; entry = URL(string: "\(NativeTerminalDocument.scheme)://\(UUID().uuidString.lowercased())/index.html")!
        self.document = Data(document.utf8); self.current = current; self.emit = emit
        super.init(nibName: nil, bundle: nil)
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) unavailable") }
    override func loadView() {
        let root = UIView(); root.backgroundColor = .systemBackground; view = root
        let stack = UIStackView(); stack.axis = .vertical; stack.translatesAutoresizingMaskIntoConstraints = false; root.addSubview(stack)
        NSLayoutConstraint.activate([stack.leadingAnchor.constraint(equalTo: root.safeAreaLayoutGuide.leadingAnchor), stack.trailingAnchor.constraint(equalTo: root.safeAreaLayoutGuide.trailingAnchor), stack.topAnchor.constraint(equalTo: root.safeAreaLayoutGuide.topAnchor), stack.bottomAnchor.constraint(equalTo: root.keyboardLayoutGuide.topAnchor)])
        toolbar = UIStackView(); toolbar.axis = .horizontal; toolbar.spacing = 8
        tabs = UIStackView(); tabs.axis = .horizontal; tabs.spacing = 4
        let scroll = UIScrollView(); scroll.showsHorizontalScrollIndicator = false; scroll.addSubview(tabs); tabs.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([tabs.leadingAnchor.constraint(equalTo: scroll.contentLayoutGuide.leadingAnchor), tabs.trailingAnchor.constraint(equalTo: scroll.contentLayoutGuide.trailingAnchor), tabs.topAnchor.constraint(equalTo: scroll.contentLayoutGuide.topAnchor), tabs.bottomAnchor.constraint(equalTo: scroll.contentLayoutGuide.bottomAnchor), tabs.heightAnchor.constraint(equalTo: scroll.frameLayoutGuide.heightAnchor), scroll.heightAnchor.constraint(equalToConstant: 44)])
        toolbar.addArrangedSubview(scroll); stack.addArrangedSubview(toolbar)
        let configuration = WKWebViewConfiguration(); configuration.websiteDataStore = .nonPersistent()
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = false; configuration.allowsAirPlayForMediaPlayback = false
        configuration.setURLSchemeHandler(self, forURLScheme: NativeTerminalDocument.scheme)
        if let rules { configuration.userContentController.add(rules) }
        let proxy = NativeTerminalMessageProxy(); proxy.surface = self
        configuration.userContentController.add(proxy, name: "terminal")
        let web = WKWebView(frame: .zero, configuration: configuration); self.web = web
        web.navigationDelegate = self; web.uiDelegate = self; web.scrollView.isScrollEnabled = false; stack.addArrangedSubview(web)
        status = UILabel(); status.numberOfLines = 0; status.font = .preferredFont(forTextStyle: .caption1); stack.addArrangedSubview(status)
        keys = UIStackView(); keys.axis = .horizontal; keys.spacing = 4
        let keyScroll = UIScrollView(); keyScroll.addSubview(keys); keys.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([keys.leadingAnchor.constraint(equalTo: keyScroll.contentLayoutGuide.leadingAnchor), keys.trailingAnchor.constraint(equalTo: keyScroll.contentLayoutGuide.trailingAnchor), keys.topAnchor.constraint(equalTo: keyScroll.contentLayoutGuide.topAnchor), keys.bottomAnchor.constraint(equalTo: keyScroll.contentLayoutGuide.bottomAnchor), keys.heightAnchor.constraint(equalTo: keyScroll.frameLayoutGuide.heightAnchor), keyScroll.heightAnchor.constraint(equalToConstant: 44)])
        stack.addArrangedSubview(keyScroll)
        navigationItem.rightBarButtonItem = UIBarButtonItem(systemItem: .done, primaryAction: UIAction { [weak self] _ in self?.onClose?() })
        web.load(URLRequest(url: entry))
    }
    private func button(_ title: String, enabled: Bool = true, action: @escaping () -> Void) -> UIButton {
        let button = UIButton(type: .system); var config = UIButton.Configuration.filled()
        config.baseBackgroundColor = .secondarySystemBackground; config.baseForegroundColor = .label; config.title = title
        button.configuration = config; button.isEnabled = enabled; button.addAction(UIAction { _ in action() }, for: .touchUpInside); return button
    }
    func update(_ value: [String: Any]) throws {
        if let result = value["inputResult"] as? [String: Any] {
            guard !stopped, current(), let key = result["key"] as? String, TerminalProtocol.identifier(key),
                  let receipt = TerminalProtocol.integer(result["receipt"]), receipt > 0,
                  let status = result["status"] as? String, ["accepted", "rejected", "unknown"].contains(status) else { throw TerminalFailure.invalid }
            web?.callAsyncJavaScript("window.terminalInputResult(result)", arguments: ["result": result], in: nil, in: .page) { [weak self] outcome in
                if case .failure = outcome { self?.emit(["type": "error", "code": "renderer_failed"]) }
            }
            return
        }
        guard !stopped, current(), let message = value["render"] as? [String: Any], let key = message["key"] as? String, key.utf8.count <= 128,
              let chunks = message["chunks"] as? [[String: Any]], chunks.count <= 65_536,
              chunks.allSatisfy({ ($0["data"] as? String).map { $0.utf8.count <= 1_048_576 } == true && TerminalProtocol.integer($0["id"]) != nil }),
              let rows = value["tabs"] as? [[String: Any]], rows.count <= 64 else { throw TerminalFailure.invalid }
        loadViewIfNeeded()
        var chrome = value; chrome.removeValue(forKey: "render")
        let encoded = try JSONSerialization.data(withJSONObject: chrome, options: .sortedKeys)
        if previousChrome != encoded {
        previousChrome = encoded
        for view in tabs.arrangedSubviews { tabs.removeArrangedSubview(view); view.removeFromSuperview() }
        for row in rows {
            guard let id = row["id"] as? String, TerminalProtocol.identifier(id), let label = row["label"] as? String, label.utf8.count <= 1024 else { throw TerminalFailure.invalid }
            let choose = button(label) { [weak self] in self?.emit(["type": "select", "id": id]) }
            choose.isSelected = id == key
            if choose.isSelected { choose.configuration?.baseBackgroundColor = .tertiarySystemFill }
            choose.accessibilityIdentifier = id
            tabs.addArrangedSubview(choose)
            if let close = value["closeLabel"] as? String { tabs.addArrangedSubview(button("×") { [weak self] in self?.emit(["type": "closeTab", "id": id]) }); tabs.arrangedSubviews.last?.accessibilityLabel = close }
        }
        if let label = value["newLabel"] as? String { tabs.addArrangedSubview(button("＋") { [weak self] in self?.emit(["type": "newTab"]) }); tabs.arrangedSubviews.last?.accessibilityLabel = label }
        if let label = value["previewLabel"] as? String, value["hasPreview"] as? Bool == true { tabs.addArrangedSubview(button(label) { [weak self] in self?.emit(["type": "preview", "id": key]) }) }
        if let label = value["retryLabel"] as? String { tabs.addArrangedSubview(button(label) { [weak self] in self?.emit(["type": "retry"]) }) }
        if let label = value["restartLabel"] as? String { tabs.addArrangedSubview(button(label) { [weak self] in self?.emit(["type": "restart"]) }) }
        for view in keys.arrangedSubviews { keys.removeArrangedSubview(view); view.removeFromSuperview() }
        for item in value["keys"] as? [[String: String]] ?? [] {
            guard let title = item["label"], let key = item["key"] else { continue }
            let control = button(title, enabled: message["live"] as? Bool == true) { [weak self] in self?.emit(["type": "key", "key": key]) }
            control.isSelected = value["modifier"] as? String == key
            if control.isSelected { control.configuration?.baseBackgroundColor = .tertiarySystemFill }
            keys.addArrangedSubview(control)
        }
        for action in value["actions"] as? [[String: String]] ?? [] {
            guard let id = action["id"], let label = action["name"] else { continue }
            keys.addArrangedSubview(button(label) { [weak self] in self?.emit(["type": "action", "id": id]) })
        }
        if let action = value["activeAction"] as? String, let label = value["stopLabel"] as? String { keys.addArrangedSubview(button(label) { [weak self] in self?.emit(["type": "stopAction", "id": action]) }) }
        status.text = value["status"] as? String
        }
        web?.callAsyncJavaScript("window.terminalRender(message)", arguments: ["message": message], in: nil, in: .page) { [weak self] result in
            if case .failure = result { self?.emit(["type": "error", "code": "renderer_failed"]) }
        }
    }
    func receive(_ message: WKScriptMessage) {
        guard !stopped, current(), message.frameInfo.isMainFrame, message.frameInfo.request.url == entry,
              let value = message.body as? [String: Any], let type = value["type"] as? String,
              ["ready", "input", "inputRejected", "resize", "ack", "error"].contains(type) else { return }
        if type == "input" {
            guard (value["data"] as? String).map({ $0.utf8.count <= 65_536 }) == true,
                  let receipt = TerminalProtocol.integer(value["receipt"]), receipt > 0 else { return }
        }
        emit(value)
    }
    func stop() {
        stopped = true; web?.stopLoading(); web?.configuration.userContentController.removeScriptMessageHandler(forName: "terminal")
        web?.navigationDelegate = nil; web?.uiDelegate = nil; web?.removeFromSuperview(); web = nil
    }
    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        guard !stopped, current(), task.request.url == entry, task.request.httpMethod == "GET" else { task.didFailWithError(TerminalFailure.invalid); return }
        let response = HTTPURLResponse(url: entry, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": NativeTerminalDocument.policy, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"])!
        task.didReceive(response); task.didReceive(document); task.didFinish()
    }
    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {}
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        let allow = !stopped && current() && NativeTerminalNavigation(entry: entry).allows(action.request.url, method: action.request.httpMethod, mainFrame: action.targetFrame?.isMainFrame == true, loading: loading)
        if allow { loading = false }
        decisionHandler(allow ? .allow : .cancel)
    }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { loading = false }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { if !stopped { emit(["type": "error", "code": "renderer_failed"]) } }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { emit(["type": "error", "code": "renderer_failed"]) }
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? { nil }
}

@MainActor final class NativeTerminalPreview: NSObject, UIAdaptivePresentationControllerDelegate {
    private weak var presenter: UIViewController?
    private let bridge: TerminalBridge
    private let emit: ([String: Any]) -> Void
    private var surface: NativeTerminalSurface?
    private var scope: RuntimeHostScope?
    private var pendingOwner: String?
    private var opening = UUID()
    init(presenter: UIViewController, bridge: TerminalBridge, emit: @escaping ([String: Any]) -> Void) { self.presenter = presenter; self.bridge = bridge; self.emit = emit }
    func register(app: NshAppView) {
        app.handle("terminal.preview.open") { [weak self] input async throws -> Any? in
            guard let self, let value = input as? [String: Any] else { throw TerminalFailure.invalid }; return try await self.open(value)
        }
        app.handle("terminal.preview.render") { [weak self] input async throws -> Any? in
            guard let self, let value = input as? [String: Any], let surface = self.surface, value["owner"] as? String == surface.owner,
                  let scope = self.scope, scope == (try RuntimeHostScope(value["expectedHost"])) else { throw TerminalFailure.stale }
            _ = try self.bridge.admitted(scope); try surface.update(value); return true
        }
        app.handle("terminal.preview.finish") { [weak self] input async throws -> Any? in
            guard let self, let owner = (input as? [String: Any])?["owner"] as? String else { return true }
            if self.pendingOwner == owner { self.opening = UUID(); self.pendingOwner = nil }
            guard self.surface?.owner == owner else { return true }
            self.finish(); return true
        }
    }
    private func open(_ value: [String: Any]) async throws -> Any {
        let expected = try RuntimeHostScope(value["expectedHost"]), transport = try bridge.admitted(expected)
        guard let presenter, presenter.presentedViewController == nil, surface == nil, pendingOwner == nil, let owner = value["owner"] as? String, TerminalProtocol.identifier(owner),
              let palette = value["palette"] as? [String: String], let family = value["fontFamily"] as? String,
              let size = value["fontSize"] as? Double, let label = value["inputLabel"] as? String,
              let js = Bundle.main.url(forResource: "terminal-ghostty", withExtension: "js"), let wasm = Bundle.main.url(forResource: "terminal-ghostty", withExtension: "wasm") else { throw TerminalFailure.unavailable }
        let token = UUID(); opening = token; pendingOwner = owner
        defer { if opening == token { pendingOwner = nil } }
        let document = try NativeTerminalDocument.render(javascript: Data(contentsOf: js), wasm: Data(contentsOf: wasm), palette: palette, family: family, size: size, label: label)
        let current = { [weak self] in self?.scope == expected && transport.isCurrent() && UIApplication.shared.applicationState == .active }
        let page = NativeTerminalSurface(owner: owner, document: document, current: current) { [weak self] event in
            guard let self, self.surface?.owner == owner else { return }; var event = event; event["owner"] = owner; event["expectedHost"] = expected.publicValue; self.emit(event)
        }
        guard let rules = try await WKContentRuleListStore.default().compileContentRuleList(forIdentifier: "yuri-terminal-offline", encodedContentRuleList: NativeTerminalDocument.networkRules), opening == token, pendingOwner == owner, transport.isCurrent(), presenter.presentedViewController == nil else { throw TerminalFailure.stale }
        page.rules = rules; scope = expected; surface = page; page.onClose = { [weak self] in self?.finish() }
        let navigation = UINavigationController(rootViewController: page); presenter.present(navigation, animated: true); navigation.presentationController?.delegate = self
        return true
    }
    func invalidate() { opening = UUID(); pendingOwner = nil; finish() }
    var contentPresenter: UIViewController? { surface }
    private func finish() {
        guard let value = surface else { return }; surface = nil; let expected = scope; scope = nil
        value.stop(); presenter?.dismiss(animated: true)
        emit(["type": "closed", "owner": value.owner, "expectedHost": expected?.publicValue ?? [:]])
    }
    func presentationControllerDidDismiss(_ presentationController: UIPresentationController) { finish() }
}
#endif
