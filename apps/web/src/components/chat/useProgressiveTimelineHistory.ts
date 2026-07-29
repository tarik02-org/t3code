import {
  type MessageId,
  type OrchestrationThreadHistoryOutline,
  type OrchestrationThreadMessageHistory,
} from "@t3tools/contracts";
import { type LegendListRef } from "@legendapp/list/react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import { resolveTimelineIsAtEnd, type MessagesTimelineRow } from "./MessagesTimeline.logic";
import {
  handoffProgressiveTimelineAnchorToUser,
  isProgressiveTimelineNavigationKey,
  PROGRESSIVE_TIMELINE_MESSAGE_SIZE,
  resolveProgressiveTimelineHistoryTarget,
  resolveProgressiveTimelineLayout,
  resolveProgressiveTimelineMessageIndex,
  shouldCaptureProgressiveTimelineScroll,
  type ProgressiveTimelineProgrammaticScroll,
  type ProgressiveTimelineViewportAnchor,
  type TimelineHistoryNavigationTarget,
} from "./progressiveTimelineHistory.logic";

const HISTORY_LOAD_THROTTLE_MS = 180;
const HISTORY_SKELETON_PERIOD = PROGRESSIVE_TIMELINE_MESSAGE_SIZE * 2;
const INITIAL_TAIL_POSITION_DELAY_MS = 200;
const MANUAL_SCROLL_END_DELAY_MS = 160;
const MESSAGE_VIEWPORT_OFFSET = 24;

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

interface UseProgressiveTimelineHistoryInput {
  readonly historyOutline: OrchestrationThreadHistoryOutline | null;
  readonly historyLayoutMeasurement: HistoryLayoutMeasurement | null;
  readonly historyScrollElement: HTMLDivElement | null;
  readonly historyTargetMessageId: MessageId | null;
  readonly isLoadingNextMessages: boolean;
  readonly isLoadingPreviousMessages: boolean;
  readonly latestMessagesRequest: number;
  readonly listRef: RefObject<LegendListRef | null>;
  readonly messageHistory: OrchestrationThreadMessageHistory | undefined;
  readonly minimapItems: ReadonlyArray<TimelineHistoryNavigationTarget>;
  readonly minimapStripMap: Map<string, HTMLSpanElement>;
  readonly onHistoryTargetReady: (() => void) | undefined;
  readonly onHistoryScrollToOffset: (offset: number, behavior: ScrollBehavior) => void;
  readonly onIsAtEndChange: (isAtEnd: boolean) => void;
  readonly onManualNavigation: () => void;
  readonly onSelectHistoryMessage: ((messageId: MessageId) => void) | undefined;
  readonly rows: ReadonlyArray<MessagesTimelineRow>;
  readonly timelineViewportElement: HTMLDivElement | null;
}

export function useProgressiveTimelineHistory({
  historyOutline,
  historyLayoutMeasurement,
  historyScrollElement,
  historyTargetMessageId,
  isLoadingNextMessages,
  isLoadingPreviousMessages,
  latestMessagesRequest,
  listRef,
  messageHistory,
  minimapItems,
  minimapStripMap,
  onHistoryTargetReady,
  onHistoryScrollToOffset,
  onIsAtEndChange,
  onManualNavigation,
  onSelectHistoryMessage,
  rows,
  timelineViewportElement,
}: UseProgressiveTimelineHistoryInput) {
  const anchorRef = useRef<ProgressiveTimelineViewportAnchor | null>(null);
  const pendingRequestRef = useRef<PendingHistoryRequest | null>(null);
  const resolvedLogicalAnchorRef = useRef<ResolvedLogicalAnchor | null>(null);
  const programmaticScrollRef = useRef<ProgressiveTimelineProgrammaticScroll | null>(null);
  const expectedScrollTopRef = useRef<number | null>(null);
  const scrollOffsetRef = useRef<number | null>(null);
  const manualScrollRef = useRef(false);
  const pointerNavigationRef = useRef(false);
  const manualScrollEndTimeoutRef = useRef<number | null>(null);
  const loadTimeoutRef = useRef<number | null>(null);
  const lastLoadAtRef = useRef(0);
  const reconcileTimeoutRef = useRef<number | null>(null);
  const reconcileAnchorRef = useRef<() => void>(() => {});
  const alignmentCleanupRef = useRef<(() => void) | null>(null);
  const historyBeforeSpacerRef = useRef<HTMLDivElement>(null);
  const historyAfterSpacerRef = useRef<HTMLDivElement>(null);
  const historyBeforeSkeletonsRef = useRef<HTMLDivElement>(null);
  const historyAfterSkeletonsRef = useRef<HTMLDivElement>(null);
  const historyInitializedRef = useRef(false);
  const latestPositionPendingRef = useRef(false);
  const initialTailPositionPendingRef = useRef(false);
  const initialTailPositionTimeoutRef = useRef<number | null>(null);
  const handledLatestMessagesRequestRef = useRef(latestMessagesRequest);
  const [historicalNavigation, setHistoricalNavigation] = useState(false);
  const loadedMessageIds = useMemo(() => {
    const messageIds: MessageId[] = [];
    for (const row of rows) {
      if (row.kind === "message") {
        messageIds.push(row.message.id);
      }
    }
    return messageIds;
  }, [rows]);

  const historyWindowKey =
    messageHistory === undefined
      ? null
      : `${messageHistory.startIndex}:${messageHistory.endIndex}:${messageHistory.totalMessages}`;
  const estimatedLoadedSize =
    messageHistory === undefined
      ? 0
      : (messageHistory.endIndex - messageHistory.startIndex) * PROGRESSIVE_TIMELINE_MESSAGE_SIZE;
  const loadedSize =
    historyLayoutMeasurement?.windowKey === historyWindowKey
      ? historyLayoutMeasurement.loadedSize
      : estimatedLoadedSize;
  const currentAnchor = anchorRef.current;
  const layoutAnchor =
    currentAnchor === null || scrollOffsetRef.current === null || historyScrollElement === null
      ? null
      : currentAnchor.kind === "logical"
        ? {
            messageIndex: currentAnchor.messageIndex,
            viewportPosition: scrollOffsetRef.current + historyScrollElement.clientHeight / 2,
          }
        : currentAnchor.messageIndex === null
          ? null
          : {
              messageIndex: currentAnchor.messageIndex,
              viewportPosition: scrollOffsetRef.current + currentAnchor.viewportOffset,
            };
  const {
    contentSize: contentHeight,
    historyAfterSize,
    historyBeforeSize,
    virtualHistoryAfterSize,
    virtualHistoryBeforeSize,
  } = messageHistory === undefined
    ? {
        contentSize: 0,
        historyAfterSize: 0,
        historyBeforeSize: 0,
        virtualHistoryAfterSize: 0,
        virtualHistoryBeforeSize: 0,
      }
    : resolveProgressiveTimelineLayout({
        anchor: layoutAnchor,
        loadedSize,
        messageHistory,
        preserveHistoricalCanvas: historicalNavigation || messageHistory.hasMoreAfter,
      });
  const historyRequestInProgress =
    isLoadingPreviousMessages || isLoadingNextMessages || historyTargetMessageId !== null;
  const historyLoadInProgress = isLoadingPreviousMessages || isLoadingNextMessages;

  const clearAlignmentWait = useCallback(() => {
    alignmentCleanupRef.current?.();
    alignmentCleanupRef.current = null;
  }, []);

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
      scrollOffsetRef.current = scrollTop;
      expectedScrollTopRef.current = scrollTop;
      positionHistorySkeletons(scrollTop, scrollNode.scrollHeight);
      onHistoryScrollToOffset(scrollTop, "auto");
      scrollNode.dispatchEvent(new Event("scroll"));
    },
    [onHistoryScrollToOffset, positionHistorySkeletons],
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
      onHistoryScrollToOffset(scrollTop, "smooth");
    },
    [clearAlignmentWait, onHistoryScrollToOffset, positionHistorySkeletons],
  );

  const scheduleInitialTailPosition = useCallback(() => {
    if (initialTailPositionTimeoutRef.current !== null) {
      window.clearTimeout(initialTailPositionTimeoutRef.current);
    }
    initialTailPositionTimeoutRef.current = window.setTimeout(() => {
      initialTailPositionTimeoutRef.current = null;
      if (!initialTailPositionPendingRef.current) {
        return;
      }
      initialTailPositionPendingRef.current = false;
      const scrollNode = historyScrollElement;
      if (scrollNode === null) {
        return;
      }
      const scrollTop = Math.max(0, scrollNode.scrollHeight - scrollNode.clientHeight);
      scrollOffsetRef.current = scrollTop;
      onHistoryScrollToOffset(scrollTop, "auto");
      scrollNode.dispatchEvent(new Event("scroll"));
    }, INITIAL_TAIL_POSITION_DELAY_MS);
  }, [historyScrollElement, onHistoryScrollToOffset]);

  const reconcileAnchor = useCallback(() => {
    if (
      messageHistory === undefined ||
      historyWindowKey === null ||
      timelineViewportElement === null
    ) {
      return false;
    }
    const scrollNode = historyScrollElement;
    const anchor = anchorRef.current;
    if (scrollNode === null || anchor === null) {
      return false;
    }
    if (anchor.kind === "logical") {
      const pendingRequest = pendingRequestRef.current;
      if (
        pendingRequest?.kind === "logical" &&
        Math.abs(pendingRequest.anchorMessageIndex - anchor.messageIndex) > 0.5
      ) {
        pendingRequestRef.current = null;
        onHistoryTargetReady?.();
        return true;
      }
      if (
        pendingRequest?.kind === "logical" &&
        !minimapItems.some((item) => item.id === pendingRequest.messageId && item.rowIndex !== null)
      ) {
        return false;
      }
      if (pendingRequest?.kind === "logical") {
        resolvedLogicalAnchorRef.current = {
          anchorMessageIndex: anchor.messageIndex,
          messageId: pendingRequest.messageId,
          windowKey: historyWindowKey,
        };
        pendingRequestRef.current = null;
        onHistoryTargetReady?.();
      }
      return true;
    }

    const target = timelineViewportElement.querySelector<HTMLElement>(
      `[data-message-id="${CSS.escape(anchor.messageId)}"]`,
    );
    if (target === null) {
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
    historyScrollElement,
    historyTargetMessageId,
    historyWindowKey,
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
      (resolvedLogicalAnchorRef.current?.windowKey === historyWindowKey &&
        Math.abs(resolvedLogicalAnchorRef.current.anchorMessageIndex - anchor.messageIndex) <= 0.01)
    ) {
      return;
    }

    const targetMessageId = resolveProgressiveTimelineHistoryTarget({
      anchorMessageIndex: anchor.messageIndex,
      historyOutline,
      loadedMessageIds,
      messageHistory,
      minimapItems,
    });
    if (targetMessageId === null) {
      return;
    }
    if (
      minimapItems.some((item) => item.id === targetMessageId && item.rowIndex !== null) ||
      (anchor.messageIndex >= messageHistory.startIndex &&
        anchor.messageIndex < messageHistory.endIndex)
    ) {
      pendingRequestRef.current = {
        kind: "logical",
        anchorMessageIndex: anchor.messageIndex,
        messageId: targetMessageId,
      };
      queueReconciliation();
      return;
    }

    const targetAlreadyRequested =
      pendingRequestRef.current?.messageId === targetMessageId &&
      historyTargetMessageId === targetMessageId;
    pendingRequestRef.current = {
      kind: "logical",
      anchorMessageIndex: anchor.messageIndex,
      messageId: targetMessageId,
    };
    if (targetAlreadyRequested) {
      return;
    }
    lastLoadAtRef.current = performance.now();
    onSelectHistoryMessage(targetMessageId);
  }, [
    historyOutline,
    historyTargetMessageId,
    historyWindowKey,
    loadedMessageIds,
    messageHistory,
    minimapItems,
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

  const cancelProgrammaticNavigation = useCallback(() => {
    const scrollNode = historyScrollElement;
    if (programmaticScrollRef.current !== null && scrollNode !== null) {
      onHistoryScrollToOffset(scrollNode.scrollTop, "auto");
      scrollNode.dispatchEvent(new Event("scroll"));
    }
    clearAlignmentWait();
    programmaticScrollRef.current = null;
    expectedScrollTopRef.current = null;
    pendingRequestRef.current = null;
    resolvedLogicalAnchorRef.current = null;
    onHistoryTargetReady?.();
  }, [clearAlignmentWait, historyScrollElement, onHistoryScrollToOffset, onHistoryTargetReady]);

  const resetNavigation = useCallback(() => {
    cancelProgrammaticNavigation();
    manualScrollRef.current = false;
    anchorRef.current = null;
  }, [cancelProgrammaticNavigation]);

  const beginUserNavigation = useCallback(() => {
    const takesScrollControl = !manualScrollRef.current || programmaticScrollRef.current !== null;
    if (takesScrollControl) {
      const scrollNode = historyScrollElement;
      if (
        anchorRef.current?.kind === "message" &&
        messageHistory !== undefined &&
        scrollNode !== null
      ) {
        const scrollTop = scrollNode.scrollTop;
        scrollOffsetRef.current = scrollTop;
        anchorRef.current = handoffProgressiveTimelineAnchorToUser({
          anchor: anchorRef.current,
          historyAfterSize,
          historyBeforeSize,
          loadedSize,
          messageHistory,
          scrollLength: scrollNode.clientHeight,
          scrollTop,
        });
      }
      cancelProgrammaticNavigation();
      initialTailPositionPendingRef.current = false;
      if (initialTailPositionTimeoutRef.current !== null) {
        window.clearTimeout(initialTailPositionTimeoutRef.current);
        initialTailPositionTimeoutRef.current = null;
      }
      onManualNavigation();
    }
    if (manualScrollEndTimeoutRef.current !== null) {
      window.clearTimeout(manualScrollEndTimeoutRef.current);
      manualScrollEndTimeoutRef.current = null;
    }
    manualScrollRef.current = true;
  }, [
    cancelProgrammaticNavigation,
    historyAfterSize,
    historyBeforeSize,
    historyScrollElement,
    loadedSize,
    messageHistory,
    onManualNavigation,
  ]);

  const beginPointerNavigation = useCallback(() => {
    pointerNavigationRef.current = true;
    beginUserNavigation();
  }, [beginUserNavigation]);

  useLayoutEffect(() => {
    if (handledLatestMessagesRequestRef.current === latestMessagesRequest) {
      return;
    }
    handledLatestMessagesRequestRef.current = latestMessagesRequest;
    resetNavigation();
    initialTailPositionPendingRef.current = false;
    if (initialTailPositionTimeoutRef.current !== null) {
      window.clearTimeout(initialTailPositionTimeoutRef.current);
      initialTailPositionTimeoutRef.current = null;
    }
    latestPositionPendingRef.current = true;
    historyInitializedRef.current = false;
    scrollOffsetRef.current = null;
    setHistoricalNavigation(false);
  }, [latestMessagesRequest, resetNavigation]);

  const handleScroll = useCallback(() => {
    const state = messageHistory === undefined ? listRef.current?.getState?.() : undefined;
    const scrollNode =
      messageHistory === undefined ? listRef.current?.getScrollableNode() : historyScrollElement;
    const isAtEnd =
      messageHistory === undefined
        ? resolveTimelineIsAtEnd(state)
        : scrollNode === null || scrollNode === undefined
          ? undefined
          : scrollNode.scrollTop + scrollNode.clientHeight >= scrollNode.scrollHeight - 2;
    if (isAtEnd !== undefined) {
      onIsAtEndChange(isAtEnd);
    }
    if (messageHistory === undefined || scrollNode === null || scrollNode === undefined) {
      return;
    }

    const scrollTop = scrollNode.scrollTop;
    const scrollLength = scrollNode.clientHeight;
    const scrollBottom = scrollTop + scrollLength;
    const previousScrollTop = scrollOffsetRef.current;
    scrollOffsetRef.current = scrollTop;
    const renderedContentHeight = historyBeforeSize + loadedSize + historyAfterSize;
    positionHistorySkeletons(scrollTop, scrollNode.scrollHeight);

    const expectedScrollTop = expectedScrollTopRef.current;
    const isExpectedScroll =
      expectedScrollTop !== null && Math.abs(scrollTop - expectedScrollTop) <= 1;
    if (isExpectedScroll) {
      expectedScrollTopRef.current = null;
    }

    if (
      messageHistory !== undefined &&
      historyInitializedRef.current &&
      shouldCaptureProgressiveTimelineScroll({
        didScroll: previousScrollTop === null || Math.abs(scrollTop - previousScrollTop) > 0.5,
        isExpectedScroll,
        isManualScroll: manualScrollRef.current,
        programmaticScroll: programmaticScrollRef.current,
      })
    ) {
      if (!pointerNavigationRef.current) {
        setHistoricalNavigation(true);
      }
      if (manualScrollEndTimeoutRef.current !== null) {
        window.clearTimeout(manualScrollEndTimeoutRef.current);
      }
      manualScrollEndTimeoutRef.current = window.setTimeout(() => {
        manualScrollEndTimeoutRef.current = null;
        if (!pointerNavigationRef.current) {
          manualScrollRef.current = false;
        }
      }, MANUAL_SCROLL_END_DELAY_MS);
      resolvedLogicalAnchorRef.current = null;
      anchorRef.current = {
        kind: "logical",
        messageIndex: resolveProgressiveTimelineMessageIndex({
          historyAfterSize,
          historyBeforeSize,
          loadedSize,
          messageHistory,
          scrollLength,
          scrollTop,
        }),
      };
      scheduleHistoryLoad();
    }
    if (
      historicalNavigation &&
      messageHistory?.hasMoreAfter === false &&
      previousScrollTop !== null &&
      scrollTop >= previousScrollTop &&
      scrollBottom >= renderedContentHeight - 1
    ) {
      setHistoricalNavigation(false);
    }

    for (const item of minimapItems) {
      const strip = minimapStripMap.get(item.id);
      if (strip === undefined || item.rowIndex === null) {
        continue;
      }
      const row = scrollNode.querySelector<HTMLElement>(
        `[data-message-id="${CSS.escape(item.id)}"]`,
      );
      const viewportRect = scrollNode.getBoundingClientRect();
      const rowRect = row?.getBoundingClientRect();
      const inView =
        rowRect !== undefined &&
        rowRect.bottom > viewportRect.top &&
        rowRect.top < viewportRect.bottom;
      strip.dataset.inView = inView ? "true" : "false";
    }
  }, [
    historyAfterSize,
    historyBeforeSize,
    historicalNavigation,
    listRef,
    loadedSize,
    messageHistory,
    minimapItems,
    minimapStripMap,
    onIsAtEndChange,
    positionHistorySkeletons,
    scheduleHistoryLoad,
    historyScrollElement,
    timelineViewportElement,
  ]);

  const selectHistoryTarget = useCallback(
    (item: TimelineHistoryNavigationTarget) => {
      initialTailPositionPendingRef.current = false;
      if (initialTailPositionTimeoutRef.current !== null) {
        window.clearTimeout(initialTailPositionTimeoutRef.current);
        initialTailPositionTimeoutRef.current = null;
      }
      setHistoricalNavigation(true);
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
      manualScrollRef.current = false;
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
        messageIndex: item.messageIndex,
        viewportOffset: MESSAGE_VIEWPORT_OFFSET,
      };
      pendingRequestRef.current = {
        kind: "message",
        messageId: item.id,
      };
      programmaticScrollRef.current = "seeking";

      const scrollNode = historyScrollElement;
      if (scrollNode === null) {
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
                item.messageIndex * PROGRESSIVE_TIMELINE_MESSAGE_SIZE - MESSAGE_VIEWPORT_OFFSET,
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
        const target = scrollNode.querySelector<HTMLElement>(
          `[data-message-id="${CSS.escape(item.id)}"]`,
        );
        if (target !== null) {
          smoothScroll(
            scrollNode,
            scrollNode.scrollTop +
              target.getBoundingClientRect().top -
              scrollNode.getBoundingClientRect().top -
              MESSAGE_VIEWPORT_OFFSET,
            finishSeek,
          );
          return;
        }
        programmaticScrollRef.current = null;
        queueReconciliation();
      }
    },
    [
      clearAlignmentWait,
      historyTargetMessageId,
      historyScrollElement,
      listRef,
      messageHistory,
      onHistoryTargetReady,
      onManualNavigation,
      onSelectHistoryMessage,
      queueReconciliation,
      setScrollTop,
      smoothScroll,
      timelineViewportElement,
    ],
  );

  useLayoutEffect(() => {
    if (
      messageHistory === undefined ||
      historyWindowKey === null ||
      historyLayoutMeasurement?.windowKey !== historyWindowKey
    ) {
      return;
    }
    const scrollNode = historyScrollElement;
    if (scrollNode === null) {
      return;
    }
    if (latestPositionPendingRef.current) {
      if (messageHistory.hasMoreAfter) {
        return;
      }
      latestPositionPendingRef.current = false;
      historyInitializedRef.current = true;
      anchorRef.current = {
        kind: "logical",
        messageIndex: messageHistory.totalMessages - 1,
      };
      initialTailPositionPendingRef.current = true;
      scheduleInitialTailPosition();
      queueReconciliation();
      return;
    }
    if (!historyInitializedRef.current) {
      historyInitializedRef.current = true;
      anchorRef.current = {
        kind: "logical",
        messageIndex: messageHistory.totalMessages - 1,
      };
      if (messageHistory.hasMoreAfter) {
        anchorRef.current = {
          kind: "logical",
          messageIndex: resolveProgressiveTimelineMessageIndex({
            historyAfterSize,
            historyBeforeSize,
            loadedSize,
            messageHistory,
            scrollLength: scrollNode.clientHeight,
            scrollTop: scrollNode.scrollTop,
          }),
        };
      } else {
        initialTailPositionPendingRef.current = true;
        scheduleInitialTailPosition();
      }
    }
    if (initialTailPositionPendingRef.current) {
      scheduleInitialTailPosition();
    }
    queueReconciliation();
  }, [
    historyAfterSize,
    historyBeforeSize,
    historyScrollElement,
    historyWindowKey,
    historyLayoutMeasurement,
    loadedSize,
    messageHistory,
    queueReconciliation,
    scheduleInitialTailPosition,
  ]);

  useEffect(() => {
    if (
      messageHistory !== undefined &&
      historyWindowKey !== null &&
      !historyLoadInProgress &&
      pendingRequestRef.current?.kind === "logical"
    ) {
      queueReconciliation();
    }
  }, [historyLoadInProgress, historyWindowKey, messageHistory, queueReconciliation]);

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

  const beginKeyboardNavigation = useCallback(
    (event: KeyboardEvent) => {
      if (
        !isProgressiveTimelineNavigationKey(event.key) ||
        (document.activeElement !== document.body &&
          !timelineViewportElement?.contains(document.activeElement))
      ) {
        return;
      }
      beginUserNavigation();
    },
    [beginUserNavigation, timelineViewportElement],
  );

  useEffect(() => {
    window.addEventListener("keydown", beginKeyboardNavigation, true);
    const finishPointerNavigation = () => {
      pointerNavigationRef.current = false;
      manualScrollRef.current = false;
      if (messageHistory !== undefined && historyScrollElement !== null) {
        setHistoricalNavigation(
          messageHistory.hasMoreAfter ||
            historyScrollElement.scrollTop + historyScrollElement.clientHeight <
              historyBeforeSize + loadedSize + historyAfterSize - 1,
        );
      }
    };
    window.addEventListener("pointerup", finishPointerNavigation);
    window.addEventListener("pointercancel", finishPointerNavigation);
    return () => {
      window.removeEventListener("keydown", beginKeyboardNavigation, true);
      window.removeEventListener("pointerup", finishPointerNavigation);
      window.removeEventListener("pointercancel", finishPointerNavigation);
    };
  }, [
    beginKeyboardNavigation,
    historyAfterSize,
    historyBeforeSize,
    historyScrollElement,
    loadedSize,
    messageHistory,
  ]);

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
      if (initialTailPositionTimeoutRef.current !== null) {
        window.clearTimeout(initialTailPositionTimeoutRef.current);
        initialTailPositionTimeoutRef.current = null;
      }
      if (manualScrollEndTimeoutRef.current !== null) {
        window.clearTimeout(manualScrollEndTimeoutRef.current);
        manualScrollEndTimeoutRef.current = null;
      }
    },
    [clearAlignmentWait],
  );

  return useMemo(
    () => ({
      beginUserNavigation,
      beginPointerNavigation,
      contentHeight,
      handleScroll,
      historyAfterSize,
      historyAfterSkeletonsRef,
      historyAfterSpacerRef,
      historyBeforeSize,
      historyBeforeSkeletonsRef,
      historyBeforeSpacerRef,
      selectHistoryTarget,
      virtualHistoryAfterSize,
      virtualHistoryBeforeSize,
    }),
    [
      beginUserNavigation,
      beginPointerNavigation,
      handleScroll,
      historyAfterSize,
      historyBeforeSize,
      selectHistoryTarget,
      contentHeight,
      virtualHistoryAfterSize,
      virtualHistoryBeforeSize,
    ],
  );
}
