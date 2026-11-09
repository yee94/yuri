import Foundation

private final class Editor {
    var marked = false, reads = 0
}
private final class WeakEditor {
    weak var value: Editor?
    init(_ value: Editor?) { self.value = value }
}

@main private enum ProbeChecks {
    static func main() throws {
        var count = 0
        func check(_ name: String, _ body: () throws -> Void) rethrows { try body(); count += 1; print("PASS \(name)") }
        func read(_ editor: Editor) -> ComposerProbeFacts {
            editor.reads += 1
            return ComposerProbeFacts(spellCheckingName: "yes", spellCheckingRawValue: 2, markedTextPresent: editor.marked, attached: true, firstResponder: false)
        }
        func capture(_ ledger: ComposerProbeLedger<Editor>, _ editor: Editor?, _ generation: Int = 1) {
            ledger.capture(editor: editor, generation: generation, step: .readback, state: "active", registrationAttached: true,
                requestedHostRevision: 0, adoptedHostRevision: 0, read: read)
        }
        check("disabled means no samples, no identity capture, no editor reads") {
            let ledger = ComposerProbeLedger<Editor>(enabled: false), editor = Editor()
            capture(ledger, editor); precondition(ledger.samples.isEmpty && editor.reads == 0)
        }
        check("same exact editor keeps its token across synthetic Host and marked text states") {
            let ledger = ComposerProbeLedger<Editor>(enabled: true), editor = Editor()
            capture(ledger, editor); editor.marked = true; capture(ledger, editor)
            ledger.capture(editor: editor, generation: 1, step: .hostChanged, state: "active", registrationAttached: true,
                requestedHostRevision: 1, adoptedHostRevision: 1, read: read)
            precondition(Set(ledger.samples.compactMap(\.editorToken)).count == 1)
            precondition(ledger.samples[1].facts!.markedTextPresent && ledger.samples[2].adoptedHostRevision == 1)
        }
        check("unresolved pair never returns cached facts or token as authoritative") {
            let ledger = ComposerProbeLedger<Editor>(enabled: true), editor = Editor()
            capture(ledger, editor); capture(ledger, nil)
            precondition(!ledger.samples[1].paired && ledger.samples[1].facts == nil && ledger.samples[1].editorToken == nil)
        }
        check("replacement receives a different token; generation is the fixture mount generation") {
            let ledger = ComposerProbeLedger<Editor>(enabled: true), old = Editor(), new = Editor()
            capture(ledger, old); capture(ledger, new, 2)
            precondition(ledger.samples[0].editorToken != ledger.samples[1].editorToken && ledger.samples[1].composerGeneration == 2)
        }
        check("tokens and metadata never keep an editor alive") {
            let ledger = ComposerProbeLedger<Editor>(enabled: true)
            var editor: Editor? = Editor(); let weak = WeakEditor(editor)
            capture(ledger, editor); editor = nil
            precondition(weak.value == nil); capture(ledger, nil)
        }
        check("samples have a hard 128 entry bound and monotonic sequence") {
            let ledger = ComposerProbeLedger<Editor>(enabled: true), editor = Editor()
            for _ in 0..<500 { capture(ledger, editor) }
            precondition(ledger.samples.count == 128 && ledger.samples.first!.sequence == 373 && ledger.samples.last!.sequence == 500)
        }
        try check("export schema is metadata-only and process-scoped; unknown steps are rejected") {
            let ledger = ComposerProbeLedger<Editor>(enabled: true), editor = Editor(); capture(ledger, editor)
            let data = try JSONEncoder().encode(ComposerProbeReport(schema: 2, processRunID: "process-1", buildRunID: "build-1", samples: ledger.samples, control: ComposerProbeControl().snapshot))
            let json = try JSONSerialization.jsonObject(with: data) as! [String: Any]
            precondition(Set(json.keys) == Set(["schema", "processRunID", "buildRunID", "samples", "control"]))
            let sample = (json["samples"] as! [[String: Any]])[0]
            let facts = sample["facts"] as! [String: Any]
            precondition(Set(facts.keys) == Set(["spellCheckingName", "spellCheckingRawValue", "markedTextPresent", "attached", "firstResponder"]))
            precondition(ComposerProbeStep(rawValue: "arbitrary user text") == nil)
            precondition(ComposerProbeStep.manual("editingChange") == nil && ComposerProbeStep.manual("background") == nil)
            precondition(ComposerProbeStep.manual("ime") == .ime)
        }
        try check("SDK JSON Foundation callback must enter before native adoption, followed by an exact JS confirmation") {
            let control = ComposerProbeControl(); precondition(control.request() == 1)
            precondition(control.adoptedHostRevision == 0 && control.snapshot.nativeHandlerCalls == 0)
            let payload = try JSONSerialization.jsonObject(with: Data("{\"revision\":1}".utf8))
            let reply = control.acknowledge(payload)
            precondition(reply["accepted"] as? Bool == true && reply["revision"] as? Int == 1)
            precondition(control.snapshot.nativeHandlerCalls == 1 && control.snapshot.lastRawInputKind == "object")
            precondition(control.adoptedHostRevision == 1 && control.jsConfirmedHostRevision == 0)
            precondition(control.status(["revision": 1, "phase": "accepted", "code": "none"]))
            precondition(control.jsConfirmedHostRevision == 1)
        }
        check("visual or requested revision and a fabricated JS accepted status cannot fake native ACK") {
            let control = ComposerProbeControl(); _ = control.request()
            precondition(control.status(["revision": 1, "phase": "pending", "code": "none"]))
            precondition(!control.status(["revision": 1, "phase": "accepted", "code": "none"]))
            precondition(control.adoptedHostRevision == 0 && control.jsConfirmedHostRevision == 0 && control.snapshot.nativeHandlerCalls == 0)
            _ = control.request()
            precondition(control.acknowledge(["revision": 1])["accepted"] as? Bool == false)
            precondition(control.adoptedHostRevision == 0 && control.snapshot.rejectedHandlerCalls == 1)
        }
        check("exact payload rejects wrapper, string, boolean, fraction, missing and extra fields without adopting requested") {
            let control = ComposerProbeControl(); _ = control.request()
            let invalid: [Any] = [["args": ["revision": 1]], "{\"revision\":1}", ["revision": true], ["revision": 1.5], ["revision": "1"], ["revision": 1, "extra": true], [:], NSNull()]
            for input in invalid { precondition(control.acknowledge(input)["accepted"] as? Bool == false) }
            precondition(control.adoptedHostRevision == 0 && control.snapshot.rejectedHandlerCalls == invalid.count)
        }
        try check("errors expose bounded fixed codes and counts, never arbitrary runtime error text or payload keys") {
            let control = ComposerProbeControl(); _ = control.request()
            for _ in 0..<50 { control.note(.runtimeError) }
            precondition(control.status(["revision": 1, "phase": "failed", "code": "ack_access_denied"]))
            precondition(!control.status(["revision": 1, "phase": "failed", "code": "private runtime content"]))
            let data = try JSONEncoder().encode(control.snapshot), string = String(decoding: data, as: UTF8.self)
            precondition(!string.contains("private runtime content") && control.snapshot.errors["runtime_error"] == 50)
            precondition(control.snapshot.errors.count <= ComposerProbeErrorCode.allCases.count && control.adoptedHostRevision == 0)
        }
        print("\(count) probe ledger checks passed")
    }
}
