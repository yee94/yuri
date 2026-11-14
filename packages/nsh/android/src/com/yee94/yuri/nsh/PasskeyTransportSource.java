package com.yee94.yuri.nsh;

/**
 * Optional companion of {@link HostLease}. HostLease intentionally exposes no origin, cookie jar or
 * credential owner, so the runtime bridge exposes its captured passkey management transport through
 * this interface on the lease it returns for the same Host and generation.
 *
 * <p>Without it a passkey call fails closed with passkey_unsupported_on_this_host; it never falls back
 * to the paired-client bearer or to a WebView JavaScript authenticator.
 */
public interface PasskeyTransportSource {
    PasskeyTransport passkeyTransport() throws Exception;
}
