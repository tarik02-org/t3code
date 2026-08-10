import { describe, expect, it } from "@effect/vitest";

import {
  encodeWebRtcMessage,
  WEBRTC_RPC_FRAGMENT_PAYLOAD_BYTES,
  WEBRTC_RPC_MAX_MESSAGE_BYTES,
  WebRtcFramingError,
  WebRtcMessageReassembler,
} from "./webrtcFraming.ts";

function reassemble(frames: ReadonlyArray<Uint8Array>) {
  const reassembler = new WebRtcMessageReassembler();
  let result = null;
  for (const frame of frames) {
    result = reassembler.push(frame, 0);
  }
  return result;
}

describe("WebRTC RPC framing", () => {
  it("fragments and reassembles a large RPC message", () => {
    const payload = new Uint8Array(WEBRTC_RPC_FRAGMENT_PAYLOAD_BYTES * 3 + 41);
    payload.fill(77);
    const frames = encodeWebRtcMessage({ kind: "rpc", messageId: 1, payload });

    expect(frames).toHaveLength(4);
    expect(reassemble(frames)).toEqual({ kind: "rpc", messageId: 1, payload });
  });

  it("reassembles sequential messages", () => {
    const decoder = new WebRtcMessageReassembler();
    const first = new TextEncoder().encode("first");
    const second = new TextEncoder().encode("second");

    expect(
      decoder.push(encodeWebRtcMessage({ kind: "rpc", messageId: 1, payload: first })[0]!, 0),
    ).toEqual({ kind: "rpc", messageId: 1, payload: first });
    expect(
      decoder.push(encodeWebRtcMessage({ kind: "rpc", messageId: 2, payload: second })[0]!, 0),
    ).toEqual({ kind: "rpc", messageId: 2, payload: second });
  });

  it("rejects malformed, overlapping, duplicate, and oversized frames", () => {
    const payload = new Uint8Array(WEBRTC_RPC_FRAGMENT_PAYLOAD_BYTES + 5);
    const frames = encodeWebRtcMessage({ kind: "rpc", messageId: 5, payload });
    const malformed = frames[0]!.slice(0, 8);
    expect(() => new WebRtcMessageReassembler().push(malformed, 0)).toThrowError(
      WebRtcFramingError,
    );

    const overlapping = frames[1]!.slice();
    new DataView(overlapping.buffer).setUint32(16, 1);
    const overlapDecoder = new WebRtcMessageReassembler();
    overlapDecoder.push(frames[0]!, 0);
    expect(() => overlapDecoder.push(overlapping, 0)).toThrowError(WebRtcFramingError);

    const duplicateDecoder = new WebRtcMessageReassembler();
    for (const frame of frames) {
      duplicateDecoder.push(frame, 0);
    }
    expect(() => duplicateDecoder.push(frames[0]!, 0)).toThrowError(WebRtcFramingError);

    expect(() =>
      encodeWebRtcMessage({
        kind: "rpc",
        messageId: 9,
        payload: new Uint8Array(WEBRTC_RPC_MAX_MESSAGE_BYTES + 1),
      }),
    ).toThrowError(WebRtcFramingError);
  });

  it("expires partial messages", () => {
    const decoder = new WebRtcMessageReassembler({ partialTtlMs: 10 });
    const partial = encodeWebRtcMessage({
      kind: "rpc",
      messageId: 1,
      payload: new Uint8Array(WEBRTC_RPC_FRAGMENT_PAYLOAD_BYTES + 1),
    });
    const next = encodeWebRtcMessage({
      kind: "rpc",
      messageId: 2,
      payload: new Uint8Array([1]),
    });

    expect(decoder.push(partial[0]!, 0)).toBeNull();
    expect(() => decoder.push(next[0]!, 11)).toThrowError(WebRtcFramingError);
  });
});
