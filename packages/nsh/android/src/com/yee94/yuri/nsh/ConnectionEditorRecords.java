package com.yee94.yuri.nsh;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

/**
 * The single durable connection record set. Every mutation stages a whole copy, validates
 * it, persists it and only then becomes authoritative; a failed write leaves the previous
 * records untouched, including its selection and pending authorization retirements.
 */
public final class ConnectionEditorRecords {
    public static final int RETIREMENT_LIMIT = 1024;
    public static final int TRANSPORT_PARTITION_LIMIT = 4096;

    public final List<ConnectionEditorConnection> connections = new ArrayList<>();
    public String selected;
    /** Native-only cleanup receipts; never exposed as JS mutation authority. */
    public final List<ConnectionEditorRetirement> pending = new ArrayList<>();
    /** Null for a legacy record set that has not been migrated yet. */
    public List<ConnectionEditorPartition> partitions;

    public interface Persist { void persist(byte[] data) throws Exception; }

    public ConnectionEditorRecords() {}

    public ConnectionEditorRecords copy() {
        ConnectionEditorRecords next = new ConnectionEditorRecords();
        for (ConnectionEditorConnection connection : connections) next.connections.add(connection.copy());
        next.selected = selected;
        next.pending.addAll(pending);
        next.partitions = partitions == null ? null : new ArrayList<>(partitions);
        return next;
    }

    public ConnectionEditorConnection selectedConnection() {
        if (selected == null) return null;
        for (ConnectionEditorConnection connection : connections) if (connection.id.equals(selected)) return connection;
        return null;
    }

    public ConnectionEditorConnection connection(String id, String version) throws ConnectionEditorFailure {
        for (ConnectionEditorConnection value : connections) {
            if (!value.id.equals(id)) continue;
            if (version != null && !version.equals(value.editorVersion == null ? "legacy" : value.editorVersion)) {
                throw new ConnectionEditorFailure(ConnectionEditorFailure.STALE);
            }
            return value;
        }
        throw new ConnectionEditorFailure(ConnectionEditorFailure.MISSING);
    }

    /** Reject everything that is not a bare http(s) origin: no path, query, credentials or fragment. */
    public static String origin(String raw) throws ConnectionEditorFailure {
        if (raw == null) throw new ConnectionEditorFailure(ConnectionEditorFailure.INVALID);
        String value = raw.trim();
        if (value.indexOf('\\') >= 0 || RuntimeHostText.hasControl(value)) {
            throw new ConnectionEditorFailure(ConnectionEditorFailure.INVALID);
        }
        RuntimeHostUri.Parts parts = RuntimeHostUri.parse(value);
        if (parts == null || parts.scheme == null || !parts.authority) throw new ConnectionEditorFailure(ConnectionEditorFailure.INVALID);
        String scheme = parts.scheme.toLowerCase(Locale.ROOT);
        if (!"http".equals(scheme) && !"https".equals(scheme)) throw new ConnectionEditorFailure(ConnectionEditorFailure.INVALID);
        if (parts.host == null || parts.host.isEmpty() || parts.hasCredentials() || parts.query != null
                || parts.fragment != null || !(parts.path.isEmpty() || "/".equals(parts.path))) {
            throw new ConnectionEditorFailure(ConnectionEditorFailure.INVALID);
        }
        Integer port = parts.port;
        if (port != null && port == ("https".equals(scheme) ? 443 : 80)) port = null;
        StringBuilder origin = new StringBuilder();
        origin.append(scheme).append("://").append(parts.host.toLowerCase(Locale.ROOT));
        if (port != null) origin.append(':').append(port);
        return origin.toString();
    }

    public ConnectionEditorRecords editing(ConnectionEditorInput input) throws ConnectionEditorFailure {
        ConnectionEditorConnection previous = connection(input.id, input.version);
        if (input.url != null) {
            if (previous.relay != null) {
                if (!input.url.equals(previous.relay.relayUrl)) throw new ConnectionEditorFailure(ConnectionEditorFailure.PAIRING_REQUIRED);
            } else if (!origin(input.url).equals(origin(previous.url))) {
                throw new ConnectionEditorFailure(ConnectionEditorFailure.PAIRING_REQUIRED);
            }
        }
        if (previous.label.equals(input.label)) return this;
        ConnectionEditorRecords next = copy();
        for (ConnectionEditorConnection value : next.connections) {
            if (!value.id.equals(input.id)) continue;
            value.label = input.label;
            value.editorVersion = UUID.randomUUID().toString();
        }
        return next;
    }

    public void validateReplacement(String id, String version, Map<String, Object> input) throws ConnectionEditorFailure {
        ConnectionEditorConnection previous = connection(id, version);
        if (input.containsKey("label")) {
            Map<String, Object> probe = new LinkedHashMap<>();
            probe.put("id", id);
            probe.put("version", version);
            probe.put("label", input.get("label"));
            ConnectionEditorInput.parse(probe, false);
        }
        Object pairing = input.get("pairingLink");
        if (pairing instanceof String && !((String) pairing).isEmpty()) return;
        Object password = input.get("password");
        if (password instanceof String && !((String) password).isEmpty()) return;
        Object token = input.get("token");
        if (!(token instanceof String) || ((String) token).isEmpty() || previous.relay != null) {
            throw new ConnectionEditorFailure(ConnectionEditorFailure.PAIRING_REQUIRED);
        }
        for (ConnectionEditorConnection other : connections) {
            if (other.token.equals(token)) throw new ConnectionEditorFailure(ConnectionEditorFailure.PAIRING_REQUIRED);
        }
    }

    /** Call only after independently authorizing and validating the replacement candidate. */
    public ConnectionEditorRecords replacing(String id, String version, ConnectionEditorConnection candidate)
            throws ConnectionEditorFailure {
        ConnectionEditorConnection previous = connection(id, version);
        if (candidate.token.isEmpty()) throw new ConnectionEditorFailure(ConnectionEditorFailure.PAIRING_REQUIRED);
        ConnectionEditorTransport transport = ConnectionEditorTransport.from(candidate.url, candidate.relay);
        for (ConnectionEditorConnection other : connections) {
            if (other.id.equals(id)) continue;
            if (ConnectionEditorTransport.from(other.url, other.relay).equals(transport)) {
                throw new ConnectionEditorFailure(ConnectionEditorFailure.DUPLICATE);
            }
        }
        ConnectionEditorRecords next = copy();
        for (int index = 0; index < next.connections.size(); index++) {
            if (!next.connections.get(index).id.equals(id)) continue;
            next.connections.set(index, new ConnectionEditorConnection(id, candidate.label, candidate.url, candidate.token,
                previous.lastUsedAt, candidate.relay, UUID.randomUUID().toString(),
                UUID.randomUUID().toString().toLowerCase(Locale.ROOT), null));
        }
        return next;
    }

    /**
     * Persist first. Ordinary mutations cannot drop outstanding cleanup even when a caller
     * builds a fresh record set; only the exact acknowledgement lane removes a receipt.
     */
    public ConnectionEditorRecords commit(ConnectionEditorRecords next, ConnectionEditorRetirement acknowledging,
                                          Persist persist) throws ConnectionEditorFailure {
        ConnectionEditorRecords staged = next.copy();
        staged.pending.clear();
        staged.pending.addAll(pending);
        for (ConnectionEditorConnection previous : connections) {
            if (previous.authorizationID == null) continue;
            ConnectionEditorConnection replacement = null;
            for (ConnectionEditorConnection value : next.connections) {
                if (value.id.equals(previous.id)) { replacement = value; break; }
            }
            if (replacement != null && previous.authorizationID.equals(replacement.authorizationID)) {
                boolean same = replacement.token.equals(previous.token) && replacement.url.equals(previous.url)
                    && (replacement.relay == null ? previous.relay == null : replacement.relay.equals(previous.relay));
                if (!same) throw new ConnectionEditorFailure(ConnectionEditorRetirement.INVALID);
                continue;
            }
            ConnectionEditorRetirement retired = new ConnectionEditorRetirement(previous.id, previous.authorizationID);
            if (!staged.pending.contains(retired)) staged.pending.add(retired);
        }
        if (acknowledging != null) staged.pending.remove(acknowledging);
        staged.validateRetirements();
        staged.assignTransportPartitions(this);
        byte[] bytes;
        try {
            bytes = RuntimeBridgeJson.stringify(staged.encode()).getBytes(StandardCharsets.UTF_8);
        } catch (RuntimeBridgeFailure failure) {
            throw new ConnectionEditorFailure(ConnectionEditorFailure.STORAGE);
        }
        try {
            persist.persist(bytes);
        } catch (ConnectionEditorFailure failure) {
            throw failure;
        } catch (Exception failure) {
            throw new ConnectionEditorFailure(ConnectionEditorFailure.STORAGE);
        }
        return staged;
    }

    public void validateRetirements() throws ConnectionEditorFailure {
        if (pending.size() > RETIREMENT_LIMIT) throw new ConnectionEditorFailure(ConnectionEditorRetirement.CAPACITY);
        if (new LinkedHashSet<>(pending).size() != pending.size()) {
            throw new ConnectionEditorFailure(ConnectionEditorRetirement.INVALID);
        }
        for (ConnectionEditorRetirement pendingRetirement : pending) {
            for (ConnectionEditorConnection connection : connections) {
                if (connection.id.equals(pendingRetirement.connectionID)
                        && pendingRetirement.authorizationID.equals(connection.authorizationID)) {
                    throw new ConnectionEditorFailure(ConnectionEditorRetirement.INVALID);
                }
            }
        }
    }

    public void validateTransportPartitions() throws ConnectionEditorFailure {
        if (partitions == null) {
            for (ConnectionEditorConnection connection : connections) {
                if (connection.transportID != null) throw new ConnectionEditorFailure(ConnectionEditorFailure.INVALID);
            }
            return;
        }
        if (partitions.size() > TRANSPORT_PARTITION_LIMIT) throw new ConnectionEditorFailure(ConnectionEditorFailure.INVALID);
        Set<ConnectionEditorTransport> transports = new LinkedHashSet<>();
        Set<String> ids = new LinkedHashSet<>();
        for (ConnectionEditorPartition partition : partitions) {
            if (!transports.add(partition.transport)) throw new ConnectionEditorFailure(ConnectionEditorFailure.INVALID);
            if (!ids.add(partition.id)) throw new ConnectionEditorFailure(ConnectionEditorFailure.INVALID);
            if (!RuntimeHostText.uuid(partition.id) || !partition.id.equals(partition.id.toLowerCase(Locale.ROOT))) {
                throw new ConnectionEditorFailure(ConnectionEditorFailure.INVALID);
            }
        }
        for (ConnectionEditorConnection connection : connections) {
            ConnectionEditorTransport transport = ConnectionEditorTransport.from(connection.url, connection.relay);
            String id = null;
            for (ConnectionEditorPartition partition : partitions) {
                if (partition.transport.equals(transport)) { id = partition.id; break; }
            }
            if (id == null || !id.equals(connection.transportID)) throw new ConnectionEditorFailure(ConnectionEditorFailure.INVALID);
        }
    }

    private void assignTransportPartitions(ConnectionEditorRecords previous) throws ConnectionEditorFailure {
        previous.validateTransportPartitions();
        List<ConnectionEditorPartition> staged = previous.partitions == null
            ? new ArrayList<>()
            : new ArrayList<>(previous.partitions);
        for (ConnectionEditorConnection connection : connections) {
            ConnectionEditorTransport transport = ConnectionEditorTransport.from(connection.url, connection.relay);
            String id = null;
            for (ConnectionEditorPartition partition : staged) {
                if (partition.transport.equals(transport)) { id = partition.id; break; }
            }
            if (id == null) {
                if (staged.size() >= TRANSPORT_PARTITION_LIMIT) throw new ConnectionEditorFailure(ConnectionEditorFailure.STORAGE);
                id = UUID.randomUUID().toString().toLowerCase(Locale.ROOT);
                staged.add(new ConnectionEditorPartition(transport, id));
            }
            connection.transportID = id;
        }
        partitions = staged;
        validateTransportPartitions();
    }

    public Map<String, Object> snapshot() {
        List<ConnectionEditorConnection> sorted = new ArrayList<>(connections);
        sorted.sort((left, right) -> Double.compare(right.lastUsedAt, left.lastUsedAt));
        List<Object> values = new ArrayList<>();
        for (ConnectionEditorConnection connection : sorted) values.add(connection.publicValue());
        Map<String, Object> snapshot = new LinkedHashMap<>();
        snapshot.put("connections", values);
        snapshot.put("selected", selected);
        return snapshot;
    }

    public Map<String, Object> encode() {
        Map<String, Object> value = new LinkedHashMap<>();
        List<Object> entries = new ArrayList<>();
        for (ConnectionEditorConnection connection : connections) entries.add(connection.encode());
        value.put("connections", entries);
        value.put("selected", selected);
        List<Object> retirements = new ArrayList<>();
        for (ConnectionEditorRetirement retirement : pending) retirements.add(retirement.encode());
        value.put("pendingAuthorizationRetirements", retirements);
        if (partitions != null) {
            List<Object> entriesPartitions = new ArrayList<>();
            for (ConnectionEditorPartition partition : partitions) entriesPartitions.add(partition.encode());
            value.put("transportPartitions", entriesPartitions);
        }
        return value;
    }

    public static ConnectionEditorRecords decode(byte[] data) throws ConnectionEditorFailure {
        Map<String, Object> fields;
        try {
            fields = RuntimeBridgeJson.object(RuntimeBridgeJson.parse(new String(data, StandardCharsets.UTF_8)));
        } catch (RuntimeBridgeFailure failure) {
            throw new ConnectionEditorFailure(ConnectionEditorFailure.INVALID);
        }
        if (fields == null) throw new ConnectionEditorFailure(ConnectionEditorFailure.INVALID);
        for (String key : fields.keySet()) {
            boolean allowed = "connections".equals(key) || "selected".equals(key)
                || "pendingAuthorizationRetirements".equals(key) || "transportPartitions".equals(key);
            if (!allowed) throw new ConnectionEditorFailure(ConnectionEditorFailure.INVALID);
        }
        ConnectionEditorRecords records = new ConnectionEditorRecords();
        List<Object> connections = RuntimeBridgeJson.array(fields.get("connections"));
        if (connections == null) throw new ConnectionEditorFailure(ConnectionEditorFailure.INVALID);
        for (Object entry : connections) records.connections.add(ConnectionEditorConnection.decode(entry));
        Object selected = fields.get("selected");
        if (selected != null && !(selected instanceof String)) throw new ConnectionEditorFailure(ConnectionEditorFailure.INVALID);
        records.selected = (String) selected;
        if (fields.containsKey("pendingAuthorizationRetirements")) {
            List<Object> pending = RuntimeBridgeJson.array(fields.get("pendingAuthorizationRetirements"));
            if (pending == null) throw new ConnectionEditorFailure(ConnectionEditorFailure.INVALID);
            for (Object entry : pending) records.pending.add(ConnectionEditorRetirement.decode(entry));
        }
        if (fields.containsKey("transportPartitions")) {
            List<Object> partitions = RuntimeBridgeJson.array(fields.get("transportPartitions"));
            if (partitions == null) throw new ConnectionEditorFailure(ConnectionEditorFailure.INVALID);
            records.partitions = new ArrayList<>();
            for (Object entry : partitions) records.partitions.add(ConnectionEditorPartition.decode(entry));
        }
        records.validateRetirements();
        records.validateTransportPartitions();
        return records;
    }
}
