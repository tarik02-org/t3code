import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import type * as Socket from "effect/unstable/socket/Socket";
import * as SocketServer from "effect/unstable/socket/SocketServer";

export interface SingleSocketServer {
  readonly server: SocketServer.SocketServer["Service"];
  readonly accept: (socket: Socket.Socket) => Effect.Effect<void>;
}

export const makeSingleSocketServer = Effect.fn("SingleSocketServer.make")(function* () {
  const sockets = yield* Queue.unbounded<Socket.Socket>();
  const server = SocketServer.SocketServer.of({
    address: { _tag: "UnixAddress", path: "webrtc:datachannel" },
    run: (handler) =>
      Effect.scoped(
        Stream.fromQueue(sockets).pipe(
          Stream.runForEach((socket) => handler(socket).pipe(Effect.forkScoped, Effect.asVoid)),
          Effect.andThen(Effect.never),
        ),
      ),
  });
  return {
    server,
    accept: (socket) => Queue.offer(sockets, socket).pipe(Effect.asVoid),
  } satisfies SingleSocketServer;
});
