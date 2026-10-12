import { describe, expect, test } from "bun:test"
import {
  getTrimmedToolEntryIds,
  mergeTranscriptSearchPayloads,
  searchTranscriptEntries,
} from "./chatSearch"
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
  test("finds visible user, assistant, and compact-summary text", () => {
    const results = searchTranscriptEntries([
      entry({ _id: "user-1", kind: "user_prompt", content: "Please inspect the sidebar" }),
      entry({ _id: "assistant-1", kind: "assistant_text", text: "The search needle is in this answer." }),
      entry({ _id: "summary-1", kind: "compact_summary", summary: "Earlier needle in the summary" }),
      entry({ _id: "result-1", kind: "result", subtype: "success", isError: false, durationMs: 10, result: "needle hidden in a short result" }),
    ], "NEEDLE", DEFAULT_SEARCH_OPTIONS)

    expect(results.map((result) => result.entryId)).toEqual(["assistant-1", "summary-1"])
    expect(results[0]?.preview).toBe("The search needle is in this answer.")
  })

  test("does not search tool calls and results unless requested", () => {
    const entries = [
      entry({
        _id: "tool-1",
        kind: "tool_call",
        tool: {
          kind: "tool",
          toolKind: "bash",
          toolName: "Bash",
          toolId: "call-1",
          input: { command: "rg needle src" },
        },
      }),
      entry({ _id: "tool-result-1", kind: "tool_result", toolId: "call-1", content: "needle twice: needle" }),
    ]

    expect(searchTranscriptEntries(entries, "needle", DEFAULT_SEARCH_OPTIONS)).toEqual([])
    expect(searchTranscriptEntries(entries, "needle", {
      ...DEFAULT_SEARCH_OPTIONS,
      includeToolEntries: true,
    }).map((result) => ({
      entryId: result.entryId,
      revealEntryId: result.revealEntryId,
      targetEntryId: result.targetEntryId,
      matchCount: result.matchCount,
    }))).toEqual([
      { entryId: "tool-1", revealEntryId: "tool-1", targetEntryId: "tool-1", matchCount: 2 },
      { entryId: "tool-result-1", revealEntryId: "tool-1", targetEntryId: "tool-1", matchCount: 2 },
    ])
  })

  test("excludes hidden text and the service prefix of a steered prompt", () => {
    const results = searchTranscriptEntries([
      entry({ _id: "hidden-1", kind: "assistant_text", text: "secret needle", hidden: true }),
      entry({
        _id: "user-1",
        kind: "user_prompt",
        content: "<system-message>service needle</system-message>Visible user text",
      }),
    ], "needle", DEFAULT_SEARCH_OPTIONS)

    expect(results).toEqual([])
  })

  test("searches only transcript rows that are actually visible", () => {
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
        model: "visible-model",
        tools: ["hidden-system-needle"],
        agents: [],
        slashCommands: [],
        mcpServers: [],
      }),
      entry({ _id: "context-1", kind: "context_window_updated", usage: { usedTokens: 1, compactsAutomatically: false } }),
      entry({ _id: "short-result-1", kind: "result", subtype: "success", isError: false, durationMs: 10, result: "short-result-needle" }),
      entry({ _id: "long-result-1", kind: "result", subtype: "success", isError: false, durationMs: 61_000, result: "long-result-needle" }),
      entry({ _id: "error-result-1", kind: "result", subtype: "error", isError: true, durationMs: 10, result: "error-result-needle" }),
      entry({ _id: "status-1", kind: "status", status: "hidden-status-needle" }),
      entry({ _id: "assistant-1", kind: "assistant_text", text: "final visible text" }),
    ], "needle", { ...DEFAULT_SEARCH_OPTIONS, includeToolEntries: true })

    expect(results.map((result) => result.entryId)).toEqual([
      "system-1",
      "error-result-1",
    ])
  })

  test("targets the parent Agent call for entries folded under a subagent", () => {
    const results = searchTranscriptEntries([
      entry({
        _id: "agent-call",
        kind: "tool_call",
        tool: {
          kind: "tool",
          toolKind: "subagent_task",
          toolName: "Agent",
          toolId: "agent-tool-id",
          input: { prompt: "Investigate", subagentType: "Explore" },
        },
      }),
      entry({
        _id: "child-text",
        kind: "assistant_text",
        text: "The nested needle is here",
        parentToolUseId: "agent-tool-id",
      }),
    ], "needle", DEFAULT_SEARCH_OPTIONS)

    expect(results).toEqual([expect.objectContaining({
      entryId: "child-text",
      revealEntryId: "child-text",
      targetEntryId: "agent-call",
    })])
  })

  test("keeps the exact nested call while targeting its outer Agent row", () => {
    const results = searchTranscriptEntries([
      entry({
        _id: "agent-call",
        kind: "tool_call",
        tool: {
          kind: "tool",
          toolKind: "subagent_task",
          toolName: "Agent",
          toolId: "agent-tool-id",
          input: { prompt: "Investigate", subagentType: "Explore" },
        },
      }),
      entry({
        _id: "child-tool",
        kind: "tool_call",
        parentToolUseId: "agent-tool-id",
        tool: {
          kind: "tool",
          toolKind: "bash",
          toolName: "Bash",
          toolId: "child-tool-id",
          input: { command: "printf unrelated" },
        },
      }),
      entry({
        _id: "child-result",
        kind: "tool_result",
        toolId: "child-tool-id",
        content: "nested needle",
      }),
    ], "needle", { ...DEFAULT_SEARCH_OPTIONS, includeToolEntries: true })

    expect(results).toEqual([expect.objectContaining({
      entryId: "child-result",
      revealEntryId: "child-tool",
      targetEntryId: "agent-call",
    })])
  })

  test("excludes entries folded under a hidden Agent call", () => {
    const results = searchTranscriptEntries([
      entry({
        _id: "hidden-agent",
        kind: "tool_call",
        hidden: true,
        tool: {
          kind: "tool",
          toolKind: "subagent_task",
          toolName: "Agent",
          toolId: "hidden-agent-tool-id",
          input: { prompt: "Investigate", subagentType: "Explore" },
        },
      }),
      entry({
        _id: "hidden-child-text",
        kind: "assistant_text",
        text: "nested needle",
        parentToolUseId: "hidden-agent-tool-id",
      }),
    ], "needle", DEFAULT_SEARCH_OPTIONS)

    expect(results).toEqual([])
  })

  test("keeps an out-of-order child inline when its Agent owner appears later", () => {
    const results = searchTranscriptEntries([
      entry({
        _id: "early-child-text",
        kind: "assistant_text",
        text: "out-of-order needle",
        parentToolUseId: "later-agent-tool-id",
      }),
      entry({
        _id: "later-hidden-agent",
        kind: "tool_call",
        hidden: true,
        tool: {
          kind: "tool",
          toolKind: "subagent_task",
          toolName: "Agent",
          toolId: "later-agent-tool-id",
          input: { prompt: "Investigate", subagentType: "Explore" },
        },
      }),
    ], "needle", DEFAULT_SEARCH_OPTIONS)

    expect(results).toEqual([expect.objectContaining({
      entryId: "early-child-text",
      revealEntryId: "early-child-text",
      targetEntryId: "early-child-text",
    })])
  })

  test("does not search an older TodoWrite or a result owned by a hidden call", () => {
    const results = searchTranscriptEntries([
      entry({
        _id: "hidden-tool",
        kind: "tool_call",
        hidden: true,
        tool: { kind: "tool", toolKind: "bash", toolName: "Bash", toolId: "hidden-call", input: { command: "echo hidden" } },
      }),
      entry({ _id: "hidden-result", kind: "tool_result", toolId: "hidden-call", content: "hidden needle" }),
      entry({
        _id: "old-todos",
        kind: "tool_call",
        tool: {
          kind: "tool",
          toolKind: "todo_write",
          toolName: "TodoWrite",
          toolId: "old-todos",
          input: { todos: [{ content: "old needle", status: "pending", activeForm: "old" }] },
        },
      }),
      entry({
        _id: "latest-todos",
        kind: "tool_call",
        tool: {
          kind: "tool",
          toolKind: "todo_write",
          toolName: "TodoWrite",
          toolId: "latest-todos",
          input: { todos: [{ content: "latest needle", status: "pending", activeForm: "latest" }] },
        },
      }),
    ], "needle", { ...DEFAULT_SEARCH_OPTIONS, includeToolEntries: true })

    expect(results.map((result) => result.entryId)).toEqual(["latest-todos"])
  })

  test("returns no results for a blank query", () => {
    expect(searchTranscriptEntries([
      entry({ kind: "user_prompt", content: "anything" }),
    ], "   ", DEFAULT_SEARCH_OPTIONS)).toEqual([])
  })

  test("skips and limits matching entries for paged project search", () => {
    const entries = [
      entry({ _id: "match-1", kind: "assistant_text", text: "needle one" }),
      entry({ _id: "match-2", kind: "assistant_text", text: "needle two" }),
      entry({ _id: "match-3", kind: "assistant_text", text: "needle three" }),
      entry({ _id: "match-4", kind: "assistant_text", text: "needle four" }),
    ]

    expect(searchTranscriptEntries(entries, "needle", {
      ...DEFAULT_SEARCH_OPTIONS,
      skipMatches: 1,
      limit: 2,
    }).map((result) => result.entryId)).toEqual(["match-2", "match-3"])
  })
})

describe("tool payload preparation", () => {
  test("requests only trimmed tool entries", () => {
    const entries = [
      entry({ _id: "prompt", kind: "user_prompt", content: "hello" }),
      entry({
        _id: "trimmed-call",
        kind: "tool_call",
        trimmed: true,
        tool: { kind: "tool", toolKind: "bash", toolName: "Bash", toolId: "call", input: { command: "" } },
      }),
      entry({ _id: "trimmed-result", kind: "tool_result", toolId: "call", content: "", trimmed: true }),
      entry({ _id: "full-result", kind: "tool_result", toolId: "other", content: "already here" }),
    ]

    expect(getTrimmedToolEntryIds(entries)).toEqual(["trimmed-call", "trimmed-result"])
  })

  test("merges fetched payloads without changing transcript order", () => {
    const header = entry({ _id: "result", kind: "tool_result", toolId: "call", content: "", trimmed: true })
    const full = entry({ _id: "result", kind: "tool_result", toolId: "call", content: "full needle" })
    const prompt = entry({ _id: "prompt", kind: "user_prompt", content: "hello" })

    const merged = mergeTranscriptSearchPayloads([prompt, header], [full])

    expect(merged.map((candidate) => candidate._id)).toEqual(["prompt", "result"])
    expect(merged[1]).toBe(full)
    expect(merged[0]).toBe(prompt)
  })
})
