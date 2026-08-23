import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Socket from "effect/unstable/socket/Socket";

import type { ServerWebRtcPeerFactory, WebRtcDataChannelPort } from "./peer.ts";
import { makeServerLogicalSocket } from "./server.ts";
import {
  decodeApplicationFrame,
  decodeControl,
  encodeApplicationFrames,
  encodeControl,
} from "./wire.ts";

const NONCE = "abcdefghijklmnopqrstuv";
const ATTEMPT_ID = "attempt-1";

type ApplicationChunk = string | Uint8Array;

const makeRawSocket = Effect.fn("WebRtcServerTest.makeRawSocket")(function* () {
  const inbound = yield* Queue.unbounded<ApplicationChunk>();
  const outbound = yield* Queue.unbounded<ApplicationChunk>();

  const runRaw = <A, E, R>(
    handler: (data: ApplicationChunk) => Effect.Effect<A, E, R> | void,
    options?: { readonly onOpen?: Effect.Effect<void> | undefined },
  ): Effect.Effect<void, Socket.SocketError | E, R> =>
    Effect.gen(function* () {
      yield* options?.onOpen ?? Effect.void;
      return yield* Queue.take(inbound).pipe(
        Effect.flatMap((data) => {
          const result = handler(data);
          return Effect.isEffect(result) ? result : Effect.void;
        }),
        Effect.forever,
      );
    });

  const writer = Effect.succeed((chunk: ApplicationChunk | Socket.CloseEvent) => {
    if (Socket.isCloseEvent(chunk)) {
      return Effect.void;
    }
    return Queue.offer(outbound, chunk).pipe(Effect.asVoid);
  });

  return {
    socket: Socket.make({ runRaw, writer }),
    receive: (chunk: ApplicationChunk) => Queue.offer(inbound, chunk).pipe(Effect.asVoid),
    takeSent: Queue.take(outbound),
  };
});

const makeDataChannel = Effect.fn("WebRtcServerTest.makeDataChannel")(function* () {
  const sent = yield* Queue.unbounded<Uint8Array>();
  const messageListenerAttached = yield* Deferred.make<void>();
  const openListeners = new Set<() => void>();
  const messageListeners = new Set<(data: Uint8Array) => void>();
  const closeListeners = new Set<() => void>();
  const errorListeners = new Set<(cause: unknown) => void>();
  let open = true;

  const port: WebRtcDataChannelPort = {
    label: "t3-websocket-v1",
    ordered: true,
    isOpen: () => open,
    bufferedAmount: () => 0,
    send: (data) => {
      Queue.offerUnsafe(sent, Uint8Array.from(data));
    },
    close: () => {
      open = false;
      for (const listener of closeListeners) {
        listener();
      }
    },
    onOpen: (listener) => {
      openListeners.add(listener);
      return () => openListeners.delete(listener);
    },
    onMessage: (listener) => {
      messageListeners.add(listener);
      Deferred.doneUnsafe(messageListenerAttached, Effect.void);
      return () => messageListeners.delete(listener);
    },
    onClose: (listener) => {
      closeListeners.add(listener);
      return () => closeListeners.delete(listener);
    },
    onError: (listener) => {
      errorListeners.add(listener);
      return () => errorListeners.delete(listener);
    },
  };

  return {
    port,
    awaitMessageListener: Deferred.await(messageListenerAttached),
    emitMessage: (data: Uint8Array) =>
      Effect.sync(() => {
        for (const listener of messageListeners) {
          listener(data);
        }
      }),
    closeRemote: Effect.sync(() => {
      open = false;
      for (const listener of closeListeners) {
        listener();
      }
    }),
    takeSent: Queue.take(sent),
  };
});

function makePeerFactory(port: WebRtcDataChannelPort): ServerWebRtcPeerFactory {
  return {
    create: () =>
      Effect.succeed({
        acceptOffer: () => Effect.succeed("answer-sdp"),
        dataChannel: Effect.succeed(port),
        closed: Effect.never,
        close: Effect.void,
      }),
    randomBytes: (size) => Effect.succeed(new Uint8Array(size).fill(1)),
  };
}

const decodeControlChunk = Effect.fn("WebRtcServerTest.decodeControlChunk")(function* (
  chunk: ApplicationChunk,
) {
  const message = yield* decodeControl(NONCE, chunk);
  return Option.getOrThrow(message);
});

const makeConnectedServer = Effect.fn("WebRtcServerTest.makeConnectedServer")(function* () {
  const raw = yield* makeRawSocket();
  const dataChannel = yield* makeDataChannel();
  const received = yield* Queue.unbounded<ApplicationChunk>();
  const socket = makeServerLogicalSocket({
    socket: raw.socket,
    nonce: NONCE,
    peerFactory: makePeerFactory(dataChannel.port),
  });

  yield* socket
    .runRaw((chunk) => Queue.offer(received, chunk).pipe(Effect.asVoid))
    .pipe(Effect.forkScoped);

  expect((yield* decodeControlChunk(yield* raw.takeSent)).kind).toBe("hello");
  yield* raw.receive(
    encodeControl(NONCE, {
      kind: "hello-ack",
      version: 1,
    }),
  );
  yield* raw.receive(
    encodeControl(NONCE, {
      kind: "frame-start",
      version: 1,
    }),
  );
  expect((yield* decodeControlChunk(yield* raw.takeSent)).kind).toBe("frame-start-ack");

  yield* raw.receive(
    encodeControl(NONCE, {
      kind: "offer",
      attemptId: ATTEMPT_ID,
      sdp: "offer-sdp",
    }),
  );
  const answer = yield* decodeControlChunk(yield* raw.takeSent);
  if (answer.kind !== "answer") {
    return yield* Effect.die(new Error(`Expected answer, received ${answer.kind}.`));
  }

  yield* dataChannel.awaitMessageListener;
  yield* dataChannel.emitMessage(
    new TextEncoder().encode(
      encodeControl(NONCE, {
        kind: "bind",
        attemptId: ATTEMPT_ID,
        bindingToken: answer.bindingToken,
      }),
    ),
  );
  expect((yield* decodeControlChunk(yield* dataChannel.takeSent)).kind).toBe("bind-ack");

  yield* raw.receive(
    encodeControl(NONCE, {
      kind: "cutover",
      attemptId: ATTEMPT_ID,
    }),
  );
  expect((yield* decodeControlChunk(yield* raw.takeSent)).kind).toBe("cutover-ack");

  return {
    dataChannel,
    raw,
    takeReceived: Queue.take(received),
    writer: yield* socket.writer,
  };
});

function expectApplicationFrame(chunk: ApplicationChunk, sequence: bigint) {
  expect(chunk).toBeInstanceOf(Uint8Array);
  if (typeof chunk === "string") {
    throw new Error("Expected a binary application frame.");
  }
  return decodeApplicationFrame(NONCE, chunk).pipe(
    Effect.map(Option.getOrThrow),
    Effect.tap((fragment) =>
      Effect.sync(() => {
        expect(fragment.sequence).toBe(sequence);
      }),
    ),
  );
}

describe("WebRTC server logical socket", () => {
  it.effect("replays unacknowledged frames when abort arrives before DataChannel close", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* makeConnectedServer();

        yield* server.writer("before-abort");
        const rtcFrame = yield* server.dataChannel.takeSent;
        yield* expectApplicationFrame(rtcFrame, 0n);

        yield* server.raw.receive(
          encodeControl(NONCE, {
            kind: "abort",
            attemptId: ATTEMPT_ID,
          }),
        );
        const replayedFrame = yield* server.raw.takeSent;
        expect(replayedFrame).toEqual(rtcFrame);

        yield* server.writer("after-abort");
        yield* expectApplicationFrame(yield* server.raw.takeSent, 1n);
      }),
    ),
  );

  it.effect("replays unacknowledged frames after DataChannel failure", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* makeConnectedServer();

        yield* server.writer("before-close");
        const rtcFrame = yield* server.dataChannel.takeSent;
        yield* server.dataChannel.closeRemote;

        expect(yield* server.raw.takeSent).toEqual(rtcFrame);
        const fallback = yield* decodeControlChunk(yield* server.raw.takeSent);
        expect(fallback).toEqual({ kind: "fallback", attemptId: ATTEMPT_ID });

        yield* server.writer("after-close");
        yield* expectApplicationFrame(yield* server.raw.takeSent, 1n);
      }),
    ),
  );

  it.effect("reassembles fragmented messages once when fragments are duplicated", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* makeConnectedServer();
        const firstMessage = "x".repeat(20 * 1024);
        const firstFrames = yield* encodeApplicationFrames(NONCE, 0n, firstMessage);
        const firstFrame = firstFrames[0];
        if (firstFrame === undefined) {
          return yield* Effect.die(new Error("Expected the message to produce a frame."));
        }

        yield* server.dataChannel.emitMessage(firstFrame);
        yield* server.dataChannel.emitMessage(firstFrame);
        for (const frame of firstFrames.slice(1)) {
          yield* server.dataChannel.emitMessage(frame);
        }
        expect(yield* server.takeReceived).toBe(firstMessage);

        for (const frame of firstFrames) {
          yield* server.dataChannel.emitMessage(frame);
        }
        const secondFrames = yield* encodeApplicationFrames(NONCE, 1n, "second");
        for (const frame of secondFrames) {
          yield* server.dataChannel.emitMessage(frame);
        }
        expect(yield* server.takeReceived).toBe("second");
      }),
    ),
  );
});
