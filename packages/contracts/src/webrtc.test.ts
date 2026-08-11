import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { WebRtcRpcFastPathCapability } from "./webrtc.ts";

const decodeWebRtcRpcFastPathCapability = Schema.decodeUnknownSync(WebRtcRpcFastPathCapability);

describe("WebRtcRpcFastPathCapability", () => {
  it("decodes the current configurable ICE server shape", () => {
    const capability = decodeWebRtcRpcFastPathCapability({
      version: 1,
      signaling: "same-websocket-rpc",
      iceServers: [
        { urls: ["stun:stun.example.test"] },
        {
          urls: ["turn:turn.example.test"],
          username: "user",
          credential: "secret",
        },
      ],
    });

    expect(capability.iceServers).toEqual([
      { urls: ["stun:stun.example.test"] },
      {
        urls: ["turn:turn.example.test"],
        username: "user",
        credential: "secret",
      },
    ]);
  });

  it("normalizes the original STUN-only v1 shape", () => {
    const capability = decodeWebRtcRpcFastPathCapability({
      version: 1,
      signaling: "same-websocket-rpc",
      turn: false,
      stunUrls: ["stun:stun.example.test", "stun:backup.example.test"],
    });

    expect(capability).toEqual({
      version: 1,
      signaling: "same-websocket-rpc",
      iceServers: [
        {
          urls: ["stun:stun.example.test", "stun:backup.example.test"],
        },
      ],
    });
  });
});
