import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentHttpApi,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";

import { projectThreadDetailSnapshot } from "./ActivityPayloadProjection.ts";
import { normalizeDispatchCommand } from "./Normalizer.ts";
import {
  annotateEnvironmentRequest,
  failEnvironmentInternal,
  failEnvironmentInvalidRequest,
  failEnvironmentNotFound,
  requireEnvironmentScope,
} from "../auth/http.ts";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";

export const orchestrationHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "orchestration",
  Effect.fnUntraced(function* (handlers) {
    const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
    const orchestrationEngine = yield* OrchestrationEngineService;

    return handlers
      .handle(
        "snapshot",
        Effect.fn("environment.orchestration.snapshot")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          return yield* projectionSnapshotQuery
            .getSnapshot()
            .pipe(
              Effect.catch((cause) =>
                failEnvironmentInternal("orchestration_snapshot_failed", cause),
              ),
            );
        }),
      )
      .handle(
        "shellSnapshot",
        Effect.fn("environment.orchestration.shellSnapshot")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          return yield* projectionSnapshotQuery
            .getShellSnapshot()
            .pipe(
              Effect.catch((cause) =>
                failEnvironmentInternal("orchestration_snapshot_failed", cause),
              ),
            );
        }),
      )
      .handle(
        "threadSnapshot",
        Effect.fn("environment.orchestration.threadSnapshot")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          const snapshot = yield* projectionSnapshotQuery
            .getThreadDetailSnapshot(args.params.threadId, args.query.messageLimit)
            .pipe(
              Effect.catch((cause) =>
                failEnvironmentInternal("orchestration_thread_snapshot_failed", cause),
              ),
            );
          if (Option.isNone(snapshot)) {
            return yield* failEnvironmentNotFound("thread_not_found");
          }
          return projectThreadDetailSnapshot(snapshot.value);
        }),
      )
      .handle(
        "threadMessages",
        Effect.fn("environment.orchestration.threadMessages")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          const page = yield* projectionSnapshotQuery
            .getThreadMessagePage({
              threadId: args.params.threadId,
              before: {
                createdAt: args.query.beforeCreatedAt,
                messageId: args.query.beforeMessageId,
              },
              limit: args.query.limit,
            })
            .pipe(
              Effect.catch((cause) =>
                failEnvironmentInternal("orchestration_thread_snapshot_failed", cause),
              ),
            );
          if (Option.isNone(page)) {
            return yield* failEnvironmentNotFound("thread_not_found");
          }
          return page.value;
        }),
      )
      .handle(
        "threadMessagesAfter",
        Effect.fn("environment.orchestration.threadMessagesAfter")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          const page = yield* projectionSnapshotQuery
            .getThreadMessagePageAfter({
              threadId: args.params.threadId,
              after: {
                createdAt: args.query.afterCreatedAt,
                messageId: args.query.afterMessageId,
              },
              limit: args.query.limit,
            })
            .pipe(
              Effect.catch((cause) =>
                failEnvironmentInternal("orchestration_thread_snapshot_failed", cause),
              ),
            );
          if (Option.isNone(page)) {
            return yield* failEnvironmentNotFound("thread_not_found");
          }
          return page.value;
        }),
      )
      .handle(
        "threadMessagesAround",
        Effect.fn("environment.orchestration.threadMessagesAround")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          const page = yield* projectionSnapshotQuery
            .getThreadMessagePageAround({
              threadId: args.params.threadId,
              messageId: args.params.messageId,
              limit: args.query.limit,
            })
            .pipe(
              Effect.catch((cause) =>
                failEnvironmentInternal("orchestration_thread_snapshot_failed", cause),
              ),
            );
          if (Option.isNone(page)) {
            return yield* failEnvironmentNotFound("thread_not_found");
          }
          return page.value;
        }),
      )
      .handle(
        "threadHistoryOutline",
        Effect.fn("environment.orchestration.threadHistoryOutline")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          const outline = yield* projectionSnapshotQuery
            .getThreadHistoryOutline(args.params.threadId)
            .pipe(
              Effect.catch((cause) =>
                failEnvironmentInternal("orchestration_thread_snapshot_failed", cause),
              ),
            );
          if (Option.isNone(outline)) {
            return yield* failEnvironmentNotFound("thread_not_found");
          }
          return outline.value;
        }),
      )
      .handle(
        "dispatch",
        Effect.fn("environment.orchestration.dispatch")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          const normalizedCommand = yield* normalizeDispatchCommand(args.payload).pipe(
            Effect.catch(() => failEnvironmentInvalidRequest("invalid_command")),
          );
          return yield* orchestrationEngine
            .dispatch(normalizedCommand)
            .pipe(
              Effect.catch((cause) =>
                failEnvironmentInternal("orchestration_dispatch_failed", cause),
              ),
            );
        }),
      );
  }),
);
