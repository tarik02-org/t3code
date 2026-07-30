import {
  type EnvironmentId,
  type MessageId,
  type OrchestrationThreadHistoryPage,
  type ThreadId,
} from "@t3tools/contracts";
import { LRUCache } from "@t3tools/shared/LRUCache";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { ConnectionPersistenceError } from "./persistence.ts";

export interface ThreadHistoryCacheLookup {
  readonly page: Option.Option<OrchestrationThreadHistoryPage>;
  readonly requestLimit: number;
}

export class ThreadHistoryCacheStore extends Context.Reference<{
  readonly loadPrevious: (
    environmentId: EnvironmentId,
    threadId: ThreadId,
    endIndex: number,
    limit: number,
  ) => Effect.Effect<ThreadHistoryCacheLookup, ConnectionPersistenceError>;
  readonly loadNext: (
    environmentId: EnvironmentId,
    threadId: ThreadId,
    startIndex: number,
    limit: number,
  ) => Effect.Effect<ThreadHistoryCacheLookup, ConnectionPersistenceError>;
  readonly loadAround: (
    environmentId: EnvironmentId,
    threadId: ThreadId,
    messageId: MessageId,
    limit: number,
  ) => Effect.Effect<Option.Option<OrchestrationThreadHistoryPage>, ConnectionPersistenceError>;
  readonly loadTotalMessages: (
    environmentId: EnvironmentId,
    threadId: ThreadId,
  ) => Effect.Effect<Option.Option<number>, ConnectionPersistenceError>;
  readonly save: (
    environmentId: EnvironmentId,
    threadId: ThreadId,
    page: OrchestrationThreadHistoryPage,
  ) => Effect.Effect<void, ConnectionPersistenceError>;
  readonly remove: (
    environmentId: EnvironmentId,
    threadId: ThreadId,
  ) => Effect.Effect<void, ConnectionPersistenceError>;
  readonly clear: (environmentId: EnvironmentId) => Effect.Effect<void, ConnectionPersistenceError>;
}>("@t3tools/client-runtime/platform/threadHistoryCache/ThreadHistoryCacheStore", {
  defaultValue: () => ({
    loadPrevious: (_environmentId, _threadId, _endIndex, limit) =>
      Effect.succeed({ page: Option.none(), requestLimit: limit }),
    loadNext: (_environmentId, _threadId, _startIndex, limit) =>
      Effect.succeed({ page: Option.none(), requestLimit: limit }),
    loadAround: () => Effect.succeed(Option.none()),
    loadTotalMessages: () => Effect.succeed(Option.none()),
    save: () => Effect.void,
    remove: () => Effect.void,
    clear: () => Effect.void,
  }),
}) {}

interface CachedHistoryPage {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly page: OrchestrationThreadHistoryPage;
}

function sliceHistoryPage(
  page: OrchestrationThreadHistoryPage,
  startIndex: number,
  endIndex: number,
): OrchestrationThreadHistoryPage {
  if (startIndex === page.messageHistory.startIndex && endIndex === page.messageHistory.endIndex) {
    return page;
  }

  const messages = page.messages.slice(
    startIndex - page.messageHistory.startIndex,
    endIndex - page.messageHistory.startIndex,
  );
  const firstMessage = messages[0];
  const activityPosition = (createdAt: string) => {
    const offset = page.messages.findIndex((message) => message.createdAt > createdAt);
    return page.messageHistory.startIndex + (offset === -1 ? page.messages.length : offset);
  };

  return {
    messages,
    activities: page.activities.filter((activity) => {
      const position = activityPosition(activity.createdAt);
      return position >= startIndex && position <= endIndex;
    }),
    proposedPlans: page.proposedPlans.filter((plan) => {
      const position = activityPosition(plan.createdAt);
      return position >= startIndex && position <= endIndex;
    }),
    messageHistory: {
      hasMoreBefore: startIndex > 0,
      hasMoreAfter: endIndex < page.messageHistory.totalMessages,
      startIndex,
      endIndex,
      totalMessages: page.messageHistory.totalMessages,
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

export function makeInMemoryThreadHistoryCacheStore(maxPages: number) {
  const pages = new LRUCache<CachedHistoryPage>(maxPages, maxPages);

  return ThreadHistoryCacheStore.of({
    loadPrevious: (environmentId, threadId, endIndex, limit) =>
      Effect.sync(() => {
        let match: readonly [string, CachedHistoryPage] | null = null;
        let nearestEndIndex: number | null = null;
        for (const entry of pages.entries()) {
          const cached = entry[1];
          if (cached.environmentId !== environmentId || cached.threadId !== threadId) {
            continue;
          }
          const history = cached.page.messageHistory;
          if (history.startIndex < endIndex && history.endIndex >= endIndex) {
            match = entry;
          } else if (
            history.endIndex < endIndex &&
            (nearestEndIndex === null || history.endIndex > nearestEndIndex)
          ) {
            nearestEndIndex = history.endIndex;
          }
        }
        if (match !== null) {
          const [key, cached] = match;
          void pages.get(key);
          return {
            page: Option.some(
              sliceHistoryPage(
                cached.page,
                Math.max(cached.page.messageHistory.startIndex, endIndex - limit),
                endIndex,
              ),
            ),
            requestLimit: limit,
          };
        }
        return {
          page: Option.none(),
          requestLimit: Math.min(
            limit,
            endIndex - (nearestEndIndex ?? Math.max(0, endIndex - limit)),
          ),
        };
      }),
    loadNext: (environmentId, threadId, startIndex, limit) =>
      Effect.sync(() => {
        let match: readonly [string, CachedHistoryPage] | null = null;
        let nearestStartIndex: number | null = null;
        for (const entry of pages.entries()) {
          const cached = entry[1];
          if (cached.environmentId !== environmentId || cached.threadId !== threadId) {
            continue;
          }
          const history = cached.page.messageHistory;
          if (history.startIndex <= startIndex && history.endIndex > startIndex) {
            match = entry;
          } else if (
            history.startIndex > startIndex &&
            (nearestStartIndex === null || history.startIndex < nearestStartIndex)
          ) {
            nearestStartIndex = history.startIndex;
          }
        }
        if (match !== null) {
          const [key, cached] = match;
          void pages.get(key);
          return {
            page: Option.some(
              sliceHistoryPage(
                cached.page,
                startIndex,
                Math.min(cached.page.messageHistory.endIndex, startIndex + limit),
              ),
            ),
            requestLimit: limit,
          };
        }
        return {
          page: Option.none(),
          requestLimit: Math.min(limit, (nearestStartIndex ?? startIndex + limit) - startIndex),
        };
      }),
    loadAround: (environmentId, threadId, messageId, limit) =>
      Effect.sync(() => {
        let match: readonly [string, CachedHistoryPage, number] | null = null;
        for (const [key, cached] of pages.entries()) {
          if (cached.environmentId !== environmentId || cached.threadId !== threadId) {
            continue;
          }
          const offset = cached.page.messages.findIndex((message) => message.id === messageId);
          if (offset !== -1) {
            match = [key, cached, cached.page.messageHistory.startIndex + offset];
          }
        }
        if (match === null) {
          return Option.none();
        }
        const [key, cached, targetIndex] = match;
        void pages.get(key);
        let startIndex = Math.max(
          cached.page.messageHistory.startIndex,
          targetIndex - Math.floor((limit - 1) / 2),
        );
        const endIndex = Math.min(cached.page.messageHistory.endIndex, startIndex + limit);
        startIndex = Math.max(cached.page.messageHistory.startIndex, endIndex - limit);
        return Option.some(sliceHistoryPage(cached.page, startIndex, endIndex));
      }),
    loadTotalMessages: (environmentId, threadId) =>
      Effect.sync(() => {
        let totalMessages: number | null = null;
        for (const [, cached] of pages.entries()) {
          if (cached.environmentId === environmentId && cached.threadId === threadId) {
            totalMessages = Math.max(totalMessages ?? 0, cached.page.messageHistory.totalMessages);
          }
        }
        return Option.fromNullishOr(totalMessages);
      }),
    save: (environmentId, threadId, page) =>
      Effect.sync(() => {
        if (page.messages.length === 0) {
          return;
        }
        const key = `${environmentId}:${threadId}:${page.messageHistory.startIndex}:${page.messageHistory.endIndex}`;
        pages.set(key, { environmentId, threadId, page }, 1);
      }),
    remove: (environmentId, threadId) =>
      Effect.sync(() => {
        for (const [key, cached] of pages.entries()) {
          if (cached.environmentId === environmentId && cached.threadId === threadId) {
            pages.delete(key);
          }
        }
      }),
    clear: (environmentId) =>
      Effect.sync(() => {
        for (const [key, cached] of pages.entries()) {
          if (cached.environmentId === environmentId) {
            pages.delete(key);
          }
        }
      }),
  });
}
