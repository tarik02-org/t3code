import * as Effect from "effect/Effect";
import type * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import type * as Socket from "effect/unstable/socket/Socket";

export function mapSocketUpgrade(
  request: HttpServerRequest.HttpServerRequest,
  mapSocket: (socket: Socket.Socket) => Socket.Socket,
): HttpServerRequest.HttpServerRequest {
  const upgrade = request.upgrade.pipe(Effect.map(mapSocket));
  return new Proxy(request, {
    get(target, property, receiver) {
      if (property === "upgrade") {
        return upgrade;
      }
      if (property === "modify") {
        return (options: Parameters<HttpServerRequest.HttpServerRequest["modify"]>[0]) =>
          mapSocketUpgrade(target.modify(options), mapSocket);
      }
      return Reflect.get(target, property, receiver);
    },
  });
}
