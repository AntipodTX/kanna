import { describe, expect, test } from "bun:test"
import { processTranscriptMessages } from "./parseTranscript"
import { getLatestToolIds } from "../app/derived"
import type { TranscriptEntry } from "../../shared/types"

function entry(partial: Omit<TranscriptEntry, "_id" | "createdAt">): TranscriptEntry {
  return {
    _id: crypto.randomUUID(),
    createdAt: Date.now(),
    ...partial,
  } as TranscriptEntry
}

describe("processTranscriptMessages", () => {
  test("hydrates tool results onto prior tool calls", () => {
    const messages = processTranscriptMessages([
      entry({
        kind: "tool_call",
        tool: {
          kind: "tool",
          toolKind: "bash",
          toolName: "Bash",
          toolId: "tool-1",
          input: { command: "pwd" },
        },
      }),
      entry({
        kind: "tool_result",
        toolId: "tool-1",
        content: "/Users/jake/Projects/kanna\n",
      }),
    ])

    expect(messages).toHaveLength(1)
    expect(messages[0]?.kind).toBe("tool")
    if (messages[0]?.kind !== "tool") throw new Error("unexpected message")
    expect(messages[0].result).toBe("/Users/jake/Projects/kanna\n")
  })

  test("hydrates ask-user-question results with typed answers", () => {
    const messages = processTranscriptMessages([
      entry({
        kind: "tool_call",
        tool: {
          kind: "tool",
          toolKind: "ask_user_question",
          toolName: "AskUserQuestion",
          toolId: "tool-2",
          input: {
            questions: [{ question: "Provider?" }],
          },
        },
      }),
      entry({
        kind: "tool_result",
        toolId: "tool-2",
        content: { answers: { "Provider?": ["Codex"] } },
      }),
    ])

    expect(messages[0]?.kind).toBe("tool")
    if (messages[0]?.kind !== "tool") throw new Error("unexpected message")
    expect(messages[0].result).toEqual({ answers: { "Provider?": ["Codex"] } })
  })

  test("hydrates discarded prompt tool results", () => {
    const messages = processTranscriptMessages([
      entry({
        kind: "tool_call",
        tool: {
          kind: "tool",
          toolKind: "exit_plan_mode",
          toolName: "ExitPlanMode",
          toolId: "tool-3",
          input: {
            plan: "## Plan",
          },
        },
      }),
      entry({
        kind: "tool_result",
        toolId: "tool-3",
        content: { discarded: true },
      }),
    ])

    expect(messages[0]?.kind).toBe("tool")
    if (messages[0]?.kind !== "tool") throw new Error("unexpected message")
    expect(messages[0].result).toEqual({ discarded: true })
  })

  test("preserves attachments on hydrated user prompts", () => {
    const messages = processTranscriptMessages([
      entry({
        kind: "user_prompt",
        content: "Please inspect these.",
        attachments: [{
          id: "file-1",
          kind: "file",
          displayName: "spec.pdf",
          absolutePath: "/tmp/project/.kanna/uploads/spec.pdf",
          relativePath: "./.kanna/uploads/spec.pdf",
          contentUrl: "/api/projects/project-1/uploads/spec.pdf/content",
          mimeType: "application/pdf",
          size: 1234,
        }],
      }),
    ])

    expect(messages[0]?.kind).toBe("user_prompt")
    if (messages[0]?.kind !== "user_prompt") throw new Error("unexpected message")
    expect(messages[0].attachments).toHaveLength(1)
    expect(messages[0].attachments?.[0]?.relativePath).toBe("./.kanna/uploads/spec.pdf")
  })

  test("preserves context window update entries", () => {
    const messages = processTranscriptMessages([
      entry({
        kind: "context_window_updated",
        usage: {
          usedTokens: 126,
          totalProcessedTokens: 11_839,
          maxTokens: 258_400,
          compactsAutomatically: true,
        },
      }),
    ])

    expect(messages[0]?.kind).toBe("context_window_updated")
    if (messages[0]?.kind !== "context_window_updated") throw new Error("unexpected message")
    expect(messages[0].usage.maxTokens).toBe(258_400)
    expect(messages[0].usage.compactsAutomatically).toBe(true)
  })

  test("preserves structured Claude ask-user-question results when a later echoed tool result arrives", () => {
    const messages = processTranscriptMessages([
      entry({
        kind: "tool_call",
        tool: {
          kind: "tool",
          toolKind: "ask_user_question",
          toolName: "AskUserQuestion",
          toolId: "tool-3",
          input: {
            questions: [{ question: "Provider?" }],
          },
        },
      }),
      entry({
        kind: "tool_result",
        toolId: "tool-3",
        content: { answers: { "Provider?": ["Codex"] } },
      }),
      entry({
        kind: "tool_result",
        toolId: "tool-3",
        content: "User has answered your questions: \"Provider?\"=\"Codex\".",
        debugRaw: JSON.stringify({
          type: "user",
          tool_use_result: {
            questions: [{ question: "Provider?" }],
            answers: { "Provider?": "Codex" },
          },
        }),
      }),
    ])

    expect(messages[0]?.kind).toBe("tool")
    if (messages[0]?.kind !== "tool") throw new Error("unexpected message")
    expect(messages[0].result).toEqual({ answers: { "Provider?": ["Codex"] } })
  })

  test("preserves Claude plan adjustment text when a later echoed tool result arrives", () => {
    const messages = processTranscriptMessages([
      entry({
        kind: "tool_call",
        tool: {
          kind: "tool",
          toolKind: "exit_plan_mode",
          toolName: "ExitPlanMode",
          toolId: "exit-plan-1",
          input: { plan: "## Plan" },
        },
      }),
      entry({
        kind: "tool_result",
        toolId: "exit-plan-1",
        content: { confirmed: false, message: "Keep the existing deployment order" },
      }),
      entry({
        kind: "tool_result",
        toolId: "exit-plan-1",
        content: "User wants to suggest edits to the plan: Keep the existing deployment order",
        isError: true,
        debugRaw: JSON.stringify({
          type: "user",
          tool_use_result: "Error: User wants to suggest edits to the plan: Keep the existing deployment order",
        }),
      }),
    ])

    expect(messages[0]?.kind).toBe("tool")
    if (messages[0]?.kind !== "tool") throw new Error("unexpected message")
    expect(messages[0].result).toEqual({
      confirmed: false,
      clearContext: undefined,
      message: "Keep the existing deployment order",
    })
  })

  test("recovers an empty Claude ExitPlanMode input from prior plan write and edit events", () => {
    const planPath = "/home/test/.claude/plans/current-plan.md"
    const messages = processTranscriptMessages([
      entry({
        kind: "tool_call",
        tool: {
          kind: "tool",
          toolKind: "write_file",
          toolName: "Write",
          toolId: "write-plan",
          input: { filePath: planPath, content: "## Plan\n\n- First step" },
        },
      }),
      entry({
        kind: "tool_result",
        toolId: "write-plan",
        content: "The file has been written successfully.",
      }),
      entry({
        kind: "tool_call",
        tool: {
          kind: "tool",
          toolKind: "edit_file",
          toolName: "Edit",
          toolId: "edit-plan",
          input: {
            filePath: planPath,
            oldString: "- First step",
            newString: "- Updated first step",
          },
        },
      }),
      entry({
        kind: "tool_result",
        toolId: "edit-plan",
        content: "The file has been updated successfully.",
      }),
      entry({
        kind: "tool_call",
        tool: {
          kind: "tool",
          toolKind: "exit_plan_mode",
          toolName: "ExitPlanMode",
          toolId: "exit-plan-empty",
          input: {},
        },
      }),
    ])

    const exitPlan = messages.find(
      (message) => message.kind === "tool" && message.toolId === "exit-plan-empty",
    )
    expect(exitPlan?.kind).toBe("tool")
    if (exitPlan?.kind !== "tool" || exitPlan.toolKind !== "exit_plan_mode") {
      throw new Error("unexpected message")
    }
    expect(exitPlan.input.plan).toBe("## Plan\n\n- Updated first step")
  })

  test("does not reuse an inline plan for a later unrelated empty ExitPlanMode call", () => {
    const messages = processTranscriptMessages([
      entry({
        kind: "tool_call",
        tool: {
          kind: "tool",
          toolKind: "exit_plan_mode",
          toolName: "ExitPlanMode",
          toolId: "exit-plan-inline",
          input: { plan: "## Earlier plan" },
        },
      }),
      entry({
        kind: "tool_call",
        tool: {
          kind: "tool",
          toolKind: "exit_plan_mode",
          toolName: "ExitPlanMode",
          toolId: "exit-plan-unrelated",
          input: {},
        },
      }),
    ])

    const unrelatedExitPlan = messages.find(
      (message) => message.kind === "tool" && message.toolId === "exit-plan-unrelated",
    )
    expect(unrelatedExitPlan?.kind).toBe("tool")
    if (unrelatedExitPlan?.kind !== "tool" || unrelatedExitPlan.toolKind !== "exit_plan_mode") {
      throw new Error("unexpected message")
    }
    expect(unrelatedExitPlan.input.plan).toBeUndefined()
  })

  test("does not mutate the source transcript input when recovering a plan", () => {
    const planPath = "/home/test/.claude/plans/source-plan.md"
    const sourceInput: Record<string, never> = {}
    const exitPlanEntry = entry({
      kind: "tool_call",
      tool: {
        kind: "tool",
        toolKind: "exit_plan_mode",
        toolName: "ExitPlanMode",
        toolId: "exit-plan-source",
        input: sourceInput,
      },
    })

    const messages = processTranscriptMessages([
      entry({
        kind: "tool_call",
        tool: {
          kind: "tool",
          toolKind: "write_file",
          toolName: "Write",
          toolId: "write-source-plan",
          input: { filePath: planPath, content: "## Source plan" },
        },
      }),
      entry({
        kind: "tool_result",
        toolId: "write-source-plan",
        content: "The file has been written successfully.",
      }),
      exitPlanEntry,
    ])

    const exitPlan = messages.find(
      (message) => message.kind === "tool" && message.toolId === "exit-plan-source",
    )
    expect(exitPlan?.kind).toBe("tool")
    if (exitPlan?.kind !== "tool" || exitPlan.toolKind !== "exit_plan_mode") {
      throw new Error("unexpected message")
    }
    expect(exitPlan.input.plan).toBe("## Source plan")
    expect(sourceInput).toEqual({})
  })
})

describe("getLatestToolIds", () => {
  test("returns the latest unresolved special tool ids", () => {
    const messages = processTranscriptMessages([
      entry({
        kind: "tool_call",
        tool: {
          kind: "tool",
          toolKind: "ask_user_question",
          toolName: "AskUserQuestion",
          toolId: "tool-1",
          input: {
            questions: [{ question: "Provider?" }],
          },
        },
      }),
      entry({
        kind: "tool_call",
        tool: {
          kind: "tool",
          toolKind: "todo_write",
          toolName: "TodoWrite",
          toolId: "tool-2",
          input: {
            todos: [{ content: "Implement adapter", status: "in_progress", activeForm: "Implementing adapter" }],
          },
        },
      }),
    ])

    expect(getLatestToolIds(messages)).toEqual({
      AskUserQuestion: messages[0]?.kind === "tool" ? messages[0].id : null,
      ExitPlanMode: null,
      TodoWrite: messages[1]?.kind === "tool" ? messages[1].id : null,
    })
  })

  test("ignores discarded special tools when choosing the latest active id", () => {
    const messages = processTranscriptMessages([
      entry({
        kind: "tool_call",
        tool: {
          kind: "tool",
          toolKind: "ask_user_question",
          toolName: "AskUserQuestion",
          toolId: "tool-1",
          input: {
            questions: [{ question: "Provider?" }],
          },
        },
      }),
      entry({
        kind: "tool_result",
        toolId: "tool-1",
        content: { discarded: true, answers: {} },
      }),
      entry({
        kind: "tool_call",
        tool: {
          kind: "tool",
          toolKind: "exit_plan_mode",
          toolName: "ExitPlanMode",
          toolId: "tool-2",
          input: {
            plan: "## Plan",
          },
        },
      }),
      entry({
        kind: "tool_result",
        toolId: "tool-2",
        content: { discarded: true },
      }),
    ])

    expect(getLatestToolIds(messages)).toEqual({
      AskUserQuestion: null,
      ExitPlanMode: null,
      TodoWrite: null,
    })
  })
})
