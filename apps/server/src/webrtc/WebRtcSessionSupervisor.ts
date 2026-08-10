import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";

export class WebRtcSessionSupervisor extends Context.Service<
  WebRtcSessionSupervisor,
  {
    readonly forkScope: Effect.Effect<Scope.Closeable>;
    readonly fork: <A, E, R>(
      effect: Effect.Effect<A, E, R>,
    ) => Effect.Effect<Fiber.Fiber<A, E>, never, R>;
  }
>()("t3/webrtc/WebRtcSessionSupervisor") {}

export const makeWebRtcSessionSupervisor = Effect.fn("WebRtcSessionSupervisor.make")(function* () {
  const parentScope = yield* Scope.Scope;

  return WebRtcSessionSupervisor.of({
    forkScope: Scope.fork(parentScope, "sequential"),
    fork<A, E, R>(effect: Effect.Effect<A, E, R>) {
      return Effect.forkIn(effect, parentScope, { startImmediately: true });
    },
  });
});

export const WebRtcSessionSupervisorLive = Layer.effect(
  WebRtcSessionSupervisor,
  makeWebRtcSessionSupervisor(),
);
