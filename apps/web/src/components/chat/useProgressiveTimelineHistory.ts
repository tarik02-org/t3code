import { type MessageId, type OrchestrationThreadMessageHistory } from "@t3tools/contracts";
import { type LegendListRef } from "@legendapp/list/react";
import { type Virtualizer } from "@tanstack/react-virtual";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  type TouchEvent as ReactTouchEvent,
  type WheelEvent as ReactWheelEvent,
} from "react";
import { resolveTimelineIsAtEnd, type MessagesTimelineRow } from "./MessagesTimeline.logic";

const HISTORY_EDGE_THRESHOLD = 640;
const MANUAL_INPUT_IDLE_MS = 240;
const MESSAGE_VIEWPORT_OFFSET = 24;

export interface TimelineHistoryNavigationTarget {
  readonly id: MessageId;
  readonly messageIndex: number | null;
  readonly rowIndex: number | null;
}

type HistoryPageDirection = "before" | "after";

interface HistoryPageAnchor {
  readonly direction: HistoryPageDirection;
  readonly originWindowKey: string;
  readonly messageId: MessageId;
  readonly viewportOffset: number;
}

interface UseProgressiveTimelineHistoryInput {
  readonly historyScrollElement: HTMLDivElement | null;
  readonly historyTargetMessageId: MessageId | null;
  readonly historyVirtualizer: Virtualizer<HTMLDivElement, HTMLDivElement>;
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
  readonly onManualNavigation: () => void;
  readonly onSelectHistoryMessage: ((messageId: MessageId) => void) | undefined;
  readonly routeThreadKey: string;
  readonly rows: ReadonlyArray<MessagesTimelineRow>;
}

export function useProgressiveTimelineHistory({
  historyScrollElement,
  historyTargetMessageId,
  historyVirtualizer,
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
  const pendingPageAnchorRef = useRef<HistoryPageAnchor | null>(null);
  const activeMessageAnchorRef = useRef<{
    readonly messageId: MessageId;
    readonly viewportOffset: number;
  } | null>(null);
  const pageRequestDirectionRef = useRef<HistoryPageDirection | null>(null);
  const pageRequestHadLoadingRef = useRef(false);
  const manualInputRef = useRef(false);
  const manualInputTimeoutRef = useRef<number | null>(null);
  const ignoreScrollRef = useRef(false);
  const ignoreScrollFrameRef = useRef<number | null>(null);
  const alignmentFrameRef = useRef<number | null>(null);
  const alignmentGenerationRef = useRef(0);
  const lastScrollTopRef = useRef<number | null>(null);
  const initializedThreadRef = useRef<string | null>(null);
  const handledLatestMessagesRequestRef = useRef(latestMessagesRequest);
  const latestPositionPendingRef = useRef(false);
  const followEndRef = useRef(true);
  const lastTouchYRef = useRef<number | null>(null);

  const historyWindowKey =
    messageHistory === undefined
      ? null
      : `${messageHistory.startIndex}:${messageHistory.endIndex}:${messageHistory.totalMessages}`;
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
    const indexes = new Map<MessageId, number>();
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

  const markProgrammaticScroll = useCallback(() => {
    ignoreScrollRef.current = true;
    if (ignoreScrollFrameRef.current !== null) {
      cancelAnimationFrame(ignoreScrollFrameRef.current);
    }
    ignoreScrollFrameRef.current = requestAnimationFrame(() => {
      ignoreScrollFrameRef.current = null;
      ignoreScrollRef.current = false;
    });
  }, []);

  const cancelAlignment = useCallback(() => {
    alignmentGenerationRef.current += 1;
    if (alignmentFrameRef.current !== null) {
      cancelAnimationFrame(alignmentFrameRef.current);
      alignmentFrameRef.current = null;
    }
  }, []);

  const alignMessage = useCallback(
    (messageId: MessageId, viewportOffset: number, onAligned?: () => void) => {
      const scrollNode = historyScrollElement;
      const rowIndex = rowIndexByMessageId.get(messageId);
      if (scrollNode === null || rowIndex === undefined) {
        return false;
      }

      cancelAlignment();
      const generation = alignmentGenerationRef.current;
      const offset = historyVirtualizer.getOffsetForIndex(rowIndex, "start")?.[0];
      if (offset !== undefined) {
        markProgrammaticScroll();
        scrollNode.scrollTop = Math.max(0, offset - viewportOffset);
      }

      const correctMeasuredOffset = (remainingFrames: number) => {
        alignmentFrameRef.current = requestAnimationFrame(() => {
          alignmentFrameRef.current = null;
          if (generation !== alignmentGenerationRef.current) {
            return;
          }
          const target = scrollNode.querySelector<HTMLElement>(
            `[data-message-id="${CSS.escape(messageId)}"]`,
          );
          if (target === null) {
            if (remainingFrames > 0) {
              correctMeasuredOffset(remainingFrames - 1);
            }
            return;
          }

          const delta =
            target.getBoundingClientRect().top -
            scrollNode.getBoundingClientRect().top -
            viewportOffset;
          if (Math.abs(delta) > 1 && remainingFrames > 0) {
            markProgrammaticScroll();
            scrollNode.scrollTop += delta;
            correctMeasuredOffset(remainingFrames - 1);
            return;
          }
          onAligned?.();
        });
      };
      correctMeasuredOffset(6);
      return true;
    },
    [
      cancelAlignment,
      historyScrollElement,
      historyVirtualizer,
      markProgrammaticScroll,
      rowIndexByMessageId,
    ],
  );

  const captureVisibleAnchor = useCallback((): HistoryPageAnchor | null => {
    if (historyScrollElement === null || historyWindowKey === null) {
      return null;
    }
    const viewport = historyScrollElement.getBoundingClientRect();
    let anchorElement: HTMLElement | null = null;
    for (const element of historyScrollElement.querySelectorAll<HTMLElement>("[data-message-id]")) {
      const rect = element.getBoundingClientRect();
      if (rect.bottom <= viewport.top || rect.top >= viewport.bottom) {
        continue;
      }
      if (anchorElement === null || rect.top < anchorElement.getBoundingClientRect().top) {
        anchorElement = element;
      }
    }
    const messageId = anchorElement?.dataset.messageId as MessageId | undefined;
    if (anchorElement !== null && messageId !== undefined) {
      return {
        direction: "before",
        originWindowKey: historyWindowKey,
        messageId,
        viewportOffset:
          anchorElement.getBoundingClientRect().top -
          historyScrollElement.getBoundingClientRect().top,
      };
    }

    const virtualItem = historyVirtualizer.getVirtualItemForOffset(historyScrollElement.scrollTop);
    if (virtualItem === undefined) {
      return null;
    }
    let rowIndex = virtualItem.index;
    while (rowIndex < rows.length && rows[rowIndex]?.kind !== "message") {
      rowIndex += 1;
    }
    if (rowIndex === rows.length) {
      rowIndex = virtualItem.index - 1;
      while (rowIndex >= 0 && rows[rowIndex]?.kind !== "message") {
        rowIndex -= 1;
      }
    }
    const row = rows[rowIndex];
    const rowOffset = historyVirtualizer.getOffsetForIndex(rowIndex, "start")?.[0];
    if (row?.kind !== "message" || rowOffset === undefined) {
      return null;
    }
    return {
      direction: "before",
      originWindowKey: historyWindowKey,
      messageId: row.message.id,
      viewportOffset: rowOffset - historyScrollElement.scrollTop,
    };
  }, [historyScrollElement, historyVirtualizer, historyWindowKey, rows]);

  const requestPage = useCallback(
    (direction: HistoryPageDirection) => {
      if (
        messageHistory === undefined ||
        historyWindowKey === null ||
        pageRequestDirectionRef.current !== null ||
        pendingPageAnchorRef.current !== null
      ) {
        return;
      }
      const anchor = captureVisibleAnchor();
      const load = direction === "before" ? onLoadPreviousMessages : onLoadNextMessages;
      if (anchor === null || load === undefined) {
        return;
      }

      pendingPageAnchorRef.current = { ...anchor, direction };
      pageRequestDirectionRef.current = direction;
      pageRequestHadLoadingRef.current = false;
      void load().then((loaded) => {
        if (pageRequestDirectionRef.current !== direction) {
          return;
        }
        pageRequestDirectionRef.current = null;
        if (!loaded) {
          pendingPageAnchorRef.current = null;
          pageRequestHadLoadingRef.current = false;
        }
      });
    },
    [
      captureVisibleAnchor,
      historyWindowKey,
      messageHistory,
      onLoadNextMessages,
      onLoadPreviousMessages,
    ],
  );

  const requestPageNearEdge = useCallback(
    (direction: HistoryPageDirection) => {
      if (messageHistory === undefined || historyScrollElement === null) {
        return;
      }
      if (
        direction === "before" &&
        historyScrollElement.scrollTop <= HISTORY_EDGE_THRESHOLD &&
        messageHistory.hasMoreBefore &&
        !isLoadingPreviousMessages
      ) {
        requestPage("before");
      } else if (
        direction === "after" &&
        historyScrollElement.scrollHeight -
          historyScrollElement.clientHeight -
          historyScrollElement.scrollTop <=
          HISTORY_EDGE_THRESHOLD &&
        messageHistory.hasMoreAfter &&
        !isLoadingNextMessages
      ) {
        requestPage("after");
      }
    },
    [
      historyScrollElement,
      isLoadingNextMessages,
      isLoadingPreviousMessages,
      messageHistory,
      requestPage,
    ],
  );

  const updateMinimap = useCallback(() => {
    const scrollNode =
      messageHistory === undefined ? listRef.current?.getScrollableNode() : historyScrollElement;
    if (scrollNode === null || scrollNode === undefined) {
      return;
    }
    const viewport = scrollNode.getBoundingClientRect();
    for (const item of minimapItems) {
      const strip = minimapStripMap.get(item.id);
      if (strip === undefined || item.rowIndex === null) {
        continue;
      }
      const row = scrollNode.querySelector<HTMLElement>(
        `[data-message-id="${CSS.escape(item.id)}"]`,
      );
      const rect = row?.getBoundingClientRect();
      strip.dataset.inView =
        rect !== undefined && rect.bottom > viewport.top && rect.top < viewport.bottom
          ? "true"
          : "false";
    }

    const positionMarker = minimapPositionRef.current;
    if (messageHistory === undefined || positionMarker === null || minimapItems.length < 2) {
      return;
    }
    const viewportCenter = viewport.top + viewport.height / 2;
    let visibleMessageId: MessageId | null = null;
    let visibleMessageDistance = Number.POSITIVE_INFINITY;
    for (const element of scrollNode.querySelectorAll<HTMLElement>("[data-message-id]")) {
      const rect = element.getBoundingClientRect();
      const distance = Math.abs((rect.top + rect.bottom) / 2 - viewportCenter);
      if (distance < visibleMessageDistance) {
        visibleMessageId = element.dataset.messageId as MessageId;
        visibleMessageDistance = distance;
      }
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
  }, [
    historyScrollElement,
    listRef,
    loadedMessageIndexById,
    messageHistory,
    minimapItems,
    minimapPositionRef,
    minimapStripMap,
  ]);

  const beginUserNavigation = useCallback(() => {
    manualInputRef.current = true;
    followEndRef.current = false;
    activeMessageAnchorRef.current = null;
    cancelAlignment();
    if (historyTargetMessageId !== null) {
      onHistoryTargetReady?.();
    }
    onManualNavigation();
    if (manualInputTimeoutRef.current !== null) {
      window.clearTimeout(manualInputTimeoutRef.current);
    }
    manualInputTimeoutRef.current = window.setTimeout(() => {
      manualInputTimeoutRef.current = null;
      manualInputRef.current = false;
    }, MANUAL_INPUT_IDLE_MS);
  }, [cancelAlignment, historyTargetMessageId, onHistoryTargetReady, onManualNavigation]);

  const beginPointerNavigation = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      beginUserNavigation();
      if (event.target !== historyScrollElement) {
        return;
      }
      if (historyScrollElement.scrollTop <= HISTORY_EDGE_THRESHOLD) {
        requestPageNearEdge("before");
      } else if (
        historyScrollElement.scrollHeight -
          historyScrollElement.clientHeight -
          historyScrollElement.scrollTop <=
        HISTORY_EDGE_THRESHOLD
      ) {
        requestPageNearEdge("after");
      }
    },
    [beginUserNavigation, historyScrollElement, requestPageNearEdge],
  );

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
      if (touchY > previousTouchY) {
        requestPageNearEdge("before");
      } else if (touchY < previousTouchY) {
        requestPageNearEdge("after");
      }
    },
    [beginUserNavigation, requestPageNearEdge],
  );

  const handleWheelNavigation = useCallback(
    (event: ReactWheelEvent<HTMLDivElement>) => {
      beginUserNavigation();
      if (event.deltaY < 0) {
        requestPageNearEdge("before");
      } else if (event.deltaY > 0) {
        requestPageNearEdge("after");
      }
    },
    [beginUserNavigation, requestPageNearEdge],
  );

  const handleScroll = useCallback(() => {
    const state = messageHistory === undefined ? listRef.current?.getState?.() : undefined;
    const scrollNode =
      messageHistory === undefined ? listRef.current?.getScrollableNode() : historyScrollElement;
    const localIsAtEnd =
      messageHistory === undefined
        ? resolveTimelineIsAtEnd(state)
        : scrollNode === null || scrollNode === undefined
          ? undefined
          : scrollNode.scrollTop + scrollNode.clientHeight >= scrollNode.scrollHeight - 2;
    if (localIsAtEnd !== undefined) {
      const isAtEnd =
        messageHistory === undefined ? localIsAtEnd : localIsAtEnd && !messageHistory.hasMoreAfter;
      onIsAtEndChange(isAtEnd);
      if (isAtEnd) {
        followEndRef.current = true;
      }
    }
    updateMinimap();
    if (messageHistory === undefined || scrollNode === null || scrollNode === undefined) {
      return;
    }

    const scrollTop = scrollNode.scrollTop;
    const previousScrollTop = lastScrollTopRef.current;
    lastScrollTopRef.current = scrollTop;
    if (ignoreScrollRef.current) {
      return;
    }

    const pendingPageAnchor = pendingPageAnchorRef.current;
    if (pendingPageAnchor !== null) {
      const currentAnchor = captureVisibleAnchor();
      if (currentAnchor !== null) {
        pendingPageAnchorRef.current = {
          ...currentAnchor,
          direction: pendingPageAnchor.direction,
          originWindowKey: pendingPageAnchor.originWindowKey,
        };
      }
    }
    if (!manualInputRef.current || previousScrollTop === null) {
      return;
    }

    const delta = scrollTop - previousScrollTop;
    if (delta < 0) {
      requestPageNearEdge("before");
    } else if (delta > 0) {
      requestPageNearEdge("after");
    }
  }, [
    captureVisibleAnchor,
    historyScrollElement,
    listRef,
    messageHistory,
    onIsAtEndChange,
    requestPageNearEdge,
    updateMinimap,
  ]);

  const selectHistoryTarget = useCallback(
    (item: TimelineHistoryNavigationTarget) => {
      onManualNavigation();
      followEndRef.current = false;
      activeMessageAnchorRef.current = {
        messageId: item.id,
        viewportOffset: MESSAGE_VIEWPORT_OFFSET,
      };
      pendingPageAnchorRef.current = null;
      pageRequestDirectionRef.current = null;
      pageRequestHadLoadingRef.current = false;
      if (messageHistory === undefined) {
        if (item.rowIndex !== null) {
          void listRef.current?.scrollToIndex({
            index: item.rowIndex,
            animated: true,
            viewOffset: MESSAGE_VIEWPORT_OFFSET,
          });
        }
        return;
      }

      if (
        rowIndexByMessageId.has(item.id) &&
        alignMessage(item.id, MESSAGE_VIEWPORT_OFFSET, onHistoryTargetReady)
      ) {
        return;
      }
      onSelectHistoryMessage?.(item.id);
    },
    [
      alignMessage,
      listRef,
      messageHistory,
      onHistoryTargetReady,
      onManualNavigation,
      onSelectHistoryMessage,
      rowIndexByMessageId,
    ],
  );

  useLayoutEffect(() => {
    const pendingAnchor = pendingPageAnchorRef.current;
    if (pendingAnchor === null || historyWindowKey === null) {
      return;
    }
    const isLoading =
      pendingAnchor.direction === "before" ? isLoadingPreviousMessages : isLoadingNextMessages;
    const pageChanged = historyWindowKey !== pendingAnchor.originWindowKey;
    if (isLoading) {
      pageRequestHadLoadingRef.current = true;
      if (pageChanged) {
        cancelAlignment();
      } else {
        alignMessage(pendingAnchor.messageId, pendingAnchor.viewportOffset);
      }
      return;
    }
    if (pageChanged || pageRequestHadLoadingRef.current) {
      const shouldAlignSkeletonRemoval = pageRequestHadLoadingRef.current;
      pendingPageAnchorRef.current = null;
      pageRequestHadLoadingRef.current = false;
      if (shouldAlignSkeletonRemoval) {
        alignMessage(pendingAnchor.messageId, pendingAnchor.viewportOffset);
      } else {
        cancelAlignment();
      }
    }
  }, [
    alignMessage,
    cancelAlignment,
    historyWindowKey,
    isLoadingNextMessages,
    isLoadingPreviousMessages,
    rows,
  ]);

  useLayoutEffect(() => {
    if (historyTargetMessageId === null || messageHistory === undefined) {
      return;
    }
    activeMessageAnchorRef.current = {
      messageId: historyTargetMessageId,
      viewportOffset: MESSAGE_VIEWPORT_OFFSET,
    };
    alignMessage(historyTargetMessageId, MESSAGE_VIEWPORT_OFFSET, onHistoryTargetReady);
  }, [alignMessage, historyTargetMessageId, messageHistory, onHistoryTargetReady, rows]);

  useLayoutEffect(() => {
    const anchor = activeMessageAnchorRef.current;
    if (anchor !== null && historyTargetMessageId === null) {
      alignMessage(anchor.messageId, anchor.viewportOffset);
    }
  }, [alignMessage, historyTargetMessageId, rows]);

  useLayoutEffect(() => {
    if (initializedThreadRef.current !== routeThreadKey) {
      initializedThreadRef.current = routeThreadKey;
      pendingPageAnchorRef.current = null;
      activeMessageAnchorRef.current = null;
      pageRequestDirectionRef.current = null;
      pageRequestHadLoadingRef.current = false;
      lastScrollTopRef.current = null;
      followEndRef.current = true;
    }
    if (handledLatestMessagesRequestRef.current !== latestMessagesRequest) {
      handledLatestMessagesRequestRef.current = latestMessagesRequest;
      latestPositionPendingRef.current = true;
      followEndRef.current = true;
      pendingPageAnchorRef.current = null;
      activeMessageAnchorRef.current = null;
      pageRequestDirectionRef.current = null;
      pageRequestHadLoadingRef.current = false;
    }
    if (
      messageHistory === undefined ||
      historyScrollElement === null ||
      messageHistory.hasMoreAfter ||
      (!followEndRef.current && !latestPositionPendingRef.current)
    ) {
      return;
    }

    latestPositionPendingRef.current = false;
    cancelAlignment();
    const generation = alignmentGenerationRef.current;
    const scrollToEnd = () => {
      if (generation !== alignmentGenerationRef.current) {
        return;
      }
      markProgrammaticScroll();
      historyScrollElement.scrollTop = Math.max(
        0,
        historyScrollElement.scrollHeight - historyScrollElement.clientHeight,
      );
      lastScrollTopRef.current = historyScrollElement.scrollTop;
      updateMinimap();
    };
    scrollToEnd();
    alignmentFrameRef.current = requestAnimationFrame(() => {
      alignmentFrameRef.current = null;
      scrollToEnd();
    });
  }, [
    cancelAlignment,
    historyScrollElement,
    historyVirtualizer,
    latestMessagesRequest,
    markProgrammaticScroll,
    messageHistory,
    routeThreadKey,
    rows,
    updateMinimap,
  ]);

  useEffect(() => {
    const content = historyScrollElement?.firstElementChild;
    if (content === null || content === undefined) {
      return;
    }
    const observer = new ResizeObserver(() => {
      const anchor = activeMessageAnchorRef.current;
      if (anchor !== null && !manualInputRef.current) {
        alignMessage(anchor.messageId, anchor.viewportOffset);
      }
    });
    observer.observe(content);
    return () => {
      observer.disconnect();
    };
  }, [alignMessage, historyScrollElement]);

  useEffect(() => {
    const handleKeyboardNavigation = (event: KeyboardEvent) => {
      if (
        !["PageUp", "PageDown", "Home", "End", "ArrowUp", "ArrowDown", " "].includes(event.key) ||
        (document.activeElement !== document.body &&
          !historyScrollElement?.contains(document.activeElement))
      ) {
        return;
      }
      beginUserNavigation();
      if (
        ["PageUp", "Home", "ArrowUp"].includes(event.key) ||
        (event.key === " " && event.shiftKey)
      ) {
        requestPageNearEdge("before");
      } else {
        requestPageNearEdge("after");
      }
    };
    window.addEventListener("keydown", handleKeyboardNavigation, true);
    return () => {
      window.removeEventListener("keydown", handleKeyboardNavigation, true);
    };
  }, [beginUserNavigation, historyScrollElement, requestPageNearEdge]);

  useEffect(
    () => () => {
      cancelAlignment();
      if (manualInputTimeoutRef.current !== null) {
        window.clearTimeout(manualInputTimeoutRef.current);
      }
      if (ignoreScrollFrameRef.current !== null) {
        cancelAnimationFrame(ignoreScrollFrameRef.current);
      }
    },
    [cancelAlignment],
  );

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
