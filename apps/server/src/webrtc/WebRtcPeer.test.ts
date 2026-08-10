import { WebRtcBindingFrame } from "@t3tools/contracts";
import { makeWebRtcDataChannelConnection } from "@t3tools/shared/webrtcDataChannel";
import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Rpc from "effect/unstable/rpc/Rpc";
import * as RpcClient from "effect/unstable/rpc/RpcClient";
import * as RpcGroup from "effect/unstable/rpc/RpcGroup";
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization";
import * as RpcServer from "effect/unstable/rpc/RpcServer";
import * as Socket from "effect/unstable/socket/Socket";
import * as SocketServer from "effect/unstable/socket/SocketServer";
import { RTCPeerConnection } from "werift";

import { makeSingleSocketServer } from "./SingleSocketServer.ts";
import { makeWebRtcFastPathController } from "./WebRtcFastPathController.ts";
import {
  loadServerWebRtcRuntime,
  ServerWebRtcPeerError,
  weriftDataChannelPort,
} from "./WebRtcPeer.ts";

const encodeBinding = Schema.encodeSync(Schema.fromJsonString(WebRtcBindingFrame));
const ProbeRpc = Rpc.make("Probe", {
  payload: Schema.Struct({}),
  success: Schema.Struct({}),
});
const LargeRpc = Rpc.make("Large", {
  payload: Schema.Struct({ size: Schema.Number }),
  success: Schema.String,
});
const EventsRpc = Rpc.make("Events", {
  payload: Schema.Struct({}),
  success: Schema.String,
  stream: true,
});
const NativeRpcGroup = RpcGroup.make(ProbeRpc, LargeRpc, EventsRpc);
const NativeRpcHandlers = NativeRpcGroup.toLayer({
  Probe: () => Effect.succeed({}),
  Large: ({ size }) => Effect.succeed("x".repeat(size)),
  Events: () => Stream.make("first", "second", "third"),
});

function withPeerTimeout<A, E, R>(
  effect: Effect.Effect<A, E, R>,
  stage: string,
): Effect.Effect<A, E, R> {
  return effect.pipe(
    Effect.timeoutOrElse({
      duration: "10 seconds",
      orElse: () => Effect.die(new Error(`WebRTC timed out during ${stage}.`)),
    }),
  );
}

it.effect("binds and fragments RPC messages over a real DataChannel", () =>
  Effect.gen(function* () {
    const runtime = Option.getOrThrow(yield* loadServerWebRtcRuntime);
    const socketServer = yield* makeSingleSocketServer();
    yield* Layer.build(
      RpcServer.layer(NativeRpcGroup).pipe(
        Layer.provide(NativeRpcHandlers),
        Layer.provide(RpcServer.layerProtocolSocketServer),
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(SocketServer.SocketServer, socketServer.server),
            RpcSerialization.layerJson,
          ),
        ),
      ),
    );
    const controller = yield* makeWebRtcFastPathController({
      enabled: true,
      stunUrls: [],
      runtime: Option.some(runtime),
      socketServer,
    });

    const clientPeer = new RTCPeerConnection({
      iceServers: [],
      maxMessageSize: 16 * 1024,
    });
    yield* Effect.addFinalizer(() =>
      Effect.tryPromise({
        try: () => clientPeer.close(),
        catch: () => new ServerWebRtcPeerError("connection"),
      }).pipe(Effect.ignore),
    );
    const clientChannel = clientPeer.createDataChannel("t3-rpc-v1");
    const clientConnection = yield* makeWebRtcDataChannelConnection(
      weriftDataChannelPort(clientChannel),
    );
    const offer = yield* Effect.tryPromise({
      try: async () => {
        const pendingOffer = await clientPeer.createOffer();
        await clientPeer.setLocalDescription(pendingOffer);
        return clientPeer.localDescription;
      },
      catch: () => new ServerWebRtcPeerError("offer"),
    });
    if (offer === null || offer.type !== "offer") {
      return yield* Effect.die(new Error("WebRTC did not create an offer."));
    }
    const answer = yield* controller.negotiate({
      version: 1,
      attemptId: "native-attempt",
      offerSdp: offer.sdp,
    });
    yield* Effect.tryPromise({
      try: () => clientPeer.setRemoteDescription({ type: "answer", sdp: answer.answerSdp }),
      catch: () => new ServerWebRtcPeerError("offer"),
    });
    yield* withPeerTimeout(clientConnection.awaitOpen, "DataChannel open");
    yield* clientConnection.sendBinding(
      new TextEncoder().encode(
        encodeBinding({
          version: 1,
          attemptId: answer.attemptId,
          bindingToken: answer.bindingToken,
        }),
      ),
    );
    yield* withPeerTimeout(clientConnection.awaitBindingAck, "binding");

    const protocolContext = yield* Layer.build(
      Layer.effect(
        RpcClient.Protocol,
        RpcClient.makeProtocolSocket({ retryTransientErrors: false }),
      ).pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(Socket.Socket, clientConnection.socket),
            RpcSerialization.layerJson,
          ),
        ),
      ),
    );
    const client = yield* RpcClient.make(NativeRpcGroup).pipe(Effect.provide(protocolContext));
    expect(yield* withPeerTimeout(client.Probe({}), "probe RPC")).toEqual({});
    expect(yield* withPeerTimeout(client.Large({ size: 40_000 }), "large RPC")).toHaveLength(
      40_000,
    );
    expect(
      yield* withPeerTimeout(client.Events({}).pipe(Stream.runCollect), "streaming RPC"),
    ).toEqual(["first", "second", "third"]);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
