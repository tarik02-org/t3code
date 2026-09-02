import { DEFAULT_HOSTED_APP_URL } from "@t3tools/shared/connectAuth";
import { PRIMARY_LOCAL_ENVIRONMENT_ID } from "@t3tools/contracts";

import { getPairingTokenFromUrl, setPairingTokenOnUrl } from "./pairingUrl";

export interface HostedPairingRequest {
  readonly host: string;
  readonly token: string;
  readonly label: string;
}

export type HostedAppChannel = "latest" | "nightly" | "canary";

function hostedStaticAppEnabled(): boolean {
  return import.meta.env.VITE_HOSTED_STATIC_APP === "true";
}

function currentOrigin(): string | null {
  return typeof window === "undefined" ? null : window.location.origin;
}

export function configuredHostedAppUrl(): string {
  return (
    import.meta.env.VITE_HOSTED_APP_URL?.trim() ||
    (hostedStaticAppEnabled() ? currentOrigin() : null) ||
    DEFAULT_HOSTED_APP_URL
  );
}

export function isDesktopBackendless(): boolean {
  if (typeof window === "undefined" || window.desktopBridge === undefined) {
    return false;
  }
  return !window.desktopBridge
    .getLocalEnvironmentBootstraps()
    .some((entry) => entry.id === PRIMARY_LOCAL_ENVIRONMENT_ID);
}

function configuredBackendUrl(): string {
  return import.meta.env.VITE_HTTP_URL?.trim() || import.meta.env.VITE_WS_URL?.trim() || "";
}

function configuredHostedAppChannel(): HostedAppChannel | null {
  const channel = import.meta.env.VITE_HOSTED_APP_CHANNEL?.trim().toLowerCase();
  if (channel === "latest" || channel === "nightly" || channel === "canary") {
    return channel;
  }
  return null;
}

function originFromUrl(value: string): string | null {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

export function isHostedStaticApp(url?: URL): boolean {
  if (isDesktopBackendless()) {
    return true;
  }
  if (configuredBackendUrl()) {
    return false;
  }

  if (hostedStaticAppEnabled()) {
    return true;
  }

  if (configuredHostedAppChannel()) {
    return true;
  }

  // No window (tests, static render) means no origin to be hosted at.
  if (url === undefined && typeof window === "undefined") {
    return false;
  }

  const hostedOrigin = originFromUrl(configuredHostedAppUrl());
  return hostedOrigin !== null && (url ?? new URL(window.location.href)).origin === hostedOrigin;
}

export function readHostedPairingRequest(url: URL = new URL(window.location.href)) {
  const host = url.searchParams.get("host")?.trim() ?? "";
  const token = getPairingTokenFromUrl(url)?.trim() ?? "";
  const label = url.searchParams.get("label")?.trim() ?? "";

  if (!host || !token) {
    return null;
  }

  return {
    host,
    token,
    label,
  } satisfies HostedPairingRequest;
}

export function hasHostedPairingRequest(url: URL = new URL(window.location.href)): boolean {
  return readHostedPairingRequest(url) !== null;
}

export function buildHostedPairingUrl(input: {
  readonly host: string;
  readonly token: string;
  readonly label?: string | null;
}): string {
  const url = new URL("/pair", configuredHostedAppUrl());
  url.searchParams.set("host", input.host);

  const label = input.label?.trim();
  if (label) {
    url.searchParams.set("label", label);
  }

  return setPairingTokenOnUrl(url, input.token).toString();
}

export function buildHostedChannelSelectionUrl(input: {
  readonly channel: HostedAppChannel;
}): string {
  const url = new URL("/__t3code/channel", configuredHostedAppUrl());
  url.searchParams.set("channel", input.channel);
  return url.toString();
}
