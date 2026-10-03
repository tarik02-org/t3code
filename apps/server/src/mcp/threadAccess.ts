import type { ProjectionRecordField } from "../orchestration-v2/ProjectionStore.ts";
import {
  CommandId,
  OrchestratorMcpFailure,
  type ThreadId,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";

import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as OrchestrationMcp from "./OrchestratorMcpService.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";

export const unavailable = () =>
  new OrchestratorMcpFailure({
    code: "orchestration_error",
    message: "The operation could not be completed.",
  });

export const readCaller = Effect.fn("mcp.readCaller")(function* () {
  const scope = yield* McpInvocationContext.requireThreadCaller;
  if (!scope.capabilities.has("orchestration")) {
    return yield* new OrchestratorMcpFailure({
      code: "capability_denied",
      message: "This credential cannot control threads.",
    });
  }
  const threads = yield* ThreadManagement.ThreadManagementService;
  const caller = yield* threads.getThreadShell(scope.threadId).pipe(Effect.mapError(unavailable));
  if (caller === null || caller.deletedAt !== null) {
    return yield* new OrchestratorMcpFailure({
      code: "thread_not_found",
      message: "The calling thread was not found.",
    });
  }
  return { scope, threads, caller };
});

/**
 * A caller that may use environment-wide tools: a thread caller (validated as by
 * `readCaller`), or an external client, which has no calling thread.
 */
export const readEnvironmentCaller = Effect.fn("mcp.readEnvironmentCaller")(function* () {
  const scope = yield* McpInvocationContext.McpInvocationContext;
  if (McpInvocationContext.isExternalCaller(scope)) return { scope, caller: null };
  const { caller } = yield* readCaller();
  return { scope, caller };
});

function assertLiveCaller({
  caller,
  scope,
}: {
  caller: OrchestrationV2ThreadShell;
  scope: McpInvocationContext.McpInvocationScope;
}) {
  return caller.archivedAt !== null ||
    caller.activeRunId === null ||
    caller.providerInstanceId !== scope.providerInstanceId
    ? Effect.fail(
        new OrchestratorMcpFailure({
          code: "parent_not_active",
          message: "The calling provider no longer owns an active thread run.",
        }),
      )
    : Effect.void;
}
export const readMutationCaller = Effect.fn("mcp.readMutationCaller")(function* () {
  const context = yield* readCaller();
  yield* assertLiveCaller(context);
  return context;
});

const threadNotFound = (message: string) =>
  new OrchestratorMcpFailure({ code: "thread_not_found", message });

/**
 * Resolve the credential's project before looking up a caller-supplied thread.
 * External callers have no project, so they name the thread and reach any in the environment.
 */
export const readThread = Effect.fn("mcp.readThread")(function* <
  K extends ProjectionRecordField = never,
>(threadId?: ThreadId, fields: ReadonlyArray<K> = []) {
  const scope = yield* McpInvocationContext.McpInvocationContext;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const readProjectThread = (projectId: OrchestrationV2ThreadShell["projectId"], id: ThreadId) =>
    threads
      .getProjectThreadRecords({ projectId, threadId: id }, fields, {
        turnItemTypes: ["user_input_request"],
      })
      .pipe(
        Effect.mapError((error) =>
          error._tag === "ThreadManagementThreadNotFoundError"
            ? threadNotFound("The thread was not found in the calling project.")
            : unavailable(),
        ),
      );
  if (McpInvocationContext.isExternalCaller(scope)) {
    if (threadId === undefined) {
      return yield* new OrchestratorMcpFailure({
        code: "invalid_request",
        message: "threadId is required: an external caller has no calling thread.",
      });
    }
    const shell = yield* threads.getThreadShell(threadId).pipe(Effect.mapError(unavailable));
    if (shell === null || shell.deletedAt !== null) {
      return yield* threadNotFound("The thread was not found.");
    }
    const projection = yield* readProjectThread(shell.projectId, threadId);
    return { scope, threads, caller: null, projection };
  }
  const { scope: threadScope, caller } = yield* readCaller();
  const projection = yield* readProjectThread(caller.projectId, threadId ?? caller.id);
  return { scope: threadScope, threads, caller, projection };
});

/**
 * A thread caller must be live and may not act on a thread with broader modes than its own.
 * An external caller holds `orchestration:operate`, so it acts as the user's own client does.
 */
export const readWritableThread = Effect.fn("mcp.readWritableThread")(function* <
  K extends ProjectionRecordField = never,
>(threadId?: ThreadId, fields: ReadonlyArray<K> = []) {
  const context = yield* readThread(threadId, fields);
  if (context.caller === null) return context;
  yield* assertLiveCaller(context);
  yield* OrchestrationMcp.resolveRuntimeMode(
    context.caller.runtimeMode,
    context.projection.thread.runtimeMode,
  );
  yield* OrchestrationMcp.resolveInteractionMode(
    context.caller.interactionMode,
    context.projection.thread.interactionMode,
  );
  return context;
});

export const newCommandId = Effect.fn("mcp.newCommandId")(function* () {
  const crypto = yield* Crypto.Crypto;
  return CommandId.make(`mcp:${yield* crypto.randomUUIDv4.pipe(Effect.orDie)}`);
});
