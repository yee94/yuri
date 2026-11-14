package com.yee94.yuri.nsh;

/** Minimal assertion helper; these tests run on a plain JVM without JUnit. */
final class Check {
    private Check() {}

    static void equal(Object expected, Object actual, String label) {
        if (expected == null ? actual != null : !expected.equals(actual)) {
            throw new AssertionError(label + ": expected <" + expected + "> but was <" + actual + ">");
        }
    }

    static void isTrue(boolean value, String label) {
        if (!value) throw new AssertionError(label);
    }

    static void isFalse(boolean value, String label) {
        if (value) throw new AssertionError(label);
    }

    static void nullValue(Object value, String label) {
        if (value != null) throw new AssertionError(label + ": expected null but was <" + value + ">");
    }

    interface Action {
        void run() throws Exception;
    }

    static void failure(String expected, Action action, String label) {
        try {
            action.run();
        } catch (Exception error) {
            String code = null;
            if (error instanceof TerminalFailure) code = ((TerminalFailure) error).code;
            else if (error instanceof VoiceRecognitionFailure) code = ((VoiceRecognitionFailure) error).code;
            else if (error instanceof SpeechFailure) code = ((SpeechFailure) error).code;
            else if (error instanceof RemoteDesktopFailure) code = ((RemoteDesktopFailure) error).code;
            equal(expected, code, label);
            return;
        }
        throw new AssertionError(label + ": expected failure " + expected);
    }
}
