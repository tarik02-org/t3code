import { useAtomValue } from "@effect/atom-react";
import type { RpcTransport } from "@t3tools/client-runtime/rpc";
import { createEnvironmentSessionAtoms } from "@t3tools/client-runtime/state/session";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";

export const environmentSession = createEnvironmentSessionAtoms(connectionAtomRuntime);

const EMPTY_PREPARED_CONNECTION_ATOM = Atom.make(Option.none()).pipe(
  Atom.withLabel("web-prepared-connection:empty"),
);
const EMPTY_RPC_TRANSPORT_ATOM = Atom.make<RpcTransport | null>(null).pipe(
  Atom.withLabel("web-rpc-transport:empty"),
);
const EMPTY_RPC_ROUND_TRIP_TIME_ATOM = Atom.make<number | null>(null).pipe(
  Atom.withLabel("web-rpc-round-trip-time:empty"),
);

export function usePreparedConnection(environmentId: EnvironmentId | null) {
  return useAtomValue(
    environmentId === null
      ? EMPTY_PREPARED_CONNECTION_ATOM
      : environmentSession.preparedConnectionValueAtom(environmentId),
  );
}

export function readPreparedConnection(environmentId: EnvironmentId) {
  return Option.getOrNull(
    appAtomRegistry.get(environmentSession.preparedConnectionValueAtom(environmentId)),
  );
}

export function useEnvironmentRpcTransport(environmentId: EnvironmentId | null) {
  return useAtomValue(
    environmentId === null
      ? EMPTY_RPC_TRANSPORT_ATOM
      : environmentSession.rpcTransportValueAtom(environmentId),
  );
}

export function useEnvironmentRpcRoundTripTime(
  environmentId: EnvironmentId | null,
  enabled: boolean,
) {
  return useAtomValue(
    environmentId === null || !enabled
      ? EMPTY_RPC_ROUND_TRIP_TIME_ATOM
      : environmentSession.rpcRoundTripTimeValueAtom(environmentId),
  );
}

/**
 * This client's authenticated session on one environment, as reported by that
 * environment's `/api/auth/session` endpoint. `data` stays populated across
 * SWR revalidations; `isPending` is only meaningful before the first resolve.
 */
export function useEnvironmentSessionState(environmentId: EnvironmentId) {
  const result = useAtomValue(environmentSession.sessionStateAtom(environmentId));
  return {
    data: Option.getOrNull(AsyncResult.value(result)),
    hasError: result._tag === "Failure",
    isPending: result.waiting,
  };
}
