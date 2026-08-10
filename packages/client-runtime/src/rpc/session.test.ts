import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ServerConfig,
  type ServerConfig as ServerConfigType,
  WS_METHODS,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as Socket from "effect/unstable/socket/Socket";
import {
  makeWebRtcDataChannelConnection,
  type WebRtcDataChannelPort,
} from "@t3tools/shared/webrtcDataChannel";

import {
  ConnectionTransientError,
  PrimaryConnectionTarget,
  type PreparedConnection,
} from "../connection/model.ts";
import {
  WebRtcPeerError,
  WebRtcPeerFactory,
  type WebRtcPeer,
  type WebRtcPeerFactoryService,
} from "../platform/capabilities.ts";
import * as RpcSession from "./session.ts";

type SocketEventType = "open" | "message" | "close" | "error";
type SocketEvent = {
  readonly code?: number;
  readonly data?: unknown;
  readonly reason?: string;
  readonly type: SocketEventType;
};
type SocketListener = (event: SocketEvent) => void;

class TestWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readyState = TestWebSocket.CONNECTING;
  readonly sent: string[] = [];
  readonly url: string;
  private readonly listeners = new Map<SocketEventType, Set<SocketListener>>();

  constructor(url: string) {
    this.url = url;
  }

  addEventListener(type: SocketEventType, listener: SocketListener) {
    const listeners = this.listeners.get(type) ?? new Set<SocketListener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: SocketEventType, listener: SocketListener) {
    this.listeners.get(type)?.delete(listener);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close(code = 1000, reason = "") {
    if (this.readyState === TestWebSocket.CLOSED) {
      return;
    }
    this.readyState = TestWebSocket.CLOSED;
    this.emit("close", { code, reason, type: "close" });
  }

  open() {
    this.readyState = TestWebSocket.OPEN;
    this.emit("open", { type: "open" });
  }

  serverMessage(data: string) {
    this.emit("message", { data, type: "message" });
  }

  private emit(type: SocketEventType, event: SocketEvent) {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

const TARGET = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("environment-1"),
  label: "Test environment",
  httpBaseUrl: "https://environment.example.test",
  wsBaseUrl: "wss://environment.example.test",
});

const PREPARED: PreparedConnection = {
  environmentId: TARGET.environmentId,
  label: TARGET.label,
  httpBaseUrl: TARGET.httpBaseUrl,
  socketUrl: "wss://environment.example.test/ws?wsTicket=test",
  httpAuthorization: null,
  target: TARGET,
};

const SERVER_CONFIG: ServerConfigType = {
  environment: {
    environmentId: TARGET.environmentId,
    label: TARGET.label,
    platform: {
      os: "darwin",
      arch: "arm64",
    },
    serverVersion: "0.0.0-test",
    capabilities: {
      repositoryIdentity: true,
      connectionProbe: true,
    },
  },
  auth: {
    policy: "loopback-browser",
    bootstrapMethods: ["one-time-token"],
    sessionMethods: ["browser-session-cookie", "bearer-access-token"],
    sessionCookieName: "t3_session",
  },
  cwd: "/tmp/workspace",
  keybindingsConfigPath: "/tmp/workspace/keybindings.json",
  keybindings: [],
  issues: [],
  providers: [],
  availableEditors: [],
  observability: {
    logsDirectoryPath: "/tmp/logs",
    localTracingEnabled: false,
    otlpTracesEnabled: false,
    otlpMetricsEnabled: false,
  },
  settings: DEFAULT_SERVER_SETTINGS,
};

const WEBRTC_SERVER_CONFIG: ServerConfigType = {
  ...SERVER_CONFIG,
  environment: {
    ...SERVER_CONFIG.environment,
    capabilities: {
      ...SERVER_CONFIG.environment.capabilities,
      webRtcRpcFastPath: {
        version: 1,
        signaling: "same-websocket-rpc",
        turn: false,
        stunUrls: [],
      },
    },
  },
};

const RpcRequest = Schema.TaggedStruct("Request", {
  id: Schema.Union([Schema.String, Schema.Number]),
  payload: Schema.Unknown,
  tag: Schema.String,
});
const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const decodeRpcRequest = Schema.decodeUnknownSync(RpcRequest);
const decodeWebRtcNegotiatePayload = Schema.decodeUnknownSync(
  Schema.Struct({ attemptId: Schema.String }),
);
const encodeJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const encodeServerConfig = Schema.encodeSync(ServerConfig);
const ENCODED_SERVER_CONFIG = encodeServerConfig(SERVER_CONFIG);
const ENCODED_WEBRTC_SERVER_CONFIG = encodeServerConfig(WEBRTC_SERVER_CONFIG);
const LEGACY_SERVER_CONFIG = {
  ...ENCODED_SERVER_CONFIG,
  environment: {
    ...ENCODED_SERVER_CONFIG.environment,
    capabilities: {
      repositoryIdentity: true,
    },
  },
};

const makeFactory = Effect.fn("TestRpcSessionFactory.make")(function* (
  webRtcPeerFactory: WebRtcPeerFactoryService | null = null,
) {
  const sockets: TestWebSocket[] = [];
  const constructorLayer = Layer.succeed(Socket.WebSocketConstructor, (url) => {
    const socket = new TestWebSocket(url);
    sockets.push(socket);
    return socket as unknown as globalThis.WebSocket;
  });
  const layer = RpcSession.layer.pipe(
    Layer.provide(
      Layer.mergeAll(constructorLayer, Layer.succeed(WebRtcPeerFactory, webRtcPeerFactory)),
    ),
  );
  const factory = yield* RpcSession.RpcSessionFactory.pipe(Effect.provide(layer));
  return { factory, sockets };
});

class TestDataChannelPort implements WebRtcDataChannelPort {
  readonly label = "t3-rpc-v1";
  readonly ordered = true;
  #open = true;
  #peer: TestDataChannelPort | null = null;
  #messageListeners = new Set<(data: Uint8Array) => void>();
  #closeListeners = new Set<() => void>();

  connect(peer: TestDataChannelPort): void {
    this.#peer = peer;
  }

  isOpen(): boolean {
    return this.#open;
  }

  bufferedAmount(): number {
    return 0;
  }

  setBufferedAmountLowThreshold(_bytes: number): void {}

  send(data: Uint8Array): void {
    if (this.#peer === null) {
      return;
    }
    const copy = data.slice();
    for (const listener of this.#peer.#messageListeners) {
      listener(copy);
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

  onOpen(_listener: () => void): () => void {
    return () => undefined;
  }

  onMessage(listener: (data: Uint8Array) => void): () => void {
    this.#messageListeners.add(listener);
    return () => this.#messageListeners.delete(listener);
  }

  onClose(listener: () => void): () => void {
    this.#closeListeners.add(listener);
    return () => this.#closeListeners.delete(listener);
  }

  onError(_listener: (error: Error) => void): () => void {
    return () => undefined;
  }

  onBufferedAmountLow(_listener: () => void): () => void {
    return () => undefined;
  }
}

const makeRtcHarness = Effect.fn("TestRpcSessionFactory.makeRtcHarness")(function* () {
  const clientPort = new TestDataChannelPort();
  const serverPort = new TestDataChannelPort();
  clientPort.connect(serverPort);
  serverPort.connect(clientPort);
  const peerClosed = yield* Deferred.make<never, WebRtcPeerError>();
  const created = yield* Queue.unbounded<void>();
  const rtcRequests = yield* Queue.unbounded<string>();
  const peer: WebRtcPeer = {
    dataChannel: clientPort,
    createOffer: Effect.succeed("v=0\r\n"),
    acceptAnswer: () => Effect.void,
    closed: Deferred.await(peerClosed),
    selectedIcePairType: Effect.succeed("host/host"),
    close: Effect.sync(() => clientPort.close()),
  };
  const peerFactory: WebRtcPeerFactoryService = {
    create: () => Queue.offer(created, undefined).pipe(Effect.as(peer)),
  };
  const serverConnection = yield* makeWebRtcDataChannelConnection(serverPort);
  yield* Effect.gen(function* () {
    yield* serverConnection.awaitBinding;
    yield* serverConnection.sendBindingAck;
    const writer = yield* serverConnection.socket.writer;
    yield* serverConnection.socket.runString((message) => {
      const request = decodeRpcRequest(decodeJson(message));
      return Queue.offer(rtcRequests, request.tag).pipe(
        Effect.andThen(
          writer(
            encodeJson({
              _tag: "Exit",
              requestId: request.id,
              exit: {
                _tag: "Success",
                value:
                  request.tag === WS_METHODS.serverGetConfig ? ENCODED_WEBRTC_SERVER_CONFIG : {},
              },
            }),
          ),
        ),
      );
    });
  }).pipe(Effect.forkScoped);
  return {
    clientPort,
    peerClosed,
    peerFactory,
    created,
    rtcRequests,
  };
});

const completeWebRtcSignaling = Effect.fn("TestRpcSessionFactory.completeWebRtcSignaling")(
  function* (socket: TestWebSocket) {
    const request = yield* awaitRequest(socket, 1);
    const payload = decodeWebRtcNegotiatePayload(request.payload);
    expect(request.tag).toBe(WS_METHODS.transportWebRtcNegotiate);
    socket.serverMessage(
      encodeJson({
        _tag: "Exit",
        requestId: request.id,
        exit: {
          _tag: "Success",
          value: {
            version: 1,
            attemptId: payload.attemptId,
            answerSdp: "v=0\r\n",
            bindingToken: "binding-token",
            expiresAt: "2099-08-09T00:00:00.000Z",
          },
        },
      }),
    );
  },
);

const awaitSocket = Effect.fn("TestRpcSessionFactory.awaitSocket")(function* (
  sockets: ReadonlyArray<TestWebSocket>,
) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const socket = sockets[0];
    if (socket) {
      return socket;
    }
    yield* Effect.yieldNow;
  }
  return yield* Effect.die(new Error("Expected the RPC protocol to create a websocket."));
});

const awaitRequest = Effect.fn("TestRpcSessionFactory.awaitRequest")(function* (
  socket: TestWebSocket,
  index = 0,
) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const request = socket.sent[index];
    if (request) {
      return decodeRpcRequest(decodeJson(request));
    }
    yield* Effect.yieldNow;
  }
  return yield* Effect.die(new Error("Expected the RPC protocol to send a request."));
});

const completeInitialConfig = Effect.fn("TestRpcSessionFactory.completeInitialConfig")(function* (
  socket: TestWebSocket,
  config: unknown = ENCODED_SERVER_CONFIG,
) {
  const request = yield* awaitRequest(socket);
  expect(request).toMatchObject({
    _tag: "Request",
    tag: WS_METHODS.serverGetConfig,
    payload: {},
  });
  socket.serverMessage(
    encodeJson({
      _tag: "Exit",
      requestId: request.id,
      exit: {
        _tag: "Success",
        value: config,
      },
    }),
  );
});

describe("RpcSessionFactory", () => {
  it.effect("stays on WebSocket when the server capability is absent", () =>
    Effect.gen(function* () {
      const { factory, sockets } = yield* makeFactory();
      const session = yield* factory.connect(PREPARED);
      const readyFiber = yield* Effect.forkChild(session.ready);
      const socket = yield* awaitSocket(sockets);

      socket.open();
      yield* completeInitialConfig(socket);
      yield* Fiber.join(readyFiber);

      expect(session.transport).toBe("websocket");
      expect(socket.sent).toHaveLength(1);
    }),
  );

  it.effect("stays on WebSocket when the platform has no WebRTC adapter", () =>
    Effect.gen(function* () {
      const { factory, sockets } = yield* makeFactory();
      const session = yield* factory.connect(PREPARED);
      const readyFiber = yield* Effect.forkChild(session.ready);
      const socket = yield* awaitSocket(sockets);

      socket.open();
      yield* completeInitialConfig(socket, ENCODED_WEBRTC_SERVER_CONFIG);
      yield* Fiber.join(readyFiber);

      expect(session.transport).toBe("websocket");
      expect(socket.sent).toHaveLength(1);
    }),
  );

  it.effect("silently falls back when WebRTC peer creation fails", () =>
    Effect.gen(function* () {
      const peerFactory: WebRtcPeerFactoryService = {
        create: () =>
          Effect.fail(
            new WebRtcPeerError({
              stage: "create",
              cause: new Error("WebRTC unavailable in test."),
            }),
          ),
      };
      const { factory, sockets } = yield* makeFactory(peerFactory);
      const session = yield* factory.connect(PREPARED);
      const readyFiber = yield* Effect.forkChild(session.ready);
      const socket = yield* awaitSocket(sockets);

      socket.open();
      yield* completeInitialConfig(socket, ENCODED_WEBRTC_SERVER_CONFIG);
      yield* Fiber.join(readyFiber);

      expect(session.transport).toBe("websocket");
      expect(socket.sent).toHaveLength(1);
    }),
  );

  it.effect("reaches WebSocket readiness before selecting WebRTC", () =>
    Effect.gen(function* () {
      const rtc = yield* makeRtcHarness();
      const { factory, sockets } = yield* makeFactory(rtc.peerFactory);
      const session = yield* factory.connect(PREPARED);
      const readyFiber = yield* Effect.forkChild(session.ready);
      const socket = yield* awaitSocket(sockets);

      socket.open();
      yield* completeInitialConfig(socket, ENCODED_WEBRTC_SERVER_CONFIG);
      yield* Fiber.join(readyFiber);

      expect(session.transport).toBe("websocket");
      const transportChanges = session.transportChanges;
      if (transportChanges === undefined) {
        return yield* Effect.die(new Error("Expected session transport changes."));
      }
      const upgraded = yield* transportChanges.pipe(
        Stream.filter((transport) => transport === "webrtc"),
        Stream.runHead,
        Effect.map(Option.getOrThrow),
        Effect.forkChild,
      );
      yield* completeWebRtcSignaling(socket);
      expect(yield* Fiber.join(upgraded)).toBe("webrtc");
      expect(session.transport).toBe("webrtc");
      expect(yield* Queue.take(rtc.rtcRequests)).toBe(WS_METHODS.serverProbe);
      expect(yield* Queue.take(rtc.rtcRequests)).toBe(WS_METHODS.serverGetConfig);
      expect(socket.sent.map((value) => decodeRpcRequest(decodeJson(value)).tag)).toEqual([
        WS_METHODS.serverGetConfig,
        WS_METHODS.transportWebRtcNegotiate,
      ]);

      const closedFiber = yield* Effect.flip(session.closed).pipe(Effect.forkChild);
      socket.close(1012, "service restart");
      yield* Fiber.join(closedFiber);
      expect(rtc.clientPort.isOpen()).toBe(false);
    }),
  );

  it.effect("fails after selected WebRTC closes and cools down the next attempt", () =>
    Effect.gen(function* () {
      const rtc = yield* makeRtcHarness();
      const { factory, sockets } = yield* makeFactory(rtc.peerFactory);
      const firstSession = yield* factory.connect(PREPARED);
      const firstReady = yield* Effect.forkChild(firstSession.ready);
      const firstSocket = yield* awaitSocket(sockets);

      firstSocket.open();
      yield* completeInitialConfig(firstSocket, ENCODED_WEBRTC_SERVER_CONFIG);
      yield* Fiber.join(firstReady);

      expect(firstSession.transport).toBe("websocket");
      const transportChanges = firstSession.transportChanges;
      if (transportChanges === undefined) {
        return yield* Effect.die(new Error("Expected session transport changes."));
      }
      const upgraded = yield* transportChanges.pipe(
        Stream.filter((transport) => transport === "webrtc"),
        Stream.runHead,
        Effect.map(Option.getOrThrow),
        Effect.forkChild,
      );
      yield* completeWebRtcSignaling(firstSocket);
      expect(yield* Fiber.join(upgraded)).toBe("webrtc");
      expect(firstSession.transport).toBe("webrtc");

      const firstClosed = yield* Effect.flip(firstSession.closed).pipe(Effect.forkChild);
      rtc.clientPort.close();
      const closeError = yield* Fiber.join(firstClosed);
      expect(closeError).toMatchObject({ reason: "transport" });

      const secondSession = yield* factory.connect(PREPARED);
      const secondReady = yield* Effect.forkChild(secondSession.ready);
      for (let attempt = 0; attempt < 100 && sockets.length < 2; attempt += 1) {
        yield* Effect.yieldNow;
      }
      const secondSocket = sockets[1];
      if (secondSocket === undefined) {
        return yield* Effect.die(new Error("Expected a replacement WebSocket."));
      }
      secondSocket.open();
      yield* completeInitialConfig(secondSocket, ENCODED_WEBRTC_SERVER_CONFIG);
      yield* Fiber.join(secondReady);

      expect(secondSession.transport).toBe("websocket");
      expect(secondSocket.sent).toHaveLength(1);
      expect(yield* Queue.size(rtc.created)).toBe(1);
    }),
  );

  it.effect("owns one scoped websocket attempt and exposes readiness and closure", () =>
    Effect.gen(function* () {
      const { factory, sockets } = yield* makeFactory();
      const session = yield* factory.connect(PREPARED);
      const readyFiber = yield* Effect.forkChild(session.ready);
      const socket = yield* awaitSocket(sockets);

      expect(socket.url).toBe(PREPARED.socketUrl);
      socket.open();
      yield* completeInitialConfig(socket);
      yield* Fiber.join(readyFiber);

      const config = yield* session.initialConfig;
      expect(config).toEqual(SERVER_CONFIG);
      expect(socket.sent).toHaveLength(1);

      const probeFiber = yield* Effect.forkChild(session.probe);
      const probeRequest = yield* awaitRequest(socket, 1);
      expect(probeRequest).toMatchObject({
        _tag: "Request",
        tag: WS_METHODS.serverProbe,
        payload: {},
      });
      socket.serverMessage(
        encodeJson({
          _tag: "Exit",
          requestId: probeRequest.id,
          exit: {
            _tag: "Success",
            value: {},
          },
        }),
      );
      yield* Fiber.join(probeFiber);

      expect(socket.sent.map((request) => decodeRpcRequest(decodeJson(request)).tag)).toEqual([
        WS_METHODS.serverGetConfig,
        WS_METHODS.serverProbe,
      ]);

      socket.close(1012, "service restart");
      const error = yield* Effect.flip(session.closed);

      expect(error).toBeInstanceOf(ConnectionTransientError);
      expect(error).toMatchObject({
        reason: "transport",
        message: "Test environment disconnected.",
      });
      yield* Effect.yieldNow;
      expect(sockets).toHaveLength(1);
    }),
  );

  it.effect("closes the websocket when the session scope is released", () =>
    Effect.gen(function* () {
      const { factory, sockets } = yield* makeFactory();

      yield* Effect.scoped(
        Effect.gen(function* () {
          const session = yield* factory.connect(PREPARED);
          const readyFiber = yield* Effect.forkChild(session.ready);
          const socket = yield* awaitSocket(sockets);
          socket.open();
          yield* completeInitialConfig(socket);
          yield* Fiber.join(readyFiber);
        }),
      );

      expect(sockets[0]?.readyState).toBe(TestWebSocket.CLOSED);
    }),
  );

  it.effect("tolerates two missed pong windows before closing the session", () =>
    Effect.gen(function* () {
      const { factory, sockets } = yield* makeFactory();
      const session = yield* factory.connect(PREPARED);
      const readyFiber = yield* Effect.forkChild(session.ready);
      const closedFiber = yield* Effect.forkChild(Effect.flip(session.closed));
      const socket = yield* awaitSocket(sockets);

      socket.open();
      yield* completeInitialConfig(socket);
      yield* Fiber.join(readyFiber);

      yield* TestClock.adjust("15 seconds");
      expect(closedFiber.pollUnsafe()).toBeUndefined();
      expect(socket.sent.slice(1).map((request) => decodeJson(request))).toEqual([
        { _tag: "Ping" },
        { _tag: "Ping" },
        { _tag: "Ping" },
      ]);

      yield* TestClock.adjust("5 seconds");
      const error = yield* Fiber.join(closedFiber);
      expect(error).toBeInstanceOf(ConnectionTransientError);
      expect(error).toMatchObject({ reason: "transport" });
    }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
  );

  it.effect("reaches ready when a newer server sends unknown config members", () =>
    Effect.gen(function* () {
      const { factory, sockets } = yield* makeFactory();
      const session = yield* factory.connect(PREPARED);
      const readyFiber = yield* Effect.forkChild(session.ready);
      const socket = yield* awaitSocket(sockets);
      socket.open();

      const shortcut = {
        key: "p",
        metaKey: false,
        ctrlKey: false,
        shiftKey: false,
        altKey: false,
        modKey: true,
      };
      yield* completeInitialConfig(socket, {
        ...ENCODED_SERVER_CONFIG,
        keybindings: [
          { command: "someFuture.toggle", shortcut },
          { command: "terminal.toggle", shortcut },
        ],
        issues: [{ kind: "keybindings.future-issue", message: "From a newer server" }],
        availableEditors: ["some-future-editor", "zed"],
      });
      yield* Fiber.join(readyFiber);

      const config = yield* session.initialConfig;
      expect(config.keybindings).toEqual([{ command: "terminal.toggle", shortcut }]);
      expect(config.issues).toEqual([]);
      expect(config.availableEditors).toEqual(["zed"]);
    }),
  );

  it.effect("uses the legacy config RPC for probes when the server lacks the capability", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { factory, sockets } = yield* makeFactory();
        const session = yield* factory.connect(PREPARED);
        const readyFiber = yield* Effect.forkChild(session.ready);
        const socket = yield* awaitSocket(sockets);

        socket.open();
        yield* completeInitialConfig(socket, LEGACY_SERVER_CONFIG);
        yield* Fiber.join(readyFiber);

        const probeFiber = yield* Effect.forkChild(session.probe);
        const probeRequest = yield* awaitRequest(socket, 1);
        expect(probeRequest).toMatchObject({
          _tag: "Request",
          tag: WS_METHODS.serverGetConfig,
          payload: {},
        });
        socket.serverMessage(
          encodeJson({
            _tag: "Exit",
            requestId: probeRequest.id,
            exit: {
              _tag: "Success",
              value: LEGACY_SERVER_CONFIG,
            },
          }),
        );
        yield* Fiber.join(probeFiber);

        expect(socket.sent.map((request) => decodeRpcRequest(decodeJson(request)).tag)).toEqual([
          WS_METHODS.serverGetConfig,
          WS_METHODS.serverGetConfig,
        ]);
      }),
    ),
  );

  it.effect("fails readiness when the websocket never opens", () =>
    Effect.gen(function* () {
      const { factory, sockets } = yield* makeFactory();

      const error = yield* Effect.scoped(
        Effect.gen(function* () {
          const session = yield* factory.connect(PREPARED);
          const readyFiber = yield* Effect.forkChild(Effect.flip(session.ready));
          yield* awaitSocket(sockets);

          yield* TestClock.adjust("15 seconds");
          return yield* Fiber.join(readyFiber);
        }),
      );

      expect(error).toBeInstanceOf(ConnectionTransientError);
      expect(error).toMatchObject({
        reason: "transport",
        message: "Test environment could not establish a WebSocket connection.",
      });
      expect(sockets[0]?.readyState).toBe(TestWebSocket.CLOSED);
    }).pipe(Effect.provide(TestClock.layer())),
  );
});
