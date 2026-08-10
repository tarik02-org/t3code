export type WebRtcUdpPortRange = readonly [minimum: number, maximum: number];

export const DEFAULT_WEBRTC_UDP_PORT_RANGE: WebRtcUdpPortRange = [60_000, 61_000];

export function parseWebRtcUdpPortRange(value: string): WebRtcUdpPortRange {
  const match = /^(\d+)-(\d+)$/.exec(value.trim());
  if (match === null) {
    throw new Error("WebRTC UDP port range must use min-max syntax.");
  }
  const minimum = Number(match[1]);
  const maximum = Number(match[2]);
  if (
    !Number.isInteger(minimum) ||
    !Number.isInteger(maximum) ||
    minimum < 1_024 ||
    maximum > 65_535 ||
    minimum >= maximum
  ) {
    throw new Error("WebRTC UDP port range is invalid.");
  }
  return [minimum, maximum];
}
