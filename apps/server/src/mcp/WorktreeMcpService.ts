import {
  CommandId,
  MessageId,
  type ProjectId,
  WorktreeMcpFailure,
  type WorktreeMcpContinuationStatus,
  type WorktreeMcpHandoffInput,
  type WorktreeMcpHandoffResult,
  type WorktreeMcpSetupScriptStatus,
  type WorktreeMcpStatusResult,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as VcsStatusBroadcaster from "../vcs/VcsStatusBroadcaster.ts";
import type { McpInvocationScope, McpThreadInvocationScope } from "./McpInvocationContext.ts";

export class WorktreeMcpService extends Context.Service<
  WorktreeMcpService,
  {
    readonly handoff: (
      scope: McpInvocationScope,
      input: WorktreeMcpHandoffInput,
    ) => Effect.Effect<WorktreeMcpHandoffResult, WorktreeMcpFailure>;
    readonly status: (
      scope: McpInvocationScope,
    ) => Effect.Effect<WorktreeMcpStatusResult, WorktreeMcpFailure>;
  }
>()("t3/mcp/WorktreeMcpService") {}

function failure(code: WorktreeMcpFailure["code"], message: string): WorktreeMcpFailure {
  return new WorktreeMcpFailure({ code, message });
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null && "message" in error) {
    return String((error as { message: unknown }).message);
  }
  return String(error);
}

// Shared shape for "the handoff already succeeded, so report the failure in
// the result instead of failing the call" (continuation, setup script).
const reportFailed = (scope: McpThreadInvocationScope, worktreePath: string, logMessage: string) =>
  Effect.catchCause((cause: Cause.Cause<unknown>) => {
    const detail = errorMessage(Cause.squash(cause));
    return Effect.logWarning(logMessage, {
      threadId: scope.thread.threadId,
      worktreePath,
      detail,
    }).pipe(Effect.as({ status: "failed", detail } as const));
  });

const asOperationFailed = (prefix: string) =>
  Effect.mapError((error: unknown) =>
    failure("operation_failed", `${prefix}: ${errorMessage(error)}`),
  );

const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const path = yield* Path.Path;
  const threadManagement = yield* ThreadManagementService.ThreadManagementService;
  const projects = yield* ProjectService.ProjectService;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const gitWorkflow = yield* GitWorkflowService.GitWorkflowService;
  const setupScriptRunner = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
  const vcsStatusBroadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;

  // Serializes handoffs per thread: two concurrent calls could otherwise both
  // pass the worktreePath === null check and each create a worktree, leaving
  // one untracked on disk.
  const handoffThreadsInFlight = new Set<string>();

  // Worktree tools act on the calling thread's own checkout binding.
  const requireThreadScope = (scope: McpInvocationScope) =>
    scope.thread === undefined
      ? Effect.fail(
          failure(
            "thread_credential_required",
            "Worktree handoff and status act as the calling T3 thread, so they need an agent running inside T3 Code.",
          ),
        )
      : Effect.succeed(scope as McpThreadInvocationScope);

  const requireCapability = (scope: McpInvocationScope) =>
    scope.capabilities.has("worktree")
      ? Effect.void
      : Effect.fail(
          failure("capability_denied", "This MCP credential does not grant worktree capabilities."),
        );

  const loadThread = (scope: McpThreadInvocationScope) =>
    threadManagement.getThreadRecords(scope.thread.threadId, []).pipe(
      Effect.mapError((error) =>
        error._tag === "OrchestratorProjectionError"
          ? failure("thread_not_found", `Thread '${scope.thread.threadId}' was not found.`)
          : failure(
              "operation_failed",
              `Unable to read thread ${scope.thread.threadId}: ${errorMessage(error)}`,
            ),
      ),
      Effect.filterOrFail(
        (projection) => projection.thread.deletedAt === null,
        () => failure("thread_not_found", `Thread '${scope.thread.threadId}' was not found.`),
      ),
    );

  const loadProject = (scope: McpThreadInvocationScope, projectId: ProjectId) =>
    projects.getById(projectId).pipe(
      asOperationFailed(`Unable to read project ${projectId}`),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(
              failure(
                "project_not_found",
                `Project '${projectId}' was not found for thread '${scope.thread.threadId}'.`,
              ),
            ),
          onSome: Effect.succeed,
        }),
      ),
    );

  const readDefaultStartFromOrigin = serverSettings.getSettings.pipe(
    Effect.map((settings) => settings.newWorktreesStartFromOrigin),
    asOperationFailed("Unable to read server settings"),
  );

  const handoffIds = (scope: McpThreadInvocationScope) =>
    crypto.randomUUIDv4.pipe(
      Effect.map((uuid) => {
        const part = (kind: string, operation: string) =>
          [kind, "mcp", encodeURIComponent(scope.thread.providerSessionId), operation, uuid].join(
            ":",
          );
        return {
          commandId: CommandId.make(part("command", "worktree-handoff")),
          continuationCommandId: CommandId.make(part("command", "worktree-continuation")),
          continuationMessageId: MessageId.make(part("message", "worktree-continuation")),
        };
      }),
      Effect.orDie,
    );

  // Queued right after the binding commits: the detach that the metadata
  // update schedules will terminate the calling session, and a durably queued
  // message is what guarantees the thread re-launches inside the worktree.
  // When the dying run reaches a terminal state the orchestrator promotes the
  // queued run, which derives its cwd from the updated projection. A failure
  // is reported in the result, not raised, because the binding is recorded.
  const queueContinuation = (
    scope: McpThreadInvocationScope,
    projectId: ProjectId,
    ids: { readonly continuationCommandId: CommandId; readonly continuationMessageId: MessageId },
    continuationPrompt: string | undefined,
    worktreePath: string,
  ): Effect.Effect<WorktreeMcpContinuationStatus> =>
    continuationPrompt === undefined
      ? Effect.succeed<WorktreeMcpContinuationStatus>({ status: "skipped" })
      : threadManagement
          .sendToThread({
            projectId,
            commandId: ids.continuationCommandId,
            threadId: scope.thread.threadId,
            messageId: ids.continuationMessageId,
            text: continuationPrompt,
            attachments: [],
            mode: "queue",
            createdBy: "agent",
            creationSource: "mcp",
          })
          .pipe(
            Effect.map((sendResult): WorktreeMcpContinuationStatus => ({
              status: "scheduled",
              delivery: sendResult.delivery,
            })),
            reportFailed(scope, worktreePath, "worktree handoff continuation failed to queue"),
          );

  const handoffNote = (continuation: WorktreeMcpContinuationStatus) =>
    continuation.status === "scheduled"
      ? "Handoff recorded. Changing the workspace detaches this provider session, so the current turn ends shortly after this call; the queued continuation prompt then starts the next turn inside the worktree with the conversation preserved. The worktree is not removed automatically when the thread is deleted."
      : "Handoff recorded. Changing the workspace detaches this provider session, so the current turn ends shortly after this call; the conversation continues inside the worktree when the thread receives its next message. Pass continuationPrompt to resume automatically. The worktree is not removed automatically when the thread is deleted.";

  const requireAbsolutePath = (field: string, value: string) =>
    path.isAbsolute(value)
      ? Effect.void
      : Effect.fail(
          failure(
            "invalid_request",
            `${field} must be an absolute filesystem path, got '${value}'. A relative path would resolve against the project workspace but be stored verbatim as the thread's worktree binding.`,
          ),
        );

  const rejectArchived = (scope: McpThreadInvocationScope, archived: boolean) =>
    // An archived thread would accept the binding but refuse the continuation
    // message (and any other follow-up), so reject the handoff outright.
    !archived
      ? Effect.void
      : Effect.fail(
          failure(
            "invalid_request",
            `Thread '${scope.thread.threadId}' is archived and cannot be handed off to a worktree.`,
          ),
        );

  const requireRepository = (projectCwd: string) =>
    gitWorkflow.localStatus({ cwd: projectCwd }).pipe(
      asOperationFailed("Unable to read git status"),
      Effect.filterOrFail(
        (status) => status.isRepo,
        () =>
          failure("invalid_request", `Project workspace '${projectCwd}' is not a git repository.`),
      ),
    );

  const attachExistingWorktree = Effect.fn("WorktreeMcpService.attachExistingWorktree")(function* (
    scope: McpThreadInvocationScope,
    input: WorktreeMcpHandoffInput,
    existingWorktreePath: string,
  ) {
    if (
      input.branch !== undefined ||
      input.baseRef !== undefined ||
      input.startFromOrigin !== undefined ||
      input.path !== undefined
    ) {
      return yield* failure(
        "invalid_request",
        "existingWorktreePath attaches a checkout that already exists; omit branch, baseRef, startFromOrigin, and path.",
      );
    }
    yield* requireAbsolutePath("existingWorktreePath", existingWorktreePath);

    const projection = yield* loadThread(scope);
    yield* rejectArchived(scope, projection.thread.archivedAt !== null);
    const project = yield* loadProject(scope, projection.thread.projectId);
    const projectCwd = project.workspaceRoot;
    yield* requireRepository(projectCwd);

    const targetPath = path.resolve(existingWorktreePath);
    const targetStatus = yield* gitWorkflow
      .localStatus({ cwd: targetPath })
      .pipe(asOperationFailed(`Unable to read git status of '${targetPath}'`));
    if (!targetStatus.isRepo) {
      return yield* failure("invalid_request", `'${targetPath}' is not a git checkout.`);
    }
    const branch = targetStatus.refName;
    if (branch === null) {
      return yield* failure(
        "invalid_request",
        `'${targetPath}' has a detached HEAD. Check out a branch there before moving the thread into it.`,
      );
    }

    // The ref inventory of the project repository maps each branch to the
    // worktree it is checked out in, which proves the target belongs to this
    // project rather than to an unrelated repository.
    const projectRef = yield* gitWorkflow
      .listRefs({ cwd: projectCwd, query: branch, refKind: "local" })
      .pipe(
        Effect.map((result) =>
          result.refs.find((ref) => ref.name === branch && ref.isRemote !== true),
        ),
        asOperationFailed("Unable to list branches"),
      );
    if (
      projectRef?.worktreePath === null ||
      projectRef?.worktreePath === undefined ||
      path.resolve(projectRef.worktreePath) !== targetPath
    ) {
      return yield* failure(
        "invalid_request",
        `'${targetPath}' is not a worktree of the project repository at '${projectCwd}'. Use t3_worktree_list to find the project's worktrees.`,
      );
    }

    // The main checkout is the project root, which threads represent as no
    // worktree binding.
    const worktreePath = targetPath === path.resolve(projectCwd) ? null : targetPath;
    if (worktreePath === projection.thread.worktreePath) {
      return yield* failure(
        "invalid_request",
        `Thread '${scope.thread.threadId}' is already in '${targetPath}'.`,
      );
    }

    const ids = yield* handoffIds(scope);

    // uninterruptible: once the binding may have committed, the scheduled
    // session detach can sever this request's connection; the continuation
    // must still be queued or the thread never resumes in the worktree.
    const continuation = yield* Effect.uninterruptible(
      threadManagement
        .dispatch({
          type: "thread.metadata.update",
          commandId: ids.commandId,
          threadId: scope.thread.threadId,
          branch,
          worktreePath,
          // Rejects the switch if the binding changed since it was read.
          expectedWorktreePath: projection.thread.worktreePath,
        })
        .pipe(
          asOperationFailed("Unable to re-point the thread at the worktree"),
          Effect.andThen(() =>
            queueContinuation(
              scope,
              projection.thread.projectId,
              ids,
              input.continuationPrompt,
              targetPath,
            ),
          ),
        ),
    );

    yield* vcsStatusBroadcaster
      .refreshStatus(targetPath)
      .pipe(Effect.ignoreCause({ log: true }), Effect.forkDetach);

    const result: WorktreeMcpHandoffResult = {
      worktreePath: targetPath,
      branch,
      baseRef: null,
      startedFromOrigin: false,
      setupScript: { status: "skipped" },
      continuation,
      note: handoffNote(continuation),
    };
    return result;
  });

  const createWorktree = Effect.fn("WorktreeMcpService.createWorktree")(function* (
    scope: McpThreadInvocationScope,
    input: WorktreeMcpHandoffInput,
    branch: string,
  ) {
    const alreadyInWorktree = (worktreePath: string) =>
      failure(
        "already_in_worktree",
        `Thread '${scope.thread.threadId}' is already attached to worktree '${worktreePath}'.`,
      );

    const projection = yield* loadThread(scope);
    if (projection.thread.worktreePath !== null) {
      return yield* alreadyInWorktree(projection.thread.worktreePath);
    }
    yield* rejectArchived(scope, projection.thread.archivedAt !== null);

    const project = yield* loadProject(scope, projection.thread.projectId);
    const projectCwd = project.workspaceRoot;

    if (input.path !== undefined) {
      yield* requireAbsolutePath("path", input.path);
    }

    // The repo check runs regardless of whether baseRef was supplied, so a
    // non-repository workspace fails with an actionable error instead of an
    // opaque git failure further down.
    const localStatus = yield* requireRepository(projectCwd);

    // Fail fast with an actionable message when the branch already exists:
    // the git driver deliberately keeps stderr out of its errors, so letting
    // `git worktree add` fail would surface only an opaque failure. The
    // existence check uses the complete local branch list (exact match); the
    // paginated substring search only enriches the message with the checkout
    // location when available.
    const localBranchNames = yield* gitWorkflow
      .listLocalBranchNames(projectCwd)
      .pipe(asOperationFailed("Unable to list branches"));
    if (localBranchNames.includes(branch)) {
      const existingRef = yield* gitWorkflow
        .listRefs({ cwd: projectCwd, query: branch, refKind: "local" })
        .pipe(
          Effect.map((result) =>
            result.refs.find((ref) => ref.name === branch && ref.isRemote !== true),
          ),
          Effect.orElseSucceed(() => undefined),
        );
      const checkoutPath = existingRef?.worktreePath ?? null;
      return yield* failure(
        "invalid_request",
        `Branch '${branch}' already exists${
          checkoutPath === null ? "" : ` and is checked out at '${checkoutPath}'`
        }. Choose a different branch name, delete the existing branch${
          checkoutPath === null ? "" : " and its worktree"
        } first${
          checkoutPath === null ? "" : ", or pass existingWorktreePath to move into that checkout"
        }.`,
      );
    }

    let baseRef = input.baseRef;
    if (baseRef === undefined) {
      if (localStatus.refName === null) {
        return yield* failure(
          "invalid_request",
          "Could not determine the current branch of the project workspace (detached HEAD?). Pass baseRef explicitly.",
        );
      }
      baseRef = localStatus.refName;
    }

    const startFromOrigin = input.startFromOrigin ?? (yield* readDefaultStartFromOrigin);

    let worktreeBaseRef = baseRef;
    if (startFromOrigin) {
      yield* gitWorkflow
        .fetchRemote({ cwd: projectCwd, remoteName: "origin" })
        .pipe(asOperationFailed("Unable to fetch origin"));
      const resolvedRemoteBase = yield* gitWorkflow
        .resolveRemoteTrackingCommit({
          cwd: projectCwd,
          refName: baseRef,
          fallbackRemoteName: "origin",
        })
        .pipe(asOperationFailed(`Unable to resolve the remote-tracking commit of '${baseRef}'`));
      worktreeBaseRef = resolvedRemoteBase.commitSha;
    }

    const ids = yield* handoffIds(scope);

    // uninterruptibleMask: only the potentially slow worktree creation itself
    // stays interruptible (restore). From the moment it succeeds, through the
    // binding, continuation queue, setup script launch, and result
    // construction, there is no interruptible gap: a client cancel can
    // therefore neither orphan the created worktree before the rollback is
    // armed, nor skip setting up a worktree the thread was just bound to
    // (once the binding commits, the scheduled session detach can sever this
    // request's connection and interrupt the fiber).
    return yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const worktree = yield* restore(
          gitWorkflow
            .createWorktree({
              cwd: projectCwd,
              refName: worktreeBaseRef,
              newRefName: branch,
              baseRefName: baseRef,
              path: input.path ?? null,
            })
            .pipe(asOperationFailed("Unable to create the worktree")),
        );
        const worktreePath = worktree.worktree.path;

        // suspend: build the rollback only if cleanup actually runs. Removing
        // the worktree must succeed before deleting its freshly created branch;
        // otherwise the branch may still be checked out there.
        const removeCreatedWorktree = Effect.suspend(() =>
          gitWorkflow.removeWorktree({ cwd: projectCwd, path: worktreePath, force: true }).pipe(
            Effect.andThen(
              Effect.suspend(() =>
                gitWorkflow.deleteLocalBranch({
                  cwd: projectCwd,
                  refName: worktree.worktree.refName,
                  force: true,
                }),
              ),
            ),
          ),
        ).pipe(Effect.ignoreCause({ log: true }));

        const recheckAndBind = Effect.gen(function* () {
          // The projection was read before the potentially slow git work
          // above; a concurrent binding (for example from the UI) could have
          // attached the thread in the meantime. Re-check before committing so
          // the race cannot leave a second, untracked worktree.
          const recheck = yield* loadThread(scope);
          if (recheck.thread.worktreePath !== null) {
            return yield* alreadyInWorktree(recheck.thread.worktreePath);
          }
          // Mirror the up-front archived check: the thread may have been
          // archived during the slow git work, and an archived thread must
          // not be bound to a fresh worktree it can never use.
          if (recheck.thread.archivedAt !== null) {
            return yield* failure(
              "invalid_request",
              `Thread '${scope.thread.threadId}' was archived while the worktree was being created; the handoff was rolled back.`,
            );
          }
          yield* threadManagement
            .dispatch({
              type: "thread.metadata.update",
              commandId: ids.commandId,
              threadId: scope.thread.threadId,
              branch: worktree.worktree.refName,
              worktreePath,
              expectedWorktreePath: null,
            })
            .pipe(
              Effect.catchCause((cause) =>
                // Interrupt-only causes propagate unchanged: whether the
                // dispatch committed is unknown, so neither a typed failure
                // nor a rollback would be correct. Failures and defects
                // (including mixed causes) map to a typed operation_failed.
                Cause.hasInterruptsOnly(cause)
                  ? Effect.failCause(cause as Cause.Cause<never>)
                  : Effect.fail(
                      failure(
                        "operation_failed",
                        `Unable to re-point the thread at the worktree: ${errorMessage(Cause.squash(cause))}`,
                      ),
                    ),
              ),
            );
        }).pipe(
          // onError: the worktree was already created, so any failure between
          // here and the committed binding (recheck read, recheck race,
          // dispatch typed failure or defect) must remove it again so a failed
          // handoff leaves nothing behind on disk. Interrupt-only causes skip
          // the removal: the binding may have committed, and force-deleting a
          // worktree the thread now points at would be worse than leaking one.
          Effect.onError((cause) =>
            Cause.hasInterruptsOnly(cause) ? Effect.void : removeCreatedWorktree,
          ),
        );

        // suspend: build the send effect only when the binding has succeeded,
        // so a failed dispatch never even constructs the continuation call.
        const continuation = yield* recheckAndBind.pipe(
          Effect.andThen(
            Effect.suspend(() =>
              queueContinuation(
                scope,
                projection.thread.projectId,
                ids,
                input.continuationPrompt,
                worktreePath,
              ),
            ),
          ),
        );

        yield* vcsStatusBroadcaster
          .refreshStatus(worktreePath)
          .pipe(Effect.ignoreCause({ log: true }), Effect.forkDetach);

        let setupScript: WorktreeMcpSetupScriptStatus = { status: "skipped" };
        if (input.runSetupScript ?? true) {
          setupScript = yield* setupScriptRunner
            .runForThread({
              threadId: scope.thread.threadId,
              projectId: projection.thread.projectId,
              projectCwd,
              worktreePath,
              project: {
                id: project.id,
                workspaceRoot: project.workspaceRoot,
                scripts: project.scripts,
              },
            })
            .pipe(
              Effect.map((result): WorktreeMcpSetupScriptStatus =>
                result.status === "started"
                  ? {
                      status: "started",
                      scriptName: result.scriptName,
                      terminalId: result.terminalId,
                    }
                  : { status: "no-script" },
              ),
              // catchCause via reportFailed: the thread is already re-pointed at the
              // worktree, so even a defect in the setup runner must not fail the handoff.
              reportFailed(scope, worktreePath, "worktree handoff setup script failed"),
            );
        }

        const result: WorktreeMcpHandoffResult = {
          worktreePath,
          branch: worktree.worktree.refName,
          baseRef,
          startedFromOrigin: startFromOrigin,
          setupScript,
          continuation,
          note: handoffNote(continuation),
        };
        return result;
      }),
    );
  });

  const performHandoff = (scope: McpThreadInvocationScope, input: WorktreeMcpHandoffInput) => {
    if (input.existingWorktreePath !== undefined) {
      return attachExistingWorktree(scope, input, input.existingWorktreePath);
    }
    if (input.branch === undefined) {
      return Effect.fail(
        failure(
          "invalid_request",
          "Pass branch to create a new worktree, or existingWorktreePath to move into an existing one.",
        ),
      );
    }
    return createWorktree(scope, input, input.branch);
  };

  const handoff: WorktreeMcpService["Service"]["handoff"] = Effect.fn("WorktreeMcpService.handoff")(
    function* (callerScope, input) {
      yield* requireCapability(callerScope);
      const scope = yield* requireThreadScope(callerScope);
      // uninterruptibleMask: the guard acquisition and the registration of the
      // releasing finalizer happen with no interruptible gap in between. An
      // interrupt landing between a bare add() and the start of an ensured
      // effect would otherwise leak the guard entry and block every future
      // handoff for this thread until restart.
      return yield* Effect.uninterruptibleMask((restore) =>
        Effect.suspend(() => {
          if (handoffThreadsInFlight.has(scope.thread.threadId)) {
            return Effect.fail(
              failure(
                "handoff_in_progress",
                `A worktree handoff is already in progress for thread '${scope.thread.threadId}'.`,
              ),
            );
          }
          handoffThreadsInFlight.add(scope.thread.threadId);
          return restore(performHandoff(scope, input)).pipe(
            Effect.ensuring(
              Effect.sync(() => handoffThreadsInFlight.delete(scope.thread.threadId)),
            ),
          );
        }),
      );
    },
  );

  const status: WorktreeMcpService["Service"]["status"] = Effect.fn("WorktreeMcpService.status")(
    function* (callerScope) {
      yield* requireCapability(callerScope);
      const scope = yield* requireThreadScope(callerScope);
      const projection = yield* loadThread(scope);
      const project = yield* loadProject(scope, projection.thread.projectId);

      const defaultStartFromOrigin = yield* readDefaultStartFromOrigin;

      const result: WorktreeMcpStatusResult = {
        attached: projection.thread.worktreePath !== null,
        worktreePath: projection.thread.worktreePath,
        branch: projection.thread.branch,
        projectWorkspaceRoot: project.workspaceRoot,
        defaultStartFromOrigin,
      };
      return result;
    },
  );

  return WorktreeMcpService.of({ handoff, status });
});

export const layer: Layer.Layer<
  WorktreeMcpService,
  never,
  | Crypto.Crypto
  | Path.Path
  | ThreadManagementService.ThreadManagementService
  | ProjectService.ProjectService
  | ServerSettings.ServerSettingsService
  | GitWorkflowService.GitWorkflowService
  | ProjectSetupScriptRunner.ProjectSetupScriptRunner
  | VcsStatusBroadcaster.VcsStatusBroadcaster
> = Layer.effect(WorktreeMcpService, make);
