import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as Environment from "../../../environment/ServerEnvironment.ts";
import * as ThreadCommandExecutor from "../../../orchestration-v2/ThreadCommandExecutor.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as Settings from "../../../serverSettings.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { EnvironmentHandlersLive } from "./handlers.ts";
import { EnvironmentToolkit } from "./tools.ts";

it.effect(
  "reports the calling credential's identity without shell variables or optional capabilities",
  () =>
    Effect.gen(function* () {
      for (const provider of ["cursor", "opencode", "codex"]) {
        const dependencies = Layer.mergeAll(
          Layer.succeed(McpInvocationContext.McpInvocationContext, {
            environmentId: EnvironmentId.make("environment:identity"),
            thread: {
              threadId: ThreadId.make(`thread:${provider}`),
              providerInstanceId: ProviderInstanceId.make(provider),
              providerSessionId: `session:${provider}`,
            },
            client: undefined,
            requestNamespace: `session:${provider}`,
            capabilities: new Set<McpInvocationContext.McpCapability>(),
            issuedAt: 0,
          }),
          Layer.mock(Environment.ServerEnvironment)({}),
          Layer.mock(ThreadCommandExecutor.ThreadCommandExecutor)({}),
          Layer.mock(ThreadManagement.ThreadManagementService)({}),
          Layer.mock(Settings.ServerSettingsService)({}),
        );
        const toolkit = yield* EnvironmentToolkit.pipe(
          Effect.provide(EnvironmentHandlersLive.pipe(Layer.provide(dependencies))),
        );
        const result = yield* toolkit
          .handle("t3_identity", {})
          .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
        expect(result.at(-1)?.result).toEqual({
          environmentId: "environment:identity",
          threadId: `thread:${provider}`,
          providerInstanceId: provider,
        });
      }
    }),
);
