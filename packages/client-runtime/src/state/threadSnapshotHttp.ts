import type {
  OrchestrationV2ThreadDetailSnapshot,
  OrchestrationV2VisibleTurnItemPage,
  ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { HttpClient } from "effect/unstable/http";

import type { PreparedConnection } from "../connection/model.ts";
import { environmentEndpointUrl } from "../environment/endpoint.ts";
import { ManagedRelayDpopSigner } from "../relay/managedRelay.ts";
import {
  executeEnvironmentHttpRequest,
  makeEnvironmentHttpApiClient,
  type RemoteEnvironmentRequestError,
} from "../rpc/http.ts";
import { buildEnvironmentAuthHeaders, withEnvironmentCredentials } from "./environmentHttpAuth.ts";

// Includes response decoding and validation. Falling back too quickly repeats
// the same snapshot through the socket while the HTTP request is still useful.
const DEFAULT_THREAD_SNAPSHOT_TIMEOUT_MS = 30_000;
export const ORCHESTRATION_V2_TURN_ITEM_PAGE_SIZE = 200;

/**
 * Load a thread's detail snapshot over HTTP instead of embedding it in the
 * WebSocket subscription's first frame. The response is gzip-compressible by
 * the transport and keeps the (potentially multi-KB) snapshot off the socket.
 */
export const fetchEnvironmentThreadSnapshot = Effect.fn(
  "clientRuntime.state.fetchEnvironmentThreadSnapshot",
)(function* (input: {
  readonly prepared: PreparedConnection;
  readonly threadId: ThreadId;
  readonly signer: Option.Option<ManagedRelayDpopSigner["Service"]>;
  readonly timeoutMs?: number;
}) {
  const requestUrl = new URL(
    environmentEndpointUrl(
      input.prepared.httpBaseUrl,
      `/api/orchestration/threads/${input.threadId}`,
    ),
  );
  requestUrl.searchParams.set("turnItemLimit", String(ORCHESTRATION_V2_TURN_ITEM_PAGE_SIZE));
  const client = yield* makeEnvironmentHttpApiClient(input.prepared.httpBaseUrl);
  const headers = yield* buildEnvironmentAuthHeaders(
    input.prepared.httpAuthorization,
    "GET",
    requestUrl.toString(),
    input.signer,
  );
  return yield* executeEnvironmentHttpRequest(
    requestUrl.toString(),
    input.timeoutMs ?? DEFAULT_THREAD_SNAPSHOT_TIMEOUT_MS,
    withEnvironmentCredentials(
      input.prepared.httpAuthorization,
      client.orchestration.threadSnapshot({
        params: { threadId: input.threadId },
        query: { turnItemLimit: ORCHESTRATION_V2_TURN_ITEM_PAGE_SIZE },
        headers,
      }),
    ),
  );
});

export const fetchEnvironmentThreadItems = Effect.fn(
  "clientRuntime.state.fetchEnvironmentThreadItems",
)(function* (input: {
  readonly prepared: PreparedConnection;
  readonly threadId: ThreadId;
  readonly beforePosition: number;
  readonly signer: Option.Option<ManagedRelayDpopSigner["Service"]>;
  readonly timeoutMs?: number;
}) {
  const requestUrl = new URL(
    environmentEndpointUrl(
      input.prepared.httpBaseUrl,
      `/api/orchestration/threads/${input.threadId}/items`,
    ),
  );
  requestUrl.searchParams.set("beforePosition", String(input.beforePosition));
  requestUrl.searchParams.set("limit", String(ORCHESTRATION_V2_TURN_ITEM_PAGE_SIZE));
  const client = yield* makeEnvironmentHttpApiClient(input.prepared.httpBaseUrl);
  const headers = yield* buildEnvironmentAuthHeaders(
    input.prepared.httpAuthorization,
    "GET",
    requestUrl.toString(),
    input.signer,
  );
  return yield* executeEnvironmentHttpRequest(
    requestUrl.toString(),
    input.timeoutMs ?? DEFAULT_THREAD_SNAPSHOT_TIMEOUT_MS,
    withEnvironmentCredentials(
      input.prepared.httpAuthorization,
      client.orchestration.threadItems({
        params: { threadId: input.threadId },
        query: {
          beforePosition: input.beforePosition,
          limit: ORCHESTRATION_V2_TURN_ITEM_PAGE_SIZE,
        },
        headers,
      }),
    ),
  );
});

export type FetchEnvironmentThreadSnapshotError = RemoteEnvironmentRequestError;

/**
 * Loads a thread's detail snapshot over HTTP, returning `Option.none()` when it
 * cannot be loaded (so the caller falls back to the socket-embedded snapshot).
 * Decouples the thread state machine from the underlying HTTP + DPoP details and
 * keeps them out of test contexts.
 */
export class ThreadSnapshotLoader extends Context.Service<
  ThreadSnapshotLoader,
  {
    readonly load: (
      prepared: PreparedConnection,
      threadId: ThreadId,
    ) => Effect.Effect<Option.Option<OrchestrationV2ThreadDetailSnapshot>>;
    readonly loadPreviousItems?: (
      prepared: PreparedConnection,
      threadId: ThreadId,
      beforePosition: number,
    ) => Effect.Effect<Option.Option<OrchestrationV2VisibleTurnItemPage>>;
  }
>()("@t3tools/client-runtime/state/threadSnapshotHttp/ThreadSnapshotLoader") {}

export const threadSnapshotLoaderLayer: Layer.Layer<
  ThreadSnapshotLoader,
  never,
  HttpClient.HttpClient
> = Layer.effect(
  ThreadSnapshotLoader,
  Effect.gen(function* () {
    const httpClient = yield* HttpClient.HttpClient;
    // Resolve the DPoP signer optionally: it is only needed for relay/DPoP
    // connections, so the loader must not hard-require it (bearer/primary
    // connections work without one).
    const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
    return ThreadSnapshotLoader.of({
      load: (prepared: PreparedConnection, threadId: ThreadId) =>
        fetchEnvironmentThreadSnapshot({ prepared, threadId, signer }).pipe(
          Effect.map(Option.some<OrchestrationV2ThreadDetailSnapshot>),
          Effect.provideService(HttpClient.HttpClient, httpClient),
          // A genuinely missing thread (404) is expected — the socket
          // subscription is the source of truth for thread existence and will
          // surface the deletion — so don't treat it as an error worth warning
          // about; just defer to the socket path.
          Effect.catchTags({
            EnvironmentResourceNotFoundError: () =>
              Effect.logDebug(
                "Thread snapshot not found over HTTP; deferring to the socket subscription.",
              ).pipe(
                Effect.annotateLogs({ threadId }),
                Effect.as(Option.none<OrchestrationV2ThreadDetailSnapshot>()),
              ),
          }),
          Effect.catchCause((cause) =>
            Effect.logWarning(
              "Could not load the thread snapshot over HTTP; using the socket snapshot instead.",
            ).pipe(
              Effect.annotateLogs({ threadId, cause: Cause.pretty(cause) }),
              Effect.as(Option.none<OrchestrationV2ThreadDetailSnapshot>()),
            ),
          ),
        ),
      loadPreviousItems: (
        prepared: PreparedConnection,
        threadId: ThreadId,
        beforePosition: number,
      ) =>
        fetchEnvironmentThreadItems({
          prepared,
          threadId,
          beforePosition,
          signer,
        }).pipe(
          Effect.map(Option.some<OrchestrationV2VisibleTurnItemPage>),
          Effect.provideService(HttpClient.HttpClient, httpClient),
          Effect.catchCause((cause) =>
            Effect.logWarning("Could not load previous thread items over HTTP.").pipe(
              Effect.annotateLogs({ threadId, cause: Cause.pretty(cause) }),
              Effect.as(Option.none<OrchestrationV2VisibleTurnItemPage>()),
            ),
          ),
        ),
    });
  }),
);
