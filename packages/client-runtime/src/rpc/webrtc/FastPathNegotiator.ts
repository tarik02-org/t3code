import {
  type EnvironmentId,
  type ServerConfig,
  WebRtcBindingFrame,
  type WebRtcRpcFastPathCapability,
  WS_METHODS,
} from "@t3tools/contracts";
import {
  validateIceServers,
  validateSessionDescription,
} from "@t3tools/shared/webrtcCandidatePolicy";
import {
  makeWebRtcDataChannelConnection,
  type WebRtcDataChannelConnection,
} from "@t3tools/shared/webrtcDataChannel";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as RpcClient from "effect/unstable/rpc/RpcClient";
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization";
import * as Socket from "effect/unstable/socket/Socket";

import type { WebRtcPeerFactoryService } from "../../platform/capabilities.ts";
import { makeWsRpcProtocolClient, type WsRpcProtocolClient } from "../protocol.ts";

const FAST_PATH_NEGOTIATION_TIMEOUT = "10 seconds";
let nextAttemptId = 0;

export const WebRtcFastPathFallbackReason = Schema.Literals([
  "invalid-capability",
  "offer-failed",
  "signaling-rejected",
  "invalid-answer",
  "datachannel-failed",
  "binding-failed",
  "rpc-probe-failed",
  "identity-mismatch",
  "timeout",
]);
export type WebRtcFastPathFallbackReason = typeof WebRtcFastPathFallbackReason.Type;

export class WebRtcFastPathNegotiationError extends Schema.TaggedErrorClass<WebRtcFastPathNegotiationError>()(
  "WebRtcFastPathNegotiationError",
  { reason: WebRtcFastPathFallbackReason, cause: Schema.optionalKey(Schema.Defect()) },
) {
  override get message(): string {
    return `WebRTC fast path negotiation failed: ${this.reason}.`;
  }
}

export class WebRtcFastPathTransportClosedError extends Schema.TaggedErrorClass<WebRtcFastPathTransportClosedError>()(
  "WebRtcFastPathTransportClosedError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "WebRTC fast path transport closed.";
  }
}

export interface NegotiatedWebRtcFastPath {
  readonly client: WsRpcProtocolClient;
  readonly initialConfig: ServerConfig;
  readonly closed: Effect.Effect<never, WebRtcFastPathTransportClosedError>;
  readonly close: Effect.Effect<void>;
}

const encodeBindingFrame = Schema.encodeSync(Schema.fromJsonString(WebRtcBindingFrame));

function makeRtcRpcClient(
  connection: WebRtcDataChannelConnection,
): Effect.Effect<WsRpcProtocolClient, never, Scope.Scope> {
  const protocolLayer = Layer.effect(
    RpcClient.Protocol,
    RpcClient.makeProtocolSocket({
      retryTransientErrors: false,
    }),
  ).pipe(
    Layer.provide(
      Layer.mergeAll(Layer.succeed(Socket.Socket, connection.socket), RpcSerialization.layerJson),
    ),
  );
  return Effect.gen(function* () {
    const protocolContext = yield* Layer.build(protocolLayer);
    return yield* makeWsRpcProtocolClient.pipe(Effect.provide(protocolContext));
  });
}

export const negotiateWebRtcFastPath = Effect.fn("RpcSession.negotiateWebRtcFastPath")(
  function* (options: {
    readonly environmentId: EnvironmentId;
    readonly capability: WebRtcRpcFastPathCapability;
    readonly controlClient: WsRpcProtocolClient;
    readonly peerFactory: WebRtcPeerFactoryService;
  }) {
    const parentScope = yield* Scope.Scope;
    const attemptScope = yield* Scope.make();
    yield* Scope.addFinalizer(parentScope, Scope.close(attemptScope, Exit.void));
    nextAttemptId = nextAttemptId === Number.MAX_SAFE_INTEGER ? 1 : nextAttemptId + 1;
    const attemptId = `webrtc-${nextAttemptId}`;
    let signalingStarted = false;

    const abort = options.controlClient[WS_METHODS.transportWebRtcAbort]({
      attemptId,
    }).pipe(Effect.ignore);
    const cleanup = Scope.close(attemptScope, Exit.void).pipe(
      Effect.andThen(Effect.suspend(() => (signalingStarted ? abort : Effect.void))),
    );

    const negotiate = Effect.gen(function* () {
      const startedAtMs = yield* Clock.currentTimeMillis;
      const iceServers = yield* validateIceServers(options.capability.iceServers).pipe(
        Effect.mapError(
          (cause) => new WebRtcFastPathNegotiationError({ reason: "invalid-capability", cause }),
        ),
      );
      const peer = yield* options.peerFactory
        .create(iceServers)
        .pipe(
          Effect.mapError(
            (cause) => new WebRtcFastPathNegotiationError({ reason: "offer-failed", cause }),
          ),
        );
      const offerSdp = yield* peer.createOffer.pipe(
        Effect.mapError(
          (cause) => new WebRtcFastPathNegotiationError({ reason: "offer-failed", cause }),
        ),
      );
      yield* validateSessionDescription(offerSdp).pipe(
        Effect.mapError(
          (cause) => new WebRtcFastPathNegotiationError({ reason: "offer-failed", cause }),
        ),
      );
      signalingStarted = true;
      const answer = yield* options.controlClient[WS_METHODS.transportWebRtcNegotiate]({
        version: 1,
        attemptId,
        offerSdp,
      }).pipe(
        Effect.mapError(
          (cause) => new WebRtcFastPathNegotiationError({ reason: "signaling-rejected", cause }),
        ),
      );
      if (answer.attemptId !== attemptId) {
        return yield* new WebRtcFastPathNegotiationError({ reason: "invalid-answer" });
      }
      yield* validateSessionDescription(answer.answerSdp).pipe(
        Effect.mapError(
          (cause) => new WebRtcFastPathNegotiationError({ reason: "invalid-answer", cause }),
        ),
      );
      yield* peer
        .acceptAnswer(answer.answerSdp)
        .pipe(
          Effect.mapError(
            (cause) => new WebRtcFastPathNegotiationError({ reason: "invalid-answer", cause }),
          ),
        );
      const dataChannelStartedAtMs = yield* Clock.currentTimeMillis;
      const dataChannel = yield* makeWebRtcDataChannelConnection(peer.dataChannel).pipe(
        Effect.mapError(
          (cause) => new WebRtcFastPathNegotiationError({ reason: "datachannel-failed", cause }),
        ),
      );
      yield* dataChannel.awaitOpen.pipe(
        Effect.mapError(
          (cause) => new WebRtcFastPathNegotiationError({ reason: "datachannel-failed", cause }),
        ),
      );
      const dataChannelOpenedAtMs = yield* Clock.currentTimeMillis;
      yield* dataChannel
        .sendBinding(
          new TextEncoder().encode(
            encodeBindingFrame({
              version: 1,
              attemptId,
              bindingToken: answer.bindingToken,
            }),
          ),
        )
        .pipe(
          Effect.mapError(
            (cause) => new WebRtcFastPathNegotiationError({ reason: "binding-failed", cause }),
          ),
        );
      yield* dataChannel.awaitBindingAck.pipe(
        Effect.mapError(
          (cause) => new WebRtcFastPathNegotiationError({ reason: "binding-failed", cause }),
        ),
      );
      const client = yield* makeRtcRpcClient(dataChannel);
      yield* client[WS_METHODS.serverProbe]({}).pipe(
        Effect.mapError(
          (cause) => new WebRtcFastPathNegotiationError({ reason: "rpc-probe-failed", cause }),
        ),
      );
      const initialConfig = yield* client[WS_METHODS.serverGetConfig]({}).pipe(
        Effect.mapError(
          (cause) => new WebRtcFastPathNegotiationError({ reason: "rpc-probe-failed", cause }),
        ),
      );
      if (initialConfig.environment.environmentId !== options.environmentId) {
        return yield* new WebRtcFastPathNegotiationError({ reason: "identity-mismatch" });
      }
      const selectedAtMs = yield* Clock.currentTimeMillis;
      yield* Effect.logDebug("Selected WebRTC RPC fast path.").pipe(
        Effect.annotateLogs({
          "rpc.transport": "webrtc",
          "webrtc.attempt.result": "selected",
          "webrtc.negotiation_ms": selectedAtMs - startedAtMs,
          "webrtc.datachannel_open_ms": dataChannelOpenedAtMs - dataChannelStartedAtMs,
        }),
      );
      yield* Effect.addFinalizer(() =>
        Effect.all({
          stats: dataChannel.stats,
          selectedIcePairType: peer.selectedIcePairType.pipe(Effect.orElseSucceed(() => null)),
        }).pipe(
          Effect.flatMap(({ stats, selectedIcePairType }) =>
            Effect.logDebug("WebRTC RPC fast path closed.").pipe(
              Effect.annotateLogs({
                "rpc.transport": "webrtc",
                "webrtc.bytes_sent": stats.bytesSent,
                "webrtc.bytes_received": stats.bytesReceived,
                ...(selectedIcePairType === null
                  ? {}
                  : { "webrtc.selected_ice_pair_type": selectedIcePairType }),
              }),
            ),
          ),
        ),
      );
      const closed = Effect.raceFirst(peer.closed, dataChannel.closed).pipe(
        Effect.mapError((cause) => new WebRtcFastPathTransportClosedError({ cause })),
      );
      const close = Effect.all([peer.close, dataChannel.close], {
        discard: true,
        concurrency: "unbounded",
      });
      return {
        client,
        initialConfig,
        closed,
        close,
      } satisfies NegotiatedWebRtcFastPath;
    }).pipe(
      Scope.provide(attemptScope),
      Effect.timeoutOrElse({
        duration: FAST_PATH_NEGOTIATION_TIMEOUT,
        orElse: () => Effect.fail(new WebRtcFastPathNegotiationError({ reason: "timeout" })),
      }),
    );

    return yield* negotiate.pipe(
      Effect.tapError(() => cleanup),
      Effect.onInterrupt(() => cleanup),
    );
  },
);
