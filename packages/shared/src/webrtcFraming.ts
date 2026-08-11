import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export const WEBRTC_RPC_FRAGMENT_PAYLOAD_BYTES = 12 * 1024;
export const WEBRTC_RPC_MAX_MESSAGE_BYTES = 8 * 1024 * 1024;
export const WEBRTC_RPC_MAX_PARTIAL_MESSAGES = 8;
export const WEBRTC_RPC_PARTIAL_TTL_MS = 30_000;
export const WEBRTC_BINDING_MAX_BYTES = 4 * 1024;

const FRAME_MAGIC = 0x54335243;
const FRAME_VERSION = 1;
const FRAME_HEADER_BYTES = 20;
const START_FLAG = 1;
const END_FLAG = 2;
const CONTROL_FLAG = 4;
const KNOWN_FLAGS = START_FLAG | END_FLAG | CONTROL_FLAG;
const COMPLETED_MESSAGE_IDS_LIMIT = 64;

export type WebRtcFrameKind = "binding" | "binding-ack" | "rpc";

const FRAME_KIND_TO_CODE = {
  binding: 1,
  "binding-ack": 2,
  rpc: 3,
} as const satisfies Readonly<Record<WebRtcFrameKind, number>>;

export interface DecodedWebRtcMessage {
  readonly kind: WebRtcFrameKind;
  readonly messageId: number;
  readonly payload: Uint8Array;
}

export const WebRtcFramingErrorCode = Schema.Literals([
  "frame-too-small",
  "invalid-header",
  "invalid-kind",
  "invalid-flags",
  "fragment-too-large",
  "message-too-large",
  "invalid-bounds",
  "missing-start",
  "duplicate-message",
  "too-many-partials",
  "partial-expired",
  "overlapping-fragment",
  "mismatched-message",
  "invalid-control-frame",
]);
export type WebRtcFramingErrorCode = typeof WebRtcFramingErrorCode.Type;

export class WebRtcFramingError extends Schema.TaggedErrorClass<WebRtcFramingError>()(
  "WebRtcFramingError",
  { code: WebRtcFramingErrorCode },
) {
  override get message(): string {
    switch (this.code) {
      case "frame-too-small":
        return "WebRTC frame is shorter than its header.";
      case "invalid-header":
        return "WebRTC frame header is invalid.";
      case "invalid-kind":
        return "Unknown WebRTC frame kind.";
      case "invalid-flags":
        return "WebRTC frame flags are invalid.";
      case "fragment-too-large":
        return "WebRTC fragment exceeds the size limit.";
      case "message-too-large":
        return "WebRTC message exceeds the size limit.";
      case "invalid-bounds":
        return "WebRTC fragment is out of bounds.";
      case "missing-start":
        return "WebRTC message is missing its start frame.";
      case "duplicate-message":
        return "WebRTC message contains duplicate data.";
      case "too-many-partials":
        return "WebRTC has too many partial messages.";
      case "partial-expired":
        return "WebRTC partial message exceeded its lifetime.";
      case "overlapping-fragment":
        return "WebRTC fragment overlaps or skips existing message data.";
      case "mismatched-message":
        return "WebRTC fragment does not match its partial message.";
      case "invalid-control-frame":
        return "WebRTC control frame has an invalid shape.";
      default: {
        const exhaustive: never = this.code;
        return exhaustive;
      }
    }
  }
}

interface PartialMessage {
  readonly kind: WebRtcFrameKind;
  readonly totalLength: number;
  readonly createdAtMs: number;
  readonly chunks: Array<Uint8Array>;
  receivedLength: number;
}

const frameKindFromCode = Effect.fn("WebRtcFraming.frameKindFromCode")(function* (code: number) {
  switch (code) {
    case 1:
      return "binding";
    case 2:
      return "binding-ack";
    case 3:
      return "rpc";
    default:
      return yield* new WebRtcFramingError({ code: "invalid-kind" });
  }
});

function makeFrame(input: {
  readonly kind: WebRtcFrameKind;
  readonly messageId: number;
  readonly totalLength: number;
  readonly offset: number;
  readonly payload: Uint8Array;
  readonly start: boolean;
  readonly end: boolean;
}): Uint8Array {
  const frame = new Uint8Array(FRAME_HEADER_BYTES + input.payload.byteLength);
  const view = new DataView(frame.buffer);
  view.setUint32(0, FRAME_MAGIC);
  view.setUint8(4, FRAME_VERSION);
  view.setUint8(5, FRAME_KIND_TO_CODE[input.kind]);
  view.setUint8(
    6,
    (input.start ? START_FLAG : 0) |
      (input.end ? END_FLAG : 0) |
      (input.kind === "rpc" ? 0 : CONTROL_FLAG),
  );
  view.setUint8(7, 0);
  view.setUint32(8, input.messageId);
  view.setUint32(12, input.totalLength);
  view.setUint32(16, input.offset);
  frame.set(input.payload, FRAME_HEADER_BYTES);
  return frame;
}

export const encodeWebRtcMessage = Effect.fn("WebRtcFraming.encodeMessage")(function* (input: {
  readonly kind: WebRtcFrameKind;
  readonly messageId: number;
  readonly payload: Uint8Array;
  readonly fragmentPayloadBytes?: number;
}) {
  const fragmentPayloadBytes = input.fragmentPayloadBytes ?? WEBRTC_RPC_FRAGMENT_PAYLOAD_BYTES;
  if (fragmentPayloadBytes <= 0 || fragmentPayloadBytes > WEBRTC_RPC_FRAGMENT_PAYLOAD_BYTES) {
    return yield* new WebRtcFramingError({ code: "fragment-too-large" });
  }
  if (input.payload.byteLength > WEBRTC_RPC_MAX_MESSAGE_BYTES) {
    return yield* new WebRtcFramingError({ code: "message-too-large" });
  }
  if (input.kind !== "rpc") {
    if (
      input.messageId !== 0 ||
      input.payload.byteLength > WEBRTC_BINDING_MAX_BYTES ||
      (input.kind === "binding-ack" && input.payload.byteLength !== 0)
    ) {
      return yield* new WebRtcFramingError({ code: "invalid-control-frame" });
    }
    return [
      makeFrame({
        kind: input.kind,
        messageId: 0,
        totalLength: input.payload.byteLength,
        offset: 0,
        payload: input.payload,
        start: true,
        end: true,
      }),
    ];
  }
  if (input.messageId === 0) {
    return yield* new WebRtcFramingError({ code: "invalid-header" });
  }
  if (input.payload.byteLength === 0) {
    return [
      makeFrame({
        kind: "rpc",
        messageId: input.messageId,
        totalLength: 0,
        offset: 0,
        payload: input.payload,
        start: true,
        end: true,
      }),
    ];
  }

  const frames: Array<Uint8Array> = [];
  for (let offset = 0; offset < input.payload.byteLength; offset += fragmentPayloadBytes) {
    const endOffset = Math.min(offset + fragmentPayloadBytes, input.payload.byteLength);
    frames.push(
      makeFrame({
        kind: "rpc",
        messageId: input.messageId,
        totalLength: input.payload.byteLength,
        offset,
        payload: input.payload.subarray(offset, endOffset),
        start: offset === 0,
        end: endOffset === input.payload.byteLength,
      }),
    );
  }
  return frames;
});

export class WebRtcMessageReassembler {
  readonly #maxMessageBytes: number;
  readonly #maxPartialMessages: number;
  readonly #partialTtlMs: number;
  readonly #partials = new Map<number, PartialMessage>();
  readonly #completedMessageIds = new Set<number>();
  readonly #completedMessageOrder: Array<number> = [];

  constructor(options?: {
    readonly maxMessageBytes?: number;
    readonly maxPartialMessages?: number;
    readonly partialTtlMs?: number;
  }) {
    this.#maxMessageBytes = options?.maxMessageBytes ?? WEBRTC_RPC_MAX_MESSAGE_BYTES;
    this.#maxPartialMessages = options?.maxPartialMessages ?? WEBRTC_RPC_MAX_PARTIAL_MESSAGES;
    this.#partialTtlMs = options?.partialTtlMs ?? WEBRTC_RPC_PARTIAL_TTL_MS;
  }

  nextPartialExpiryAtMs(): number | null {
    let nextExpiryAtMs: number | null = null;
    for (const partial of this.#partials.values()) {
      const expiresAtMs = partial.createdAtMs + this.#partialTtlMs;
      if (nextExpiryAtMs === null || expiresAtMs < nextExpiryAtMs) {
        nextExpiryAtMs = expiresAtMs;
      }
    }
    return nextExpiryAtMs;
  }

  readonly expirePartials = Effect.fn("WebRtcMessageReassembler.expirePartials")(function* (
    this: WebRtcMessageReassembler,
    nowMs: number,
  ) {
    let expired = false;
    for (const [messageId, partial] of this.#partials) {
      if (nowMs >= partial.createdAtMs + this.#partialTtlMs) {
        this.#partials.delete(messageId);
        expired = true;
      }
    }
    if (expired) {
      return yield* new WebRtcFramingError({ code: "partial-expired" });
    }
  });

  readonly push = Effect.fn("WebRtcMessageReassembler.push")(function* (
    this: WebRtcMessageReassembler,
    frame: Uint8Array,
    nowMs: number,
  ) {
    yield* this.expirePartials(nowMs);
    if (frame.byteLength < FRAME_HEADER_BYTES) {
      return yield* new WebRtcFramingError({ code: "frame-too-small" });
    }
    const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
    if (
      view.getUint32(0) !== FRAME_MAGIC ||
      view.getUint8(4) !== FRAME_VERSION ||
      view.getUint8(7) !== 0
    ) {
      return yield* new WebRtcFramingError({ code: "invalid-header" });
    }
    const kind = yield* frameKindFromCode(view.getUint8(5));
    const flags = view.getUint8(6);
    if ((flags & ~KNOWN_FLAGS) !== 0) {
      return yield* new WebRtcFramingError({ code: "invalid-flags" });
    }
    const start = (flags & START_FLAG) !== 0;
    const end = (flags & END_FLAG) !== 0;
    const control = (flags & CONTROL_FLAG) !== 0;
    if (control !== (kind !== "rpc")) {
      return yield* new WebRtcFramingError({ code: "invalid-flags" });
    }
    const messageId = view.getUint32(8);
    const totalLength = view.getUint32(12);
    const offset = view.getUint32(16);
    const payload = frame.subarray(FRAME_HEADER_BYTES);
    if (payload.byteLength > WEBRTC_RPC_FRAGMENT_PAYLOAD_BYTES) {
      return yield* new WebRtcFramingError({ code: "fragment-too-large" });
    }
    if (totalLength > this.#maxMessageBytes) {
      return yield* new WebRtcFramingError({ code: "message-too-large" });
    }
    if (offset > totalLength || payload.byteLength > totalLength - offset) {
      return yield* new WebRtcFramingError({ code: "invalid-bounds" });
    }
    const reachesEnd = offset + payload.byteLength === totalLength;
    if (start !== (offset === 0) || end !== reachesEnd) {
      return yield* new WebRtcFramingError({ code: "invalid-flags" });
    }

    if (kind !== "rpc") {
      if (
        messageId !== 0 ||
        !start ||
        !end ||
        totalLength > WEBRTC_BINDING_MAX_BYTES ||
        (kind === "binding-ack" && totalLength !== 0)
      ) {
        return yield* new WebRtcFramingError({ code: "invalid-control-frame" });
      }
      return { kind, messageId, payload: payload.slice() } satisfies DecodedWebRtcMessage;
    }
    if (messageId === 0) {
      return yield* new WebRtcFramingError({ code: "invalid-header" });
    }
    if (this.#completedMessageIds.has(messageId)) {
      return yield* new WebRtcFramingError({ code: "duplicate-message" });
    }

    let partial = this.#partials.get(messageId);
    if (partial === undefined) {
      if (!start) {
        return yield* new WebRtcFramingError({ code: "missing-start" });
      }
      if (this.#partials.size >= this.#maxPartialMessages) {
        return yield* new WebRtcFramingError({ code: "too-many-partials" });
      }
      partial = {
        kind,
        totalLength,
        createdAtMs: nowMs,
        chunks: [],
        receivedLength: 0,
      };
      this.#partials.set(messageId, partial);
    } else {
      if (start) {
        return yield* new WebRtcFramingError({ code: "duplicate-message" });
      }
      if (partial.kind !== kind || partial.totalLength !== totalLength) {
        return yield* new WebRtcFramingError({ code: "mismatched-message" });
      }
    }
    if (offset !== partial.receivedLength) {
      return yield* new WebRtcFramingError({ code: "overlapping-fragment" });
    }
    partial.chunks.push(payload.slice());
    partial.receivedLength += payload.byteLength;
    if (!end) {
      return null;
    }

    this.#partials.delete(messageId);
    const message = new Uint8Array(totalLength);
    let writeOffset = 0;
    for (const chunk of partial.chunks) {
      message.set(chunk, writeOffset);
      writeOffset += chunk.byteLength;
    }
    this.#completedMessageIds.add(messageId);
    this.#completedMessageOrder.push(messageId);
    if (this.#completedMessageOrder.length > COMPLETED_MESSAGE_IDS_LIMIT) {
      const oldest = this.#completedMessageOrder.shift();
      if (oldest !== undefined) {
        this.#completedMessageIds.delete(oldest);
      }
    }
    return { kind: "rpc", messageId, payload: message } satisfies DecodedWebRtcMessage;
  });
}
