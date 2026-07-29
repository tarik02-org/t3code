import {
  type OrchestrationThreadHistoryOutline,
  type OrchestrationThreadMessageHistory,
  MessageId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  handoffProgressiveTimelineAnchorToUser,
  isProgressiveTimelineNavigationKey,
  resolveProgressiveTimelineHistoryTarget,
  resolveProgressiveTimelineLayout,
  resolveProgressiveTimelineMessageIndex,
  shouldCaptureProgressiveTimelineScroll,
} from "./progressiveTimelineHistory.logic";

const messageHistory = {
  hasMoreBefore: true,
  hasMoreAfter: true,
  startIndex: 100,
  endIndex: 200,
  totalMessages: 1_000,
  cursor: null,
} satisfies OrchestrationThreadMessageHistory;

const outline = {
  totalUserMessages: 3,
  landmarks: [
    {
      messageId: MessageId.make("landmark-100"),
      ordinal: 0,
      messageIndex: 100,
      createdAt: "2026-07-29T00:00:00.000Z",
      preview: "100",
    },
    {
      messageId: MessageId.make("landmark-500"),
      ordinal: 1,
      messageIndex: 500,
      createdAt: "2026-07-29T00:01:00.000Z",
      preview: "500",
    },
    {
      messageId: MessageId.make("landmark-900"),
      ordinal: 2,
      messageIndex: 900,
      createdAt: "2026-07-29T00:02:00.000Z",
      preview: "900",
    },
  ],
} satisfies OrchestrationThreadHistoryOutline;

describe("progressive timeline history", () => {
  it("maps unloaded and loaded viewport positions onto one logical message axis", () => {
    const input = {
      historyAfterSize: 192_000,
      historyBeforeSize: 24_000,
      loadedSize: 20_000,
      messageHistory,
      scrollLength: 600,
    };

    expect(resolveProgressiveTimelineMessageIndex({ ...input, scrollTop: 12_000 })).toBeCloseTo(
      51.25,
    );
    expect(resolveProgressiveTimelineMessageIndex({ ...input, scrollTop: 34_000 })).toBeCloseTo(
      151.5,
    );
    expect(resolveProgressiveTimelineMessageIndex({ ...input, scrollTop: 50_000 })).toBeCloseTo(
      226.25,
    );
  });

  it("keeps a stable historical canvas and lets the live tail end at real content", () => {
    const firstHistoricalWindow = resolveProgressiveTimelineLayout({
      anchor: null,
      loadedSize: 18_000,
      messageHistory,
      preserveHistoricalCanvas: true,
    });
    const nextHistoricalWindow = resolveProgressiveTimelineLayout({
      anchor: null,
      loadedSize: 12_000,
      messageHistory: {
        ...messageHistory,
        startIndex: 500,
        endIndex: 600,
      },
      preserveHistoricalCanvas: true,
    });

    expect(firstHistoricalWindow).toEqual({
      contentSize: 240_000,
      historyAfterSize: 192_000,
      historyBeforeSize: 24_000,
      virtualHistoryAfterSize: 192_000,
      virtualHistoryBeforeSize: 24_000,
    });
    expect(nextHistoricalWindow.contentSize).toBe(firstHistoricalWindow.contentSize);
    expect(
      resolveProgressiveTimelineLayout({
        anchor: {
          messageIndex: 550,
          viewportPosition: 120_000,
        },
        loadedSize: 12_000,
        messageHistory: {
          ...messageHistory,
          startIndex: 500,
          endIndex: 600,
        },
        preserveHistoricalCanvas: true,
      }),
    ).toEqual({
      contentSize: 240_000,
      historyAfterSize: 114_000,
      historyBeforeSize: 114_000,
      virtualHistoryAfterSize: 96_000,
      virtualHistoryBeforeSize: 120_000,
    });
    expect(
      resolveProgressiveTimelineLayout({
        anchor: null,
        loadedSize: 18_000,
        messageHistory: {
          ...messageHistory,
          startIndex: 900,
          endIndex: 1_000,
          hasMoreAfter: false,
        },
        preserveHistoricalCanvas: false,
      }),
    ).toEqual({
      contentSize: 234_000,
      historyAfterSize: 0,
      historyBeforeSize: 216_000,
      virtualHistoryAfterSize: 0,
      virtualHistoryBeforeSize: 216_000,
    });
    expect(
      resolveProgressiveTimelineLayout({
        anchor: null,
        loadedSize: 30_000,
        messageHistory: {
          ...messageHistory,
          startIndex: 900,
          endIndex: 950,
        },
        preserveHistoricalCanvas: true,
      }),
    ).toEqual({
      contentSize: 258_000,
      historyAfterSize: 12_000,
      historyBeforeSize: 216_000,
      virtualHistoryAfterSize: 12_000,
      virtualHistoryBeforeSize: 216_000,
    });
  });

  it("keeps the loaded segment fixed when manual scrolling replaces a message anchor", () => {
    const anchoredLayout = resolveProgressiveTimelineLayout({
      anchor: {
        messageIndex: 550,
        viewportPosition: 100_000,
      },
      loadedSize: 12_000,
      messageHistory: {
        ...messageHistory,
        startIndex: 500,
        endIndex: 600,
      },
      preserveHistoricalCanvas: true,
    });
    const manualAnchor = handoffProgressiveTimelineAnchorToUser({
      anchor: {
        kind: "message",
        messageId: MessageId.make("message-550"),
        messageIndex: 550,
        viewportOffset: 300,
      },
      historyAfterSize: anchoredLayout.historyAfterSize,
      historyBeforeSize: anchoredLayout.historyBeforeSize,
      loadedSize: 12_000,
      messageHistory: {
        ...messageHistory,
        startIndex: 500,
        endIndex: 600,
      },
      scrollLength: 600,
      scrollTop: 99_700,
    });
    expect(manualAnchor).toEqual({
      kind: "logical",
      messageIndex: 550,
    });
    const manualLayout = resolveProgressiveTimelineLayout({
      anchor: {
        messageIndex: manualAnchor.messageIndex,
        viewportPosition: 100_000,
      },
      loadedSize: 12_000,
      messageHistory: {
        ...messageHistory,
        startIndex: 500,
        endIndex: 600,
      },
      preserveHistoricalCanvas: true,
    });

    expect(manualLayout).toEqual(anchoredLayout);
  });

  it("only captures scroll events owned by manual navigation", () => {
    expect(
      shouldCaptureProgressiveTimelineScroll({
        didScroll: true,
        isExpectedScroll: false,
        isManualScroll: true,
        programmaticScroll: null,
      }),
    ).toBe(true);
    expect(
      shouldCaptureProgressiveTimelineScroll({
        didScroll: true,
        isExpectedScroll: true,
        isManualScroll: true,
        programmaticScroll: null,
      }),
    ).toBe(false);
    expect(
      shouldCaptureProgressiveTimelineScroll({
        didScroll: true,
        isExpectedScroll: false,
        isManualScroll: true,
        programmaticScroll: "aligning",
      }),
    ).toBe(false);
    expect(
      shouldCaptureProgressiveTimelineScroll({
        didScroll: true,
        isExpectedScroll: false,
        isManualScroll: false,
        programmaticScroll: null,
      }),
    ).toBe(false);
    expect(
      shouldCaptureProgressiveTimelineScroll({
        didScroll: false,
        isExpectedScroll: false,
        isManualScroll: true,
        programmaticScroll: null,
      }),
    ).toBe(false);
  });

  it("recognizes only keys that can navigate the timeline", () => {
    for (const key of ["PageUp", "PageDown", "Home", "End", "ArrowUp", "ArrowDown", " "]) {
      expect(isProgressiveTimelineNavigationKey(key)).toBe(true);
    }
    expect(isProgressiveTimelineNavigationKey("a")).toBe(false);
    expect(isProgressiveTimelineNavigationKey("Enter")).toBe(false);
  });

  it("selects the nearest bounded history landmark", () => {
    expect(
      resolveProgressiveTimelineHistoryTarget({
        anchorMessageIndex: 540,
        historyOutline: outline,
        loadedMessageIds: [],
        messageHistory,
        minimapItems: [],
      }),
    ).toBe(MessageId.make("landmark-500"));
  });

  it("selects a landmark beyond the active window when the viewport leaves it", () => {
    expect(
      resolveProgressiveTimelineHistoryTarget({
        anchorMessageIndex: 300,
        historyOutline: outline,
        loadedMessageIds: [MessageId.make("landmark-500")],
        messageHistory: {
          ...messageHistory,
          startIndex: 500,
          endIndex: 600,
        },
        minimapItems: [
          {
            id: MessageId.make("landmark-500"),
            messageIndex: 500,
            rowIndex: 0,
          },
        ],
      }),
    ).toBe(MessageId.make("landmark-100"));
  });

  it("uses the nearest loaded target while the viewport remains inside the active window", () => {
    const loadedMessageId = MessageId.make("loaded-160");

    expect(
      resolveProgressiveTimelineHistoryTarget({
        anchorMessageIndex: 160,
        historyOutline: outline,
        loadedMessageIds: [loadedMessageId],
        messageHistory,
        minimapItems: [
          {
            id: loadedMessageId,
            messageIndex: 160,
            rowIndex: 4,
          },
        ],
      }),
    ).toBe(loadedMessageId);
  });
});
