import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Socket from "effect/unstable/socket/Socket";

import {
  type ClientWebRtcPeerFactory,
  type WebRtcDataChannelPort,
  type WebRtcIceServer,
  WebRtcPeerError,
} from "./peer.ts";
import { makeLogicalSocket, type LogicalSocketSession } from "./socket.ts";
import { DATA_CHANNEL_LABEL, type ControlMessage, wireIceServers } from "./wire.ts";

const NEGOTIATION_TIMEOUT = "15 seconds";
const RETRY_DELAYS = ["1 second", "2 seconds", "5 seconds", "10 seconds", "30 seconds"] as const;
const MAX_RETRY_DELAY = "30 seconds";

interface NegotiatedAnswer {
  readonly sdp: string;
  readonly bindingToken: string;
}

interface ClientAttemptState {
  readonly attemptId: string;
  readonly answer: Deferred.Deferred<NegotiatedAnswer>;
  readonly bindAcknowledged: Deferred.Deferred<void>;
  readonly cutoverAcknowledged: Deferred.Deferred<void>;
  readonly stopped: Deferred.Deferred<never, WebRtcNegotiationError>;
}

export class WebRtcNegotiationError extends Schema.TaggedErrorClass<WebRtcNegotiationError>()(
  "WebRtcNegotiationError",
  {
    attemptId: Schema.String,
    reason: Schema.Literals([
      "aborted",
      "answer-timeout",
      "bind-timeout",
      "connection-timeout",
      "cutover-timeout",
      "offer-timeout",
    ]),
  },
) {
  override get message(): string {
    return `WebRTC negotiation failed: ${this.reason}.`;
  }
}

export interface WebRtcSessionDescription {
  readonly type: "offer" | "answer";
  readonly sdp: string;
}

export type WebRtcPeerConnectionState =
  | "new"
  | "connecting"
  | "connected"
  | "disconnected"
  | "failed"
  | "closed";

export interface PlatformWebRtcPeerConnection {
  readonly createDataChannel: (label: string) => WebRtcDataChannelPort;
  readonly createOffer: () => Promise<WebRtcSessionDescription | null>;
  readonly setLocalDescription: (description: WebRtcSessionDescription) => Promise<void>;
  readonly localDescription: () => WebRtcSessionDescription | null;
  readonly setRemoteDescription: (description: WebRtcSessionDescription) => Promise<void>;
  readonly iceGatheringState: () => "new" | "gathering" | "complete";
  readonly onIceGatheringStateChange: (listener: () => void) => () => void;
  readonly onConnectionStateChange: (
    listener: (state: WebRtcPeerConnectionState) => void,
  ) => () => void;
  readonly close: () => void;
}

function awaitNegotiationStep<A, E, R>(
  effect: Effect.Effect<A, E, R>,
  attemptId: string,
  reason:
    | "answer-timeout"
    | "bind-timeout"
    | "connection-timeout"
    | "cutover-timeout"
    | "offer-timeout",
): Effect.Effect<A, E | WebRtcNegotiationError, R> {
  return effect.pipe(
    Effect.timeoutOption(NEGOTIATION_TIMEOUT),
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.fail(new WebRtcNegotiationError({ attemptId, reason })),
        onSome: Effect.succeed,
      }),
    ),
  );
}

const awaitDataChannelOpen = Effect.fn("WebRtcClient.awaitDataChannelOpen")(function* (
  port: WebRtcDataChannelPort,
) {
  if (port.isOpen()) {
    return;
  }
  const opened = yield* Deferred.make<void, WebRtcPeerError>();
  const removeOpen = port.onOpen(() => {
    Deferred.doneUnsafe(opened, Effect.void);
  });
  const removeClose = port.onClose(() => {
    Deferred.doneUnsafe(
      opened,
      Effect.fail(
        new WebRtcPeerError({
          stage: "data-channel",
          cause: new Error("WebRTC DataChannel closed before opening."),
        }),
      ),
    );
  });
  const removeError = port.onError((cause) => {
    Deferred.doneUnsafe(opened, Effect.fail(new WebRtcPeerError({ stage: "data-channel", cause })));
  });
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      removeOpen();
      removeClose();
      removeError();
    }),
  );
  yield* Deferred.await(opened);
});

function makeClientDriver(session: LogicalSocketSession, peerFactory: ClientWebRtcPeerFactory) {
  return Effect.gen(function* () {
    let currentAttempt: ClientAttemptState | null = null;
    let framingStarted = false;

    const stopAttempt = (attemptId: string, reason: "aborted") =>
      Effect.sync(() => {
        if (currentAttempt?.attemptId !== attemptId) {
          return;
        }
        Deferred.doneUnsafe(
          currentAttempt.stopped,
          Effect.fail(new WebRtcNegotiationError({ attemptId, reason })),
        );
      });

    const runAttempt = Effect.fn("WebRtcClient.runAttempt")(function* (
      iceServers: ReadonlyArray<WebRtcIceServer>,
    ) {
      const attemptId = Encoding.encodeBase64Url(yield* peerFactory.randomBytes(16));
      const answer = yield* Deferred.make<NegotiatedAnswer>();
      const bindAcknowledged = yield* Deferred.make<void>();
      const cutoverAcknowledged = yield* Deferred.make<void>();
      const stopped = yield* Deferred.make<never, WebRtcNegotiationError>();
      const attempt: ClientAttemptState = {
        attemptId,
        answer,
        bindAcknowledged,
        cutoverAcknowledged,
        stopped,
      };
      currentAttempt = attempt;

      const peer = yield* peerFactory.create(iceServers);
      if (peer.dataChannel.label !== DATA_CHANNEL_LABEL || !peer.dataChannel.ordered) {
        return yield* new WebRtcPeerError({
          stage: "data-channel",
          cause: new Error("WebRTC peer created an incompatible DataChannel."),
        });
      }
      yield* session.attachDataChannel(attemptId, peer.dataChannel);
      const offerSdp = yield* awaitNegotiationStep(peer.createOffer, attemptId, "offer-timeout");
      yield* session.sendControl({ kind: "offer", attemptId, sdp: offerSdp });
      const negotiated = yield* awaitNegotiationStep(
        Deferred.await(answer),
        attemptId,
        "answer-timeout",
      ).pipe(Effect.raceFirst(Deferred.await(stopped)), Effect.raceFirst(peer.closed));
      yield* awaitNegotiationStep(
        peer.acceptAnswer(negotiated.sdp),
        attemptId,
        "connection-timeout",
      );
      yield* awaitNegotiationStep(
        awaitDataChannelOpen(peer.dataChannel),
        attemptId,
        "connection-timeout",
      ).pipe(Effect.raceFirst(Deferred.await(stopped)), Effect.raceFirst(peer.closed));
      yield* session.sendRtcControl(attemptId, {
        kind: "bind",
        attemptId,
        bindingToken: negotiated.bindingToken,
      });
      yield* awaitNegotiationStep(Deferred.await(bindAcknowledged), attemptId, "bind-timeout").pipe(
        Effect.raceFirst(Deferred.await(stopped)),
        Effect.raceFirst(peer.closed),
      );
      yield* session.sendControl({ kind: "cutover", attemptId });
      yield* awaitNegotiationStep(
        Deferred.await(cutoverAcknowledged),
        attemptId,
        "cutover-timeout",
      ).pipe(Effect.raceFirst(Deferred.await(stopped)), Effect.raceFirst(peer.closed));
      yield* session.selectDataChannel(attemptId);
      return yield* Effect.raceFirst(Deferred.await(stopped), peer.closed);
    });

    const runAttempts = Effect.gen(function* () {
      const iceServers = yield* session.framingReady;
      let retryIndex = 0;
      while (true) {
        yield* Effect.scoped(runAttempt(iceServers)).pipe(
          Effect.catchTags({
            SocketError: (error) =>
              Effect.logDebug("WebRTC upgrade attempt hit a socket error.", { error }),
            WebRtcNegotiationError: (error) =>
              Effect.logDebug("WebRTC upgrade attempt did not complete.", { error }),
            WebRtcPeerError: (error) => Effect.logDebug("WebRTC upgrade peer failed.", { error }),
          }),
          Effect.ensuring(
            Effect.gen(function* () {
              const attempt = currentAttempt;
              currentAttempt = null;
              if (attempt !== null) {
                yield* session
                  .fallbackToWebSocket(attempt.attemptId)
                  .pipe(
                    Effect.catchTag("SocketError", (error) =>
                      Effect.logDebug("Could not replay WebRTC traffic over WebSocket.", { error }),
                    ),
                  );
                yield* session.closeDataChannel(attempt.attemptId);
                yield* session
                  .sendControl({ kind: "abort", attemptId: attempt.attemptId })
                  .pipe(
                    Effect.catchTag("SocketError", (error) =>
                      Effect.logDebug("Could not abort the WebRTC upgrade attempt.", { error }),
                    ),
                  );
              }
            }),
          ),
        );
        yield* Effect.sleep(RETRY_DELAYS[retryIndex] ?? MAX_RETRY_DELAY);
        retryIndex = Math.min(retryIndex + 1, RETRY_DELAYS.length - 1);
      }
    });
    yield* Effect.forkScoped(runAttempts);

    const onControl = (message: ControlMessage, source: "websocket" | "webrtc") => {
      switch (message.kind) {
        case "hello":
          if (source !== "websocket" || framingStarted) {
            return Effect.void;
          }
          framingStarted = true;
          return session.beginClientFraming(wireIceServers(message.iceServers));
        case "frame-start-ack":
          return source === "websocket" ? session.finishClientFraming : Effect.void;
        case "answer":
          if (source !== "websocket" || currentAttempt?.attemptId !== message.attemptId) {
            return Effect.void;
          }
          return Deferred.succeed(currentAttempt.answer, {
            sdp: message.sdp,
            bindingToken: message.bindingToken,
          }).pipe(Effect.asVoid);
        case "bind-ack":
          if (source !== "webrtc" || currentAttempt?.attemptId !== message.attemptId) {
            return Effect.void;
          }
          return Deferred.succeed(currentAttempt.bindAcknowledged, undefined).pipe(Effect.asVoid);
        case "cutover-ack":
          if (source !== "websocket" || currentAttempt?.attemptId !== message.attemptId) {
            return Effect.void;
          }
          return Deferred.succeed(currentAttempt.cutoverAcknowledged, undefined).pipe(
            Effect.asVoid,
          );
        case "abort":
          return source === "websocket" ? stopAttempt(message.attemptId, "aborted") : Effect.void;
        case "ack":
        case "bind":
        case "cutover":
        case "fallback":
        case "frame-start":
        case "hello-ack":
        case "offer":
          return Effect.void;
      }
    };

    return {
      onOpen: Effect.void,
      onControl,
      onRtcClosed: (attemptId: string) => stopAttempt(attemptId, "aborted"),
      close: Effect.void,
    };
  });
}

export function makeClientLogicalSocket(options: {
  readonly socket: Socket.Socket;
  readonly nonce: string;
  readonly peerFactory: ClientWebRtcPeerFactory;
}): Socket.Socket {
  return makeLogicalSocket({
    socket: options.socket,
    nonce: options.nonce,
    makeDriver: (session) => makeClientDriver(session, options.peerFactory),
  });
}

function isTerminalConnectionState(state: WebRtcPeerConnectionState): boolean {
  return state === "failed" || state === "closed";
}

export function makeClientWebRtcPeerFactory(options: {
  readonly createPeerConnection: (
    iceServers: ReadonlyArray<WebRtcIceServer>,
  ) => PlatformWebRtcPeerConnection;
  readonly randomBytes: (size: number) => Effect.Effect<Uint8Array, WebRtcPeerError>;
}): ClientWebRtcPeerFactory {
  return {
    randomBytes: options.randomBytes,
    create: Effect.fn("WebRtcClientPeerFactory.create")(function* (iceServers) {
      const peer = yield* Effect.try({
        try: () => options.createPeerConnection(iceServers),
        catch: (cause) => new WebRtcPeerError({ stage: "create", cause }),
      });
      const gathered = yield* Deferred.make<void, WebRtcPeerError>();
      const closed = yield* Deferred.make<never, WebRtcPeerError>();
      const removeGatheringListener = peer.onIceGatheringStateChange(() => {
        if (peer.iceGatheringState() === "complete") {
          Deferred.doneUnsafe(gathered, Effect.void);
        }
      });
      const removeConnectionListener = peer.onConnectionStateChange((state) => {
        if (isTerminalConnectionState(state)) {
          Deferred.doneUnsafe(
            closed,
            Effect.fail(
              new WebRtcPeerError({
                stage: "connection",
                cause: new Error(`WebRTC peer entered ${state} state.`),
              }),
            ),
          );
        }
      });
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          removeGatheringListener();
          removeConnectionListener();
          peer.close();
        }),
      );
      const dataChannel = yield* Effect.try({
        try: () => peer.createDataChannel(DATA_CHANNEL_LABEL),
        catch: (cause) => new WebRtcPeerError({ stage: "data-channel", cause }),
      });

      const createOffer = Effect.gen(function* () {
        const offer = yield* Effect.tryPromise({
          try: () => peer.createOffer(),
          catch: (cause) => new WebRtcPeerError({ stage: "offer", cause }),
        });
        if (offer === null) {
          return yield* new WebRtcPeerError({
            stage: "offer",
            cause: new Error("WebRTC peer did not produce an offer."),
          });
        }
        yield* Effect.tryPromise({
          try: () => peer.setLocalDescription(offer),
          catch: (cause) => new WebRtcPeerError({ stage: "offer", cause }),
        });
        if (peer.iceGatheringState() === "complete") {
          Deferred.doneUnsafe(gathered, Effect.void);
        }
        yield* Deferred.await(gathered);
        const description = peer.localDescription();
        if (description === null || description.type !== "offer") {
          return yield* new WebRtcPeerError({
            stage: "ice-gathering",
            cause: new Error("WebRTC peer did not produce a complete offer."),
          });
        }
        return description.sdp;
      }).pipe(Effect.raceFirst(Deferred.await(closed)));

      const acceptAnswer = Effect.fn("WebRtcClientPeer.acceptAnswer")(function* (
        answerSdp: string,
      ) {
        yield* Effect.tryPromise({
          try: () => peer.setRemoteDescription({ type: "answer", sdp: answerSdp }),
          catch: (cause) => new WebRtcPeerError({ stage: "answer", cause }),
        });
      });

      return {
        dataChannel,
        createOffer,
        acceptAnswer,
        closed: Deferred.await(closed),
        close: Effect.sync(() => peer.close()),
      };
    }),
  };
}
