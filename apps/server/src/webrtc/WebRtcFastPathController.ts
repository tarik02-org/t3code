import {
  WebRtcBindingFrame,
  WebRtcFastPathBusyError,
  WebRtcFastPathDisabledError,
  WebRtcFastPathInvalidAttemptError,
  WebRtcFastPathInvalidSdpError,
  WebRtcFastPathNegotiationError,
  WebRtcFastPathUnsupportedError,
  type WebRtcNegotiateInput,
  type WebRtcNegotiateResult,
  type WebRtcRpcFastPathCapability,
  type WebRtcSignalingError,
} from "@t3tools/contracts";
import {
  validateSessionDescription,
  validateStunUrls,
} from "@t3tools/shared/webrtcCandidatePolicy";
import { makeWebRtcDataChannelConnection } from "@t3tools/shared/webrtcDataChannel";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";

import type { SingleSocketServer } from "./SingleSocketServer.ts";
import type { ServerWebRtcPeer, ServerWebRtcRuntime } from "./WebRtcPeer.ts";
import { DEFAULT_WEBRTC_UDP_PORT_RANGE, type WebRtcUdpPortRange } from "./config.ts";

const DEFAULT_ATTEMPT_TTL_MS = 30_000;
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_ATTEMPTS = 5;

const decodeBindingFrame = Schema.decodeUnknownEffect(Schema.fromJsonString(WebRtcBindingFrame));

interface ActiveAttempt {
  readonly attemptId: string;
  readonly bindingToken: string;
  readonly expiresAtMs: number;
  readonly peer: ServerWebRtcPeer;
  readonly bound: boolean;
}

export interface WebRtcFastPathController {
  readonly capability: WebRtcRpcFastPathCapability | null;
  readonly negotiate: (
    input: WebRtcNegotiateInput,
  ) => Effect.Effect<WebRtcNegotiateResult, WebRtcSignalingError>;
  readonly abort: (attemptId: string) => Effect.Effect<{}, WebRtcSignalingError>;
  readonly close: Effect.Effect<void>;
}

export interface WebRtcFastPathControllerOptions {
  readonly enabled: boolean;
  readonly stunUrls: ReadonlyArray<string>;
  readonly runtime: Option.Option<ServerWebRtcRuntime>;
  readonly socketServer: SingleSocketServer;
  readonly udpPortRange?: WebRtcUdpPortRange;
  readonly attemptTtlMs?: number;
}

export function webRtcAttemptExpired(expiresAtMs: number, nowMs: number): boolean {
  return nowMs >= expiresAtMs;
}

export const makeWebRtcFastPathController = Effect.fn("WebRtcFastPathController.make")(function* (
  options: WebRtcFastPathControllerOptions,
) {
  const scope = yield* Scope.Scope;
  const crypto = yield* Crypto.Crypto;
  const negotiationLock = yield* Semaphore.make(1);
  const active = yield* Ref.make<ActiveAttempt | null>(null);
  const attemptTimes = yield* Ref.make<ReadonlyArray<number>>([]);
  const attemptTtlMs = options.attemptTtlMs ?? DEFAULT_ATTEMPT_TTL_MS;
  const runtime = Option.getOrNull(options.runtime);
  const stunUrls = yield* Effect.try({
    try: () => validateStunUrls(options.stunUrls),
    catch: () => null,
  });
  const capability: WebRtcRpcFastPathCapability | null =
    options.enabled && runtime !== null && stunUrls !== null
      ? {
          version: 1,
          signaling: "same-websocket-rpc",
          turn: false,
          stunUrls: [...stunUrls],
        }
      : null;

  const closeAttempt = (attempt: ActiveAttempt | null) =>
    attempt === null ? Effect.void : attempt.peer.close;
  const clearAttempt = Effect.fn("WebRtcFastPathController.clearAttempt")(function* (
    attemptId: string,
  ) {
    const attempt = yield* Ref.modify(active, (current) =>
      current?.attemptId === attemptId ? [current, null] : [null, current],
    );
    yield* closeAttempt(attempt);
  });

  const handleBinding = Effect.fn("WebRtcFastPathController.handleBinding")(function* (
    attempt: ActiveAttempt,
  ) {
    const port = yield* attempt.peer.takeDataChannel;
    if (port.label !== "t3-rpc-v1" || !port.ordered) {
      return yield* new WebRtcFastPathInvalidAttemptError({
        message: "WebRTC DataChannel does not match the negotiated RPC transport.",
      });
    }
    const connection = yield* makeWebRtcDataChannelConnection(port);
    yield* connection.awaitOpen;
    const bindingBytes = yield* connection.awaitBinding;
    const binding = yield* decodeBindingFrame(new TextDecoder().decode(bindingBytes)).pipe(
      Effect.mapError(
        () =>
          new WebRtcFastPathInvalidAttemptError({
            message: "WebRTC binding frame is invalid.",
          }),
      ),
    );
    const nowMs = yield* Clock.currentTimeMillis;
    const current = yield* Ref.get(active);
    if (
      current === null ||
      current.bound ||
      current.attemptId !== attempt.attemptId ||
      binding.attemptId !== attempt.attemptId ||
      binding.bindingToken !== attempt.bindingToken ||
      webRtcAttemptExpired(attempt.expiresAtMs, nowMs)
    ) {
      return yield* new WebRtcFastPathInvalidAttemptError({
        message: "WebRTC binding attempt is invalid or expired.",
      });
    }
    yield* Ref.set(active, { ...attempt, bound: true });
    yield* connection.sendBindingAck;
    yield* options.socketServer.accept(connection.socket);
    yield* Effect.logDebug("WebRTC RPC DataChannel bound.").pipe(
      Effect.annotateLogs({
        "rpc.transport": "webrtc",
        "webrtc.attempt.result": "selected",
      }),
    );
    const logStats = Effect.all({
      bytesSent: attempt.peer.bytesSent,
      bytesReceived: attempt.peer.bytesReceived,
      selectedIcePairType: attempt.peer.selectedIcePairType,
    }).pipe(
      Effect.flatMap((stats) =>
        Effect.logDebug("WebRTC RPC DataChannel closed.").pipe(
          Effect.annotateLogs({
            "rpc.transport": "webrtc",
            "webrtc.bytes_sent": stats.bytesSent,
            "webrtc.bytes_received": stats.bytesReceived,
            ...(stats.selectedIcePairType === null
              ? {}
              : { "webrtc.selected_ice_pair_type": stats.selectedIcePairType }),
          }),
        ),
      ),
    );
    return yield* Effect.raceFirst(attempt.peer.closed, connection.closed).pipe(
      Effect.ensuring(logStats),
    );
  });

  const negotiateUnlocked = Effect.fn("WebRtcFastPathController.negotiateUnlocked")(function* (
    input: WebRtcNegotiateInput,
  ) {
    if (!options.enabled) {
      return yield* new WebRtcFastPathDisabledError({ message: "WebRTC fast path is disabled." });
    }
    if (runtime === null || capability === null || stunUrls === null) {
      return yield* new WebRtcFastPathUnsupportedError({
        message: "WebRTC fast path is unavailable on this server.",
      });
    }
    yield* Effect.try({
      try: () => validateSessionDescription(input.offerSdp),
      catch: () => new WebRtcFastPathInvalidSdpError({ message: "WebRTC offer SDP is invalid." }),
    });
    const nowMs = yield* Clock.currentTimeMillis;
    const recentAttempts = (yield* Ref.get(attemptTimes)).filter(
      (attemptedAtMs) => nowMs - attemptedAtMs < RATE_LIMIT_WINDOW_MS,
    );
    if (recentAttempts.length >= RATE_LIMIT_ATTEMPTS) {
      return yield* new WebRtcFastPathBusyError({
        message: "WebRTC negotiation rate limit reached.",
      });
    }
    yield* Ref.set(attemptTimes, [...recentAttempts, nowMs]);
    const previous = yield* Ref.getAndSet(active, null);
    yield* closeAttempt(previous);
    const peer = yield* runtime
      .createPeer(input.attemptId, stunUrls, options.udpPortRange ?? DEFAULT_WEBRTC_UDP_PORT_RANGE)
      .pipe(
        Effect.mapError(
          () =>
            new WebRtcFastPathNegotiationError({
              message: "WebRTC peer initialization failed.",
            }),
        ),
      );
    return yield* Effect.gen(function* () {
      const answerSdp = yield* peer
        .acceptOffer(input.offerSdp)
        .pipe(
          Effect.mapError(
            () =>
              new WebRtcFastPathNegotiationError({ message: "WebRTC offer negotiation failed." }),
          ),
        );
      yield* Effect.try({
        try: () => validateSessionDescription(answerSdp),
        catch: () =>
          new WebRtcFastPathNegotiationError({
            message: "WebRTC generated an invalid answer.",
          }),
      });
      const bindingToken = yield* crypto.randomBytes(32).pipe(
        Effect.map(Encoding.encodeBase64Url),
        Effect.mapError(
          () =>
            new WebRtcFastPathNegotiationError({
              message: "WebRTC binding token generation failed.",
            }),
        ),
      );
      const bindingStartedAtMs = yield* Clock.currentTimeMillis;
      const expiresAtMs = bindingStartedAtMs + attemptTtlMs;
      const attempt: ActiveAttempt = {
        attemptId: input.attemptId,
        bindingToken,
        expiresAtMs,
        peer,
        bound: false,
      };
      yield* Ref.set(active, attempt);
      const bindingDeadline = Effect.sleep(Duration.millis(attemptTtlMs)).pipe(
        Effect.andThen(Ref.get(active)),
        Effect.flatMap((current) =>
          current?.attemptId === attempt.attemptId && current.bound === false
            ? Effect.fail(
                new WebRtcFastPathInvalidAttemptError({
                  message: "WebRTC binding attempt expired.",
                }),
              )
            : Effect.never,
        ),
      );
      yield* Effect.forkIn(
        Effect.scoped(handleBinding(attempt)).pipe(
          Effect.raceFirst(bindingDeadline),
          Effect.tapError(() => clearAttempt(attempt.attemptId)),
          Effect.ignore,
        ),
        scope,
      );
      return {
        version: 1,
        attemptId: input.attemptId,
        answerSdp,
        bindingToken,
        expiresAt: DateTime.formatIso(DateTime.makeUnsafe(expiresAtMs)),
      } satisfies WebRtcNegotiateResult;
    }).pipe(Effect.onError(() => peer.close.pipe(Effect.andThen(clearAttempt(input.attemptId)))));
  });

  const negotiate = Effect.fn("WebRtcFastPathController.negotiate")(function* (
    input: WebRtcNegotiateInput,
  ) {
    const result = yield* negotiationLock.withPermitsIfAvailable(1)(negotiateUnlocked(input));
    if (Option.isNone(result)) {
      return yield* new WebRtcFastPathBusyError({
        message: "Another WebRTC negotiation is already active.",
      });
    }
    return result.value;
  });

  const abort = Effect.fn("WebRtcFastPathController.abort")(function* (attemptId: string) {
    const current = yield* Ref.get(active);
    if (current === null || current.attemptId !== attemptId) {
      return yield* new WebRtcFastPathInvalidAttemptError({
        message: "WebRTC attempt is invalid or expired.",
      });
    }
    const diagnosticState = yield* current.peer.diagnosticState;
    yield* Effect.logInfo("WebRTC negotiation aborted by the client.").pipe(
      Effect.annotateLogs({
        "webrtc.attempt.result": "aborted",
        "webrtc.peer.connection_state": diagnosticState.connectionState,
        "webrtc.peer.gathering_state": diagnosticState.gatheringState,
        "webrtc.peer.ice_state": diagnosticState.iceState,
      }),
    );
    yield* clearAttempt(attemptId);
    return {};
  });

  const close = Ref.getAndSet(active, null).pipe(Effect.flatMap(closeAttempt));
  yield* Effect.addFinalizer(() => close);

  return {
    capability,
    negotiate,
    abort,
    close,
  } satisfies WebRtcFastPathController;
});
