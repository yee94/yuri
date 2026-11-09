import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { expect, it } from 'vitest';

const root = path.dirname(fileURLToPath(import.meta.url));
const sources = ['RuntimeHostScope.swift', 'ResourceWebPreviewBridge.swift', 'ResourceWebPreviewView.swift', 'GuiPluginPreviewBridge.swift', 'GuiPluginResourceResolver.swift', 'GuiPluginDeviceBridge.swift'].map(file => path.join(root, 'ios', file));
it.skipIf(process.platform !== 'darwin')('production resource resolver reuses exact file/preview transport and device policy rejects before effects', () => {
  const directory = mkdtempSync(path.join(process.env.OPENCODE_TMP_DIR || tmpdir(), 'gui-capabilities-'));
  try {
    const source = path.join(directory, 'Fixture.swift'), binary = path.join(directory, 'fixture');
    const renderer = readFileSync(path.join(root, '../mobile/ios/App/App/YuriViewExportRenderer.swift'), 'utf8');
    const requestTypes = renderer.slice(renderer.indexOf('struct YuriViewExportError'), renderer.indexOf('/// A task-owned renderer'));
    writeFileSync(source, `import Foundation
${requestTypes}
@main struct Fixture {
 @MainActor static func main() async throws {
  let resource = ResourceWebPreviewResponse(status:200,mime:"text/html; charset=utf-8",data:Data("<script>test</script>".utf8),contentSecurityPolicy:"img-src data:")
  let resourceHeaders = GuiPluginPreviewScope.responseHeaders(resource,applicationDocument:false)
  let appHeaders = GuiPluginPreviewScope.responseHeaders(resource,applicationDocument:true)
  let resourcePolicy = resourceHeaders["Content-Security-Policy"]!
  precondition(resourcePolicy.contains("sandbox allow-scripts") && !resourcePolicy.contains("allow-same-origin"))
  precondition(resourcePolicy.contains("img-src data:") && resourcePolicy.contains("connect-src yuri-plugin:"))
  precondition(resourceHeaders["Access-Control-Allow-Origin"] == "*" && resourceHeaders["Access-Control-Allow-Credentials"] == nil)
  precondition(appHeaders["Content-Security-Policy"]!.contains("sandbox") == false && appHeaders["Access-Control-Allow-Origin"] == nil)
  let name = try GuiPluginDevicePolicy.filename("报告.html"), text = try GuiPluginDevicePolicy.text("原文")
  precondition(name == "报告.html" && text == "原文")
  for value in ["../x", "a/b", "a\\\\b", "", ".", ".."] { do { _ = try GuiPluginDevicePolicy.filename(value); fatalError("unsafe save name") } catch {} }
  for value in ["javascript:alert(1)", "file:///private/x", "https://user:pass@example.invalid", "http://localhost:3000"] { do { _ = try GuiPluginDevicePolicy.external(value); fatalError("unsafe external") } catch {} }
  let external = try GuiPluginDevicePolicy.external("https://example.invalid/path"), toast = try GuiPluginDevicePolicy.toast(["title":"literal <script>","persistent":true])
  precondition(external.scheme == "https" && toast.2)
  let keyA = try GuiPluginDevicePolicy.toastIdentity(owner:"plugin-A",input:["title":"same"])
  let keyAgain = try GuiPluginDevicePolicy.toastIdentity(owner:"plugin-A",input:["title":"same","variant":"default","duration":5000,"persistent":false])
  let keyB = try GuiPluginDevicePolicy.toastIdentity(owner:"plugin-B",input:["title":"same"])
  let titleNewline = try GuiPluginDevicePolicy.toastIdentity(owner:"plugin-A",input:["title":"a\\nb"])
  let described = try GuiPluginDevicePolicy.toastIdentity(owner:"plugin-A",input:["title":"a","description":"b"])
  precondition(keyA == keyAgain && keyA != keyB && titleNewline != described)
  do { _ = try GuiPluginDevicePolicy.toast(["title":"bad", "actions":[]]); fatalError("unsupported actions") } catch {}
  let snapshot: [String:Any] = ["html":"<p>静态 snapshot</p>","width":300,"height":900]
  let pdf = try YuriViewExportRequest(["taskId":"pdf-task","snapshot":snapshot,"filename":"report.pdf","pageSize":"a4"],pdf:true)
  let png = try YuriViewExportRequest(["taskId":"png-task","snapshot":snapshot,"filename":"report.png"],pdf:false)
  precondition(pdf.pdf && pdf.document.contains("script-src 'none'") && png.imageWidth == 600 && png.imageHeight == 1800)
  for bad in ["<script>bad</script>","<iframe src='http://localhost'></iframe>","<link href='https://external.invalid'>"] {
   do { _ = try YuriViewExportRequest(["taskId":"invalid","snapshot":["html":bad,"width":300,"height":900],"filename":"x"],pdf:true);fatalError("executable export") } catch {}
  }
  do { _ = try YuriViewExportRequest(["taskId":"invalid","snapshot":["html":"x","width":2048,"height":32768],"filename":"x"],pdf:false);fatalError("unbounded bitmap") } catch {}
  do { _ = try YuriViewExportRequest(["taskId":"invalid","snapshot":snapshot,"filename":"x","pageSize":"a4"],pdf:false);fatalError("PDF parameter on image") } catch {}
  var current = true, files: [String] = [], routes: [String] = [], headers: [[String:String]] = []
  let target = String(repeating:"a",count:32), token = String(repeating:"f",count:32)
  let transport = ResourceWebPreviewTransport.authorized(readFile: { route, limit in
   precondition(limit == ResourceWebPreviewScope.responseLimit); files.append(route)
   return ResourceWebPreviewResponse(status:200,mime:"image/svg+xml",data:Data("<svg/>".utf8))
  }, isCurrent:{current}, send:{ route, method, body, head, limit in
   routes.append(route);headers.append(head)
   if route == "/api/preview/targets" {
    precondition(method == "POST" && head["X-Yuri-Native-Preview"] == "1")
    let input = try JSONSerialization.jsonObject(with:body!) as! [String:Any]
    precondition(input["url"] as? String == "http://localhost:3000/" && input["allowExternal"] as? Bool == false)
    let json: [String:Any] = ["id":target,"proxyBasePath":"/api/preview/proxy/"+target,"previewToken":token,"expiresAt":Date().addingTimeInterval(120).timeIntervalSince1970*1000]
    return ResourceWebPreviewResponse(status:200,mime:"application/json",data:try JSONSerialization.data(withJSONObject:json))
   }
   precondition(method == "GET" && head["X-Yuri-Preview-Token"] == token && !route.contains(token))
   return ResourceWebPreviewResponse(status:200,mime:"text/html; charset=utf-8",data:Data("<p>real captured transport</p>".utf8))
  })
  let resolver = try GuiPluginResourceResolver(directory:"/work",transport:transport)
  _ = try await resolver.read(URL(string:"yuri-plugin://owner/__gui/files/work/图.svg".addingPercentEncoding(withAllowedCharacters:.urlFragmentAllowed)!)!,owner:"owner")
  precondition(files == ["/api/fs/serve/work/%E5%9B%BE.svg"])
  let hostURL = Data("https://actual-host.invalid".utf8).base64EncodedString().replacingOccurrences(of:"+",with:"-").replacingOccurrences(of:"/",with:"_").replacingOccurrences(of:"=",with:"")
  let absolute = URL(string:"yuri-plugin://owner/__gui/host/"+hostURL+"/api/fs/serve/work/reports/attack.html")!
  do { _ = try await resolver.read(absolute,owner:"owner");fatalError("guessed Host origin") } catch GuiPluginResourceFailure.hostIdentity {}
  var hostProofs: [String] = []
  let hostResolver = try GuiPluginResourceResolver(directory:"/work",transport:transport,isHostResourceURL:{url in hostProofs.append(url.absoluteString);return url.scheme == "https" && url.host == "actual-host.invalid"})
  _ = try await hostResolver.read(absolute,owner:"owner")
  precondition(files.last == "/api/fs/serve/work/reports/attack.html")
  for relative in ["safe.js","safe.mjs","safe.css","probe.txt"] {
   _ = try await hostResolver.read(URL(string:"./"+relative,relativeTo:absolute)!.absoluteURL,owner:"owner")
   precondition(files.last == "/api/fs/serve/work/reports/"+relative)
  }
  precondition(hostProofs.count == 5 && hostProofs.allSatisfy{$0.hasPrefix("https://actual-host.invalid/api/fs/serve/work/reports/")})
  for invalid in ["yuri-plugin://owner/__gui/host/"+hostURL+"/api/fs/serve/outside/file", "yuri-plugin://owner/__gui/host/"+hostURL+"/api/fs/serve/work/%252e%252e/file"] {
   do { _ = try await hostResolver.read(URL(string:invalid)!,owner:"owner");fatalError("Host mapping left workspace") } catch {}
  }
  let forgedHost = Data("https://unapproved.invalid".utf8).base64EncodedString().replacingOccurrences(of:"+",with:"-").replacingOccurrences(of:"/",with:"_").replacingOccurrences(of:"=",with:"")
  do { _ = try await hostResolver.read(URL(string:"yuri-plugin://owner/__gui/host/"+forgedHost+"/api/fs/serve/work/reports/safe.js")!,owner:"owner");fatalError("JS origin selected another Host") } catch {}
  for value in ["yuri-plugin://other/__gui/files/work/a", "yuri-plugin://owner/__gui/files/outside/a", "yuri-plugin://owner/__gui/files/work/%252e%252e/a", "yuri-plugin://owner/api/preview/proxy/unknown/a"] {
   do { _ = try await resolver.read(URL(string:value)!,owner:"owner");fatalError("out of scope resource") } catch {}
  }
  let encoded = Data("http://localhost:3000".utf8).base64EncodedString().replacingOccurrences(of:"+",with:"-").replacingOccurrences(of:"/",with:"_").replacingOccurrences(of:"=",with:"")
  let loopback = URL(string:"yuri-plugin://owner/__gui/loopback/"+encoded+"/page?q=ok")!
  _ = try await resolver.read(loopback,owner:"owner")
  _ = try await resolver.read(loopback,owner:"owner")
  _ = try await resolver.read(URL(string:"yuri-plugin://owner/api/preview/proxy/"+target+"/icon.svg")!,owner:"owner")
  precondition(routes.filter{$0 == "/api/preview/targets"}.count == 1)
  precondition(routes.contains("/api/preview/proxy/"+target+"/page?q=ok"))
  precondition(routes.allSatisfy{!$0.contains("token=")})
  current = false
  do { _ = try await resolver.read(loopback,owner:"owner"); fatalError("revoked Host read") } catch {}
  current = true; resolver.stop()
  do { _ = try await resolver.read(loopback,owner:"owner"); fatalError("retired read") } catch {}
  precondition(files.count == 6 && routes.count == 4)
  print("scoped GUI resources and device policy passed")
 }
}`);
    const compiled = spawnSync('xcrun', ['swiftc', '-swift-version', '5', '-parse-as-library', ...sources, source, '-o', binary], { encoding: 'utf8', timeout: 60000 });
    expect(compiled.status, compiled.stdout + compiled.stderr).toBe(0);
    const result = spawnSync(binary, [], { encoding: 'utf8', timeout: 10000 });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain('scoped GUI resources and device policy passed');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
it.skipIf(process.platform !== 'darwin')('GUI device integration and existing mobile renderer typecheck against the real iOS SDK without an engine', () => {
  const sdk = spawnSync('xcrun', ['--sdk', 'iphonesimulator', '--show-sdk-path'], { encoding: 'utf8' });
  expect(sdk.status, sdk.stderr).toBe(0);
  const result = spawnSync('xcrun', ['--sdk', 'iphonesimulator', 'swiftc', '-typecheck', '-swift-version', '5', '-target', 'arm64-apple-ios16.0-simulator', '-sdk', sdk.stdout.trim(), ...sources, path.join(root, '../mobile/ios/App/App/YuriViewExportRenderer.swift'), path.join(root, 'tests/gui-wk-boundary/GuiPluginWKBoundaryFixture.swift')], { encoding: 'utf8', timeout: 60000 });
  expect(result.status, result.stdout + result.stderr).toBe(0);
});
