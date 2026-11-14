package com.yee94.yuri.nsh;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * The relay mux codec, byte-identical to the protocol's 1-byte type|more + 4-byte
 * big-endian stream ID header. Request/response heads are single frames, so a payload over
 * {@link #MAX_PAYLOAD} is a protocol violation rather than something to split here.
 */
public final class RelayTunnelFrame {
    /** The protocol reserves 5 bytes for the mux header and 5 for a batch envelope. */
    public static final int MAX_PAYLOAD = 65526;

    public static final class Frame {
        public final int type;
        public final boolean more;
        public final int streamId;
        public final byte[] payload;

        Frame(int type, boolean more, int streamId, byte[] payload) {
            this.type = type;
            this.more = more;
            this.streamId = streamId;
            this.payload = payload;
        }
    }

    private RelayTunnelFrame() {}

    /** {@code typeAndMore}'s high bit marks a fragmented payload. */
    public static byte[] encode(int typeAndMore, int streamId, byte[] payload) throws RelayTunnelFailure {
        if ((typeAndMore & 0x7f) < 1 || (typeAndMore & 0x7f) > 12) {
            throw new RelayTunnelFailure(RelayTunnelFailure.Kind.INVALID_FRAME);
        }
        if (payload.length > MAX_PAYLOAD) throw new RelayTunnelFailure(RelayTunnelFailure.Kind.LIMIT);
        byte[] frame = new byte[5 + payload.length];
        frame[0] = (byte) typeAndMore;
        frame[1] = (byte) (streamId >>> 24);
        frame[2] = (byte) (streamId >>> 16);
        frame[3] = (byte) (streamId >>> 8);
        frame[4] = (byte) streamId;
        System.arraycopy(payload, 0, frame, 5, payload.length);
        return frame;
    }

    public static Frame decode(byte[] frame) throws RelayTunnelFailure {
        if (frame == null || frame.length < 5 || frame.length > MAX_PAYLOAD + 5) {
            throw new RelayTunnelFailure(RelayTunnelFailure.Kind.INVALID_FRAME);
        }
        int type = frame[0] & 0x7f;
        boolean more = (frame[0] & 0x80) != 0;
        if (type < 1 || type > 12 || (more && type != 8 && type != 9)) {
            throw new RelayTunnelFailure(RelayTunnelFailure.Kind.INVALID_FRAME);
        }
        int id = ((frame[1] & 0xff) << 24) | ((frame[2] & 0xff) << 16) | ((frame[3] & 0xff) << 8) | (frame[4] & 0xff);
        byte[] payload = new byte[frame.length - 5];
        System.arraycopy(frame, 5, payload, 0, payload.length);
        return new Frame(type, more, id, payload);
    }

    /** Response head: exactly one per stream, status 200-599, no transfer encoding. */
    public static Map<String, String> head(int status, Map<String, ? extends Object> headers) throws RelayTunnelFailure {
        if (status < 200 || status > 599 || headers == null) throw new RelayTunnelFailure(RelayTunnelFailure.Kind.INVALID_FRAME);
        Map<String, String> values = new LinkedHashMap<>();
        for (Map.Entry<String, ? extends Object> entry : headers.entrySet()) {
            if (!(entry.getValue() instanceof String)) throw new RelayTunnelFailure(RelayTunnelFailure.Kind.INVALID_FRAME);
            values.put(entry.getKey(), (String) entry.getValue());
        }
        return values;
    }
}
