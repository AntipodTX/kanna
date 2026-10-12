import { describe, expect, test } from "bun:test"
import {
  CHAT_MIN_SIZE_PERCENT,
  getEffectiveTerminalMainSizes,
  getTerminalPanelDefaultSizes,
  MAX_TERMINAL_MAIN_SIZES,
  getIgnoreFolderEntryFromDiffPath,
  hasFileDragTypes,
  resolveTranscriptEditUserPromptControls,
  shouldUseMobileRightSidebarOverlay,
  shouldAutoFollowTranscriptResize,
} from "./ChatPage"

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

describe("getEffectiveTerminalMainSizes", () => {
  test("pins the terminal to its ceiling on mobile", () => {
    expect(getEffectiveTerminalMainSizes([68, 32], true)).toEqual([25, 75])
  })

  test("hands back the persisted split untouched on desktop", () => {
    const stored: [number, number] = [68, 32]
    expect(getEffectiveTerminalMainSizes(stored, false)).toBe(stored)
  })

  // Anything taller and the panel group would clamp it back down on the first
  // layout pass, so the pinned height has to be exactly what the chat pane allows.
  test("never asks for more height than the chat pane's minimum leaves", () => {
    const [chatSize, terminalSize] = getEffectiveTerminalMainSizes([68, 32], true)
    expect(chatSize).toBe(CHAT_MIN_SIZE_PERCENT)
    expect(chatSize + terminalSize).toBe(100)
  })

  test("collapses to a hidden terminal even while clamped", () => {
    expect(getTerminalPanelDefaultSizes(false, MAX_TERMINAL_MAIN_SIZES)).toEqual([100, 0])
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

describe("resolveTranscriptEditUserPromptControls", () => {
  test("keeps the edit handler visible while disabling edits during a replacement turn", () => {
    const handler = async () => {}
    const forkHandler = async () => {}

    expect(resolveTranscriptEditUserPromptControls({
      isProcessing: true,
      isDraining: false,
      handleEditUserPrompt: handler,
      handleForkUserPrompt: forkHandler,
    })).toEqual({
      onEditUserPrompt: handler,
      isEditUserPromptDisabled: true,
      onForkUserPrompt: forkHandler,
      isForkUserPromptDisabled: true,
    })
  })

  test("keeps the edit handler visible while disabling edits during stream draining", () => {
    const handler = async () => {}
    const forkHandler = async () => {}

    expect(resolveTranscriptEditUserPromptControls({
      isProcessing: false,
      isDraining: true,
      handleEditUserPrompt: handler,
      handleForkUserPrompt: forkHandler,
    })).toEqual({
      onEditUserPrompt: handler,
      isEditUserPromptDisabled: true,
      onForkUserPrompt: forkHandler,
      isForkUserPromptDisabled: true,
    })
  })

  test("enables edit controls while idle", () => {
    const handler = async () => {}
    const forkHandler = async () => {}

    expect(resolveTranscriptEditUserPromptControls({
      isProcessing: false,
      isDraining: false,
      handleEditUserPrompt: handler,
      handleForkUserPrompt: forkHandler,
    })).toEqual({
      onEditUserPrompt: handler,
      isEditUserPromptDisabled: false,
      onForkUserPrompt: forkHandler,
      isForkUserPromptDisabled: false,
    })
  })
})
