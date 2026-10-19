import { describe, expect, test } from "bun:test"
import { buildChatJumpLocationState, readChatJumpLocationState } from "./chat-navigation"

describe("chat entry jump navigation", () => {
  test("round-trips a named transcript entry through router state", () => {
    const state = buildChatJumpLocationState({ entryId: "agent-1", revealEntryId: "nested-entry-1" })

    expect(state.jumpToEntryId).toBe("agent-1")
    expect(state.jumpToRevealEntryId).toBe("nested-entry-1")
    expect(readChatJumpLocationState(state)).toEqual({
      target: { entryId: "agent-1", revealEntryId: "nested-entry-1" },
      requestId: state.jumpRequestId,
    })
  })

  test("ignores an empty entry id", () => {
    expect(readChatJumpLocationState({ jumpToEntryId: "", jumpRequestId: "request" })).toBeNull()
  })
})
