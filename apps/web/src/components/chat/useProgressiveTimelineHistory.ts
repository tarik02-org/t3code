import { type MessageId, type OrchestrationThreadMessageHistory } from "@t3tools/contracts";
import { type LegendListRef } from "@legendapp/list/react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  type RefObject,
  type TouchEvent as ReactTouchEvent,
  type WheelEvent as ReactWheelEvent,
} from "react";
import { resolveTimelineIsAtEnd, type MessagesTimelineRow } from "./MessagesTimeline.logic";

const HISTORY_EDGE_THRESHOLD = 640;
const MANUAL_INPUT_IDLE_MS = 240;
const PREPEND_ANCHOR_STABLE_FRAMES = 12;

export interface TimelineHistoryNavigationTarget {
  readonly id: MessageId;
  readonly messageIndex: number | null;
  readonly rowIndex: number | null;
}

type HistoryPageDirection = "before" | "after";

interface HistoryPageRequest {
  readonly direction: HistoryPageDirection;
}

interface HistoryPrependAnchor {
  readonly request: HistoryPageRequest;
  readonly startIndex: number;
  distanceFromBottom: number;
  rowId: string | null;
  viewportOffset: number;
}

function resolveVisibleTimelineRowAnchor(scrollNode: HTMLElement) {
  const viewport = scrollNode.getBoundingClientRect();
  let intersecting: { readonly rowId: string; readonly viewportOffset: number } | null = null;
  let starting: { readonly rowId: string; readonly viewportOffset: number } | null = null;
  for (const element of scrollNode.querySelectorAll<HTMLElement>("[data-timeline-row-id]")) {
    const rect = element.getBoundingClientRect();
    const rowId = element.dataset.timelineRowId;
    if (rowId === undefined || rect.bottom <= viewport.top || rect.top >= viewport.bottom) {
      continue;
    }
    const viewportOffset = rect.top - viewport.top;
    if (intersecting === null || viewportOffset < intersecting.viewportOffset) {
      intersecting = { rowId, viewportOffset };
    }
    if (viewportOffset >= 0 && (starting === null || viewportOffset < starting.viewportOffset)) {
      starting = { rowId, viewportOffset };
    }
  }
  return starting ?? intersecting;
}

interface UseProgressiveTimelineHistoryInput {
  readonly historyTargetMessageId: MessageId | null;
  readonly isLoadingNextMessages: boolean;
  readonly isLoadingPreviousMessages: boolean;
  readonly latestMessagesRequest: number;
  readonly listRef: RefObject<LegendListRef | null>;
  readonly messageHistory: OrchestrationThreadMessageHistory | undefined;
  readonly minimapItems: ReadonlyArray<TimelineHistoryNavigationTarget>;
  readonly minimapPositionRef: RefObject<HTMLSpanElement | null>;
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
  minimapItems,
  minimapPositionRef,
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
  const prependAnchorRef = useRef<HistoryPrependAnchor | null>(null);
  const manualInputRef = useRef(false);
  const manualInputTimeoutRef = useRef<number | null>(null);
  const lastScrollTopRef = useRef<number | null>(null);
  const initializedThreadRef = useRef<string | null>(null);
  const handledLatestMessagesRequestRef = useRef(latestMessagesRequest);
  const latestPositionPendingRef = useRef(false);
  const followEndRef = useRef(true);
  const lastTouchYRef = useRef<number | null>(null);
  const pointerActiveRef = useRef(false);
  const positioningTargetRef = useRef<MessageId | null>(null);
  const minimapFrameRef = useRef<number | null>(null);

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
  const loadedMessageIndexById = useMemo(() => {
    const indexes = new Map<string, number>();
    let messageIndex = 0;
    for (const row of rows) {
      if (row.kind !== "message") {
        continue;
      }
      indexes.set(row.message.id, messageIndex);
      messageIndex += 1;
    }
    return indexes;
  }, [rows]);

  const requestPage = useCallback(
    (direction: HistoryPageDirection) => {
      if (messageHistory === undefined || pageRequestRef.current !== null) {
        return;
      }
      const load = direction === "before" ? onLoadPreviousMessages : onLoadNextMessages;
      if (load === undefined) {
        return;
      }

      const request = { direction };
      pageRequestRef.current = request;
      if (direction === "before") {
        const scrollNode = listRef.current?.getScrollableNode();
        if (scrollNode !== null && scrollNode !== undefined) {
          const rowAnchor = resolveVisibleTimelineRowAnchor(scrollNode);
          prependAnchorRef.current = {
            request,
            startIndex: messageHistory.startIndex,
            distanceFromBottom: scrollNode.scrollHeight - scrollNode.scrollTop,
            rowId: rowAnchor?.rowId ?? null,
            viewportOffset: rowAnchor?.viewportOffset ?? 0,
          };
        }
      }
      void load()
        .then((loaded) => {
          if (!loaded && prependAnchorRef.current?.request === request) {
            prependAnchorRef.current = null;
          }
        })
        .finally(() => {
          if (pageRequestRef.current === request) {
            pageRequestRef.current = null;
          }
        });
    },
    [listRef, messageHistory, onLoadNextMessages, onLoadPreviousMessages],
  );

  const requestPageNearEdge = useCallback(
    (direction: HistoryPageDirection) => {
      const scrollNode = listRef.current?.getScrollableNode();
      if (messageHistory === undefined || scrollNode === null || scrollNode === undefined) {
        return;
      }
      if (
        direction === "before" &&
        scrollNode.scrollTop <= HISTORY_EDGE_THRESHOLD &&
        messageHistory.hasMoreBefore &&
        !isLoadingPreviousMessages
      ) {
        requestPage("before");
      } else if (
        direction === "after" &&
        scrollNode.scrollHeight - scrollNode.clientHeight - scrollNode.scrollTop <=
          HISTORY_EDGE_THRESHOLD &&
        messageHistory.hasMoreAfter &&
        !isLoadingNextMessages
      ) {
        requestPage("after");
      }
    },
    [isLoadingNextMessages, isLoadingPreviousMessages, listRef, messageHistory, requestPage],
  );

  const updateMinimap = useCallback(() => {
    const scrollNode = listRef.current?.getScrollableNode();
    if (scrollNode === null || scrollNode === undefined) {
      return;
    }
    const viewport = scrollNode.getBoundingClientRect();
    const viewportCenter = viewport.top + viewport.height / 2;
    const messageRects = new Map<string, DOMRect>();
    let visibleMessageId: string | null = null;
    let visibleMessageDistance = Number.POSITIVE_INFINITY;
    for (const element of scrollNode.querySelectorAll<HTMLElement>("[data-message-id]")) {
      const rect = element.getBoundingClientRect();
      const messageId = element.dataset.messageId;
      if (messageId !== undefined) {
        messageRects.set(messageId, rect);
      }
      if (rect.bottom <= viewport.top || rect.top >= viewport.bottom) {
        continue;
      }
      const distance = Math.abs((rect.top + rect.bottom) / 2 - viewportCenter);
      if (messageId !== undefined && distance < visibleMessageDistance) {
        visibleMessageId = messageId;
        visibleMessageDistance = distance;
      }
    }
    for (const item of minimapItems) {
      const strip = minimapStripMap.get(item.id);
      if (strip === undefined || item.rowIndex === null) {
        continue;
      }
      const rect = messageRects.get(item.id);
      strip.dataset.inView =
        rect !== undefined && rect.bottom > viewport.top && rect.top < viewport.bottom
          ? "true"
          : "false";
    }

    const positionMarker = minimapPositionRef.current;
    if (positionMarker === null) {
      return;
    }
    positionMarker.style.opacity = "0";
    if (messageHistory === undefined || minimapItems.length < 2) {
      return;
    }
    const loadedMessageIndex =
      visibleMessageId === null ? undefined : loadedMessageIndexById.get(visibleMessageId);
    if (loadedMessageIndex === undefined) {
      return;
    }

    const globalMessageIndex = messageHistory.startIndex + loadedMessageIndex;
    let progress = globalMessageIndex / Math.max(1, messageHistory.totalMessages - 1);
    let previousItemIndex: number | null = null;
    for (let index = 0; index < minimapItems.length; index += 1) {
      const itemMessageIndex = minimapItems[index]?.messageIndex;
      if (itemMessageIndex === null || itemMessageIndex === undefined) {
        continue;
      }
      if (itemMessageIndex >= globalMessageIndex) {
        if (previousItemIndex === null) {
          progress = index / (minimapItems.length - 1);
        } else {
          const previousMessageIndex = minimapItems[previousItemIndex]?.messageIndex;
          progress =
            previousMessageIndex === null || previousMessageIndex === undefined
              ? progress
              : (previousItemIndex +
                  (globalMessageIndex - previousMessageIndex) /
                    Math.max(1, itemMessageIndex - previousMessageIndex)) /
                (minimapItems.length - 1);
        }
        break;
      }
      previousItemIndex = index;
      if (index === minimapItems.length - 1) {
        progress = 1;
      }
    }
    positionMarker.style.top = `${Math.max(0, Math.min(1, progress)) * 100}%`;
    positionMarker.style.opacity = "1";
  }, [
    listRef,
    loadedMessageIndexById,
    messageHistory,
    minimapItems,
    minimapPositionRef,
    minimapStripMap,
  ]);

  const scheduleMinimapUpdate = useCallback(() => {
    if (minimapFrameRef.current !== null) {
      return;
    }
    minimapFrameRef.current = requestAnimationFrame(() => {
      minimapFrameRef.current = null;
      updateMinimap();
    });
  }, [updateMinimap]);

  const beginUserNavigation = useCallback(() => {
    scheduleMinimapUpdate();
    if (
      prependAnchorRef.current !== null &&
      messageHistory !== undefined &&
      messageHistory.startIndex < prependAnchorRef.current.startIndex
    ) {
      prependAnchorRef.current = null;
    }
    manualInputRef.current = true;
    followEndRef.current = false;
    if (positioningTargetRef.current !== null) {
      positioningTargetRef.current = null;
      const scrollOffset = listRef.current?.getState().scroll;
      if (scrollOffset !== undefined) {
        void listRef.current?.scrollToOffset({ offset: scrollOffset, animated: false });
      }
    }
    if (historyTargetMessageId !== null) {
      onHistoryTargetReady?.();
    }
    onManualNavigation(true);
    if (manualInputTimeoutRef.current !== null) {
      window.clearTimeout(manualInputTimeoutRef.current);
    }
    manualInputTimeoutRef.current = window.setTimeout(() => {
      manualInputTimeoutRef.current = null;
      manualInputRef.current = false;
    }, MANUAL_INPUT_IDLE_MS);
  }, [
    historyTargetMessageId,
    listRef,
    messageHistory,
    onHistoryTargetReady,
    onManualNavigation,
    scheduleMinimapUpdate,
  ]);

  useLayoutEffect(() => {
    updateMinimap();
    const prependAnchor = prependAnchorRef.current;
    if (
      prependAnchor === null ||
      messageHistory === undefined ||
      isLoadingPreviousMessages ||
      messageHistory.startIndex >= prependAnchor.startIndex
    ) {
      return;
    }

    let frame: number | null = null;
    let previousScrollHeight: number | null = null;
    let stableFrames = 0;
    const reconcile = () => {
      if (prependAnchorRef.current !== prependAnchor) {
        return;
      }
      const scrollNode = listRef.current?.getScrollableNode();
      if (scrollNode === null || scrollNode === undefined) {
        return;
      }

      const scrollHeight = scrollNode.scrollHeight;
      const viewport = scrollNode.getBoundingClientRect();
      const anchorElement =
        prependAnchor.rowId === null
          ? null
          : scrollNode.querySelector<HTMLElement>(
              `[data-timeline-row-id="${CSS.escape(prependAnchor.rowId)}"]`,
            );
      const anchorOffset =
        anchorElement === null ? null : anchorElement.getBoundingClientRect().top - viewport.top;
      stableFrames =
        previousScrollHeight !== null &&
        Math.abs(scrollHeight - previousScrollHeight) <= 1 &&
        (anchorOffset === null || Math.abs(anchorOffset - prependAnchor.viewportOffset) <= 1)
          ? stableFrames + 1
          : 0;
      previousScrollHeight = scrollHeight;
      if (anchorOffset !== null) {
        const scrollTop = scrollNode.scrollTop + anchorOffset - prependAnchor.viewportOffset;
        scrollNode.scrollTop = scrollTop;
        lastScrollTopRef.current = scrollNode.scrollTop;
      } else if (
        scrollHeight >= prependAnchor.distanceFromBottom ||
        stableFrames >= PREPEND_ANCHOR_STABLE_FRAMES
      ) {
        const scrollTop = Math.max(0, scrollHeight - prependAnchor.distanceFromBottom);
        scrollNode.scrollTop = scrollTop;
        lastScrollTopRef.current = scrollNode.scrollTop;
      }
      if (stableFrames >= PREPEND_ANCHOR_STABLE_FRAMES) {
        prependAnchorRef.current = null;
        scheduleMinimapUpdate();
        return;
      }
      frame = requestAnimationFrame(reconcile);
    };
    reconcile();
    return () => {
      if (frame !== null) {
        cancelAnimationFrame(frame);
      }
    };
  }, [
    isLoadingPreviousMessages,
    listRef,
    messageHistory,
    rows,
    scheduleMinimapUpdate,
    updateMinimap,
  ]);

  const beginPointerNavigation = useCallback(() => {
    pointerActiveRef.current = true;
    beginUserNavigation();
  }, [beginUserNavigation]);

  const beginTouchNavigation = useCallback(
    (event: ReactTouchEvent<HTMLDivElement>) => {
      beginUserNavigation();
      lastTouchYRef.current = event.touches.item(0)?.clientY ?? null;
    },
    [beginUserNavigation],
  );

  const continueTouchNavigation = useCallback(
    (event: ReactTouchEvent<HTMLDivElement>) => {
      beginUserNavigation();
      const touchY = event.touches.item(0)?.clientY;
      const previousTouchY = lastTouchYRef.current;
      lastTouchYRef.current = touchY ?? null;
      if (touchY === undefined || previousTouchY === null) {
        return;
      }
      const scrollNode = listRef.current?.getScrollableNode();
      if (touchY > previousTouchY && scrollNode?.scrollTop === 0) {
        requestPageNearEdge("before");
      } else if (
        touchY < previousTouchY &&
        scrollNode !== null &&
        scrollNode !== undefined &&
        scrollNode.scrollHeight - scrollNode.clientHeight - scrollNode.scrollTop <= 1
      ) {
        requestPageNearEdge("after");
      }
    },
    [beginUserNavigation, listRef, requestPageNearEdge],
  );

  const handleWheelNavigation = useCallback(
    (event: ReactWheelEvent<HTMLDivElement>) => {
      beginUserNavigation();
      const scrollNode = listRef.current?.getScrollableNode();
      if (event.deltaY < 0 && scrollNode?.scrollTop === 0) {
        requestPageNearEdge("before");
      } else if (
        event.deltaY > 0 &&
        scrollNode !== null &&
        scrollNode !== undefined &&
        scrollNode.scrollHeight - scrollNode.clientHeight - scrollNode.scrollTop <= 1
      ) {
        requestPageNearEdge("after");
      }
    },
    [beginUserNavigation, listRef, requestPageNearEdge],
  );

  const handleScroll = useCallback(() => {
    const list = listRef.current;
    const state = list?.getState();
    const scrollNode = list?.getScrollableNode();
    const localIsAtEnd = resolveTimelineIsAtEnd(state);
    if (localIsAtEnd !== undefined) {
      const isAtEnd =
        messageHistory === undefined ? localIsAtEnd : localIsAtEnd && !messageHistory.hasMoreAfter;
      onIsAtEndChange(isAtEnd);
      if (isAtEnd) {
        followEndRef.current = true;
      }
    }
    scheduleMinimapUpdate();
    if (messageHistory === undefined || scrollNode === null || scrollNode === undefined) {
      return;
    }

    const scrollTop = scrollNode.scrollTop;
    const previousScrollTop = lastScrollTopRef.current;
    lastScrollTopRef.current = scrollTop;
    const prependAnchor = prependAnchorRef.current;
    if (prependAnchor !== null && messageHistory.startIndex === prependAnchor.startIndex) {
      const loadingSkeleton = scrollNode.querySelector<HTMLElement>("[data-history-skeletons]");
      if (loadingSkeleton === null) {
        const rowAnchor = resolveVisibleTimelineRowAnchor(scrollNode);
        prependAnchor.distanceFromBottom = scrollNode.scrollHeight - scrollTop;
        prependAnchor.rowId = rowAnchor?.rowId ?? null;
        prependAnchor.viewportOffset = rowAnchor?.viewportOffset ?? 0;
      }
    }
    if (scrollTop <= 1) {
      requestPageNearEdge("before");
    } else if (scrollNode.scrollHeight - scrollNode.clientHeight - scrollTop <= 1) {
      requestPageNearEdge("after");
    }
    if ((!manualInputRef.current && !pointerActiveRef.current) || previousScrollTop === null) {
      return;
    }

    const delta = scrollTop - previousScrollTop;
    if (delta < 0) {
      requestPageNearEdge("before");
    } else if (delta > 0) {
      requestPageNearEdge("after");
    }
  }, [listRef, messageHistory, onIsAtEndChange, requestPageNearEdge, scheduleMinimapUpdate]);

  const selectHistoryTarget = useCallback(
    (item: TimelineHistoryNavigationTarget) => {
      onManualNavigation(false);
      followEndRef.current = false;
      pageRequestRef.current = null;
      prependAnchorRef.current = null;
      const rowIndex = rowIndexByMessageId.get(item.id);
      const list = listRef.current;
      if (rowIndex !== undefined && list !== null) {
        positioningTargetRef.current = item.id;
        void list
          .scrollToIndex({
            index: rowIndex,
            animated: true,
            viewPosition: 0.5,
          })
          .then(() => {
            if (positioningTargetRef.current === item.id) {
              positioningTargetRef.current = null;
            }
          });
        return;
      }
      onSelectHistoryMessage?.(item.id);
    },
    [listRef, onManualNavigation, onSelectHistoryMessage, rowIndexByMessageId],
  );

  useLayoutEffect(() => {
    if (historyTargetMessageId === null) {
      positioningTargetRef.current = null;
      return;
    }
    if (positioningTargetRef.current === historyTargetMessageId) {
      return;
    }
    const rowIndex = rowIndexByMessageId.get(historyTargetMessageId);
    const list = listRef.current;
    if (rowIndex === undefined || list === null) {
      return;
    }

    positioningTargetRef.current = historyTargetMessageId;
    void list
      .scrollToIndex({
        index: rowIndex,
        animated: false,
        viewPosition: 0.5,
      })
      .then(() => {
        if (positioningTargetRef.current === historyTargetMessageId) {
          positioningTargetRef.current = null;
          onHistoryTargetReady?.();
        }
      });
  }, [historyTargetMessageId, listRef, onHistoryTargetReady, rowIndexByMessageId]);

  useLayoutEffect(() => {
    if (initializedThreadRef.current !== routeThreadKey) {
      initializedThreadRef.current = routeThreadKey;
      pageRequestRef.current = null;
      prependAnchorRef.current = null;
      positioningTargetRef.current = null;
      lastScrollTopRef.current = null;
      followEndRef.current = true;
    }
    if (handledLatestMessagesRequestRef.current !== latestMessagesRequest) {
      handledLatestMessagesRequestRef.current = latestMessagesRequest;
      latestPositionPendingRef.current = true;
      followEndRef.current = true;
      pageRequestRef.current = null;
      prependAnchorRef.current = null;
      positioningTargetRef.current = null;
    }
    if (
      messageHistory === undefined ||
      messageHistory.hasMoreAfter ||
      (!followEndRef.current && !latestPositionPendingRef.current)
    ) {
      return;
    }

    latestPositionPendingRef.current = false;
    void listRef.current?.scrollToEnd({ animated: false }).then(scheduleMinimapUpdate);
  }, [latestMessagesRequest, listRef, messageHistory, routeThreadKey, rows, scheduleMinimapUpdate]);

  useEffect(() => {
    scheduleMinimapUpdate();
  }, [rows.length, scheduleMinimapUpdate]);

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
      if (
        ["PageUp", "Home", "ArrowUp"].includes(event.key) ||
        (event.key === " " && event.shiftKey)
      ) {
        if (scrollNode?.scrollTop === 0) {
          requestPageNearEdge("before");
        }
      } else if (
        scrollNode !== null &&
        scrollNode !== undefined &&
        scrollNode.scrollHeight - scrollNode.clientHeight - scrollNode.scrollTop <= 1
      ) {
        requestPageNearEdge("after");
      }
    };
    window.addEventListener("keydown", handleKeyboardNavigation, true);
    return () => {
      window.removeEventListener("keydown", handleKeyboardNavigation, true);
    };
  }, [beginUserNavigation, listRef, requestPageNearEdge]);

  useEffect(
    () => () => {
      if (manualInputTimeoutRef.current !== null) {
        window.clearTimeout(manualInputTimeoutRef.current);
      }
      if (minimapFrameRef.current !== null) {
        cancelAnimationFrame(minimapFrameRef.current);
        minimapFrameRef.current = null;
      }
    },
    [],
  );

  useEffect(() => {
    const endPointerNavigation = () => {
      pointerActiveRef.current = false;
    };
    window.addEventListener("pointerup", endPointerNavigation, true);
    window.addEventListener("pointercancel", endPointerNavigation, true);
    return () => {
      window.removeEventListener("pointerup", endPointerNavigation, true);
      window.removeEventListener("pointercancel", endPointerNavigation, true);
    };
  }, []);

  return useMemo(
    () => ({
      beginPointerNavigation,
      beginTouchNavigation,
      continueTouchNavigation,
      handleScroll,
      handleWheelNavigation,
      selectHistoryTarget,
    }),
    [
      beginPointerNavigation,
      beginTouchNavigation,
      continueTouchNavigation,
      handleScroll,
      handleWheelNavigation,
      selectHistoryTarget,
    ],
  );
}
