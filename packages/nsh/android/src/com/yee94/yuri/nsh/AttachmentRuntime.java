package com.yee94.yuri.nsh;

import java.util.Map;
import java.util.function.BooleanSupplier;

/**
 * The Host-facing half of attachments, implemented by RuntimeBridge (Agent 1).
 * AttachmentBridge owns the picker, validation, journal and receipt phases; the
 * runtime owns the authenticated transport, the captured original connection
 * and every byte the Host receives. Nothing here exposes a URL or credential.
 */
public interface AttachmentRuntime {
    /** Fails when `expected` is not the current authenticated Host scope. */
    void validateAttachmentHost(HostLease.Scope expected) throws Exception;

    /** Raw authenticated PUT of one plain attachment; the Host descriptor is returned as a Map. */
    Map<String, Object> uploadPlain(HostLease.Scope expected, byte[] data, String name, String mime) throws Exception;

    /** Captures the contact generation, validates the receipt protocol and journals `prepared`. */
    Operation contactOperation(HostLease.Scope expected, String assistantID, Integer expectedGeneration,
                               String requestID, AttachmentReceiptJournal.DraftContext context,
                               AttachmentReceiptJournal journal) throws Exception;

    /** Restores an exact journaled operation after a restart; it can only GET/DELETE its own upload. */
    Operation restoreOperation(AttachmentReceiptJournal.Record saved, HostLease.Scope expected,
                               AttachmentReceiptJournal journal) throws Exception;

    /** Exact native-owned authority for one captured operation. */
    final class Operation {
        public interface Upload {
            Map<String, Object> upload(byte[] data, String name, String mime) throws Exception;
        }

        public interface Reconcile {
            Map<String, Object> reconcile() throws Exception;
        }

        public interface Retire {
            void retire() throws Exception;
        }

        public interface Acknowledge {
            void acknowledge(Object descriptor) throws Exception;
        }

        public final Upload upload;
        public final Reconcile reconcile;
        public final Retire retire;
        public final Acknowledge acknowledge;
        public final BooleanSupplier dispatched;

        public Operation(Upload upload, Reconcile reconcile, Retire retire, Acknowledge acknowledge,
                         BooleanSupplier dispatched) {
            this.upload = upload;
            this.reconcile = reconcile;
            this.retire = retire;
            this.acknowledge = acknowledge;
            this.dispatched = dispatched;
        }
    }
}
