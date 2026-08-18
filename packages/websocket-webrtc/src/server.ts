import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import type * as Socket from "effect/unstable/socket/Socket";

import { type ServerWebRtcPeerFactory, type WebRtcIceServer, WebRtcPeerError } from "./peer.ts";
import { makeLogicalSocket, type LogicalSocketSession } from "./socket.ts";
import {
  DATA_CHANNEL_LABEL,
  type ControlMessage,
  PROTOCOL_VERSION,
  wireIceServers,
} from "./wire.ts";

const SERVER_NEGOTIATION_TIMEOUT = "15 seconds";

interface ServerAttemptState {
  readonly attemptId: string;
  readonly scope: Scope.Closeable;
  bindingToken: string | null;
  bound: boolean;
}

function makeServerDriver(options: {
  readonly session: LogicalSocketSession;
  readonly peerFactory: ServerWebRtcPeerFactory;
  readonly iceServers: ReadonlyArray<WebRtcIceServer>;
}) {
  return Effect.gen(function* () {
    const driverScope = yield* Scope.Scope;
    let currentAttempt: ServerAttemptState | null = null;
    let clientAccepted = false;
    let framingComplete = false;

    const disposeAttempt = (attempt: ServerAttemptState) =>
      Effect.gen(function* () {
        if (currentAttempt === attempt) {
          currentAttempt = null;
        }
        yield* options.session.closeDataChannel(attempt.attemptId);
        yield* Scope.close(attempt.scope, Exit.void);
      });

    const failAttempt = (
      attempt: ServerAttemptState,
      error: Error | Socket.SocketError | WebRtcPeerError,
    ) =>
      disposeAttempt(attempt).pipe(
        Effect.andThen(
          options.session.sendControl({ kind: "abort", attemptId: attempt.attemptId }),
        ),
        Effect.catchTag("SocketError", (socketError) =>
          Effect.logDebug("Could not report a failed WebRTC server attempt.", { socketError }),
        ),
        Effect.andThen(Effect.logDebug("WebRTC server attempt failed.", { error })),
      );

    const processOffer = Effect.fn("WebRtcServer.processOffer")(function* (
      attemptId: string,
      offerSdp: string,
    ) {
      const previousAttempt = currentAttempt;
      if (previousAttempt !== null) {
        yield* options.session.fallbackToWebSocket(previousAttempt.attemptId);
        yield* disposeAttempt(previousAttempt);
      }

      const attemptScope = yield* Scope.make();
      const attempt: ServerAttemptState = {
        attemptId,
        scope: attemptScope,
        bindingToken: null,
        bound: false,
      };
      currentAttempt = attempt;
      const peer = yield* options.peerFactory
        .create(options.iceServers)
        .pipe(Scope.provide(attemptScope));
      const bindingToken = Encoding.encodeBase64Url(yield* options.peerFactory.randomBytes(32));
      const answerSdp = yield* peer.acceptOffer(offerSdp).pipe(
        Effect.timeoutOption(SERVER_NEGOTIATION_TIMEOUT),
        Effect.flatMap(
          Option.match({
            onNone: () =>
              Effect.fail(
                new WebRtcPeerError({
                  stage: "answer",
                  cause: new Error("WebRTC server answer timed out."),
                }),
              ),
            onSome: Effect.succeed,
          }),
        ),
      );
      if (currentAttempt !== attempt) {
        yield* Scope.close(attemptScope, Exit.void);
        return;
      }
      attempt.bindingToken = bindingToken;
      yield* options.session.sendControl({
        kind: "answer",
        attemptId,
        sdp: answerSdp,
        bindingToken,
      });

      yield* peer.dataChannel.pipe(
        Effect.flatMap((port) => {
          if (port.label !== DATA_CHANNEL_LABEL || !port.ordered) {
            return failAttempt(
              attempt,
              new Error("Client created an incompatible WebRTC DataChannel."),
            );
          }
          if (currentAttempt !== attempt) {
            port.close();
            return Effect.void;
          }
          return options.session.attachDataChannel(attemptId, port);
        }),
        Effect.catchTags({
          SocketError: (error) => failAttempt(attempt, error),
          WebRtcPeerError: (error) => failAttempt(attempt, error),
        }),
        Effect.forkIn(driverScope),
      );

      yield* peer.closed.pipe(
        Effect.catchTag("WebRtcPeerError", (error) => {
          if (currentAttempt !== attempt) {
            return Effect.void;
          }
          return options.session.fallbackToWebSocket(attemptId).pipe(
            Effect.andThen(disposeAttempt(attempt)),
            Effect.andThen(options.session.sendControl({ kind: "fallback", attemptId })),
            Effect.catchTag("SocketError", (socketError) =>
              Effect.logDebug("Could not report a closed WebRTC server peer.", {
                error,
                socketError,
              }),
            ),
          );
        }),
        Effect.forkIn(driverScope),
      );
    });

    const startOffer = (attemptId: string, offerSdp: string) =>
      processOffer(attemptId, offerSdp).pipe(
        Effect.catchTags({
          SocketError: (error) => {
            const attempt = currentAttempt;
            return attempt?.attemptId === attemptId
              ? failAttempt(attempt, error)
              : Effect.logDebug("WebRTC server signaling failed.", { error });
          },
          WebRtcPeerError: (error) => {
            const attempt = currentAttempt;
            return attempt?.attemptId === attemptId
              ? failAttempt(attempt, error)
              : Effect.logDebug("WebRTC server peer setup failed.", { error });
          },
        }),
        Effect.forkIn(driverScope),
        Effect.asVoid,
      );

    const onControl = (message: ControlMessage, source: "websocket" | "webrtc") => {
      switch (message.kind) {
        case "hello-ack":
          if (source === "websocket") {
            clientAccepted = true;
          }
          return Effect.void;
        case "frame-start":
          if (source !== "websocket" || !clientAccepted || framingComplete) {
            return Effect.void;
          }
          framingComplete = true;
          return options.session.finishServerFraming;
        case "offer":
          return source === "websocket" && framingComplete
            ? startOffer(message.attemptId, message.sdp)
            : Effect.void;
        case "bind": {
          const attempt = currentAttempt;
          if (
            source !== "webrtc" ||
            attempt?.attemptId !== message.attemptId ||
            attempt.bindingToken !== message.bindingToken ||
            attempt.bound
          ) {
            return Effect.void;
          }
          attempt.bound = true;
          attempt.bindingToken = null;
          return options.session.sendRtcControl(message.attemptId, {
            kind: "bind-ack",
            attemptId: message.attemptId,
          });
        }
        case "cutover": {
          const attempt = currentAttempt;
          if (
            source !== "websocket" ||
            attempt?.attemptId !== message.attemptId ||
            !attempt.bound
          ) {
            return Effect.void;
          }
          return options.session.selectDataChannel(message.attemptId).pipe(
            Effect.andThen(
              options.session.sendControl({
                kind: "cutover-ack",
                attemptId: message.attemptId,
              }),
            ),
          );
        }
        case "abort": {
          const attempt = currentAttempt;
          return source === "websocket" && attempt?.attemptId === message.attemptId
            ? disposeAttempt(attempt)
            : Effect.void;
        }
        case "ack":
        case "answer":
        case "bind-ack":
        case "cutover-ack":
        case "fallback":
        case "frame-start-ack":
        case "hello":
          return Effect.void;
      }
    };

    return {
      onOpen: options.session
        .sendControl({
          kind: "hello",
          version: PROTOCOL_VERSION,
          iceServers: wireIceServers(options.iceServers),
        })
        .pipe(
          Effect.catchTag("SocketError", (error) =>
            Effect.logDebug("Could not advertise WebRTC upgrade support.", { error }),
          ),
        ),
      onControl,
      onRtcClosed: (attemptId: string) => {
        const attempt = currentAttempt;
        if (attempt?.attemptId !== attemptId) {
          return Effect.void;
        }
        return disposeAttempt(attempt).pipe(
          Effect.andThen(options.session.sendControl({ kind: "fallback", attemptId })),
        );
      },
      close: Effect.suspend(() =>
        currentAttempt === null ? Effect.void : disposeAttempt(currentAttempt),
      ),
    };
  });
}

export function makeServerLogicalSocket(options: {
  readonly socket: Socket.Socket;
  readonly nonce: string;
  readonly peerFactory: ServerWebRtcPeerFactory;
  readonly iceServers?: ReadonlyArray<WebRtcIceServer>;
}): Socket.Socket {
  const iceServers = options.iceServers ?? [];
  return makeLogicalSocket({
    socket: options.socket,
    nonce: options.nonce,
    makeDriver: (session) =>
      makeServerDriver({
        session,
        peerFactory: options.peerFactory,
        iceServers,
      }),
  });
}
