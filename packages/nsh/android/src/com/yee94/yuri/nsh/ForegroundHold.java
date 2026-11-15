package com.yee94.yuri.nsh;

import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * A system picker covers MainActivity (onPause) while the app is still the one asking, which
 * iOS never reports as background. While a hold is open, onPause does not retire the Host
 * lease or cancel the picker session; the hold ends with the picker's activity result.
 */
final class ForegroundHold {
    private static final AtomicInteger OPEN = new AtomicInteger();

    private ForegroundHold() {}

    static boolean held() { return OPEN.get() > 0; }

    /** Each hold releases at most once, however many paths try. */
    static final class Token {
        private final AtomicBoolean open = new AtomicBoolean(true);

        Token() { OPEN.incrementAndGet(); }

        void release() {
            if (open.compareAndSet(true, false)) OPEN.decrementAndGet();
        }
    }
}
