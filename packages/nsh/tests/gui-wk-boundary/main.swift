import Foundation
import UIKit
import CryptoKit

private struct BoundaryBuild: Decodable {
    let schema: Int
    let buildID: String
    let bundleID: String
    let sourceHash: String
    let profile: String
    let expectedCases: [String]
}

@MainActor private final class BoundaryController: UIViewController {
    private let status = UILabel()
    private var started = false
    private let runID = UUID().uuidString
    private let startedAt = Date()
    private var build: BoundaryBuild?
    private var rootProof: [String: Bool] = [:]
    private var rootResultType = "not-observed"

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        status.text = "GUI WK BOUNDARY\nWAITING FOR ACTIVE WINDOW"
        status.textColor = .label; status.numberOfLines = 0; status.textAlignment = .center
        status.font = .preferredFont(forTextStyle: .title2); status.accessibilityIdentifier = "gui-wk-boundary-result"
        status.translatesAutoresizingMaskIntoConstraints = false; view.addSubview(status)
        NSLayoutConstraint.activate([
            status.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor, constant: 20),
            status.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor, constant: -20),
            status.centerYAnchor.constraint(equalTo: view.safeAreaLayoutGuide.centerYAnchor)
        ])
    }
    override func viewDidAppear(_ animated: Bool) { super.viewDidAppear(animated); beginIfReady() }

    private func loadBuild() throws -> BoundaryBuild {
        guard let metadata = Bundle.main.url(forResource: "build", withExtension: "json"),
              let sources = Bundle.main.url(forResource: "source-manifest", withExtension: "json") else { throw SetupFailure.missingManifest }
        let value = try JSONDecoder().decode(BoundaryBuild.self, from: Data(contentsOf: metadata))
        let sourceHash = SHA256.hash(data: try Data(contentsOf: sources)).map { String(format: "%02x", $0) }.joined()
        let cases = ["workspace", "loopback", "absoluteHost", "workspace-nested", "loopback-nested", "absoluteHost-nested"]
        guard value.schema == 1, value.profile == "strict-production-gui-capture",
              value.buildID.range(of: "^run-[a-f0-9]{8}$", options: .regularExpression) != nil,
              value.bundleID == "example.nsh.gui-wk-boundary." + value.buildID,
              value.bundleID == Bundle.main.bundleIdentifier,
              value.sourceHash == sourceHash, value.expectedCases == cases else { throw SetupFailure.identityOrHash }
        return value
    }
    private enum SetupFailure: String, Error { case missingManifest = "build.missing-manifest", identityOrHash = "build.identity-or-source-hash", evidence = "fixture.invalid-evidence" }

    func beginIfReady() {
        guard !started, viewIfLoaded?.window != nil, UIApplication.shared.applicationState == .active else { return }
        started = true
        Task { @MainActor in
            do {
                do { build = try loadBuild() }
                catch let error as SetupFailure { throw error }
                catch { throw SetupFailure.identityOrHash }
                try writeReport(status: "invalid", failureCase: "run.incomplete", evidence: [:])
                status.text = "GUI WK BOUNDARY\nRUNNING\n" + build!.buildID
                let evidence = try await GuiPluginWKBoundaryFixture.run(in: self, onRootProof: { [weak self] in self?.rootProof = $0 }, onRootResultType: { [weak self] in self?.rootResultType = $0 })
                guard evidence["status"] as? String == "passed", evidence["cases"] as? [String] == build!.expectedCases,
                      evidence["rootBridge"] as? Bool == true, evidence["clipboardUnchanged"] as? Bool == true,
                      evidence["storageUnchanged"] as? Bool == true, evidence["rpcReads"] as? Int == 1,
                      (evidence["hostApprovals"] as? Int ?? 0) >= 5 else { throw SetupFailure.evidence }
                finish(status: "success", failureCase: nil, evidence: evidence)
            } catch let error as SetupFailure {
                finish(status: "invalid", failureCase: error.rawValue, evidence: [:])
            } catch let error as GuiPluginWKBoundaryFixture.Failure {
                let failureCase: String
                var failureStatus = "failed"
                switch error {
                case .unattached: failureCase = "fixture.unattached"; failureStatus = "invalid"
                case .timeout: failureCase = "fixture.timeout"
                case .rootBridge:
                    if rootProof["resultString"] != true { failureCase = "fixture.root-bridge.result-string" }
                    else if rootProof["resultDecoded"] != true { failureCase = "fixture.root-bridge.result-decode" }
                    else {
                        let failed = ["bootstrap", "device", "storage", "rpc"].first { rootProof[$0] != true } ?? "unknown"
                        failureCase = "fixture.root-bridge." + failed
                    }
                case .childBoundary(let detail): failureCase = "fixture.child-boundary:" + detail
                case .escaped: failureCase = "fixture.escaped-or-clipboard-changed"
                case .storage: failureCase = "fixture.storage-changed"
                case .rpc: failureCase = "fixture.unexpected-rpc"
                }
                finish(status: failureStatus, failureCase: failureCase, evidence: [:])
            } catch {
                let native = error as NSError
                finish(status: "failed", failureCase: "fixture.error", evidence: ["errorDomain": native.domain, "errorCode": native.code])
            }
        }
    }
    private func writeReport(status: String, failureCase: String?, evidence: [String: Any]) throws {
        let document = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        try FileManager.default.createDirectory(at: document, withIntermediateDirectories: true)
        let report: [String: Any] = [
            "schema": 1, "status": status, "failureCase": failureCase.map { $0 as Any } ?? NSNull(),
            "buildID": build.map { $0.buildID as Any } ?? NSNull(), "bundleID": Bundle.main.bundleIdentifier.map { $0 as Any } ?? NSNull(),
            "sourceHash": build.map { $0.sourceHash as Any } ?? NSNull(), "runID": runID,
            "startedAt": ISO8601DateFormatter().string(from: startedAt), "updatedAt": ISO8601DateFormatter().string(from: Date()),
            "evidence": evidence, "rootProof": rootProof, "rootResultType": rootResultType, "profile": "strict-production-gui-capture",
            "network": false, "keychain": false, "nshEngine": false
        ]
        let bytes = try JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys])
        try bytes.write(to: document.appendingPathComponent("result.json"), options: [.atomic, .completeFileProtection])
    }
    private func finish(status value: String, failureCase: String?, evidence: [String: Any]) {
        do {
            try writeReport(status: value, failureCase: failureCase, evidence: evidence)
            status.textColor = value == "success" ? .systemGreen : .systemRed
            status.text = (value == "success" ? "PASS" : "FAIL · " + value.uppercased()) + "\nGUI WK BOUNDARY\n" + (build?.buildID ?? "unidentified build") + "\n" + (failureCase ?? "all six WK cases passed") + "\nDocuments/result.json\n" + (build?.sourceHash ?? "no verified source hash")
            print("GUI_WK_BOUNDARY_RESULT", value, build?.buildID ?? "invalid", failureCase ?? "none")
        } catch {
            status.textColor = .systemRed; status.text = "FAIL · INVALID\nreport.write\nNo persisted success evidence"
            print("GUI_WK_BOUNDARY_RESULT invalid report.write")
        }
    }
}

@MainActor private final class BoundaryAppDelegate: UIResponder, UIApplicationDelegate {
    var window: UIWindow?
    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        let window = UIWindow(frame: UIScreen.main.bounds)
        window.rootViewController = BoundaryController(); self.window = window; window.makeKeyAndVisible(); return true
    }
    func applicationDidBecomeActive(_ application: UIApplication) { (window?.rootViewController as? BoundaryController)?.beginIfReady() }
}

UIApplicationMain(CommandLine.argc, CommandLine.unsafeArgv, nil, NSStringFromClass(BoundaryAppDelegate.self))
