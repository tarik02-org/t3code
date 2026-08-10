import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import type { WebRtcIceServer } from "@t3tools/contracts";
import type { WebRtcDataChannelPort } from "@t3tools/shared/webrtcDataChannel";
import {
  makeWebRtcPeerFactory,
  type PlatformWebRtcPeerConnection,
  selectedIcePairTypeFromStats,
} from "./WebRtcPeer.ts";

it("reports only the selected ICE candidate pair types", () => {
  const stats = new Map<string, unknown>([
    ["transport", { type: "transport", selectedCandidatePairId: "pair" }],
    [
      "pair",
      {
        type: "candidate-pair",
        state: "succeeded",
        localCandidateId: "local",
        remoteCandidateId: "remote",
      },
    ],
    ["local", { type: "local-candidate", candidateType: "host", address: "192.0.2.1" }],
    ["remote", { type: "remote-candidate", candidateType: "srflx", address: "198.51.100.1" }],
  ]);

  expect(selectedIcePairTypeFromStats(stats)).toBe("host/srflx");
});

it("does not expose unknown candidate data", () => {
  const stats = new Map<string, unknown>([
    ["transport", { type: "transport", selectedCandidatePairId: "pair" }],
    ["pair", { localCandidateId: "local", remoteCandidateId: "remote" }],
    ["local", { candidateType: "future-type", address: "192.0.2.1" }],
    ["remote", { candidateType: "host", address: "198.51.100.1" }],
  ]);

  expect(selectedIcePairTypeFromStats(stats)).toBeNull();
});

it.effect("passes TURN configuration to the platform and preserves offer failures", () =>
  Effect.gen(function* () {
    const offerFailure = new Error("Platform offer failure.");
    const dataChannel = {
      label: "t3-rpc-v1",
      ordered: true,
      isOpen: () => false,
      bufferedAmount: () => 0,
      setBufferedAmountLowThreshold: () => undefined,
      send: () => undefined,
      close: () => undefined,
      onOpen: () => () => undefined,
      onMessage: () => () => undefined,
      onClose: () => () => undefined,
      onError: () => () => undefined,
      onBufferedAmountLow: () => () => undefined,
    } satisfies WebRtcDataChannelPort;
    let receivedIceServers: ReadonlyArray<WebRtcIceServer> = [];
    const factory = makeWebRtcPeerFactory((iceServers) => {
      receivedIceServers = iceServers;
      return {
        createDataChannel: () => dataChannel,
        createOffer: () => Promise.reject(offerFailure),
        setLocalDescription: () => Promise.resolve(),
        localDescription: () => null,
        setRemoteDescription: () => Promise.resolve(),
        iceGatheringState: () => "new",
        onIceGatheringStateChange: () => () => undefined,
        onConnectionStateChange: () => () => undefined,
        selectedIcePairType: () => Promise.resolve(null),
        close: () => undefined,
      } satisfies PlatformWebRtcPeerConnection;
    });
    const configuredIceServers = [
      {
        urls: ["turns:turn.example.test:5349"],
        username: "turn-user",
        credential: "turn-credential",
      },
    ];

    const peer = yield* factory.create(configuredIceServers);
    expect(receivedIceServers).toEqual(configuredIceServers);
    const error = yield* Effect.flip(peer.createOffer);
    expect(error.cause).toBe(offerFailure);
  }).pipe(Effect.scoped),
);
