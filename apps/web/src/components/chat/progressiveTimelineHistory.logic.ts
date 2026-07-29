import {
  type MessageId,
  type OrchestrationThreadHistoryOutline,
  type OrchestrationThreadMessageHistory,
} from "@t3tools/contracts";

export const PROGRESSIVE_TIMELINE_MESSAGE_SIZE = 240;

export type ProgressiveTimelineProgrammaticScroll = "seeking" | "aligning";

export type ProgressiveTimelineViewportAnchor =
  | {
      readonly kind: "logical";
      readonly messageIndex: number;
    }
  | {
      readonly kind: "message";
      readonly messageId: MessageId;
      readonly messageIndex: number | null;
      readonly viewportOffset: number;
    };

export interface TimelineHistoryNavigationTarget {
  readonly id: MessageId;
  readonly messageIndex: number | null;
  readonly rowIndex: number | null;
}

export interface ProgressiveTimelineLayout {
  readonly contentSize: number;
  readonly historyAfterSize: number;
  readonly historyBeforeSize: number;
  readonly virtualHistoryAfterSize: number;
  readonly virtualHistoryBeforeSize: number;
}

export function resolveProgressiveTimelineLayout({
  anchor,
  loadedSize,
  messageHistory,
  preserveHistoricalCanvas,
}: {
  readonly anchor: {
    readonly messageIndex: number;
    readonly viewportPosition: number;
  } | null;
  readonly loadedSize: number;
  readonly messageHistory: OrchestrationThreadMessageHistory;
  readonly preserveHistoricalCanvas: boolean;
}): ProgressiveTimelineLayout {
  const virtualHistoryBeforeSize = messageHistory.startIndex * PROGRESSIVE_TIMELINE_MESSAGE_SIZE;
  const virtualHistoryAfterSize =
    Math.max(0, messageHistory.totalMessages - messageHistory.endIndex) *
    PROGRESSIVE_TIMELINE_MESSAGE_SIZE;
  const renderedContentSize = virtualHistoryBeforeSize + loadedSize + virtualHistoryAfterSize;
  const contentSize = preserveHistoricalCanvas
    ? Math.max(
        messageHistory.totalMessages * PROGRESSIVE_TIMELINE_MESSAGE_SIZE,
        renderedContentSize,
      )
    : renderedContentSize;
  const canPlaceAtAnchor =
    preserveHistoricalCanvas &&
    anchor !== null &&
    anchor.messageIndex >= messageHistory.startIndex &&
    anchor.messageIndex < messageHistory.endIndex;
  const historyBeforeSize = canPlaceAtAnchor
    ? Math.max(
        0,
        Math.min(
          contentSize - loadedSize,
          anchor.viewportPosition -
            ((anchor.messageIndex - messageHistory.startIndex) /
              Math.max(1, messageHistory.endIndex - messageHistory.startIndex)) *
              loadedSize,
        ),
      )
    : virtualHistoryBeforeSize;
  const historyAfterSize = canPlaceAtAnchor
    ? Math.max(0, contentSize - historyBeforeSize - loadedSize)
    : virtualHistoryAfterSize;
  return {
    contentSize,
    historyAfterSize,
    historyBeforeSize,
    virtualHistoryAfterSize,
    virtualHistoryBeforeSize,
  };
}

export function resolveProgressiveTimelineMessageIndex({
  historyAfterSize,
  historyBeforeSize,
  loadedSize,
  messageHistory,
  scrollLength,
  scrollTop,
}: {
  readonly historyAfterSize: number;
  readonly historyBeforeSize: number;
  readonly loadedSize: number;
  readonly messageHistory: OrchestrationThreadMessageHistory;
  readonly scrollLength: number;
  readonly scrollTop: number;
}): number {
  const viewportPosition = scrollTop + scrollLength / 2;
  const messageIndex =
    viewportPosition <= historyBeforeSize
      ? (viewportPosition / Math.max(1, historyBeforeSize)) * messageHistory.startIndex
      : viewportPosition >= historyBeforeSize + loadedSize
        ? messageHistory.endIndex +
          ((viewportPosition - historyBeforeSize - loadedSize) / Math.max(1, historyAfterSize)) *
            (messageHistory.totalMessages - messageHistory.endIndex)
        : messageHistory.startIndex +
          ((viewportPosition - historyBeforeSize) / Math.max(1, loadedSize)) *
            (messageHistory.endIndex - messageHistory.startIndex);
  return Math.max(0, Math.min(messageHistory.totalMessages - 1, messageIndex));
}

export function handoffProgressiveTimelineAnchorToUser({
  anchor,
  historyAfterSize,
  historyBeforeSize,
  loadedSize,
  messageHistory,
  scrollLength,
  scrollTop,
}: {
  readonly anchor: ProgressiveTimelineViewportAnchor;
  readonly historyAfterSize: number;
  readonly historyBeforeSize: number;
  readonly loadedSize: number;
  readonly messageHistory: OrchestrationThreadMessageHistory;
  readonly scrollLength: number;
  readonly scrollTop: number;
}): Extract<ProgressiveTimelineViewportAnchor, { readonly kind: "logical" }> {
  if (anchor.kind === "logical") {
    return anchor;
  }
  return {
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
}

export function shouldCaptureProgressiveTimelineScroll({
  didScroll,
  isExpectedScroll,
  isManualScroll,
  programmaticScroll,
}: {
  readonly didScroll: boolean;
  readonly isExpectedScroll: boolean;
  readonly isManualScroll: boolean;
  readonly programmaticScroll: ProgressiveTimelineProgrammaticScroll | null;
}): boolean {
  return didScroll && isManualScroll && programmaticScroll === null && !isExpectedScroll;
}

export function isProgressiveTimelineNavigationKey(key: string): boolean {
  switch (key) {
    case "PageUp":
    case "PageDown":
    case "Home":
    case "End":
    case "ArrowUp":
    case "ArrowDown":
    case " ":
      return true;
    default:
      return false;
  }
}

export function resolveProgressiveTimelineHistoryTarget({
  anchorMessageIndex,
  historyOutline,
  loadedMessageIds,
  messageHistory,
  minimapItems,
}: {
  readonly anchorMessageIndex: number;
  readonly historyOutline: OrchestrationThreadHistoryOutline;
  readonly loadedMessageIds: ReadonlyArray<MessageId>;
  readonly messageHistory: OrchestrationThreadMessageHistory;
  readonly minimapItems: ReadonlyArray<TimelineHistoryNavigationTarget>;
}): MessageId | null {
  const [firstLandmark, ...remainingLandmarks] = historyOutline.landmarks;
  if (firstLandmark === undefined) {
    return null;
  }

  let target = firstLandmark;
  let targetMessageIndex =
    target.messageIndex ??
    (target.ordinal / Math.max(1, historyOutline.totalUserMessages - 1)) *
      Math.max(0, messageHistory.totalMessages - 1);
  for (const landmark of remainingLandmarks) {
    const landmarkMessageIndex =
      landmark.messageIndex ??
      (landmark.ordinal / Math.max(1, historyOutline.totalUserMessages - 1)) *
        Math.max(0, messageHistory.totalMessages - 1);
    if (
      Math.abs(landmarkMessageIndex - anchorMessageIndex) <
      Math.abs(targetMessageIndex - anchorMessageIndex)
    ) {
      target = landmark;
      targetMessageIndex = landmarkMessageIndex;
    }
  }

  if (
    anchorMessageIndex < messageHistory.startIndex ||
    anchorMessageIndex >= messageHistory.endIndex
  ) {
    let boundedTarget: (typeof historyOutline.landmarks)[number] | null = null;
    let boundedTargetMessageIndex = 0;
    for (const landmark of historyOutline.landmarks) {
      const landmarkMessageIndex =
        landmark.messageIndex ??
        (landmark.ordinal / Math.max(1, historyOutline.totalUserMessages - 1)) *
          Math.max(0, messageHistory.totalMessages - 1);
      if (
        (anchorMessageIndex < messageHistory.startIndex &&
          landmarkMessageIndex >= messageHistory.startIndex) ||
        (anchorMessageIndex >= messageHistory.endIndex &&
          landmarkMessageIndex < messageHistory.endIndex)
      ) {
        continue;
      }
      if (
        boundedTarget === null ||
        Math.abs(landmarkMessageIndex - anchorMessageIndex) <
          Math.abs(boundedTargetMessageIndex - anchorMessageIndex)
      ) {
        boundedTarget = landmark;
        boundedTargetMessageIndex = landmarkMessageIndex;
      }
    }
    if (boundedTarget !== null) {
      target = boundedTarget;
    }
  }

  if (minimapItems.some((item) => item.id === target.messageId && item.rowIndex !== null)) {
    return target.messageId;
  }

  if (
    anchorMessageIndex >= messageHistory.startIndex &&
    anchorMessageIndex < messageHistory.endIndex
  ) {
    let loadedTarget: TimelineHistoryNavigationTarget | null = null;
    let loadedTargetDistance = Number.POSITIVE_INFINITY;
    for (const item of minimapItems) {
      if (item.rowIndex === null || item.messageIndex === null) {
        continue;
      }
      const distance = Math.abs(item.messageIndex - anchorMessageIndex);
      if (distance < loadedTargetDistance) {
        loadedTarget = item;
        loadedTargetDistance = distance;
      }
    }
    if (loadedTarget !== null) {
      return loadedTarget.id;
    }

    return (
      loadedMessageIds[
        Math.round(
          ((anchorMessageIndex - messageHistory.startIndex) /
            Math.max(1, messageHistory.endIndex - messageHistory.startIndex - 1)) *
            Math.max(0, loadedMessageIds.length - 1),
        )
      ] ?? null
    );
  }

  return target.messageId;
}
