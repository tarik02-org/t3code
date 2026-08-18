import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Latch from "effect/Latch";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Socket from "effect/unstable/socket/Socket";

import type { WebRtcDataChannelPort, WebRtcIceServer, WebRtcTransportKind } from "./peer.ts";
import {
  type ApplicationFragment,
  type ControlMessage,
  decodeApplicationFrame,
  decodeControl,
  encodeApplicationFrames,
  encodeControl,
} from "./wire.ts";

const MAX_BUFFERED_REPLAY_BYTES = 16 * 1024 * 1024;
const MAX_BUFFERED_RECEIVE_BYTES = 16 * 1024 * 1024;
const MAX_DATA_CHANNEL_BUFFERED_BYTES = 16 * 1024 * 1024;
const MAX_PENDING_MESSAGES = 1024;

type ApplicationChunk = string | Uint8Array;
type ControlSource = "websocket" | "webrtc";

type InboundEvent =
  | { readonly kind: "websocket"; readonly data: ApplicationChunk }
  | { readonly kind: "webrtc"; readonly attemptId: string; readonly data: Uint8Array }
  | { readonly kind: "webrtc-closed"; readonly attemptId: string };

interface FragmentAssembly {
  readonly text: boolean;
  readonly fragmentCount: number;
  readonly fragments: Array<Uint8Array | null>;
  receivedCount: number;
  receivedBytes: number;
}

interface CompleteMessage {
  readonly text: boolean;
  readonly payload: Uint8Array;
}

interface ActiveDataChannel {
  readonly attemptId: string;
  readonly port: WebRtcDataChannelPort;
  readonly removeListeners: () => void;
}

export interface LogicalSocketSession {
  readonly nonce: string;
  readonly framingReady: Effect.Effect<ReadonlyArray<WebRtcIceServer>>;
  readonly sendControl: (message: ControlMessage) => Effect.Effect<void, Socket.SocketError>;
  readonly sendRtcControl: (
    attemptId: string,
    message: ControlMessage,
  ) => Effect.Effect<void, Socket.SocketError>;
  readonly beginClientFraming: (
    iceServers: ReadonlyArray<WebRtcIceServer>,
  ) => Effect.Effect<void, Socket.SocketError>;
  readonly finishClientFraming: Effect.Effect<void, Socket.SocketError>;
  readonly finishServerFraming: Effect.Effect<void, Socket.SocketError>;
  readonly attachDataChannel: (
    attemptId: string,
    port: WebRtcDataChannelPort,
  ) => Effect.Effect<void, Socket.SocketError>;
  readonly selectDataChannel: (attemptId: string) => Effect.Effect<void, Socket.SocketError>;
  readonly fallbackToWebSocket: (attemptId: string) => Effect.Effect<void, Socket.SocketError>;
  readonly closeDataChannel: (attemptId: string) => Effect.Effect<void>;
}

export interface LogicalSocketDriver {
  readonly onOpen: Effect.Effect<void>;
  readonly onControl: (
    message: ControlMessage,
    source: ControlSource,
  ) => Effect.Effect<void, Socket.SocketError>;
  readonly onRtcClosed: (attemptId: string) => Effect.Effect<void, Socket.SocketError>;
  readonly close: Effect.Effect<void>;
}

export interface MakeLogicalSocketOptions {
  readonly socket: Socket.Socket;
  readonly nonce: string;
  readonly makeDriver: (
    session: LogicalSocketSession,
  ) => Effect.Effect<LogicalSocketDriver, never, Scope.Scope>;
  readonly onTransportChange?: (transport: WebRtcTransportKind) => void;
}

function readFailure(cause: unknown): Socket.SocketError {
  return new Socket.SocketError({
    reason: new Socket.SocketReadError({ cause }),
  });
}

function writeFailure(cause: unknown): Socket.SocketError {
  return new Socket.SocketError({
    reason: new Socket.SocketWriteError({ cause }),
  });
}

function concatenateFragments(assembly: FragmentAssembly): Uint8Array {
  const payload = new Uint8Array(assembly.receivedBytes);
  let offset = 0;
  for (const fragment of assembly.fragments) {
    if (fragment === null) {
      continue;
    }
    payload.set(fragment, offset);
    offset += fragment.byteLength;
  }
  return payload;
}

export function makeLogicalSocket(options: MakeLogicalSocketOptions): Socket.Socket {
  const openLatch = Latch.makeUnsafe(false);
  let writeApplication:
    | ((chunk: ApplicationChunk | Socket.CloseEvent) => Effect.Effect<void, Socket.SocketError>)
    | null = null;

  const writer = Effect.succeed((chunk: ApplicationChunk | Socket.CloseEvent) => {
    const ownedChunk = chunk instanceof Uint8Array ? Uint8Array.from(chunk) : chunk;
    return openLatch.whenOpen(
      Effect.suspend(() => {
        if (writeApplication === null) {
          return Effect.fail(writeFailure(new Error("Logical WebSocket is not running.")));
        }
        return writeApplication(ownedChunk);
      }),
    );
  });

  const runRaw = <A, E, R>(
    handler: (data: ApplicationChunk) => Effect.Effect<A, E, R> | void,
    runOptions?: { readonly onOpen?: Effect.Effect<void> | undefined },
  ): Effect.Effect<void, Socket.SocketError | E, R> =>
    Effect.scoped(
      Effect.gen(function* () {
        const rawWriter = yield* options.socket.writer;
        const sendLock = yield* Semaphore.make(1);
        const inbound = yield* Queue.unbounded<InboundEvent>();
        const framingReady = yield* Deferred.make<ReadonlyArray<WebRtcIceServer>>();
        const pendingApplication: Array<ApplicationChunk> = [];
        const unacked = new Map<bigint, ReadonlyArray<Uint8Array>>();
        const assemblies = new Map<bigint, FragmentAssembly>();
        const complete = new Map<bigint, CompleteMessage>();
        let outboundMode: "raw" | "activating" | "framed" = "raw";
        let inboundFramed = false;
        let route: WebRtcTransportKind = "websocket";
        let activeDataChannel: ActiveDataChannel | null = null;
        let nextOutboundSequence = 0n;
        let nextInboundSequence = 0n;
        let replayBytes = 0;
        let receiveBytes = 0;
        let pendingApplicationBytes = 0;
        let clientIceServers: ReadonlyArray<WebRtcIceServer> | null = null;

        const rawWrite = (chunk: ApplicationChunk | Socket.CloseEvent) => rawWriter(chunk);

        const sendControl = (message: ControlMessage) =>
          sendLock.withPermits(1)(rawWrite(encodeControl(options.nonce, message)));

        const sendFramesOnWebSocket = (frames: ReadonlyArray<Uint8Array>) =>
          Effect.forEach(frames, rawWrite, { discard: true });

        const replayUnacked = Effect.suspend(() =>
          Effect.forEach(unacked.values(), sendFramesOnWebSocket, { discard: true }),
        );

        const setTransport = (transport: WebRtcTransportKind) =>
          Effect.sync(() => {
            if (route === transport) {
              return;
            }
            route = transport;
            options.onTransportChange?.(transport);
          });

        const fallbackLocked = Effect.fn("LogicalWebSocket.fallbackLocked")(function* (
          attemptId: string,
        ) {
          if (activeDataChannel?.attemptId !== attemptId) {
            return;
          }
          activeDataChannel.removeListeners();
          activeDataChannel.port.close();
          activeDataChannel = null;
          yield* setTransport("websocket");
          yield* replayUnacked;
        });

        const sendFramedLocked = Effect.fn("LogicalWebSocket.sendFramedLocked")(function* (
          chunk: ApplicationChunk,
        ) {
          const sequence = nextOutboundSequence;
          const frames = yield* encodeApplicationFrames(options.nonce, sequence, chunk).pipe(
            Effect.mapError(writeFailure),
          );
          const frameBytes = frames.reduce((total, frame) => total + frame.byteLength, 0);
          if (
            unacked.size >= MAX_PENDING_MESSAGES ||
            replayBytes + frameBytes > MAX_BUFFERED_REPLAY_BYTES
          ) {
            return yield* writeFailure(
              new Error("Logical WebSocket replay buffer exceeded its limit."),
            );
          }
          nextOutboundSequence += 1n;
          replayBytes += frameBytes;
          unacked.set(sequence, frames);
          const dataChannel = activeDataChannel;
          if (route === "webrtc" && dataChannel !== null) {
            if (dataChannel.port.bufferedAmount() > MAX_DATA_CHANNEL_BUFFERED_BYTES) {
              yield* fallbackLocked(dataChannel.attemptId);
              Queue.offerUnsafe(inbound, {
                kind: "webrtc-closed",
                attemptId: dataChannel.attemptId,
              });
              return;
            }
            const sent = yield* Effect.try({
              try: () => {
                for (const frame of frames) {
                  dataChannel.port.send(frame);
                }
              },
              catch: writeFailure,
            }).pipe(Effect.option);
            if (Option.isSome(sent)) {
              return;
            }
            yield* fallbackLocked(dataChannel.attemptId);
            Queue.offerUnsafe(inbound, {
              kind: "webrtc-closed",
              attemptId: dataChannel.attemptId,
            });
            return;
          }
          yield* sendFramesOnWebSocket(frames);
        });

        const flushPendingLocked = Effect.forEach(pendingApplication, sendFramedLocked, {
          discard: true,
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              pendingApplication.length = 0;
            }),
          ),
        );

        const sendApplication = (chunk: ApplicationChunk | Socket.CloseEvent) =>
          sendLock.withPermits(1)(
            Effect.suspend(() => {
              if (Socket.isCloseEvent(chunk)) {
                if (activeDataChannel !== null) {
                  activeDataChannel.removeListeners();
                  activeDataChannel.port.close();
                  activeDataChannel = null;
                }
                return rawWrite(chunk);
              }
              switch (outboundMode) {
                case "raw":
                  return rawWrite(chunk);
                case "activating": {
                  pendingApplicationBytes +=
                    typeof chunk === "string"
                      ? new TextEncoder().encode(chunk).byteLength
                      : chunk.byteLength;
                  if (
                    pendingApplication.length >= MAX_PENDING_MESSAGES ||
                    pendingApplicationBytes > MAX_BUFFERED_REPLAY_BYTES
                  ) {
                    return Effect.fail(
                      writeFailure(
                        new Error("Logical WebSocket pending buffer exceeded its limit."),
                      ),
                    );
                  }
                  pendingApplication.push(chunk);
                  return Effect.void;
                }
                case "framed":
                  return sendFramedLocked(chunk);
              }
            }),
          );
        writeApplication = sendApplication;

        const beginClientFraming = (iceServers: ReadonlyArray<WebRtcIceServer>) =>
          sendLock.withPermits(1)(
            Effect.gen(function* () {
              if (outboundMode !== "raw") {
                return;
              }
              outboundMode = "activating";
              clientIceServers = iceServers;
              yield* rawWrite(
                encodeControl(options.nonce, {
                  kind: "hello-ack",
                  version: 1,
                }),
              );
              yield* rawWrite(
                encodeControl(options.nonce, {
                  kind: "frame-start",
                  version: 1,
                }),
              );
            }),
          );

        const finishClientFraming = sendLock.withPermits(1)(
          Effect.gen(function* () {
            if (outboundMode !== "activating") {
              return;
            }
            const iceServers = clientIceServers;
            if (iceServers === null) {
              return yield* writeFailure(
                new Error("Logical WebSocket framing started without ICE server configuration."),
              );
            }
            inboundFramed = true;
            outboundMode = "framed";
            yield* flushPendingLocked;
            pendingApplicationBytes = 0;
            yield* Deferred.succeed(framingReady, iceServers);
          }),
        );

        const finishServerFraming = sendLock.withPermits(1)(
          Effect.gen(function* () {
            if (outboundMode !== "raw") {
              return;
            }
            inboundFramed = true;
            outboundMode = "framed";
            yield* rawWrite(
              encodeControl(options.nonce, {
                kind: "frame-start-ack",
                version: 1,
              }),
            );
            yield* Deferred.succeed(framingReady, []);
          }),
        );

        const attachDataChannel = (attemptId: string, port: WebRtcDataChannelPort) =>
          sendLock.withPermits(1)(
            Effect.gen(function* () {
              if (!port.ordered) {
                port.close();
                return yield* writeFailure(
                  new Error("Logical WebSocket requires an ordered DataChannel."),
                );
              }
              if (activeDataChannel !== null) {
                yield* fallbackLocked(activeDataChannel.attemptId);
              }
              const removeMessage = port.onMessage((data) => {
                Queue.offerUnsafe(inbound, { kind: "webrtc", attemptId, data });
              });
              const notifyClosed = () => {
                Queue.offerUnsafe(inbound, { kind: "webrtc-closed", attemptId });
              };
              const removeClose = port.onClose(notifyClosed);
              const removeError = port.onError(notifyClosed);
              activeDataChannel = {
                attemptId,
                port,
                removeListeners: () => {
                  removeMessage();
                  removeClose();
                  removeError();
                },
              };
            }),
          );

        const selectDataChannel = (attemptId: string) =>
          sendLock.withPermits(1)(
            Effect.gen(function* () {
              if (activeDataChannel?.attemptId !== attemptId || !activeDataChannel.port.isOpen()) {
                return;
              }
              yield* setTransport("webrtc");
            }),
          );

        const fallbackToWebSocket = (attemptId: string) =>
          sendLock.withPermits(1)(fallbackLocked(attemptId));

        const closeDataChannel = (attemptId: string) =>
          Effect.sync(() => {
            if (activeDataChannel?.attemptId !== attemptId) {
              return;
            }
            activeDataChannel.removeListeners();
            activeDataChannel.port.close();
            activeDataChannel = null;
          });

        const sendRtcControl = (attemptId: string, message: ControlMessage) =>
          Effect.suspend(() => {
            const dataChannel = activeDataChannel;
            if (dataChannel?.attemptId !== attemptId) {
              return Effect.fail(
                writeFailure(new Error("WebRTC DataChannel attempt is no longer active.")),
              );
            }
            return Effect.try({
              try: () =>
                dataChannel.port.send(
                  new TextEncoder().encode(encodeControl(options.nonce, message)),
                ),
              catch: writeFailure,
            });
          });

        const session: LogicalSocketSession = {
          nonce: options.nonce,
          framingReady: Deferred.await(framingReady),
          sendControl,
          sendRtcControl,
          beginClientFraming,
          finishClientFraming,
          finishServerFraming,
          attachDataChannel,
          selectDataChannel,
          fallbackToWebSocket,
          closeDataChannel,
        };
        const driver = yield* options.makeDriver(session);

        const acknowledge = (nextSequence: bigint) =>
          sendControl({ kind: "ack", nextSequence: nextSequence.toString() });

        const deliverComplete = Effect.fn("LogicalWebSocket.deliverComplete")(function* () {
          while (true) {
            const message = complete.get(nextInboundSequence);
            if (message === undefined) {
              return;
            }
            complete.delete(nextInboundSequence);
            receiveBytes -= message.payload.byteLength;
            const delivered = message.text
              ? new TextDecoder().decode(message.payload)
              : message.payload;
            const result = handler(delivered);
            if (Effect.isEffect(result)) {
              yield* result;
            }
            nextInboundSequence += 1n;
          }
        });

        const receiveFragment = Effect.fn("LogicalWebSocket.receiveFragment")(function* (
          fragment: ApplicationFragment,
        ) {
          if (fragment.sequence < nextInboundSequence) {
            yield* acknowledge(nextInboundSequence);
            return;
          }
          if (complete.has(fragment.sequence)) {
            yield* acknowledge(nextInboundSequence);
            return;
          }
          let assembly = assemblies.get(fragment.sequence);
          if (assembly === undefined) {
            if (assemblies.size + complete.size >= MAX_PENDING_MESSAGES) {
              return yield* readFailure(
                new Error("Logical WebSocket has too many pending messages."),
              );
            }
            assembly = {
              text: fragment.text,
              fragmentCount: fragment.fragmentCount,
              fragments: Array.from({ length: fragment.fragmentCount }, () => null),
              receivedCount: 0,
              receivedBytes: 0,
            };
            assemblies.set(fragment.sequence, assembly);
          } else if (
            assembly.text !== fragment.text ||
            assembly.fragmentCount !== fragment.fragmentCount
          ) {
            return yield* readFailure(
              new Error("WebRTC message fragments disagree on their metadata."),
            );
          }
          if (assembly.fragments[fragment.fragmentIndex] !== null) {
            return;
          }
          if (receiveBytes + fragment.payload.byteLength > MAX_BUFFERED_RECEIVE_BYTES) {
            return yield* readFailure(
              new Error("Logical WebSocket receive buffer exceeded its byte limit."),
            );
          }
          assembly.fragments[fragment.fragmentIndex] = fragment.payload;
          assembly.receivedCount += 1;
          assembly.receivedBytes += fragment.payload.byteLength;
          receiveBytes += fragment.payload.byteLength;
          if (assembly.receivedCount !== assembly.fragmentCount) {
            return;
          }
          assemblies.delete(fragment.sequence);
          complete.set(fragment.sequence, {
            text: assembly.text,
            payload: concatenateFragments(assembly),
          });
          yield* deliverComplete();
          yield* acknowledge(nextInboundSequence);
        });

        const removeAcknowledged = (nextSequenceText: string) =>
          sendLock.withPermits(1)(
            Effect.try({
              try: () => BigInt(nextSequenceText),
              catch: (cause) => readFailure(cause),
            }).pipe(
              Effect.flatMap((nextSequence) =>
                nextSequence < 0n || nextSequence > nextOutboundSequence
                  ? Effect.fail(
                      readFailure(new Error("Received an invalid WebRTC acknowledgement.")),
                    )
                  : Effect.sync(() => {
                      for (const [sequence, frames] of unacked) {
                        if (sequence >= nextSequence) {
                          continue;
                        }
                        replayBytes -= frames.reduce((total, frame) => total + frame.byteLength, 0);
                        unacked.delete(sequence);
                      }
                    }),
              ),
            ),
          );

        const handleControl = Effect.fn("LogicalWebSocket.handleControl")(function* (
          message: ControlMessage,
          source: ControlSource,
        ) {
          switch (message.kind) {
            case "ack":
              if (source !== "websocket") {
                return;
              }
              yield* removeAcknowledged(message.nextSequence);
              return;
            case "fallback":
              if (source !== "websocket") {
                return;
              }
              yield* fallbackToWebSocket(message.attemptId);
              yield* driver.onRtcClosed(message.attemptId);
              return;
            default:
              yield* driver.onControl(message, source);
          }
        });

        const decodeHiddenControl = (data: ApplicationChunk) =>
          decodeControl(options.nonce, data).pipe(Effect.mapError(readFailure));

        const decodeHiddenData = (data: ApplicationChunk) =>
          typeof data === "string"
            ? Effect.succeed(Option.none<ApplicationFragment>())
            : decodeApplicationFrame(options.nonce, data).pipe(Effect.mapError(readFailure));

        const handleWebSocketData = Effect.fn("LogicalWebSocket.handleWebSocketData")(function* (
          data: ApplicationChunk,
        ) {
          const control = yield* decodeHiddenControl(data);
          if (Option.isSome(control)) {
            yield* handleControl(control.value, "websocket");
            return;
          }
          const fragment = yield* decodeHiddenData(data);
          if (Option.isSome(fragment)) {
            yield* receiveFragment(fragment.value);
            return;
          }
          if (inboundFramed) {
            return yield* readFailure(
              new Error("Received an unframed message after framing was activated."),
            );
          }
          const result = handler(data);
          if (Effect.isEffect(result)) {
            yield* result;
          }
        });

        const handleRtcData = Effect.fn("LogicalWebSocket.handleRtcData")(function* (
          attemptId: string,
          data: Uint8Array,
        ) {
          if (activeDataChannel?.attemptId !== attemptId) {
            return;
          }
          const control = yield* decodeHiddenControl(data);
          if (Option.isSome(control)) {
            yield* handleControl(control.value, "webrtc");
            return;
          }
          const fragment = yield* decodeHiddenData(data);
          if (Option.isSome(fragment)) {
            yield* receiveFragment(fragment.value);
          }
        });

        const processInbound = Queue.take(inbound).pipe(
          Effect.flatMap((event) => {
            switch (event.kind) {
              case "websocket":
                return handleWebSocketData(event.data);
              case "webrtc":
                return handleRtcData(event.attemptId, event.data);
              case "webrtc-closed":
                return fallbackToWebSocket(event.attemptId).pipe(
                  Effect.andThen(driver.onRtcClosed(event.attemptId)),
                );
            }
          }),
          Effect.forever,
        );

        yield* Effect.addFinalizer(() =>
          driver.close.pipe(
            Effect.andThen(
              Effect.sync(() => {
                if (activeDataChannel !== null) {
                  activeDataChannel.removeListeners();
                  activeDataChannel.port.close();
                  activeDataChannel = null;
                }
                writeApplication = null;
                openLatch.closeUnsafe();
              }),
            ),
          ),
        );

        const rawRun = options.socket.runRaw(
          (data) => Queue.offer(inbound, { kind: "websocket", data }).pipe(Effect.asVoid),
          {
            onOpen: driver.onOpen.pipe(
              Effect.andThen(
                Effect.sync(() => {
                  openLatch.openUnsafe();
                }),
              ),
              Effect.andThen(runOptions?.onOpen ?? Effect.void),
            ),
          },
        );

        return yield* Effect.raceFirst(rawRun, processInbound);
      }),
    );

  return Socket.make({ runRaw, writer });
}
