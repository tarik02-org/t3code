import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Semaphore from "effect/Semaphore";
import * as Socket from "effect/unstable/socket/Socket";

import {
  encodeWebRtcMessage,
  type DecodedWebRtcMessage,
  WebRtcMessageReassembler,
} from "./webrtcFraming.ts";

const BUFFERED_AMOUNT_HIGH_BYTES = 256 * 1024;
const BUFFERED_AMOUNT_LOW_BYTES = 64 * 1024;

export interface WebRtcDataChannelPort {
  readonly label: string;
  readonly ordered: boolean;
  readonly isOpen: () => boolean;
  readonly bufferedAmount: () => number;
  readonly setBufferedAmountLowThreshold: (bytes: number) => void;
  readonly send: (data: Uint8Array) => void;
  readonly close: () => void;
  readonly onOpen: (listener: () => void) => () => void;
  readonly onMessage: (listener: (data: Uint8Array) => void) => () => void;
  readonly onClose: (listener: () => void) => () => void;
  readonly onError: (listener: (error: Error) => void) => () => void;
  readonly onBufferedAmountLow: (listener: () => void) => () => void;
}

export interface WebRtcDataChannelStats {
  readonly bytesSent: number;
  readonly bytesReceived: number;
}

export interface WebRtcDataChannelConnection {
  readonly awaitOpen: Effect.Effect<void, Socket.SocketError>;
  readonly sendBinding: (payload: Uint8Array) => Effect.Effect<void, Socket.SocketError>;
  readonly awaitBinding: Effect.Effect<Uint8Array, Socket.SocketError>;
  readonly sendBindingAck: Effect.Effect<void, Socket.SocketError>;
  readonly awaitBindingAck: Effect.Effect<void, Socket.SocketError>;
  readonly socket: Socket.Socket;
  readonly closed: Effect.Effect<never, Socket.SocketError>;
  readonly close: Effect.Effect<void>;
  readonly stats: Effect.Effect<WebRtcDataChannelStats>;
}

function socketError(reason: Socket.SocketErrorReason): Socket.SocketError {
  return new Socket.SocketError({ reason });
}

export const makeWebRtcDataChannelConnection = Effect.fn("WebRtcDataChannelConnection.make")(
  function* (port: WebRtcDataChannelPort) {
    const incoming = yield* Queue.unbounded<Uint8Array>();
    const bufferedAmountLow = yield* Queue.sliding<void>(1);
    const opened = yield* Deferred.make<void, Socket.SocketError>();
    const closed = yield* Deferred.make<never, Socket.SocketError>();
    const writeLock = yield* Semaphore.make(1);
    const decoder = new WebRtcMessageReassembler();
    let nextMessageId = 1;
    let bytesSent = 0;
    let bytesReceived = 0;

    const closeWith = (error: Socket.SocketError) => {
      Deferred.doneUnsafe(closed, Effect.fail(error));
    };
    const failConnection = (error: Socket.SocketError) =>
      Effect.sync(() => {
        closeWith(error);
        port.close();
      });
    if (port.isOpen()) {
      Deferred.doneUnsafe(opened, Effect.void);
    }
    port.setBufferedAmountLowThreshold(BUFFERED_AMOUNT_LOW_BYTES);
    const cleanups = [
      port.onOpen(() => {
        Deferred.doneUnsafe(opened, Effect.void);
      }),
      port.onMessage((data) => {
        bytesReceived += data.byteLength;
        Queue.offerUnsafe(incoming, data);
      }),
      port.onClose(() => {
        closeWith(socketError(new Socket.SocketCloseError({ code: 1000 })));
      }),
      port.onError((error) => {
        closeWith(socketError(new Socket.SocketReadError({ cause: error })));
      }),
      port.onBufferedAmountLow(() => {
        Queue.offerUnsafe(bufferedAmountLow, undefined);
      }),
    ];
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        for (const cleanup of cleanups) {
          cleanup();
        }
        port.close();
      }),
    );

    const awaitOpen = Deferred.await(opened).pipe(Effect.raceFirst(Deferred.await(closed)));
    const receive = Effect.fn("WebRtcDataChannelConnection.receive")(function* () {
      while (true) {
        const takeFrame = Queue.take(incoming).pipe(Effect.raceFirst(Deferred.await(closed)));
        const expiresAtMs = decoder.nextPartialExpiryAtMs();
        const frame =
          expiresAtMs === null
            ? yield* takeFrame
            : yield* Clock.currentTimeMillis.pipe(
                Effect.flatMap((nowMs) =>
                  Effect.sleep(Duration.millis(Math.max(0, expiresAtMs - nowMs))).pipe(
                    Effect.andThen(Clock.currentTimeMillis),
                    Effect.flatMap((expiredAtMs) =>
                      decoder
                        .expirePartials(expiredAtMs)
                        .pipe(
                          Effect.mapError((cause) =>
                            socketError(new Socket.SocketReadError({ cause })),
                          ),
                        ),
                    ),
                    Effect.tapError(failConnection),
                    Effect.andThen(Effect.never),
                  ),
                ),
                Effect.raceFirst(takeFrame),
              );
        const nowMs = yield* Clock.currentTimeMillis;
        const message = yield* decoder.push(frame, nowMs).pipe(
          Effect.tapError((error) =>
            Effect.logWarning("WebRTC framing rejected a DataChannel frame.").pipe(
              Effect.annotateLogs({ "webrtc.framing.error_code": error.code }),
            ),
          ),
          Effect.mapError((cause) => socketError(new Socket.SocketReadError({ cause }))),
          Effect.tapError(failConnection),
        );
        if (message !== null) {
          return message;
        }
      }
    });

    const sendFrames = (frames: ReadonlyArray<Uint8Array>) =>
      writeLock.withPermits(1)(
        Effect.gen(function* () {
          for (const frame of frames) {
            while (port.bufferedAmount() > BUFFERED_AMOUNT_HIGH_BYTES) {
              yield* Queue.take(bufferedAmountLow).pipe(Effect.raceFirst(Deferred.await(closed)));
            }
            yield* Effect.try({
              try: () => {
                port.send(frame);
                bytesSent += frame.byteLength;
              },
              catch: (cause) => socketError(new Socket.SocketWriteError({ cause })),
            });
          }
        }),
      );

    const sendControl = (kind: "binding" | "binding-ack", payload: Uint8Array) =>
      encodeWebRtcMessage({ kind, messageId: 0, payload }).pipe(
        Effect.mapError((cause) => socketError(new Socket.SocketWriteError({ cause }))),
        Effect.flatMap(sendFrames),
      );

    const expectControl = Effect.fn("WebRtcDataChannelConnection.expectControl")(function* (
      expected: "binding" | "binding-ack",
    ) {
      const message = yield* receive();
      if (message.kind !== expected) {
        return yield* socketError(
          new Socket.SocketReadError({ cause: new Error(`Expected ${expected} control frame.`) }),
        );
      }
      return message.payload;
    });

    const socket = Socket.make({
      runRaw: (handler, options) =>
        Effect.gen(function* () {
          yield* awaitOpen;
          if (options?.onOpen !== undefined) {
            yield* options.onOpen;
          }
          while (true) {
            const message: DecodedWebRtcMessage = yield* receive();
            if (message.kind !== "rpc") {
              const error = socketError(
                new Socket.SocketReadError({
                  cause: new Error("Unexpected WebRTC control frame after binding."),
                }),
              );
              yield* failConnection(error);
              return yield* error;
            }
            const handled = handler(message.payload);
            if (handled !== undefined) {
              yield* handled;
            }
          }
        }),
      writer: Effect.succeed((chunk) => {
        if (Socket.isCloseEvent(chunk)) {
          return Effect.sync(() => port.close());
        }
        const payload = typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk;
        return Effect.sync(() => {
          const messageId = nextMessageId;
          nextMessageId = nextMessageId === 0xffff_ffff ? 1 : nextMessageId + 1;
          return messageId;
        }).pipe(
          Effect.flatMap((messageId) => encodeWebRtcMessage({ kind: "rpc", messageId, payload })),
          Effect.mapError((cause) => socketError(new Socket.SocketWriteError({ cause }))),
          Effect.flatMap(sendFrames),
        );
      }),
    });

    return {
      awaitOpen,
      sendBinding: (payload) => sendControl("binding", payload),
      awaitBinding: expectControl("binding"),
      sendBindingAck: sendControl("binding-ack", new Uint8Array()),
      awaitBindingAck: expectControl("binding-ack").pipe(Effect.asVoid),
      socket,
      closed: Deferred.await(closed),
      close: Effect.sync(() => port.close()),
      stats: Effect.sync(() => ({ bytesSent, bytesReceived })),
    } satisfies WebRtcDataChannelConnection;
  },
);
