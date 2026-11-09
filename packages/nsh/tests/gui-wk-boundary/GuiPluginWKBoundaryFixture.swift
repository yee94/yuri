import Foundation
import UIKit
import WebKit

/// Main runs this in an attached, active UIKit fixture host. It exercises the
/// actual GuiPluginPreviewBridge, scheme handler, response headers and WK SOP.
/// No NSH engine, network, real Host, photo permission or production data.
@MainActor enum GuiPluginWKBoundaryFixture {
    enum Failure: Error { case unattached, timeout, rootBridge, childBoundary(String), escaped, storage, rpc }
    private final class Evidence: NSObject, WKScriptMessageHandler {
        var rows: [String: [String: Any]] = [:]
        func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
            guard !message.frameInfo.isMainFrame, let row = message.body as? [String: Any], let name = row["case"] as? String else { return }
            rows[name] = row
        }
    }
    private static func findWeb(_ view: UIView) -> WKWebView? {
        if let web = view as? WKWebView { return web }
        return view.subviews.lazy.compactMap { findWeb($0) }.first
    }
    private static let rootHTML = #"""
    <!doctype html><html><head><meta charset="utf-8"></head><body>
    <script>
    window.fixtureReady = false;
    (async () => {
      const channel = window.webkit.messageHandlers.guiPluginPreview;
      const bootstrap = await channel.postMessage({name:'bootstrap'});
      window.fixtureScope = bootstrap.intent.expectedHost;
      await channel.postMessage({name:'state',expectedHost:window.fixtureScope,phase:'mounted'});
      window.fixtureReady = true;
    })();
    window.startFixtureChildren = () => {
      const origin = location.protocol + '//' + location.host;
      const encoded = btoa('http://localhost:3000').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
      const host = btoa('https://fixture-host.invalid').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
      for (const path of ['/__gui/files/work/attack.html','/__gui/loopback/'+encoded+'/attack.html','/__gui/host/'+host+'/api/fs/serve/work/reports/attack.html']) {
        const frame = document.createElement('iframe'); frame.src = origin + path; document.body.append(frame);
      }
    };
    </script></body></html>
    """#
    private static let attackScript = #"""
    async function exerciseBoundary(caseName) {
      const result = {case:caseName,script:true};
      const scope = {hostID:'gui-boundary-host',lease:'11111111-1111-4111-8111-111111111111'};
      const payload = `(async()=>{
        window.fixtureEscaped = (window.fixtureEscaped || 0) + 1;
        const channel = window.webkit.messageHandlers.guiPluginPreview;
        const boot = await channel.postMessage({name:'bootstrap'});
        const expectedHost = boot.intent.expectedHost;
        await channel.postMessage({name:'device',expectedHost,method:'copy',input:{text:'untrusted-frame-escape'}});
        window.prompt('yuri.gui.storage.v1',JSON.stringify({expectedHost,operation:{method:'set',key:boot.preferenceKey,value:'["escaped"]'}}));
        await channel.postMessage({name:'request',expectedHost,id:'902',input:{method:'POST',route:'/api/rpc/boundary/probe',headers:{'content-type':'application/json'},body:'{"input":{"escaped":true}}'}});
      })()`;
      for (const [name, run] of [
        ['parentEval',()=>parent.eval(payload)],
        ['parentFunction',()=>parent.Function('return '+payload)()],
        ['topEval',()=>top.eval(payload)],
        ['topFunction',()=>top.Function('return '+payload)()]
      ]) {
        try { await run(); result[name] = 'ESCAPED'; }
        catch (error) { result[name] = error.name; }
      }
      try { await window.webkit.messageHandlers.guiPluginPreview.postMessage({name:'bootstrap'});result.directBootstrap=false; }
      catch { result.directBootstrap=true; }
      try {
        await window.webkit.messageHandlers.guiPluginPreview.postMessage({name:'device',expectedHost:scope,method:'copy',input:{text:'direct-child-device'}});
        result.directDevice=false;
      } catch { result.directDevice=true; }
      try {
        await window.webkit.messageHandlers.guiPluginPreview.postMessage({name:'request',expectedHost:scope,id:'903',input:{method:'POST',route:'/api/rpc/boundary/probe',headers:{'content-type':'application/json'},body:'{"input":{"child":true}}'}});
        result.directRPC=false;
      } catch { result.directRPC=true; }
      result.directStorage = window.prompt('yuri.gui.storage.v1',JSON.stringify({expectedHost:scope,operation:{method:'set',key:'yuri.inst.bnNoOmd1aS1ib3VuZGFyeS1ob3N0.gui-plugins.disabled',value:'["direct-child"]'}})) === null;
      if (!caseName.endsWith('-nested')) {
        const button = document.getElementById('action'); button.click();
        result.interaction = button.dataset.pressed === 'true';
        result.classicScript = window.fixtureClassic === true;
        result.moduleScript = window.fixtureModule === true;
        result.style = getComputedStyle(document.getElementById('styled')).color === 'rgb(1, 2, 3)';
        try { result.resourceFetch = await (await fetch(new URL('./probe.txt',location.href),{credentials:'omit',redirect:'error'})).text() === 'scoped resource bytes'; }
        catch (error) { result.resourceFetch=false; result.fetchError=error.name; }
        const nested = document.createElement('iframe');
        nested.srcdoc = '<!doctype html><html><body><script>('+exerciseBoundary.toString()+')('+JSON.stringify(caseName+'-nested')+')</'+'script></body></html>';
        document.body.append(nested);
      }
      window.webkit.messageHandlers.guiBoundaryResult.postMessage(result);
    }
    window.addEventListener('load',()=>exerciseBoundary(document.documentElement.dataset.case),{once:true});
    """#
    private static func resource(_ route: String, kind: String) throws -> ResourceWebPreviewResponse {
        let path = URLComponents(string: route)?.path ?? ""
        if path.hasSuffix("/attack.html") {
            let html = "<!doctype html><html data-case='" + kind + "'><head><meta charset='utf-8'><link rel='stylesheet' href='./safe.css'><script src='./safe.js'></script><script type='module' src='./safe.mjs'></script></head><body><button id='action' onclick=\"this.dataset.pressed='true'\">test action</button><p id='styled'>scoped style</p><script>" + attackScript + "</script></body></html>"
            return ResourceWebPreviewResponse(status: 200, mime: "text/html; charset=utf-8", data: Data(html.utf8))
        }
        if path.hasSuffix("/safe.js") { return ResourceWebPreviewResponse(status: 200, mime: "text/javascript", data: Data("window.fixtureClassic=true".utf8)) }
        if path.hasSuffix("/safe.mjs") { return ResourceWebPreviewResponse(status: 200, mime: "text/javascript", data: Data("window.fixtureModule=true;export {}".utf8)) }
        if path.hasSuffix("/safe.css") { return ResourceWebPreviewResponse(status: 200, mime: "text/css", data: Data("#styled{color:rgb(1,2,3)}".utf8)) }
        if path.hasSuffix("/probe.txt") { return ResourceWebPreviewResponse(status: 200, mime: "text/plain", data: Data("scoped resource bytes".utf8)) }
        throw GuiPluginPreviewFailure.invalid
    }
    static func run(in controller: UIViewController, onRootProof: (([String: Bool]) -> Void)? = nil, onRootResultType: ((String) -> Void)? = nil) async throws -> [String: Any] {
        guard controller.view.window != nil, controller.presentedViewController == nil, UIApplication.shared.applicationState == .active else { throw Failure.unattached }
        let scope = RuntimeHostScope(hostID: "gui-boundary-host", lease: UUID(uuidString: "11111111-1111-4111-8111-111111111111")!)
        let owner = "wk-boundary-fixture", runtimeKey = GuiPluginNativeContext.runtimeKey(hostID: scope.hostID)
        let preferenceKey = GuiPluginNativeContext.preferenceKey(runtimeKey: runtimeKey)
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("gui-boundary-" + UUID().uuidString, isDirectory: true)
        let storage = try GuiPluginPreviewStorage(directory: directory, connectionID: scope.hostID)
        _ = try storage.transact(["method": "set", "key": preferenceKey, "value": "[]"])
        let previousClipboard = UIPasteboard.general.items
        UIPasteboard.general.string = "gui-boundary-baseline"
        var rpcReads = 0, hostApprovals = 0
        var transport = ResourceWebPreviewTransport(readFile: { route, _ in try resource(route, kind: route.hasPrefix("/api/fs/serve/work/reports/") ? "absoluteHost" : "workspace") }, isCurrent: { true })
        transport.prepareLoopback = { value in
            guard value == "http://localhost:3000/" else { throw GuiPluginPreviewFailure.invalid }
            return ResourceWebPreviewProxy(basePath: "/api/preview/proxy/" + String(repeating: "a", count: 32), expiresAt: Date().addingTimeInterval(120), read: { route, _ in try resource(route, kind: "loopback") })
        }
        let bridge = GuiPluginPreviewBridge(controller: controller, capture: { expected in
            guard expected == scope else { throw GuiPluginPreviewFailure.stale }
            var capture = GuiPluginPreviewCapture(expectedHost: scope, isCurrent: { $0 == scope }, resource: transport, readAsset: { path, _ in
                guard path == GuiPluginPreviewScope.entry else { throw GuiPluginPreviewFailure.invalid }
                return ResourceWebPreviewResponse(status: 200, mime: "text/html", data: Data(rootHTML.utf8))
            })
            capture.storage = storage
            capture.isHostResourceURL = { url in
                guard url.scheme == "https", url.host == "fixture-host.invalid", (url.port ?? 443) == 443 else { return false }
                hostApprovals += 1; return true
            }
            capture.readGui = { expected, request, _ in
                guard expected == scope, request.route == "/api/rpc/boundary/probe" else { throw GuiPluginPreviewFailure.invalid }
                rpcReads += 1
                return GuiPluginPreviewResponse(status: 200, mime: "application/json", data: Data("{}".utf8))
            }
            return capture
        })
        let labels = ["loading": "loading", "failed": "failed", "back": "back", "close": "close", "retry": "retry", "source": "source", "preview": "preview"]
        let context: [String: Any] = ["runtimeKey": runtimeKey, "preferenceKey": preferenceKey, "locale": "en", "mode": "light", "themeCSS": ":root{--foreground:#212121}", "labels": labels]
        let presentation = Task { try await bridge.present(["directory": "/work", "path": "/work/report.html", "expectedHost": scope.publicValue, "owner": owner, "context": context]) }
        let evidence = Evidence()
        var testedWeb: WKWebView?
        defer {
            testedWeb?.configuration.userContentController.removeScriptMessageHandler(forName: "guiBoundaryResult")
            bridge.invalidate(); presentation.cancel(); UIPasteboard.general.items = previousClipboard
            try? FileManager.default.removeItem(at: directory)
        }
        let deadline = Date().addingTimeInterval(20)
        while Date() < deadline {
            if let view = controller.presentedViewController?.view, let web = findWeb(view), web.window != nil { testedWeb = web; break }
            try await Task.sleep(nanoseconds: 50_000_000)
        }
        guard let web = testedWeb else { throw Failure.timeout }
        web.configuration.userContentController.add(evidence, name: "guiBoundaryResult")
        let rawProof = try await web.callAsyncJavaScript(#"""
        if (!window.fixtureReady) throw Error('root not ready');
        const channel=window.webkit.messageHandlers.guiPluginPreview,expectedHost=admittedScope;
        const proof={bootstrap:false,device:false,storage:false,rpc:false};
        const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
        const sameScope=value=>object(value)&&value.hostID===admittedScope.hostID&&value.lease===admittedScope.lease;
        proof.cachedScopeMatched=sameScope(window.fixtureScope);
        try {
          const bootstrap=await channel.postMessage({name:'bootstrap'});
          proof.bootstrapReplyReceived=object(bootstrap);
          proof.bootstrapRuntimeKeyMatched=object(bootstrap)&&bootstrap.runtimeKey===expectedRuntimeKey;
          proof.bootstrapPreferenceKeyMatched=object(bootstrap)&&bootstrap.preferenceKey===expectedPreferenceKey;
          proof.bootstrapScopeMatched=object(bootstrap)&&object(bootstrap.intent)&&sameScope(bootstrap.intent.expectedHost);
          proof.bootstrap=proof.bootstrapReplyReceived&&proof.bootstrapRuntimeKeyMatched&&proof.bootstrapPreferenceKeyMatched&&proof.bootstrapScopeMatched&&proof.cachedScopeMatched;
        } catch { proof.bootstrapRejected=true; }
        try {
          const device=await channel.postMessage({name:'device',expectedHost,method:'capabilities',input:{}});
          proof.deviceReplyReceived=object(device);
          proof.deviceEnvelopeBoolean=object(device)&&typeof device.ok==='boolean';
          proof.deviceEnvelopeOK=object(device)&&device.ok===true;
          proof.deviceCapabilitiesVersionMatched=object(device)&&object(device.value)&&device.value.version===1;
          proof.devicePDFMatched=object(device)&&object(device.value)&&device.value.exportPDF===true;
          proof.deviceLongImageMatched=object(device)&&object(device.value)&&device.value.exportLongImage===true;
          proof.device=proof.deviceEnvelopeBoolean&&proof.deviceEnvelopeOK&&proof.deviceCapabilitiesVersionMatched&&proof.devicePDFMatched&&proof.deviceLongImageMatched;
        } catch { proof.deviceRejected=true; }
        try {
          const text=window.prompt('yuri.gui.storage.v1',JSON.stringify({expectedHost,operation:{method:'get',key:expectedPreferenceKey}}));
          proof.storagePromptReturned=typeof text==='string';
          const stored=typeof text==='string'?JSON.parse(text):null;
          proof.storageJSONParsed=object(stored);
          proof.storageEnvelopeBoolean=object(stored)&&typeof stored.ok==='boolean';
          proof.storageEnvelopeOK=object(stored)&&stored.ok===true;
          proof.storageValueMatched=object(stored)&&typeof stored.value==='string'&&stored.value==='[]';
          proof.storage=proof.storagePromptReturned&&proof.storageJSONParsed&&proof.storageEnvelopeBoolean&&proof.storageEnvelopeOK&&proof.storageValueMatched;
        } catch { proof.storageRejected=true; }
        try {
          const rpc=await channel.postMessage({name:'request',expectedHost,id:'901',input:{method:'POST',route:'/api/rpc/boundary/probe',headers:{'content-type':'application/json'},body:'{"input":{"legitimate":true}}'}});
          proof.rpcReplyReceived=object(rpc);
          proof.rpcStatusMatched=object(rpc)&&rpc.status===200;
          proof.rpcMimeMatched=object(rpc)&&typeof rpc.mime==='string'&&rpc.mime.split(';')[0]==='application/json';
          proof.rpcBodyMatched=object(rpc)&&rpc.base64==='e30=';
          proof.rpc=proof.rpcStatusMatched&&proof.rpcMimeMatched&&proof.rpcBodyMatched;
        } catch { proof.rpcRejected=true; }
        return JSON.stringify(proof);
        """#, arguments: ["admittedScope": scope.publicValue, "expectedRuntimeKey": runtimeKey, "expectedPreferenceKey": preferenceKey], in: nil, contentWorld: .page)
        onRootResultType?(rawProof.map { String(reflecting: type(of: $0)) } ?? "nil")
        let rootJSON = rawProof as? String
        let parsed = rootJSON?.data(using: .utf8).flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Bool] }
        var proof = parsed ?? [:]
        proof["resultString"] = rootJSON != nil; proof["resultDecoded"] = parsed != nil
        proof["resultPresent"] = rawProof != nil
        proof["nativeRPCObserved"] = rpcReads == 1
        proof["nativeStorageValueMatched"] = (try? storage.transact(["method": "get", "key": preferenceKey]) as? String) == "[]"
        proof["rpc"] = proof["rpc"] == true && proof["nativeRPCObserved"] == true
        proof["storage"] = proof["storage"] == true && proof["nativeStorageValueMatched"] == true
        onRootProof?(proof)
        guard proof["resultDecoded"] == true, proof["device"] == true, proof["storage"] == true, proof["bootstrap"] == true, proof["rpc"] == true else { throw Failure.rootBridge }
        _ = try await web.callAsyncJavaScript("window.startFixtureChildren()", arguments: [:], in: nil, contentWorld: .page)
        let cases = ["workspace", "loopback", "absoluteHost", "workspace-nested", "loopback-nested", "absoluteHost-nested"]
        while Date() < deadline, !cases.allSatisfy({ evidence.rows[$0] != nil }) { try await Task.sleep(nanoseconds: 50_000_000) }
        guard cases.allSatisfy({ evidence.rows[$0] != nil }) else { throw Failure.timeout }
        for name in cases {
            let row = evidence.rows[name]!
            for attack in ["parentEval", "parentFunction", "topEval", "topFunction"] {
                guard row[attack] as? String == "SecurityError" else { throw Failure.childBoundary(name + ":" + attack) }
            }
            for flag in ["script", "directBootstrap", "directDevice", "directRPC", "directStorage"] {
                guard row[flag] as? Bool == true else { throw Failure.childBoundary(name + ":" + flag) }
            }
            if !name.hasSuffix("-nested") {
                for flag in ["interaction", "classicScript", "moduleScript", "style", "resourceFetch"] {
                    guard row[flag] as? Bool == true else { throw Failure.childBoundary(name + ":" + flag) }
                }
            }
        }
        let escaped = try await web.callAsyncJavaScript("return window.fixtureEscaped || 0", arguments: [:], in: nil, contentWorld: .page) as? Int
        guard escaped == 0, UIPasteboard.general.string == "gui-boundary-baseline" else { throw Failure.escaped }
        guard try storage.transact(["method": "get", "key": preferenceKey]) as? String == "[]" else { throw Failure.storage }
        guard rpcReads == 1 else { throw Failure.rpc }
        guard hostApprovals >= 5 else { throw Failure.childBoundary("absoluteHost:capturedPredicate") }
        try await bridge.close(["expectedHost": scope.publicValue, "owner": owner]); _ = try? await presentation.value
        return ["status": "passed", "cases": cases, "rootBridge": true, "rootProof": proof, "rpcReads": rpcReads, "hostApprovals": hostApprovals, "clipboardUnchanged": true, "storageUnchanged": true]
    }
}
