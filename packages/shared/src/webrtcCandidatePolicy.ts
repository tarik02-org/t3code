export const DEFAULT_WEBRTC_STUN_URLS = ["stun:stun.cloudflare.com:3478"] as const;

export const MAX_WEBRTC_SDP_BYTES = 256 * 1024;
export const MAX_WEBRTC_SDP_CANDIDATES = 128;

export type WebRtcCandidatePolicyErrorCode =
  | "turn-url"
  | "unsupported-url"
  | "relay-candidate"
  | "sdp-too-large"
  | "too-many-candidates";

export class WebRtcCandidatePolicyError extends Error {
  readonly code: WebRtcCandidatePolicyErrorCode;

  constructor(code: WebRtcCandidatePolicyErrorCode, message: string) {
    super(message);
    this.name = "WebRtcCandidatePolicyError";
    this.code = code;
  }
}

const STUN_URL_PATTERN = /^stuns?:[^\s]+$/i;
const TURN_URL_PATTERN = /^turns?:/i;
const RELAY_CANDIDATE_PATTERN = /(?:^|\s)typ\s+relay(?:\s|$)/i;
const SDP_CANDIDATE_PATTERN = /^a=candidate:/gm;

export function validateStunUrls(urls: ReadonlyArray<string>): ReadonlyArray<string> {
  return urls.map((value) => {
    const url = value.trim();
    if (TURN_URL_PATTERN.test(url)) {
      throw new WebRtcCandidatePolicyError("turn-url", "TURN URLs are not allowed.");
    }
    if (!STUN_URL_PATTERN.test(url)) {
      throw new WebRtcCandidatePolicyError(
        "unsupported-url",
        "WebRTC ICE servers must use the stun: or stuns: scheme.",
      );
    }
    return url;
  });
}

export function validateIceCandidate(candidate: string): void {
  if (RELAY_CANDIDATE_PATTERN.test(candidate)) {
    throw new WebRtcCandidatePolicyError(
      "relay-candidate",
      "Relay ICE candidates are not allowed.",
    );
  }
}

export function validateSessionDescription(
  sdp: string,
  options?: {
    readonly maxBytes?: number;
    readonly maxCandidates?: number;
  },
): void {
  const maxBytes = options?.maxBytes ?? MAX_WEBRTC_SDP_BYTES;
  const maxCandidates = options?.maxCandidates ?? MAX_WEBRTC_SDP_CANDIDATES;
  if (new TextEncoder().encode(sdp).byteLength > maxBytes) {
    throw new WebRtcCandidatePolicyError("sdp-too-large", "WebRTC SDP exceeds the size limit.");
  }
  const candidateCount = [...sdp.matchAll(SDP_CANDIDATE_PATTERN)].length;
  if (candidateCount > maxCandidates) {
    throw new WebRtcCandidatePolicyError(
      "too-many-candidates",
      "WebRTC SDP contains too many ICE candidates.",
    );
  }
  if (RELAY_CANDIDATE_PATTERN.test(sdp)) {
    throw new WebRtcCandidatePolicyError(
      "relay-candidate",
      "WebRTC SDP contains a relay ICE candidate.",
    );
  }
}
