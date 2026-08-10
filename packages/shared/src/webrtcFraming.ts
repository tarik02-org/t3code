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

export type WebRtcFramingErrorCode =
  | "frame-too-small"
  | "invalid-header"
  | "invalid-kind"
  | "invalid-flags"
  | "fragment-too-large"
  | "message-too-large"
  | "invalid-bounds"
  | "missing-start"
  | "duplicate-message"
  | "too-many-partials"
  | "partial-expired"
  | "overlapping-fragment"
  | "mismatched-message"
  | "invalid-control-frame";

export class WebRtcFramingError extends Error {
  readonly code: WebRtcFramingErrorCode;

  constructor(code: WebRtcFramingErrorCode, message: string) {
    super(message);
    this.name = "WebRtcFramingError";
    this.code = code;
  }
}

interface PartialMessage {
  readonly kind: WebRtcFrameKind;
  readonly totalLength: number;
  readonly createdAtMs: number;
  readonly chunks: Array<Uint8Array>;
  receivedLength: number;
}

function frameKindFromCode(code: number): WebRtcFrameKind {
  switch (code) {
    case 1:
      return "binding";
    case 2:
      return "binding-ack";
    case 3:
      return "rpc";
    default:
      throw new WebRtcFramingError("invalid-kind", "Unknown WebRTC frame kind.");
  }
}

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

export function encodeWebRtcMessage(input: {
  readonly kind: WebRtcFrameKind;
  readonly messageId: number;
  readonly payload: Uint8Array;
  readonly fragmentPayloadBytes?: number;
}): ReadonlyArray<Uint8Array> {
  const fragmentPayloadBytes = input.fragmentPayloadBytes ?? WEBRTC_RPC_FRAGMENT_PAYLOAD_BYTES;
  if (fragmentPayloadBytes <= 0 || fragmentPayloadBytes > WEBRTC_RPC_FRAGMENT_PAYLOAD_BYTES) {
    throw new WebRtcFramingError(
      "fragment-too-large",
      "WebRTC fragment payload size is outside the supported range.",
    );
  }
  if (input.payload.byteLength > WEBRTC_RPC_MAX_MESSAGE_BYTES) {
    throw new WebRtcFramingError("message-too-large", "WebRTC message exceeds the size limit.");
  }
  if (input.kind !== "rpc") {
    if (
      input.messageId !== 0 ||
      input.payload.byteLength > WEBRTC_BINDING_MAX_BYTES ||
      (input.kind === "binding-ack" && input.payload.byteLength !== 0)
    ) {
      throw new WebRtcFramingError(
        "invalid-control-frame",
        "WebRTC control frame has an invalid shape.",
      );
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
    throw new WebRtcFramingError("invalid-header", "WebRTC RPC message ID must be non-zero.");
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
}

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

  expirePartials(nowMs: number): void {
    let expired = false;
    for (const [messageId, partial] of this.#partials) {
      if (nowMs >= partial.createdAtMs + this.#partialTtlMs) {
        this.#partials.delete(messageId);
        expired = true;
      }
    }
    if (expired) {
      throw new WebRtcFramingError(
        "partial-expired",
        "WebRTC partial message exceeded its lifetime.",
      );
    }
  }

  push(frame: Uint8Array, nowMs: number): DecodedWebRtcMessage | null {
    this.expirePartials(nowMs);
    if (frame.byteLength < FRAME_HEADER_BYTES) {
      throw new WebRtcFramingError("frame-too-small", "WebRTC frame is shorter than its header.");
    }
    const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
    if (
      view.getUint32(0) !== FRAME_MAGIC ||
      view.getUint8(4) !== FRAME_VERSION ||
      view.getUint8(7) !== 0
    ) {
      throw new WebRtcFramingError("invalid-header", "WebRTC frame header is invalid.");
    }
    const kind = frameKindFromCode(view.getUint8(5));
    const flags = view.getUint8(6);
    if ((flags & ~KNOWN_FLAGS) !== 0) {
      throw new WebRtcFramingError("invalid-flags", "WebRTC frame has unknown flags.");
    }
    const start = (flags & START_FLAG) !== 0;
    const end = (flags & END_FLAG) !== 0;
    const control = (flags & CONTROL_FLAG) !== 0;
    if (control !== (kind !== "rpc")) {
      throw new WebRtcFramingError("invalid-flags", "WebRTC frame control flag is invalid.");
    }
    const messageId = view.getUint32(8);
    const totalLength = view.getUint32(12);
    const offset = view.getUint32(16);
    const payload = frame.subarray(FRAME_HEADER_BYTES);
    if (payload.byteLength > WEBRTC_RPC_FRAGMENT_PAYLOAD_BYTES) {
      throw new WebRtcFramingError("fragment-too-large", "WebRTC fragment exceeds the size limit.");
    }
    if (totalLength > this.#maxMessageBytes) {
      throw new WebRtcFramingError("message-too-large", "WebRTC message exceeds the size limit.");
    }
    if (offset > totalLength || payload.byteLength > totalLength - offset) {
      throw new WebRtcFramingError("invalid-bounds", "WebRTC fragment is out of bounds.");
    }
    const reachesEnd = offset + payload.byteLength === totalLength;
    if (start !== (offset === 0) || end !== reachesEnd) {
      throw new WebRtcFramingError("invalid-flags", "WebRTC fragment boundary flags are invalid.");
    }

    if (kind !== "rpc") {
      if (
        messageId !== 0 ||
        !start ||
        !end ||
        totalLength > WEBRTC_BINDING_MAX_BYTES ||
        (kind === "binding-ack" && totalLength !== 0)
      ) {
        throw new WebRtcFramingError(
          "invalid-control-frame",
          "WebRTC control frame has an invalid shape.",
        );
      }
      return { kind, messageId, payload: payload.slice() };
    }
    if (messageId === 0) {
      throw new WebRtcFramingError("invalid-header", "WebRTC RPC message ID must be non-zero.");
    }
    if (this.#completedMessageIds.has(messageId)) {
      throw new WebRtcFramingError("duplicate-message", "WebRTC message ID was already completed.");
    }

    let partial = this.#partials.get(messageId);
    if (partial === undefined) {
      if (!start) {
        throw new WebRtcFramingError("missing-start", "WebRTC message is missing its start frame.");
      }
      if (this.#partials.size >= this.#maxPartialMessages) {
        throw new WebRtcFramingError("too-many-partials", "WebRTC has too many partial messages.");
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
        throw new WebRtcFramingError("duplicate-message", "WebRTC message has a duplicate start.");
      }
      if (partial.kind !== kind || partial.totalLength !== totalLength) {
        throw new WebRtcFramingError(
          "mismatched-message",
          "WebRTC fragment does not match its partial message.",
        );
      }
    }
    if (offset !== partial.receivedLength) {
      throw new WebRtcFramingError(
        "overlapping-fragment",
        "WebRTC fragment overlaps or skips existing message data.",
      );
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
    return { kind: "rpc", messageId, payload: message };
  }
}
