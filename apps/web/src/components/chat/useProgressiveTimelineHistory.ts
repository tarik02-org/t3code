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
      readonly viewportOffset: number;
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
  readonly beforeSize: number;
}

interface ResolvedLogicalAnchor {
  readonly anchorMessageIndex: number;
  readonly messageId: MessageId;
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
  readonly isLoadingNextMessages: boolean;
  readonly isLoadingPreviousMessages: boolean;
  readonly listRef: RefObject<LegendListRef | null>;
  readonly messageHistory: OrchestrationThreadMessageHistory | undefined;
  readonly minimapItems: ReadonlyArray<TimelineHistoryNavigationTarget>;
  readonly minimapStripMap: Map<string, HTMLSpanElement>;
  readonly onHistoryTargetReady: (() => void) | undefined;
  readonly onIsAtEndChange: (isAtEnd: boolean) => void;
  readonly onManualNavigation: () => void;
  readonly onSelectHistoryMessage: ((messageId: MessageId) => void) | undefined;
  readonly rows: ReadonlyArray<MessagesTimelineRow>;
  readonly timelineViewportElement: HTMLDivElement | null;
}

export function useProgressiveTimelineHistory({
  historyOutline,
  historyTargetMessageId,
  isLoadingNextMessages,
  isLoadingPreviousMessages,
  listRef,
  messageHistory,
  minimapItems,
  minimapStripMap,
  onHistoryTargetReady,
  onIsAtEndChange,
  onManualNavigation,
  onSelectHistoryMessage,
  rows,
  timelineViewportElement,
}: UseProgressiveTimelineHistoryInput) {
  const anchorRef = useRef<ViewportAnchor | null>(null);
  const pendingRequestRef = useRef<PendingHistoryRequest | null>(null);
  const resolvedLogicalAnchorRef = useRef<ResolvedLogicalAnchor | null>(null);
  const programmaticScrollRef = useRef<"instant" | "message" | "aligning" | null>(null);
  const pointerActiveRef = useRef(false);
  const loadTimeoutRef = useRef<number | null>(null);
  const lastLoadAtRef = useRef(0);
  const reconcileFrameRef = useRef<number | null>(null);
  const reconcileAnchorRef = useRef<() => void>(() => {});
  const releaseProgrammaticScrollFrameRef = useRef<number | null>(null);
  const alignmentCleanupRef = useRef<(() => void) | null>(null);
  const historyBeforeSpacerRef = useRef<HTMLDivElement>(null);
  const historyAfterSpacerRef = useRef<HTMLDivElement>(null);
  const historyBeforeSkeletonsRef = useRef<HTMLDivElement>(null);
  const historyAfterSkeletonsRef = useRef<HTMLDivElement>(null);
  const clearedWindowKeyRef = useRef<string | null>(null);
  const [layoutMeasurement, setLayoutMeasurement] = useState<HistoryLayoutMeasurement | null>(null);
  const loadedMessageIds = useMemo(
    () =>
      rows.flatMap((row) => {
        if (row.kind === "message") {
          return [row.message.id];
        }
        return [];
      }),
    [rows],
  );

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
  const totalHistorySize = (messageHistory?.totalMessages ?? 0) * VIRTUAL_MESSAGE_SIZE;
  const virtualHistoryBeforeSize = (messageHistory?.startIndex ?? 0) * VIRTUAL_MESSAGE_SIZE;
  const measuredHistoryBeforeSize =
    layoutMeasurement?.windowKey === historyWindowKey
      ? layoutMeasurement.beforeSize
      : virtualHistoryBeforeSize;
  const historyBeforeSize = Math.min(
    measuredHistoryBeforeSize,
    Math.max(0, totalHistorySize - loadedSize),
  );
  const historyAfterSize = Math.max(0, totalHistorySize - historyBeforeSize - loadedSize);
  const virtualHistoryAfterSize =
    Math.max(0, (messageHistory?.totalMessages ?? 0) - (messageHistory?.endIndex ?? 0)) *
    VIRTUAL_MESSAGE_SIZE;
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
    resolvedLogicalAnchorRef.current = null;
    anchorRef.current = {
      kind: "logical",
      messageIndex: Math.max(
        0,
        Math.min(
          messageHistory.totalMessages - 1,
          (scrollNode.scrollTop + viewportOffset) / VIRTUAL_MESSAGE_SIZE,
        ),
      ),
      viewportOffset,
    };
  }, [listRef, messageHistory]);

  const releaseInstantScroll = useCallback(() => {
    if (releaseProgrammaticScrollFrameRef.current !== null) {
      cancelAnimationFrame(releaseProgrammaticScrollFrameRef.current);
    }
    releaseProgrammaticScrollFrameRef.current = requestAnimationFrame(() => {
      releaseProgrammaticScrollFrameRef.current = null;
      if (programmaticScrollRef.current === "instant") {
        programmaticScrollRef.current = null;
      }
    });
  }, []);

  const queueReconciliation = useCallback(() => {
    if (reconcileFrameRef.current !== null) {
      return;
    }
    reconcileFrameRef.current = requestAnimationFrame(() => {
      reconcileFrameRef.current = null;
      reconcileAnchorRef.current();
    });
  }, []);

  const reconcileAnchor = useCallback(() => {
    if (messageHistory === undefined || timelineViewportElement === null) {
      return false;
    }
    const list = listRef.current;
    const scrollNode = list?.getScrollableNode();
    const anchor = anchorRef.current;
    if (list === null || list === undefined || scrollNode === undefined || anchor === null) {
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
      const resolvedAnchor = resolvedLogicalAnchorRef.current;
      const alignmentMessageId =
        pendingRequest?.kind === "logical"
          ? pendingRequest.messageId
          : resolvedAnchor?.windowKey === historyWindowKey &&
              Math.abs(resolvedAnchor.anchorMessageIndex - anchor.messageIndex) <= 0.01
            ? resolvedAnchor.messageId
            : null;
      if (alignmentMessageId !== null && historyWindowKey !== null) {
        const target = timelineViewportElement.querySelector<HTMLElement>(
          `[data-message-id="${CSS.escape(alignmentMessageId)}"]`,
        );
        const loadedRowsContainer =
          historyBeforeSpacerRef.current?.parentElement?.nextElementSibling;
        if (target === null || loadedRowsContainer === null || loadedRowsContainer === undefined) {
          return false;
        }
        const nextBeforeSize = Math.max(
          0,
          Math.min(
            totalHistorySize - loadedSize,
            scrollNode.scrollTop +
              anchor.viewportOffset -
              (target.getBoundingClientRect().top -
                loadedRowsContainer.getBoundingClientRect().top),
          ),
        );
        if (Math.abs(historyBeforeSize - nextBeforeSize) > 1) {
          setLayoutMeasurement({
            windowKey: historyWindowKey,
            loadedSize,
            beforeSize: nextBeforeSize,
          });
          return false;
        }
      }

      const scrollTop = Math.max(
        0,
        Math.min(
          scrollNode.scrollHeight - scrollNode.clientHeight,
          anchor.messageIndex * VIRTUAL_MESSAGE_SIZE - anchor.viewportOffset,
        ),
      );
      if (Math.abs(scrollNode.scrollTop - scrollTop) > 1) {
        programmaticScrollRef.current = "instant";
        void list.scrollToOffset({ offset: scrollTop, animated: false });
        releaseInstantScroll();
        queueReconciliation();
        return false;
      }
      return true;
    }

    const target = timelineViewportElement.querySelector<HTMLElement>(
      `[data-message-id="${CSS.escape(anchor.messageId)}"]`,
    );
    if (target === null) {
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
      programmaticScrollRef.current = "instant";
      void list.scrollToOffset({ offset: scrollTop, animated: false });
      releaseInstantScroll();
      queueReconciliation();
      return false;
    }
    if (programmaticScrollRef.current === "aligning") {
      return false;
    }

    clearAlignmentWait();
    programmaticScrollRef.current = "aligning";
    const finishAlignment = () => {
      clearAlignmentWait();
      if (programmaticScrollRef.current === "aligning") {
        programmaticScrollRef.current = "message";
      }
      queueReconciliation();
    };
    scrollNode.addEventListener("scrollend", finishAlignment, { once: true });
    const timeout = window.setTimeout(finishAlignment, 500);
    alignmentCleanupRef.current = () => {
      window.clearTimeout(timeout);
      scrollNode.removeEventListener("scrollend", finishAlignment);
    };
    scrollNode.scrollTo({ behavior: "smooth", top: scrollTop });
    return false;
  }, [
    clearAlignmentWait,
    historyBeforeSize,
    historyTargetMessageId,
    historyWindowKey,
    listRef,
    loadedSize,
    messageHistory,
    onHistoryTargetReady,
    queueReconciliation,
    releaseInstantScroll,
    timelineViewportElement,
    totalHistorySize,
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
    const renderedHistoryBeforeSize =
      historyBeforeSpacerRef.current?.offsetHeight ?? historyBeforeSize;
    const renderedHistoryAfterSize =
      historyAfterSpacerRef.current?.offsetHeight ?? historyAfterSize;
    const loadedHistoryEnd =
      (scrollNode?.scrollHeight ?? state.contentLength ?? 0) - renderedHistoryAfterSize;
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
      const scrollWithinHistory = Math.max(0, scrollTop - loadedHistoryEnd);
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

    if (messageHistory !== undefined && programmaticScrollRef.current === null) {
      captureLogicalAnchor();
      scheduleHistoryLoad();
    } else if (
      programmaticScrollRef.current === "message" ||
      programmaticScrollRef.current === "aligning"
    ) {
      queueReconciliation();
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
    captureLogicalAnchor,
    historyAfterSize,
    historyBeforeSize,
    listRef,
    messageHistory,
    minimapItems,
    minimapStripMap,
    onIsAtEndChange,
    queueReconciliation,
    scheduleHistoryLoad,
  ]);

  const beginUserNavigation = useCallback(() => {
    const anchor = anchorRef.current;
    clearAlignmentWait();
    programmaticScrollRef.current = null;
    if (anchor?.kind === "message" && historyTargetMessageId === anchor.messageId) {
      onHistoryTargetReady?.();
    }
    captureLogicalAnchor();
    onManualNavigation();
  }, [
    captureLogicalAnchor,
    clearAlignmentWait,
    historyTargetMessageId,
    onHistoryTargetReady,
    onManualNavigation,
  ]);

  const beginScrollbarPointerNavigation = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      const scrollNode = listRef.current?.getScrollableNode();
      if (event.target !== scrollNode) {
        return;
      }
      pointerActiveRef.current = true;
      beginUserNavigation();
    },
    [beginUserNavigation, listRef],
  );

  const finishScrollbarPointerNavigation = useCallback(() => {
    if (!pointerActiveRef.current) {
      return;
    }
    pointerActiveRef.current = false;
    captureLogicalAnchor();
    scheduleHistoryLoad();
  }, [captureLogicalAnchor, scheduleHistoryLoad]);

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
      anchorRef.current = {
        kind: "message",
        messageId: item.id,
        viewportOffset: MESSAGE_VIEWPORT_OFFSET,
      };
      pendingRequestRef.current = {
        kind: "message",
        messageId: item.id,
      };
      programmaticScrollRef.current = "message";

      const list = listRef.current;
      const scrollNode = list?.getScrollableNode();
      if (list === null || list === undefined || scrollNode === undefined) {
        return;
      }
      if (item.rowIndex !== null) {
        void list.scrollToIndex({
          index: item.rowIndex,
          animated: true,
          viewOffset: MESSAGE_VIEWPORT_OFFSET,
        });
        queueReconciliation();
        return;
      }
      if (item.messageIndex !== null) {
        scrollNode.scrollTo({
          behavior: "smooth",
          top: Math.max(
            0,
            Math.min(
              scrollNode.scrollHeight - scrollNode.clientHeight,
              item.messageIndex * VIRTUAL_MESSAGE_SIZE - MESSAGE_VIEWPORT_OFFSET,
            ),
          ),
        });
      }
      onSelectHistoryMessage?.(item.id);
    },
    [
      clearAlignmentWait,
      listRef,
      messageHistory,
      onManualNavigation,
      onSelectHistoryMessage,
      queueReconciliation,
    ],
  );

  useLayoutEffect(() => {
    if (messageHistory === undefined || historyWindowKey === null) {
      return;
    }
    const beforeSpacer = historyBeforeSpacerRef.current;
    const loadedRowsContainer = beforeSpacer?.parentElement?.nextElementSibling;
    if (loadedRowsContainer === null || loadedRowsContainer === undefined) {
      return;
    }

    const measure = () => {
      const loadedSize = loadedRowsContainer.getBoundingClientRect().height;
      setLayoutMeasurement((current) =>
        current?.windowKey === historyWindowKey && Math.abs(current.loadedSize - loadedSize) <= 1
          ? current
          : {
              windowKey: historyWindowKey,
              loadedSize,
              beforeSize:
                current?.windowKey === historyWindowKey
                  ? Math.min(current.beforeSize, Math.max(0, totalHistorySize - loadedSize))
                  : Math.min(virtualHistoryBeforeSize, Math.max(0, totalHistorySize - loadedSize)),
            },
      );
      queueReconciliation();
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(loadedRowsContainer);
    return () => {
      observer.disconnect();
    };
  }, [
    historyWindowKey,
    messageHistory,
    queueReconciliation,
    rows.length,
    totalHistorySize,
    virtualHistoryBeforeSize,
  ]);

  useLayoutEffect(() => {
    if (messageHistory === undefined || historyWindowKey === null) {
      return;
    }
    const list = listRef.current;
    const scrollNode = list?.getScrollableNode();
    if (list === null || list === undefined || scrollNode === undefined) {
      return;
    }
    if (anchorRef.current === null) {
      captureLogicalAnchor();
    }
    scheduleHistoryLoad();
    if (clearedWindowKeyRef.current !== historyWindowKey) {
      clearedWindowKeyRef.current = historyWindowKey;
      list.clearCaches();
    }
    queueReconciliation();

    const frame = requestAnimationFrame(() => {
      const anchor = anchorRef.current;
      if (
        anchor?.kind !== "logical" ||
        anchor.messageIndex < messageHistory.startIndex ||
        anchor.messageIndex >= messageHistory.endIndex
      ) {
        return;
      }
      const loadedRowsContainer = historyBeforeSpacerRef.current?.parentElement?.nextElementSibling;
      if (loadedRowsContainer === null || loadedRowsContainer === undefined) {
        return;
      }
      const viewportRect = scrollNode.getBoundingClientRect();
      const viewportContainsRenderedRow = Array.from(loadedRowsContainer.children).some((row) => {
        const rowRect = row.getBoundingClientRect();
        return rowRect.bottom > viewportRect.top && rowRect.top < viewportRect.bottom;
      });
      if (viewportContainsRenderedRow) {
        return;
      }
      const scrollTop = scrollNode.scrollTop;
      programmaticScrollRef.current = "instant";
      void list.scrollToOffset({
        offset: scrollTop > 1 ? scrollTop - 2 : scrollTop + 2,
        animated: false,
      });
      void list.scrollToOffset({ offset: scrollTop, animated: false });
      releaseInstantScroll();
    });
    return () => {
      cancelAnimationFrame(frame);
    };
  }, [
    captureLogicalAnchor,
    historyAfterSize,
    historyBeforeSize,
    historyWindowKey,
    listRef,
    messageHistory,
    queueReconciliation,
    releaseInstantScroll,
    rows.length,
    scheduleHistoryLoad,
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
    const frame = requestAnimationFrame(() => {
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
    });
    return () => cancelAnimationFrame(frame);
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
    window.addEventListener("pointerup", finishScrollbarPointerNavigation);
    window.addEventListener("pointercancel", finishScrollbarPointerNavigation);
    return () => {
      window.removeEventListener("pointerup", finishScrollbarPointerNavigation);
      window.removeEventListener("pointercancel", finishScrollbarPointerNavigation);
    };
  }, [finishScrollbarPointerNavigation]);

  useEffect(
    () => () => {
      clearAlignmentWait();
      if (loadTimeoutRef.current !== null) {
        window.clearTimeout(loadTimeoutRef.current);
        loadTimeoutRef.current = null;
      }
      if (reconcileFrameRef.current !== null) {
        cancelAnimationFrame(reconcileFrameRef.current);
        reconcileFrameRef.current = null;
      }
      if (releaseProgrammaticScrollFrameRef.current !== null) {
        cancelAnimationFrame(releaseProgrammaticScrollFrameRef.current);
        releaseProgrammaticScrollFrameRef.current = null;
      }
    },
    [clearAlignmentWait],
  );

  return useMemo(
    () => ({
      beginScrollbarPointerNavigation,
      beginUserNavigation,
      contentHeight: totalHistorySize,
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
      beginScrollbarPointerNavigation,
      beginUserNavigation,
      handleScroll,
      historyAfterSize,
      historyBeforeSize,
      selectHistoryTarget,
      totalHistorySize,
      virtualHistoryAfterSize,
      virtualHistoryBeforeSize,
    ],
  );
}
