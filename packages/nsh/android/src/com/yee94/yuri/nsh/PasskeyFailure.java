package com.yee94.yuri.nsh;

/**
 * Passkey failures; the codes are the strings iOS PasskeyFailure throws, so JS sees the same
 * reject values on both platforms. Android-only codes are called out where they are raised.
 */
public final class PasskeyFailure extends Exception {
    private static final long serialVersionUID = 1L;

    public static final String INVALID = "passkey_invalid_request";
    public static final String LOCKED = "passkey_management_scope_locked";
    public static final String SESSION = "passkey_full_ui_session_required";
    public static final String RP = "passkey_rp_must_match_https_host";
    public static final String ASSOCIATED_DOMAIN = "passkey_associated_domain_required";
    public static final String OPTIONS = "passkey_options_not_supported";
    public static final String PRESENTATION = "passkey_presentation_unavailable";
    public static final String CANCELLED = "passkey_cancelled";
    public static final String BUSY = "passkey_ceremony_busy";
    public static final String RESPONSE = "passkey_invalid_host_response";
    public static final String RESET = "passkey_reset_ack_required";
    public static final String CLEANUP = "passkey_authorization_cleanup_pending";
    /** iOS gates registration on 17.4; Android has no system WebAuthn provider before API 34. */
    public static final String SYSTEM_VERSION = "passkey_registration_requires_android_14";
    /** The runtime lease does not expose a full-UI management transport (see PasskeyTransportSource). */
    public static final String UNSUPPORTED = "passkey_unsupported_on_this_host";

    public final String code;

    public PasskeyFailure(String code) {
        super(code);
        this.code = code;
    }

    public static PasskeyFailure invalid() { return new PasskeyFailure(INVALID); }
    public static PasskeyFailure cancelled() { return new PasskeyFailure(CANCELLED); }
    public static PasskeyFailure presentation() { return new PasskeyFailure(PRESENTATION); }
    public static PasskeyFailure unavailable() { return new PasskeyFailure(UNSUPPORTED); }

    /** Mirrors PasskeySystemFailure: the platform error code is appended, never a secret. */
    public static PasskeyFailure system(int code) {
        return new PasskeyFailure("passkey_system_authorization_failed_" + code);
    }

    public static PasskeyFailure systemType(String type) {
        return new PasskeyFailure("passkey_system_authorization_failed_" + (type == null ? "unknown" : type));
    }
}
