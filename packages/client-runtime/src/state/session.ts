import type { AuthSessionState, EnvironmentId, ServerConfig } from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import type { HttpClient } from "effect/unstable/http";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

import { EnvironmentRegistry } from "../connection/registry.ts";
import type { PreparedConnection } from "../connection/model.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import { environmentEndpointUrl } from "../environment/endpoint.ts";
import { ManagedRelayDpopSigner } from "../relay/managedRelay.ts";
import { safeErrorLogAttributes } from "../errors/safeLog.ts";
import { executeEnvironmentHttpRequest, makeEnvironmentHttpApiClient } from "../rpc/http.ts";
import type { RpcTransport } from "../rpc/session.ts";
import { buildEnvironmentAuthHeaders, withEnvironmentCredentials } from "./environmentHttpAuth.ts";
import { followStreamInEnvironment } from "./runtime.ts";

export function initialConfigOption<E>(
  initialConfig: Effect.Effect<ServerConfig, E>,
): Effect.Effect<Option.Option<ServerConfig>> {
  return initialConfig.pipe(
    Effect.map(Option.some),
    Effect.catch((error) =>
      Effect.logWarning("Could not load the initial environment configuration.").pipe(
        Effect.annotateLogs({ ...safeErrorLogAttributes(error) }),
        Effect.as(Option.none<ServerConfig>()),
      ),
    ),
  );
}

// Bounded like the snapshot fetches: a wedged environment must not pin the
// permissions check (and with it the settings UI) in a loading state for long.
const DEFAULT_SESSION_STATE_TIMEOUT_MS = 6_000;

/**
 * Read the granted scopes of this client's session on one environment via its
 * `/api/auth/session` endpoint, authenticated with whatever credential the
 * connection was prepared with (cookie, bearer, or DPoP).
 */
export const fetchEnvironmentSessionState = Effect.fn(
  "clientRuntime.state.fetchEnvironmentSessionState",
)(function* (input: {
  readonly prepared: PreparedConnection;
  readonly signer: Option.Option<ManagedRelayDpopSigner["Service"]>;
  readonly timeoutMs?: number;
}) {
  const requestUrl = environmentEndpointUrl(input.prepared.httpBaseUrl, "/api/auth/session");
  const client = yield* makeEnvironmentHttpApiClient(input.prepared.httpBaseUrl);
  const headers = yield* buildEnvironmentAuthHeaders(
    input.prepared.httpAuthorization,
    "GET",
    requestUrl,
    input.signer,
  );
  return yield* executeEnvironmentHttpRequest(
    requestUrl,
    input.timeoutMs ?? DEFAULT_SESSION_STATE_TIMEOUT_MS,
    withEnvironmentCredentials(input.prepared.httpAuthorization, client.auth.session({ headers })),
  );
});

export function createEnvironmentSessionAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | HttpClient.HttpClient | R, E>,
) {
  const initialConfigAtom = Atom.family((environmentId: EnvironmentId) =>
    runtime.atom(
      followStreamInEnvironment(
        environmentId,
        Stream.unwrap(
          EnvironmentSupervisor.pipe(
            Effect.map((supervisor) =>
              SubscriptionRef.changes(supervisor.session).pipe(
                Stream.mapEffect(
                  Option.match({
                    onNone: () => Effect.succeed(Option.none<ServerConfig>()),
                    onSome: (session) => initialConfigOption(session.initialConfig),
                  }),
                ),
              ),
            ),
          ),
        ),
      ),
      { initialValue: Option.none() },
    ),
  );

  // This is only the bootstrap config captured when a transport session is
  // established. Consumers that need current provider/settings state must use
  // createServerEnvironmentAtoms(...).configValueAtom instead.
  const initialConfigValueAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get): ServerConfig | null =>
      Option.getOrNull(
        Option.getOrElse(AsyncResult.value(get(initialConfigAtom(environmentId))), () =>
          Option.none(),
        ),
      ),
    ).pipe(Atom.withLabel(`environment-config-value:${environmentId}`)),
  );

  const preparedConnectionAtom = Atom.family((environmentId: EnvironmentId) =>
    runtime.atom(
      followStreamInEnvironment(
        environmentId,
        Stream.unwrap(
          EnvironmentSupervisor.pipe(
            Effect.map((supervisor) => SubscriptionRef.changes(supervisor.prepared)),
          ),
        ),
      ),
      { initialValue: Option.none<PreparedConnection>() },
    ),
  );

  const preparedConnectionValueAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get) =>
      Option.getOrElse(AsyncResult.value(get(preparedConnectionAtom(environmentId))), () =>
        Option.none<PreparedConnection>(),
      ),
    ).pipe(Atom.withLabel(`environment-prepared-connection:${environmentId}`)),
  );

  const rpcTransportAtom = Atom.family((environmentId: EnvironmentId) =>
    runtime.atom(
      followStreamInEnvironment(
        environmentId,
        Stream.unwrap(
          EnvironmentSupervisor.pipe(
            Effect.map((supervisor) =>
              SubscriptionRef.changes(supervisor.session).pipe(
                Stream.switchMap(
                  Option.match({
                    onNone: () => Stream.succeed<RpcTransport | null>(null),
                    onSome: (session) =>
                      session.transportChanges ??
                      Stream.succeed<RpcTransport>(session.transport ?? "websocket"),
                  }),
                ),
              ),
            ),
          ),
        ),
      ),
      { initialValue: null as RpcTransport | null },
    ),
  );

  const rpcTransportValueAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make(
      (get): RpcTransport | null =>
        Option.getOrNull(AsyncResult.value(get(rpcTransportAtom(environmentId)))) ?? null,
    ).pipe(Atom.withLabel(`environment-rpc-transport:${environmentId}`)),
  );

  const rpcRoundTripTimeAtom = Atom.family((environmentId: EnvironmentId) =>
    runtime.atom(
      followStreamInEnvironment(
        environmentId,
        Stream.unwrap(
          EnvironmentSupervisor.pipe(
            Effect.map((supervisor) =>
              SubscriptionRef.changes(supervisor.session).pipe(
                Stream.switchMap(
                  Option.match({
                    onNone: () => Stream.succeed<number | null>(null),
                    onSome: (session) =>
                      Stream.fromEffect(
                        Effect.timed(session.probe).pipe(
                          Effect.map(([duration]) => Duration.toMillis(duration)),
                          Effect.option,
                          Effect.map(Option.getOrNull),
                        ),
                      ).pipe(Stream.repeat(Schedule.spaced("2 seconds"))),
                  }),
                ),
              ),
            ),
          ),
        ),
      ),
      { initialValue: null as number | null },
    ),
  );

  const rpcRoundTripTimeValueAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make(
      (get): number | null =>
        Option.getOrNull(AsyncResult.value(get(rpcRoundTripTimeAtom(environmentId)))) ?? null,
    ).pipe(Atom.withLabel(`environment-rpc-round-trip-time:${environmentId}`)),
  );

  // Keyed on the prepared connection's identity: a reconnect (new credential,
  // new base URL) swaps the prepared value, which re-runs the fetch, so scope
  // changes from re-pairing are picked up without an explicit refresh.
  const sessionStateAtom = Atom.family((environmentId: EnvironmentId) =>
    runtime
      .atom((get) => {
        const prepared = Option.getOrNull(get(preparedConnectionValueAtom(environmentId)));
        if (prepared === null) {
          return Effect.never;
        }
        return Effect.gen(function* () {
          const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
          return yield* fetchEnvironmentSessionState({ prepared, signer });
        });
      })
      .pipe(
        Atom.swr({ staleTime: 30_000, revalidateOnMount: true }),
        Atom.setIdleTTL(5 * 60_000),
        Atom.withLabel(`environment-session-state:${environmentId}`),
      ),
  );

  const sessionStateValueAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make(
      (get): AuthSessionState | null =>
        Option.getOrNull(AsyncResult.value(get(sessionStateAtom(environmentId)))) ?? null,
    ).pipe(Atom.withLabel(`environment-session-state-value:${environmentId}`)),
  );

  return {
    initialConfigAtom,
    initialConfigValueAtom,
    preparedConnectionAtom,
    preparedConnectionValueAtom,
    rpcTransportAtom,
    rpcTransportValueAtom,
    rpcRoundTripTimeAtom,
    rpcRoundTripTimeValueAtom,
    sessionStateAtom,
    sessionStateValueAtom,
  };
}
