import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export type WebRtcUdpPortRange = readonly [minimum: number, maximum: number];

export const DEFAULT_WEBRTC_UDP_PORT_RANGE: WebRtcUdpPortRange = [60_000, 61_000];

export class WebRtcUdpPortRangeConfigError extends Schema.TaggedErrorClass<WebRtcUdpPortRangeConfigError>()(
  "WebRtcUdpPortRangeConfigError",
  { reason: Schema.Literals(["invalid-syntax", "invalid-range"]) },
) {
  override get message(): string {
    return this.reason === "invalid-syntax"
      ? "WebRTC UDP port range must use min-max syntax."
      : "WebRTC UDP port range is invalid.";
  }
}

export const parseWebRtcUdpPortRange = Effect.fn("WebRtcConfig.parseUdpPortRange")(function* (
  value: string,
) {
  const match = /^(\d+)-(\d+)$/.exec(value.trim());
  if (match === null) {
    return yield* new WebRtcUdpPortRangeConfigError({ reason: "invalid-syntax" });
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
    return yield* new WebRtcUdpPortRangeConfigError({ reason: "invalid-range" });
  }
  return [minimum, maximum] satisfies WebRtcUdpPortRange;
});
