package com.yee94.yuri.nsh;

/**
 * Android font capability (iOS NativeFontRegistry.swift).
 *
 * The catalog is the same Fontsource WOFF2 snapshot, but android.graphics has
 * no process-wide registration API for app-private font files: Typeface
 * .createFromFile produces a typeface object that NSH's family-name theme
 * tokens cannot reach, and WOFF2 is not a Typeface format. Applying a
 * downloaded App face would therefore silently fall back. This registry
 * reports `unsupported` for every non-system family (the same failure shape as
 * iOS's NativeFontFailure.unsupported) instead of claiming success.
 */
public final class NativeFontRegistry {
    public static final class RegisteredFont {
        public final String family;
        public final String identity;

        RegisteredFont(String family, String identity) {
            this.family = family;
            this.identity = identity;
        }
    }

    /** Immutable catalog bytes never become a process registration on Android. */
    public RegisteredFont cached(NativeFontCatalog.Definition definition) {
        return null;
    }

    public RegisteredFont load(NativeFontCatalog.Definition definition, java.util.function.BooleanSupplier authorized) {
        if (!authorized.getAsBoolean()) return null;
        throw new Unsupported();
    }

    public String bundledMono() {
        return null;
    }

    public static final class Unsupported extends RuntimeException {
        Unsupported() {
            super("font_unsupported", null, false, false);
        }
    }
}
