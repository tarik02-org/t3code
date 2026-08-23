import * as NodeBuffer from "node:buffer";
import * as NodeCrypto from "node:crypto";

import type { RTCDataChannel, RTCPeerConnection } from "werift";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";

import {
  type ServerWebRtcPeer,
  type ServerWebRtcPeerFactory,
  type WebRtcDataChannelPort,
  WebRtcPeerError,
} from "./peer.ts";

const EARLY_MESSAGE_LIMIT = 4;
const EARLY_MESSAGE_BYTES_LIMIT = 64 * 1024;
const MAX_MESSAGE_SIZE = 16 * 1024;
const ICE_PORT_RANGE: [number, number] = [60_000, 61_000];

type WeriftDataChannel = Pick<
  RTCDataChannel,
  | "label"
  | "ordered"
  | "readyState"
  | "bufferedAmount"
  | "send"
  | "close"
  | "stateChanged"
  | "onMessage"
  | "error"
>;

function weriftDataChannelPort(channel: WeriftDataChannel): WebRtcDataChannelPort {
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
      earlyMessages.length >= EARLY_MESSAGE_LIMIT ||
      earlyMessageBytes + data.byteLength > EARLY_MESSAGE_BYTES_LIMIT
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
    send: (data) => channel.send(NodeBuffer.Buffer.from(data)),
    close: () => {
      closeMessageSubscription();
      channel.close();
    },
    onOpen: (listener) => {
      const subscription = channel.stateChanged.subscribe((state) => {
        if (state === "open") {
          listener();
        }
      });
      return subscription.unSubscribe;
    },
    onMessage: (listener) => {
      if (messageListener !== null) {
        channel.close();
        return () => undefined;
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
  };
}

function makeWeriftPeer(connection: RTCPeerConnection): Effect.Effect<ServerWebRtcPeer> {
  return Effect.gen(function* () {
    const closed = yield* Deferred.make<never, WebRtcPeerError>();
    const dataChannels = yield* Queue.unbounded<WebRtcDataChannelPort>();
    let acceptedDataChannel = false;
    const stateSubscription = connection.connectionStateChange.subscribe((state) => {
      if (state !== "failed" && state !== "closed") {
        return;
      }
      Deferred.doneUnsafe(
        closed,
        Effect.fail(
          new WebRtcPeerError({
            stage: "connection",
            cause: new Error(`WebRTC peer entered ${state} state.`),
          }),
        ),
      );
    });
    const dataChannelSubscription = connection.onDataChannel.subscribe((channel) => {
      if (acceptedDataChannel) {
        channel.close();
        return;
      }
      acceptedDataChannel = true;
      Queue.offerUnsafe(dataChannels, weriftDataChannelPort(channel));
    });

    const acceptOffer = Effect.fn("WeriftServerPeer.acceptOffer")(function* (offerSdp: string) {
      yield* Effect.tryPromise({
        try: async () => {
          await connection.setRemoteDescription({ type: "offer", sdp: offerSdp });
          const answer = await connection.createAnswer();
          await connection.setLocalDescription(answer);
        },
        catch: (cause) => new WebRtcPeerError({ stage: "offer", cause }),
      }).pipe(Effect.raceFirst(Deferred.await(closed)));
      const answer = connection.localDescription;
      if (answer === null || answer.type !== "answer") {
        return yield* new WebRtcPeerError({
          stage: "answer",
          cause: new Error("WebRTC peer did not produce a complete answer."),
        });
      }
      return answer.sdp;
    });

    return {
      acceptOffer,
      dataChannel: Queue.take(dataChannels).pipe(
        Effect.mapError((cause) => new WebRtcPeerError({ stage: "data-channel", cause })),
        Effect.raceFirst(Deferred.await(closed)),
      ),
      closed: Deferred.await(closed),
      close: Effect.tryPromise({
        try: () => connection.close(),
        catch: (cause) => new WebRtcPeerError({ stage: "connection", cause }),
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            stateSubscription.unSubscribe();
            dataChannelSubscription.unSubscribe();
          }),
        ),
        Effect.ignore,
      ),
    };
  });
}

export const loadWeriftServerPeerFactory: Effect.Effect<Option.Option<ServerWebRtcPeerFactory>> =
  Effect.tryPromise({
    try: () => import("werift"),
    catch: (cause) => new WebRtcPeerError({ stage: "create", cause }),
  }).pipe(
    Effect.map(
      (werift) =>
        ({
          create: Effect.fn("WeriftServerPeerFactory.create")(function* (iceServers) {
            const connection = yield* Effect.try({
              try: () =>
                new werift.RTCPeerConnection({
                  iceServers: iceServers.map((server) => ({
                    urls: [...server.urls],
                    ...(server.username === undefined ? {} : { username: server.username }),
                    ...(server.credential === undefined ? {} : { credential: server.credential }),
                  })),
                  icePortRange: ICE_PORT_RANGE,
                  maxMessageSize: MAX_MESSAGE_SIZE,
                }),
              catch: (cause) => new WebRtcPeerError({ stage: "create", cause }),
            });
            const peer = yield* makeWeriftPeer(connection);
            yield* Effect.addFinalizer(() => peer.close);
            return peer;
          }),
          randomBytes: (size: number) =>
            Effect.try({
              try: () => Uint8Array.from(NodeCrypto.randomBytes(size)),
              catch: (cause) => new WebRtcPeerError({ stage: "create", cause }),
            }),
        }) satisfies ServerWebRtcPeerFactory,
    ),
    Effect.option,
  );
