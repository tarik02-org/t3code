import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as DeviceService from "../device/DeviceService.ts";
import * as ServerConfig from "../config.ts";
import { expect, it } from "@effect/vitest";
import { NodeHttpServer } from "@effect/platform-node";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSessionId,
  EnvironmentId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpBody, HttpClient, HttpRouter } from "effect/unstable/http";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import * as ProviderRegistry from "../provider/Services/ProviderRegistry.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as VcsStatusBroadcaster from "../vcs/VcsStatusBroadcaster.ts";
import * as McpHttpServer from "./McpHttpServer.ts";
import * as McpSessionRegistry from "./McpSessionRegistry.ts";
import * as PreviewAutomationBroker from "./PreviewAutomationBroker.ts";

const environmentId = EnvironmentId.make("environment-external-mcp");
const operateToken = "operate-token";
const readToken = "read-token";
const sessionCookie = "t3_session=operate-token";

/** Accepts the two test tokens, and only from the Authorization header. */
const EnvironmentAuthStub = Layer.mock(EnvironmentAuth.EnvironmentAuth)({
  authenticateHttpRequest: (request) => {
    if (request.headers.cookie !== undefined) {
      return Effect.die("the MCP middleware must not forward cookies");
    }
    const token = request.headers.authorization?.slice("Bearer ".length);
    const scopes =
      token === operateToken
        ? [AuthOrchestrationReadScope, AuthOrchestrationOperateScope]
        : token === readToken
          ? [AuthOrchestrationReadScope]
          : undefined;
    return scopes === undefined
      ? Effect.fail(new EnvironmentAuth.ServerAuthInvalidCredentialError({}))
      : Effect.succeed({
          sessionId: AuthSessionId.make(`session-${token}`),
          subject: "gateway",
          method: "bearer-access-token" as const,
          scopes,
        });
  },
});

const StubServicesLive = Layer.mergeAll(
  Layer.mock(Orchestrator.OrchestratorV2)({}),
  Layer.mock(ProjectionStore.ProjectionStoreV2)({}),
  Layer.mock(DeviceService.DeviceService)({}),
  Layer.mock(ThreadManagementService.ThreadManagementService)({}),
  Layer.mock(ProviderRegistry.ProviderRegistry)({}),
  Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({}),
  Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
  Layer.mock(ProjectService.ProjectService)({}),
  ServerSettings.layerTest({}),
  Layer.mock(GitWorkflowService.GitWorkflowService)({}),
  Layer.mock(ProjectSetupScriptRunner.ProjectSetupScriptRunner)({}),
  Layer.mock(VcsStatusBroadcaster.VcsStatusBroadcaster)({}),
  Layer.mock(ServerEnvironment.ServerEnvironment)({
    getEnvironmentId: Effect.succeed(environmentId),
  }),
  EnvironmentAuthStub,
);

const ToolsListPayload = Schema.fromJsonString(
  Schema.Struct({
    result: Schema.Struct({
      tools: Schema.Array(
        Schema.Struct({
          name: Schema.String,
          _meta: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
        }),
      ),
    }),
  }),
);
const ToolCallPayload = Schema.fromJsonString(
  Schema.Struct({
    result: Schema.Struct({
      content: Schema.Array(
        Schema.Struct({ type: Schema.String, text: Schema.optional(Schema.String) }),
      ),
    }),
  }),
);
const decodeToolsList = Schema.decodeUnknownEffect(ToolsListPayload);
const decodeToolCall = Schema.decodeUnknownEffect(ToolCallPayload);

const serveMcp = HttpRouter.serve(
  McpHttpServer.layer.pipe(Layer.provide(McpSessionRegistry.layer)),
  { disableListenLog: true, disableLogger: true },
).pipe(Layer.provide(PreviewAutomationBroker.layer), Layer.provide(StubServicesLive), Layer.build);

const post = (headers: Record<string, string>, body: string) =>
  Effect.gen(function* () {
    const httpClient = yield* HttpClient.HttpClient;
    return yield* httpClient.post("/mcp", {
      headers: { accept: "application/json, text/event-stream", ...headers },
      body: HttpBody.text(body, "application/json"),
    });
  });

const initialize = `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"gateway","version":"1.0.0"}}}`;

/** Initializes a session with the token and returns headers for follow-up requests. */
const openSession = (token: string) =>
  Effect.gen(function* () {
    const authorization = `Bearer ${token}`;
    const response = yield* post({ authorization }, initialize);
    expect(response.status).toBe(200);
    const sessionId = response.headers["mcp-session-id"];
    return {
      authorization,
      "mcp-protocol-version": "2025-06-18",
      ...(sessionId ? { "mcp-session-id": sessionId } : {}),
    };
  });

const jsonOf = (text: string) => text.match(/\{.*\}/s)![0];

const testLayer = Layer.mergeAll(
  NodeHttpServer.layerTest,
  ServerConfig.layerTest(process.cwd(), { prefix: "t3-external-mcp-" }).pipe(
    Layer.provide(NodeServices.layer),
  ),
  NodeServices.layer,
);

it.effect("marks the tools an environment access token can use", () =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* serveMcp;
      const headers = yield* openSession(operateToken);
      const response = yield* post(
        headers,
        `{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}`,
      );
      const payload = yield* decodeToolsList(jsonOf(yield* response.text));
      const external = new Set(
        payload.result.tools
          .filter((tool) => tool._meta?.["t3code/externalCaller"] === true)
          .map((tool) => tool.name),
      );
      expect(external).toContain("t3_thread_list");
      expect(external).toContain("t3_thread_send");
      expect(external).toContain("t3_thread_launch");
      expect(external).not.toContain("delegate_task");
      expect(external).not.toContain("t3_worktree_handoff");
      expect(external).not.toContain("preview_status");
    }),
  ).pipe(Effect.provide(testLayer)),
);

it.effect("refuses thread-only tools to an external caller", () =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* serveMcp;
      const headers = yield* openSession(operateToken);
      const response = yield* post(
        headers,
        `{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"orchestrator_capabilities","arguments":{}}}`,
      );
      const payload = yield* decodeToolCall(jsonOf(yield* response.text));
      expect(payload.result.content[0]?.text).toContain("only available to agents running inside");
    }),
  ).pipe(Effect.provide(testLayer)),
);

it.effect("requires orchestration:operate from an environment access token", () =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* serveMcp;
      const response = yield* post({ authorization: `Bearer ${readToken}` }, initialize);
      expect(response.status).toBe(403);
    }),
  ).pipe(Effect.provide(testLayer)),
);

it.effect("does not authenticate external callers from cookies", () =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* serveMcp;
      const cookieOnly = yield* post({ cookie: sessionCookie }, initialize);
      expect(cookieOnly.status).toBe(401);
      // A valid session cookie must not rescue an invalid bearer token either.
      const badBearer = yield* post(
        { authorization: "Bearer unknown", cookie: sessionCookie },
        initialize,
      );
      expect(badBearer.status).toBe(401);
    }),
  ).pipe(Effect.provide(testLayer)),
);
