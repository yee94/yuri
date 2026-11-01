import Cocoa
import ApplicationServices

if CommandLine.arguments.count == 2,
   ["--check-accessibility", "--request-accessibility"].contains(CommandLine.arguments[1]) {
    let prompt = CommandLine.arguments[1] == "--request-accessibility"
    let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: prompt] as CFDictionary
    print(AXIsProcessTrustedWithOptions(options) ? "granted" : "denied")
    exit(0)
}

guard CommandLine.arguments.count == 2, let displayID = UInt32(CommandLine.arguments[1]), AXIsProcessTrusted() else {
    print("permission_required"); fflush(stdout); exit(1)
}
let bounds = CGDisplayBounds(displayID)
let source = CGEventSource(stateID: .hidSystemState)
let keyCodes: [String: CGKeyCode] = ["Enter": 36, "Tab": 48, "Backspace": 51, "Escape": 53,
    "ArrowLeft": 123, "ArrowRight": 124, "ArrowDown": 125, "ArrowUp": 126,
    "Delete": 117, "Home": 115, "End": 119, "PageUp": 116, "PageDown": 121]
var held = false
var point = CGPoint(x: bounds.midX, y: bounds.midY)
var lastClickTime: TimeInterval = 0
var lastClickPoint = point
var clickCount: Int64 = 0
func mouse(_ type: CGEventType, _ button: CGMouseButton = .left, clicks: Int64 = 1) {
    if let event = CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: point, mouseButton: button) {
        event.setIntegerValueField(.mouseEventClickState, value: clicks)
        event.post(tap: .cghidEventTap)
    }
}
func release() {
    if held { mouse(.leftMouseUp); held = false }
}
print("ready"); fflush(stdout)
while let line = readLine() {
    if line.utf8.count > 8192 { break }
    guard AXIsProcessTrusted(), CGDisplayIsActive(displayID) != 0 else { break }
    guard let data = line.data(using: .utf8), let message = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let type = message["type"] as? String else { continue }
    switch type {
    case "pointer":
        guard let x = message["x"] as? Double, let y = message["y"] as? Double,
              x.isFinite, y.isFinite, (0...1).contains(x), (0...1).contains(y), let action = message["action"] as? String else { continue }
        point = CGPoint(x: bounds.minX + x * max(0, bounds.width - 1), y: bounds.minY + y * max(0, bounds.height - 1))
        switch action {
        case "down": mouse(.leftMouseDown); held = true
        case "up": release()
        case "move": mouse(held ? .leftMouseDragged : .mouseMoved)
        case "click":
            release()
            let now = ProcessInfo.processInfo.systemUptime
            let nearby = hypot(point.x - lastClickPoint.x, point.y - lastClickPoint.y) <= 5
            clickCount = nearby && now - lastClickTime < NSEvent.doubleClickInterval ? min(3, clickCount + 1) : 1
            lastClickTime = now; lastClickPoint = point
            mouse(.leftMouseDown, clicks: clickCount); mouse(.leftMouseUp, clicks: clickCount)
        case "right": release(); mouse(.rightMouseDown, .right); mouse(.rightMouseUp, .right)
        default: break
        }
    case "scroll":
        guard let dx = message["dx"] as? Double, let dy = message["dy"] as? Double, dx.isFinite, dy.isFinite else { continue }
        CGEvent(scrollWheelEvent2Source: source, units: .pixel, wheelCount: 2,
                wheel1: Int32(max(-1000, min(1000, -dy))), wheel2: Int32(max(-1000, min(1000, -dx))), wheel3: 0)?.post(tap: .cghidEventTap)
    case "key":
        guard let name = message["key"] as? String, let code = keyCodes[name] else { continue }
        CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: true)?.post(tap: .cghidEventTap)
        CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: false)?.post(tap: .cghidEventTap)
    case "text":
        guard let text = message["text"] as? String, text.utf16.count <= 1024 else { continue }
        let chars = Array(text.utf16)
        for down in [true, false] {
            if let event = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: down) {
                chars.withUnsafeBufferPointer { event.keyboardSetUnicodeString(stringLength: chars.count, unicodeString: $0.baseAddress) }
                event.post(tap: .cghidEventTap)
            }
        }
    case "release": release()
    default: break
    }
}
release()
