import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";

export interface WebRtcIceServer {
  readonly urls: ReadonlyArray<string>;
  readonly username?: string;
  readonly credential?: string;
}

export type WebRtcTransportKind = "websocket" | "webrtc";

export interface WebRtcDataChannelPort {
  readonly label: string;
  readonly ordered: boolean;
  readonly isOpen: () => boolean;
  readonly bufferedAmount: () => number;
  readonly send: (data: Uint8Array) => void;
  readonly close: () => void;
  readonly onOpen: (listener: () => void) => () => void;
  readonly onMessage: (listener: (data: Uint8Array) => void) => () => void;
  readonly onClose: (listener: () => void) => () => void;
  readonly onError: (listener: (cause: unknown) => void) => () => void;
}

export const WebRtcPeerErrorStage = Schema.Literals([
  "create",
  "offer",
  "answer",
  "ice-gathering",
  "connection",
  "data-channel",
  "signaling",
]);
export type WebRtcPeerErrorStage = typeof WebRtcPeerErrorStage.Type;

export class WebRtcPeerError extends Schema.TaggedErrorClass<WebRtcPeerError>()("WebRtcPeerError", {
  stage: WebRtcPeerErrorStage,
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return `WebRTC peer failed during ${this.stage}.`;
  }
}

export interface ClientWebRtcPeer {
  readonly dataChannel: WebRtcDataChannelPort;
  readonly createOffer: Effect.Effect<string, WebRtcPeerError>;
  readonly acceptAnswer: (answerSdp: string) => Effect.Effect<void, WebRtcPeerError>;
  readonly closed: Effect.Effect<never, WebRtcPeerError>;
  readonly close: Effect.Effect<void>;
}

export interface ClientWebRtcPeerFactory {
  readonly create: (
    iceServers: ReadonlyArray<WebRtcIceServer>,
  ) => Effect.Effect<ClientWebRtcPeer, WebRtcPeerError, Scope.Scope>;
  readonly randomBytes: (size: number) => Effect.Effect<Uint8Array, WebRtcPeerError>;
}

export class WebRtcClientPlatform extends Context.Reference<ClientWebRtcPeerFactory | null>(
  "@t3tools/websocket-webrtc/WebRtcClientPlatform",
  {
    defaultValue: () => null,
  },
) {}

export interface ServerWebRtcPeer {
  readonly acceptOffer: (offerSdp: string) => Effect.Effect<string, WebRtcPeerError>;
  readonly dataChannel: Effect.Effect<WebRtcDataChannelPort, WebRtcPeerError>;
  readonly closed: Effect.Effect<never, WebRtcPeerError>;
  readonly close: Effect.Effect<void>;
}

export interface ServerWebRtcPeerFactory {
  readonly create: (
    iceServers: ReadonlyArray<WebRtcIceServer>,
  ) => Effect.Effect<ServerWebRtcPeer, WebRtcPeerError, Scope.Scope>;
  readonly randomBytes: (size: number) => Effect.Effect<Uint8Array, WebRtcPeerError>;
}
