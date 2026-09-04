import * as Crypto from "effect/Crypto";
import { Atom } from "effect/unstable/reactivity";
import { type ThreadGoalRequest, WS_METHODS } from "@t3tools/contracts";

import {
  createAtomCommandScheduler,
  createEnvironmentCommand,
  createEnvironmentRpcCommand,
} from "./runtime.ts";
import {
  type ArchiveThreadInput,
  type CreateThreadInput,
  type DeleteThreadInput,
  type InterruptThreadTurnInput,
  type RespondToThreadApprovalInput,
  type RespondToThreadUserInputInput,
  type RequestThreadGoalInput,
  type RevertThreadCheckpointInput,
  type SetThreadInteractionModeInput,
  type SetThreadRuntimeModeInput,
  type PinThreadInput,
  type ReorderPinnedThreadInput,
  type SettleThreadInput,
  type SnoozeThreadInput,
  type StartThreadTurnInput,
  type StopThreadSessionInput,
  type UnarchiveThreadInput,
  type UnpinThreadInput,
  type UnsettleThreadInput,
  type UnsnoozeThreadInput,
  type UpdateThreadMetadataInput,
  archiveThread,
  createThread,
  deleteThread,
  interruptThreadTurn,
  respondToThreadApproval,
  respondToThreadUserInput,
  requestThreadGoal,
  revertThreadCheckpoint,
  setThreadInteractionMode,
  setThreadRuntimeMode,
  pinThread,
  reorderPinnedThread,
  settleThread,
  snoozeThread,
  startThreadTurn,
  stopThreadSession,
  unarchiveThread,
  unpinThread,
  unsettleThread,
  unsnoozeThread,
  updateThreadMetadata,
} from "../operations/commands.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";

export type {
  ArchiveThreadInput,
  CreateThreadInput,
  DeleteThreadInput,
  InterruptThreadTurnInput,
  RespondToThreadApprovalInput,
  RespondToThreadUserInputInput,
  RequestThreadGoalInput,
  RevertThreadCheckpointInput,
  SetThreadInteractionModeInput,
  SetThreadRuntimeModeInput,
  PinThreadInput,
  ReorderPinnedThreadInput,
  SettleThreadInput,
  SnoozeThreadInput,
  StartThreadTurnInput,
  StopThreadSessionInput,
  UnarchiveThreadInput,
  UnpinThreadInput,
  UnsettleThreadInput,
  UnsnoozeThreadInput,
  UpdateThreadMetadataInput,
} from "../operations/commands.ts";

export type CodexGoalCommand =
  | ThreadGoalRequest
  | { readonly kind: "invalid"; readonly message: string };

const GOAL_OBJECTIVE_MAX_LENGTH = 4_000;
const GOAL_COMMAND_USAGE =
  "Usage: /goal [status | create <objective> | steer <objective> | pause | resume | clear | reset]";

function invalidGoalObjectiveLength(): CodexGoalCommand {
  return {
    kind: "invalid",
    message: `Goal objective must be ${GOAL_OBJECTIVE_MAX_LENGTH.toLocaleString()} characters or fewer.`,
  };
}

export function parseCodexGoalCommand(value: string): CodexGoalCommand | null {
  const match = /^\/goal(?:\s+([\s\S]*))?$/i.exec(value.trim());
  if (match === null) return null;

  const argument = match[1]?.trim() ?? "";
  if (argument.length === 0 || argument.toLowerCase() === "status") return { kind: "status" };

  const [rawAction = "", ...rest] = argument.split(/\s+/);
  const action = rawAction.toLowerCase();
  const objective = rest.join(" ").trim();
  if (action === "create" || action === "steer") {
    if (objective.length === 0) return { kind: "invalid", message: GOAL_COMMAND_USAGE };
    return objective.length > GOAL_OBJECTIVE_MAX_LENGTH
      ? invalidGoalObjectiveLength()
      : { kind: "set", objective };
  }
  if (action === "edit") {
    if (objective.length === 0) {
      return {
        kind: "invalid",
        message: "T3 does not open Codex's Goal editor. Use /goal steer <objective>.",
      };
    }
    return objective.length > GOAL_OBJECTIVE_MAX_LENGTH
      ? invalidGoalObjectiveLength()
      : { kind: "set", objective };
  }
  if (action === "pause" || action === "resume") {
    return objective.length === 0
      ? { kind: "control", action }
      : { kind: "invalid", message: GOAL_COMMAND_USAGE };
  }
  if (action === "clear" || action === "reset") {
    return objective.length === 0
      ? { kind: "control", action: "clear" }
      : { kind: "invalid", message: GOAL_COMMAND_USAGE };
  }
  if (action === "status") return { kind: "invalid", message: GOAL_COMMAND_USAGE };

  return argument.length > GOAL_OBJECTIVE_MAX_LENGTH
    ? invalidGoalObjectiveLength()
    : { kind: "set", objective: argument };
}

export function createThreadEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | Crypto.Crypto | R, E>,
) {
  const scheduler = createAtomCommandScheduler();
  const concurrency = {
    mode: "serial" as const,
    key: ({ environmentId, input }: { environmentId: string; input: { threadId: string } }) =>
      JSON.stringify([environmentId, input.threadId]),
  };
  return {
    create: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:create",
      execute: (input: CreateThreadInput) => createThread(input),
      scheduler,
      concurrency,
    }),
    delete: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:delete",
      execute: (input: DeleteThreadInput) => deleteThread(input),
      scheduler,
      concurrency,
    }),
    archive: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:archive",
      execute: (input: ArchiveThreadInput) => archiveThread(input),
      scheduler,
      concurrency,
    }),
    unarchive: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:unarchive",
      execute: (input: UnarchiveThreadInput) => unarchiveThread(input),
      scheduler,
      concurrency,
    }),
    settle: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:settle",
      execute: (input: SettleThreadInput) => settleThread(input),
      scheduler,
      concurrency,
    }),
    unsettle: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:unsettle",
      execute: (input: UnsettleThreadInput) => unsettleThread(input),
      scheduler,
      concurrency,
    }),
    snooze: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:snooze",
      execute: (input: SnoozeThreadInput) => snoozeThread(input),
      scheduler,
      concurrency,
    }),
    unsnooze: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:unsnooze",
      execute: (input: UnsnoozeThreadInput) => unsnoozeThread(input),
      scheduler,
      concurrency,
    }),
    pin: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:pin",
      execute: (input: PinThreadInput) => pinThread(input),
      scheduler,
      concurrency,
    }),
    unpin: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:unpin",
      execute: (input: UnpinThreadInput) => unpinThread(input),
      scheduler,
      concurrency,
    }),
    reorderPin: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:reorder-pin",
      execute: (input: ReorderPinnedThreadInput) => reorderPinnedThread(input),
      scheduler,
      concurrency,
    }),
    updateMetadata: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:update-metadata",
      execute: (input: UpdateThreadMetadataInput) => updateThreadMetadata(input),
      scheduler,
      concurrency,
    }),
    setRuntimeMode: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:set-runtime-mode",
      execute: (input: SetThreadRuntimeModeInput) => setThreadRuntimeMode(input),
      scheduler,
      concurrency,
    }),
    setInteractionMode: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:set-interaction-mode",
      execute: (input: SetThreadInteractionModeInput) => setThreadInteractionMode(input),
      scheduler,
      concurrency,
    }),
    startTurn: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:start-turn",
      execute: (input: StartThreadTurnInput) => startThreadTurn(input),
      scheduler,
      concurrency,
    }),
    interruptTurn: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:interrupt-turn",
      execute: (input: InterruptThreadTurnInput) => interruptThreadTurn(input),
      scheduler,
      concurrency,
    }),
    respondToApproval: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:respond-to-approval",
      execute: (input: RespondToThreadApprovalInput) => respondToThreadApproval(input),
      scheduler,
      concurrency,
    }),
    respondToUserInput: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:respond-to-user-input",
      execute: (input: RespondToThreadUserInputInput) => respondToThreadUserInput(input),
      scheduler,
      concurrency,
    }),
    requestGoal: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:request-goal",
      execute: (input: RequestThreadGoalInput) => requestThreadGoal(input),
      scheduler,
      concurrency,
    }),
    revertCheckpoint: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:revert-checkpoint",
      execute: (input: RevertThreadCheckpointInput) => revertThreadCheckpoint(input),
      scheduler,
      concurrency,
    }),
    stopSession: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:stop-session",
      execute: (input: StopThreadSessionInput) => stopThreadSession(input),
      scheduler,
      concurrency,
    }),
    uploadFeedback: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:commands:thread:upload-feedback",
      tag: WS_METHODS.providerUploadFeedback,
      scheduler,
      concurrency,
    }),
  };
}
