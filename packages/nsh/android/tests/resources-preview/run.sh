#!/bin/sh
# resources-preview JVM contract test; see README.md.
set -eu
cd "$(dirname "$0")/../.."
ANDROID_JAR=${ANDROID_JAR:-/opt/homebrew/share/android-commandlinetools/platforms/android-35/android.jar}
OUT=$(mktemp -d)
trap 'rm -rf "$OUT"' EXIT

javac --release 17 -d "$OUT/classes" -cp "$ANDROID_JAR" \
  tests/resources-preview/stubs/com/longbridge/nsh/*.java \
  src/com/yee94/yuri/nsh/HostLease.java src/com/yee94/yuri/nsh/HostLeaseProvider.java \
  src/com/yee94/yuri/nsh/RuntimeHostScope.java src/com/yee94/yuri/nsh/RuntimeHostScopeFailure.java \
  src/com/yee94/yuri/nsh/RuntimeHostText.java \
  src/com/yee94/yuri/nsh/Resource*.java src/com/yee94/yuri/nsh/GuiPlugin*.java \
  src/com/yee94/yuri/nsh/YuriViewExport*.java

javac --release 17 -d "$OUT/test" -cp "$OUT/classes:$ANDROID_JAR" \
  tests/resources-preview/ResourcesPreviewTest.java

java -cp "$OUT/test:$OUT/classes:$ANDROID_JAR" com.yee94.yuri.nsh.ResourcesPreviewTest
