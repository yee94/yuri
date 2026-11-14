package com.yee94.yuri.nsh;

import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.security.KeyFactory;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.security.interfaces.ECPublicKey;
import java.security.spec.ECGenParameterSpec;
import java.security.spec.ECParameterSpec;
import java.security.spec.ECPoint;
import java.security.spec.ECPublicKeySpec;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.Map;

import javax.crypto.Cipher;
import javax.crypto.KeyAgreement;
import javax.crypto.Mac;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;

/**
 * Byte-compatible with the Relay's {@code lib/relay/crypto.ts}: ephemeral P-256 ECDH,
 * HKDF-SHA256 over the handshake nonce, then AES-256-GCM with a 4-byte prefix and a
 * big-endian 64-bit counter as the 12-byte nonce. Both directions get their own key.
 */
public final class RelayTunnelCrypto {
    private static final int MAX_PLAINTEXT = 65536;
    private static final String INFO = "yuri-relay-v1";
    private static final SecureRandom RANDOM = new SecureRandom();

    public final String hello;

    private final byte[] outgoing;
    private final byte[] incoming;
    private final byte[] prefix;
    private long sent;
    private long received;

    public RelayTunnelCrypto(ECPublicKey hostKey) throws RelayTunnelFailure {
        try {
            KeyPairGenerator generator = KeyPairGenerator.getInstance("EC");
            generator.initialize(new ECGenParameterSpec("secp256r1"), RANDOM);
            KeyPair ephemeral = generator.generateKeyPair();
            ECPublicKey publicKey = (ECPublicKey) ephemeral.getPublic();
            KeyAgreement agreement = KeyAgreement.getInstance("ECDH");
            agreement.init(ephemeral.getPrivate());
            agreement.doPhase(hostKey, true);
            byte[] secret = agreement.generateSecret();

            byte[] nonce = random(16);
            prefix = random(4);
            byte[] material = hkdf(secret, nonce, INFO.getBytes(StandardCharsets.UTF_8), 64);
            outgoing = Arrays.copyOfRange(material, 0, 32);
            incoming = Arrays.copyOfRange(material, 32, 64);

            Map<String, Object> clientKey = new LinkedHashMap<>();
            clientKey.put("kty", "EC");
            clientKey.put("crv", "P-256");
            clientKey.put("x", base64Url(unsigned(publicKey.getW().getAffineX(), 32)));
            clientKey.put("y", base64Url(unsigned(publicKey.getW().getAffineY(), 32)));
            Map<String, Object> helloValue = new LinkedHashMap<>();
            helloValue.put("t", "hello");
            helloValue.put("v", 1);
            helloValue.put("batch", Boolean.FALSE);
            helloValue.put("clientPubJwk", clientKey);
            helloValue.put("nonce", base64Url(nonce));
            hello = RuntimeBridgeJson.stringify(helloValue);
        } catch (RuntimeBridgeFailure failure) {
            throw new RelayTunnelFailure(RelayTunnelFailure.Kind.INVALID_CONFIGURATION);
        } catch (Exception failure) {
            throw new RelayTunnelFailure(RelayTunnelFailure.Kind.INVALID_CONFIGURATION);
        }
    }

    public static ECPublicKey importKey(Map<String, String> jwk) throws RelayTunnelFailure {
        if (jwk == null || !"EC".equals(jwk.get("kty")) || !"P-256".equals(jwk.get("crv"))) {
            throw new RelayTunnelFailure(RelayTunnelFailure.Kind.INVALID_CONFIGURATION);
        }
        byte[] x = decodeBase64Url(jwk.get("x"));
        byte[] y = decodeBase64Url(jwk.get("y"));
        if (x == null || y == null || x.length != 32 || y.length != 32) {
            throw new RelayTunnelFailure(RelayTunnelFailure.Kind.INVALID_CONFIGURATION);
        }
        try {
            ECParameterSpec parameters = p256();
            ECPoint point = new ECPoint(new BigInteger(1, x), new BigInteger(1, y));
            if (point.getAffineX().signum() < 0 || point.getAffineY().signum() < 0) {
                throw new RelayTunnelFailure(RelayTunnelFailure.Kind.INVALID_CONFIGURATION);
            }
            ECPublicKey key = (ECPublicKey) KeyFactory.getInstance("EC").generatePublic(new ECPublicKeySpec(point, parameters));
            return key;
        } catch (RelayTunnelFailure failure) {
            throw failure;
        } catch (Exception failure) {
            throw new RelayTunnelFailure(RelayTunnelFailure.Kind.INVALID_CONFIGURATION);
        }
    }

    private static ECParameterSpec p256() throws Exception {
        KeyPairGenerator generator = KeyPairGenerator.getInstance("EC");
        generator.initialize(new ECGenParameterSpec("secp256r1"));
        return ((ECPublicKey) generator.generateKeyPair().getPublic()).getParams();
    }

    public synchronized byte[] encrypt(byte[] plaintext) throws RelayTunnelFailure {
        if (plaintext.length > MAX_PLAINTEXT || sent == Long.MAX_VALUE) {
            throw new RelayTunnelFailure(RelayTunnelFailure.Kind.INVALID_FRAME);
        }
        sent += 1;
        try {
            byte[] iv = new byte[12];
            System.arraycopy(prefix, 0, iv, 0, 4);
            writeCounter(iv, 4, sent);
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, new SecretKeySpec(outgoing, "AES"), new GCMParameterSpec(128, iv));
            byte[] sealed = cipher.doFinal(plaintext);
            byte[] frame = new byte[1 + iv.length + sealed.length];
            frame[0] = 1;
            System.arraycopy(iv, 0, frame, 1, iv.length);
            System.arraycopy(sealed, 0, frame, 1 + iv.length, sealed.length);
            return frame;
        } catch (Exception failure) {
            throw new RelayTunnelFailure(RelayTunnelFailure.Kind.INVALID_FRAME);
        }
    }

    public synchronized byte[] decrypt(byte[] frame) throws RelayTunnelFailure {
        if (frame.length < 29 || frame.length > 65565 || frame[0] != 1) {
            throw new RelayTunnelFailure(RelayTunnelFailure.Kind.INVALID_FRAME);
        }
        long counter = readCounter(frame, 5);
        if (counter <= received) throw new RelayTunnelFailure(RelayTunnelFailure.Kind.INVALID_FRAME);
        try {
            byte[] iv = Arrays.copyOfRange(frame, 1, 13);
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, new SecretKeySpec(incoming, "AES"), new GCMParameterSpec(128, iv));
            byte[] plaintext = cipher.doFinal(frame, 13, frame.length - 13);
            received = counter;
            return plaintext;
        } catch (Exception failure) {
            throw new RelayTunnelFailure(RelayTunnelFailure.Kind.INVALID_FRAME);
        }
    }

    private static void writeCounter(byte[] target, int offset, long value) {
        for (int i = 0; i < 8; i++) target[offset + i] = (byte) (value >>> (8 * (7 - i)));
    }

    private static long readCounter(byte[] source, int offset) {
        long value = 0;
        for (int i = 0; i < 8; i++) value = (value << 8) | (source[offset + i] & 0xffL);
        return value;
    }

    private static byte[] hkdf(byte[] input, byte[] salt, byte[] info, int length) throws Exception {
        Mac mac = Mac.getInstance("HmacSHA256");
        mac.init(new SecretKeySpec(salt, "HmacSHA256"));
        byte[] pseudoRandom = mac.doFinal(input);
        byte[] output = new byte[length];
        byte[] block = new byte[0];
        int offset = 0;
        int counter = 1;
        while (offset < length) {
            mac.init(new SecretKeySpec(pseudoRandom, "HmacSHA256"));
            mac.update(block);
            mac.update(info);
            mac.update((byte) counter);
            block = mac.doFinal();
            int take = Math.min(block.length, length - offset);
            System.arraycopy(block, 0, output, offset, take);
            offset += take;
            counter++;
        }
        return output;
    }

    private static byte[] unsigned(BigInteger value, int length) {
        byte[] raw = value.toByteArray();
        if (raw.length == length) return raw;
        byte[] result = new byte[length];
        if (raw.length > length) {
            System.arraycopy(raw, raw.length - length, result, 0, length);
        } else {
            System.arraycopy(raw, 0, result, length - raw.length, raw.length);
        }
        return result;
    }

    private static byte[] random(int count) {
        byte[] value = new byte[count];
        RANDOM.nextBytes(value);
        return value;
    }

    static String base64Url(byte[] value) {
        return java.util.Base64.getUrlEncoder().withoutPadding().encodeToString(value);
    }

    static byte[] decodeBase64Url(String value) {
        if (value == null || value.length() != 43) return null;
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            boolean ok = (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-' || c == '_';
            if (!ok) return null;
        }
        try {
            byte[] decoded = java.util.Base64.getUrlDecoder().decode(value);
            return decoded.length == 32 ? decoded : null;
        } catch (IllegalArgumentException failure) {
            return null;
        }
    }

    static String sha256Hex(byte[] data) {
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256").digest(data);
            StringBuilder out = new StringBuilder(digest.length * 2);
            for (byte value : digest) out.append(String.format("%02x", value & 0xff));
            return out.toString();
        } catch (Exception failure) {
            return null;
        }
    }
}
