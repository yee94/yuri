package com.yee94.yuri.nsh;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import java.security.KeyStore;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * One AES-GCM record under a device-only Android Keystore key contains metadata and
 * credentials atomically; no plaintext credential copy exists in another preference file.
 * This is the Android counterpart of the single Keychain item iOS uses.
 */
public final class ConnectionStore {
    private static final String KEY_ALIAS = "com.yee94.yuri.nsh.connections";
    private static final String PREFERENCES = "yuri-nsh-connections";
    private static final String ENTRY = "connections";
    private static final int TAG_BITS = 128;

    private final SharedPreferences preferences;
    private ConnectionEditorRecords state;

    public ConnectionStore(Context context) throws Exception {
        preferences = context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE);
        String stored = preferences.getString(ENTRY, null);
        if (stored == null) {
            state = new ConnectionEditorRecords();
        } else {
            state = ConnectionEditorRecords.decode(decrypt(Base64.decode(stored, Base64.NO_WRAP)));
        }
        // Legacy records gain their opaque transport partitions only after the migration
        // write succeeds, so a failure never publishes a temporary identity.
        if (state.partitions == null && !state.connections.isEmpty()) commit(state, null);
    }

    public synchronized ConnectionEditorRecords records() { return state; }

    public synchronized ConnectionEditorConnection selected() { return state.selectedConnection(); }

    /**
     * Reconstitute only the exact original attachment authorization. Selection and
     * metadata edits do not grant a replacement credential this authority.
     */
    public synchronized ConnectionEditorConnection attachmentConnection(String connectionID, String transportID,
                                                                         String authorizationID, String version)
            throws RuntimeBridgeFailure {
        for (ConnectionEditorConnection connection : state.connections) {
            if (connection.id.equals(connectionID) && transportID.equals(connection.transportID)
                    && authorizationID.equals(connection.authorizationID) && version.equals(connection.editorVersion)) {
                return connection;
            }
        }
        throw new RuntimeBridgeFailure("attachment_original_authorization_unavailable");
    }

    public synchronized Map<String, Object> snapshot() { return state.snapshot(); }

    public synchronized Map<String, Object> editor(String id) throws ConnectionEditorFailure {
        return state.connection(id, null).editorValue();
    }

    public synchronized void save(String url, String token, String label, ConnectionEditorRelay relay)
            throws ConnectionEditorFailure {
        ConnectionEditorTransport transport = ConnectionEditorTransport.from(url, relay);
        ConnectionEditorConnection existing = null;
        for (ConnectionEditorConnection connection : state.connections) {
            if (ConnectionEditorTransport.from(connection.url, connection.relay).equals(transport)) {
                existing = connection;
                break;
            }
        }
        String id = existing == null ? java.util.UUID.randomUUID().toString() : existing.id;
        ConnectionEditorConnection value = new ConnectionEditorConnection(id, label.isEmpty() ? fallbackLabel(relay, url) : label,
            url, token, System.currentTimeMillis(), relay, java.util.UUID.randomUUID().toString(),
            java.util.UUID.randomUUID().toString().toLowerCase(java.util.Locale.ROOT), null);
        ConnectionEditorRecords next = state.copy();
        List<ConnectionEditorConnection> kept = new ArrayList<>();
        for (ConnectionEditorConnection connection : next.connections) if (!connection.id.equals(value.id)) kept.add(connection);
        next.connections.clear();
        next.connections.addAll(kept);
        next.connections.add(value);
        next.selected = value.id;
        commit(next, null);
    }

    private static String fallbackLabel(ConnectionEditorRelay relay, String url) {
        if (relay != null && !relay.serverId.isEmpty()) return relay.serverId;
        RuntimeHostUri.Parts parts = RuntimeHostUri.parse(url);
        if (parts != null && parts.host != null && !parts.host.isEmpty()) return parts.host;
        return "Yuri";
    }

    public synchronized void edit(ConnectionEditorInput input) throws ConnectionEditorFailure {
        ConnectionEditorRecords next = state.editing(input);
        String before;
        String after;
        try {
            before = state.connection(input.id, null).editorVersion;
            after = next.connection(input.id, null).editorVersion;
        } catch (ConnectionEditorFailure failure) {
            throw failure;
        }
        if (before == null ? after == null : before.equals(after)) return;
        try {
            commit(next, null);
        } catch (ConnectionEditorFailure failure) {
            if (ConnectionEditorFailure.STORAGE.equals(failure.code)) throw failure;
            throw new ConnectionEditorFailure(ConnectionEditorFailure.STORAGE);
        }
    }

    public synchronized void validateReplacement(String id, String version, Map<String, Object> input)
            throws ConnectionEditorFailure {
        state.validateReplacement(id, version, input);
    }

    public synchronized void replace(String id, String version, String url, String token, String label,
                                     ConnectionEditorRelay relay) throws ConnectionEditorFailure {
        ConnectionEditorConnection candidate = new ConnectionEditorConnection(id,
            label.isEmpty() ? fallbackLabel(relay, url) : label, url, token, 0, relay, null, null, null);
        ConnectionEditorRecords next = state.replacing(id, version, candidate);
        commit(next, null);
    }

    public synchronized void select(String id) throws Exception {
        ConnectionEditorConnection value = null;
        int index = -1;
        for (int i = 0; i < state.connections.size(); i++) {
            if (state.connections.get(i).id.equals(id)) { value = state.connections.get(i); index = i; break; }
        }
        if (value == null) throw new RuntimeBridgeFailure("connection_missing", "连接已不存在");
        ConnectionEditorRecords next = state.copy();
        next.selected = id;
        next.connections.get(index).lastUsedAt = System.currentTimeMillis();
        commit(next, null);
    }

    public synchronized void remove(String id) throws ConnectionEditorFailure {
        ConnectionEditorRecords next = state.copy();
        List<ConnectionEditorConnection> kept = new ArrayList<>();
        for (ConnectionEditorConnection connection : next.connections) if (!connection.id.equals(id)) kept.add(connection);
        next.connections.clear();
        next.connections.addAll(kept);
        if (id.equals(next.selected)) next.selected = null;
        commit(next, null);
    }

    public synchronized List<ConnectionEditorRetirement> pendingAuthorizationRetirements() {
        return new ArrayList<>(state.pending);
    }

    /**
     * Call only after every native owner retired this exact pair. A failed acknowledgement
     * write preserves the receipt; retry cleanup, never the original mutation.
     */
    public synchronized void acknowledgeAuthorizationRetirement(String connectionID, String authorizationID)
            throws Exception {
        ConnectionEditorRetirement retired = new ConnectionEditorRetirement(connectionID, authorizationID);
        if (!state.pending.contains(retired)) return;
        commit(state, retired);
    }

    private void commit(ConnectionEditorRecords next, ConnectionEditorRetirement acknowledging)
            throws ConnectionEditorFailure {
        state = state.commit(next, acknowledging, this::persist);
    }

    private void persist(byte[] data) throws Exception {
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, key());
        byte[] iv = cipher.getIV();
        byte[] ciphertext = cipher.doFinal(data);
        byte[] combined = new byte[iv.length + ciphertext.length];
        System.arraycopy(iv, 0, combined, 0, iv.length);
        System.arraycopy(ciphertext, 0, combined, iv.length, ciphertext.length);
        String encoded = Base64.encodeToString(combined, Base64.NO_WRAP);
        if (!preferences.edit().putString(ENTRY, encoded).commit()) {
            throw new RuntimeBridgeFailure("connection_storage", "无法保存设备连接");
        }
    }

    private byte[] decrypt(byte[] combined) throws Exception {
        if (combined.length <= 12) throw new RuntimeBridgeFailure("connection_storage", "无法读取设备安全存储");
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(TAG_BITS, combined, 0, 12));
        return cipher.doFinal(combined, 12, combined.length - 12);
    }

    private SecretKey key() throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore");
        store.load(null);
        if (store.containsAlias(KEY_ALIAS)) return (SecretKey) store.getKey(KEY_ALIAS, null);
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        generator.init(new KeyGenParameterSpec.Builder(KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setRandomizedEncryptionRequired(true)
            .build());
        return generator.generateKey();
    }
}
