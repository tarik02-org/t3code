import {
  type ServerConfig,
  type WebRtcRpcFastPathCapability,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as RpcClient from "effect/unstable/rpc/RpcClient";
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization";
import * as Socket from "effect/unstable/socket/Socket";

import { makeWsRpcProtocolClient, type WsRpcProtocolClient } from "./protocol.ts";
import { WebRtcPeerFactory, type WebRtcPeerFactoryService } from "../platform/capabilities.ts";
import {
  negotiateWebRtcFastPath,
  type NegotiatedWebRtcFastPath,
} from "./webrtc/FastPathNegotiator.ts";
import { WebRtcFastPathCooldown } from "./webrtc/cooldown.ts";
import type {
  ConnectionAttemptError,
  ConnectionTransientError,
  PreparedConnection,
} from "../connection/model.ts";
import {
  ConnectionBlockedError,
  ConnectionTransientError as ConnectionTransientErrorClass,
} from "../connection/model.ts";

const SOCKET_OPEN_TIMEOUT = "15 seconds";

export interface RpcSession {
  readonly client: WsRpcProtocolClient;
  readonly initialConfig: Effect.Effect<ServerConfig, ConnectionAttemptError>;
  readonly ready: Effect.Effect<void, ConnectionAttemptError>;
  readonly probe: Effect.Effect<void, ConnectionAttemptError>;
  readonly closed: Effect.Effect<never, ConnectionTransientError>;
  readonly transport?: "websocket" | "webrtc";
  readonly transportChanges?: Stream.Stream<"websocket" | "webrtc">;
}

export class RpcSessionFactory extends Context.Service<
  RpcSessionFactory,
  {
    readonly connect: (
      connection: PreparedConnection,
    ) => Effect.Effect<RpcSession, ConnectionAttemptError, Scope.Scope>;
  }
>()("@t3tools/client-runtime/rpc/session/RpcSessionFactory") {}

type InitialConfigError = Effect.Error<
  ReturnType<WsRpcProtocolClient[typeof WS_METHODS.serverGetConfig]>
>;
type ProbeError = Effect.Error<ReturnType<WsRpcProtocolClient[typeof WS_METHODS.serverProbe]>>;

function mapSessionRpcError(error: InitialConfigError | ProbeError): ConnectionAttemptError {
  switch (error._tag) {
    case "EnvironmentAuthorizationError":
      return new ConnectionBlockedError({
        reason: "permission",
        detail: error.message,
      });
    case "KeybindingsConfigParseError":
    case "ServerSettingsError":
      return new ConnectionTransientErrorClass({
        reason: "remote-unavailable",
        detail: error.message,
      });
    case "RpcClientError":
      return new ConnectionTransientErrorClass({
        reason: "transport",
        detail: error.message,
      });
  }
}

export const make = Effect.gen(function* () {
  const webSocketConstructor = yield* Socket.WebSocketConstructor;
  const webRtcPeerFactory = yield* WebRtcPeerFactory;
  const webRtcCooldown = new WebRtcFastPathCooldown();

  const connect = Effect.fnUntraced(function* (connection: PreparedConnection) {
    const scope = yield* Scope.Scope;
    yield* Effect.annotateCurrentSpan({
      "connection.environment.id": connection.environmentId,
    });

    const connected = yield* Deferred.make<void>();
    const disconnected = yield* Deferred.make<never, ConnectionTransientError>();
    const hooks = RpcClient.ConnectionHooks.of({
      onConnect: Deferred.succeed(connected, undefined).pipe(Effect.asVoid),
      onDisconnect: Deferred.isDone(connected).pipe(
        Effect.flatMap((wasConnected) =>
          Deferred.fail(
            disconnected,
            new ConnectionTransientErrorClass({
              reason: "transport",
              detail: wasConnected
                ? `${connection.label} disconnected.`
                : `${connection.label} could not establish a WebSocket connection.`,
            }),
          ),
        ),
        Effect.asVoid,
      ),
    });
    const socketLayer = Socket.layerWebSocket(connection.socketUrl, {
      openTimeout: SOCKET_OPEN_TIMEOUT,
    }).pipe(Layer.provide(Layer.succeed(Socket.WebSocketConstructor, webSocketConstructor)));
    const protocolLayer = Layer.effect(
      RpcClient.Protocol,
      RpcClient.makeProtocolSocket({
        retryTransientErrors: false,
        retryPolicy: Schedule.recurs(0),
      }),
    ).pipe(
      Layer.provide(
        Layer.mergeAll(
          socketLayer,
          RpcSerialization.layerJson,
          Layer.succeed(RpcClient.ConnectionHooks, hooks),
        ),
      ),
    );
    const protocolContext = yield* Layer.build(protocolLayer).pipe(
      Effect.withSpan("environment.websocket.connect"),
    );
    const controlClient = yield* makeWsRpcProtocolClient.pipe(Effect.provide(protocolContext));
    const controlInitialConfig = yield* Effect.cached(
      controlClient[WS_METHODS.serverGetConfig]({}).pipe(
        Effect.mapError(mapSessionRpcError),
        Effect.withSpan("environment.initialSync"),
      ),
    );

    interface SelectedTransport {
      readonly kind: "websocket" | "webrtc";
      readonly client: WsRpcProtocolClient;
      readonly initialConfig: Effect.Effect<ServerConfig, ConnectionAttemptError>;
      readonly closed: Effect.Effect<never, ConnectionTransientError>;
      readonly close: Effect.Effect<void>;
    }

    const upgradeComplete = yield* Deferred.make<void>();
    const selected = yield* SubscriptionRef.make<SelectedTransport>({
      kind: "websocket",
      client: controlClient,
      initialConfig: controlInitialConfig,
      closed: Deferred.await(disconnected),
      close: Effect.void,
    });

    const selectWebRtc = Effect.fn("RpcSession.selectWebRtc")(function* (
      peerFactory: WebRtcPeerFactoryService,
      capability: WebRtcRpcFastPathCapability,
    ) {
      const fastPath = yield* negotiateWebRtcFastPath({
        environmentId: connection.environmentId,
        capability,
        controlClient,
        peerFactory,
      }).pipe(
        Scope.provide(scope),
        Effect.matchEffect({
          onFailure: (error) =>
            Effect.logDebug("WebRTC RPC fast path fell back to WebSocket.").pipe(
              Effect.annotateLogs({
                "rpc.transport": "websocket",
                "webrtc.attempt.result": "fallback",
                "webrtc.fallback.reason": error.reason,
              }),
              Effect.as<NegotiatedWebRtcFastPath | null>(null),
            ),
          onSuccess: (fastPath) => Effect.succeed(fastPath),
        }),
      );
      if (fastPath === null) {
        return;
      }
      const rtcClosed = fastPath.closed.pipe(
        Effect.tapError(() =>
          Effect.gen(function* () {
            const nowMs = yield* Clock.currentTimeMillis;
            webRtcCooldown.start(connection.environmentId, nowMs);
            yield* fastPath.close;
          }),
        ),
        Effect.mapError(
          () =>
            new ConnectionTransientErrorClass({
              reason: "transport",
              detail: `${connection.label} WebRTC transport disconnected.`,
            }),
        ),
      );
      yield* SubscriptionRef.set(selected, {
        kind: "webrtc",
        client: fastPath.client,
        initialConfig: Effect.succeed(fastPath.initialConfig),
        closed: rtcClosed,
        close: fastPath.close,
      });
    });

    const startTransportUpgrade = Effect.fn("RpcSession.startTransportUpgrade")(function* (
      config: ServerConfig,
    ) {
      const capability = config.environment.capabilities.webRtcRpcFastPath;
      let fallbackReason: "capability-absent" | "platform-absent" | "cooldown" | null = null;
      if (capability === undefined) {
        fallbackReason = "capability-absent";
      } else if (webRtcPeerFactory === null) {
        fallbackReason = "platform-absent";
      } else {
        const nowMs = yield* Clock.currentTimeMillis;
        if (webRtcCooldown.isActive(connection.environmentId, nowMs)) {
          fallbackReason = "cooldown";
        } else {
          yield* selectWebRtc(webRtcPeerFactory, capability).pipe(
            Effect.raceFirst(Deferred.await(disconnected)),
            Effect.ensuring(Deferred.succeed(upgradeComplete, undefined)),
            Effect.forkIn(scope),
          );
        }
      }
      if (fallbackReason !== null) {
        yield* Effect.logDebug("Using WebSocket RPC transport.").pipe(
          Effect.annotateLogs({
            "rpc.transport": "websocket",
            "webrtc.fallback.reason": fallbackReason,
          }),
        );
        yield* Deferred.succeed(upgradeComplete, undefined);
      }
    });
    const ready = yield* Effect.cached(
      Deferred.await(connected).pipe(
        Effect.andThen(controlInitialConfig),
        Effect.tap(startTransportUpgrade),
        Effect.asVoid,
        Effect.raceFirst(Deferred.await(disconnected)),
      ),
    );
    const probe = Effect.suspend(() => {
      const transport = SubscriptionRef.getUnsafe(selected);
      return transport.initialConfig.pipe(
        Effect.flatMap((config) =>
          (config.environment.capabilities.connectionProbe === true
            ? transport.client[WS_METHODS.serverProbe]({})
            : transport.client[WS_METHODS.serverGetConfig]({})
          ).pipe(Effect.mapError(mapSessionRpcError)),
        ),
        Effect.asVoid,
        Effect.withSpan("clientRuntime.connection.rpcSession.probe"),
      );
    });
    const closed = Effect.raceFirst(
      Deferred.await(disconnected).pipe(
        Effect.tapError(() => Effect.suspend(() => SubscriptionRef.getUnsafe(selected).close)),
      ),
      Deferred.await(upgradeComplete).pipe(
        Effect.andThen(
          Effect.suspend(() => {
            const transport = SubscriptionRef.getUnsafe(selected);
            return transport.kind === "webrtc" ? transport.closed : Effect.never;
          }),
        ),
      ),
    );

    return {
      get client() {
        return SubscriptionRef.getUnsafe(selected).client;
      },
      get initialConfig() {
        return SubscriptionRef.getUnsafe(selected).initialConfig;
      },
      ready,
      probe,
      closed,
      get transport() {
        return SubscriptionRef.getUnsafe(selected).kind;
      },
      transportChanges: SubscriptionRef.changes(selected).pipe(
        Stream.map((transport) => transport.kind),
      ),
    } satisfies RpcSession;
  });

  return RpcSessionFactory.of({ connect });
});

export const layer = Layer.effect(RpcSessionFactory, make);
