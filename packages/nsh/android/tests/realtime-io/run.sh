#!/bin/sh
# JVM tests for the realtime-io Android bridges (no JUnit, no device, no network).
# Usage: sh packages/nsh/android/tests/realtime-io/run.sh
set -eu

ROOT=$(cd "$(dirname "$0")" && pwd)
ANDROID=${ANDROID_JAR:-/opt/homebrew/share/android-commandlinetools/platforms/android-35/android.jar}
SRC="$ROOT/../../src/com/yee94/yuri/nsh"
OUT=${TMPDIR:-/tmp}/yuri-realtime-io-tests

rm -rf "$OUT"
mkdir -p "$OUT"

STUBS="$ROOT/stub/com/longbridge/nsh/NshView.java $ROOT/stub/com/longbridge/nsh/NshHostReply.java"
SOURCES="$SRC/HostLease.java $SRC/HostLeaseProvider.java
 $SRC/TerminalFailure.java $SRC/TerminalJson.java $SRC/TerminalProtocol.java $SRC/TerminalCatalogStore.java
 $SRC/TerminalStreamInbox.java $SRC/TerminalTransport.java $SRC/TerminalBridge.java $SRC/NativeTerminalPreview.java
 $SRC/RemoteDesktopFailure.java $SRC/RemoteDesktopInbox.java $SRC/RemoteDesktopTransport.java $SRC/RemoteDesktopBridge.java
 $SRC/VoiceRecognitionFailure.java $SRC/VoiceRecognitionRuntime.java $SRC/VoiceRecognitionAudio.java
 $SRC/VoiceRecognitionTransport.java $SRC/VoiceRecognitionCore.java $SRC/VoiceRecognitionRecorder.java
 $SRC/VoiceRecognitionPermissions.java $SRC/VoiceRecognitionBridge.java
 $SRC/SpeechFailure.java $SRC/SpeechVoiceCatalogPolicy.java $SRC/SpeechPlaybackBridge.java
 $ROOT/Check.java $ROOT/TerminalProtocolTest.java $ROOT/TerminalCatalogStoreTest.java
 $ROOT/TerminalStreamInboxTest.java $ROOT/TerminalTransportTest.java $ROOT/VoiceRecognitionPayloadTest.java
 $ROOT/SpeechPayloadTest.java $ROOT/RemoteDesktopInputTest.java"

# shellcheck disable=SC2086
javac --release 17 -nowarn -cp "$ANDROID" -d "$OUT" $SOURCES $STUBS

for test in TerminalProtocolTest TerminalCatalogStoreTest TerminalStreamInboxTest TerminalTransportTest \
            VoiceRecognitionPayloadTest SpeechPayloadTest RemoteDesktopInputTest; do
  java -cp "$ANDROID:$OUT" "com.yee94.yuri.nsh.$test"
done
