import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

test('production Swift speech contracts reject stale scope, invalid settings/audio and preserve provider routes', () => {
  const directory = path.dirname(fileURLToPath(import.meta.url));
  const temporary = mkdtempSync(path.join(os.tmpdir(), 'nsh-speech-contract-'));
  try {
    const program = path.join(temporary, 'main.swift');
    writeFileSync(program, `import Foundation
func rejected(_ work: () throws -> Void) { do { try work(); fatalError("Expected contract rejection") } catch {} }
func settings(_ provider: String) throws -> NativeSpeechSettings {
  try NativeSpeechSettings(JSONSerialization.data(withJSONObject: ["voiceProvider": provider, "ttsInputMode": "sanitized", "showMessageTTSButtons": true, "speechRate": 1, "speechPitch": 1, "speechVolume": 0.8, "apiKey": "neutral-not-a-key"]))
}
let expected: [String: String] = ["local": "/api/dictation/tts/speak", "say": "/api/tts/say/speak", "openai": "/api/tts/speak", "openai-compatible": "/api/tts/speak", "volcengine": "/api/tts/speak"]
for (provider, route) in expected { let s = try settings(provider); precondition(s.route == route); precondition(s.publicValue["apiKey"] == nil) }
let browser = try settings("browser"); precondition(browser.route == nil)
rejected { _ = try settings("invented") }
rejected { _ = try NativeSpeechSettings(Data("{}".utf8)) }
let payload: [String: Any] = ["owner": "neutral-owner", "revision": 2, "text": "Neutral sentence."]
let segment = try NativeSpeechSegment(payload, owner: "neutral-owner", revision: 1); precondition(segment.revision == 2)
try segment.validatePlayback(visible: true, current: true, foreground: true)
rejected { try segment.validatePlayback(visible: false, current: true, foreground: true) }
let automatic = try NativeSpeechSegment(payload.merging(["source": "auto-read"]) { _, new in new }, owner: "neutral-owner", revision: 1)
try automatic.validatePlayback(visible: false, current: true, foreground: true)
rejected { try automatic.validatePlayback(visible: false, current: false, foreground: true) }
rejected { try automatic.validatePlayback(visible: false, current: true, foreground: false) }
let preview = try NativeSpeechSegment(payload.merging(["source": "settings-preview"]) { _, new in new }, owner: "neutral-owner", revision: 1)
try preview.validatePlayback(visible: false, current: true, foreground: true)
rejected { try preview.validatePlayback(visible: false, current: false, foreground: true) }
rejected { try preview.validatePlayback(visible: false, current: true, foreground: false) }
rejected { _ = try NativeSpeechSegment(payload.merging(["source": "invented"]) { _, new in new }, owner: "neutral-owner", revision: 1) }
rejected { _ = try NativeSpeechSegment(payload.merging(["source": true]) { _, new in new }, owner: "neutral-owner", revision: 1) }
rejected { _ = try NativeSpeechSegment(payload.merging(["token": "not-a-token"]) { _, new in new }, owner: "neutral-owner", revision: 1) }
rejected { _ = try NativeSpeechSegment(payload, owner: "another-owner", revision: 1) }
rejected { _ = try NativeSpeechSegment(payload, owner: "neutral-owner", revision: 2) }
rejected { _ = try NativeSpeechSegment(["owner": "neutral-owner", "revision": true, "text": "Neutral"], owner: "neutral-owner", revision: 0) }
rejected { _ = try NativeSpeechSegment(["owner": "neutral-owner", "revision": 3, "text": String(repeating: "x", count: 4097)], owner: "neutral-owner", revision: 0) }
let awakePayload: [String: Any] = ["owner": "neutral-owner", "revision": 1, "enabled": true]
let awake = try NativeSpeechAwakeRequest(awakePayload, owner: "neutral-owner", revision: 0)
let unsupported = try awake.response(current: true, foreground: true)
precondition(unsupported["supported"] as? Bool == false && unsupported["enabled"] as? Bool == false)
rejected { _ = try awake.response(current: false, foreground: true) }
rejected { _ = try awake.response(current: true, foreground: false) }
rejected { _ = try NativeSpeechAwakeRequest(awakePayload, owner: "another-owner", revision: 0) }
rejected { _ = try NativeSpeechAwakeRequest(awakePayload, owner: "neutral-owner", revision: 1) }
rejected { _ = try NativeSpeechAwakeRequest(awakePayload.merging(["enabled": 1]) { _, new in new }, owner: "neutral-owner", revision: 0) }
rejected { _ = try NativeSpeechAwakeRequest(awakePayload.merging(["revision": true]) { _, new in new }, owner: "neutral-owner", revision: 0) }
rejected { _ = try NativeSpeechAwakeRequest(awakePayload.merging(["extra": 1]) { _, new in new }, owner: "neutral-owner", revision: 0) }
let releaseAwake = try NativeSpeechAwakeRequest(["owner": "neutral-owner", "revision": 2, "enabled": false], owner: "neutral-owner", revision: 1)
let released = try releaseAwake.response(current: false, foreground: false)
precondition(released["enabled"] as? Bool == false)
let s = try settings("openai-compatible"), bytes = Data([1, 2, 3])
let audio = try NativeSpeechAudio(status: 200, mime: "audio/mpeg", data: bytes, pitch: "1.5", volume: "0.4", settings: s)
precondition(audio.pitch == 1.5 && audio.volume == 0.4)
rejected { _ = try NativeSpeechAudio(status: 500, mime: "audio/mpeg", data: bytes, pitch: nil, volume: nil, settings: s) }
rejected { _ = try NativeSpeechAudio(status: 200, mime: "application/json", data: bytes, pitch: nil, volume: nil, settings: s) }
rejected { _ = try NativeSpeechAudio(status: 200, mime: "audio/mpeg", data: Data(), pitch: nil, volume: nil, settings: s) }
rejected { _ = try NativeSpeechAudio(status: 200, mime: "audio/mpeg", data: bytes, pitch: "nan", volume: nil, settings: s) }
rejected { _ = try NativeSpeechAudio(status: 200, mime: "audio/mpeg", data: bytes, pitch: nil, volume: "9", settings: s) }
print("Speech contracts passed")
`);
    const binary = path.join(temporary, 'speech-contract');
    const compile = spawnSync('xcrun', ['swiftc', '-swift-version', '5', path.join(directory, 'ios/SpeechPlaybackBridge.swift'), program, '-o', binary], { encoding: 'utf8', timeout: 60000 });
    expect(compile.status, compile.stdout + compile.stderr).toBe(0);
    const result = spawnSync(binary, { encoding: 'utf8', timeout: 10000 });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain('Speech contracts passed');
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}, 90000);

test('captured transport remains fixed-route, bounded, authenticated and cancellation-owned', () => {
  const source = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'ios/RuntimeBridge.swift'), 'utf8');
  const speech = source.split('transport.speech =')[1].split('return transport')[0];
  for (const route of ['/api/voice/settings', '/api/tts/speak', '/api/tts/say/speak', '/api/dictation/tts/speak']) expect(speech).toContain(route);
  for (const guard of ['current()', '65536', '16 * 1024 * 1024', '4096', 'self.makeRequest', 'request.httpBody', 'self.tunnel(for: relay).stream', 'boundedBytes', 'onCancel: { task.cancel() }']) expect(speech).toContain(guard);
  expect(source).toContain('speechTasks.values.forEach { $0.cancel() }');
});

test('production speech applies the source-aware gate and exposes only same-owner guarded awake requests without a global idle-timer writer', () => {
  const source = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'ios/SpeechPlaybackBridge.swift'), 'utf8');
  expect(source).toContain('segment.validatePlayback(visible: settings.visible, current: transport.isCurrent(), foreground: UIApplication.shared.applicationState == .active)');
  expect(source).toContain('self.owner == capturedOwner && self.revision == next && transport.isCurrent() && UIApplication.shared.applicationState == .active');
  expect(source).toContain('app.handle("speech.awake")');
  expect(source).toContain('NativeSpeechAwakeRequest(input, owner: self.owner, revision: self.awakeRevision)');
  expect(source).toContain('self.settings != nil && self.transport?.isCurrent() == true');
  expect(source).toContain('UIApplication.willResignActiveNotification');
  expect(source).toContain('awakeRevision = 0; stop()');
  expect(source).not.toMatch(/UIApplication\.shared\.isIdleTimerDisabled\s*=/);
});
