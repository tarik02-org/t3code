import { expect, it } from "vite-plus/test";

import {
  isTerminalWebRtcPeerConnectionState,
  type WebRtcPeerConnectionState,
} from "./webrtcPeerState.ts";

it("keeps transient WebRTC peer states alive", () => {
  const states: ReadonlyArray<WebRtcPeerConnectionState> = [
    "new",
    "connecting",
    "connected",
    "disconnected",
  ];

  for (const state of states) {
    expect(isTerminalWebRtcPeerConnectionState(state)).toBe(false);
  }
});

it("closes WebRTC peers only for terminal states", () => {
  expect(isTerminalWebRtcPeerConnectionState("failed")).toBe(true);
  expect(isTerminalWebRtcPeerConnectionState("closed")).toBe(true);
});
