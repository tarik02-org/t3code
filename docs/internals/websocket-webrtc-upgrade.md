# WebSocket WebRTC upgrade

The `packages/websocket-webrtc` workspace wraps an Effect `Socket.Socket`. Callers still create one
RPC client or server and see one ordered socket. The wrapper keeps the authenticated WebSocket open
for the full session and uses a reliable, ordered WebRTC DataChannel when both peers finish
negotiation.

The project integrations only provide platform adapters:

- `client.ts` owns browser and React Native peer negotiation.
- `server.ts` owns offer handling, one-time DataChannel binding, and cutover.
- `socket.ts` owns framing, ordering, acknowledgements, replay, and fallback.
- `werift.ts` is the optional Node server adapter. The peer interfaces can accept another adapter
  later without changing the framing protocol.

## Capability negotiation

The client adds `__t3_wsrtc=1.<nonce>` to the existing WebSocket URL. An older server ignores the
query parameter and continues with ordinary WebSocket messages. A supporting server waits until the
upgrade request has passed normal authentication, then sends a hidden `hello` control message tied
to that nonce. An older client never adds the marker, so a supporting server leaves its socket
untouched.

After `hello`, both peers cross a `frame-start` acknowledgement barrier before sending framed
application traffic. This keeps raw pre-negotiation messages separate from replayable messages.

The WebRTC attempt then follows this sequence:

1. The client sends an SDP offer over WebSocket.
2. The server returns an answer and a one-time binding token over WebSocket.
3. The client presents the token over the DataChannel and receives `bind-ack` there.
4. The client requests cutover over WebSocket.
5. The server selects the DataChannel and acknowledges cutover over WebSocket.

## Delivery rules

Each direction assigns a monotonic `uint64` sequence to application messages. DataChannel messages
use 16 KiB fragments. The receiver reassembles and delivers complete messages in sequence order,
then sends a cumulative acknowledgement over WebSocket.

The sender retains at most 16 MiB of unacknowledged frames. If the DataChannel closes, errors, or
backs up past its limit, the wrapper selects WebSocket and replays retained frames there. Duplicate
fragments are safe because the receiver keys them by message sequence and fragment index. WebSocket
close still ends the whole logical connection.

There is no NACK in version 1. Both physical transports are reliable, so cumulative ACK and replay
cover the path-switch case without another recovery mechanism.

## ICE configuration

Werift binds direct ICE candidates to UDP ports `60000-61000`. A server host must allow inbound UDP
traffic on that range. Direct connections, including LAN connections, fall back to WebSocket when
the host firewall blocks it.

The server defaults to `stun:stun.cloudflare.com:3478`. When
`T3CODE_WEBRTC_CLOUDFLARE_TURN_KEY_ID` and
`T3CODE_WEBRTC_CLOUDFLARE_TURN_API_TOKEN` are set, each authenticated WebRTC upgrade gets a fresh
Cloudflare TURN credential. The credential expires after 48 hours. Credential generation stays on
the server; clients only receive the short-lived ICE configuration over their authenticated
WebSocket.

Custom TURN configuration takes precedence over Cloudflare:

- `T3CODE_WEBRTC_STUN_URLS` sets a comma-separated STUN URL list.
- `T3CODE_WEBRTC_TURN_URLS` sets a comma-separated TURN URL list.
- `T3CODE_WEBRTC_TURN_USERNAME` and `T3CODE_WEBRTC_TURN_CREDENTIAL` set optional custom TURN
  authentication. Set both or neither.

If Cloudflare credential generation fails or takes longer than five seconds, the server advertises
STUN only. WebRTC can still connect directly; otherwise the logical socket stays on WebSocket.

## Client controls and diagnostics

Web and mobile clients enable the upgrade by default. Their Experimental settings include a
client-local `WebRTC transport` switch. Changing it restarts active environment connections so the
next RPC session either attempts the upgrade or stays on WebSocket.

The web environment connection tooltip shows the selected RPC transport and application-level
round-trip time. Opening the tooltip starts a connection health RPC every two seconds; closing it
stops the probes. The same measurement runs over WebSocket and the WebRTC DataChannel, so the values
are directly comparable.
