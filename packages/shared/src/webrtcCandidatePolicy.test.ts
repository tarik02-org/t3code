import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  validateIceServers,
  validateSessionDescription,
  validateStunUrls,
  validateTurnUrls,
  WebRtcCandidatePolicyError,
} from "./webrtcCandidatePolicy.ts";

describe("WebRTC ICE policy", () => {
  it.effect("accepts STUN URLs", () =>
    Effect.gen(function* () {
      expect(
        yield* validateStunUrls(["stun:stun.example.test:3478", "stuns:stun.example.test:5349"]),
      ).toEqual(["stun:stun.example.test:3478", "stuns:stun.example.test:5349"]);
    }),
  );

  it.effect("accepts TURN URLs", () =>
    Effect.gen(function* () {
      expect(
        yield* validateTurnUrls([
          "turn:turn.example.test:3478?transport=udp",
          "turns:turn.example.test:5349?transport=tcp",
        ]),
      ).toEqual([
        "turn:turn.example.test:3478?transport=udp",
        "turns:turn.example.test:5349?transport=tcp",
      ]);
    }),
  );

  it.effect("preserves TURN credentials in ICE server configuration", () =>
    Effect.gen(function* () {
      const iceServers = [
        { urls: ["stun:stun.example.test:3478"] },
        {
          urls: ["turn:turn.example.test:3478"],
          username: "test-user",
          credential: "test-credential",
        },
      ];

      expect(yield* validateIceServers(iceServers)).toEqual(iceServers);
    }),
  );

  it.effect("rejects a URL under the wrong environment setting", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(validateStunUrls(["turn:turn.example.test:3478"]));
      expect(error).toBeInstanceOf(WebRtcCandidatePolicyError);
      expect(error.code).toBe("unsupported-stun-url");
    }),
  );

  it.effect("rejects incomplete TURN credentials", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        validateIceServers([
          { urls: ["turn:turn.example.test:3478"], username: "missing-credential" },
        ]),
      );
      expect(error.code).toBe("incomplete-turn-credentials");
    }),
  );

  it.effect("allows relay candidates in SDP", () =>
    validateSessionDescription(
      "v=0\r\na=candidate:1 1 UDP 1677734910 203.0.113.1 50000 typ relay\r\n",
    ),
  );

  it.effect("rejects oversized SDP without throwing", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        validateSessionDescription("v=0\r\n", {
          maxBytes: 2,
        }),
      );
      expect(error.code).toBe("sdp-too-large");
    }),
  );
});
