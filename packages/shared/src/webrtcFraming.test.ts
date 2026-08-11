import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  encodeWebRtcMessage,
  WEBRTC_RPC_FRAGMENT_PAYLOAD_BYTES,
  WEBRTC_RPC_MAX_MESSAGE_BYTES,
  WebRtcFramingError,
  WebRtcMessageReassembler,
} from "./webrtcFraming.ts";

const reassemble = Effect.fn("WebRtcFraming.test.reassemble")(function* (
  frames: ReadonlyArray<Uint8Array>,
) {
  const reassembler = new WebRtcMessageReassembler();
  let result = null;
  for (const frame of frames) {
    result = yield* reassembler.push(frame, 0);
  }
  return result;
});

describe("WebRTC RPC framing", () => {
  it.effect("fragments and reassembles a large RPC message", () =>
    Effect.gen(function* () {
      const payload = new Uint8Array(WEBRTC_RPC_FRAGMENT_PAYLOAD_BYTES * 3 + 41);
      payload.fill(77);
      const frames = yield* encodeWebRtcMessage({ kind: "rpc", messageId: 1, payload });

      expect(frames).toHaveLength(4);
      expect(yield* reassemble(frames)).toEqual({ kind: "rpc", messageId: 1, payload });
    }),
  );

  it.effect("reassembles sequential messages", () =>
    Effect.gen(function* () {
      const decoder = new WebRtcMessageReassembler();
      const first = new TextEncoder().encode("first");
      const second = new TextEncoder().encode("second");
      const firstFrames = yield* encodeWebRtcMessage({
        kind: "rpc",
        messageId: 1,
        payload: first,
      });
      const secondFrames = yield* encodeWebRtcMessage({
        kind: "rpc",
        messageId: 2,
        payload: second,
      });

      expect(yield* decoder.push(firstFrames[0]!, 0)).toEqual({
        kind: "rpc",
        messageId: 1,
        payload: first,
      });
      expect(yield* decoder.push(secondFrames[0]!, 0)).toEqual({
        kind: "rpc",
        messageId: 2,
        payload: second,
      });
    }),
  );

  it.effect("rejects malformed, overlapping, duplicate, and oversized frames", () =>
    Effect.gen(function* () {
      const payload = new Uint8Array(WEBRTC_RPC_FRAGMENT_PAYLOAD_BYTES + 5);
      const frames = yield* encodeWebRtcMessage({ kind: "rpc", messageId: 5, payload });
      const malformed = frames[0]!.slice(0, 8);
      expect(yield* Effect.flip(new WebRtcMessageReassembler().push(malformed, 0))).toBeInstanceOf(
        WebRtcFramingError,
      );

      const overlapping = frames[1]!.slice();
      new DataView(overlapping.buffer).setUint32(16, 1);
      const overlapDecoder = new WebRtcMessageReassembler();
      yield* overlapDecoder.push(frames[0]!, 0);
      expect(yield* Effect.flip(overlapDecoder.push(overlapping, 0))).toBeInstanceOf(
        WebRtcFramingError,
      );

      const duplicateDecoder = new WebRtcMessageReassembler();
      for (const frame of frames) {
        yield* duplicateDecoder.push(frame, 0);
      }
      expect(yield* Effect.flip(duplicateDecoder.push(frames[0]!, 0))).toBeInstanceOf(
        WebRtcFramingError,
      );

      expect(
        yield* Effect.flip(
          encodeWebRtcMessage({
            kind: "rpc",
            messageId: 9,
            payload: new Uint8Array(WEBRTC_RPC_MAX_MESSAGE_BYTES + 1),
          }),
        ),
      ).toBeInstanceOf(WebRtcFramingError);
    }),
  );

  it.effect("expires partial messages", () =>
    Effect.gen(function* () {
      const decoder = new WebRtcMessageReassembler({ partialTtlMs: 10 });
      const partial = yield* encodeWebRtcMessage({
        kind: "rpc",
        messageId: 1,
        payload: new Uint8Array(WEBRTC_RPC_FRAGMENT_PAYLOAD_BYTES + 1),
      });
      const next = yield* encodeWebRtcMessage({
        kind: "rpc",
        messageId: 2,
        payload: new Uint8Array([1]),
      });

      expect(yield* decoder.push(partial[0]!, 0)).toBeNull();
      expect(yield* Effect.flip(decoder.push(next[0]!, 11))).toBeInstanceOf(WebRtcFramingError);
    }),
  );
});
