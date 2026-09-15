import type { ChatAttachment, RuntimeMode } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as P from "effect/Predicate";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { OpenCode, Permission } from "@opencode/client/effect";
import { Service as OpenCodeLocalService } from "@opencode/client/effect/service";
import type { OpenCodeClient } from "@opencode/client/effect";

/**
 * OpenCode 2 runtime: connection management for the machine's background
 * service (or an explicit external server), plus inventory loading and the
 * runtime-mode → session permission rules translation.
 *
 * Unlike the v1 runtime there is no process management here: v2's
 * architecture is one shared background server owning sessions, plugins,
 * permissions, and durable state. `Service.ensure` starts it when missing.
 */
export interface OpenCode2Connection {
  readonly client: OpenCodeClient;
  readonly url: string;
  readonly external: boolean;
  /** Server version from `health.get`, resolved at connect time. */
  readonly version: string;
}

const OPENCODE2_RUNTIME_ERROR_TAG = "OpenCode2RuntimeError";
export class OpenCode2RuntimeError extends Data.TaggedError(OPENCODE2_RUNTIME_ERROR_TAG)<{
  readonly operation: string;
  readonly cause?: unknown;
  readonly detail: string;
}> {
  static readonly is = (u: unknown): u is OpenCode2RuntimeError =>
    P.isTagged(u, OPENCODE2_RUNTIME_ERROR_TAG);
}

const OPENCODE2_CONNECT_TIMEOUT = "10 seconds";

/**
 * v2 session rules for a T3 runtime mode. Session rules are evaluated after
 * agent rules with last-match-wins, server-enforced, so they cannot be
 * overridden by user config, agent definitions, or saved approvals — this is
 * what makes supervised modes trustworthy on a shared background service.
 *
 * `ownMcpServerName` denies the other threads' `t3-code-*` MCP registrations:
 * per-thread-named servers are visible to every session in the directory, and
 * without this rule a restricted session could execute another thread's
 * tools (which run under that thread's credential).
 */
export function buildOpenCode2SessionRules(
  runtimeMode: RuntimeMode,
  ownMcpServerName?: string,
): Permission.Ruleset {
  if (runtimeMode === "full-access") {
    return [];
  }
  const editEffect = runtimeMode === "auto-accept-edits" ? ("allow" as const) : ("ask" as const);
  return [
    // Catch-all ask first; the specific rules below win as later matches.
    { action: "*", resource: "*", effect: "ask" },
    // Other threads' t3-code registrations are visible in this directory;
    // only this thread's own registration may be called. OpenCode checks MCP
    // tool calls as `<sanitized-server>_<tool>`, so the own-server allow
    // pattern carries the tool suffix.
    { action: "t3-code-*", resource: "*", effect: "deny" },
    ...(ownMcpServerName
      ? [{ action: `${ownMcpServerName}_*`, resource: "*", effect: "ask" as const }]
      : []),
    // Read-only discovery stays frictionless.
    { action: "read", resource: "*", effect: "allow" },
    { action: "glob", resource: "*", effect: "allow" },
    { action: "grep", resource: "*", effect: "allow" },
    { action: "question", resource: "*", effect: "allow" },
    { action: "subagent", resource: "*", effect: "allow" },
    // OpenCode's own default keeps .env files behind a prompt.
    { action: "read", resource: "*.env", effect: "ask" },
    { action: "read", resource: "*.env.*", effect: "ask" },
    { action: "read", resource: "*.env.example", effect: "allow" },
    { action: "edit", resource: "*", effect: editEffect },
  ];
}

export interface OpenCode2Inventory {
  readonly models: ReadonlyArray<{
    readonly id: string;
    readonly providerId: string;
    readonly name: string;
    readonly contextWindow: number;
    readonly maxOutputTokens: number;
    readonly status?: string;
  }>;
  readonly agents: ReadonlyArray<{
    readonly id: string;
    readonly name: string;
    readonly description: string;
    readonly mode?: string | null;
  }>;
  readonly skills: ReadonlyArray<{
    readonly id: string;
    readonly name: string;
    readonly description?: string | null;
    readonly location: string;
  }>;
}

export interface OpenCode2RuntimeShape {
  /**
   * Connect to the OpenCode server used by this provider instance: the
   * explicitly configured external `serverUrl`, or the machine's background
   * service (discovered, or started when absent). Connections are plain HTTP
   * against an externally-owned server; nothing is held open by T3.
   */
  readonly connect: (input: {
    readonly serverUrl?: string | null;
    readonly serverPassword?: string;
  }) => Effect.Effect<OpenCode2Connection, OpenCode2RuntimeError>;
  /** Load model/agent/skill inventory from the same connection chat uses. */
  readonly loadInventory: (input: {
    readonly client: OpenCodeClient;
    readonly directory: string;
  }) => Effect.Effect<OpenCode2Inventory, OpenCode2RuntimeError>;
}

export class OpenCode2Runtime extends Context.Service<OpenCode2Runtime, OpenCode2RuntimeShape>()(
  "t3/provider/opencode2Runtime",
) {}

function ensureRuntimeError(
  operation: OpenCode2RuntimeError["operation"],
  detail: string,
  cause: unknown,
): OpenCode2RuntimeError {
  return OpenCode2RuntimeError.is(cause)
    ? cause
    : new OpenCode2RuntimeError({ operation, detail, cause });
}

const basicAuthHeader = (username: string, password: string): string =>
  `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`;

const makeOpenCode2Runtime = Effect.gen(function* () {
  // Acquire the platform services once here so the service's methods have no
  // requirements channel — mirrors the v1 runtime layer providing `NetService`.
  const httpClient = yield* HttpClient.HttpClient;
  // The client package's local-service discovery reads the registration file
  // through this FileSystem when connect() falls through to discover().
  const fileSystem = yield* FileSystem.FileSystem;

  const clientFor = (
    url: string,
    headers: Record<string, string>,
  ): Effect.Effect<OpenCodeClient, never, HttpClient.HttpClient> =>
    OpenCode.make({ baseUrl: url }).pipe(
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.mapRequest(httpClient, (request) =>
          HttpClientRequest.setHeaders(request, headers),
        ),
      ),
    );

  /** `health.get` is the unauthenticated liveness + version probe in v2. */
  const probeConnection = (client: OpenCodeClient) =>
    client.health.get().pipe(
      Effect.timeout(OPENCODE2_CONNECT_TIMEOUT),
      Effect.map((health) => health.version),
      Effect.mapError((cause) =>
        ensureRuntimeError(
          "connect",
          "The OpenCode server did not respond to a health probe.",
          cause,
        ),
      ),
    );

  const connectExternal = (url: string, password: string | undefined) =>
    Effect.gen(function* () {
      const headers = password ? { authorization: basicAuthHeader("opencode", password) } : {};
      const client = yield* clientFor(url, headers);
      const version = yield* probeConnection(client);
      return { client, url, external: true, version } satisfies OpenCode2Connection;
    });

  const connectBackgroundService = Effect.gen(function* () {
    const discovered = yield* OpenCodeLocalService.discover().pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.mapError((cause) =>
        ensureRuntimeError("connect", "Failed to read the local service registration.", cause),
      ),
    );
    if (discovered) {
      const headers = discovered.auth
        ? { authorization: basicAuthHeader(discovered.auth.username, discovered.auth.password) }
        : {};
      const client = yield* clientFor(discovered.url, headers);
      const version = yield* probeConnection(client);
      return {
        client,
        url: discovered.url,
        external: false,
        version,
      } satisfies OpenCode2Connection;
    }
    const endpoint = yield* OpenCodeLocalService.ensure({
      version: (version) => version.startsWith("2."),
    }).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.mapError((cause) =>
        ensureRuntimeError(
          "connect",
          "No OpenCode background service is registered and starting one failed.",
          cause,
        ),
      ),
    );
    const headers = OpenCodeLocalService.headers(endpoint) ?? {};
    const client = yield* clientFor(endpoint.url, headers);
    const version = yield* probeConnection(client);
    return { client, url: endpoint.url, external: false, version } satisfies OpenCode2Connection;
  });

  const connect: OpenCode2RuntimeShape["connect"] = (input) =>
    Effect.gen(function* () {
      const serverUrl = input.serverUrl?.trim();
      if (serverUrl && serverUrl.length > 0) {
        return yield* connectExternal(
          normalizeServerUrl(serverUrl),
          input.serverPassword && input.serverPassword.length > 0
            ? input.serverPassword
            : undefined,
        );
      }
      return yield* connectBackgroundService;
    }).pipe(Effect.provideService(HttpClient.HttpClient, httpClient));

  const loadInventory: OpenCode2RuntimeShape["loadInventory"] = (input) =>
    Effect.gen(function* () {
      const { client, directory } = input;
      const location = { directory };

      const modelPage = yield* client.model
        .list({ location })
        .pipe(
          Effect.mapError((cause) =>
            ensureRuntimeError("inventory", "Failed to load OpenCode models.", cause),
          ),
        );

      const agentPage = yield* client.agent
        .list({ location })
        .pipe(
          Effect.mapError((cause) =>
            ensureRuntimeError("inventory", "Failed to load OpenCode agents.", cause),
          ),
        );

      const skillPage = yield* client.skill
        .list({ location })
        .pipe(
          Effect.mapError((cause) =>
            ensureRuntimeError("inventory", "Failed to load OpenCode skills.", cause),
          ),
        );

      return {
        models: modelPage.data.map((model) => ({
          id: model.id,
          providerId: model.providerID,
          name: model.name,
          contextWindow: model.limit.context,
          maxOutputTokens: model.limit.output,
          status: model.status,
        })),
        agents: agentPage.data.map((agent) => ({
          id: agent.id,
          name: agent.name,
          description: agent.description ?? "",
          mode: agent.mode ?? null,
        })),
        skills: skillPage.data.map((skill) => ({
          id: skill.id,
          name: skill.name,
          description: skill.description ?? null,
          location: skill.location,
        })),
      } satisfies OpenCode2Inventory;
    });

  return OpenCode2Runtime.of({ connect, loadInventory });
});

export const OpenCode2RuntimeLive = Layer.effect(OpenCode2Runtime, makeOpenCode2Runtime).pipe(
  // `HttpClient` (API calls) and `FileSystem` (local service registration file)
  // both come from the Node platform layer.
  Layer.provide(NodeServices.layer),
);

function normalizeServerUrl(url: string): string {
  return NodeURL.parse(url).toString();
}

export type { OpenCodeClient };

/**
 * v2 file attachments. Gating mirrors the v1 adapter's native-file rules
 * (images, text, pdf under 20 MB) so providers without vision or large-file
 * support do not receive parts they cannot process.
 */
export function toOpenCode2FileParts(input: {
  readonly attachments: ReadonlyArray<ChatAttachment> | undefined;
  readonly resolveAttachmentPath: (attachment: ChatAttachment) => string | null;
}): ReadonlyArray<{
  readonly type: "file";
  readonly mime: string;
  readonly name: string;
  readonly url: string;
}> {
  const OPENCODE2_NATIVE_IMAGE_MIMES = new Set([
    "image/png",
    "image/jpeg",
    "image/gif",
    "image/webp",
  ]);
  const OPENCODE2_NATIVE_FILE_PART_MAX_BYTES = 20 * 1024 * 1024;

  const parts: Array<{
    readonly type: "file";
    readonly mime: string;
    readonly name: string;
    readonly url: string;
  }> = [];
  for (const attachment of input.attachments ?? []) {
    if (
      attachment.type === "file" &&
      "source" in attachment &&
      attachment.source?._tag === "pasted-text"
    ) {
      continue;
    }
    const normalized = attachment.mimeType.trim().toLowerCase();
    const isNative =
      attachment.sizeBytes <= OPENCODE2_NATIVE_FILE_PART_MAX_BYTES &&
      (OPENCODE2_NATIVE_IMAGE_MIMES.has(normalized) ||
        normalized.startsWith("text/") ||
        normalized === "application/pdf");
    if (!isNative) continue;
    const attachmentPath = input.resolveAttachmentPath(attachment);
    if (!attachmentPath) continue;
    parts.push({
      type: "file",
      mime: attachment.mimeType,
      name: attachment.name,
      url: NodeURL.pathToFileURL(attachmentPath).href,
    });
  }
  return parts;
}
