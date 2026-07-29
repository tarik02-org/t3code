import { ThreadHistoryCacheStore } from "@t3tools/client-runtime/platform";
import {
  type EnvironmentId,
  type OrchestrationThreadHistoryPage,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

const MAX_CACHED_HISTORY_PAGES = 12;

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

export function make() {
  const pages = new Map<string, CachedHistoryPage>();

  const touch = (key: string, cached: CachedHistoryPage) => {
    pages.delete(key);
    pages.set(key, cached);
  };

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
          touch(key, cached);
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
          touch(key, cached);
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
        touch(key, cached);
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
        for (const cached of pages.values()) {
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
        pages.delete(key);
        pages.set(key, { environmentId, threadId, page });
        if (pages.size > MAX_CACHED_HISTORY_PAGES) {
          const oldestKey = pages.keys().next().value;
          if (oldestKey !== undefined) {
            pages.delete(oldestKey);
          }
        }
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

export const layer = Layer.succeed(ThreadHistoryCacheStore, make());
