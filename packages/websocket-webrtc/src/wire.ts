import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { ClientWebRtcPeerFactory, WebRtcIceServer } from "./peer.ts";

export const UPGRADE_QUERY_PARAMETER = "__t3_wsrtc";
export const PROTOCOL_VERSION = 1;
export const DATA_CHANNEL_LABEL = "t3-websocket-v1";

const NONCE_BYTE_LENGTH = 16;
const NONCE_TEXT_LENGTH = 22;
const CONTROL_PREFIX = "\u001et3-wsrtc-v1:";
const DATA_MAGIC = new TextEncoder().encode("T3WRTC01");
const DATA_KIND = 1;
const DATA_HEADER_LENGTH = DATA_MAGIC.byteLength + NONCE_TEXT_LENGTH + 1 + 1 + 8 + 2 + 2;
const MAX_DATA_CHANNEL_MESSAGE_BYTES = 16 * 1024;
const MAX_FRAGMENT_PAYLOAD_BYTES = MAX_DATA_CHANNEL_MESSAGE_BYTES - DATA_HEADER_LENGTH;
const MAX_APPLICATION_MESSAGE_BYTES = 16 * 1024 * 1024;
const MAX_FRAGMENT_COUNT = Math.ceil(MAX_APPLICATION_MESSAGE_BYTES / MAX_FRAGMENT_PAYLOAD_BYTES);
const MAX_SEQUENCE = 2n ** 64n - 1n;
const NONCE_PATTERN = /^[A-Za-z0-9_-]{22}$/;

const AttemptId = Schema.String.check(Schema.isLengthBetween(1, 128));
const SessionDescription = Schema.String.check(Schema.isLengthBetween(1, 1024 * 1024));
const BindingToken = Schema.String.check(Schema.isLengthBetween(1, 128));
const Sequence = Schema.String.check(Schema.isPattern(/^(0|[1-9][0-9]{0,19})$/));
const IceUrl = Schema.String.check(Schema.isLengthBetween(1, 2048));
const IceCredential = Schema.String.check(Schema.isMaxLength(512));

const WireIceServer = Schema.Struct({
  urls: Schema.Array(IceUrl).check(Schema.isLengthBetween(1, 16)),
  username: Schema.optionalKey(IceCredential),
  credential: Schema.optionalKey(IceCredential),
});

const Hello = Schema.Struct({
  kind: Schema.Literal("hello"),
  version: Schema.Literal(PROTOCOL_VERSION),
  iceServers: Schema.Array(WireIceServer).check(Schema.isMaxLength(32)),
});
const HelloAck = Schema.Struct({
  kind: Schema.Literal("hello-ack"),
  version: Schema.Literal(PROTOCOL_VERSION),
});
const FrameStart = Schema.Struct({
  kind: Schema.Literal("frame-start"),
  version: Schema.Literal(PROTOCOL_VERSION),
});
const FrameStartAck = Schema.Struct({
  kind: Schema.Literal("frame-start-ack"),
  version: Schema.Literal(PROTOCOL_VERSION),
});
const Offer = Schema.Struct({
  kind: Schema.Literal("offer"),
  attemptId: AttemptId,
  sdp: SessionDescription,
});
const Answer = Schema.Struct({
  kind: Schema.Literal("answer"),
  attemptId: AttemptId,
  sdp: SessionDescription,
  bindingToken: BindingToken,
});
const Abort = Schema.Struct({
  kind: Schema.Literal("abort"),
  attemptId: AttemptId,
});
const Bind = Schema.Struct({
  kind: Schema.Literal("bind"),
  attemptId: AttemptId,
  bindingToken: BindingToken,
});
const BindAck = Schema.Struct({
  kind: Schema.Literal("bind-ack"),
  attemptId: AttemptId,
});
const Cutover = Schema.Struct({
  kind: Schema.Literal("cutover"),
  attemptId: AttemptId,
});
const CutoverAck = Schema.Struct({
  kind: Schema.Literal("cutover-ack"),
  attemptId: AttemptId,
});
const Fallback = Schema.Struct({
  kind: Schema.Literal("fallback"),
  attemptId: AttemptId,
});
const Ack = Schema.Struct({
  kind: Schema.Literal("ack"),
  nextSequence: Sequence,
});

export const ControlMessage = Schema.Union([
  Hello,
  HelloAck,
  FrameStart,
  FrameStartAck,
  Offer,
  Answer,
  Abort,
  Bind,
  BindAck,
  Cutover,
  CutoverAck,
  Fallback,
  Ack,
]);
export type ControlMessage = typeof ControlMessage.Type;

const ControlMessageJson = Schema.fromJsonString(ControlMessage);
const encodeControlJson = Schema.encodeSync(ControlMessageJson);
const decodeControlJson = Schema.decodeUnknownEffect(ControlMessageJson);

export class WebRtcWireError extends Schema.TaggedErrorClass<WebRtcWireError>()("WebRtcWireError", {
  reason: Schema.Literals([
    "invalid-control",
    "invalid-data-frame",
    "message-too-large",
    "sequence-exhausted",
    "invalid-url",
  ]),
  cause: Schema.optionalKey(Schema.Defect()),
}) {
  override get message(): string {
    return `WebRTC WebSocket wire protocol failed: ${this.reason}.`;
  }
}

export interface PreparedUpgradeUrl {
  readonly url: string;
  readonly nonce: string;
}

export const prepareUpgradeUrl = Effect.fn("WebRtcWebSocket.prepareUpgradeUrl")(function* (
  url: string,
  peerFactory: ClientWebRtcPeerFactory,
) {
  const nonceBytes = yield* peerFactory.randomBytes(NONCE_BYTE_LENGTH);
  const nonce = Encoding.encodeBase64Url(nonceBytes);
  const parsed = yield* Effect.try({
    try: () => new URL(url),
    catch: (cause) => new WebRtcWireError({ reason: "invalid-url", cause }),
  });
  parsed.searchParams.set(UPGRADE_QUERY_PARAMETER, `${PROTOCOL_VERSION}.${nonce}`);
  return { url: parsed.toString(), nonce } satisfies PreparedUpgradeUrl;
});

export function readUpgradeNonce(url: URL): string | null {
  const marker = url.searchParams.get(UPGRADE_QUERY_PARAMETER);
  if (marker === null) {
    return null;
  }
  const prefix = `${PROTOCOL_VERSION}.`;
  if (!marker.startsWith(prefix)) {
    return null;
  }
  const nonce = marker.slice(prefix.length);
  return NONCE_PATTERN.test(nonce) ? nonce : null;
}

export function encodeControl(nonce: string, message: ControlMessage): string {
  return `${CONTROL_PREFIX}${nonce}:${encodeControlJson(message)}`;
}

export function decodeControl(
  nonce: string,
  data: string | Uint8Array,
): Effect.Effect<Option.Option<ControlMessage>, WebRtcWireError> {
  const text = typeof data === "string" ? data : new TextDecoder().decode(data);
  const prefix = `${CONTROL_PREFIX}${nonce}:`;
  if (!text.startsWith(prefix)) {
    return Effect.succeed(Option.none());
  }
  return decodeControlJson(text.slice(prefix.length)).pipe(
    Effect.map(Option.some),
    Effect.mapError((cause) => new WebRtcWireError({ reason: "invalid-control", cause })),
  );
}

export interface ApplicationFragment {
  readonly sequence: bigint;
  readonly text: boolean;
  readonly fragmentIndex: number;
  readonly fragmentCount: number;
  readonly payload: Uint8Array;
}

function hasDataPrefix(nonce: string, data: Uint8Array): boolean {
  if (data.byteLength < DATA_MAGIC.byteLength + NONCE_TEXT_LENGTH) {
    return false;
  }
  for (let index = 0; index < DATA_MAGIC.byteLength; index += 1) {
    if (data[index] !== DATA_MAGIC[index]) {
      return false;
    }
  }
  const encodedNonce = new TextDecoder().decode(
    data.subarray(DATA_MAGIC.byteLength, DATA_MAGIC.byteLength + NONCE_TEXT_LENGTH),
  );
  return encodedNonce === nonce;
}

export function encodeApplicationFrames(
  nonce: string,
  sequence: bigint,
  chunk: string | Uint8Array,
): Effect.Effect<ReadonlyArray<Uint8Array>, WebRtcWireError> {
  if (sequence < 0n || sequence > MAX_SEQUENCE) {
    return Effect.fail(new WebRtcWireError({ reason: "sequence-exhausted" }));
  }
  const payload = typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk;
  if (payload.byteLength > MAX_APPLICATION_MESSAGE_BYTES) {
    return Effect.fail(new WebRtcWireError({ reason: "message-too-large" }));
  }
  const fragmentCount = Math.max(1, Math.ceil(payload.byteLength / MAX_FRAGMENT_PAYLOAD_BYTES));
  if (fragmentCount > 65_535) {
    return Effect.fail(new WebRtcWireError({ reason: "message-too-large" }));
  }
  const nonceBytes = new TextEncoder().encode(nonce);
  const frames: Array<Uint8Array> = [];
  for (let fragmentIndex = 0; fragmentIndex < fragmentCount; fragmentIndex += 1) {
    const start = fragmentIndex * MAX_FRAGMENT_PAYLOAD_BYTES;
    const end = Math.min(payload.byteLength, start + MAX_FRAGMENT_PAYLOAD_BYTES);
    const frame = new Uint8Array(DATA_HEADER_LENGTH + end - start);
    frame.set(DATA_MAGIC, 0);
    frame.set(nonceBytes, DATA_MAGIC.byteLength);
    const view = new DataView(frame.buffer);
    const kindOffset = DATA_MAGIC.byteLength + NONCE_TEXT_LENGTH;
    view.setUint8(kindOffset, DATA_KIND);
    view.setUint8(kindOffset + 1, typeof chunk === "string" ? 1 : 0);
    view.setBigUint64(kindOffset + 2, sequence);
    view.setUint16(kindOffset + 10, fragmentIndex);
    view.setUint16(kindOffset + 12, fragmentCount);
    frame.set(payload.subarray(start, end), DATA_HEADER_LENGTH);
    frames.push(frame);
  }
  return Effect.succeed(frames);
}

export function decodeApplicationFrame(
  nonce: string,
  data: Uint8Array,
): Effect.Effect<Option.Option<ApplicationFragment>, WebRtcWireError> {
  if (!hasDataPrefix(nonce, data)) {
    return Effect.succeed(Option.none());
  }
  if (data.byteLength < DATA_HEADER_LENGTH || data.byteLength > MAX_DATA_CHANNEL_MESSAGE_BYTES) {
    return Effect.fail(new WebRtcWireError({ reason: "invalid-data-frame" }));
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const kindOffset = DATA_MAGIC.byteLength + NONCE_TEXT_LENGTH;
  const kind = view.getUint8(kindOffset);
  const textFlag = view.getUint8(kindOffset + 1);
  const fragmentIndex = view.getUint16(kindOffset + 10);
  const fragmentCount = view.getUint16(kindOffset + 12);
  if (
    kind !== DATA_KIND ||
    (textFlag !== 0 && textFlag !== 1) ||
    fragmentCount === 0 ||
    fragmentCount > MAX_FRAGMENT_COUNT ||
    fragmentIndex >= fragmentCount
  ) {
    return Effect.fail(new WebRtcWireError({ reason: "invalid-data-frame" }));
  }
  return Effect.succeed(
    Option.some({
      sequence: view.getBigUint64(kindOffset + 2),
      text: textFlag === 1,
      fragmentIndex,
      fragmentCount,
      payload: data.slice(DATA_HEADER_LENGTH),
    }),
  );
}

export function wireIceServers(
  iceServers: ReadonlyArray<WebRtcIceServer>,
): ReadonlyArray<WebRtcIceServer> {
  return iceServers.map((server) => ({
    urls: [...server.urls],
    ...(server.username === undefined ? {} : { username: server.username }),
    ...(server.credential === undefined ? {} : { credential: server.credential }),
  }));
}
