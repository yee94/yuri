import Foundation

/// Test-only Foundation process; accepts synthetic JSON calls on stdin, never starts NSH/UIKit.
@main struct FeaturesPolicyCLI {
    static func main() throws {
        let input = try JSONSerialization.jsonObject(with: FileHandle.standardInput.readDataToEndOfFile()) as! [String: Any]
        let host = try FeaturesSyntheticHost(seed: input["seed"] as! [String: Any])
        var output: [[String: Any]] = []
        for call in input["calls"] as! [[String: Any]] {
            do { output.append(["value": try host.call(call["name"] as! String, call["input"])]) }
            catch { output.append(["error": error.localizedDescription]) }
        }
        print(try FeaturesSyntheticHost.json(output))
    }
}
