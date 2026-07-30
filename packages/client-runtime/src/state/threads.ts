import {
  ORCHESTRATION_V2_WS_METHODS,
  type EnvironmentId as EnvironmentIdType,
  type OrchestrationV2ThreadDetailSnapshot,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadStreamItem,
  type OrchestrationV2VisibleTurnItemPageInfo,
  type ThreadId as ThreadIdType,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { Atom } from "effect/unstable/reactivity";

import { EnvironmentRegistry } from "../connection/registry.ts";
import { connectionProjectionPhase } from "../connection/model.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import * as ConnectionWakeups from "../connection/wakeups.ts";
import { EnvironmentCacheStore } from "../platform/persistence.ts";
import { subscribeDynamic } from "../rpc/client.ts";
import {
  ORCHESTRATION_V2_TURN_ITEM_PAGE_SIZE,
  ThreadSnapshotLoader,
} from "./threadSnapshotHttp.ts";
import { parseThreadKey, threadKey } from "./entities.ts";
import { applyOrchestrationV2ProjectionEvent } from "./orchestrationV2Projection.ts";
import { THREAD_STATE_IDLE_TTL_MS } from "./threadRetention.ts";
import {
  createAtomCommandScheduler,
  createEnvironmentCommand,
  followStreamInEnvironment,
} from "./runtime.ts";
import {
  EMPTY_ENVIRONMENT_THREAD_STATE,
  type EnvironmentThreadState,
  type EnvironmentThreadStatus,
} from "./threadState.ts";

function statusWithoutLiveData(
  data: Option.Option<OrchestrationV2ThreadProjection>,
): EnvironmentThreadStatus {
  return Option.isSome(data) ? "cached" : "empty";
}

function formatThreadError(cause: Cause.Cause<unknown>): string {
  const error = Cause.squash(cause);
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : "Could not synchronize the thread.";
}

function shouldPersistThread(thread: OrchestrationV2ThreadProjection): boolean {
  return !thread.runs.some(
    (run) => run.status === "preparing" || run.status === "starting" || run.status === "running",
  );
}

export const makeEnvironmentThreadState = Effect.fn("EnvironmentThreadState.make")(function* (
  threadId: ThreadIdType,
) {
  const supervisor = yield* EnvironmentSupervisor;
  const cache = yield* EnvironmentCacheStore;
  const snapshotLoader = yield* ThreadSnapshotLoader;
  const wakeups = yield* Effect.serviceOption(ConnectionWakeups.ConnectionWakeups);
  const environmentId = supervisor.target.environmentId;
  const cached = yield* cache.loadThread(environmentId, threadId).pipe(
    Effect.catch((error) =>
      Effect.logWarning("Could not load cached thread.").pipe(
        Effect.annotateLogs({
          environmentId,
          threadId,
          error: error.message,
        }),
        Effect.as(Option.none<OrchestrationV2ThreadDetailSnapshot>()),
      ),
    ),
  );
  const cachedThread = Option.map(cached, (snapshot) => snapshot.projection);
  const state = yield* SubscriptionRef.make<EnvironmentThreadState>({
    data: cachedThread,
    status: statusWithoutLiveData(cachedThread),
    error: Option.none(),
    visibleTurnItemHistory: {
      page: Option.match(cached, {
        onNone: () => null,
        onSome: (snapshot) => snapshot.visibleTurnItemPage ?? null,
      }),
      loadingPrevious: false,
    },
  });
  // Seed the resume cursor from the cached snapshot so a warm cache can catch up
  // via `afterSequence` instead of re-downloading the full thread body.
  const lastSequence = yield* SubscriptionRef.make(
    Option.match(cached, { onNone: () => 0, onSome: (snapshot) => snapshot.snapshotSequence }),
  );
  const awaitingCompletion = yield* Ref.make(false);
  const persistence = yield* Queue.sliding<OrchestrationV2ThreadDetailSnapshot>(1);
  const preparedConnection = SubscriptionRef.get(supervisor.prepared).pipe(
    Effect.flatMap(
      Option.match({
        onSome: Effect.succeed,
        onNone: () =>
          SubscriptionRef.changes(supervisor.prepared).pipe(
            Stream.filter(Option.isSome),
            Stream.map((value) => value.value),
            Stream.runHead,
            Effect.map(Option.getOrThrow),
          ),
      }),
    ),
  );

  const persist = Effect.fn("EnvironmentThreadState.persist")(function* (
    snapshot: OrchestrationV2ThreadDetailSnapshot,
  ) {
    yield* cache.saveThread(environmentId, snapshot).pipe(
      Effect.catch((error) =>
        Effect.logWarning("Could not persist the thread cache.").pipe(
          Effect.annotateLogs({
            environmentId,
            threadId,
            error: error.message,
          }),
        ),
      ),
    );
  });

  yield* Stream.fromQueue(persistence).pipe(
    Stream.debounce("500 millis"),
    Stream.runForEach(persist),
    Effect.forkScoped,
  );

  const setSynchronizing = SubscriptionRef.update(state, (current) =>
    current.status === "deleted"
      ? current
      : {
          ...current,
          status: "synchronizing" as const,
          error: Option.none(),
        },
  );
  const setReady = SubscriptionRef.update(state, (current) =>
    current.status === "live" || current.status === "deleted"
      ? current
      : {
          ...current,
          status: "synchronizing" as const,
          error: Option.none(),
        },
  );
  const setDisconnected = Effect.gen(function* () {
    yield* Ref.set(awaitingCompletion, false);
    yield* SubscriptionRef.update(state, (current) => ({
      ...current,
      status: current.status === "deleted" ? current.status : statusWithoutLiveData(current.data),
    }));
  });
  const setStreamError = (cause: Cause.Cause<unknown>) =>
    Ref.set(awaitingCompletion, false).pipe(
      Effect.andThen(
        SubscriptionRef.update(state, (current) => ({
          ...current,
          status:
            current.status === "deleted" ? current.status : statusWithoutLiveData(current.data),
          error: Option.some(formatThreadError(cause)),
        })),
      ),
    );

  const setThread = Effect.fn("EnvironmentThreadState.setThread")(function* (
    thread: OrchestrationV2ThreadProjection,
    visibleTurnItemPage?: OrchestrationV2VisibleTurnItemPageInfo,
  ) {
    const waiting = yield* Ref.get(awaitingCompletion);
    yield* SubscriptionRef.update(state, (current) => ({
      data: Option.some(thread),
      status: waiting ? ("synchronizing" as const) : ("live" as const),
      error: Option.none(),
      visibleTurnItemHistory: {
        page: visibleTurnItemPage ?? current.visibleTurnItemHistory?.page ?? null,
        loadingPrevious: current.visibleTurnItemHistory?.loadingPrevious ?? false,
      },
    }));
    // Active projections can update many times per second and retain large tool
    // payloads. Persist once the run settles so cache encoding stays off the
    // streaming path.
    if (shouldPersistThread(thread)) {
      const snapshotSequence = yield* SubscriptionRef.get(lastSequence);
      const current = yield* SubscriptionRef.get(state);
      yield* Queue.offer(persistence, {
        snapshotSequence,
        projection: thread,
        ...(current.visibleTurnItemHistory?.page === null ||
        current.visibleTurnItemHistory?.page === undefined
          ? {}
          : { visibleTurnItemPage: current.visibleTurnItemHistory.page }),
      });
    }
  });

  const loadPreviousItems = Effect.gen(function* () {
    const current = yield* SubscriptionRef.get(state);
    const page = current.visibleTurnItemHistory?.page;
    if (
      Option.isNone(current.data) ||
      page === null ||
      page === undefined ||
      !page.hasMoreBefore ||
      current.visibleTurnItemHistory?.loadingPrevious === true
    ) {
      return false;
    }
    yield* SubscriptionRef.set(state, {
      ...current,
      visibleTurnItemHistory: {
        page,
        loadingPrevious: true,
      },
    });
    return yield* Effect.gen(function* () {
      const prepared = yield* preparedConnection;
      const loaded =
        snapshotLoader.loadPreviousItems === undefined
          ? Option.none()
          : yield* snapshotLoader.loadPreviousItems(prepared, threadId, page.startPosition);
      if (Option.isNone(loaded)) {
        return false;
      }
      const latest = yield* SubscriptionRef.get(state);
      if (Option.isNone(latest.data)) {
        return false;
      }
      const visibleById = new Map(
        [...loaded.value.visibleTurnItems, ...latest.data.value.visibleTurnItems].map((row) => [
          row.sourceItemId,
          row,
        ]),
      );
      const turnItemsById = new Map(
        [
          ...latest.data.value.turnItems,
          ...loaded.value.visibleTurnItems.flatMap((row) =>
            row.visibility === "local" && row.item.threadId === threadId ? [row.item] : [],
          ),
        ].map((item) => [item.id, item]),
      );
      const projection = {
        ...latest.data.value,
        turnItems: [...turnItemsById.values()].toSorted(
          (left, right) =>
            left.ordinal - right.ordinal || String(left.id).localeCompare(String(right.id)),
        ),
        visibleTurnItems: [...visibleById.values()].toSorted(
          (left, right) => left.position - right.position,
        ),
      };
      yield* SubscriptionRef.set(state, {
        ...latest,
        data: Option.some(projection),
        visibleTurnItemHistory: {
          page: {
            startPosition: loaded.value.page.startPosition,
            endPosition: Math.max(page.endPosition, loaded.value.page.endPosition),
            totalItems: Math.max(page.totalItems, loaded.value.page.totalItems),
            hasMoreBefore: loaded.value.page.hasMoreBefore,
            hasMoreAfter: page.hasMoreAfter,
          },
          loadingPrevious: false,
        },
      });
      return true;
    }).pipe(
      Effect.ensuring(
        SubscriptionRef.update(state, (latest) => ({
          ...latest,
          visibleTurnItemHistory: {
            page: latest.visibleTurnItemHistory?.page ?? null,
            loadingPrevious: false,
          },
        })),
      ),
    );
  });

  const setDeleted = Effect.fn("EnvironmentThreadState.setDeleted")(function* () {
    yield* Ref.set(awaitingCompletion, false);
    yield* SubscriptionRef.set(state, {
      data: Option.none(),
      status: "deleted",
      error: Option.none(),
      visibleTurnItemHistory: {
        page: null,
        loadingPrevious: false,
      },
    });
    yield* cache.removeThread(environmentId, threadId).pipe(
      Effect.catch((error) =>
        Effect.logWarning("Could not remove the cached thread.").pipe(
          Effect.annotateLogs({
            environmentId,
            threadId,
            error: error.message,
          }),
        ),
      ),
    );
  });

  const applyItem = Effect.fn("EnvironmentThreadState.applyItem")(function* (
    item: OrchestrationV2ThreadStreamItem,
  ) {
    if (item.kind === "synchronized") {
      yield* Ref.set(awaitingCompletion, false);
      yield* SubscriptionRef.update(state, (current) =>
        Option.isSome(current.data) && current.status !== "deleted"
          ? { ...current, status: "live" as const, error: Option.none() }
          : current,
      );
      return;
    }

    if (item.kind === "snapshot") {
      yield* SubscriptionRef.set(lastSequence, item.snapshotSequence);
      yield* setThread(item.projection, item.visibleTurnItemPage);
      return;
    }

    const sequence = yield* SubscriptionRef.get(lastSequence);
    if (item.sequence <= sequence) {
      return;
    }
    yield* SubscriptionRef.set(lastSequence, item.sequence);

    const current = yield* SubscriptionRef.get(state);
    if (Option.isNone(current.data)) {
      if (item.event.type === "thread.deleted") {
        yield* setDeleted();
      }
      return;
    }
    if (item.event.type === "thread.deleted") {
      yield* setDeleted();
      return;
    }
    const next = applyOrchestrationV2ProjectionEvent(current.data.value, item.event);
    if (next !== null) {
      yield* setThread(next);
      const visibleDelta =
        next.visibleTurnItems.length - current.data.value.visibleTurnItems.length;
      if (visibleDelta !== 0 && current.visibleTurnItemHistory?.page !== null) {
        yield* SubscriptionRef.update(state, (latest) => {
          const page = latest.visibleTurnItemHistory?.page;
          if (page === null || page === undefined) {
            return latest;
          }
          return {
            ...latest,
            visibleTurnItemHistory: {
              page: {
                ...page,
                endPosition: Math.max(page.startPosition, page.endPosition + visibleDelta),
                totalItems: Math.max(0, page.totalItems + visibleDelta),
              },
              loadingPrevious: latest.visibleTurnItemHistory?.loadingPrevious ?? false,
            },
          };
        });
      }
    }
  });

  yield* SubscriptionRef.changes(supervisor.state).pipe(
    Stream.runForEach((connectionState) => {
      switch (connectionProjectionPhase(connectionState)) {
        case "synchronizing":
          return setSynchronizing;
        case "disconnected":
          return setDisconnected;
        case "ready":
          return setReady;
      }
    }),
    Effect.forkScoped,
  );

  const foregroundResubscriptions = Option.match(wakeups, {
    onNone: () => Stream.never,
    onSome: (service) =>
      service.changes.pipe(Stream.filter(ConnectionWakeups.shouldResubscribeAfterWakeup)),
  });

  yield* setSynchronizing;
  yield* Effect.forkScoped(
    subscribeDynamic(
      ORCHESTRATION_V2_WS_METHODS.subscribeThread,
      Effect.fn("EnvironmentThreadState.makeSubscribeInput")(function* (session) {
        const supportsCompletionMarker = yield* session.initialConfig.pipe(
          Effect.map((config) => config.threadResumeCompletionMarker === true),
          Effect.orElseSucceed(() => false),
        );
        yield* Ref.set(awaitingCompletion, supportsCompletionMarker);
        yield* setSynchronizing;

        let current = yield* SubscriptionRef.get(state);
        if (Option.isNone(current.data) && current.status !== "deleted") {
          const prepared = yield* SubscriptionRef.get(supervisor.prepared).pipe(
            Effect.flatMap(
              Option.match({
                onSome: Effect.succeed,
                onNone: () =>
                  SubscriptionRef.changes(supervisor.prepared).pipe(
                    Stream.filter(Option.isSome),
                    Stream.map((value) => value.value),
                    Stream.runHead,
                    Effect.map(Option.getOrThrow),
                  ),
              }),
            ),
          );
          const httpSnapshot = yield* snapshotLoader.load(prepared, threadId);
          if (Option.isSome(httpSnapshot)) {
            yield* applyItem({
              kind: "snapshot",
              snapshotSequence: httpSnapshot.value.snapshotSequence,
              projection: httpSnapshot.value.projection,
              ...(httpSnapshot.value.visibleTurnItemPage === undefined
                ? {}
                : { visibleTurnItemPage: httpSnapshot.value.visibleTurnItemPage }),
            });
            current = yield* SubscriptionRef.get(state);
          }
        }

        const sequence = yield* SubscriptionRef.get(lastSequence);
        const canResume = Option.isSome(current.data);
        if (!supportsCompletionMarker && canResume) {
          yield* SubscriptionRef.update(state, (value) => ({
            ...value,
            status: value.status === "deleted" ? value.status : ("live" as const),
            error: Option.none(),
          }));
        }

        return {
          threadId,
          turnItemLimit: ORCHESTRATION_V2_TURN_ITEM_PAGE_SIZE,
          ...(canResume ? { afterSequence: sequence } : {}),
          ...(supportsCompletionMarker ? { requestCompletionMarker: true as const } : {}),
        };
      }),
      {
        onExpectedFailure: setStreamError,
        retryExpectedFailureAfter: "250 millis",
        resubscribe: foregroundResubscriptions,
      },
    ).pipe(Stream.runForEach(applyItem)),
  );

  yield* Effect.addFinalizer(() =>
    Effect.all([SubscriptionRef.get(state), SubscriptionRef.get(lastSequence)]).pipe(
      Effect.flatMap(([current, snapshotSequence]) =>
        Option.match(current.data, {
          onNone: () => Effect.void,
          onSome: (projection) =>
            shouldPersistThread(projection)
              ? persist({
                  snapshotSequence,
                  projection,
                  ...(current.visibleTurnItemHistory?.page === null ||
                  current.visibleTurnItemHistory?.page === undefined
                    ? {}
                    : { visibleTurnItemPage: current.visibleTurnItemHistory.page }),
                })
              : Effect.void,
        }),
      ),
    ),
  );

  return Object.assign(state, { loadPreviousItems });
});

type EnvironmentThreadStateSubscription =
  SubscriptionRef.SubscriptionRef<EnvironmentThreadState> & {
    readonly loadPreviousItems: Effect.Effect<boolean>;
  };

export function threadStateChanges(
  environmentId: EnvironmentIdType,
  threadId: ThreadIdType,
  subscriptions?: Map<string, EnvironmentThreadStateSubscription>,
) {
  const key = threadKey({ environmentId, threadId });
  return followStreamInEnvironment(
    environmentId,
    Stream.unwrap(
      makeEnvironmentThreadState(threadId).pipe(
        Effect.flatMap((subscription) =>
          subscriptions === undefined
            ? Effect.succeed(SubscriptionRef.changes(subscription))
            : Effect.acquireRelease(
                Effect.sync(() => {
                  subscriptions.set(key, subscription);
                  return subscription;
                }),
                (registered) =>
                  Effect.sync(() => {
                    if (subscriptions.get(key) === registered) {
                      subscriptions.delete(key);
                    }
                  }),
              ).pipe(Effect.map(SubscriptionRef.changes)),
        ),
      ),
    ),
  );
}

export function createEnvironmentThreadStateAtoms<R, E>(
  runtime: Atom.AtomRuntime<
    EnvironmentRegistry | EnvironmentCacheStore | ThreadSnapshotLoader | R,
    E
  >,
) {
  const subscriptions = new Map<string, EnvironmentThreadStateSubscription>();
  const scheduler = createAtomCommandScheduler();
  const family = Atom.family((key: string) => {
    const { environmentId, threadId } = parseThreadKey(key);
    return runtime
      .atom(threadStateChanges(environmentId, threadId, subscriptions), {
        initialValue: EMPTY_ENVIRONMENT_THREAD_STATE,
      })
      .pipe(
        Atom.setIdleTTL(THREAD_STATE_IDLE_TTL_MS),
        Atom.withLabel(`environment-thread-state:${key}`),
      );
  });

  return {
    stateAtom: (environmentId: EnvironmentIdType, threadId: ThreadIdType) =>
      family(threadKey({ environmentId, threadId })),
    loadPreviousItems: createEnvironmentCommand(runtime, {
      label: "environment-data:thread:load-previous-items",
      execute: (input: { readonly threadId: ThreadIdType }) =>
        EnvironmentSupervisor.pipe(
          Effect.flatMap((supervisor) => {
            const subscription = subscriptions.get(
              threadKey({
                environmentId: supervisor.target.environmentId,
                threadId: input.threadId,
              }),
            );
            return subscription?.loadPreviousItems ?? Effect.succeed(false);
          }),
        ),
      scheduler,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) => threadKey({ environmentId, threadId: input.threadId }),
      },
    }),
  };
}

export * from "./archivedThreads.ts";
export * from "./checkpointDiff.ts";
export * from "./threadSnapshotHttp.ts";
export * from "./composerPathSearch.ts";
export * from "./threadCommands.ts";
export * from "./threadDetail.ts";
export * from "./threadShell.ts";
export * from "./threadState.ts";
