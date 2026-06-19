import { describe, expect, test } from "bun:test"
import { searchTranscriptEntries } from "./chatSearch"
import type { TranscriptEntry } from "./types"

const DEFAULT_SEARCH_OPTIONS = { chatId: "chat-1" }

function entry(overrides: Partial<TranscriptEntry> & Pick<TranscriptEntry, "kind">): TranscriptEntry {
  return {
    _id: `${overrides.kind}-1`,
    createdAt: 1,
    ...overrides,
  } as TranscriptEntry
}

describe("searchTranscriptEntries", () => {
  test("finds user and assistant text across current chat transcript entries without rendered rows", () => {
    const results = searchTranscriptEntries([
      entry({ _id: "user-1", kind: "user_prompt", content: "Please inspect the sidebar layout" }),
      entry({ _id: "assistant-1", kind: "assistant_text", text: "The search term is tucked inside this answer." }),
      entry({ _id: "result-1", kind: "result", subtype: "success", isError: false, durationMs: 10, result: "Done" }),
    ], "SEARCH term", { chatId: "chat-1" })

    expect(results).toEqual([{
      chatId: "chat-1",
      entryId: "assistant-1",
      targetEntryId: "assistant-1",
      messageId: undefined,
      kind: "assistant_text",
      createdAt: 1,
      matchCount: 1,
      preview: "The search term is tucked inside this answer.",
    }])
  })

  test("does not search tool calls and results by default", () => {
    const results = searchTranscriptEntries([
      entry({
        _id: "user-1",
        kind: "user_prompt",
        content: "needle in user text",
      }),
      entry({
        _id: "assistant-1",
        kind: "assistant_text",
        text: "needle in assistant text",
      }),
      entry({
        _id: "tool-1",
        kind: "tool_call",
        tool: {
          kind: "tool",
          toolKind: "bash",
          toolName: "Bash",
          toolId: "tool-1",
          input: { command: "rg needle src" },
        },
      }),
      entry({
        _id: "tool-result-1",
        kind: "tool_result",
        toolId: "tool-1",
        content: "needle in tool output",
      }),
    ], "needle", DEFAULT_SEARCH_OPTIONS)

    expect(results.map((result) => result.entryId)).toEqual(["user-1", "assistant-1"])
  })

  test("searches compact summaries by default", () => {
    const results = searchTranscriptEntries([
      entry({
        _id: "summary-1",
        kind: "compact_summary",
        summary: "Resolved authentication bug by patching JWT middleware",
      }),
      entry({
        _id: "tool-1",
        kind: "tool_call",
        tool: {
          kind: "tool",
          toolKind: "bash",
          toolName: "Bash",
          toolId: "tool-1",
          input: { command: "echo JWT" },
        },
      }),
    ], "JWT", DEFAULT_SEARCH_OPTIONS)

    expect(results.map((result) => ({
      entryId: result.entryId,
      kind: result.kind,
      preview: result.preview,
    }))).toEqual([{
      entryId: "summary-1",
      kind: "compact_summary",
      preview: "Resolved authentication bug by patching JWT middleware",
    }])
  })

  test("searches visible tool input and output text when tool entries are included", () => {
    const results = searchTranscriptEntries([
      entry({
        _id: "hidden-1",
        kind: "assistant_text",
        text: "needle in hidden text",
        hidden: true,
      }),
      entry({
        _id: "tool-1",
        kind: "tool_call",
        tool: {
          kind: "tool",
          toolKind: "bash",
          toolName: "Bash",
          toolId: "tool-1",
          input: { command: "rg needle src" },
        },
      }),
      entry({
        _id: "tool-result-1",
        kind: "tool_result",
        toolId: "tool-1",
        content: "needle appears twice: needle",
      }),
    ], "needle", { ...DEFAULT_SEARCH_OPTIONS, includeToolEntries: true })

    expect(results.map((result) => ({
      entryId: result.entryId,
      targetEntryId: result.targetEntryId,
      kind: result.kind,
      matchCount: result.matchCount,
    }))).toEqual([
      { entryId: "tool-1", targetEntryId: "tool-1", kind: "tool_call", matchCount: 2 },
      { entryId: "tool-result-1", targetEntryId: "tool-1", kind: "tool_result", matchCount: 2 },
    ])
  })

  test("does not search hidden system prompt content in user messages", () => {
    const results = searchTranscriptEntries([
      entry({
        _id: "user-1",
        kind: "user_prompt",
        content: "<system-message>hidden-service-needle</system-message>Visible user text",
      }),
    ], "hidden-service-needle", DEFAULT_SEARCH_OPTIONS)

    expect(results).toEqual([])
  })

  test("searches only visible tool call fields", () => {
    const readTool = entry({
      _id: "read-1",
      kind: "tool_call",
      tool: {
        kind: "tool",
        toolKind: "read_file",
        toolName: "Read",
        toolId: "read-1",
        input: { filePath: "/workspace/private-prefix/src/visible-file.ts" },
      },
    })

    const mcpTool = entry({
      _id: "mcp-1",
      kind: "tool_call",
      tool: {
        kind: "tool",
        toolKind: "mcp_generic",
        toolName: "mcp__hidden_server__hidden_tool",
        toolId: "mcp-1",
        input: {
          server: "visible-server",
          tool: "visible-tool",
          payload: { secret: "hidden-payload-needle" },
        },
      },
    })

    expect(searchTranscriptEntries([readTool, mcpTool], "hidden", { ...DEFAULT_SEARCH_OPTIONS, localPath: "/workspace/private-prefix", includeToolEntries: true })).toEqual([])
    expect(searchTranscriptEntries([readTool], "visible-file.ts", { ...DEFAULT_SEARCH_OPTIONS, localPath: "/workspace/private-prefix", includeToolEntries: true }).map((result) => result.entryId)).toEqual(["read-1"])
  })

  test("searches only entries rendered in the transcript", () => {
    const results = searchTranscriptEntries([
      entry({
        _id: "system-1",
        kind: "system_init",
        provider: "claude",
        model: "visible-model",
        tools: ["visible-system-needle"],
        agents: [],
        slashCommands: [],
        mcpServers: [],
      }),
      entry({
        _id: "system-2",
        kind: "system_init",
        provider: "claude",
        model: "hidden-model",
        tools: ["hidden-system-needle"],
        agents: [],
        slashCommands: [],
        mcpServers: [],
      }),
      entry({ _id: "context-1", kind: "context_window_updated", usage: { usedTokens: 1, compactsAutomatically: false } }),
      entry({ _id: "short-result-1", kind: "result", subtype: "success", isError: false, durationMs: 10, result: "short-result-needle" }),
      entry({ _id: "long-result-1", kind: "result", subtype: "success", isError: false, durationMs: 61000, result: "long-result-needle" }),
      entry({ _id: "error-result-1", kind: "result", subtype: "error", isError: true, durationMs: 10, result: "error-result-needle" }),
      entry({ _id: "status-1", kind: "status", status: "hidden-status-needle" }),
      entry({ _id: "assistant-1", kind: "assistant_text", text: "final visible text" }),
    ], "needle", { ...DEFAULT_SEARCH_OPTIONS, includeToolEntries: true })

    expect(results.map((result) => result.entryId)).toEqual([
      "system-1",
      "long-result-1",
      "error-result-1",
    ])
  })

  test("does not search tool output when the owning tool call is not rendered", () => {
    const results = searchTranscriptEntries([
      entry({
        _id: "hidden-tool-1",
        kind: "tool_call",
        hidden: true,
        tool: {
          kind: "tool",
          toolKind: "bash",
          toolName: "Bash",
          toolId: "hidden-tool-1",
          input: { command: "echo hidden" },
        },
      }),
      entry({
        _id: "hidden-tool-result-1",
        kind: "tool_result",
        toolId: "hidden-tool-1",
        content: "hidden-tool-result-needle",
      }),
      entry({
        _id: "old-todos-1",
        kind: "tool_call",
        tool: {
          kind: "tool",
          toolKind: "todo_write",
          toolName: "TodoWrite",
          toolId: "old-todos-1",
          input: { todos: [{ content: "old todo needle", status: "pending", activeForm: "old todo" }] },
        },
      }),
      entry({
        _id: "latest-todos-1",
        kind: "tool_call",
        tool: {
          kind: "tool",
          toolKind: "todo_write",
          toolName: "TodoWrite",
          toolId: "latest-todos-1",
          input: { todos: [{ content: "latest todo needle", status: "pending", activeForm: "latest todo" }] },
        },
      }),
    ], "needle", { ...DEFAULT_SEARCH_OPTIONS, includeToolEntries: true })

    expect(results.map((result) => result.entryId)).toEqual(["latest-todos-1"])
  })

  test("returns no results for blank queries", () => {
    expect(searchTranscriptEntries([
      entry({ _id: "user-1", kind: "user_prompt", content: "anything" }),
    ], "   ", DEFAULT_SEARCH_OPTIONS)).toEqual([])
  })
})
