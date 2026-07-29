import {
  type MessageId,
  type OrchestrationThreadHistoryOutline,
  type OrchestrationThreadMessageHistory,
} from "@t3tools/contracts";
import { type LegendListMetrics, type LegendListRef } from "@legendapp/list/react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent,
  type RefObject,
} from "react";
import { resolveTimelineIsAtEnd, type MessagesTimelineRow } from "./MessagesTimeline.logic";

const VIRTUAL_MESSAGE_SIZE = 120;
const HISTORY_LOAD_THROTTLE_MS = 180;
const HISTORY_SKELETON_PERIOD = VIRTUAL_MESSAGE_SIZE * 2;
const MESSAGE_VIEWPORT_OFFSET = 24;

type ViewportAnchor =
  | {
      readonly kind: "logical";
      readonly messageIndex: number;
    }
  | {
      readonly kind: "message";
      readonly messageId: MessageId;
      readonly viewportOffset: number;
    };

type PendingHistoryRequest =
  | {
      readonly kind: "logical";
      readonly anchorMessageIndex: number;
      readonly messageId: MessageId;
    }
  | {
      readonly kind: "message";
      readonly messageId: MessageId;
    };

interface HistoryLayoutMeasurement {
  readonly windowKey: string;
  readonly loadedSize: number;
}

interface ResolvedLogicalAnchor {
  readonly anchorMessageIndex: number;
  readonly messageId: MessageId;
  readonly windowKey: string;
}

interface AdjacentHistoryRequest {
  readonly direction: "before" | "after";
  readonly windowKey: string;
}

export interface TimelineHistoryNavigationTarget {
  readonly id: MessageId;
  readonly messageIndex: number | null;
  readonly rowIndex: number | null;
}

interface UseProgressiveTimelineHistoryInput {
  readonly historyOutline: OrchestrationThreadHistoryOutline | null;
  readonly historyTargetMessageId: MessageId | null;
  readonly isHistoryReady: boolean;
  readonly isLoadingNextMessages: boolean;
  readonly isLoadingPreviousMessages: boolean;
  readonly latestMessagesRequest: number;
  readonly listRef: RefObject<LegendListRef | null>;
  readonly messageHistory: OrchestrationThreadMessageHistory | undefined;
  readonly minimapItems: ReadonlyArray<TimelineHistoryNavigationTarget>;
  readonly minimapStripMap: Map<string, HTMLSpanElement>;
  readonly onHistoryTargetReady: (() => void) | undefined;
  readonly onIsAtEndChange: (isAtEnd: boolean) => void;
  readonly onLoadNextMessages: (() => Promise<boolean>) | undefined;
  readonly onLoadPreviousMessages: (() => Promise<boolean>) | undefined;
  readonly onManualNavigation: () => void;
  readonly onSelectHistoryMessage: ((messageId: MessageId) => void) | undefined;
  readonly rows: ReadonlyArray<MessagesTimelineRow>;
  readonly timelineViewportElement: HTMLDivElement | null;
}

export function useProgressiveTimelineHistory({
  historyOutline,
  historyTargetMessageId,
  isHistoryReady,
  isLoadingNextMessages,
  isLoadingPreviousMessages,
  latestMessagesRequest,
  listRef,
  messageHistory,
  minimapItems,
  minimapStripMap,
  onHistoryTargetReady,
  onIsAtEndChange,
  onLoadNextMessages,
  onLoadPreviousMessages,
  onManualNavigation,
  onSelectHistoryMessage,
  rows,
  timelineViewportElement,
}: UseProgressiveTimelineHistoryInput) {
  const anchorRef = useRef<ViewportAnchor | null>(null);
  const pendingRequestRef = useRef<PendingHistoryRequest | null>(null);
  const resolvedLogicalAnchorRef = useRef<ResolvedLogicalAnchor | null>(null);
  const programmaticScrollRef = useRef<"seeking" | "aligning" | null>(null);
  const expectedScrollTopRef = useRef<number | null>(null);
  const pointerActiveRef = useRef(false);
  const userNavigationRef = useRef(false);
  const userNavigationResetFrameRef = useRef<number | null>(null);
  const loadTimeoutRef = useRef<number | null>(null);
  const lastLoadAtRef = useRef(0);
  const reconcileTimeoutRef = useRef<number | null>(null);
  const reconcileAnchorRef = useRef<() => void>(() => {});
  const adjacentHistoryRequestRef = useRef<AdjacentHistoryRequest | null>(null);
  const alignmentCleanupRef = useRef<(() => void) | null>(null);
  const historyBeforeSpacerRef = useRef<HTMLDivElement>(null);
  const historyAfterSpacerRef = useRef<HTMLDivElement>(null);
  const historyBeforeSkeletonsRef = useRef<HTMLDivElement>(null);
  const historyAfterSkeletonsRef = useRef<HTMLDivElement>(null);
  const historyInitializedRef = useRef(false);
  const handledLatestMessagesRequestRef = useRef(latestMessagesRequest);
  const [listHeaderSize, setListHeaderSize] = useState(0);
  const [layoutMeasurement, setLayoutMeasurement] = useState<HistoryLayoutMeasurement | null>(null);
  const messageRowIndexById = useMemo(() => {
    const rowIndexByMessageId = new Map<MessageId, number>();
    for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
      const row = rows[rowIndex];
      if (row?.kind === "message") {
        rowIndexByMessageId.set(row.message.id, rowIndex);
      }
    }
    return rowIndexByMessageId;
  }, [rows]);
  const loadedMessageIds = useMemo(() => [...messageRowIndexById.keys()], [messageRowIndexById]);

  const historyWindowKey =
    messageHistory === undefined
      ? null
      : `${messageHistory.startIndex}:${messageHistory.endIndex}:${messageHistory.totalMessages}`;
  const estimatedLoadedSize =
    messageHistory === undefined
      ? 0
      : (messageHistory.endIndex - messageHistory.startIndex) * VIRTUAL_MESSAGE_SIZE;
  const loadedSize =
    layoutMeasurement?.windowKey === historyWindowKey
      ? layoutMeasurement.loadedSize
      : estimatedLoadedSize;
  const virtualHistoryBeforeSize = (messageHistory?.startIndex ?? 0) * VIRTUAL_MESSAGE_SIZE;
  const historyBeforeSize = virtualHistoryBeforeSize;
  const virtualHistoryAfterSize =
    Math.max(0, (messageHistory?.totalMessages ?? 0) - (messageHistory?.endIndex ?? 0)) *
    VIRTUAL_MESSAGE_SIZE;
  const historyAfterSize = virtualHistoryAfterSize;
  const contentHeight = historyBeforeSize + loadedSize + historyAfterSize;
  const historyRequestInProgress =
    isLoadingPreviousMessages || isLoadingNextMessages || historyTargetMessageId !== null;
  const historyLoadInProgress = isLoadingPreviousMessages || isLoadingNextMessages;

  const clearAlignmentWait = useCallback(() => {
    alignmentCleanupRef.current?.();
    alignmentCleanupRef.current = null;
  }, []);

  const captureLogicalAnchor = useCallback(() => {
    if (messageHistory === undefined) {
      return;
    }
    const scrollNode = listRef.current?.getScrollableNode();
    if (scrollNode === undefined) {
      return;
    }
    const viewportOffset = scrollNode.clientHeight / 2;
    const viewportPosition = scrollNode.scrollTop + viewportOffset;
    const messageIndex =
      viewportPosition <= historyBeforeSize
        ? viewportPosition / VIRTUAL_MESSAGE_SIZE
        : viewportPosition >= historyBeforeSize + loadedSize
          ? messageHistory.endIndex +
            (viewportPosition - historyBeforeSize - loadedSize) / VIRTUAL_MESSAGE_SIZE
          : messageHistory.startIndex +
            ((viewportPosition - historyBeforeSize) / Math.max(1, loadedSize)) *
              (messageHistory.endIndex - messageHistory.startIndex);
    resolvedLogicalAnchorRef.current = null;
    anchorRef.current = {
      kind: "logical",
      messageIndex: Math.max(0, Math.min(messageHistory.totalMessages - 1, messageIndex)),
    };
  }, [historyBeforeSize, listRef, loadedSize, messageHistory]);

  const captureRenderedMessageAnchor = useCallback(() => {
    if (timelineViewportElement === null) {
      return false;
    }
    const viewportRect = timelineViewportElement.getBoundingClientRect();
    const viewportCenter = viewportRect.top + viewportRect.height / 2;
    let closest:
      | {
          readonly messageId: MessageId;
          readonly viewportOffset: number;
          readonly distance: number;
        }
      | undefined;
    for (const messageId of loadedMessageIds) {
      const element = timelineViewportElement.querySelector<HTMLElement>(
        `[data-message-id="${CSS.escape(messageId)}"]`,
      );
      if (element === null) {
        continue;
      }
      const rect = element.getBoundingClientRect();
      if (rect.bottom <= viewportRect.top || rect.top >= viewportRect.bottom) {
        continue;
      }
      const distance = Math.abs(rect.top + rect.height / 2 - viewportCenter);
      if (closest === undefined || distance < closest.distance) {
        closest = {
          messageId,
          viewportOffset: rect.top - viewportRect.top,
          distance,
        };
      }
    }
    if (closest === undefined) {
      return false;
    }
    pendingRequestRef.current = null;
    resolvedLogicalAnchorRef.current = null;
    anchorRef.current = {
      kind: "message",
      messageId: closest.messageId,
      viewportOffset: closest.viewportOffset,
    };
    return true;
  }, [loadedMessageIds, timelineViewportElement]);

  const queueReconciliation = useCallback(() => {
    if (reconcileTimeoutRef.current !== null) {
      return;
    }
    reconcileTimeoutRef.current = window.setTimeout(() => {
      reconcileTimeoutRef.current = null;
      reconcileAnchorRef.current();
    }, 0);
  }, []);

  const positionHistorySkeletons = useCallback(
    (scrollTop: number, scrollHeight: number) => {
      const renderedHistoryBeforeSize =
        historyBeforeSpacerRef.current?.offsetHeight ?? historyBeforeSize;
      const renderedHistoryAfterSize =
        historyAfterSpacerRef.current?.offsetHeight ?? historyAfterSize;
      const historyBeforeSkeletons = historyBeforeSkeletonsRef.current;
      if (historyBeforeSkeletons !== null) {
        const offset = Math.min(
          Math.max(
            0,
            Math.floor(scrollTop / HISTORY_SKELETON_PERIOD) * HISTORY_SKELETON_PERIOD -
              HISTORY_SKELETON_PERIOD,
          ),
          Math.max(
            0,
            Math.floor(
              (renderedHistoryBeforeSize - HISTORY_SKELETON_PERIOD) / HISTORY_SKELETON_PERIOD,
            ) * HISTORY_SKELETON_PERIOD,
          ),
        );
        const transform = `translateY(${offset}px)`;
        if (historyBeforeSkeletons.style.transform !== transform) {
          historyBeforeSkeletons.style.transform = transform;
        }
      }
      const historyAfterSkeletons = historyAfterSkeletonsRef.current;
      if (historyAfterSkeletons !== null) {
        const scrollWithinHistory = Math.max(
          0,
          scrollTop - (scrollHeight - renderedHistoryAfterSize),
        );
        const offset = Math.min(
          Math.max(
            0,
            Math.floor(scrollWithinHistory / HISTORY_SKELETON_PERIOD) * HISTORY_SKELETON_PERIOD -
              HISTORY_SKELETON_PERIOD,
          ),
          Math.max(
            0,
            Math.floor(
              (renderedHistoryAfterSize - HISTORY_SKELETON_PERIOD) / HISTORY_SKELETON_PERIOD,
            ) * HISTORY_SKELETON_PERIOD,
          ),
        );
        const transform = `translateY(${offset}px)`;
        if (historyAfterSkeletons.style.transform !== transform) {
          historyAfterSkeletons.style.transform = transform;
        }
      }
    },
    [historyAfterSize, historyBeforeSize],
  );

  const setScrollTop = useCallback(
    (scrollNode: HTMLElement, scrollTop: number) => {
      expectedScrollTopRef.current = scrollTop;
      positionHistorySkeletons(scrollTop, scrollNode.scrollHeight);
      scrollNode.scrollTo({ behavior: "auto", top: scrollTop });
    },
    [positionHistorySkeletons],
  );

  const smoothScroll = useCallback(
    (scrollNode: HTMLElement, scrollTop: number, onFinish: () => void) => {
      clearAlignmentWait();
      if (Math.abs(scrollNode.scrollTop - scrollTop) <= 1) {
        onFinish();
        return;
      }

      let finished = false;
      const finish = () => {
        if (finished) {
          return;
        }
        finished = true;
        window.clearTimeout(timeout);
        scrollNode.removeEventListener("scrollend", finish);
        if (alignmentCleanupRef.current === cleanup) {
          alignmentCleanupRef.current = null;
        }
        onFinish();
      };
      const timeout = window.setTimeout(finish, 1_000);
      const cleanup = () => {
        finished = true;
        window.clearTimeout(timeout);
        scrollNode.removeEventListener("scrollend", finish);
      };
      alignmentCleanupRef.current = cleanup;
      positionHistorySkeletons(scrollTop, scrollNode.scrollHeight);
      scrollNode.addEventListener("scrollend", finish, { once: true });
      scrollNode.scrollTo({ behavior: "smooth", top: scrollTop });
    },
    [clearAlignmentWait, positionHistorySkeletons],
  );

  const reconcileAnchor = useCallback(() => {
    if (messageHistory === undefined || timelineViewportElement === null) {
      return false;
    }
    if (pointerActiveRef.current) {
      return false;
    }
    const list = listRef.current;
    const scrollNode = list?.getScrollableNode();
    const anchor = anchorRef.current;
    if (list === null || list === undefined || scrollNode === undefined || anchor === null) {
      return false;
    }
    if (Math.abs(listHeaderSize - historyBeforeSize) > 1) {
      return false;
    }

    if (anchor.kind === "logical") {
      const pendingRequest = pendingRequestRef.current;
      if (
        pendingRequest?.kind === "logical" &&
        Math.abs(pendingRequest.anchorMessageIndex - anchor.messageIndex) > 0.5
      ) {
        return false;
      }
      return (
        pendingRequest?.kind !== "logical" ||
        minimapItems.some((item) => item.id === pendingRequest.messageId && item.rowIndex !== null)
      );
    }

    const target = timelineViewportElement.querySelector<HTMLElement>(
      `[data-message-id="${CSS.escape(anchor.messageId)}"]`,
    );
    if (target === null) {
      const targetRowIndex = messageRowIndexById.get(anchor.messageId);
      const targetPosition =
        targetRowIndex === null || targetRowIndex === undefined
          ? undefined
          : list.getState().positionAtIndex(targetRowIndex);
      if (
        targetPosition === undefined ||
        !Number.isFinite(targetPosition) ||
        programmaticScrollRef.current === "aligning"
      ) {
        return false;
      }
      const scrollTop = Math.max(
        0,
        Math.min(
          scrollNode.scrollHeight - scrollNode.clientHeight,
          historyBeforeSize + targetPosition - anchor.viewportOffset,
        ),
      );
      if (Math.abs(scrollNode.scrollTop - scrollTop) <= 2) {
        pendingRequestRef.current = null;
        if (historyTargetMessageId === anchor.messageId) {
          onHistoryTargetReady?.();
        }
        return true;
      }
      programmaticScrollRef.current = "aligning";
      smoothScroll(scrollNode, scrollTop, () => {
        if (programmaticScrollRef.current !== "aligning") {
          return;
        }
        programmaticScrollRef.current = null;
        queueReconciliation();
      });
      return false;
    }
    if (programmaticScrollRef.current === "seeking") {
      return false;
    }

    const scrollTop =
      scrollNode.scrollTop +
      target.getBoundingClientRect().top -
      scrollNode.getBoundingClientRect().top -
      anchor.viewportOffset;
    if (Math.abs(scrollNode.scrollTop - scrollTop) <= 2) {
      clearAlignmentWait();
      programmaticScrollRef.current = null;
      pendingRequestRef.current = null;
      if (historyTargetMessageId === anchor.messageId) {
        onHistoryTargetReady?.();
      }
      return true;
    }
    if (pendingRequestRef.current?.kind !== "message") {
      clearAlignmentWait();
      setScrollTop(scrollNode, scrollTop);
      queueReconciliation();
      return false;
    }
    if (programmaticScrollRef.current === "aligning") {
      return false;
    }

    programmaticScrollRef.current = "aligning";
    const finishAlignment = () => {
      if (programmaticScrollRef.current !== "aligning") {
        return;
      }
      programmaticScrollRef.current = null;
      pendingRequestRef.current = null;
      if (historyTargetMessageId === anchor.messageId) {
        onHistoryTargetReady?.();
      }
      queueReconciliation();
    };
    smoothScroll(scrollNode, scrollTop, finishAlignment);
    return false;
  }, [
    clearAlignmentWait,
    historyBeforeSize,
    historyTargetMessageId,
    listHeaderSize,
    listRef,
    messageRowIndexById,
    messageHistory,
    minimapItems,
    onHistoryTargetReady,
    queueReconciliation,
    setScrollTop,
    smoothScroll,
    timelineViewportElement,
  ]);
  reconcileAnchorRef.current = reconcileAnchor;

  const requestHistoryForAnchor = useCallback(() => {
    const anchor = anchorRef.current;
    if (
      anchor?.kind !== "logical" ||
      messageHistory === undefined ||
      historyOutline === null ||
      onSelectHistoryMessage === undefined ||
      historyOutline.landmarks.length === 0 ||
      (resolvedLogicalAnchorRef.current?.windowKey === historyWindowKey &&
        Math.abs(resolvedLogicalAnchorRef.current.anchorMessageIndex - anchor.messageIndex) <= 0.01)
    ) {
      return;
    }

    let target = historyOutline.landmarks[0]!;
    let targetMessageIndex =
      target.messageIndex ??
      (target.ordinal / Math.max(1, historyOutline.totalUserMessages - 1)) *
        Math.max(0, messageHistory.totalMessages - 1);
    for (const landmark of historyOutline.landmarks) {
      const landmarkMessageIndex =
        landmark.messageIndex ??
        (landmark.ordinal / Math.max(1, historyOutline.totalUserMessages - 1)) *
          Math.max(0, messageHistory.totalMessages - 1);
      if (
        Math.abs(landmarkMessageIndex - anchor.messageIndex) <
        Math.abs(targetMessageIndex - anchor.messageIndex)
      ) {
        target = landmark;
        targetMessageIndex = landmarkMessageIndex;
      }
    }
    const targetIsLoaded = minimapItems.some(
      (item) => item.id === target.messageId && item.rowIndex !== null,
    );
    if (targetIsLoaded) {
      pendingRequestRef.current = {
        kind: "logical",
        anchorMessageIndex: anchor.messageIndex,
        messageId: target.messageId,
      };
      queueReconciliation();
      return;
    }
    if (
      anchor.messageIndex >= messageHistory.startIndex &&
      anchor.messageIndex < messageHistory.endIndex
    ) {
      let loadedTarget: TimelineHistoryNavigationTarget | null = null;
      let loadedTargetDistance = Number.POSITIVE_INFINITY;
      for (const item of minimapItems) {
        if (item.rowIndex === null || item.messageIndex === null) {
          continue;
        }
        const distance = Math.abs(item.messageIndex - anchor.messageIndex);
        if (distance < loadedTargetDistance) {
          loadedTarget = item;
          loadedTargetDistance = distance;
        }
      }
      if (loadedTarget !== null) {
        pendingRequestRef.current = {
          kind: "logical",
          anchorMessageIndex: anchor.messageIndex,
          messageId: loadedTarget.id,
        };
        queueReconciliation();
        return;
      }
      const fallbackMessageId =
        loadedMessageIds[
          Math.round(
            ((anchor.messageIndex - messageHistory.startIndex) /
              Math.max(1, messageHistory.endIndex - messageHistory.startIndex - 1)) *
              Math.max(0, loadedMessageIds.length - 1),
          )
        ];
      if (fallbackMessageId !== undefined) {
        pendingRequestRef.current = {
          kind: "logical",
          anchorMessageIndex: anchor.messageIndex,
          messageId: fallbackMessageId,
        };
        queueReconciliation();
      }
      return;
    }

    const targetAlreadyRequested =
      pendingRequestRef.current?.messageId === target.messageId &&
      historyTargetMessageId === target.messageId;
    pendingRequestRef.current = {
      kind: "logical",
      anchorMessageIndex: anchor.messageIndex,
      messageId: target.messageId,
    };
    if (targetAlreadyRequested) {
      return;
    }
    lastLoadAtRef.current = performance.now();
    onManualNavigation();
    onSelectHistoryMessage(target.messageId);
  }, [
    historyOutline,
    historyTargetMessageId,
    historyWindowKey,
    loadedMessageIds,
    messageHistory,
    minimapItems,
    onManualNavigation,
    onSelectHistoryMessage,
    queueReconciliation,
  ]);

  const scheduleHistoryLoad = useCallback(() => {
    if (loadTimeoutRef.current !== null) {
      return;
    }
    const delay = Math.max(0, lastLoadAtRef.current + HISTORY_LOAD_THROTTLE_MS - performance.now());
    loadTimeoutRef.current = window.setTimeout(() => {
      loadTimeoutRef.current = null;
      requestHistoryForAnchor();
    }, delay);
  }, [requestHistoryForAnchor]);

  const releaseScrollControl = useCallback(() => {
    const scrollNode = listRef.current?.getScrollableNode();
    if (programmaticScrollRef.current !== null && scrollNode !== undefined) {
      scrollNode.scrollTo({ behavior: "auto", top: scrollNode.scrollTop });
    }
    clearAlignmentWait();
    programmaticScrollRef.current = null;
    expectedScrollTopRef.current = null;
    anchorRef.current = null;
    pendingRequestRef.current = null;
    resolvedLogicalAnchorRef.current = null;
    onHistoryTargetReady?.();
  }, [clearAlignmentWait, listRef, onHistoryTargetReady]);

  const beginUserNavigation = useCallback(() => {
    releaseScrollControl();
    userNavigationRef.current = true;
    if (userNavigationResetFrameRef.current !== null) {
      window.cancelAnimationFrame(userNavigationResetFrameRef.current);
    }
    userNavigationResetFrameRef.current = window.requestAnimationFrame(() => {
      userNavigationResetFrameRef.current = null;
      if (!pointerActiveRef.current) {
        userNavigationRef.current = false;
      }
    });
    onManualNavigation();
  }, [onManualNavigation, releaseScrollControl]);

  useLayoutEffect(() => {
    if (handledLatestMessagesRequestRef.current === latestMessagesRequest) {
      return;
    }
    handledLatestMessagesRequestRef.current = latestMessagesRequest;
    releaseScrollControl();
    adjacentHistoryRequestRef.current = null;
    historyInitializedRef.current = false;
  }, [latestMessagesRequest, releaseScrollControl]);

  const handleListMetricsChange = useCallback(({ headerSize }: LegendListMetrics) => {
    setListHeaderSize((current) => (Math.abs(current - headerSize) <= 1 ? current : headerSize));
  }, []);

  const handleScroll = useCallback(() => {
    const state = listRef.current?.getState?.();
    const isAtEnd = resolveTimelineIsAtEnd(state);
    if (isAtEnd !== undefined) {
      onIsAtEndChange(isAtEnd);
    }
    if (state === undefined) {
      return;
    }

    const scrollNode = listRef.current?.getScrollableNode();
    const scrollTop = scrollNode?.scrollTop ?? state.scroll ?? 0;
    const scrollLength = scrollNode?.clientHeight ?? state.scrollLength ?? 0;
    const scrollBottom = scrollTop + scrollLength;
    positionHistorySkeletons(scrollTop, scrollNode?.scrollHeight ?? state.contentLength ?? 0);

    const expectedScrollTop = expectedScrollTopRef.current;
    const isExpectedScroll =
      expectedScrollTop !== null && Math.abs(scrollTop - expectedScrollTop) <= 1;
    if (isExpectedScroll) {
      expectedScrollTopRef.current = null;
    }

    if (
      messageHistory !== undefined &&
      historyInitializedRef.current &&
      programmaticScrollRef.current === null &&
      !isExpectedScroll &&
      (userNavigationRef.current || pointerActiveRef.current)
    ) {
      captureLogicalAnchor();
      onManualNavigation();
      scheduleHistoryLoad();
      if (!pointerActiveRef.current) {
        userNavigationRef.current = false;
      }
    }

    if (
      messageHistory !== undefined &&
      isHistoryReady &&
      historyWindowKey !== null &&
      scrollTop < historyBeforeSize &&
      scrollBottom >= historyBeforeSize &&
      messageHistory.hasMoreBefore &&
      onLoadPreviousMessages !== undefined &&
      !isLoadingPreviousMessages &&
      (adjacentHistoryRequestRef.current?.direction !== "before" ||
        adjacentHistoryRequestRef.current.windowKey !== historyWindowKey)
    ) {
      captureRenderedMessageAnchor();
      const request: AdjacentHistoryRequest = {
        direction: "before",
        windowKey: historyWindowKey,
      };
      adjacentHistoryRequestRef.current = request;
      void onLoadPreviousMessages().then((loaded) => {
        const currentRequest = adjacentHistoryRequestRef.current;
        if (
          loaded ||
          currentRequest?.direction !== request.direction ||
          currentRequest.windowKey !== request.windowKey
        ) {
          return;
        }
        adjacentHistoryRequestRef.current = null;
      });
    }
    const loadedHistoryEnd = historyBeforeSize + loadedSize;
    if (
      messageHistory !== undefined &&
      isHistoryReady &&
      historyWindowKey !== null &&
      scrollTop < loadedHistoryEnd &&
      scrollBottom >= loadedHistoryEnd &&
      messageHistory.hasMoreAfter &&
      onLoadNextMessages !== undefined &&
      !isLoadingNextMessages &&
      (adjacentHistoryRequestRef.current?.direction !== "after" ||
        adjacentHistoryRequestRef.current.windowKey !== historyWindowKey)
    ) {
      captureRenderedMessageAnchor();
      const request: AdjacentHistoryRequest = {
        direction: "after",
        windowKey: historyWindowKey,
      };
      adjacentHistoryRequestRef.current = request;
      void onLoadNextMessages().then((loaded) => {
        const currentRequest = adjacentHistoryRequestRef.current;
        if (
          loaded ||
          currentRequest?.direction !== request.direction ||
          currentRequest.windowKey !== request.windowKey
        ) {
          return;
        }
        adjacentHistoryRequestRef.current = null;
      });
    }

    for (const item of minimapItems) {
      const strip = minimapStripMap.get(item.id);
      if (strip === undefined || item.rowIndex === null) {
        continue;
      }
      const rowTopWithinWindow = state.positionAtIndex?.(item.rowIndex);
      const rowHeight = state.sizeAtIndex?.(item.rowIndex);
      const rowTop =
        rowTopWithinWindow === undefined || !Number.isFinite(rowTopWithinWindow)
          ? null
          : historyBeforeSize + rowTopWithinWindow;
      const resolvedRowHeight =
        rowHeight === undefined || !Number.isFinite(rowHeight) ? null : rowHeight;
      const inView =
        rowTop !== null &&
        rowTop < scrollBottom &&
        rowTop + Math.max(1, resolvedRowHeight ?? 1) > scrollTop;
      strip.dataset.inView = inView ? "true" : "false";
    }
  }, [
    historyBeforeSize,
    historyWindowKey,
    isHistoryReady,
    isLoadingNextMessages,
    isLoadingPreviousMessages,
    listRef,
    loadedSize,
    messageHistory,
    minimapItems,
    minimapStripMap,
    onLoadNextMessages,
    onLoadPreviousMessages,
    onManualNavigation,
    onIsAtEndChange,
    positionHistorySkeletons,
    captureRenderedMessageAnchor,
    scheduleHistoryLoad,
  ]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(handleScroll);
    return () => window.cancelAnimationFrame(frame);
  }, [handleScroll]);

  const beginScrollbarPointerNavigation = useCallback(
    (event: globalThis.PointerEvent | PointerEvent<HTMLDivElement>) => {
      const scrollNode = listRef.current?.getScrollableNode();
      if (scrollNode === undefined || event.button !== 0 || pointerActiveRef.current) {
        return;
      }
      const rect = scrollNode.getBoundingClientRect();
      const sideGutterWidth = Math.max(0, (scrollNode.offsetWidth - scrollNode.clientWidth) / 2);
      if (
        event.target !== scrollNode &&
        !(
          event.clientY >= rect.top &&
          event.clientY <= rect.bottom &&
          (event.clientX <= rect.left + sideGutterWidth ||
            event.clientX >= rect.right - sideGutterWidth)
        )
      ) {
        return;
      }
      pointerActiveRef.current = true;
      beginUserNavigation();
    },
    [beginUserNavigation, listRef],
  );

  const beginPointerNavigation = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      beginUserNavigation();
      beginScrollbarPointerNavigation(event);
    },
    [beginScrollbarPointerNavigation, beginUserNavigation],
  );

  const finishScrollbarPointerNavigation = useCallback(() => {
    if (!pointerActiveRef.current) {
      return;
    }
    pointerActiveRef.current = false;
    captureLogicalAnchor();
    scheduleHistoryLoad();
    queueReconciliation();
  }, [captureLogicalAnchor, queueReconciliation, scheduleHistoryLoad]);

  const selectHistoryTarget = useCallback(
    (item: TimelineHistoryNavigationTarget) => {
      onManualNavigation();
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

      clearAlignmentWait();
      userNavigationRef.current = false;
      expectedScrollTopRef.current = null;
      if (loadTimeoutRef.current !== null) {
        window.clearTimeout(loadTimeoutRef.current);
        loadTimeoutRef.current = null;
      }
      const supersedesHistoryRequest =
        historyTargetMessageId !== null && historyTargetMessageId !== item.id;
      onHistoryTargetReady?.();
      anchorRef.current = {
        kind: "message",
        messageId: item.id,
        viewportOffset: MESSAGE_VIEWPORT_OFFSET,
      };
      pendingRequestRef.current = {
        kind: "message",
        messageId: item.id,
      };
      programmaticScrollRef.current = "seeking";

      const list = listRef.current;
      const scrollNode = list?.getScrollableNode();
      if (list === null || list === undefined || scrollNode === undefined) {
        programmaticScrollRef.current = null;
        return;
      }
      const estimatedScrollTop =
        item.messageIndex === null
          ? null
          : Math.max(
              0,
              Math.min(
                scrollNode.scrollHeight - scrollNode.clientHeight,
                item.messageIndex * VIRTUAL_MESSAGE_SIZE - MESSAGE_VIEWPORT_OFFSET,
              ),
            );
      if (item.rowIndex === null || supersedesHistoryRequest) {
        window.setTimeout(() => {
          if (
            pendingRequestRef.current?.kind === "message" &&
            pendingRequestRef.current.messageId === item.id
          ) {
            onSelectHistoryMessage?.(item.id);
          }
        });
      }

      if (item.rowIndex === null && estimatedScrollTop === null) {
        programmaticScrollRef.current = null;
        return;
      }

      const finishSeek = () => {
        if (programmaticScrollRef.current !== "seeking") {
          return;
        }
        programmaticScrollRef.current = null;
        queueReconciliation();
      };
      if (estimatedScrollTop !== null) {
        setScrollTop(scrollNode, estimatedScrollTop);
        finishSeek();
      } else if (item.rowIndex !== null) {
        void list.scrollToIndex({
          index: item.rowIndex,
          animated: true,
          viewOffset: MESSAGE_VIEWPORT_OFFSET,
        });
        programmaticScrollRef.current = null;
        queueReconciliation();
      }
    },
    [
      clearAlignmentWait,
      historyTargetMessageId,
      listRef,
      messageHistory,
      onHistoryTargetReady,
      onManualNavigation,
      onSelectHistoryMessage,
      queueReconciliation,
      setScrollTop,
    ],
  );

  useLayoutEffect(() => {
    if (messageHistory === undefined || historyWindowKey === null) {
      return;
    }
    const beforeSpacer = historyBeforeSpacerRef.current;
    const afterSpacer = historyAfterSpacerRef.current;
    const loadedRowsContainer = afterSpacer?.parentElement?.previousElementSibling;
    if (
      beforeSpacer === null ||
      afterSpacer === null ||
      loadedRowsContainer === null ||
      loadedRowsContainer === undefined
    ) {
      return;
    }

    const measure = () => {
      const loadedSize = Math.max(
        0,
        afterSpacer.getBoundingClientRect().top - beforeSpacer.getBoundingClientRect().bottom,
      );
      setLayoutMeasurement((current) =>
        current?.windowKey === historyWindowKey && Math.abs(current.loadedSize - loadedSize) <= 1
          ? current
          : {
              windowKey: historyWindowKey,
              loadedSize,
            },
      );
      queueReconciliation();
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(loadedRowsContainer);
    observer.observe(beforeSpacer);
    observer.observe(afterSpacer);
    return () => {
      observer.disconnect();
    };
  }, [historyWindowKey, messageHistory, queueReconciliation, rows.length]);

  useLayoutEffect(() => {
    if (messageHistory === undefined || historyWindowKey === null) {
      return;
    }
    const list = listRef.current;
    const scrollNode = list?.getScrollableNode();
    if (list === null || list === undefined || scrollNode === undefined) {
      return;
    }
    if (!historyInitializedRef.current) {
      const initialScrollTop = messageHistory.hasMoreAfter
        ? Math.min(
            historyBeforeSize,
            Math.max(0, scrollNode.scrollHeight - scrollNode.clientHeight),
          )
        : Math.max(0, scrollNode.scrollHeight - scrollNode.clientHeight);
      anchorRef.current = {
        kind: "logical",
        messageIndex: Math.max(
          0,
          Math.min(
            messageHistory.totalMessages - 1,
            (initialScrollTop + scrollNode.clientHeight / 2) / VIRTUAL_MESSAGE_SIZE,
          ),
        ),
      };
      if (Math.abs(scrollNode.scrollTop - initialScrollTop) > 1) {
        setScrollTop(scrollNode, initialScrollTop);
      }
      historyInitializedRef.current = true;
    }
    scheduleHistoryLoad();
    if (Math.abs(listHeaderSize - historyBeforeSize) <= 1) {
      queueReconciliation();
    }
  }, [
    historyBeforeSize,
    historyWindowKey,
    listHeaderSize,
    listRef,
    messageHistory,
    queueReconciliation,
    scheduleHistoryLoad,
    setScrollTop,
  ]);

  useEffect(() => {
    if (
      messageHistory === undefined ||
      historyWindowKey === null ||
      historyLoadInProgress ||
      pendingRequestRef.current?.kind !== "logical"
    ) {
      return;
    }
    const anchor = anchorRef.current;
    const pendingRequest = pendingRequestRef.current;
    if (anchor?.kind !== "logical" || pendingRequest?.kind !== "logical") {
      return;
    }
    if (Math.abs(pendingRequest.anchorMessageIndex - anchor.messageIndex) > 0.5) {
      pendingRequestRef.current = null;
      onHistoryTargetReady?.();
      return;
    }
    const timeout = window.setTimeout(() => {
      if (!reconcileAnchor()) {
        return;
      }
      resolvedLogicalAnchorRef.current = {
        anchorMessageIndex: anchor.messageIndex,
        messageId: pendingRequest.messageId,
        windowKey: historyWindowKey,
      };
      pendingRequestRef.current = null;
      onHistoryTargetReady?.();
      scheduleHistoryLoad();
    }, 0);
    return () => window.clearTimeout(timeout);
  }, [
    historyLoadInProgress,
    historyWindowKey,
    messageHistory,
    onHistoryTargetReady,
    reconcileAnchor,
    scheduleHistoryLoad,
  ]);

  useEffect(() => {
    if (!historyRequestInProgress) {
      scheduleHistoryLoad();
    }
  }, [historyRequestInProgress, scheduleHistoryLoad]);

  useEffect(() => {
    if (anchorRef.current?.kind === "message" && pendingRequestRef.current?.kind === "message") {
      queueReconciliation();
    }
  }, [historyRequestInProgress, historyWindowKey, queueReconciliation, rows]);

  useEffect(() => {
    if (timelineViewportElement === null) {
      return;
    }
    const observer = new ResizeObserver(queueReconciliation);
    observer.observe(timelineViewportElement);
    return () => {
      observer.disconnect();
    };
  }, [queueReconciliation, timelineViewportElement]);

  useEffect(() => {
    window.addEventListener("keydown", beginUserNavigation, true);
    window.addEventListener("pointerdown", beginScrollbarPointerNavigation, true);
    window.addEventListener("pointerup", finishScrollbarPointerNavigation);
    window.addEventListener("pointercancel", finishScrollbarPointerNavigation);
    return () => {
      window.removeEventListener("keydown", beginUserNavigation, true);
      window.removeEventListener("pointerdown", beginScrollbarPointerNavigation, true);
      window.removeEventListener("pointerup", finishScrollbarPointerNavigation);
      window.removeEventListener("pointercancel", finishScrollbarPointerNavigation);
    };
  }, [beginScrollbarPointerNavigation, beginUserNavigation, finishScrollbarPointerNavigation]);

  useEffect(
    () => () => {
      clearAlignmentWait();
      if (loadTimeoutRef.current !== null) {
        window.clearTimeout(loadTimeoutRef.current);
        loadTimeoutRef.current = null;
      }
      if (reconcileTimeoutRef.current !== null) {
        window.clearTimeout(reconcileTimeoutRef.current);
        reconcileTimeoutRef.current = null;
      }
      if (userNavigationResetFrameRef.current !== null) {
        window.cancelAnimationFrame(userNavigationResetFrameRef.current);
        userNavigationResetFrameRef.current = null;
      }
    },
    [clearAlignmentWait],
  );

  return useMemo(
    () => ({
      beginPointerNavigation,
      beginScrollbarPointerNavigation,
      beginUserNavigation,
      contentHeight,
      handleScroll,
      historyAfterSize,
      historyAfterSkeletonsRef,
      historyAfterSpacerRef,
      historyBeforeSize,
      historyBeforeSkeletonsRef,
      historyBeforeSpacerRef,
      onListMetricsChange: handleListMetricsChange,
      selectHistoryTarget,
      virtualHistoryAfterSize,
      virtualHistoryBeforeSize,
    }),
    [
      beginScrollbarPointerNavigation,
      beginPointerNavigation,
      beginUserNavigation,
      handleScroll,
      historyAfterSize,
      historyBeforeSize,
      handleListMetricsChange,
      selectHistoryTarget,
      contentHeight,
      virtualHistoryAfterSize,
      virtualHistoryBeforeSize,
    ],
  );
}
