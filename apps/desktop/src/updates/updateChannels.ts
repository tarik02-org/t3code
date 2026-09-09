import type { DesktopUpdateChannel } from "@t3tools/contracts";

const NIGHTLY_VERSION_PATTERN = /-nightly\.\d{8}\.\d+$/;
const CANARY_VERSION_PATTERN = /-canary\.\d{8}\.\d+$/;

export function isNightlyDesktopVersion(version: string): boolean {
  return NIGHTLY_VERSION_PATTERN.test(version);
}

export function isCanaryDesktopVersion(version: string): boolean {
  return CANARY_VERSION_PATTERN.test(version);
}

export function resolveDefaultDesktopUpdateChannel(appVersion: string): DesktopUpdateChannel {
  if (isCanaryDesktopVersion(appVersion)) return "canary";
  return isNightlyDesktopVersion(appVersion) ? "nightly" : "latest";
}
