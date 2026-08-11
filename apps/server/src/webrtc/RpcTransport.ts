import * as Context from "effect/Context";

export type RpcTransportKind = "websocket" | "webrtc";

export const RpcTransport = Context.Service<RpcTransportKind>("t3/webrtc/RpcTransport");
