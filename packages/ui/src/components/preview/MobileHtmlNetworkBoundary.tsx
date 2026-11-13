import React from 'react';
import { isCapacitorApp } from '@/lib/platform';
import { acquireMobileHtmlNetwork } from '@/lib/preview/mobile-html-network';
import { HtmlNetworkBoundary } from './HtmlNetworkBoundary';

type Network = { hostOrigin?: string };
type Props = {
  children: (network?: Network) => React.ReactNode;
  /** Built-in HTML needs the Host HTTP origin; plugin views only need egress routed. */
  connect?: boolean;
};

// HTML needs the Host's HTTP origin from the channel handshake, so it connects now.
const openHtml = async (signal: AbortSignal, fail: () => void): Promise<Network> =>
  (await acquireMobileHtmlNetwork(signal, fail)).connect(signal);
const openPlugin = async (signal: AbortSignal): Promise<Network> => {
  await acquireMobileHtmlNetwork(signal, () => {});
  return {};
};

/**
 * Built-in HTML and plugin views route through Relay only while mounted; the rest of
 * the application keeps its original network path.
 */
export function MobileHtmlNetworkBoundary({ children, connect }: Props) {
  return isCapacitorApp()
    ? <HtmlNetworkBoundary open={connect === false ? openPlugin : openHtml}>{children}</HtmlNetworkBoundary>
    : children();
}
