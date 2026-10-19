import { describe, expect, test } from "bun:test"

import { normalizeClaudeStreamMessage } from "./claude-transcript"

describe("normalizeClaudeStreamMessage", () => {
  test("keeps upstream subagent metadata without duplicating raw transcript payloads", () => {
    const [entry] = normalizeClaudeStreamMessage({
      type: "assistant", uuid: "child-1", parent_tool_use_id: "parent-1",
      message: { content: [{ type: "text", text: "Child findings" }] },
    })
    expect(entry).toMatchObject({ kind: "assistant_text", parentToolUseId: "parent-1" })
    expect(entry).not.toHaveProperty("debugRaw")
  })

  test("imports array-formatted Claude resume banners as compact summaries", () => {
    const [entry] = normalizeClaudeStreamMessage({
      type: "user",
      uuid: "resume-1",
      message: {
        role: "user",
        content: [{
          type: "text",
          text: "This session is being continued from a previous conversation that ran out of context.",
        }],
      },
    })

    expect(entry).toMatchObject({
      kind: "compact_summary",
      messageId: "resume-1",
      summary: "This session is being continued from a previous conversation that ran out of context.",
    })
  })

  for (const sessionField of ["session_id", "sessionId"]) {
    test(`retains ${sessionField} and parent ownership on an imported resume banner`, () => {
      const [entry] = normalizeClaudeStreamMessage({
        type: "user", uuid: "child-resume", [sessionField]: "child-session",
        parent_tool_use_id: "parent-tool",
        ...(sessionField === "session_id" ? { isSidechain: true } : { subagent_type: "researcher" }),
        message: { role: "user", content: [{ type: "text", text: "This session is being continued after compaction." }] },
      })
      expect(entry).toMatchObject({
        kind: "compact_summary", messageId: "child-resume",
        claudeSessionToken: "child-session", parentToolUseId: "parent-tool",
        claudeSidechain: true,
      })
      expect(entry).not.toHaveProperty("debugRaw")
    })
  }
})
