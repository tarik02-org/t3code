# WebRTC RPC fast path

T3 Code can run `WsRpcGroup` over one reliable, ordered WebRTC DataChannel named
`t3-rpc-v1`. This is an optional transport upgrade, not a separate connection
mode.

The client first establishes and authenticates the normal environment WebSocket.
It reads `server.getConfig` there and exposes the WebSocket session immediately.
WebRTC negotiation then runs as a background upgrade through
`transport.webrtc.negotiate` on that same socket. The server binds the new
DataChannel to the authenticated WebSocket with a short-lived attempt ID and a
one-time random token. The client selects WebRTC only after `server.probe` and a
matching `server.getConfig` succeed over the DataChannel.

The control WebSocket remains the authentication and signaling channel while it
is connected. Signaling calls made over WebRTC are rejected. Once the binding
frame and RTC probe succeed, the authenticated server session can continue over
the DataChannel if the control WebSocket later disconnects. Negotiation that has
not reached that point still ends with the WebSocket. If the selected
DataChannel closes, the normal environment supervisor replaces the whole
session. It does not replay requests or move in-flight streams between
transports.

## ICE configuration and support

The server uses `werift`, a pure TypeScript WebRTC implementation that ships in
the existing Node and desktop bundles without a native artifact. Web and desktop
renderers use the browser WebRTC implementation. Mobile uses
`react-native-webrtc` through its Expo config plugin.

The default configuration uses one public STUN server and no TURN server. A
server operator can add `turn:` or `turns:` URLs and credentials through the
environment. The authenticated capability response sends the resulting ICE
server list to web, desktop, and mobile clients, and both peers use the same
list. T3 Code does not run a TURN service itself.

Without configured TURN, symmetric NATs, restrictive firewalls, blocked UDP,
and some enterprise networks can prevent the fast path. A configured TURN
server allows relay candidates for those networks. If ICE still fails, T3 Code
keeps using the already-open WebSocket.

The upgrade runs after any connection target has produced an authenticated
environment WebSocket. Relay, managed endpoint, manual bearer, SSH-forwarded,
web, desktop, and mobile connections use the same path.

## Configuration

- `T3CODE_WEBRTC_FAST_PATH=0` disables the server capability.
- `T3CODE_WEBRTC_STUN_URLS` is a comma-separated STUN list. The default is
  `stun:stun.cloudflare.com:3478`. An empty list permits host candidates only.
- `T3CODE_WEBRTC_TURN_URLS` is a comma-separated TURN list. It is empty by
  default. Both `turn:` and `turns:` URLs are accepted.
- `T3CODE_WEBRTC_TURN_USERNAME` and `T3CODE_WEBRTC_TURN_CREDENTIAL` configure
  TURN password authentication. Set both or neither. The credential is read as
  a redacted server setting and is never written to logs.
- `T3CODE_WEBRTC_UDP_PORT_RANGE` sets the server candidate range as `min-max`.
  The default is `60000-61000`. Host firewalls must allow inbound UDP on this
  range for direct and server-reflexive candidates to work.

The server advertises the capability only when it is enabled and the optional
runtime loads. Invalid ICE configuration fails with a typed configuration error.
A missing WebRTC runtime never prevents WebSocket startup.

## Diagnostics

Debug traces annotate RPC work with `rpc.transport=websocket|webrtc`. WebRTC
attempts add `webrtc.attempt.result`, `webrtc.fallback.reason`, negotiation and
DataChannel-open durations, byte counters, and the selected candidate pair types
when the platform exposes them. Logs never contain SDP, candidate strings, IP
addresses, DTLS fingerprints, binding tokens, or authentication tokens.

When WebRTC is selected, initial shell and thread snapshots come from their
existing socket subscriptions. HTTP remains in use for WebSocket sessions and
for older thread pages.
