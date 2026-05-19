import { describe, expect, mock, test } from "bun:test"
import {
  ensureChatSearchResultTargetLoaded,
  getNextHandledProjectSearchTargetKey,
  getTerminalPanelDefaultSizes,
  getRightSidebarSizePercent,
  getRightSidebarSizePx,
  getIgnoreFolderEntryFromDiffPath,
  hasFileDragTypes,
  resolveTranscriptEditUserPromptControls,
  shouldAttemptProjectSearchTargetLoad,
  shouldUseMobileRightSidebarOverlay,
  shouldAutoFollowTranscriptResize,
} from "./ChatPage"

describe("ensureChatSearchResultTargetLoaded", () => {
  test("loads the scroll target even when the matching entry is already loaded", async () => {
    const calls: string[] = []
    const ensureTranscriptEntryLoaded = mock(async (entryId: string) => {
      calls.push(entryId)
      return entryId === "tool-result"
    })

    await expect(ensureChatSearchResultTargetLoaded({
      entryId: "tool-result",
      targetEntryId: "tool-call",
    }, ensureTranscriptEntryLoaded)).resolves.toBe(false)

    expect(calls).toEqual(["tool-result", "tool-call"])
  })

  test("returns true only after both the matching entry and scroll target are loaded", async () => {
    const ensureTranscriptEntryLoaded = mock(async () => true)

    await expect(ensureChatSearchResultTargetLoaded({
      entryId: "tool-result",
      targetEntryId: "tool-call",
    }, ensureTranscriptEntryLoaded)).resolves.toBe(true)
  })

  test("does not load the same entry twice when the match is its own target", async () => {
    const ensureTranscriptEntryLoaded = mock(async () => true)

    await expect(ensureChatSearchResultTargetLoaded({
      entryId: "assistant-message",
      targetEntryId: "assistant-message",
    }, ensureTranscriptEntryLoaded)).resolves.toBe(true)

    expect(ensureTranscriptEntryLoaded).toHaveBeenCalledTimes(1)
  })
})

describe("project search target loading", () => {
  const target = { entryId: "entry-1", targetEntryId: "target-1" }

  test("does not mark a search target handled when loading did not find it", () => {
    const targetKey = shouldAttemptProjectSearchTargetLoad({
      activeChatId: "chat-1",
      target,
      handledKey: null,
      pendingKey: null,
    })

    expect(targetKey).toBe("chat-1:entry-1:target-1")
    expect(getNextHandledProjectSearchTargetKey(null, targetKey!, false)).toBeNull()
  })

  test("allows retrying the same target after a pending attempt is cleared", () => {
    const targetKey = "chat-1:entry-1:target-1"

    expect(shouldAttemptProjectSearchTargetLoad({
      activeChatId: "chat-1",
      target,
      handledKey: null,
      pendingKey: targetKey,
    })).toBeNull()

    expect(shouldAttemptProjectSearchTargetLoad({
      activeChatId: "chat-1",
      target,
      handledKey: null,
      pendingKey: null,
    })).toBe(targetKey)
  })
})

describe("hasFileDragTypes", () => {
  test("returns true when file drags are present", () => {
    expect(hasFileDragTypes(["text/plain", "Files"])).toBe(true)
  })

  test("returns false for non-file drags", () => {
    expect(hasFileDragTypes(["text/plain", "text/uri-list"])).toBe(false)
  })
})

describe("getIgnoreFolderEntryFromDiffPath", () => {
  test("returns the parent folder with a trailing slash", () => {
    expect(getIgnoreFolderEntryFromDiffPath("tmp/cache/output.log")).toBe("tmp/cache/")
  })

  test("normalizes repeated separators before deriving the folder", () => {
    expect(getIgnoreFolderEntryFromDiffPath("tmp//cache/output.log")).toBe("tmp/cache/")
  })

  test("returns null for repo root files", () => {
    expect(getIgnoreFolderEntryFromDiffPath("scratch.log")).toBeNull()
  })
})

describe("shouldAutoFollowTranscriptResize", () => {
  test("keeps auto-follow enabled while the scroll button is hidden", () => {
    expect(shouldAutoFollowTranscriptResize(false, 0, 1_000)).toBe(true)
  })

  test("keeps auto-follow enabled briefly after chat selection", () => {
    expect(shouldAutoFollowTranscriptResize(true, 2_000, 1_500)).toBe(true)
  })

  test("stops forcing auto-follow after the selection window expires", () => {
    expect(shouldAutoFollowTranscriptResize(true, 2_000, 2_000)).toBe(false)
  })
})

describe("shouldUseMobileRightSidebarOverlay", () => {
  test("enables the overlay below the mobile breakpoint", () => {
    expect(shouldUseMobileRightSidebarOverlay(767)).toBe(true)
  })

  test("keeps the desktop split layout at and above the breakpoint", () => {
    expect(shouldUseMobileRightSidebarOverlay(768)).toBe(false)
    expect(shouldUseMobileRightSidebarOverlay(1280)).toBe(false)
  })
})

describe("getTerminalPanelDefaultSizes", () => {
  test("uses persisted terminal sizes while the terminal is visible", () => {
    expect(getTerminalPanelDefaultSizes(true, [68, 32])).toEqual([68, 32])
  })

  test("collapses the terminal panel defaults while the terminal is hidden", () => {
    expect(getTerminalPanelDefaultSizes(false, [68, 32])).toEqual([100, 0])
  })
})

describe("right sidebar pixel sizing", () => {
  test("converts the saved pixel width to a panel percentage", () => {
    expect(getRightSidebarSizePercent(420, 1_200)).toBe(35)
  })

  test("keeps the panel at the minimum pixel width", () => {
    expect(getRightSidebarSizePercent(100, 1_000)).toBe(37)
  })

  test("caps the panel so the workspace keeps its minimum share", () => {
    expect(getRightSidebarSizePercent(1_200, 1_000)).toBe(80)
  })

  test("converts the panel percentage back to pixels", () => {
    expect(getRightSidebarSizePx(35, 1_200)).toBe(420)
  })
})
