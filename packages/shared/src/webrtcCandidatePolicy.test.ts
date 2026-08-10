import { describe, expect, it } from "@effect/vitest";

import {
  validateIceCandidate,
  validateSessionDescription,
  validateStunUrls,
  WebRtcCandidatePolicyError,
} from "./webrtcCandidatePolicy.ts";

describe("WebRTC no-TURN policy", () => {
  it("accepts STUN URLs", () => {
    expect(
      validateStunUrls(["stun:stun.example.test:3478", "stuns:stun.example.test:5349"]),
    ).toEqual(["stun:stun.example.test:3478", "stuns:stun.example.test:5349"]);
  });

  it.each(["turn:turn.example.test:3478", "turns:turn.example.test:5349"])(
    "rejects %s URLs",
    (url) => {
      expect(() => validateStunUrls([url])).toThrowError(WebRtcCandidatePolicyError);
    },
  );

  it("rejects relay candidates", () => {
    expect(() =>
      validateIceCandidate(
        "candidate:1 1 UDP 1677734910 203.0.113.1 50000 typ relay raddr 0.0.0.0 rport 0",
      ),
    ).toThrowError(WebRtcCandidatePolicyError);
  });

  it("rejects SDP containing relay candidates", () => {
    expect(() =>
      validateSessionDescription(
        "v=0\r\na=candidate:1 1 UDP 1677734910 203.0.113.1 50000 typ relay\r\n",
      ),
    ).toThrowError(WebRtcCandidatePolicyError);
  });
});
