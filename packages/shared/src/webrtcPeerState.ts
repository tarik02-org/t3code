export type WebRtcPeerConnectionState =
  | "new"
  | "connecting"
  | "connected"
  | "disconnected"
  | "failed"
  | "closed";

export function isTerminalWebRtcPeerConnectionState(state: string): boolean {
  return state === "failed" || state === "closed";
}
