# WebRTC RPC fast path

T3 Code can run `WsRpcGroup` over one reliable, ordered WebRTC DataChannel named
`t3-rpc-v1`. This is an optional transport upgrade, not a separate connection
mode.

The client first establishes and authenticates the normal environment WebSocket.
It reads `server.getConfig` there and negotiates WebRTC through
`transport.webrtc.negotiate` on that same socket. The server binds the new
DataChannel to the authenticated WebSocket with a short-lived attempt ID and a
one-time random token. The client selects WebRTC only after `server.probe` and a
matching `server.getConfig` succeed over the DataChannel.

The control WebSocket remains open and authoritative for authentication,
signaling, presence, and lifetime. Signaling calls made over WebRTC are rejected.
If the control WebSocket closes, the server and client close its DataChannel. If
a selected DataChannel closes, the normal environment supervisor replaces the
whole session. It does not replay requests or move in-flight streams between
transports.

## ICE policy and support

The server uses `werift`, a pure TypeScript WebRTC implementation that ships in
the existing Node and desktop bundles without a native artifact. Web and desktop
renderers use the browser WebRTC implementation. Mobile uses
`react-native-webrtc` through its Expo config plugin.

Only direct host, peer-reflexive, and server-reflexive ICE candidates are
accepted. Configuration rejects `turn:` and `turns:` URLs, and both peers reject
SDP containing `typ relay`. There is no TURN service or TURN fallback. Symmetric
NATs, restrictive firewalls, blocked UDP, and some enterprise networks can
therefore prevent the fast path. T3 Code silently keeps using the already-open
WebSocket in those cases.

The upgrade runs after any connection target has produced an authenticated
environment WebSocket. Relay, managed endpoint, manual bearer, SSH-forwarded,
web, desktop, and mobile connections use the same path.

## Configuration

- `T3CODE_WEBRTC_FAST_PATH=0` disables the server capability.
- `T3CODE_WEBRTC_STUN_URLS` is a comma-separated STUN-only list. The default is
  `stun:stun.cloudflare.com:3478`. An empty list permits host candidates only.
- `T3CODE_WEBRTC_UDP_PORT_RANGE` sets the server candidate range as `min-max`.
  The default is `60000-61000`. Host firewalls must allow inbound UDP on this
  range for direct and server-reflexive candidates to work.

The server advertises the capability only when it is enabled, the STUN list is
valid, and the optional runtime loads. A missing runtime never prevents
WebSocket startup.

## Diagnostics

Debug traces annotate RPC work with `rpc.transport=websocket|webrtc`. WebRTC
attempts add `webrtc.attempt.result`, `webrtc.fallback.reason`, negotiation and
DataChannel-open durations, byte counters, and the selected candidate pair types
when the platform exposes them. Logs never contain SDP, candidate strings, IP
addresses, DTLS fingerprints, binding tokens, or authentication tokens.

When WebRTC is selected, initial shell and thread snapshots come from their
existing socket subscriptions. HTTP remains in use for WebSocket sessions and
for older thread pages.
