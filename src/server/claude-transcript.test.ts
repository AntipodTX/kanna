import { describe, expect, test } from "bun:test"

import { normalizeClaudeStreamMessage } from "./claude-transcript"

describe("normalizeClaudeStreamMessage", () => {
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
})
