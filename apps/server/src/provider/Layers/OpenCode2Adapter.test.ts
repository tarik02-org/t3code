import * as NodeAssert from "node:assert/strict";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { OpenCode2Settings, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { ServerConfig } from "../../config.ts";
import type { OpenCode2AdapterShape } from "../Services/OpenCode2Adapter.ts";
import { OpenCode2Runtime } from "../opencode2Runtime.ts";
import type { OpenCodeClient } from "../opencode2Runtime.ts";
import { makeOpenCode2Adapter } from "./OpenCode2Adapter.ts";

class OpenCode2Adapter extends Context.Service<OpenCode2Adapter, OpenCode2AdapterShape>()(
  "t3/provider/Layers/OpenCode2Adapter.test/OpenCode2Adapter",
) {}

const environmentCalls: Array<{
  readonly sessionID: string;
  readonly variables: Record<string, string>;
}> = [];

/**
 * Starting a session only reaches for a handful of client operations, so the
 * fake implements those and nothing else. The cast is the same trade the v1
 * adapter test makes — the generated client surface is far too wide to build.
 */
const fakeClient = {
  session: {
    create: () => Effect.succeed({ id: "ses_test", location: { directory: process.cwd() } }),
    environment: (input: { sessionID: string; variables: Record<string, string> }) =>
      Effect.sync(() => {
        environmentCalls.push(input);
      }),
  },
  event: {
    // One `server.connected` releases `startSession`, then the stream stays
    // open so the pump does not spin through its reconnect loop.
    subscribe: () => Stream.concat(Stream.make({ type: "server.connected" }), Stream.never),
  },
} as unknown as OpenCodeClient;

const OpenCode2AdapterTestLayer = Layer.effect(
  OpenCode2Adapter,
  makeOpenCode2Adapter(Schema.decodeSync(OpenCode2Settings)({}), {
    instanceId: ProviderInstanceId.make("opencode2-test"),
    environment: { SHARED_INSTANCE_VAR: "instance", T3CODE_THREAD_ID: "stale-thread" },
  }),
).pipe(
  Layer.provideMerge(
    Layer.succeed(OpenCode2Runtime, {
      connect: () =>
        Effect.succeed({
          client: fakeClient,
          url: "http://127.0.0.1:4096",
          external: true,
          version: "2.0.5",
        }),
      loadInventory: () => Effect.succeed({ models: [], skills: [] }),
    }),
  ),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
  Layer.provideMerge(NodeServices.layer),
);

it.layer(OpenCode2AdapterTestLayer)("OpenCode2AdapterLive", (it) => {
  it.effect("sends the thread's launch env on top of the instance env", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCode2Adapter;

      yield* adapter.startSession({
        threadId: ThreadId.make("thread-env"),
        runtimeMode: "full-access",
        env: { T3CODE_THREAD_ID: "thread-env", T3CODE_PROJECT_ROOT: "/repo" },
      });

      NodeAssert.equal(environmentCalls.length, 1);
      const variables = environmentCalls[0]?.variables ?? {};
      NodeAssert.equal(variables.SHARED_INSTANCE_VAR, "instance");
      // The launch env owns the managed keys: an instance-level value must
      // never shadow the running thread's identity.
      NodeAssert.equal(variables.T3CODE_THREAD_ID, "thread-env");
      NodeAssert.equal(variables.T3CODE_PROJECT_ROOT, "/repo");
    }),
  );
});
