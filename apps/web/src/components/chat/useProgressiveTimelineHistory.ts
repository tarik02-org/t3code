import { type MessageId, type OrchestrationThreadMessageHistory } from "@t3tools/contracts";
import { type LegendListRef } from "@legendapp/list/react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, type RefObject } from "react";
import { resolveTimelineIsAtEnd, type MessagesTimelineRow } from "./MessagesTimeline.logic";

export interface TimelineHistoryNavigationTarget {
  readonly id: MessageId;
  readonly messageIndex: number | null;
  readonly rowIndex: number | null;
}

type HistoryPageDirection = "before" | "after";

const CONFIRM_AT_END_DELAY_MS = 180;

interface HistoryPageRequest {
  readonly direction: HistoryPageDirection;
}

interface HistoryPositioningTarget {
  readonly id: string;
}

interface PrependViewportAnchor {
  readonly id: string;
  readonly offset: number;
  readonly rows: ReadonlyArray<MessagesTimelineRow>;
}

interface UseProgressiveTimelineHistoryInput {
  readonly historyTargetMessageId: MessageId | null;
  readonly isLoadingNextMessages: boolean;
  readonly isLoadingPreviousMessages: boolean;
  readonly latestMessagesRequest: number;
  readonly listRef: RefObject<LegendListRef | null>;
  readonly messageHistory: OrchestrationThreadMessageHistory | undefined;
  readonly minimapStripMap: Map<string, HTMLSpanElement>;
  readonly onHistoryTargetReady: (() => void) | undefined;
  readonly onIsAtEndChange: (isAtEnd: boolean) => void;
  readonly onLoadNextMessages: (() => Promise<boolean>) | undefined;
  readonly onLoadPreviousMessages: (() => Promise<boolean>) | undefined;
  readonly onManualNavigation: (cancelHistoryLoad: boolean) => void;
  readonly onSelectHistoryMessage: ((messageId: MessageId) => void) | undefined;
  readonly routeThreadKey: string;
  readonly rows: ReadonlyArray<MessagesTimelineRow>;
}

export function useProgressiveTimelineHistory({
  historyTargetMessageId,
  isLoadingNextMessages,
  isLoadingPreviousMessages,
  latestMessagesRequest,
  listRef,
  messageHistory,
  minimapStripMap,
  onHistoryTargetReady,
  onIsAtEndChange,
  onLoadNextMessages,
  onLoadPreviousMessages,
  onManualNavigation,
  onSelectHistoryMessage,
  routeThreadKey,
  rows,
}: UseProgressiveTimelineHistoryInput) {
  const pageRequestRef = useRef<HistoryPageRequest | null>(null);
  const initializedThreadRef = useRef<string | null>(null);
  const handledLatestMessagesRequestRef = useRef(latestMessagesRequest);
  const latestPositionPendingRef = useRef(false);
  const positioningTargetRef = useRef<HistoryPositioningTarget | null>(null);
  const prependViewportAnchorRef = useRef<PrependViewportAnchor | null>(null);
  const prependViewportAnchorFrameRef = useRef<number | null>(null);
  const minimapFrameRef = useRef<number | null>(null);
  const confirmAtEndTimerRef = useRef<number | null>(null);
  const visibleMinimapIdsRef = useRef<ReadonlySet<string>>(new Set());

  const cancelAtEndConfirmation = useCallback(() => {
    if (confirmAtEndTimerRef.current !== null) {
      window.clearTimeout(confirmAtEndTimerRef.current);
      confirmAtEndTimerRef.current = null;
    }
  }, []);

  const rowIndexByMessageId = useMemo(() => {
    const indexes = new Map<MessageId, number>();
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      if (row?.kind === "message") {
        indexes.set(row.message.id, index);
      }
    }
    return indexes;
  }, [rows]);

  const capturePrependViewportAnchor = useCallback(() => {
    const scrollNode = listRef.current?.getScrollableNode();
    if (scrollNode === null || scrollNode === undefined) {
      return;
    }
    const viewport = scrollNode.getBoundingClientRect();
    const visibleRows = Array.from(
      scrollNode.querySelectorAll<HTMLElement>("[data-timeline-row-id]"),
    ).filter((element) => {
      const rect = element.getBoundingClientRect();
      return rect.bottom > viewport.top && rect.top < viewport.bottom;
    });
    const element =
      visibleRows.find((candidate) => candidate.dataset.messageRole === "user") ??
      visibleRows.find((candidate) => candidate.dataset.timelineRowKind === "turn-fold") ??
      visibleRows.find((candidate) => candidate.dataset.timelineRowKind === "goal") ??
      visibleRows.find((candidate) => candidate.dataset.timelineRowKind === "message") ??
      visibleRows[0];
    const id = element?.dataset.timelineRowId;
    if (element !== undefined && id !== undefined) {
      prependViewportAnchorRef.current = {
        id,
        offset: element.getBoundingClientRect().top - viewport.top,
        rows,
      };
    }
  }, [listRef, rows]);

  const stopPrependViewportAnchorTracking = useCallback(() => {
    if (prependViewportAnchorFrameRef.current !== null) {
      cancelAnimationFrame(prependViewportAnchorFrameRef.current);
      prependViewportAnchorFrameRef.current = null;
    }
  }, []);

  const trackPrependViewportAnchor = useCallback(() => {
    stopPrependViewportAnchorTracking();
    const track = () => {
      const anchorRows = prependViewportAnchorRef.current?.rows;
      if (
        pageRequestRef.current?.direction !== "before" ||
        (anchorRows !== undefined && anchorRows !== rows)
      ) {
        prependViewportAnchorFrameRef.current = null;
        return;
      }
      capturePrependViewportAnchor();
      prependViewportAnchorFrameRef.current = requestAnimationFrame(track);
    };
    prependViewportAnchorFrameRef.current = requestAnimationFrame(track);
  }, [capturePrependViewportAnchor, rows, stopPrependViewportAnchorTracking]);

  const requestPage = useCallback(
    (direction: HistoryPageDirection) => {
      if (messageHistory === undefined || pageRequestRef.current !== null) {
        return;
      }
      const isBefore = direction === "before";
      if (
        (isBefore && (!messageHistory.hasMoreBefore || isLoadingPreviousMessages)) ||
        (!isBefore && (!messageHistory.hasMoreAfter || isLoadingNextMessages))
      ) {
        return;
      }
      const load = isBefore ? onLoadPreviousMessages : onLoadNextMessages;
      if (load === undefined) {
        return;
      }

      const request = { direction };
      pageRequestRef.current = request;
      if (isBefore) {
        capturePrependViewportAnchor();
        trackPrependViewportAnchor();
      }
      cancelAtEndConfirmation();
      onIsAtEndChange(false);
      void load()
        .then((didLoad) => {
          if (!didLoad) {
            prependViewportAnchorRef.current = null;
            stopPrependViewportAnchorTracking();
          }
        })
        .finally(() => {
          if (pageRequestRef.current === request) {
            pageRequestRef.current = null;
          }
        });
    },
    [
      isLoadingNextMessages,
      isLoadingPreviousMessages,
      messageHistory,
      cancelAtEndConfirmation,
      capturePrependViewportAnchor,
      onLoadNextMessages,
      onLoadPreviousMessages,
      onIsAtEndChange,
      stopPrependViewportAnchorTracking,
      trackPrependViewportAnchor,
    ],
  );

  const loadPreviousPage = useCallback(() => {
    requestPage("before");
  }, [requestPage]);

  const loadNextPage = useCallback(() => {
    requestPage("after");
  }, [requestPage]);

  const updateMinimap = useCallback(() => {
    const scrollNode = listRef.current?.getScrollableNode();
    if (scrollNode === null || scrollNode === undefined) {
      return;
    }
    const viewport = scrollNode.getBoundingClientRect();
    const visibleMessageIds = new Set<string>();
    for (const element of scrollNode.querySelectorAll<HTMLElement>("[data-message-id]")) {
      const rect = element.getBoundingClientRect();
      const messageId = element.dataset.messageId;
      if (messageId !== undefined && rect.bottom > viewport.top && rect.top < viewport.bottom) {
        visibleMessageIds.add(messageId);
      }
    }
    for (const messageId of visibleMinimapIdsRef.current) {
      if (!visibleMessageIds.has(messageId)) {
        const strip = minimapStripMap.get(messageId);
        if (strip !== undefined) {
          strip.dataset.inView = "false";
        }
      }
    }
    for (const messageId of visibleMessageIds) {
      const strip = minimapStripMap.get(messageId);
      if (strip !== undefined) {
        strip.dataset.inView = "true";
      }
    }
    visibleMinimapIdsRef.current = visibleMessageIds;
  }, [listRef, minimapStripMap]);

  const scheduleMinimapUpdate = useCallback(() => {
    if (minimapFrameRef.current !== null) {
      return;
    }
    minimapFrameRef.current = requestAnimationFrame(() => {
      minimapFrameRef.current = null;
      updateMinimap();
    });
  }, [updateMinimap]);

  const positionHistoryTarget = useCallback(
    (id: MessageId, rowIndex: number, animated: boolean, onReady?: () => void) => {
      const list = listRef.current;
      if (list === null) {
        return;
      }
      const target = { id };
      positioningTargetRef.current = target;
      void list
        .scrollToIndex({
          index: rowIndex,
          animated,
          viewPosition: 0.5,
        })
        .then(() => {
          if (positioningTargetRef.current !== target) {
            return;
          }
          positioningTargetRef.current = null;
          scheduleMinimapUpdate();
          onReady?.();
        });
    },
    [listRef, scheduleMinimapUpdate],
  );

  const beginUserNavigation = useCallback(() => {
    if (pageRequestRef.current?.direction === "before") {
      capturePrependViewportAnchor();
      trackPrependViewportAnchor();
    } else {
      prependViewportAnchorRef.current = null;
      stopPrependViewportAnchorTracking();
    }
    scheduleMinimapUpdate();
    if (positioningTargetRef.current !== null) {
      positioningTargetRef.current = null;
      const list = listRef.current;
      const scrollOffset = list?.getState().scroll;
      if (list !== null && scrollOffset !== undefined) {
        void list.scrollToOffset({ offset: scrollOffset, animated: false });
      }
    }
    if (historyTargetMessageId !== null) {
      onHistoryTargetReady?.();
    }
    onManualNavigation(true);
  }, [
    capturePrependViewportAnchor,
    historyTargetMessageId,
    listRef,
    onHistoryTargetReady,
    onManualNavigation,
    scheduleMinimapUpdate,
    stopPrependViewportAnchorTracking,
    trackPrependViewportAnchor,
  ]);

  const handleScroll = useCallback(() => {
    const localIsAtEnd = resolveTimelineIsAtEnd(listRef.current?.getState());
    if (localIsAtEnd !== undefined) {
      const isAtEnd =
        messageHistory === undefined ? localIsAtEnd : localIsAtEnd && !messageHistory.hasMoreAfter;
      cancelAtEndConfirmation();
      if (isAtEnd) {
        confirmAtEndTimerRef.current = window.setTimeout(() => {
          confirmAtEndTimerRef.current = null;
          const stableIsAtEnd = resolveTimelineIsAtEnd(listRef.current?.getState());
          onIsAtEndChange(
            stableIsAtEnd === true &&
              (messageHistory === undefined || !messageHistory.hasMoreAfter),
          );
        }, CONFIRM_AT_END_DELAY_MS);
      } else {
        onIsAtEndChange(false);
      }
    }
    scheduleMinimapUpdate();
  }, [cancelAtEndConfirmation, listRef, messageHistory, onIsAtEndChange, scheduleMinimapUpdate]);

  const selectHistoryTarget = useCallback(
    (item: TimelineHistoryNavigationTarget) => {
      onManualNavigation(false);
      const rowIndex = rowIndexByMessageId.get(item.id);
      if (rowIndex !== undefined) {
        positionHistoryTarget(item.id, rowIndex, true);
        return;
      }
      onSelectHistoryMessage?.(item.id);
    },
    [onManualNavigation, onSelectHistoryMessage, positionHistoryTarget, rowIndexByMessageId],
  );

  useLayoutEffect(() => {
    updateMinimap();
  }, [rows, updateMinimap]);

  useLayoutEffect(() => {
    const anchor = prependViewportAnchorRef.current;
    if (anchor === null || anchor.rows === rows) {
      return;
    }
    stopPrependViewportAnchorTracking();

    const restore = () => {
      const list = listRef.current;
      const scrollNode = list?.getScrollableNode();
      if (list === null || scrollNode === null || scrollNode === undefined) {
        return;
      }
      const viewport = scrollNode.getBoundingClientRect();
      const element = Array.from(
        scrollNode.querySelectorAll<HTMLElement>("[data-timeline-row-id]"),
      ).find((candidate) => candidate.dataset.timelineRowId === anchor.id);
      const currentScroll = scrollNode.scrollTop;
      const index = element === undefined ? rows.findIndex((row) => row.id === anchor.id) : -1;
      if (element === undefined) {
        if (index >= 0 && positioningTargetRef.current?.id !== anchor.id) {
          const target = { id: anchor.id };
          positioningTargetRef.current = target;
          void list
            .scrollToIndex({
              index,
              animated: false,
              viewOffset: anchor.offset,
              viewPosition: 0,
            })
            .finally(() => {
              if (positioningTargetRef.current === target) {
                positioningTargetRef.current = null;
              }
            });
        }
        return;
      }
      if (positioningTargetRef.current?.id === anchor.id) {
        positioningTargetRef.current = null;
        void list.scrollToOffset({ offset: currentScroll, animated: false });
      }
      const nextScroll =
        currentScroll + (element.getBoundingClientRect().top - viewport.top - anchor.offset);
      if (Math.abs(nextScroll - currentScroll) > 1) {
        scrollNode.scrollTop = Math.max(0, nextScroll);
      }
    };
    queueMicrotask(() => {
      if (prependViewportAnchorRef.current !== anchor) {
        return;
      }
      restore();
      let remainingFrames = 2;
      const settle = () => {
        if (prependViewportAnchorRef.current !== anchor) {
          prependViewportAnchorFrameRef.current = null;
          return;
        }
        restore();
        remainingFrames -= 1;
        if (remainingFrames > 0) {
          prependViewportAnchorFrameRef.current = requestAnimationFrame(settle);
        } else {
          prependViewportAnchorRef.current = null;
          prependViewportAnchorFrameRef.current = null;
        }
      };
      prependViewportAnchorFrameRef.current = requestAnimationFrame(settle);
    });
  }, [listRef, rows, stopPrependViewportAnchorTracking]);

  useLayoutEffect(() => {
    if (
      historyTargetMessageId === null ||
      positioningTargetRef.current?.id === historyTargetMessageId
    ) {
      return;
    }
    const rowIndex = rowIndexByMessageId.get(historyTargetMessageId);
    if (rowIndex === undefined) {
      return;
    }
    positionHistoryTarget(historyTargetMessageId, rowIndex, false, onHistoryTargetReady);
  }, [historyTargetMessageId, onHistoryTargetReady, positionHistoryTarget, rowIndexByMessageId]);

  useLayoutEffect(() => {
    if (initializedThreadRef.current === routeThreadKey) {
      return;
    }
    initializedThreadRef.current = routeThreadKey;
    for (const messageId of visibleMinimapIdsRef.current) {
      const strip = minimapStripMap.get(messageId);
      if (strip !== undefined) {
        strip.dataset.inView = "false";
      }
    }
    visibleMinimapIdsRef.current = new Set();
    pageRequestRef.current = null;
    positioningTargetRef.current = null;
    prependViewportAnchorRef.current = null;
    stopPrependViewportAnchorTracking();
    cancelAtEndConfirmation();
    handledLatestMessagesRequestRef.current = latestMessagesRequest;
    latestPositionPendingRef.current = false;
  }, [
    cancelAtEndConfirmation,
    latestMessagesRequest,
    minimapStripMap,
    routeThreadKey,
    stopPrependViewportAnchorTracking,
  ]);

  useLayoutEffect(() => {
    if (handledLatestMessagesRequestRef.current === latestMessagesRequest) {
      return;
    }
    handledLatestMessagesRequestRef.current = latestMessagesRequest;
    latestPositionPendingRef.current = true;
    pageRequestRef.current = null;
    positioningTargetRef.current = null;
  }, [latestMessagesRequest]);

  useLayoutEffect(() => {
    if (
      messageHistory === undefined ||
      messageHistory.hasMoreAfter ||
      !latestPositionPendingRef.current
    ) {
      return;
    }
    latestPositionPendingRef.current = false;
    queueMicrotask(() => {
      const list = listRef.current;
      const scrollNode = list?.getScrollableNode();
      if (list === null || scrollNode === null || scrollNode === undefined) {
        return;
      }
      void list
        .scrollToOffset({
          offset: Math.max(0, scrollNode.scrollHeight - scrollNode.clientHeight),
          animated: false,
        })
        .then(scheduleMinimapUpdate);
    });
  }, [latestMessagesRequest, listRef, messageHistory, rows, scheduleMinimapUpdate]);

  useEffect(() => {
    const handleKeyboardNavigation = (event: KeyboardEvent) => {
      const scrollNode = listRef.current?.getScrollableNode();
      if (
        !["PageUp", "PageDown", "Home", "End", "ArrowUp", "ArrowDown", " "].includes(event.key) ||
        (document.activeElement !== document.body && !scrollNode?.contains(document.activeElement))
      ) {
        return;
      }
      beginUserNavigation();
    };
    window.addEventListener("keydown", handleKeyboardNavigation, true);
    return () => {
      window.removeEventListener("keydown", handleKeyboardNavigation, true);
    };
  }, [beginUserNavigation, listRef]);

  useEffect(
    () => () => {
      cancelAtEndConfirmation();
      stopPrependViewportAnchorTracking();
      if (minimapFrameRef.current !== null) {
        cancelAnimationFrame(minimapFrameRef.current);
        minimapFrameRef.current = null;
      }
    },
    [cancelAtEndConfirmation, stopPrependViewportAnchorTracking],
  );

  return useMemo(
    () => ({
      beginUserNavigation,
      handleScroll,
      loadNextPage,
      loadPreviousPage,
      selectHistoryTarget,
    }),
    [beginUserNavigation, handleScroll, loadNextPage, loadPreviousPage, selectHistoryTarget],
  );
}
