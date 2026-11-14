# realtime-io JVM tests

Pure-logic checks for the Agent 4 Android bridges (`Terminal*`, `NativeTerminal*`,
`RemoteDesktop*`, `VoiceRecognition*`, `Speech*`). They need a JDK and the Android platform
`android.jar`; no device, emulator, Gradle or network.

```sh
sh packages/nsh/android/tests/realtime-io/run.sh
# ANDROID_JAR=/path/to/android-35/android.jar sh ... when the SDK lives elsewhere
```

| Test | Covers |
| --- | --- |
| `TerminalProtocolTest` | loopback URL admission, integral-number/identifier/directory/size validation, v2 control-frame encoding, canonical chrome JSON |
| `TerminalCatalogStoreTest` | metadata journal defaults, strict schema validation, remember/forget/contains, directory bound |
| `TerminalStreamInboxTest` | bounded message/byte queue, open order, failure vs end, receive deadline |
| `TerminalTransportTest` | `x-yuri-file-exists` preference, 404 fallback, text/plain + UTF-8 admission, bounded read, fixed failure codes |
| `VoiceRecognitionPayloadTest` | WAV container, RIFF chunk traversal, transcript limits, saved-settings authority, request admission |
| `SpeechPayloadTest` | speech settings allowlist/ranges, `x-speech-pitch`/`x-speech-volume` narrowing and range rejection, segment admission and source rules, unsupported `speech.awake` reply |
| `RemoteDesktopInputTest` | pointer/scroll clamping, text and key allowlists, rejection of unknown input |

`stub/com/longbridge/nsh` holds compile-only signatures of the `nsh.aar` API used when the
distribution is not built locally; it is never packaged.

Not covered here because it needs the AAR/device: `WebView` document admission, `AudioRecord`
permission and capture, `TextToSpeech`/`MediaPlayer` playback, `BitmapFactory` frame decoding,
`ConnectivityManager` reachability, and every Host exchange.
