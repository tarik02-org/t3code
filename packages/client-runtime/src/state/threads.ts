import {
  ORCHESTRATION_WS_METHODS,
  type EnvironmentId as EnvironmentIdType,
  type MessageId,
  type OrchestrationThreadHistoryPage,
  type OrchestrationThread,
  type OrchestrationThreadDetailSnapshot,
  type OrchestrationThreadStreamItem,
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
import { EnvironmentCacheStore, ThreadHistoryCacheStore } from "../platform/persistence.ts";
import { subscribeDynamic } from "../rpc/client.ts";
import {
  THREAD_HISTORY_AROUND_PAGE_SIZE,
  THREAD_MESSAGE_PAGE_SIZE,
  ThreadSnapshotLoader,
} from "./threadSnapshotHttp.ts";
import { parseThreadKey, threadKey } from "./entities.ts";
import { applyThreadDetailEvent } from "./threadReducer.ts";
import { THREAD_STATE_IDLE_TTL_MS } from "./threadRetention.ts";
import {
  createAtomCommandScheduler,
  createEnvironmentCommand,
  followStreamInEnvironment,
} from "./runtime.ts";
import {
  EMPTY_ENVIRONMENT_THREAD_STATE,
  type EnvironmentThreadHistoryState,
  type EnvironmentThreadState,
  type EnvironmentThreadStatus,
} from "./threadState.ts";

const THREAD_HISTORY_WINDOW_MAX_MESSAGES = 250;

function statusWithoutLiveData(data: Option.Option<OrchestrationThread>): EnvironmentThreadStatus {
  return Option.isSome(data) ? "cached" : "empty";
}

function formatThreadError(cause: Cause.Cause<unknown>): string {
  const error = Cause.squash(cause);
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : "Could not synchronize the thread.";
}

function shouldPersistThread(thread: OrchestrationThread): boolean {
  const status = thread.session?.status;
  return status !== "starting" && status !== "running";
}

function boundLiveThread(thread: OrchestrationThread): OrchestrationThread {
  if (thread.messageHistory === undefined) {
    return thread;
  }
  const messages =
    thread.messages.length > THREAD_MESSAGE_PAGE_SIZE
      ? thread.messages.slice(-THREAD_MESSAGE_PAGE_SIZE)
      : thread.messages;
  const firstMessage = messages[0];
  if (firstMessage === undefined) {
    return thread;
  }
  const visibleTurnIds = new Set(
    messages.flatMap((message) => (message.turnId === null ? [] : [message.turnId])),
  );
  const activeTurnId = thread.session?.activeTurnId ?? null;
  if (activeTurnId !== null) {
    visibleTurnIds.add(activeTurnId);
  }
  return {
    ...thread,
    messages,
    activities: thread.activities.filter(
      (activity) =>
        activity.createdAt >= firstMessage.createdAt &&
        (activity.turnId === null || visibleTurnIds.has(activity.turnId)),
    ),
    proposedPlans: thread.proposedPlans.filter((plan) => plan.createdAt >= firstMessage.createdAt),
    messageHistory: {
      hasMoreBefore: thread.messageHistory.endIndex - messages.length > 0,
      hasMoreAfter: thread.messageHistory.endIndex < thread.messageHistory.totalMessages,
      startIndex: thread.messageHistory.endIndex - messages.length,
      endIndex: thread.messageHistory.endIndex,
      totalMessages: thread.messageHistory.totalMessages,
      cursor: {
        createdAt: firstMessage.createdAt,
        messageId: firstMessage.id,
      },
    },
  };
}

function mergeThreadHistoryPages(input: {
  readonly older: OrchestrationThreadHistoryPage;
  readonly newer: OrchestrationThreadHistoryPage;
}): OrchestrationThreadHistoryPage {
  const messages = [
    ...new Map(
      [...input.older.messages, ...input.newer.messages].map((message) => [message.id, message]),
    ).values(),
  ].toSorted(
    (left, right) =>
      left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
  );
  const activities = [
    ...new Map(
      [...input.older.activities, ...input.newer.activities].map((activity) => [
        activity.id,
        activity,
      ]),
    ).values(),
  ].toSorted(
    (left, right) =>
      left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
  );
  const proposedPlans = [
    ...new Map(
      [...input.older.proposedPlans, ...input.newer.proposedPlans].map((plan) => [plan.id, plan]),
    ).values(),
  ].toSorted(
    (left, right) =>
      left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
  );
  const firstMessage = messages[0];
  const startIndex = Math.min(
    input.older.messageHistory.startIndex,
    input.newer.messageHistory.startIndex,
  );
  const endIndex = Math.max(
    input.older.messageHistory.endIndex,
    input.newer.messageHistory.endIndex,
  );
  const totalMessages = Math.max(
    input.older.messageHistory.totalMessages,
    input.newer.messageHistory.totalMessages,
  );
  return {
    messages,
    activities,
    proposedPlans,
    messageHistory: {
      hasMoreBefore: startIndex > 0,
      hasMoreAfter: endIndex < totalMessages,
      startIndex,
      endIndex,
      totalMessages,
      cursor:
        firstMessage === undefined
          ? null
          : {
              createdAt: firstMessage.createdAt,
              messageId: firstMessage.id,
            },
    },
  };
}

function boundThreadHistoryPage(
  page: OrchestrationThreadHistoryPage,
  preserve: "older" | "newer",
): OrchestrationThreadHistoryPage {
  if (page.messages.length <= THREAD_HISTORY_WINDOW_MAX_MESSAGES) {
    return page;
  }
  const messages =
    preserve === "older"
      ? page.messages.slice(0, THREAD_HISTORY_WINDOW_MAX_MESSAGES)
      : page.messages.slice(-THREAD_HISTORY_WINDOW_MAX_MESSAGES);
  const firstMessage = messages[0];
  const lastMessage = messages.at(-1);
  if (firstMessage === undefined || lastMessage === undefined) {
    return page;
  }
  const startIndex =
    preserve === "older"
      ? page.messageHistory.startIndex
      : page.messageHistory.endIndex - messages.length;
  const endIndex =
    preserve === "older"
      ? page.messageHistory.startIndex + messages.length
      : page.messageHistory.endIndex;
  return {
    messages,
    activities: page.activities.filter(
      (activity) =>
        activity.createdAt >= firstMessage.createdAt && activity.createdAt <= lastMessage.createdAt,
    ),
    proposedPlans: page.proposedPlans.filter(
      (plan) => plan.createdAt >= firstMessage.createdAt && plan.createdAt <= lastMessage.createdAt,
    ),
    messageHistory: {
      hasMoreBefore: startIndex > 0,
      hasMoreAfter: endIndex < page.messageHistory.totalMessages,
      startIndex,
      endIndex,
      totalMessages: page.messageHistory.totalMessages,
      cursor: {
        createdAt: firstMessage.createdAt,
        messageId: firstMessage.id,
      },
    },
  };
}

function displayThreadHistory(
  liveThread: OrchestrationThread,
  history: EnvironmentThreadHistoryState,
): OrchestrationThread {
  if (history.kind === "disabled" || history.window === null) {
    return liveThread;
  }
  const historyTurnIds = new Set(
    history.window.messages.flatMap((message) => (message.turnId === null ? [] : [message.turnId])),
  );
  const visibleHistoryWindow = {
    ...history.window,
    activities: history.window.activities.filter(
      (activity) => activity.turnId === null || historyTurnIds.has(activity.turnId),
    ),
  };
  if (visibleHistoryWindow.messageHistory.hasMoreAfter) {
    const totalMessages = Math.max(
      visibleHistoryWindow.messageHistory.totalMessages,
      liveThread.messageHistory?.totalMessages ?? liveThread.messages.length,
    );
    return {
      ...liveThread,
      messages: visibleHistoryWindow.messages,
      activities: visibleHistoryWindow.activities,
      proposedPlans: visibleHistoryWindow.proposedPlans,
      messageHistory: {
        ...visibleHistoryWindow.messageHistory,
        hasMoreAfter: visibleHistoryWindow.messageHistory.endIndex < totalMessages,
        totalMessages,
      },
    };
  }
  const merged = mergeThreadHistoryPages({
    older: visibleHistoryWindow,
    newer: {
      messages: liveThread.messages,
      activities: liveThread.activities,
      proposedPlans: liveThread.proposedPlans,
      messageHistory: liveThread.messageHistory ?? {
        hasMoreBefore: false,
        hasMoreAfter: false,
        startIndex: 0,
        endIndex: liveThread.messages.length,
        totalMessages: liveThread.messages.length,
        cursor: null,
      },
    },
  });
  return {
    ...liveThread,
    messages: merged.messages,
    activities: merged.activities,
    proposedPlans: merged.proposedPlans,
    messageHistory: merged.messageHistory,
  };
}

export const makeEnvironmentThreadState = Effect.fn("EnvironmentThreadState.make")(function* (
  threadId: ThreadIdType,
) {
  const supervisor = yield* EnvironmentSupervisor;
  const cache = yield* EnvironmentCacheStore;
  const historyCache = yield* ThreadHistoryCacheStore;
  const snapshotLoader = yield* ThreadSnapshotLoader;
  const wakeups = yield* Effect.serviceOption(ConnectionWakeups.ConnectionWakeups);
  const environmentId = supervisor.target.environmentId;
  const cacheHistoryPage = Effect.fn("EnvironmentThreadState.cacheHistoryPage")(function* (
    page: OrchestrationThreadHistoryPage,
  ) {
    yield* historyCache.save(environmentId, threadId, page).pipe(
      Effect.catchTags({
        ConnectionPersistenceError: (error) =>
          Effect.logWarning("Could not persist cached thread history.").pipe(
            Effect.annotateLogs({
              environmentId,
              threadId,
              error: error.message,
            }),
          ),
      }),
    );
  });
  const clearHistoryCache = Effect.fn("EnvironmentThreadState.clearHistoryCache")(function* () {
    yield* historyCache.remove(environmentId, threadId).pipe(
      Effect.catchTags({
        ConnectionPersistenceError: (error) =>
          Effect.logWarning("Could not clear cached thread history.").pipe(
            Effect.annotateLogs({
              environmentId,
              threadId,
              error: error.message,
            }),
          ),
      }),
    );
  });
  const cached = yield* cache.loadThread(environmentId, threadId).pipe(
    Effect.catch((error) =>
      Effect.logWarning("Could not load cached thread.").pipe(
        Effect.annotateLogs({
          environmentId,
          threadId,
          error: error.message,
        }),
        Effect.as(Option.none<OrchestrationThreadDetailSnapshot>()),
      ),
    ),
  );
  const cachedThread = Option.map(cached, (snapshot) => boundLiveThread(snapshot.thread));
  const state = yield* SubscriptionRef.make<EnvironmentThreadState>({
    data: cachedThread,
    liveData: cachedThread,
    status: statusWithoutLiveData(cachedThread),
    error: Option.none(),
    history: { kind: "disabled" },
  });
  const liveThread = yield* Ref.make(cachedThread);
  const historyOutlineRefreshes = yield* SubscriptionRef.make(0);
  // Seed the resume cursor from the cached snapshot so a warm cache can catch up
  // via `afterSequence` instead of re-downloading the full thread body.
  const lastSequence = yield* SubscriptionRef.make(
    Option.match(cached, { onNone: () => 0, onSome: (snapshot) => snapshot.snapshotSequence }),
  );
  const awaitingCompletion = yield* Ref.make(false);
  const persistence = yield* Queue.sliding<OrchestrationThreadDetailSnapshot>(1);
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
    snapshot: OrchestrationThreadDetailSnapshot,
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
    const firstMessage = snapshot.thread.messages[0];
    if (snapshot.thread.messageHistory !== undefined && firstMessage !== undefined) {
      yield* cacheHistoryPage({
        messages: snapshot.thread.messages,
        activities: snapshot.thread.activities.filter(
          (activity) => activity.createdAt >= firstMessage.createdAt,
        ),
        proposedPlans: snapshot.thread.proposedPlans.filter(
          (plan) => plan.createdAt >= firstMessage.createdAt,
        ),
        messageHistory: snapshot.thread.messageHistory,
      });
    }
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
    thread: OrchestrationThread,
  ) {
    const boundedThread = boundLiveThread(thread);
    yield* Ref.set(liveThread, Option.some(boundedThread));
    const waiting = yield* Ref.get(awaitingCompletion);
    const status: EnvironmentThreadStatus = waiting ? "synchronizing" : "live";
    yield* SubscriptionRef.update(state, (current) => ({
      ...current,
      data: Option.some(displayThreadHistory(boundedThread, current.history)),
      liveData: Option.some(boundedThread),
      status,
      error: Option.none(),
    }));
    // Active threads can update many times per second and retain large tool
    // payloads. The server remains the source of truth while a turn is active;
    // persist once it settles so cache encoding stays off the streaming path.
    if (shouldPersistThread(boundedThread)) {
      const snapshotSequence = yield* SubscriptionRef.get(lastSequence);
      yield* Queue.offer(persistence, { snapshotSequence, thread: boundedThread });
    }
  });

  const loadHistoryOutline = Effect.gen(function* () {
    const current = yield* SubscriptionRef.get(state);
    if (
      current.history.kind === "disabled" ||
      current.history.outline !== null ||
      current.history.loading !== null
    ) {
      return;
    }
    yield* SubscriptionRef.set(state, {
      ...current,
      history: { ...current.history, loading: "outline" },
    });
    yield* Effect.gen(function* () {
      const prepared = yield* preparedConnection;
      const outline = yield* snapshotLoader.loadHistoryOutline(prepared, threadId);
      if (Option.isNone(outline)) {
        return;
      }
      yield* SubscriptionRef.update(state, (latest) =>
        latest.history.kind === "disabled" || latest.history.loading !== "outline"
          ? latest
          : {
              ...latest,
              history: { ...latest.history, outline: outline.value },
            },
      );
    }).pipe(
      Effect.ensuring(
        SubscriptionRef.update(state, (latest) =>
          latest.history.kind === "ready" && latest.history.loading === "outline"
            ? {
                ...latest,
                history: { ...latest.history, loading: null },
              }
            : latest,
        ),
      ),
    );
  });

  const loadPreviousMessages = Effect.gen(function* () {
    const current = yield* SubscriptionRef.get(state);
    const currentLiveThread = yield* Ref.get(liveThread);
    if (
      current.history.kind === "disabled" ||
      current.history.loading !== null ||
      Option.isNone(currentLiveThread)
    ) {
      return;
    }
    const sourceHistory =
      current.history.window?.messageHistory ?? currentLiveThread.value.messageHistory;
    const cursor = sourceHistory?.cursor;
    if (
      sourceHistory === undefined ||
      !sourceHistory.hasMoreBefore ||
      cursor === null ||
      cursor === undefined
    ) {
      return;
    }

    const historyLookup = yield* historyCache
      .loadPrevious(environmentId, threadId, sourceHistory.startIndex, THREAD_MESSAGE_PAGE_SIZE)
      .pipe(
        Effect.catchTags({
          ConnectionPersistenceError: (error) =>
            Effect.logWarning("Could not load cached previous thread messages.").pipe(
              Effect.annotateLogs({
                environmentId,
                threadId,
                error: error.message,
              }),
              Effect.as({
                page: Option.none<OrchestrationThreadHistoryPage>(),
                requestLimit: THREAD_MESSAGE_PAGE_SIZE,
              }),
            ),
        }),
      );
    if (Option.isSome(historyLookup.page)) {
      const liveMessages = currentLiveThread.value.messages;
      const firstLiveMessage = liveMessages[0];
      const currentWindow = current.history.window ?? {
        messages: liveMessages,
        activities:
          firstLiveMessage === undefined
            ? []
            : currentLiveThread.value.activities.filter(
                (activity) => activity.createdAt >= firstLiveMessage.createdAt,
              ),
        proposedPlans:
          firstLiveMessage === undefined
            ? []
            : currentLiveThread.value.proposedPlans.filter(
                (plan) => plan.createdAt >= firstLiveMessage.createdAt,
              ),
        messageHistory: currentLiveThread.value.messageHistory ?? {
          hasMoreBefore: false,
          hasMoreAfter: false,
          startIndex: 0,
          endIndex: liveMessages.length,
          totalMessages: liveMessages.length,
          cursor: null,
        },
      };
      const window = boundThreadHistoryPage(
        mergeThreadHistoryPages({
          older: historyLookup.page.value,
          newer: currentWindow,
        }),
        "older",
      );
      const history: EnvironmentThreadHistoryState = { ...current.history, window };
      yield* SubscriptionRef.set(state, {
        ...current,
        data: Option.some(displayThreadHistory(currentLiveThread.value, history)),
        history,
      });
      return;
    }

    yield* SubscriptionRef.set(state, {
      ...current,
      history: { ...current.history, loading: "before" },
    });
    yield* Effect.gen(function* () {
      const prepared = yield* preparedConnection;
      const page = yield* snapshotLoader.loadPreviousMessages(
        prepared,
        threadId,
        cursor,
        historyLookup.requestLimit,
      );
      if (Option.isNone(page)) {
        return;
      }

      const latest = yield* SubscriptionRef.get(state);
      const latestLiveThread = yield* Ref.get(liveThread);
      if (
        latest.history.kind === "disabled" ||
        latest.history.loading !== "before" ||
        Option.isNone(latestLiveThread)
      ) {
        return;
      }
      const liveMessages = latestLiveThread.value.messages;
      const firstLiveMessage = liveMessages[0];
      const currentWindow = latest.history.window ?? {
        messages: liveMessages,
        activities:
          firstLiveMessage === undefined
            ? []
            : latestLiveThread.value.activities.filter(
                (activity) => activity.createdAt >= firstLiveMessage.createdAt,
              ),
        proposedPlans:
          firstLiveMessage === undefined
            ? []
            : latestLiveThread.value.proposedPlans.filter(
                (plan) => plan.createdAt >= firstLiveMessage.createdAt,
              ),
        messageHistory: latestLiveThread.value.messageHistory ?? {
          hasMoreBefore: false,
          hasMoreAfter: false,
          startIndex: 0,
          endIndex: liveMessages.length,
          totalMessages: liveMessages.length,
          cursor: null,
        },
      };
      const window = boundThreadHistoryPage(
        mergeThreadHistoryPages({
          older: page.value,
          newer: currentWindow,
        }),
        "older",
      );
      const history: EnvironmentThreadHistoryState = { ...latest.history, window };
      yield* SubscriptionRef.set(state, {
        ...latest,
        data: Option.some(displayThreadHistory(latestLiveThread.value, history)),
        history,
      });
      yield* cacheHistoryPage(page.value);
    }).pipe(
      Effect.ensuring(
        SubscriptionRef.update(state, (latest) =>
          latest.history.kind === "ready" && latest.history.loading === "before"
            ? {
                ...latest,
                history: { ...latest.history, loading: null },
              }
            : latest,
        ),
      ),
    );
  });

  const loadNextMessages = Effect.gen(function* () {
    const current = yield* SubscriptionRef.get(state);
    const currentLiveThread = yield* Ref.get(liveThread);
    const window = current.history.kind === "ready" ? current.history.window : null;
    const lastMessage = window?.messages.at(-1);
    if (
      current.history.kind === "disabled" ||
      current.history.loading !== null ||
      window === null ||
      !window.messageHistory.hasMoreAfter ||
      lastMessage === undefined ||
      Option.isNone(currentLiveThread)
    ) {
      return;
    }

    const historyLookup = yield* historyCache
      .loadNext(environmentId, threadId, window.messageHistory.endIndex, THREAD_MESSAGE_PAGE_SIZE)
      .pipe(
        Effect.catchTags({
          ConnectionPersistenceError: (error) =>
            Effect.logWarning("Could not load cached next thread messages.").pipe(
              Effect.annotateLogs({
                environmentId,
                threadId,
                error: error.message,
              }),
              Effect.as({
                page: Option.none<OrchestrationThreadHistoryPage>(),
                requestLimit: THREAD_MESSAGE_PAGE_SIZE,
              }),
            ),
        }),
      );
    if (Option.isSome(historyLookup.page)) {
      const nextWindow = boundThreadHistoryPage(
        mergeThreadHistoryPages({
          older: window,
          newer: historyLookup.page.value,
        }),
        "newer",
      );
      const history: EnvironmentThreadHistoryState = {
        ...current.history,
        window: nextWindow,
      };
      yield* SubscriptionRef.set(state, {
        ...current,
        data: Option.some(displayThreadHistory(currentLiveThread.value, history)),
        history,
      });
      return;
    }

    yield* SubscriptionRef.set(state, {
      ...current,
      history: { ...current.history, loading: "after" },
    });
    yield* Effect.gen(function* () {
      const prepared = yield* preparedConnection;
      const page = yield* snapshotLoader.loadNextMessages(
        prepared,
        threadId,
        {
          createdAt: lastMessage.createdAt,
          messageId: lastMessage.id,
        },
        historyLookup.requestLimit,
      );
      if (Option.isNone(page)) {
        return;
      }

      const latest = yield* SubscriptionRef.get(state);
      const latestLiveThread = yield* Ref.get(liveThread);
      if (
        latest.history.kind === "disabled" ||
        latest.history.loading !== "after" ||
        latest.history.window === null ||
        Option.isNone(latestLiveThread)
      ) {
        return;
      }
      const nextWindow = boundThreadHistoryPage(
        mergeThreadHistoryPages({
          older: latest.history.window,
          newer: page.value,
        }),
        "newer",
      );
      const history: EnvironmentThreadHistoryState = {
        ...latest.history,
        window: nextWindow,
      };
      yield* SubscriptionRef.set(state, {
        ...latest,
        data: Option.some(displayThreadHistory(latestLiveThread.value, history)),
        history,
      });
      yield* cacheHistoryPage(page.value);
    }).pipe(
      Effect.ensuring(
        SubscriptionRef.update(state, (latest) =>
          latest.history.kind === "ready" && latest.history.loading === "after"
            ? {
                ...latest,
                history: { ...latest.history, loading: null },
              }
            : latest,
        ),
      ),
    );
  });

  const loadMessagesAround = Effect.fn("EnvironmentThreadState.loadMessagesAround")(function* (
    messageId: MessageId,
  ) {
    const current = yield* SubscriptionRef.get(state);
    if (current.history.kind === "disabled" || current.history.loading !== null) {
      return false;
    }
    const cachedPage = yield* historyCache
      .loadAround(environmentId, threadId, messageId, THREAD_HISTORY_AROUND_PAGE_SIZE)
      .pipe(
        Effect.catchTags({
          ConnectionPersistenceError: (error) =>
            Effect.logWarning("Could not load cached thread messages around the target.").pipe(
              Effect.annotateLogs({
                environmentId,
                threadId,
                error: error.message,
              }),
              Effect.as(Option.none<OrchestrationThreadHistoryPage>()),
            ),
        }),
      );
    if (Option.isSome(cachedPage)) {
      const currentLiveThread = yield* Ref.get(liveThread);
      if (Option.isNone(currentLiveThread)) {
        return false;
      }
      const totalMessages = Math.max(
        cachedPage.value.messageHistory.totalMessages,
        currentLiveThread.value.messageHistory?.totalMessages ??
          currentLiveThread.value.messages.length,
      );
      const history: EnvironmentThreadHistoryState = {
        ...current.history,
        window: {
          ...cachedPage.value,
          messageHistory: {
            ...cachedPage.value.messageHistory,
            hasMoreAfter: cachedPage.value.messageHistory.endIndex < totalMessages,
            totalMessages,
          },
        },
      };
      yield* SubscriptionRef.set(state, {
        ...current,
        data: Option.some(displayThreadHistory(currentLiveThread.value, history)),
        history,
      });
      return true;
    }
    yield* SubscriptionRef.set(state, {
      ...current,
      history: { ...current.history, loading: "around" },
    });
    return yield* Effect.gen(function* () {
      const prepared = yield* preparedConnection;
      const page = yield* snapshotLoader.loadMessagesAround(prepared, threadId, messageId);
      if (Option.isNone(page)) {
        return false;
      }

      const latest = yield* SubscriptionRef.get(state);
      const latestLiveThread = yield* Ref.get(liveThread);
      if (
        latest.history.kind === "disabled" ||
        latest.history.loading !== "around" ||
        Option.isNone(latestLiveThread)
      ) {
        return false;
      }
      const history: EnvironmentThreadHistoryState = {
        ...latest.history,
        window: page.value,
      };
      yield* SubscriptionRef.set(state, {
        ...latest,
        data: Option.some(displayThreadHistory(latestLiveThread.value, history)),
        history,
      });
      yield* cacheHistoryPage(page.value);
      return true;
    }).pipe(
      Effect.ensuring(
        SubscriptionRef.update(state, (latest) =>
          latest.history.kind === "ready" && latest.history.loading === "around"
            ? {
                ...latest,
                history: { ...latest.history, loading: null },
              }
            : latest,
        ),
      ),
    );
  });

  const setDeleted = Effect.fn("EnvironmentThreadState.setDeleted")(function* () {
    yield* Ref.set(awaitingCompletion, false);
    yield* Ref.set(liveThread, Option.none());
    yield* clearHistoryCache();
    yield* SubscriptionRef.set(state, {
      data: Option.none(),
      liveData: Option.none(),
      status: "deleted",
      error: Option.none(),
      history: { kind: "disabled" },
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
    item: OrchestrationThreadStreamItem,
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
      const snapshotTotalMessages =
        item.snapshot.thread.messageHistory?.totalMessages ?? item.snapshot.thread.messages.length;
      const cachedTotalMessages = yield* historyCache
        .loadTotalMessages(environmentId, threadId)
        .pipe(
          Effect.catchTags({
            ConnectionPersistenceError: (error) =>
              Effect.logWarning("Could not inspect cached thread history.").pipe(
                Effect.annotateLogs({
                  environmentId,
                  threadId,
                  error: error.message,
                }),
                Effect.as(Option.none<number>()),
              ),
          }),
        );
      if (Option.isSome(cachedTotalMessages) && cachedTotalMessages.value > snapshotTotalMessages) {
        yield* clearHistoryCache();
      }
      yield* SubscriptionRef.set(lastSequence, item.snapshot.snapshotSequence);
      yield* setThread(item.snapshot.thread);
      return;
    }

    const sequence = yield* SubscriptionRef.get(lastSequence);
    if (item.event.sequence <= sequence) {
      return;
    }
    yield* SubscriptionRef.set(lastSequence, item.event.sequence);

    const currentLiveThread = yield* Ref.get(liveThread);
    if (Option.isNone(currentLiveThread)) {
      if (item.event.type === "thread.deleted") {
        yield* setDeleted();
      }
      return;
    }
    const result = applyThreadDetailEvent(currentLiveThread.value, item.event);
    if (result.kind === "updated") {
      const sentUserMessage =
        item.event.type === "thread.message-sent" && item.event.payload.role === "user";
      if (item.event.type === "thread.reverted") {
        yield* clearHistoryCache();
        const current = yield* SubscriptionRef.get(state);
        const refreshOutline =
          current.history.kind === "ready" && current.history.loading !== "outline";
        yield* SubscriptionRef.update(state, (current) => {
          const history: EnvironmentThreadHistoryState =
            current.history.kind === "disabled"
              ? current.history
              : {
                  kind: "ready",
                  outline: null,
                  window: null,
                  loading: current.history.loading === "outline" ? "outline" : null,
                };
          return { ...current, history };
        });
        if (refreshOutline) {
          yield* SubscriptionRef.update(historyOutlineRefreshes, (revision) => revision + 1);
        }
      } else if (sentUserMessage) {
        const current = yield* SubscriptionRef.get(state);
        const refreshOutline =
          current.history.kind === "ready" && current.history.loading !== "outline";
        yield* SubscriptionRef.update(state, (current) => {
          const history: EnvironmentThreadHistoryState =
            current.history.kind === "disabled"
              ? current.history
              : {
                  ...current.history,
                  outline: null,
                  window: null,
                  loading: current.history.loading === "outline" ? "outline" : null,
                };
          return { ...current, history };
        });
        if (refreshOutline) {
          yield* SubscriptionRef.update(historyOutlineRefreshes, (revision) => revision + 1);
        }
      }
      yield* setThread(result.thread);
    } else if (result.kind === "deleted") {
      yield* setDeleted();
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
      service.changes.pipe(Stream.filter((reason) => reason === "application-active")),
  });
  const messagePaginationSupported = yield* SubscriptionRef.make(false);
  yield* SubscriptionRef.changes(messagePaginationSupported).pipe(
    Stream.filter((supported) => supported),
    Stream.runForEach(() => loadHistoryOutline),
    Effect.forkScoped,
  );
  yield* SubscriptionRef.changes(historyOutlineRefreshes).pipe(
    Stream.filter((revision) => revision > 0),
    Stream.runForEach(() => loadHistoryOutline),
    Effect.forkScoped,
  );

  yield* setSynchronizing;
  yield* Effect.forkScoped(
    subscribeDynamic(
      ORCHESTRATION_WS_METHODS.subscribeThread,
      Effect.fn("EnvironmentThreadState.makeSubscribeInput")(function* (session) {
        const supportsCompletionMarker = yield* session.initialConfig.pipe(
          Effect.map((config) => config.threadResumeCompletionMarker === true),
          Effect.orElseSucceed(() => false),
        );
        const supportsMessagePagination = yield* session.initialConfig.pipe(
          Effect.map((config) => config.threadMessagePagination === true),
          Effect.orElseSucceed(() => false),
        );
        yield* Ref.set(awaitingCompletion, supportsCompletionMarker);
        yield* setSynchronizing;
        const currentLiveThread = yield* Ref.get(liveThread);
        yield* SubscriptionRef.update(state, (current) => {
          const history: EnvironmentThreadHistoryState = supportsMessagePagination
            ? current.history.kind === "ready"
              ? current.history
              : {
                  kind: "ready",
                  outline: null,
                  window: null,
                  loading: null,
                }
            : { kind: "disabled" };
          return {
            ...current,
            data: Option.map(currentLiveThread, (thread) => displayThreadHistory(thread, history)),
            liveData: currentLiveThread,
            history,
          };
        });

        let current = yield* SubscriptionRef.get(state);
        if (
          current.status !== "deleted" &&
          (Option.isNone(current.data) ||
            (supportsMessagePagination && current.data.value.messageHistory === undefined))
        ) {
          const prepared = yield* preparedConnection;
          const httpSnapshot = yield* snapshotLoader.load(
            prepared,
            threadId,
            supportsMessagePagination ? THREAD_MESSAGE_PAGE_SIZE : undefined,
          );
          if (Option.isSome(httpSnapshot)) {
            yield* applyItem({ kind: "snapshot", snapshot: httpSnapshot.value });
            current = yield* SubscriptionRef.get(state);
          }
        }
        yield* SubscriptionRef.set(messagePaginationSupported, supportsMessagePagination);

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
          ...(supportsMessagePagination ? { messageLimit: THREAD_MESSAGE_PAGE_SIZE } : {}),
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
    Effect.all([Ref.get(liveThread), SubscriptionRef.get(lastSequence)]).pipe(
      Effect.flatMap(([currentLiveThread, snapshotSequence]) =>
        Option.match(currentLiveThread, {
          onNone: () => Effect.void,
          onSome: (thread) =>
            shouldPersistThread(thread) ? persist({ snapshotSequence, thread }) : Effect.void,
        }),
      ),
    ),
  );

  return Object.assign(state, {
    loadPreviousMessages,
    loadNextMessages,
    loadMessagesAround,
  });
});

type EnvironmentThreadStateSubscription =
  SubscriptionRef.SubscriptionRef<EnvironmentThreadState> & {
    readonly loadPreviousMessages: Effect.Effect<void>;
    readonly loadNextMessages: Effect.Effect<void>;
    readonly loadMessagesAround: (messageId: MessageId) => Effect.Effect<boolean>;
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
    loadPreviousMessages: createEnvironmentCommand(runtime, {
      label: "environment-data:thread:load-previous-messages",
      execute: (input: { readonly threadId: ThreadIdType }) =>
        EnvironmentSupervisor.pipe(
          Effect.flatMap((supervisor) => {
            const subscription = subscriptions.get(
              threadKey({
                environmentId: supervisor.target.environmentId,
                threadId: input.threadId,
              }),
            );
            return subscription?.loadPreviousMessages ?? Effect.void;
          }),
        ),
      scheduler,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) => threadKey({ environmentId, threadId: input.threadId }),
      },
    }),
    loadNextMessages: createEnvironmentCommand(runtime, {
      label: "environment-data:thread:load-next-messages",
      execute: (input: { readonly threadId: ThreadIdType }) =>
        EnvironmentSupervisor.pipe(
          Effect.flatMap((supervisor) => {
            const subscription = subscriptions.get(
              threadKey({
                environmentId: supervisor.target.environmentId,
                threadId: input.threadId,
              }),
            );
            return subscription?.loadNextMessages ?? Effect.void;
          }),
        ),
      scheduler,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) => threadKey({ environmentId, threadId: input.threadId }),
      },
    }),
    loadMessagesAround: createEnvironmentCommand(runtime, {
      label: "environment-data:thread:load-messages-around",
      execute: (input: { readonly threadId: ThreadIdType; readonly messageId: MessageId }) =>
        EnvironmentSupervisor.pipe(
          Effect.flatMap((supervisor) => {
            const subscription = subscriptions.get(
              threadKey({
                environmentId: supervisor.target.environmentId,
                threadId: input.threadId,
              }),
            );
            return subscription?.loadMessagesAround(input.messageId) ?? Effect.void;
          }),
        ),
      scheduler,
      concurrency: {
        mode: "latest",
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
export * from "./threadReducer.ts";
export * from "./threadShell.ts";
export * from "./threadState.ts";
