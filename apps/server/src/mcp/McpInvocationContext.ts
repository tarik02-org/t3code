import {
  type AuthSessionId,
  type EnvironmentId,
  McpCapabilityUnavailableError,
  OrchestratorMcpFailure,
  PreviewAutomationUnavailableError,
  type ProviderInstanceId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

const ALL_MCP_CAPABILITIES = [
  "preview",
  "orchestration",
  "worktree",
  "device",
  "pull-requests",
] as const;
export type McpCapability = (typeof ALL_MCP_CAPABILITIES)[number];

/** A provider session T3 Code started for one thread, holding a registry-issued credential. */
export interface McpInvocationScope {
  readonly kind?: "thread";
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly providerSessionId: string;
  readonly providerInstanceId: ProviderInstanceId;
  readonly capabilities: ReadonlySet<McpCapability>;
  readonly issuedAt: number;
}

/**
 * A client outside T3 Code holding an environment access token with
 * `orchestration:operate`, the same grant a paired web client has. It has no
 * calling thread, so tools that act on "this thread" refuse it, and tools that
 * take a thread or project accept any in the environment, as the web client does.
 */
export interface McpExternalInvocationScope {
  readonly kind: "external";
  readonly environmentId: EnvironmentId;
  readonly sessionId: AuthSessionId;
}

export type McpCaller = McpInvocationScope | McpExternalInvocationScope;

export class McpInvocationContext extends Context.Service<McpInvocationContext, McpCaller>()(
  "t3/mcp/McpInvocationContext",
) {}

/**
 * Marks a tool that serves external callers, as `_meta` on its `tools/list`
 * entry. `tools/list` is not filtered per credential, so external clients use
 * this marker to skip tools that only work for a calling thread.
 */
export const EXTERNAL_CALLER_TOOL_META = { "t3code/externalCaller": true } as const;

export const isExternalCaller = (caller: McpCaller): caller is McpExternalInvocationScope =>
  caller.kind === "external";

/** Stable per-credential key for idempotent command ids. */
export const callerRequestKey = (caller: McpCaller): string =>
  isExternalCaller(caller) ? `external:${caller.sessionId}` : caller.providerSessionId;

export const threadCallerRequired = () =>
  new OrchestratorMcpFailure({
    code: "capability_denied",
    message:
      "This tool acts on the calling thread and is only available to agents running inside T3 Code.",
  });

/** The calling thread's scope; external callers fail with `threadCallerRequired`. */
export const requireThreadCaller: Effect.Effect<
  McpInvocationScope,
  OrchestratorMcpFailure,
  McpInvocationContext
> = McpInvocationContext.pipe(
  Effect.filterOrFail(
    (caller): caller is McpInvocationScope => !isExternalCaller(caller),
    threadCallerRequired,
  ),
);

/** The error a missing capability surfaces as; preview keeps its own so the broker can route it. */
export type McpCapabilityError<C extends McpCapability> = C extends "preview"
  ? PreviewAutomationUnavailableError
  : McpCapabilityUnavailableError;

const missingCapability = (
  invocation: McpCaller,
  capability: McpCapability,
): PreviewAutomationUnavailableError | McpCapabilityUnavailableError => {
  const fields = isExternalCaller(invocation)
    ? { environmentId: invocation.environmentId }
    : {
        environmentId: invocation.environmentId,
        threadId: invocation.threadId,
        providerSessionId: invocation.providerSessionId,
        providerInstanceId: invocation.providerInstanceId,
      };
  return capability === "preview"
    ? new PreviewAutomationUnavailableError({ capability, ...fields })
    : new McpCapabilityUnavailableError({ capability, ...fields });
};

/** Capabilities belong to thread credentials; external callers never hold one. */
export const requireMcpCapability = <const C extends McpCapability>(
  capability: C,
): Effect.Effect<McpInvocationScope, McpCapabilityError<C>, McpInvocationContext> =>
  McpInvocationContext.pipe(
    Effect.filterOrFail(
      (invocation): invocation is McpInvocationScope =>
        !isExternalCaller(invocation) && invocation.capabilities.has(capability),
      // The conditional type narrows what the literal argument decided at runtime.
      (invocation) => missingCapability(invocation, capability) as McpCapabilityError<C>,
    ),
    Effect.withSpan("mcp.requireCapability"),
  );
