import * as NodeBuffer from "node:buffer";

import type { RTCDataChannel, RTCPeerConnection } from "werift";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";

import type { WebRtcDataChannelPort } from "@t3tools/shared/webrtcDataChannel";
import { isTerminalWebRtcPeerConnectionState } from "@t3tools/shared/webrtcPeerState";

import type { WebRtcUdpPortRange } from "./config.ts";

const EARLY_DATA_CHANNEL_MESSAGE_LIMIT = 4;
const EARLY_DATA_CHANNEL_BYTES_LIMIT = 64 * 1024;

export interface ServerWebRtcPeer {
  readonly acceptOffer: (offerSdp: string) => Effect.Effect<string, ServerWebRtcPeerError>;
  readonly takeDataChannel: Effect.Effect<WebRtcDataChannelPort, ServerWebRtcPeerError>;
  readonly closed: Effect.Effect<never, ServerWebRtcPeerError>;
  readonly diagnosticState: Effect.Effect<{
    readonly connectionState: string;
    readonly gatheringState: string;
    readonly iceState: string;
  }>;
  readonly selectedIcePairType: Effect.Effect<string | null>;
  readonly bytesSent: Effect.Effect<number>;
  readonly bytesReceived: Effect.Effect<number>;
  readonly close: Effect.Effect<void>;
}

export class ServerWebRtcPeerError extends Error {
  readonly stage: "create" | "offer" | "connection";

  constructor(stage: "create" | "offer" | "connection") {
    super(`Server WebRTC peer failed during ${stage}.`);
    this.name = "ServerWebRtcPeerError";
    this.stage = stage;
  }
}

export interface ServerWebRtcRuntime {
  readonly createPeer: (
    attemptId: string,
    stunUrls: ReadonlyArray<string>,
    udpPortRange: WebRtcUdpPortRange,
  ) => Effect.Effect<ServerWebRtcPeer, ServerWebRtcPeerError>;
}

type WeriftDataChannelAdapter = Pick<
  RTCDataChannel,
  | "label"
  | "ordered"
  | "readyState"
  | "bufferedAmount"
  | "bufferedAmountLowThreshold"
  | "send"
  | "close"
  | "stateChanged"
  | "onMessage"
  | "error"
  | "bufferedAmountLow"
>;

function iceCandidateType(candidate: string): string {
  const match = /(?:^|\s)typ\s+(host|srflx|prflx|relay)(?:\s|$)/i.exec(candidate);
  return match?.[1]?.toLowerCase() ?? "unknown";
}

export function weriftDataChannelPort(channel: WeriftDataChannelAdapter): WebRtcDataChannelPort {
  const earlyMessages: Array<Uint8Array> = [];
  let earlyMessageBytes = 0;
  let messageListener: ((data: Uint8Array) => void) | null = null;
  let messageSubscriptionClosed = false;
  const messageSubscription = channel.onMessage.subscribe((message) => {
    const data =
      typeof message === "string" ? new TextEncoder().encode(message) : Uint8Array.from(message);
    if (messageListener !== null) {
      messageListener(data);
      return;
    }
    if (
      earlyMessages.length >= EARLY_DATA_CHANNEL_MESSAGE_LIMIT ||
      earlyMessageBytes + data.byteLength > EARLY_DATA_CHANNEL_BYTES_LIMIT
    ) {
      channel.close();
      return;
    }
    earlyMessages.push(data);
    earlyMessageBytes += data.byteLength;
  });
  const closeMessageSubscription = () => {
    if (messageSubscriptionClosed) {
      return;
    }
    messageSubscriptionClosed = true;
    messageSubscription.unSubscribe();
    earlyMessages.length = 0;
    earlyMessageBytes = 0;
    messageListener = null;
  };

  return {
    label: channel.label,
    ordered: channel.ordered,
    isOpen: () => channel.readyState === "open",
    bufferedAmount: () => channel.bufferedAmount,
    setBufferedAmountLowThreshold: (bytes) => {
      channel.bufferedAmountLowThreshold = bytes;
    },
    send: (data) => channel.send(NodeBuffer.Buffer.from(data)),
    close: () => {
      closeMessageSubscription();
      channel.close();
    },
    onOpen: (listener) => {
      const subscription = channel.stateChanged.subscribe((state) => {
        if (state === "open") listener();
      });
      return subscription.unSubscribe;
    },
    onMessage: (listener) => {
      if (messageListener !== null) {
        throw new Error("WebRTC DataChannel already has a message listener.");
      }
      messageListener = listener;
      for (const message of earlyMessages.splice(0)) {
        listener(message);
      }
      earlyMessageBytes = 0;
      return () => {
        if (messageListener === listener) {
          messageListener = null;
        }
      };
    },
    onClose: (listener) => {
      const subscription = channel.stateChanged.subscribe((state) => {
        if (state === "closed") {
          closeMessageSubscription();
          listener();
        }
      });
      return subscription.unSubscribe;
    },
    onError: (listener) => {
      const subscription = channel.error.subscribe(listener);
      return subscription.unSubscribe;
    },
    onBufferedAmountLow: (listener) => {
      const subscription = channel.bufferedAmountLow.subscribe(listener);
      return subscription.unSubscribe;
    },
  };
}

function makeWeriftPeer(connection: RTCPeerConnection): Effect.Effect<ServerWebRtcPeer, never> {
  return Effect.gen(function* () {
    const closed = yield* Deferred.make<never, ServerWebRtcPeerError>();
    const channels = yield* Queue.unbounded<WebRtcDataChannelPort>();
    const dataChannels: Array<RTCDataChannel> = [];
    const stateSubscription = connection.connectionStateChange.subscribe((state) => {
      if (isTerminalWebRtcPeerConnectionState(state)) {
        Deferred.doneUnsafe(closed, Effect.fail(new ServerWebRtcPeerError("connection")));
      }
    });
    const dataChannelSubscription = connection.onDataChannel.subscribe((channel) => {
      dataChannels.push(channel);
      Queue.offerUnsafe(channels, weriftDataChannelPort(channel));
    });

    const acceptOffer = Effect.fn("ServerWebRtcPeer.acceptOffer")(function* (offerSdp: string) {
      yield* Effect.tryPromise({
        try: async () => {
          await connection.setRemoteDescription({ type: "offer", sdp: offerSdp });
          const answer = await connection.createAnswer();
          await connection.setLocalDescription(answer);
        },
        catch: () => new ServerWebRtcPeerError("offer"),
      }).pipe(Effect.raceFirst(Deferred.await(closed)));
      const answer = connection.localDescription;
      if (answer === null || answer.type !== "answer") {
        return yield* Effect.fail(new ServerWebRtcPeerError("offer"));
      }
      return answer.sdp;
    });

    const close = Effect.tryPromise({
      try: () => connection.close(),
      catch: () => new ServerWebRtcPeerError("connection"),
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          stateSubscription.unSubscribe();
          dataChannelSubscription.unSubscribe();
        }),
      ),
      Effect.ignore,
    );

    return {
      acceptOffer,
      takeDataChannel: Queue.take(channels).pipe(
        Effect.mapError(() => new ServerWebRtcPeerError("connection")),
        Effect.raceFirst(Deferred.await(closed)),
      ),
      closed: Deferred.await(closed),
      diagnosticState: Effect.sync(() => ({
        connectionState: connection.connectionState,
        gatheringState: connection.iceGatheringState,
        iceState: connection.iceConnectionState,
      })),
      selectedIcePairType: Effect.sync(() => {
        for (const transport of connection.iceTransports) {
          const pair = transport.getSelectedCandidatePair();
          if (pair !== null) {
            return `${iceCandidateType(pair.local.candidate)}/${iceCandidateType(pair.remote.candidate)}`;
          }
        }
        return null;
      }),
      bytesSent: Effect.sync(() =>
        dataChannels.reduce((total, channel) => total + channel.bytesSent, 0),
      ),
      bytesReceived: Effect.sync(() =>
        dataChannels.reduce((total, channel) => total + channel.bytesReceived, 0),
      ),
      close,
    } satisfies ServerWebRtcPeer;
  });
}

export const loadServerWebRtcRuntime: Effect.Effect<Option.Option<ServerWebRtcRuntime>> =
  Effect.tryPromise({
    try: () => import("werift"),
    catch: () => new ServerWebRtcPeerError("create"),
  }).pipe(
    Effect.map(
      (werift) =>
        ({
          createPeer: Effect.fn("ServerWebRtcRuntime.createPeer")(function* (
            _attemptId: string,
            stunUrls: ReadonlyArray<string>,
            udpPortRange: WebRtcUdpPortRange,
          ) {
            const connection = yield* Effect.try({
              try: () =>
                new werift.RTCPeerConnection({
                  iceServers: stunUrls.map((urls) => ({ urls })),
                  icePortRange: [...udpPortRange],
                  maxMessageSize: 16 * 1024,
                }),
              catch: () => new ServerWebRtcPeerError("create"),
            });
            return yield* makeWeriftPeer(connection);
          }),
        }) satisfies ServerWebRtcRuntime,
    ),
    Effect.option,
  );
