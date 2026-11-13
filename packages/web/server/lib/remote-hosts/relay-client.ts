// Compile the existing normative client, rather than introducing another wire
// protocol or copying its security-sensitive handshake/codec implementation.
export { createRelayTunnelClient } from '../../../../ui/src/lib/relay/tunnel-client';
