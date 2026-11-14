package com.yee94.yuri.nsh;

import android.app.Activity;

import com.longbridge.nsh.NshHostReply;
import com.longbridge.nsh.NshView;

import java.util.LinkedHashSet;
import java.util.Map;
import java.util.Set;

/**
 * Main owns this bridge alongside RuntimeBridge; it never performs reset POSTs. The
 * handler names, argument shapes and reply shapes match iOS exactly.
 */
public final class AuthorizationCacheCleanupBridge {
    private final Activity activity;
    private final RuntimeBridge runtime;
    private final AuthorizationCacheCleanup owner;
    private NshView view;

    public AuthorizationCacheCleanupBridge(Activity activity, RuntimeBridge runtime, NshView view) {
        this.activity = activity;
        this.runtime = runtime;
        this.view = view;
        this.owner = new AuthorizationCacheCleanup(() -> {
            Set<AuthorizationCacheCleanup.Identity> pending = new LinkedHashSet<>();
            for (ConnectionEditorRetirement retirement : runtime.store().pendingAuthorizationRetirements()) {
                pending.add(new AuthorizationCacheCleanup.Identity(retirement.connectionID, retirement.authorizationID));
            }
            return pending;
        });
    }

    /** Uniform bridge shape; the provider must be the single RuntimeBridge of this process. */
    public AuthorizationCacheCleanupBridge(Activity activity, HostLeaseProvider leases, NshView view) {
        this(activity, requireRuntime(leases), view);
    }

    private static RuntimeBridge requireRuntime(HostLeaseProvider leases) {
        if (leases instanceof RuntimeBridge) return (RuntimeBridge) leases;
        throw new IllegalArgumentException("AuthorizationCacheCleanupBridge requires RuntimeBridge");
    }

    public void install() {
        for (String name : new String[] {"ready", "list", "claim", "ack", "retry"}) {
            final String operation = name;
            view.handle("authorization.cache." + name, (data, reply) -> handle(operation, data, reply));
        }
    }

    public void invalidate() {
        view = null;
    }

    /** Tells JS that native receipts changed; it never carries an identity. */
    public void requestSweep() {
        if (view != null) view.send("authorization.cache.pending", new java.util.LinkedHashMap<String, Object>());
    }

    public void requireCompletion(String connectionID, String authorizationID) throws RuntimeBridgeFailure {
        owner.requireCompletion(connectionID, authorizationID);
    }

    private void handle(String name, Object input, NshHostReply reply) {
        try {
            Set<String> keys = new LinkedHashSet<>();
            if (name.equals("list")) keys.add("owner");
            else if (name.equals("claim") || name.equals("ack")) { keys.add("owner"); keys.add("ticket"); }
            Map<String, String> fields = fields(input, keys);
            switch (name) {
                case "ready": reply.resolve(owner.ready()); return;
                case "list": reply.resolve(owner.list(fields.get("owner"))); return;
                case "claim": reply.resolve(owner.claim(fields.get("owner"), fields.get("ticket"))); return;
                case "ack":
                    owner.ack(fields.get("owner"), fields.get("ticket"));
                    reply.resolve(Boolean.TRUE);
                    return;
                default:
                    // A normal return from the runtime is not proof of cleanup: every owner
                    // must have retired before JS may clear its native failure. The reply is
                    // answered from the worker, never by blocking the UI thread.
                    runtime.retryAuthorizationRetirementsOnce().whenComplete((status, error) -> {
                        if (error != null) { reply.reject("authorization_cleanup_failed"); return; }
                        Object failed = status == null ? null : status.get("failed");
                        if (failed instanceof Integer && ((Integer) failed) > 0) {
                            reply.reject("authorization_cleanup_failed");
                            return;
                        }
                        reply.resolve(Boolean.TRUE);
                    });
                    return;
            }
        } catch (RuntimeBridgeFailure failure) {
            reply.reject(failure.getMessage());
        } catch (Exception failure) {
            reply.reject("authorization_cache_invalid_input");
        }
    }

    private static Map<String, String> fields(Object input, Set<String> keys) throws RuntimeBridgeFailure {
        Map<String, Object> fields = RuntimeBridgeJson.object(input);
        if (fields == null || !fields.keySet().equals(keys)) throw new RuntimeBridgeFailure("authorization_cache_invalid_input");
        Map<String, String> result = new java.util.LinkedHashMap<>();
        for (String key : keys) {
            Object value = fields.get(key);
            if (!(value instanceof String) || !RuntimeHostText.identifier((String) value)) {
                throw new RuntimeBridgeFailure("authorization_cache_invalid_input");
            }
            result.put(key, (String) value);
        }
        return result;
    }
}
