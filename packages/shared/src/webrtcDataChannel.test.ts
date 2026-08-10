import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as TestClock from "effect/testing/TestClock";

import {
  makeWebRtcDataChannelConnection,
  type WebRtcDataChannelPort,
} from "./webrtcDataChannel.ts";
import {
  encodeWebRtcMessage,
  WEBRTC_RPC_FRAGMENT_PAYLOAD_BYTES,
  WEBRTC_RPC_PARTIAL_TTL_MS,
  WebRtcMessageReassembler,
} from "./webrtcFraming.ts";

class TestDataChannelPort implements WebRtcDataChannelPort {
  readonly label = "t3-rpc-v1";
  readonly ordered = true;
  readonly sent: Array<Uint8Array> = [];
  #open = true;
  #bufferedAmount = 0;
  #peer: TestDataChannelPort | null = null;
  #openListeners = new Set<() => void>();
  #messageListeners = new Set<(data: Uint8Array) => void>();
  #closeListeners = new Set<() => void>();
  #errorListeners = new Set<(error: Error) => void>();
  #lowListeners = new Set<() => void>();

  connect(peer: TestDataChannelPort): void {
    this.#peer = peer;
  }

  setBufferedAmount(bytes: number): void {
    this.#bufferedAmount = bytes;
  }

  releaseBackpressure(): void {
    this.#bufferedAmount = 0;
    for (const listener of this.#lowListeners) {
      listener();
    }
  }

  isOpen(): boolean {
    return this.#open;
  }

  bufferedAmount(): number {
    return this.#bufferedAmount;
  }

  setBufferedAmountLowThreshold(_bytes: number): void {}

  send(data: Uint8Array): void {
    const copy = data.slice();
    this.sent.push(copy);
    if (this.#peer !== null) {
      for (const listener of this.#peer.#messageListeners) {
        listener(copy);
      }
    }
  }

  close(): void {
    if (!this.#open) {
      return;
    }
    this.#open = false;
    for (const listener of this.#closeListeners) {
      listener();
    }
  }

  onOpen(listener: () => void): () => void {
    this.#openListeners.add(listener);
    return () => this.#openListeners.delete(listener);
  }

  onMessage(listener: (data: Uint8Array) => void): () => void {
    this.#messageListeners.add(listener);
    return () => this.#messageListeners.delete(listener);
  }

  onClose(listener: () => void): () => void {
    this.#closeListeners.add(listener);
    return () => this.#closeListeners.delete(listener);
  }

  onError(listener: (error: Error) => void): () => void {
    this.#errorListeners.add(listener);
    return () => this.#errorListeners.delete(listener);
  }

  onBufferedAmountLow(listener: () => void): () => void {
    this.#lowListeners.add(listener);
    return () => this.#lowListeners.delete(listener);
  }
}

function makePair() {
  const left = new TestDataChannelPort();
  const right = new TestDataChannelPort();
  left.connect(right);
  right.connect(left);
  return { left, right };
}

it.effect("serializes concurrent fragmented writes", () =>
  Effect.gen(function* () {
    const ports = makePair();
    const sender = yield* makeWebRtcDataChannelConnection(ports.left);
    const receiver = yield* makeWebRtcDataChannelConnection(ports.right);
    yield* sender.sendBinding(new TextEncoder().encode("binding"));
    expect(new TextDecoder().decode(yield* receiver.awaitBinding)).toBe("binding");
    yield* receiver.sendBindingAck;
    yield* sender.awaitBindingAck;
    const writer = yield* sender.socket.writer;
    const received = yield* Queue.unbounded<string>();
    yield* receiver.socket
      .runString((message) => Queue.offer(received, message))
      .pipe(Effect.forkScoped);

    const first = "a".repeat(30_000);
    const second = "b".repeat(30_000);
    yield* Effect.all([writer(first), writer(second)], { concurrency: "unbounded" });
    expect([yield* Queue.take(received), yield* Queue.take(received)]).toEqual([first, second]);
  }),
);

it.effect("waits for DataChannel backpressure before writing", () =>
  Effect.gen(function* () {
    const port = new TestDataChannelPort();
    port.setBufferedAmount(300 * 1024);
    const connection = yield* makeWebRtcDataChannelConnection(port);
    const writer = yield* connection.socket.writer;
    const fiber = yield* writer("held").pipe(Effect.forkChild);
    yield* Effect.yieldNow;
    expect(port.sent).toHaveLength(0);

    port.releaseBackpressure();
    yield* Fiber.join(fiber);
    expect(port.sent).toHaveLength(1);
  }),
);

it.effect("allocates a new message ID when a write effect is reused", () =>
  Effect.gen(function* () {
    const port = new TestDataChannelPort();
    const connection = yield* makeWebRtcDataChannelConnection(port);
    const writer = yield* connection.socket.writer;
    const write = writer("heartbeat");

    yield* write;
    yield* write;

    const decoder = new WebRtcMessageReassembler();
    expect(port.sent.map((frame) => decoder.push(frame, 0)?.messageId)).toEqual([1, 2]);
  }),
);

it.effect("propagates a clean channel close to the Effect socket", () =>
  Effect.gen(function* () {
    const port = new TestDataChannelPort();
    const connection = yield* makeWebRtcDataChannelConnection(port);
    const exitFiber = yield* connection.socket
      .run(() => undefined)
      .pipe(Effect.exit, Effect.forkScoped);
    port.close();
    const exit = yield* Fiber.join(exitFiber);
    expect(Exit.isFailure(exit)).toBe(true);
  }),
);

it.effect("closes the connection when framing is malformed", () =>
  Effect.gen(function* () {
    const ports = makePair();
    const connection = yield* makeWebRtcDataChannelConnection(ports.right);
    yield* connection.socket.run(() => undefined).pipe(Effect.exit, Effect.forkScoped);
    const closedFiber = yield* connection.closed.pipe(Effect.exit, Effect.forkScoped);

    ports.left.send(new Uint8Array([1, 2, 3]));

    expect(Exit.isFailure(yield* Fiber.join(closedFiber))).toBe(true);
    expect(ports.right.isOpen()).toBe(false);
  }),
);

it.effect("expires an idle partial message without waiting for another frame", () =>
  Effect.gen(function* () {
    const ports = makePair();
    const receiver = yield* makeWebRtcDataChannelConnection(ports.right);
    const exitFiber = yield* receiver.socket
      .run(() => undefined)
      .pipe(Effect.exit, Effect.forkScoped);
    const frames = encodeWebRtcMessage({
      kind: "rpc",
      messageId: 1,
      payload: new Uint8Array(WEBRTC_RPC_FRAGMENT_PAYLOAD_BYTES + 1),
    });

    ports.left.send(frames[0]!);
    yield* Effect.yieldNow;
    yield* TestClock.adjust(WEBRTC_RPC_PARTIAL_TTL_MS);

    expect(Exit.isFailure(yield* Fiber.join(exitFiber))).toBe(true);
  }).pipe(Effect.provide(TestClock.layer())),
);
