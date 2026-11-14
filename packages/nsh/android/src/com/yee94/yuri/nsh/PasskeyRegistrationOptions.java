package com.yee94.yuri.nsh;

import java.net.URI;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

/**
 * Platform passkey creation options. Only discoverable ES256 platform credentials are accepted; the
 * bridge never pretends to configure security-key algorithms or extension semantics.
 */
public final class PasskeyRegistrationOptions {
    public final String rpID;
    public final byte[] challenge;
    public final byte[] userID;
    public final String name;
    public final List<byte[]> excluded;
    public final String verification;

    private PasskeyRegistrationOptions(String rpID, byte[] challenge, byte[] userID, String name,
                                       List<byte[]> excluded, String verification) {
        this.rpID = rpID;
        this.challenge = challenge;
        this.userID = userID;
        this.name = name;
        this.excluded = excluded;
        this.verification = verification;
    }

    public static PasskeyRegistrationOptions parse(Object input, URI origin, Set<String> associatedDomains)
            throws PasskeyFailure {
        Map<String, Object> value = NotificationJson.map(input);
        if (value == null) throw PasskeyFailure.invalid();
        Map<String, Object> rp = NotificationJson.map(value.get("rp"));
        Object rawRpID = rp == null ? null : rp.get("id");
        String host = origin == null ? null : origin.getHost();
        if (!(rawRpID instanceof String)) throw new PasskeyFailure(PasskeyFailure.RP);
        String rpID = (String) rawRpID;
        boolean secure = "https".equals(origin == null ? null : origin.getScheme());
        if (!secure || host == null || !host.toLowerCase(Locale.ROOT).equals(rpID.toLowerCase(Locale.ROOT))
                || rpID.contains(":") || rpID.isEmpty()) throw new PasskeyFailure(PasskeyFailure.RP);
        if (associatedDomains == null || !associatedDomains.contains("webcredentials:" + rpID.toLowerCase(Locale.ROOT))) {
            throw new PasskeyFailure(PasskeyFailure.ASSOCIATED_DOMAIN);
        }
        Map<String, Object> user = NotificationJson.map(value.get("user"));
        Object rawName = user == null ? null : user.get("name");
        if (!(rawName instanceof String) || ((String) rawName).isEmpty()) throw options();
        if (!(value.get("pubKeyCredParams") instanceof List)) throw options();
        boolean es256 = false;
        for (Object item : (List<?>) value.get("pubKeyCredParams")) {
            Map<String, Object> param = NotificationJson.map(item);
            if (param == null) continue;
            if ("public-key".equals(param.get("type")) && param.get("alg") instanceof Number
                    && ((Number) param.get("alg")).intValue() == -7) es256 = true;
        }
        if (!es256) throw options();
        if (value.containsKey("authenticatorSelection") && !(value.get("authenticatorSelection") instanceof Map)) throw options();
        if (value.containsKey("extensions") && !(value.get("extensions") instanceof Map)) throw options();
        Map<String, Object> selection = NotificationJson.map(value.get("authenticatorSelection"));
        if (selection == null) selection = new java.util.LinkedHashMap<>();
        Object attachment = selection.get("authenticatorAttachment");
        if (attachment != null && !"platform".equals(attachment)) throw options();
        Object attestation = value.get("attestation");
        if (attestation != null && !"none".equals(attestation)) throw options();
        Object extensions = value.get("extensions");
        if (extensions instanceof Map && !((Map<?, ?>) extensions).isEmpty()) throw options();
        Object residentKey = selection.get("residentKey");
        if (residentKey != null && !"required".equals(residentKey) && !"preferred".equals(residentKey)
                && !"discouraged".equals(residentKey)) throw options();
        Object rawVerification = selection.get("userVerification");
        String verification = rawVerification == null ? "preferred" : String.valueOf(rawVerification);
        if (!"required".equals(verification) && !"preferred".equals(verification) && !"discouraged".equals(verification)) {
            throw options();
        }
        List<byte[]> excluded = new ArrayList<>();
        if (value.containsKey("excludeCredentials") && value.get("excludeCredentials") != null) {
            if (!(value.get("excludeCredentials") instanceof List)) throw PasskeyFailure.invalid();
            for (Object item : (List<?>) value.get("excludeCredentials")) {
                Map<String, Object> descriptor = NotificationJson.map(item);
                if (descriptor == null || !"public-key".equals(descriptor.get("type"))) throw PasskeyFailure.invalid();
                excluded.add(PasskeyWire.decode(descriptor.get("id")));
            }
        }
        byte[] challenge = PasskeyWire.decode(value.get("challenge"));
        byte[] userID = PasskeyWire.decode(user == null ? null : user.get("id"));
        if (userID.length > 64) throw PasskeyFailure.invalid();
        return new PasskeyRegistrationOptions(rpID, challenge, userID, (String) rawName, excluded, verification);
    }

    private static PasskeyFailure options() { return new PasskeyFailure(PasskeyFailure.OPTIONS); }
}
