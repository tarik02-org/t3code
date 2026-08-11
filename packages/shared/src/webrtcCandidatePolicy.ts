import type { WebRtcIceServer } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export const DEFAULT_WEBRTC_STUN_URLS = ["stun:stun.cloudflare.com:3478"] as const;

export const MAX_WEBRTC_SDP_BYTES = 256 * 1024;
export const MAX_WEBRTC_SDP_CANDIDATES = 128;

export type WebRtcCandidatePolicyErrorCode =
  | "unsupported-stun-url"
  | "unsupported-turn-url"
  | "unsupported-ice-url"
  | "incomplete-turn-credentials"
  | "sdp-too-large"
  | "too-many-candidates";

export class WebRtcCandidatePolicyError extends Schema.TaggedErrorClass<WebRtcCandidatePolicyError>()(
  "WebRtcCandidatePolicyError",
  {
    code: Schema.Literals([
      "unsupported-stun-url",
      "unsupported-turn-url",
      "unsupported-ice-url",
      "incomplete-turn-credentials",
      "sdp-too-large",
      "too-many-candidates",
    ]),
  },
) {
  override get message(): string {
    switch (this.code) {
      case "unsupported-stun-url":
        return "WebRTC STUN servers must use the stun: or stuns: scheme.";
      case "unsupported-turn-url":
        return "WebRTC TURN servers must use the turn: or turns: scheme.";
      case "unsupported-ice-url":
        return "WebRTC ICE servers must use the stun:, stuns:, turn:, or turns: scheme.";
      case "incomplete-turn-credentials":
        return "WebRTC TURN username and credential must be configured together.";
      case "sdp-too-large":
        return "WebRTC SDP exceeds the size limit.";
      case "too-many-candidates":
        return "WebRTC SDP contains too many ICE candidates.";
      default: {
        const exhaustive: never = this.code;
        return exhaustive;
      }
    }
  }
}

const STUN_URL_PATTERN = /^stuns?:[^\s]+$/i;
const TURN_URL_PATTERN = /^turns?:[^\s]+$/i;
const ICE_URL_PATTERN = /^(?:stuns?|turns?):[^\s]+$/i;
const SDP_CANDIDATE_PATTERN = /^a=candidate:/gm;

export const validateStunUrls = Effect.fn("WebRtcCandidatePolicy.validateStunUrls")(function* (
  urls: ReadonlyArray<string>,
) {
  const validated: Array<string> = [];
  for (const value of urls) {
    const url = value.trim();
    if (!STUN_URL_PATTERN.test(url)) {
      return yield* new WebRtcCandidatePolicyError({ code: "unsupported-stun-url" });
    }
    validated.push(url);
  }
  return validated;
});

export const validateTurnUrls = Effect.fn("WebRtcCandidatePolicy.validateTurnUrls")(function* (
  urls: ReadonlyArray<string>,
) {
  const validated: Array<string> = [];
  for (const value of urls) {
    const url = value.trim();
    if (!TURN_URL_PATTERN.test(url)) {
      return yield* new WebRtcCandidatePolicyError({ code: "unsupported-turn-url" });
    }
    validated.push(url);
  }
  return validated;
});

export const validateIceServers = Effect.fn("WebRtcCandidatePolicy.validateIceServers")(function* (
  iceServers: ReadonlyArray<WebRtcIceServer>,
) {
  const validated: Array<WebRtcIceServer> = [];
  for (const iceServer of iceServers) {
    const urls: Array<string> = [];
    for (const value of iceServer.urls) {
      const url = value.trim();
      if (!ICE_URL_PATTERN.test(url)) {
        return yield* new WebRtcCandidatePolicyError({ code: "unsupported-ice-url" });
      }
      urls.push(url);
    }
    if ((iceServer.username === undefined) !== (iceServer.credential === undefined)) {
      return yield* new WebRtcCandidatePolicyError({ code: "incomplete-turn-credentials" });
    }
    validated.push({
      urls,
      ...(iceServer.username === undefined
        ? {}
        : { username: iceServer.username, credential: iceServer.credential }),
    });
  }
  return validated;
});

export const validateSessionDescription = Effect.fn(
  "WebRtcCandidatePolicy.validateSessionDescription",
)(function* (
  sdp: string,
  options?: {
    readonly maxBytes?: number;
    readonly maxCandidates?: number;
  },
) {
  const maxBytes = options?.maxBytes ?? MAX_WEBRTC_SDP_BYTES;
  const maxCandidates = options?.maxCandidates ?? MAX_WEBRTC_SDP_CANDIDATES;
  if (new TextEncoder().encode(sdp).byteLength > maxBytes) {
    return yield* new WebRtcCandidatePolicyError({ code: "sdp-too-large" });
  }
  const candidateCount = [...sdp.matchAll(SDP_CANDIDATE_PATTERN)].length;
  if (candidateCount > maxCandidates) {
    return yield* new WebRtcCandidatePolicyError({ code: "too-many-candidates" });
  }
});
