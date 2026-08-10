import { WebRtcBindingFrame } from "@t3tools/contracts";
import {
  makeWebRtcDataChannelConnection,
  type WebRtcDataChannelPort,
} from "@t3tools/shared/webrtcDataChannel";
import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import type * as Socket from "effect/unstable/socket/Socket";

import { makeSingleSocketServer } from "./SingleSocketServer.ts";
import { makeWebRtcFastPathController, webRtcAttemptExpired } from "./WebRtcFastPathController.ts";
import {
  type ServerWebRtcPeer,
  ServerWebRtcPeerError,
  type ServerWebRtcRuntime,
} from "./WebRtcPeer.ts";

class TestDataChannelPort implements WebRtcDataChannelPort {
  readonly label = "t3-rpc-v1";
  readonly ordered = true;
  #open = true;
  #peer: TestDataChannelPort | null = null;
  #messageListeners = new Set<(data: Uint8Array) => void>();
  #closeListeners = new Set<() => void>();
  #pendingMessages: Array<Uint8Array> = [];

  connect(peer: TestDataChannelPort): void {
    this.#peer = peer;
  }

  isOpen(): boolean {
    return this.#open;
  }

  bufferedAmount(): number {
    return 0;
  }

  setBufferedAmountLowThreshold(_bytes: number): void {}

  send(data: Uint8Array): void {
    if (this.#peer === null) {
      return;
    }
    const copy = data.slice();
    if (this.#peer.#messageListeners.size === 0) {
      this.#peer.#pendingMessages.push(copy);
      return;
    }
    for (const listener of this.#peer.#messageListeners) {
      listener(copy);
    }
  }

  close(): void {
    if (!this.#open) {
      return;
    }
    this.#open = false;
    for (const listener of this.#closeListeners) {
      listener();
    }
  }

  onOpen(_listener: () => void): () => void {
    return () => undefined;
  }

  onMessage(listener: (data: Uint8Array) => void): () => void {
    this.#messageListeners.add(listener);
    for (const message of this.#pendingMessages.splice(0)) {
      listener(message);
    }
    return () => this.#messageListeners.delete(listener);
  }

  onClose(listener: () => void): () => void {
    this.#closeListeners.add(listener);
    return () => this.#closeListeners.delete(listener);
  }

  onError(_listener: (error: Error) => void): () => void {
    return () => undefined;
  }

  onBufferedAmountLow(_listener: () => void): () => void {
    return () => undefined;
  }
}

const encodeBinding = Schema.encodeSync(Schema.fromJsonString(WebRtcBindingFrame));

const makeHarness = Effect.fn("WebRtcFastPathController.test.makeHarness")(function* (
  attemptTtlMs = 30_000,
) {
  const clientPort = new TestDataChannelPort();
  const serverPort = new TestDataChannelPort();
  clientPort.connect(serverPort);
  serverPort.connect(clientPort);
  const channels = yield* Deferred.make<WebRtcDataChannelPort>();
  const closeCount = yield* Ref.make(0);
  const peer: ServerWebRtcPeer = {
    acceptOffer: () => Effect.succeed("v=0\r\n"),
    takeDataChannel: Deferred.await(channels),
    closed: Effect.never,
    diagnosticState: Effect.succeed({
      connectionState: "connected",
      gatheringState: "complete",
      iceState: "connected",
    }),
    selectedIcePairType: Effect.succeed("host/host"),
    bytesSent: Effect.succeed(0),
    bytesReceived: Effect.succeed(0),
    close: Ref.update(closeCount, (count) => count + 1).pipe(
      Effect.andThen(Effect.sync(() => serverPort.close())),
    ),
  };
  const runtime: ServerWebRtcRuntime = {
    createPeer: () => Effect.succeed(peer),
  };
  const socketServer = yield* makeSingleSocketServer();
  const accepted = yield* Queue.unbounded<Socket.Socket>();
  yield* socketServer.server
    .run((socket) => Queue.offer(accepted, socket).pipe(Effect.andThen(Effect.never)))
    .pipe(Effect.forkScoped);
  const controller = yield* makeWebRtcFastPathController({
    enabled: true,
    stunUrls: [],
    runtime: Option.some(runtime),
    socketServer,
    attemptTtlMs,
  });
  return {
    accepted,
    channels,
    clientPort,
    closeCount,
    controller,
    serverPort,
  };
});

describe("WebRtcFastPathController", () => {
  it("uses an inclusive attempt deadline", () => {
    expect(webRtcAttemptExpired(1_000, 999)).toBe(false);
    expect(webRtcAttemptExpired(1_000, 1_000)).toBe(true);
  });

  it.effect("does not advertise a missing optional WebRTC runtime", () =>
    Effect.gen(function* () {
      const controller = yield* makeWebRtcFastPathController({
        enabled: true,
        stunUrls: [],
        runtime: Option.none(),
        socketServer: yield* makeSingleSocketServer(),
      });

      expect(controller.capability).toBeNull();
      const error = yield* Effect.flip(
        controller.negotiate({
          version: 1,
          attemptId: "attempt-1",
          offerSdp: "v=0\r\n",
        }),
      );
      expect(error._tag).toBe("WebRtcFastPathUnsupportedError");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("accepts only the binding token issued for the control WebSocket", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const answer = yield* harness.controller.negotiate({
        version: 1,
        attemptId: "attempt-1",
        offerSdp: "v=0\r\n",
      });
      yield* Deferred.succeed(harness.channels, harness.serverPort);
      const client = yield* makeWebRtcDataChannelConnection(harness.clientPort);
      yield* client.sendBinding(
        new TextEncoder().encode(
          encodeBinding({
            version: 1,
            attemptId: answer.attemptId,
            bindingToken: answer.bindingToken,
          }),
        ),
      );
      yield* client.awaitBindingAck;

      expect(yield* Queue.take(harness.accepted)).toBeDefined();
      expect(yield* Ref.get(harness.closeCount)).toBe(0);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("closes a peer whose binding token does not match", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const answer = yield* harness.controller.negotiate({
        version: 1,
        attemptId: "attempt-1",
        offerSdp: "v=0\r\n",
      });
      yield* Deferred.succeed(harness.channels, harness.serverPort);
      const client = yield* makeWebRtcDataChannelConnection(harness.clientPort);
      yield* client.sendBinding(
        new TextEncoder().encode(
          encodeBinding({
            version: 1,
            attemptId: answer.attemptId,
            bindingToken: "wrong-binding-token",
          }),
        ),
      );
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if ((yield* Ref.get(harness.closeCount)) > 0) {
          break;
        }
        yield* Effect.yieldNow;
      }

      expect(yield* Ref.get(harness.closeCount)).toBe(1);
      expect(yield* Queue.size(harness.accepted)).toBe(0);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("expires and cleans up an unbound attempt", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness(1_000);
      yield* harness.controller.negotiate({
        version: 1,
        attemptId: "attempt-1",
        offerSdp: "v=0\r\n",
      });

      yield* TestClock.adjust("1 second");
      yield* Effect.yieldNow;

      expect(yield* Ref.get(harness.closeCount)).toBe(1);
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, TestClock.layer()))),
  );

  it.effect("closes a partially initialized peer when offer negotiation fails", () =>
    Effect.gen(function* () {
      const closeCount = yield* Ref.make(0);
      const peer: ServerWebRtcPeer = {
        acceptOffer: () => Effect.fail(new ServerWebRtcPeerError("offer")),
        takeDataChannel: Effect.never,
        closed: Effect.never,
        diagnosticState: Effect.succeed({
          connectionState: "new",
          gatheringState: "new",
          iceState: "new",
        }),
        selectedIcePairType: Effect.succeed(null),
        bytesSent: Effect.succeed(0),
        bytesReceived: Effect.succeed(0),
        close: Ref.update(closeCount, (count) => count + 1),
      };
      const controller = yield* makeWebRtcFastPathController({
        enabled: true,
        stunUrls: [],
        runtime: Option.some({ createPeer: () => Effect.succeed(peer) }),
        socketServer: yield* makeSingleSocketServer(),
      });

      const error = yield* Effect.flip(
        controller.negotiate({
          version: 1,
          attemptId: "attempt-1",
          offerSdp: "v=0\r\n",
        }),
      );

      expect(error._tag).toBe("WebRtcFastPathNegotiationError");
      expect(yield* Ref.get(closeCount)).toBe(1);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("closes a partially initialized peer when negotiation is interrupted", () =>
    Effect.gen(function* () {
      const offerStarted = yield* Deferred.make<void>();
      const closeCount = yield* Ref.make(0);
      const peer: ServerWebRtcPeer = {
        acceptOffer: () =>
          Deferred.succeed(offerStarted, undefined).pipe(Effect.andThen(Effect.never)),
        takeDataChannel: Effect.never,
        closed: Effect.never,
        diagnosticState: Effect.succeed({
          connectionState: "new",
          gatheringState: "new",
          iceState: "new",
        }),
        selectedIcePairType: Effect.succeed(null),
        bytesSent: Effect.succeed(0),
        bytesReceived: Effect.succeed(0),
        close: Ref.update(closeCount, (count) => count + 1),
      };
      const controller = yield* makeWebRtcFastPathController({
        enabled: true,
        stunUrls: [],
        runtime: Option.some({ createPeer: () => Effect.succeed(peer) }),
        socketServer: yield* makeSingleSocketServer(),
      });
      const negotiation = yield* controller
        .negotiate({
          version: 1,
          attemptId: "attempt-1",
          offerSdp: "v=0\r\n",
        })
        .pipe(Effect.forkChild);

      yield* Deferred.await(offerStarted);
      yield* Fiber.interrupt(negotiation);

      expect(yield* Ref.get(closeCount)).toBe(1);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
