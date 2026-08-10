import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";

import type { WebRtcIceServer } from "@t3tools/contracts";
import {
  isTerminalWebRtcPeerConnectionState,
  type WebRtcPeerConnectionState,
} from "@t3tools/shared/webrtcPeerState";
import {
  WebRtcPeerError,
  type WebRtcPeer,
  type WebRtcPeerFactoryService,
} from "../../platform/capabilities.ts";
import type { WebRtcDataChannelPort } from "@t3tools/shared/webrtcDataChannel";

const ICE_CANDIDATE_TYPES = new Set(["host", "prflx", "relay", "srflx"]);

export interface WebRtcSessionDescription {
  readonly type: "offer" | "answer";
  readonly sdp: string;
}

export interface PlatformWebRtcPeerConnection {
  readonly createDataChannel: (label: string) => WebRtcDataChannelPort;
  readonly createOffer: () => Promise<WebRtcSessionDescription | null>;
  readonly setLocalDescription: (description: WebRtcSessionDescription) => Promise<void>;
  readonly localDescription: () => WebRtcSessionDescription | null;
  readonly setRemoteDescription: (description: WebRtcSessionDescription) => Promise<void>;
  readonly iceGatheringState: () => "new" | "gathering" | "complete";
  readonly onIceGatheringStateChange: (listener: () => void) => () => void;
  readonly onConnectionStateChange: (
    listener: (state: WebRtcPeerConnectionState) => void,
  ) => () => void;
  readonly selectedIcePairType: () => Promise<string | null>;
  readonly close: () => void;
}

export interface WebRtcStatsReportLike {
  readonly get: (id: string) => unknown;
  readonly forEach: (callback: (report: unknown) => void) => void;
}

export function selectedIcePairTypeFromStats(stats: WebRtcStatsReportLike): string | null {
  let selectedPairId: string | null = null;
  let nominatedPair: Readonly<Record<string, unknown>> | null = null;
  stats.forEach((value) => {
    if (typeof value !== "object" || value === null) {
      return;
    }
    const report = value as Readonly<Record<string, unknown>>;
    if (report.type === "transport" && typeof report.selectedCandidatePairId === "string") {
      selectedPairId = report.selectedCandidatePairId;
    }
    if (
      report.type === "candidate-pair" &&
      report.state === "succeeded" &&
      report.nominated === true
    ) {
      nominatedPair = report;
    }
  });

  const selectedPair = selectedPairId === null ? nominatedPair : stats.get(selectedPairId);
  if (typeof selectedPair !== "object" || selectedPair === null) {
    return null;
  }
  const pair = selectedPair as Readonly<Record<string, unknown>>;
  if (typeof pair.localCandidateId !== "string" || typeof pair.remoteCandidateId !== "string") {
    return null;
  }
  const localCandidate = stats.get(pair.localCandidateId);
  const remoteCandidate = stats.get(pair.remoteCandidateId);
  if (
    typeof localCandidate !== "object" ||
    localCandidate === null ||
    typeof remoteCandidate !== "object" ||
    remoteCandidate === null
  ) {
    return null;
  }
  const localType = (localCandidate as Readonly<Record<string, unknown>>).candidateType;
  const remoteType = (remoteCandidate as Readonly<Record<string, unknown>>).candidateType;
  if (
    typeof localType !== "string" ||
    !ICE_CANDIDATE_TYPES.has(localType) ||
    typeof remoteType !== "string" ||
    !ICE_CANDIDATE_TYPES.has(remoteType)
  ) {
    return null;
  }
  return `${localType}/${remoteType}`;
}

export function makeWebRtcPeerFactory(
  createPeerConnection: (
    iceServers: ReadonlyArray<WebRtcIceServer>,
  ) => PlatformWebRtcPeerConnection,
): WebRtcPeerFactoryService {
  return {
    create: Effect.fn("WebRtcPeerFactory.create")(function* (
      iceServers: ReadonlyArray<WebRtcIceServer>,
    ) {
      const peer = yield* Effect.try({
        try: () => createPeerConnection(iceServers),
        catch: (cause) => new WebRtcPeerError({ stage: "create", cause }),
      });
      const gathered = yield* Deferred.make<void, WebRtcPeerError>();
      const closed = yield* Deferred.make<never, WebRtcPeerError>();
      const removeGatheringListener = peer.onIceGatheringStateChange(() => {
        if (peer.iceGatheringState() === "complete") {
          Deferred.doneUnsafe(gathered, Effect.void);
        }
      });
      const removeConnectionListener = peer.onConnectionStateChange((state) => {
        if (isTerminalWebRtcPeerConnectionState(state)) {
          Deferred.doneUnsafe(
            closed,
            Effect.fail(
              new WebRtcPeerError({
                stage: "connection",
                cause: new Error(`WebRTC peer entered ${state} state.`),
              }),
            ),
          );
        }
      });
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          removeGatheringListener();
          removeConnectionListener();
          peer.close();
        }),
      );
      const dataChannel = yield* Effect.try({
        try: () => peer.createDataChannel("t3-rpc-v1"),
        catch: (cause) => new WebRtcPeerError({ stage: "create", cause }),
      });

      const createOffer = Effect.gen(function* () {
        const offer = yield* Effect.tryPromise({
          try: () => peer.createOffer(),
          catch: (cause) => new WebRtcPeerError({ stage: "offer", cause }),
        });
        if (offer === null) {
          return yield* new WebRtcPeerError({
            stage: "offer",
            cause: new Error("WebRTC peer did not produce a valid offer."),
          });
        }
        yield* Effect.tryPromise({
          try: () => peer.setLocalDescription(offer),
          catch: (cause) => new WebRtcPeerError({ stage: "offer", cause }),
        });
        if (peer.iceGatheringState() === "complete") {
          Deferred.doneUnsafe(gathered, Effect.void);
        }
        yield* Deferred.await(gathered);
        const description = peer.localDescription();
        if (description === null || description.type !== "offer") {
          return yield* new WebRtcPeerError({
            stage: "ice-gathering",
            cause: new Error("WebRTC peer did not produce a complete offer."),
          });
        }
        return description.sdp;
      }).pipe(Effect.raceFirst(Deferred.await(closed)));

      const acceptAnswer = Effect.fn("WebRtcPeer.acceptAnswer")(function* (answerSdp: string) {
        yield* Effect.tryPromise({
          try: () => peer.setRemoteDescription({ type: "answer", sdp: answerSdp }),
          catch: (cause) => new WebRtcPeerError({ stage: "answer", cause }),
        });
      });

      return {
        dataChannel,
        createOffer,
        acceptAnswer,
        closed: Deferred.await(closed),
        selectedIcePairType: Effect.tryPromise({
          try: peer.selectedIcePairType,
          catch: (cause) => new WebRtcPeerError({ stage: "stats", cause }),
        }),
        close: Effect.sync(() => peer.close()),
      } satisfies WebRtcPeer;
    }),
  };
}
