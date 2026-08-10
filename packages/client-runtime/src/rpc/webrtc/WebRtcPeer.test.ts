import { expect, it } from "vite-plus/test";

import { selectedIcePairTypeFromStats } from "./WebRtcPeer.ts";

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
