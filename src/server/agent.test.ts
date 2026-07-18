import { describe, expect, test } from "bun:test"
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import {
  AgentCoordinator,
  buildAttachmentHintText,
  buildClaudeSdkUserMessage,
  buildPromptText,
  maxClaudeContextWindowFromModelUsage,
  normalizeClaudeContextUsage,
  normalizeClaudeStreamMessage,
  normalizeClaudeUsageSnapshot,
  resolveClaudeCodeExecutable,
} from "./agent"
import type { HarnessTurn } from "./harness-types"
import type { ChatAttachment, TranscriptEntry } from "../shared/types"
import { timestamped } from "./transcript"

async function waitFor(condition: () => boolean, timeoutMs = 2000) {
  const start = Date.now()
  while (!condition()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("Timed out waiting for condition")
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

class AsyncEventQueue<T> implements AsyncIterable<T> {
  private readonly values: T[] = []
  private readonly waiters: Array<(result: IteratorResult<T>) => void> = []
  private closed = false

  push(value: T) {
    const waiter = this.waiters.shift()
    if (waiter) {
      waiter({ done: false, value })
      return
    }
    this.values.push(value)
  }

  close() {
    this.closed = true
    while (this.waiters.length > 0) {
      this.waiters.shift()?.({ done: true, value: undefined as never })
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: async () => {
        if (this.values.length > 0) {
          return { done: false, value: this.values.shift() as T }
        }
        if (this.closed) {
          return { done: true, value: undefined as never }
        }
        return await new Promise<IteratorResult<T>>((resolve) => {
          this.waiters.push(resolve)
        })
      },
    }
  }
}

describe("normalizeClaudeStreamMessage", () => {
  test("builds streaming Claude prompts without pinning them to the resumed session id", () => {
    expect(buildClaudeSdkUserMessage("edited task")).toEqual({
      type: "user",
      message: {
        role: "user",
        content: "edited task",
      },
      parent_tool_use_id: null,
      session_id: "",
    })
  })

  test("normalizes assistant tool calls", () => {
    const entries = normalizeClaudeStreamMessage({
      type: "assistant",
      uuid: "msg-1",
      message: {
        content: [
          {
            type: "tool_use",
            id: "tool-1",
            name: "Bash",
            input: {
              command: "pwd",
              timeout: 1000,
            },
          },
        ],
      },
    })

    expect(entries).toHaveLength(1)
    expect(entries[0]?.kind).toBe("tool_call")
    if (entries[0]?.kind !== "tool_call") throw new Error("unexpected entry")
    expect(entries[0].tool.toolKind).toBe("bash")
  })

  test("normalizes result messages", () => {
    const entries = normalizeClaudeStreamMessage({
      type: "result",
      subtype: "success",
      is_error: false,
      duration_ms: 3210,
      result: "done",
    })

    expect(entries).toHaveLength(1)
    expect(entries[0]?.kind).toBe("result")
    if (entries[0]?.kind !== "result") throw new Error("unexpected entry")
    expect(entries[0].durationMs).toBe(3210)
  })

  test("normalizes Claude usage snapshots from SDK usage payloads", () => {
    const snapshot = normalizeClaudeUsageSnapshot({
      input_tokens: 4,
      cache_creation_input_tokens: 2715,
      cache_read_input_tokens: 21144,
      output_tokens: 679,
      tool_uses: 2,
      duration_ms: 654,
    }, 200_000)

    expect(snapshot).toEqual({
      usedTokens: 24_542,
      inputTokens: 23_863,
      cachedInputTokens: 21_144,
      outputTokens: 679,
      lastUsedTokens: 24_542,
      lastInputTokens: 23_863,
      lastCachedInputTokens: 21_144,
      lastOutputTokens: 679,
      toolUses: 2,
      durationMs: 654,
      maxTokens: 200_000,
      compactsAutomatically: false,
    })
  })

  test("normalizes Claude getContextUsage responses", () => {
    expect(normalizeClaudeContextUsage({
      totalTokens: 87_312,
      maxTokens: 200_000,
      rawMaxTokens: 200_000,
      percentage: 43.7,
      categories: [],
    })).toEqual({
      usedTokens: 87_312,
      maxTokens: 200_000,
    })

    expect(normalizeClaudeContextUsage({ totalTokens: 12_345 })).toEqual({ usedTokens: 12_345 })
    expect(normalizeClaudeContextUsage({ totalTokens: 0, maxTokens: 200_000 })).toBeNull()
    expect(normalizeClaudeContextUsage(null)).toBeNull()
    expect(normalizeClaudeContextUsage("nope")).toBeNull()
  })

  test("reads the max Claude context window from modelUsage", () => {
    expect(maxClaudeContextWindowFromModelUsage({
      "claude-opus-4-6": {
        contextWindow: 200_000,
      },
      "claude-opus-4-6[1m]": {
        contextWindow: 1_000_000,
      },
    })).toBe(1_000_000)
  })
})

describe("resolveClaudeCodeExecutable", () => {
  test("prefers CLAUDE_EXECUTABLE when configured", () => {
    expect(resolveClaudeCodeExecutable({
      CLAUDE_EXECUTABLE: "~/bin/claude",
      PATH: "",
    })).toBe(join(homedir(), "bin/claude"))
  })

  test("falls back to claude from PATH", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "kanna-claude-"))
    try {
      const executable = join(tempDir, "claude")
      writeFileSync(executable, "#!/bin/sh\n")
      chmodSync(executable, 0o755)

      expect(resolveClaudeCodeExecutable({ PATH: tempDir })).toBe(executable)
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })
})

describe("attachment prompt helpers", () => {
  test("appends a structured attachment hint block for all attachment kinds", () => {
    const attachments: ChatAttachment[] = [
      {
        id: "image-1",
        kind: "image",
        displayName: "shot.png",
        absolutePath: "/tmp/project/.kanna/uploads/shot.png",
        relativePath: "./.kanna/uploads/shot.png",
        contentUrl: "/api/projects/project-1/uploads/shot.png/content",
        mimeType: "image/png",
        size: 512,
      },
      {
        id: "file-1",
        kind: "file",
        displayName: "spec.pdf",
        absolutePath: "/tmp/project/.kanna/uploads/spec.pdf",
        relativePath: "./.kanna/uploads/spec.pdf",
        contentUrl: "/api/projects/project-1/uploads/spec.pdf/content",
        mimeType: "application/pdf",
        size: 1234,
      },
    ]

    const prompt = buildPromptText("Review these", attachments)
    expect(prompt).toContain("<kanna-attachments>")
    expect(prompt).toContain('path="/tmp/project/.kanna/uploads/shot.png"')
    expect(prompt).toContain('project_path="./.kanna/uploads/spec.pdf"')
  })

  test("supports attachment-only prompts", () => {
    const attachments: ChatAttachment[] = [{
      id: "file-1",
      kind: "file",
      displayName: "todo.txt",
      absolutePath: "/tmp/project/.kanna/uploads/todo.txt",
      relativePath: "./.kanna/uploads/todo.txt",
      contentUrl: "/api/projects/project-1/uploads/todo.txt/content",
      mimeType: "text/plain",
      size: 32,
    }]

    expect(buildPromptText("", attachments)).toContain("Please inspect the attached files.")
  })

  test("escapes xml attribute values for attachment hint markup", () => {
    const hint = buildAttachmentHintText([{
      id: "file-1",
      kind: "file",
      displayName: "\"report\" <draft>.txt",
      absolutePath: "/tmp/project/.kanna/uploads/report.txt",
      relativePath: "./.kanna/uploads/report.txt",
      contentUrl: "/api/projects/project-1/uploads/report.txt/content",
      mimeType: "text/plain",
      size: 64,
    }])

    expect(hint).toContain("&quot;report&quot; &lt;draft&gt;.txt")
  })
})

describe("AgentCoordinator codex integration", () => {
  test("edits a Codex user prompt by rolling back affected turns and replaying the edited prompt", async () => {
    const rollbackCalls: Array<{ chatId?: string; cwd: string; threadId: string; numTurns: number }> = []
    const startedTurns: string[] = []
    let stopSessionCalls = 0
    const fakeCodexManager = {
      async rollbackThread(args: { chatId?: string; cwd: string; threadId: string; numTurns: number }) {
        rollbackCalls.push(args)
      },
      stopSession() {
        stopSessionCalls += 1
      },
      async startSession() {},
      async startTurn(args: { content: string }): Promise<HarnessTurn> {
        startedTurns.push(args.content)
        async function* stream() {
          yield {
            type: "transcript" as const,
            entry: timestamped({
              kind: "result",
              subtype: "success",
              isError: false,
              durationMs: 0,
              result: "done",
            }),
          }
        }

        return {
          provider: "codex",
          stream: stream(),
          interrupt: async () => {},
          close: () => {},
        }
      },
    }
    const store = createFakeStore()
    store.chat.provider = "codex"
    store.chat.sessionToken = "thread-1"
    const firstPrompt = timestamped({ kind: "user_prompt", content: "original task" })
    store.messages = [
      firstPrompt,
      timestamped({ kind: "assistant_text", text: "first answer" }),
      timestamped({ kind: "result", subtype: "success", isError: false, durationMs: 0, result: "done" }),
      timestamped({ kind: "user_prompt", content: "follow-up" }),
      timestamped({ kind: "assistant_text", text: "second answer" }),
      timestamped({ kind: "result", subtype: "success", isError: false, durationMs: 0, result: "done" }),
    ]

    const coordinator = new AgentCoordinator({
      store: store as never,
      codexManager: fakeCodexManager as never,
      onStateChange: () => {},
    })

    await coordinator.editUserPrompt({
      type: "chat.editUserPrompt",
      chatId: "chat-1",
      messageId: firstPrompt._id,
      content: "edited task",
    })

    await waitFor(() => store.turnFinishedCount === 1)

    expect(rollbackCalls).toEqual([{
      chatId: "chat-1",
      cwd: "/tmp/project",
      threadId: "thread-1",
      numTurns: 2,
    }])
    expect(stopSessionCalls).toBe(0)
    expect(startedTurns).toEqual(["edited task"])
    expect(store.messages.map((entry) => entry.kind)).toEqual(["user_prompt", "result"])
    expect(store.messages[0]).toMatchObject({ kind: "user_prompt", content: "edited task" })
  })

  test("edits the second Codex user prompt out of two while preserving the first turn", async () => {
    const rollbackCalls: Array<{ chatId?: string; cwd: string; threadId: string; numTurns: number }> = []
    const startedTurns: string[] = []
    const fakeCodexManager = {
      async rollbackThread(args: { chatId?: string; cwd: string; threadId: string; numTurns: number }) {
        rollbackCalls.push(args)
      },
      stopSession() {
        throw new Error("stopSession should not be called before live rollback")
      },
      async startSession() {},
      async startTurn(args: { content: string }): Promise<HarnessTurn> {
        startedTurns.push(args.content)
        async function* stream() {
          yield {
            type: "transcript" as const,
            entry: timestamped({
              kind: "result",
              subtype: "success",
              isError: false,
              durationMs: 0,
              result: "done",
            }),
          }
        }

        return {
          provider: "codex",
          stream: stream(),
          interrupt: async () => {},
          close: () => {},
        }
      },
    }
    const store = createFakeStore()
    store.chat.provider = "codex"
    store.chat.sessionToken = "thread-1"
    const firstPrompt = timestamped({ kind: "user_prompt", content: "first task" })
    const firstAnswer = timestamped({ kind: "assistant_text", text: "first answer" })
    const secondPrompt = timestamped({ kind: "user_prompt", content: "second task" })
    store.messages = [
      firstPrompt,
      firstAnswer,
      timestamped({ kind: "result", subtype: "success", isError: false, durationMs: 0, result: "done" }),
      secondPrompt,
      timestamped({ kind: "assistant_text", text: "second answer" }),
      timestamped({ kind: "result", subtype: "success", isError: false, durationMs: 0, result: "done" }),
    ]

    const coordinator = new AgentCoordinator({
      store: store as never,
      codexManager: fakeCodexManager as never,
      onStateChange: () => {},
    })

    await coordinator.editUserPrompt({
      type: "chat.editUserPrompt",
      chatId: "chat-1",
      messageId: secondPrompt._id,
      content: "edited second task",
    })

    await waitFor(() => store.turnFinishedCount === 1)

    expect(rollbackCalls).toEqual([{
      chatId: "chat-1",
      cwd: "/tmp/project",
      threadId: "thread-1",
      numTurns: 1,
    }])
    expect(startedTurns).toEqual(["edited second task"])
    expect(store.messages[0]).toBe(firstPrompt)
    expect(store.messages[1]).toBe(firstAnswer)
    expect(store.messages.map((entry) => entry.kind)).toEqual(["user_prompt", "assistant_text", "result", "user_prompt", "result"])
    expect(store.messages[3]).toMatchObject({ kind: "user_prompt", content: "edited second task" })
    expect(store.messages.some((entry) => entry.kind === "user_prompt" && entry.content === "second task")).toBe(false)
  })

  test("edits the second Codex user prompt out of three and discards the later turns", async () => {
    const rollbackCalls: Array<{ chatId?: string; cwd: string; threadId: string; numTurns: number }> = []
    const startedTurns: string[] = []
    const fakeCodexManager = {
      async rollbackThread(args: { chatId?: string; cwd: string; threadId: string; numTurns: number }) {
        rollbackCalls.push(args)
      },
      stopSession() {
        throw new Error("stopSession should not be called before live rollback")
      },
      async startSession() {},
      async startTurn(args: { content: string }): Promise<HarnessTurn> {
        startedTurns.push(args.content)
        async function* stream() {
          yield {
            type: "transcript" as const,
            entry: timestamped({
              kind: "result",
              subtype: "success",
              isError: false,
              durationMs: 0,
              result: "done",
            }),
          }
        }

        return {
          provider: "codex",
          stream: stream(),
          interrupt: async () => {},
          close: () => {},
        }
      },
    }
    const store = createFakeStore()
    store.chat.provider = "codex"
    store.chat.sessionToken = "thread-1"
    const firstPrompt = timestamped({ kind: "user_prompt", content: "first task" })
    const secondPrompt = timestamped({ kind: "user_prompt", content: "second task" })
    const thirdPrompt = timestamped({ kind: "user_prompt", content: "third task" })
    store.messages = [
      firstPrompt,
      timestamped({ kind: "assistant_text", text: "first answer" }),
      timestamped({ kind: "result", subtype: "success", isError: false, durationMs: 0, result: "done" }),
      secondPrompt,
      timestamped({ kind: "assistant_text", text: "second answer" }),
      timestamped({ kind: "result", subtype: "success", isError: false, durationMs: 0, result: "done" }),
      thirdPrompt,
      timestamped({ kind: "assistant_text", text: "third answer" }),
      timestamped({ kind: "result", subtype: "success", isError: false, durationMs: 0, result: "done" }),
    ]

    const coordinator = new AgentCoordinator({
      store: store as never,
      codexManager: fakeCodexManager as never,
      onStateChange: () => {},
    })

    await coordinator.editUserPrompt({
      type: "chat.editUserPrompt",
      chatId: "chat-1",
      messageId: secondPrompt._id,
      content: "edited second task",
    })

    await waitFor(() => store.turnFinishedCount === 1)

    expect(rollbackCalls).toEqual([{
      chatId: "chat-1",
      cwd: "/tmp/project",
      threadId: "thread-1",
      numTurns: 2,
    }])
    expect(startedTurns).toEqual(["edited second task"])
    expect(store.messages.map((entry) => entry.kind)).toEqual(["user_prompt", "assistant_text", "result", "user_prompt", "result"])
    expect(store.messages[0]).toBe(firstPrompt)
    expect(store.messages[3]).toMatchObject({ kind: "user_prompt", content: "edited second task" })
    expect(store.messages.some((entry) => entry.kind === "user_prompt" && entry.content === "third task")).toBe(false)
  })

  test("forks a Codex chat from the selected user prompt into a new visible chat", async () => {
    const startSessionCalls: Array<{
      chatId: string
      cwd: string
      model: string
      serviceTier?: "fast"
      sessionToken: string | null
      pendingForkSessionToken?: string | null
    }> = []
    const rollbackCalls: Array<{ chatId?: string; cwd: string; threadId: string; numTurns: number }> = []
    const startedTurns: string[] = []
    const fakeCodexManager = {
      async startSession(args: {
        chatId: string
        cwd: string
        model: string
        serviceTier?: "fast"
        sessionToken: string | null
        pendingForkSessionToken?: string | null
      }) {
        startSessionCalls.push(args)
        return args.pendingForkSessionToken ? "thread-fork-1" : undefined
      },
      async rollbackThread(args: { chatId?: string; cwd: string; threadId: string; numTurns: number }) {
        rollbackCalls.push(args)
      },
      async startTurn(args: { content: string }): Promise<HarnessTurn> {
        startedTurns.push(args.content)
        async function* stream() {
          yield {
            type: "transcript" as const,
            entry: timestamped({
              kind: "result",
              subtype: "success",
              isError: false,
              durationMs: 0,
              result: "done",
            }),
          }
        }

        return {
          provider: "codex",
          stream: stream(),
          interrupt: async () => {},
          close: () => {},
        }
      },
    }
    const store = createForkableFakeStore("codex", {
      title: "Debug Session",
      sessionToken: "thread-1",
    })
    const firstPrompt = timestamped({ kind: "user_prompt", content: "first task" })
    const secondPrompt = timestamped({ kind: "user_prompt", content: "second task" })
    const thirdPrompt = timestamped({ kind: "user_prompt", content: "third task" })
    store.setMessages("chat-1", [
      firstPrompt,
      timestamped({ kind: "assistant_text", text: "first answer" }),
      timestamped({ kind: "result", subtype: "success", isError: false, durationMs: 0, result: "done" }),
      secondPrompt,
      timestamped({ kind: "assistant_text", text: "second answer" }),
      timestamped({ kind: "result", subtype: "success", isError: false, durationMs: 0, result: "done" }),
      thirdPrompt,
      timestamped({ kind: "assistant_text", text: "third answer" }),
      timestamped({ kind: "result", subtype: "success", isError: false, durationMs: 0, result: "done" }),
    ])

    const coordinator = new AgentCoordinator({
      store: store as never,
      codexManager: fakeCodexManager as never,
      onStateChange: () => {},
    })

    const result = await coordinator.forkChat({
      type: "chat.fork",
      chatId: "chat-1",
      messageId: secondPrompt._id,
    })

    expect(result).toEqual({ chatId: "chat-fork-1" })
    expect(store.requireChat("chat-fork-1")).toMatchObject({
      title: "Debug Session (forked)",
      provider: "codex",
      sessionToken: null,
      pendingForkSessionToken: "thread-fork-1",
    })
    expect(startSessionCalls).toEqual([
      {
        chatId: "chat-fork-1",
        cwd: "/tmp/project",
        model: "gpt-5.6-sol",
        serviceTier: undefined,
        sessionToken: null,
        pendingForkSessionToken: "thread-1",
      },
    ])
    expect(rollbackCalls).toEqual([{
      chatId: "chat-fork-1",
      cwd: "/tmp/project",
      threadId: "thread-fork-1",
      numTurns: 2,
    }])
    expect(startedTurns).toEqual([])
    expect(store.turnFinishedCount).toBe(0)
    expect(store.getMessages("chat-1").some((entry) => entry.kind === "user_prompt" && entry.content === "third task")).toBe(true)
    expect(store.getMessages("chat-fork-1").map((entry) => entry.kind)).toEqual([
      "user_prompt",
      "assistant_text",
      "result",
      "user_prompt",
    ])
    expect(store.getMessages("chat-fork-1")[3]).toMatchObject({ kind: "user_prompt", content: "second task" })

    await coordinator.send({
      type: "chat.send",
      chatId: result.chatId,
      provider: "codex",
      content: "continue from fork",
    })
    await waitFor(() => store.turnFinishedCount === 1)

    expect(startSessionCalls).toEqual([
      {
        chatId: "chat-fork-1",
        cwd: "/tmp/project",
        model: "gpt-5.6-sol",
        serviceTier: undefined,
        sessionToken: null,
        pendingForkSessionToken: "thread-1",
      },
      {
        chatId: "chat-fork-1",
        cwd: "/tmp/project",
        model: "gpt-5.6-sol",
        serviceTier: undefined,
        sessionToken: null,
        pendingForkSessionToken: "thread-fork-1",
      },
    ])
    expect(startedTurns).toEqual(["second task\n\ncontinue from fork"])
    expect(store.requireChat("chat-fork-1")).toMatchObject({
      pendingForkSessionToken: null,
    })
    expect(store.getMessages("chat-fork-1").map((entry) => entry.kind)).toEqual([
      "user_prompt",
      "assistant_text",
      "result",
      "user_prompt",
      "result",
    ])
    expect(store.getMessages("chat-fork-1")[3]).toMatchObject({
      kind: "user_prompt",
      content: "second task\n\ncontinue from fork",
    })
  })

  test("deletes a Codex fork chat when fork session setup fails", async () => {
    const rollbackCalls: Array<{ chatId?: string; cwd: string; threadId: string; numTurns: number }> = []
    const fakeCodexManager = {
      async startSession() {
        return null
      },
      async rollbackThread(args: { chatId?: string; cwd: string; threadId: string; numTurns: number }) {
        rollbackCalls.push(args)
      },
      stopSession() {},
      async startTurn(): Promise<HarnessTurn> {
        async function* stream() {
          yield {
            type: "transcript" as const,
            entry: timestamped({
              kind: "result",
              subtype: "success",
              isError: false,
              durationMs: 0,
              result: "done",
            }),
          }
        }

        return {
          provider: "codex",
          stream: stream(),
          interrupt: async () => {},
          close: () => {},
        }
      },
    }
    const store = createForkableFakeStore("codex", {
      title: "Debug Session",
      sessionToken: "thread-1",
    })
    const prompt = timestamped({ kind: "user_prompt", content: "first task" })
    store.setMessages("chat-1", [
      prompt,
      timestamped({ kind: "assistant_text", text: "first answer" }),
      timestamped({ kind: "result", subtype: "success", isError: false, durationMs: 0, result: "done" }),
    ])

    const coordinator = new AgentCoordinator({
      store: store as never,
      codexManager: fakeCodexManager as never,
      onStateChange: () => {},
    })

    await expect(coordinator.forkChat({
      type: "chat.fork",
      chatId: "chat-1",
      messageId: prompt._id,
    })).rejects.toThrow("Codex did not return a forked session")

    expect(store.deletedChatIds).toEqual(["chat-fork-1"])
    expect(rollbackCalls).toEqual([])
  })

  test("stops the Codex fork session when rollback fails", async () => {
    const stoppedChatIds: string[] = []
    const fakeCodexManager = {
      async startSession() {
        return "thread-fork-1"
      },
      async rollbackThread() {
        throw new Error("rollback failed")
      },
      stopSession(chatId: string) {
        stoppedChatIds.push(chatId)
      },
    }
    const store = createForkableFakeStore("codex", {
      title: "Debug Session",
      sessionToken: "thread-1",
    })
    const prompt = timestamped({ kind: "user_prompt", content: "first task" })
    store.setMessages("chat-1", [
      prompt,
      timestamped({ kind: "assistant_text", text: "first answer" }),
      timestamped({ kind: "result", subtype: "success", isError: false, durationMs: 0, result: "done" }),
    ])

    const coordinator = new AgentCoordinator({
      store: store as never,
      codexManager: fakeCodexManager as never,
      onStateChange: () => {},
    })

    await expect(coordinator.forkChat({
      type: "chat.fork",
      chatId: "chat-1",
      messageId: prompt._id,
    })).rejects.toThrow("rollback failed")

    expect(stoppedChatIds).toEqual(["chat-fork-1"])
    expect(store.deletedChatIds).toEqual(["chat-fork-1"])
  })

  test("forks a Codex chat using persisted chat model settings when the command omits them", async () => {
    const startSessionCalls: Array<{
      model: string
      serviceTier?: "fast"
    }> = []
    const startTurnCalls: Array<{
      model: string
      effort?: string
      serviceTier?: "fast"
      planMode: boolean
    }> = []
    const fakeCodexManager = {
      async startSession(args: { model: string; serviceTier?: "fast"; pendingForkSessionToken?: string | null }) {
        startSessionCalls.push({ model: args.model, serviceTier: args.serviceTier })
        return args.pendingForkSessionToken ? "thread-fork-1" : undefined
      },
      async rollbackThread() {},
      async startTurn(args: {
        model: string
        effort?: string
        serviceTier?: "fast"
        planMode: boolean
      }): Promise<HarnessTurn> {
        startTurnCalls.push({
          model: args.model,
          effort: args.effort,
          serviceTier: args.serviceTier,
          planMode: args.planMode,
        })
        async function* stream() {
          yield {
            type: "transcript" as const,
            entry: timestamped({
              kind: "result",
              subtype: "success",
              isError: false,
              durationMs: 0,
              result: "done",
            }),
          }
        }

        return {
          provider: "codex",
          stream: stream(),
          interrupt: async () => {},
          close: () => {},
        }
      },
    }
    const store = createForkableFakeStore("codex", {
      title: "Persisted Settings",
      sessionToken: "thread-1",
    })
    store.chat.model = "gpt-5.6-sol"
    store.chat.modelOptions = { codex: { reasoningEffort: "xhigh", fastMode: true } }
    store.chat.planMode = true
    const prompt = timestamped({ kind: "user_prompt", content: "first task" })
    store.setMessages("chat-1", [
      prompt,
      timestamped({ kind: "assistant_text", text: "first answer" }),
      timestamped({ kind: "result", subtype: "success", isError: false, durationMs: 0, result: "done" }),
    ])

    const coordinator = new AgentCoordinator({
      store: store as never,
      codexManager: fakeCodexManager as never,
      onStateChange: () => {},
    })

    await coordinator.forkChat({
      type: "chat.fork",
      chatId: "chat-1",
      messageId: prompt._id,
    })

    expect(startSessionCalls).toEqual([
      { model: "gpt-5.6-sol", serviceTier: "fast" },
    ])
    expect(startTurnCalls).toEqual([])
    expect(store.turnFinishedCount).toBe(0)
  })

  test("forks a pending Codex fork from the selected user prompt using its pending source thread", async () => {
    const startSessionCalls: Array<{
      pendingForkSessionToken?: string | null
    }> = []
    const rollbackCalls: Array<{ numTurns: number }> = []
    const fakeCodexManager = {
      async startSession(args: { pendingForkSessionToken?: string | null }) {
        startSessionCalls.push(args)
        return args.pendingForkSessionToken ? "thread-fork-2" : undefined
      },
      async rollbackThread(args: { numTurns: number }) {
        rollbackCalls.push(args)
      },
      async startTurn(): Promise<HarnessTurn> {
        async function* stream() {
          yield {
            type: "transcript" as const,
            entry: timestamped({
              kind: "result",
              subtype: "success",
              isError: false,
              durationMs: 0,
              result: "done",
            }),
          }
        }

        return {
          provider: "codex",
          stream: stream(),
          interrupt: async () => {},
          close: () => {},
        }
      },
    }
    const store = createForkableFakeStore("codex", {
      title: "Pending Fork",
      sessionToken: null,
      pendingForkSessionToken: "thread-pending",
    })
    const prompt = timestamped({ kind: "user_prompt", content: "first task" })
    store.setMessages("chat-1", [
      prompt,
      timestamped({ kind: "assistant_text", text: "first answer" }),
      timestamped({ kind: "result", subtype: "success", isError: false, durationMs: 0, result: "done" }),
    ])

    const coordinator = new AgentCoordinator({
      store: store as never,
      codexManager: fakeCodexManager as never,
      onStateChange: () => {},
    })

    await coordinator.forkChat({
      type: "chat.fork",
      chatId: "chat-1",
      messageId: prompt._id,
    })

    expect(startSessionCalls[0]).toMatchObject({ pendingForkSessionToken: "thread-pending" })
    expect(rollbackCalls).toEqual([])
    expect(store.requireChat("chat-fork-1").sessionToken).toBeNull()
    expect(store.requireChat("chat-fork-1").pendingForkSessionToken).toBe("thread-fork-2")
    expect(store.turnFinishedCount).toBe(0)
  })

  test("starts Codex only after editing the last prompt in a forked chat", async () => {
    const startSessionCalls: Array<{
      sessionToken: string | null
      pendingForkSessionToken?: string | null
    }> = []
    const rollbackCalls: Array<{ threadId: string; numTurns: number }> = []
    const startedTurns: string[] = []
    const fakeCodexManager = {
      async startSession(args: { sessionToken: string | null; pendingForkSessionToken?: string | null }) {
        startSessionCalls.push(args)
        if (args.pendingForkSessionToken === "thread-1") return "thread-fork-1"
        if (args.pendingForkSessionToken === "thread-fork-1") return "thread-edit-1"
        return args.sessionToken
      },
      async rollbackThread(args: { threadId: string; numTurns: number }) {
        rollbackCalls.push(args)
      },
      async startTurn(args: { content: string }): Promise<HarnessTurn> {
        startedTurns.push(args.content)
        async function* stream() {
          yield {
            type: "transcript" as const,
            entry: timestamped({
              kind: "result",
              subtype: "success",
              isError: false,
              durationMs: 0,
              result: "done",
            }),
          }
        }

        return {
          provider: "codex",
          stream: stream(),
          interrupt: async () => {},
          close: () => {},
        }
      },
    }
    const store = createForkableFakeStore("codex", {
      title: "Debug Session",
      sessionToken: "thread-1",
    })
    const firstPrompt = timestamped({ kind: "user_prompt", content: "first task" })
    const secondPrompt = timestamped({ kind: "user_prompt", content: "second task" })
    store.setMessages("chat-1", [
      firstPrompt,
      timestamped({ kind: "assistant_text", text: "first answer" }),
      timestamped({ kind: "result", subtype: "success", isError: false, durationMs: 0, result: "done" }),
      secondPrompt,
      timestamped({ kind: "assistant_text", text: "second answer" }),
      timestamped({ kind: "result", subtype: "success", isError: false, durationMs: 0, result: "done" }),
    ])

    const coordinator = new AgentCoordinator({
      store: store as never,
      codexManager: fakeCodexManager as never,
      onStateChange: () => {},
    })

    await coordinator.forkChat({
      type: "chat.fork",
      chatId: "chat-1",
      messageId: secondPrompt._id,
    })

    expect(startedTurns).toEqual([])
    expect(store.requireChat("chat-fork-1").pendingForkSessionToken).toBe("thread-fork-1")

    await coordinator.editUserPrompt({
      type: "chat.editUserPrompt",
      chatId: "chat-fork-1",
      messageId: secondPrompt._id,
      content: "edited second task",
    })
    await waitFor(() => store.turnFinishedCount === 1)

    expect(startSessionCalls).toMatchObject([
      { sessionToken: null, pendingForkSessionToken: "thread-1" },
      { sessionToken: null, pendingForkSessionToken: "thread-fork-1" },
      { sessionToken: "thread-edit-1", pendingForkSessionToken: null },
    ])
    expect(rollbackCalls).toMatchObject([{ threadId: "thread-fork-1", numTurns: 1 }])
    expect(startedTurns).toEqual(["edited second task"])
    expect(store.requireChat("chat-fork-1").pendingForkSessionToken).toBeNull()
    expect(store.getMessages("chat-fork-1").map((entry) => entry.kind)).toEqual([
      "user_prompt",
      "assistant_text",
      "result",
      "user_prompt",
      "result",
    ])
    expect(store.getMessages("chat-fork-1")[3]).toMatchObject({ kind: "user_prompt", content: "edited second task" })
  })

  test("keeps a pending Codex fork unchanged when provider start fails before replay", async () => {
    let pendingForkSendAttempts = 0
    const startedTurns: string[] = []
    const fakeCodexManager = {
      async startSession(args: { pendingForkSessionToken?: string | null }) {
        if (args.pendingForkSessionToken === "thread-1") return "thread-fork-1"
        if (args.pendingForkSessionToken === "thread-fork-1") {
          pendingForkSendAttempts += 1
          if (pendingForkSendAttempts === 1) {
            throw new Error("Codex boot failed")
          }
          return "thread-fork-1"
        }
        return args.pendingForkSessionToken ?? null
      },
      async rollbackThread() {},
      async startTurn(args: { content: string }): Promise<HarnessTurn> {
        startedTurns.push(args.content)
        async function* stream() {
          yield {
            type: "transcript" as const,
            entry: timestamped({
              kind: "result",
              subtype: "success",
              isError: false,
              durationMs: 0,
              result: "done",
            }),
          }
        }

        return {
          provider: "codex",
          stream: stream(),
          interrupt: async () => {},
          close: () => {},
        }
      },
    }
    const store = createForkableFakeStore("codex", {
      title: "Pending Fork",
      sessionToken: "thread-1",
    })
    const prompt = timestamped({ kind: "user_prompt", content: "forked task" })
    store.setMessages("chat-1", [
      prompt,
      timestamped({ kind: "assistant_text", text: "forked answer" }),
      timestamped({ kind: "result", subtype: "success", isError: false, durationMs: 0, result: "done" }),
    ])

    const coordinator = new AgentCoordinator({
      store: store as never,
      codexManager: fakeCodexManager as never,
      onStateChange: () => {},
    })

    await coordinator.forkChat({
      type: "chat.fork",
      chatId: "chat-1",
      messageId: prompt._id,
    })

    await expect(coordinator.send({
      type: "chat.send",
      chatId: "chat-fork-1",
      provider: "codex",
      content: "first retry",
      model: "gpt-5.4",
    })).rejects.toThrow("Codex boot failed")

    expect(store.getMessages("chat-fork-1").filter((entry) => entry.kind === "user_prompt").map((entry) => entry.content)).toEqual([
      "forked task",
    ])
    expect(store.requireChat("chat-fork-1").pendingForkUserPrompt).toBe(true)
    expect(store.requireChat("chat-fork-1").pendingForkSessionToken).toBe("thread-fork-1")

    await coordinator.send({
      type: "chat.send",
      chatId: "chat-fork-1",
      provider: "codex",
      content: "second retry",
      model: "gpt-5.4",
    })
    await waitFor(() => store.turnFinishedCount === 1)

    expect(startedTurns).toEqual(["forked task\n\nsecond retry"])
    expect(store.getMessages("chat-fork-1").filter((entry) => entry.kind === "user_prompt").map((entry) => entry.content)).toEqual([
      "forked task\n\nsecond retry",
    ])
    expect(store.requireChat("chat-fork-1").pendingForkUserPrompt).toBe(false)
    expect(store.requireChat("chat-fork-1").pendingForkSessionToken).toBeNull()
  })

  test("rolls back a pending Codex fork before editing an earlier prompt", async () => {
    const startSessionCalls: Array<{
      sessionToken: string | null
      pendingForkSessionToken?: string | null
    }> = []
    const rollbackCalls: Array<{ threadId: string; numTurns: number }> = []
    const startedTurns: string[] = []
    const fakeCodexManager = {
      async startSession(args: { sessionToken: string | null; pendingForkSessionToken?: string | null }) {
        startSessionCalls.push(args)
        if (args.pendingForkSessionToken === "thread-1") return "thread-fork-1"
        if (args.pendingForkSessionToken === "thread-fork-1") return "thread-edit-1"
        return args.sessionToken
      },
      async rollbackThread(args: { threadId: string; numTurns: number }) {
        rollbackCalls.push(args)
      },
      async startTurn(args: { content: string }): Promise<HarnessTurn> {
        startedTurns.push(args.content)
        async function* stream() {
          yield {
            type: "transcript" as const,
            entry: timestamped({
              kind: "result",
              subtype: "success",
              isError: false,
              durationMs: 0,
              result: "done",
            }),
          }
        }

        return {
          provider: "codex",
          stream: stream(),
          interrupt: async () => {},
          close: () => {},
        }
      },
    }
    const store = createForkableFakeStore("codex", {
      title: "Debug Session",
      sessionToken: "thread-1",
    })
    const firstPrompt = timestamped({ kind: "user_prompt", content: "first task" })
    const secondPrompt = timestamped({ kind: "user_prompt", content: "second task" })
    const thirdPrompt = timestamped({ kind: "user_prompt", content: "third task" })
    store.setMessages("chat-1", [
      firstPrompt,
      timestamped({ kind: "assistant_text", text: "first answer" }),
      timestamped({ kind: "result", subtype: "success", isError: false, durationMs: 0, result: "done" }),
      secondPrompt,
      timestamped({ kind: "assistant_text", text: "second answer" }),
      timestamped({ kind: "result", subtype: "success", isError: false, durationMs: 0, result: "done" }),
      thirdPrompt,
      timestamped({ kind: "assistant_text", text: "third answer" }),
      timestamped({ kind: "result", subtype: "success", isError: false, durationMs: 0, result: "done" }),
    ])

    const coordinator = new AgentCoordinator({
      store: store as never,
      codexManager: fakeCodexManager as never,
      onStateChange: () => {},
    })

    await coordinator.forkChat({
      type: "chat.fork",
      chatId: "chat-1",
      messageId: thirdPrompt._id,
    })

    await coordinator.editUserPrompt({
      type: "chat.editUserPrompt",
      chatId: "chat-fork-1",
      messageId: secondPrompt._id,
      content: "edited second task",
    })
    await waitFor(() => store.turnFinishedCount === 1)

    expect(startSessionCalls).toMatchObject([
      { sessionToken: null, pendingForkSessionToken: "thread-1" },
      { sessionToken: null, pendingForkSessionToken: "thread-fork-1" },
      { sessionToken: "thread-edit-1", pendingForkSessionToken: null },
    ])
    expect(rollbackCalls).toMatchObject([
      { threadId: "thread-fork-1", numTurns: 1 },
      { threadId: "thread-edit-1", numTurns: 1 },
    ])
    expect(startedTurns).toEqual(["edited second task"])
    expect(store.requireChat("chat-fork-1").sessionToken).toBe("thread-edit-1")
    expect(store.requireChat("chat-fork-1").pendingForkSessionToken).toBeNull()
    expect(store.getMessages("chat-fork-1").map((entry) => entry.kind)).toEqual([
      "user_prompt",
      "assistant_text",
      "result",
      "user_prompt",
      "result",
    ])
  })

  test("stops a pending Codex fork session when edit rollback fails", async () => {
    const stoppedChatIds: string[] = []
    const fakeCodexManager = {
      async startSession() {
        return "thread-edit-1"
      },
      async rollbackThread() {
        throw new Error("rollback failed")
      },
      stopSession(chatId: string) {
        stoppedChatIds.push(chatId)
      },
    }
    const store = createForkableFakeStore("codex", {
      title: "Debug Session",
      sessionToken: "thread-1",
    })
    const firstPrompt = timestamped({ kind: "user_prompt", content: "first task" })
    const secondPrompt = timestamped({ kind: "user_prompt", content: "second task" })
    await store.forkChat("chat-1", {
      transcriptEntries: [
        firstPrompt,
        timestamped({ kind: "assistant_text", text: "first answer" }),
        timestamped({ kind: "result", subtype: "success", isError: false, durationMs: 0, result: "done" }),
        secondPrompt,
      ],
      pendingForkSessionToken: "thread-fork-1",
      pendingForkUserPrompt: true,
    })

    const coordinator = new AgentCoordinator({
      store: store as never,
      codexManager: fakeCodexManager as never,
      onStateChange: () => {},
    })

    await expect(coordinator.editUserPrompt({
      type: "chat.editUserPrompt",
      chatId: "chat-fork-1",
      messageId: firstPrompt._id,
      content: "edited first task",
    })).rejects.toThrow("rollback failed")

    expect(stoppedChatIds).toEqual(["chat-fork-1"])
    expect(store.requireChat("chat-fork-1")).toMatchObject({
      sessionToken: null,
      pendingForkSessionToken: "thread-fork-1",
    })
  })

  test("keeps pending Codex fork state when an edited turn fails to start", async () => {
    const rollbackCalls: Array<{ threadId: string; numTurns: number }> = []
    const stoppedChatIds: string[] = []
    let forkSessionCount = 0
    let startTurnCount = 0
    const fakeCodexManager = {
      async startSession(args: { sessionToken: string | null; pendingForkSessionToken?: string | null }) {
        if (args.pendingForkSessionToken === "thread-fork-1") {
          forkSessionCount += 1
          return `thread-edit-${forkSessionCount}`
        }
        return args.sessionToken
      },
      async rollbackThread(args: { threadId: string; numTurns: number }) {
        rollbackCalls.push(args)
      },
      stopSession(chatId: string) {
        stoppedChatIds.push(chatId)
      },
      async startTurn(): Promise<HarnessTurn> {
        startTurnCount += 1
        if (startTurnCount === 1) {
          throw new Error("start failed")
        }
        async function* stream() {
          yield {
            type: "transcript" as const,
            entry: timestamped({
              kind: "result",
              subtype: "success",
              isError: false,
              durationMs: 0,
              result: "done",
            }),
          }
        }

        return {
          provider: "codex",
          stream: stream(),
          interrupt: async () => {},
          close: () => {},
        }
      },
    }
    const store = createForkableFakeStore("codex", {
      title: "Debug Session",
      sessionToken: "thread-1",
    })
    const firstPrompt = timestamped({ kind: "user_prompt", content: "first task" })
    const secondPrompt = timestamped({ kind: "user_prompt", content: "second task" })
    await store.forkChat("chat-1", {
      transcriptEntries: [
        firstPrompt,
        timestamped({ kind: "assistant_text", text: "first answer" }),
        timestamped({ kind: "result", subtype: "success", isError: false, durationMs: 0, result: "done" }),
        secondPrompt,
      ],
      pendingForkSessionToken: "thread-fork-1",
      pendingForkUserPrompt: true,
    })

    const coordinator = new AgentCoordinator({
      store: store as never,
      codexManager: fakeCodexManager as never,
      onStateChange: () => {},
    })
    const editCommand = {
      type: "chat.editUserPrompt" as const,
      chatId: "chat-fork-1",
      messageId: firstPrompt._id,
      content: "edited first task",
    }

    await expect(coordinator.editUserPrompt(editCommand)).rejects.toThrow("start failed")

    expect(stoppedChatIds).toEqual(["chat-fork-1"])
    expect(store.requireChat("chat-fork-1")).toMatchObject({
      sessionToken: null,
      pendingForkSessionToken: "thread-fork-1",
    })

    await coordinator.editUserPrompt(editCommand)
    await waitFor(() => store.turnFinishedCount === 1)

    expect(rollbackCalls).toMatchObject([
      { threadId: "thread-edit-1", numTurns: 1 },
      { threadId: "thread-edit-2", numTurns: 1 },
    ])
    expect(store.requireChat("chat-fork-1")).toMatchObject({
      sessionToken: "thread-edit-2",
      pendingForkSessionToken: null,
    })
  })

  test("forks a Claude chat from the selected user prompt using the previous assistant resume point", async () => {
    const events = new AsyncEventQueue<any>()
    const startSessionCalls: Array<{
      sessionToken: string | null
      forkSession: boolean
      resumeSessionAt?: string
      resetSession?: boolean
    }> = []
    const prompts: string[] = []
    const store = createForkableFakeStore("claude", {
      title: "Claude Debug",
      sessionToken: "claude-session-1",
    })
    const firstPrompt = timestamped({ kind: "user_prompt", content: "first task" })
    const secondPrompt = timestamped({ kind: "user_prompt", content: "second task" })
    store.setMessages("chat-1", [
      firstPrompt,
      timestamped({ kind: "assistant_text", messageId: "assistant-msg-1", text: "first answer" }),
      timestamped({ kind: "result", subtype: "success", isError: false, durationMs: 0, result: "done" }),
      secondPrompt,
      timestamped({ kind: "assistant_text", messageId: "assistant-msg-2", text: "second answer" }),
      timestamped({ kind: "result", subtype: "success", isError: false, durationMs: 0, result: "done" }),
    ])

    const coordinator = new AgentCoordinator({
      store: store as never,
      onStateChange: () => {},
      startClaudeSession: async (args) => {
        startSessionCalls.push({
          sessionToken: args.sessionToken,
          forkSession: args.forkSession,
          resumeSessionAt: args.resumeSessionAt,
          resetSession: args.resetSession,
        })

        return {
          provider: "claude",
          stream: events,
          getAccountInfo: async () => null,
          interrupt: async () => {},
          close: () => {},
          setModel: async () => {},
          setPermissionMode: async () => {},
          sendPrompt: async (content: string) => {
            prompts.push(content)
            events.push({ type: "session_token" as const, sessionToken: "claude-fork-session" })
            events.push({
              type: "transcript" as const,
              entry: timestamped({
                kind: "result",
                subtype: "success",
                isError: false,
                durationMs: 0,
                result: "done",
              }),
            })
          },
        }
      },
    })

    const result = await coordinator.forkChat({
      type: "chat.fork",
      chatId: "chat-1",
      messageId: secondPrompt._id,
    })

    expect(result).toEqual({ chatId: "chat-fork-1" })
    expect(startSessionCalls).toEqual([])
    expect(prompts).toEqual([])
    expect(store.requireChat("chat-fork-1")).toMatchObject({
      title: "Claude Debug (forked)",
      provider: "claude",
      sessionToken: null,
      pendingForkSessionToken: "claude-session-1",
      pendingForkResumeAt: "assistant-msg-1",
    })
    expect(store.hiddenProviderSessions).toEqual([])
    expect(store.turnFinishedCount).toBe(0)
    expect(store.getMessages("chat-1").length).toBe(6)
    expect(store.getMessages("chat-fork-1").map((entry) => entry.kind)).toEqual([
      "user_prompt",
      "assistant_text",
      "result",
      "user_prompt",
    ])
    expect(store.getMessages("chat-fork-1")[3]).toMatchObject({ kind: "user_prompt", content: "second task" })

    await coordinator.send({
      type: "chat.send",
      chatId: result.chatId,
      provider: "claude",
      content: "continue from fork",
      model: "claude-opus-4-1",
    })
    await waitFor(() => store.turnFinishedCount === 1)

    expect(startSessionCalls).toEqual([{
      sessionToken: "claude-session-1",
      forkSession: true,
      resumeSessionAt: "assistant-msg-1",
      resetSession: undefined,
    }])
    expect(prompts).toEqual(["second task\n\ncontinue from fork"])
    expect(store.requireChat("chat-fork-1")).toMatchObject({
      sessionToken: "claude-fork-session",
      pendingForkSessionToken: null,
      pendingForkResumeAt: null,
    })
    expect(store.getMessages("chat-fork-1").map((entry) => entry.kind)).toEqual([
      "user_prompt",
      "assistant_text",
      "result",
      "user_prompt",
      "result",
    ])
    expect(store.getMessages("chat-fork-1")[3]).toMatchObject({
      kind: "user_prompt",
      content: "second task\n\ncontinue from fork",
    })

    events.close()
  })

  test("continues a first-message Claude fork by gluing the next prompt into the visible pending prompt", async () => {
    const events = new AsyncEventQueue<any>()
    const startSessionCalls: Array<{
      sessionToken: string | null
      forkSession: boolean
      resumeSessionAt?: string
    }> = []
    const prompts: string[] = []
    const store = createForkableFakeStore("claude", {
      title: "Claude Debug",
      sessionToken: "claude-session-1",
    })
    const firstPrompt = timestamped({ kind: "user_prompt", content: "first task" })
    const secondPrompt = timestamped({ kind: "user_prompt", content: "second task" })
    store.setMessages("chat-1", [
      firstPrompt,
      timestamped({ kind: "assistant_text", messageId: "assistant-msg-1", text: "first answer" }),
      timestamped({ kind: "result", subtype: "success", isError: false, durationMs: 0, result: "done" }),
      secondPrompt,
      timestamped({ kind: "assistant_text", messageId: "assistant-msg-2", text: "second answer" }),
      timestamped({ kind: "result", subtype: "success", isError: false, durationMs: 0, result: "done" }),
    ])

    const coordinator = new AgentCoordinator({
      store: store as never,
      onStateChange: () => {},
      startClaudeSession: async (args) => {
        startSessionCalls.push({
          sessionToken: args.sessionToken,
          forkSession: args.forkSession,
          resumeSessionAt: args.resumeSessionAt,
        })

        return {
          provider: "claude",
          stream: events,
          getAccountInfo: async () => null,
          interrupt: async () => {},
          close: () => {},
          setModel: async () => {},
          setPermissionMode: async () => {},
          sendPrompt: async (content: string) => {
            prompts.push(content)
            events.push({ type: "session_token" as const, sessionToken: "claude-fork-session" })
            events.push({
              type: "transcript" as const,
              entry: timestamped({
                kind: "result",
                subtype: "success",
                isError: false,
                durationMs: 0,
                result: "done",
              }),
            })
          },
        }
      },
    })

    const result = await coordinator.forkChat({
      type: "chat.fork",
      chatId: "chat-1",
      messageId: firstPrompt._id,
    })

    expect(store.requireChat(result.chatId)).toMatchObject({
      pendingForkSessionToken: null,
      pendingForkResumeAt: null,
    })

    await coordinator.send({
      type: "chat.send",
      chatId: result.chatId,
      provider: "claude",
      content: "continue from fork",
      model: "claude-opus-4-1",
    })
    await waitFor(() => store.turnFinishedCount === 1)

    expect(startSessionCalls).toEqual([{
      sessionToken: null,
      forkSession: false,
      resumeSessionAt: undefined,
    }])
    expect(prompts).toEqual(["first task\n\ncontinue from fork"])
    expect(store.getMessages("chat-fork-1").map((entry) => entry.kind)).toEqual([
      "user_prompt",
      "result",
    ])
    expect(store.getMessages("chat-fork-1")[0]).toMatchObject({
      kind: "user_prompt",
      content: "first task\n\ncontinue from fork",
    })

    events.close()
  })

  test("starts Claude only after editing the last prompt in a forked chat", async () => {
    const events = new AsyncEventQueue<any>()
    const startSessionCalls: Array<{
      sessionToken: string | null
      forkSession: boolean
      resumeSessionAt?: string
      resetSession?: boolean
    }> = []
    const prompts: string[] = []
    const store = createForkableFakeStore("claude", {
      title: "Claude Debug",
      sessionToken: "claude-session-1",
    })
    const firstPrompt = timestamped({ kind: "user_prompt", content: "first task" })
    const secondPrompt = timestamped({ kind: "user_prompt", content: "second task" })
    store.setMessages("chat-1", [
      firstPrompt,
      timestamped({ kind: "assistant_text", messageId: "assistant-msg-1", text: "first answer" }),
      timestamped({ kind: "result", subtype: "success", isError: false, durationMs: 0, result: "done" }),
      secondPrompt,
      timestamped({ kind: "assistant_text", messageId: "assistant-msg-2", text: "second answer" }),
      timestamped({ kind: "result", subtype: "success", isError: false, durationMs: 0, result: "done" }),
    ])

    const coordinator = new AgentCoordinator({
      store: store as never,
      onStateChange: () => {},
      startClaudeSession: async (args) => {
        startSessionCalls.push({
          sessionToken: args.sessionToken,
          forkSession: args.forkSession,
          resumeSessionAt: args.resumeSessionAt,
          resetSession: args.resetSession,
        })

        return {
          provider: "claude",
          stream: events,
          getAccountInfo: async () => null,
          interrupt: async () => {},
          close: () => {},
          setModel: async () => {},
          setPermissionMode: async () => {},
          sendPrompt: async (content: string) => {
            prompts.push(content)
            events.push({ type: "session_token" as const, sessionToken: "claude-edit-session" })
            events.push({
              type: "transcript" as const,
              entry: timestamped({
                kind: "system_init",
                provider: "claude",
                model: "claude-opus-4-1",
                tools: [],
                agents: [],
                slashCommands: [],
                mcpServers: [],
              }),
            })
            events.push({
              type: "transcript" as const,
              entry: timestamped({
                kind: "result",
                subtype: "success",
                isError: false,
                durationMs: 0,
                result: "done",
              }),
            })
          },
        }
      },
    })

    await coordinator.forkChat({
      type: "chat.fork",
      chatId: "chat-1",
      messageId: secondPrompt._id,
    })

    expect(startSessionCalls).toEqual([])
    expect(prompts).toEqual([])
    expect(store.requireChat("chat-fork-1").pendingForkSessionToken).toBe("claude-session-1")

    await coordinator.editUserPrompt({
      type: "chat.editUserPrompt",
      chatId: "chat-fork-1",
      messageId: secondPrompt._id,
      content: "edited second task",
    })
    await waitFor(() => store.turnFinishedCount === 1)

    expect(startSessionCalls).toEqual([{
      sessionToken: "claude-session-1",
      forkSession: false,
      resumeSessionAt: undefined,
      resetSession: true,
    }])
    expect(prompts).toEqual(["edited second task"])
    expect(store.requireChat("chat-fork-1")).toMatchObject({
      sessionToken: "claude-edit-session",
      pendingForkSessionToken: null,
    })
    expect(store.getMessages("chat-fork-1").map((entry) => entry.kind)).toEqual([
      "user_prompt",
      "assistant_text",
      "result",
      "user_prompt",
      "system_init",
      "result",
    ])
    expect(store.getMessages("chat-fork-1")[3]).toMatchObject({ kind: "user_prompt", content: "edited second task" })

    events.close()
  })

  test("starts Claude after editing a non-last prompt in a pending forked chat", async () => {
    const events = new AsyncEventQueue<any>()
    const startSessionCalls: Array<{
      sessionToken: string | null
      forkSession: boolean
      resumeSessionAt?: string
      resetSession?: boolean
    }> = []
    const prompts: string[] = []
    const store = createForkableFakeStore("claude", {
      title: "Claude Debug",
      sessionToken: "claude-session-1",
    })
    const firstPrompt = timestamped({ kind: "user_prompt", content: "first task" })
    const secondPrompt = timestamped({ kind: "user_prompt", content: "second task" })
    const thirdPrompt = timestamped({ kind: "user_prompt", content: "third task" })
    store.setMessages("chat-1", [
      firstPrompt,
      timestamped({ kind: "assistant_text", messageId: "assistant-msg-1", text: "first answer" }),
      timestamped({ kind: "result", subtype: "success", isError: false, durationMs: 0, result: "done" }),
      secondPrompt,
      timestamped({ kind: "assistant_text", messageId: "assistant-msg-2", text: "second answer" }),
      timestamped({ kind: "result", subtype: "success", isError: false, durationMs: 0, result: "done" }),
      thirdPrompt,
      timestamped({ kind: "assistant_text", messageId: "assistant-msg-3", text: "third answer" }),
      timestamped({ kind: "result", subtype: "success", isError: false, durationMs: 0, result: "done" }),
    ])

    const coordinator = new AgentCoordinator({
      store: store as never,
      onStateChange: () => {},
      startClaudeSession: async (args) => {
        startSessionCalls.push({
          sessionToken: args.sessionToken,
          forkSession: args.forkSession,
          resumeSessionAt: args.resumeSessionAt,
          resetSession: args.resetSession,
        })

        return {
          provider: "claude",
          stream: events,
          getAccountInfo: async () => null,
          interrupt: async () => {},
          close: () => {},
          setModel: async () => {},
          setPermissionMode: async () => {},
          sendPrompt: async (content: string) => {
            prompts.push(content)
            events.push({ type: "session_token" as const, sessionToken: "claude-edit-session" })
            events.push({
              type: "transcript" as const,
              entry: timestamped({
                kind: "system_init",
                provider: "claude",
                model: "claude-opus-4-1",
                tools: [],
                agents: [],
                slashCommands: [],
                mcpServers: [],
              }),
            })
            events.push({
              type: "transcript" as const,
              entry: timestamped({
                kind: "result",
                subtype: "success",
                isError: false,
                durationMs: 0,
                result: "done",
              }),
            })
          },
        }
      },
    })

    await coordinator.forkChat({
      type: "chat.fork",
      chatId: "chat-1",
      messageId: thirdPrompt._id,
    })

    expect(startSessionCalls).toEqual([])
    expect(prompts).toEqual([])
    expect(store.requireChat("chat-fork-1")).toMatchObject({
      pendingForkSessionToken: "claude-session-1",
      pendingForkResumeAt: "assistant-msg-2",
    })

    await coordinator.editUserPrompt({
      type: "chat.editUserPrompt",
      chatId: "chat-fork-1",
      messageId: secondPrompt._id,
      content: "edited second task",
    })
    await waitFor(() => store.turnFinishedCount === 1)

    expect(startSessionCalls).toEqual([{
      sessionToken: "claude-session-1",
      forkSession: false,
      resumeSessionAt: undefined,
      resetSession: true,
    }])
    expect(prompts).toEqual(["edited second task"])
    expect(store.requireChat("chat-fork-1")).toMatchObject({
      sessionToken: "claude-edit-session",
      pendingForkSessionToken: null,
      pendingForkResumeAt: null,
    })
    expect(store.getMessages("chat-fork-1").map((entry) => entry.kind)).toEqual([
      "user_prompt",
      "assistant_text",
      "result",
      "user_prompt",
      "system_init",
      "result",
    ])
    expect(store.getMessages("chat-fork-1")[3]).toMatchObject({ kind: "user_prompt", content: "edited second task" })
    expect(store.getMessages("chat-fork-1").some((entry) => entry.kind === "user_prompt" && entry.content === "third task")).toBe(false)

    events.close()
  })

  test("generates a chat title in the background on the first user message", async () => {
    let releaseTitle!: () => void
    const titleGate = new Promise<void>((resolve) => {
      releaseTitle = resolve
    })
    const fakeCodexManager = {
      async startSession() {},
      async startTurn(): Promise<HarnessTurn> {
        async function* stream() {
          yield {
            type: "transcript" as const,
            entry: timestamped({
              kind: "system_init",
              provider: "codex",
              model: "gpt-5.4",
              tools: [],
              agents: [],
              slashCommands: [],
              mcpServers: [],
            }),
          }
          yield {
            type: "transcript" as const,
            entry: timestamped({
              kind: "result",
              subtype: "success",
              isError: false,
              durationMs: 0,
              result: "",
            }),
          }
        }

        return {
          provider: "codex",
          stream: stream(),
          interrupt: async () => {},
          close: () => {},
        }
      },
    }

    const store = createFakeStore()
    const coordinator = new AgentCoordinator({
      store: store as never,
      onStateChange: () => {},
      codexManager: fakeCodexManager as never,
      generateTitle: async () => {
        await titleGate
        return {
          title: "Generated title",
          usedFallback: false,
          failureMessage: null,
        }
      },
    })

    await coordinator.send({
      type: "chat.send",
      chatId: "chat-1",
      provider: "codex",
      content: "first message",
      model: "gpt-5.4",
    })

    expect(store.chat.title).toBe("first message")
    releaseTitle()
    await waitFor(() => store.chat.title === "Generated title")
    expect(store.messages[0]?.kind).toBe("user_prompt")
  })

  test("does not overwrite a manual rename when background title generation finishes later", async () => {
    let releaseTitle!: () => void
    const titleGate = new Promise<void>((resolve) => {
      releaseTitle = resolve
    })
    const fakeCodexManager = {
      async startSession() {},
      async startTurn(): Promise<HarnessTurn> {
        async function* stream() {
          yield {
            type: "transcript" as const,
            entry: timestamped({
              kind: "system_init",
              provider: "codex",
              model: "gpt-5.4",
              tools: [],
              agents: [],
              slashCommands: [],
              mcpServers: [],
            }),
          }
          yield {
            type: "transcript" as const,
            entry: timestamped({
              kind: "result",
              subtype: "success",
              isError: false,
              durationMs: 0,
              result: "",
            }),
          }
        }

        return {
          provider: "codex",
          stream: stream(),
          interrupt: async () => {},
          close: () => {},
        }
      },
    }

    const store = createFakeStore()
    const coordinator = new AgentCoordinator({
      store: store as never,
      onStateChange: () => {},
      codexManager: fakeCodexManager as never,
      generateTitle: async () => {
        await titleGate
        return {
          title: "Generated title",
          usedFallback: false,
          failureMessage: null,
        }
      },
    })

    await coordinator.send({
      type: "chat.send",
      chatId: "chat-1",
      provider: "codex",
      content: "first message",
      model: "gpt-5.4",
    })

    await store.renameChat("chat-1", "Manual title")
    releaseTitle()
    await waitFor(() => store.turnFinishedCount === 1)

    expect(store.chat.title).toBe("Manual title")
  })

  test("reports provider failure without a second rename after the optimistic title", async () => {
    const fakeCodexManager = {
      async startSession() {},
      async startTurn(): Promise<HarnessTurn> {
        async function* stream() {
          yield {
            type: "transcript" as const,
            entry: timestamped({
              kind: "system_init",
              provider: "codex",
              model: "gpt-5.4",
              tools: [],
              agents: [],
              slashCommands: [],
              mcpServers: [],
            }),
          }
          yield {
            type: "transcript" as const,
            entry: timestamped({
              kind: "result",
              subtype: "success",
              isError: false,
              durationMs: 0,
              result: "",
            }),
          }
        }

        return {
          provider: "codex",
          stream: stream(),
          interrupt: async () => {},
          close: () => {},
        }
      },
    }

    const store = createFakeStore()
    const backgroundErrors: string[] = []
    const coordinator = new AgentCoordinator({
      store: store as never,
      onStateChange: () => {},
      codexManager: fakeCodexManager as never,
      generateTitle: async () => ({
        title: "first message",
        usedFallback: true,
        failureMessage: "claude failed conversation title generation: Not authenticated",
      }),
    })
    coordinator.setBackgroundErrorReporter((message) => {
      backgroundErrors.push(message)
    })

    await coordinator.send({
      type: "chat.send",
      chatId: "chat-1",
      provider: "codex",
      content: "first message",
      model: "gpt-5.4",
    })

    expect(store.chat.title).toBe("first message")
    await waitFor(() => store.turnFinishedCount === 1)
    expect(store.chat.title).toBe("first message")
    expect(backgroundErrors).toEqual([
      "[title-generation] chat chat-1 failed provider title generation: claude failed conversation title generation: Not authenticated",
    ])
  })

  test("binds codex provider and reuses the session token on later turns", async () => {
    const sessionCalls: Array<{ chatId: string; sessionToken: string | null }> = []
    const fakeCodexManager = {
      async startSession(args: { chatId: string; sessionToken: string | null }) {
        sessionCalls.push({ chatId: args.chatId, sessionToken: args.sessionToken })
      },
      async startTurn(): Promise<HarnessTurn> {
        async function* stream() {
          yield { type: "session_token" as const, sessionToken: "thread-1" }
          yield {
            type: "transcript" as const,
            entry: timestamped({
              kind: "system_init",
              provider: "codex",
              model: "gpt-5.4",
              tools: [],
              agents: [],
              slashCommands: [],
              mcpServers: [],
            }),
          }
          yield {
            type: "transcript" as const,
            entry: timestamped({
              kind: "result",
              subtype: "success",
              isError: false,
              durationMs: 0,
              result: "",
            }),
          }
        }

        return {
          provider: "codex",
          stream: stream(),
          interrupt: async () => {},
          close: () => {},
        }
      },
    }

    const store = createFakeStore()
    const coordinator = new AgentCoordinator({
      store: store as never,
      onStateChange: () => {},
      codexManager: fakeCodexManager as never,
    })

    await coordinator.send({
      type: "chat.send",
      chatId: "chat-1",
      provider: "codex",
      content: "first",
    })

    await waitFor(() => store.turnFinishedCount === 1)
    expect(store.chat.provider).toBe("codex")
    expect(store.chat.sessionToken).toBe("thread-1")
    expect(sessionCalls).toEqual([{ chatId: "chat-1", sessionToken: null }])

    await coordinator.send({
      type: "chat.send",
      chatId: "chat-1",
      content: "second",
    })

    await waitFor(() => store.turnFinishedCount === 2)
    expect(sessionCalls).toEqual([
      { chatId: "chat-1", sessionToken: null },
      { chatId: "chat-1", sessionToken: "thread-1" },
    ])
  })

  test("maps explicit and legacy Codex options over persisted chat settings", async () => {
    const sessionCalls: Array<{ chatId: string; sessionToken: string | null; serviceTier?: string }> = []
    const turnCalls: Array<{ effort?: string; serviceTier?: string }> = []

    const fakeCodexManager = {
      async startSession(args: { chatId: string; sessionToken: string | null; serviceTier?: string }) {
        sessionCalls.push({
          chatId: args.chatId,
          sessionToken: args.sessionToken,
          serviceTier: args.serviceTier,
        })
      },
      async startTurn(args: { effort?: string; serviceTier?: string }): Promise<HarnessTurn> {
        turnCalls.push({
          effort: args.effort,
          serviceTier: args.serviceTier,
        })

        async function* stream() {
          yield { type: "session_token" as const, sessionToken: "thread-1" }
          yield {
            type: "transcript" as const,
            entry: timestamped({
              kind: "system_init",
              provider: "codex",
              model: "gpt-5.4",
              tools: [],
              agents: [],
              slashCommands: [],
              mcpServers: [],
            }),
          }
          yield {
            type: "transcript" as const,
            entry: timestamped({
              kind: "result",
              subtype: "success",
              isError: false,
              durationMs: 0,
              result: "",
            }),
          }
        }

        return {
          provider: "codex",
          stream: stream(),
          interrupt: async () => {},
          close: () => {},
        }
      },
    }

    const store = createFakeStore()
    const coordinator = new AgentCoordinator({
      store: store as never,
      onStateChange: () => {},
      codexManager: fakeCodexManager as never,
    })

    await coordinator.send({
      type: "chat.send",
      chatId: "chat-1",
      provider: "codex",
      content: "opt in",
      modelOptions: {
        codex: {
          reasoningEffort: "xhigh",
          fastMode: true,
        },
      },
    })

    await waitFor(() => store.turnFinishedCount === 1)

    expect(sessionCalls).toEqual([{ chatId: "chat-1", sessionToken: null, serviceTier: "fast" }])
    expect(turnCalls).toEqual([{ effort: "xhigh", serviceTier: "fast" }])
    expect(store.chat.model).toBe("gpt-5.6-sol")
    expect(store.chat.modelOptions).toEqual({
      codex: {
        reasoningEffort: "xhigh",
        fastMode: true,
      },
    })

    await coordinator.send({
      type: "chat.send",
      chatId: "chat-1",
      provider: "codex",
      content: "legacy effort override",
      effort: "low",
    })

    await waitFor(() => store.turnFinishedCount === 2)

    expect(sessionCalls).toEqual([
      { chatId: "chat-1", sessionToken: null, serviceTier: "fast" },
      { chatId: "chat-1", sessionToken: "thread-1", serviceTier: "fast" },
    ])
    expect(turnCalls).toEqual([
      { effort: "xhigh", serviceTier: "fast" },
      { effort: "low", serviceTier: "fast" },
    ])
    expect(store.chat.modelOptions).toEqual({
      codex: {
        reasoningEffort: "low",
        fastMode: true,
      },
    })
  })

  test("approving synthetic codex ExitPlanMode starts a hidden follow-up turn and can clear context", async () => {
    const sessionCalls: Array<{ chatId: string; sessionToken: string | null }> = []
    const startTurnCalls: Array<{ content: string; planMode: boolean }> = []
    let turnCount = 0

    const fakeCodexManager = {
      async startSession(args: { chatId: string; sessionToken: string | null }) {
        sessionCalls.push({ chatId: args.chatId, sessionToken: args.sessionToken })
      },
      async startTurn(args: {
        content: string
        planMode: boolean
        onToolRequest: (request: any) => Promise<unknown>
      }): Promise<HarnessTurn> {
        startTurnCalls.push({ content: args.content, planMode: args.planMode })
        turnCount += 1

        async function* firstStream() {
          yield { type: "session_token" as const, sessionToken: "thread-1" }
          yield {
            type: "transcript" as const,
            entry: timestamped({
              kind: "system_init",
              provider: "codex",
              model: "gpt-5.4",
              tools: [],
              agents: [],
              slashCommands: [],
              mcpServers: [],
            }),
          }
          yield {
            type: "transcript" as const,
            entry: timestamped({
              kind: "tool_call",
              tool: {
                kind: "tool",
                toolKind: "exit_plan_mode",
                toolName: "ExitPlanMode",
                toolId: "exit-1",
                input: {
                  plan: "## Plan\n\n- [ ] Ship it",
                  summary: "Plan summary",
                },
              },
            }),
          }
          await args.onToolRequest({
            tool: {
              kind: "tool",
              toolKind: "exit_plan_mode",
              toolName: "ExitPlanMode",
              toolId: "exit-1",
              input: {
                plan: "## Plan\n\n- [ ] Ship it",
                summary: "Plan summary",
              },
            },
          })
        }

        async function* secondStream() {
          yield { type: "session_token" as const, sessionToken: "thread-2" }
          yield {
            type: "transcript" as const,
            entry: timestamped({
              kind: "system_init",
              provider: "codex",
              model: "gpt-5.4",
              tools: [],
              agents: [],
              slashCommands: [],
              mcpServers: [],
            }),
          }
          yield {
            type: "transcript" as const,
            entry: timestamped({
              kind: "result",
              subtype: "success",
              isError: false,
              durationMs: 0,
              result: "",
            }),
          }
        }

        return {
          provider: "codex",
          stream: turnCount === 1 ? firstStream() : secondStream(),
          interrupt: async () => {},
          close: () => {},
        }
      },
    }

    const store = createFakeStore()
    const coordinator = new AgentCoordinator({
      store: store as never,
      onStateChange: () => {},
      codexManager: fakeCodexManager as never,
    })

    await coordinator.send({
      type: "chat.send",
      chatId: "chat-1",
      provider: "codex",
      content: "plan this",
      planMode: true,
    })

    await waitFor(() => coordinator.getPendingTool("chat-1")?.toolKind === "exit_plan_mode")

    await coordinator.respondTool({
      type: "chat.respondTool",
      chatId: "chat-1",
      toolUseId: "exit-1",
      result: {
        confirmed: true,
        clearContext: true,
        message: "Use the fast path",
      },
    })

    await waitFor(() => store.turnFinishedCount === 1)

    expect(startTurnCalls).toEqual([
      { content: "plan this", planMode: true },
      { content: "Proceed with the approved plan. Additional guidance: Use the fast path", planMode: false },
    ])
    expect(sessionCalls).toEqual([
      { chatId: "chat-1", sessionToken: null },
      { chatId: "chat-1", sessionToken: null },
    ])
    expect(store.messages.filter((entry) => entry.kind === "user_prompt")).toHaveLength(1)
    expect(store.messages.some((entry) => entry.kind === "context_cleared")).toBe(true)
    expect(store.chat.sessionToken).toBe("thread-2")
  })

  test("cancelling a waiting ask-user-question records a discarded tool result", async () => {
    let releaseInterrupt!: () => void
    const interrupted = new Promise<void>((resolve) => {
      releaseInterrupt = resolve
    })

    const fakeCodexManager = {
      async startSession() {},
      async startTurn(args: {
        onToolRequest: (request: any) => Promise<unknown>
      }): Promise<HarnessTurn> {
        async function* stream() {
          yield {
            type: "transcript" as const,
            entry: timestamped({
              kind: "system_init",
              provider: "codex",
              model: "gpt-5.4",
              tools: [],
              agents: [],
              slashCommands: [],
              mcpServers: [],
            }),
          }
          void args.onToolRequest({
            tool: {
              kind: "tool",
              toolKind: "ask_user_question",
              toolName: "AskUserQuestion",
              toolId: "question-1",
              input: {
                questions: [{ question: "Provider?" }],
              },
            },
          })
          await interrupted
        }

        return {
          provider: "codex",
          stream: stream(),
          interrupt: async () => {
            releaseInterrupt()
          },
          close: () => {},
        }
      },
    }

    const store = createFakeStore()
    const coordinator = new AgentCoordinator({
      store: store as never,
      onStateChange: () => {},
      codexManager: fakeCodexManager as never,
    })

    await coordinator.send({
      type: "chat.send",
      chatId: "chat-1",
      provider: "codex",
      content: "ask me something",
    })

    await waitFor(() => coordinator.getPendingTool("chat-1")?.toolKind === "ask_user_question")
    await coordinator.cancel("chat-1")

    const discardedResult = store.messages.find((entry) => entry.kind === "tool_result" && entry.toolId === "question-1")
    expect(discardedResult).toBeDefined()
    if (!discardedResult || discardedResult.kind !== "tool_result") {
      throw new Error("missing discarded ask-user-question result")
    }
    expect(discardedResult.content).toEqual({ discarded: true, answers: {} })
    expect(store.messages.some((entry) => entry.kind === "interrupted")).toBe(true)
  })

  test("UI unblocks immediately when result arrives even if stream stays open", async () => {
    let resolveStream!: () => void

    const fakeCodexManager = {
      async startSession() {},
      async startTurn(): Promise<HarnessTurn> {
        async function* stream() {
          yield {
            type: "transcript" as const,
            entry: timestamped({
              kind: "system_init",
              provider: "codex",
              model: "gpt-5.4",
              tools: [],
              agents: [],
              slashCommands: [],
              mcpServers: [],
            }),
          }
          // Produce the result event
          yield {
            type: "transcript" as const,
            entry: timestamped({
              kind: "result",
              subtype: "success",
              isError: false,
              durationMs: 120_000,
              result: "done",
            }),
          }
          // Stream stays open (simulates background tasks still running)
          await new Promise<void>((resolve) => {
            resolveStream = resolve
          })
        }

        return {
          provider: "codex",
          stream: stream(),
          interrupt: async () => {},
          close: () => {
            resolveStream?.()
          },
        }
      },
    }

    const store = createFakeStore()
    const coordinator = new AgentCoordinator({
      store: store as never,
      onStateChange: () => {},
      codexManager: fakeCodexManager as never,
    })

    await coordinator.send({
      type: "chat.send",
      chatId: "chat-1",
      provider: "codex",
      content: "run something with a background task",
    })

    // Wait for the result message to be persisted
    await waitFor(() => store.messages.some((entry) => entry.kind === "result"))

    // The active turn should be removed even though the stream is still open.
    // This is the key assertion: the UI should show idle (not "Running...")
    // so the user can send new messages without hitting stop.
    expect(coordinator.getActiveStatuses().has("chat-1")).toBe(false)
    expect(store.turnFinishedCount).toBe(1)

    // The stream is still open, so it should be draining
    expect(coordinator.getDrainingChatIds().has("chat-1")).toBe(true)

    // Clean up the hanging stream
    resolveStream()

    // After the stream closes, draining should stop
    await waitFor(() => !coordinator.getDrainingChatIds().has("chat-1"))
  })

  test("stopDraining closes the stream and removes from draining set", async () => {
    let resolveStream!: () => void
    let streamClosed = false

    const fakeCodexManager = {
      async startSession() {},
      async startTurn(): Promise<HarnessTurn> {
        async function* stream() {
          yield {
            type: "transcript" as const,
            entry: timestamped({
              kind: "system_init",
              provider: "codex",
              model: "gpt-5.4",
              tools: [],
              agents: [],
              slashCommands: [],
              mcpServers: [],
            }),
          }
          yield {
            type: "transcript" as const,
            entry: timestamped({
              kind: "result",
              subtype: "success",
              isError: false,
              durationMs: 0,
              result: "done",
            }),
          }
          await new Promise<void>((resolve) => {
            resolveStream = resolve
          })
        }

        return {
          provider: "codex",
          stream: stream(),
          interrupt: async () => {},
          close: () => {
            streamClosed = true
            resolveStream?.()
          },
        }
      },
    }

    const store = createFakeStore()
    const coordinator = new AgentCoordinator({
      store: store as never,
      onStateChange: () => {},
      codexManager: fakeCodexManager as never,
    })

    await coordinator.send({
      type: "chat.send",
      chatId: "chat-1",
      provider: "codex",
      content: "work",
    })

    await waitFor(() => coordinator.getDrainingChatIds().has("chat-1"))

    await coordinator.stopDraining("chat-1")

    expect(coordinator.getDrainingChatIds().has("chat-1")).toBe(false)
    expect(streamClosed).toBe(true)
  })

  test("cancel immediately removes active turn so UI shows idle", async () => {
    let resolveInterrupt!: () => void
    const interruptCalled = new Promise<void>((resolve) => {
      resolveInterrupt = resolve
    })
    // interrupt() that hangs until we resolve it — simulating a slow SDK
    let interruptDone = false

    const fakeCodexManager = {
      async startSession() {},
      async startTurn(): Promise<HarnessTurn> {
        async function* stream() {
          yield {
            type: "transcript" as const,
            entry: timestamped({
              kind: "system_init",
              provider: "codex",
              model: "gpt-5.4",
              tools: [],
              agents: [],
              slashCommands: [],
              mcpServers: [],
            }),
          }
          // Stream that never ends (simulates the SDK hanging)
          await new Promise(() => {})
        }

        return {
          provider: "codex",
          stream: stream(),
          interrupt: async () => {
            resolveInterrupt()
            // Hang to simulate a slow interrupt
            await new Promise<void>((resolve) => {
              setTimeout(() => {
                interruptDone = true
                resolve()
              }, 100)
            })
          },
          close: () => {},
        }
      },
    }

    const stateChanges: number[] = []
    const store = createFakeStore()
    const coordinator = new AgentCoordinator({
      store: store as never,
      onStateChange: () => {
        stateChanges.push(Date.now())
      },
      codexManager: fakeCodexManager as never,
    })

    await coordinator.send({
      type: "chat.send",
      chatId: "chat-1",
      provider: "codex",
      content: "do something",
    })

    // Wait for the turn to be running
    await waitFor(() => coordinator.getActiveStatuses().get("chat-1") === "running")

    // Cancel — this should immediately remove from active turns
    const cancelPromise = coordinator.cancel("chat-1")

    // The turn should be removed from activeTurns immediately,
    // BEFORE interrupt() resolves
    await interruptCalled
    expect(coordinator.getActiveStatuses().has("chat-1")).toBe(false)
    expect(interruptDone).toBe(false) // interrupt is still in progress

    await cancelPromise

    // Verify only one "interrupted" message was appended
    const interruptedMessages = store.messages.filter((entry) => entry.kind === "interrupted")
    expect(interruptedMessages).toHaveLength(1)
  })

  test("concurrent cancel calls only produce a single interrupted message", async () => {
    let resolveStream!: () => void

    const fakeCodexManager = {
      async startSession() {},
      async startTurn(): Promise<HarnessTurn> {
        async function* stream() {
          yield {
            type: "transcript" as const,
            entry: timestamped({
              kind: "system_init",
              provider: "codex",
              model: "gpt-5.4",
              tools: [],
              agents: [],
              slashCommands: [],
              mcpServers: [],
            }),
          }
          await new Promise<void>((resolve) => {
            resolveStream = resolve
          })
        }

        return {
          provider: "codex",
          stream: stream(),
          interrupt: async () => {
            resolveStream()
          },
          close: () => {},
        }
      },
    }

    const store = createFakeStore()
    const coordinator = new AgentCoordinator({
      store: store as never,
      onStateChange: () => {},
      codexManager: fakeCodexManager as never,
    })

    await coordinator.send({
      type: "chat.send",
      chatId: "chat-1",
      provider: "codex",
      content: "work",
    })

    await waitFor(() => coordinator.getActiveStatuses().get("chat-1") === "running")

    // Fire multiple cancel calls concurrently (simulating repeated stop button clicks)
    await Promise.all([
      coordinator.cancel("chat-1"),
      coordinator.cancel("chat-1"),
      coordinator.cancel("chat-1"),
    ])

    // Only one "interrupted" message should exist
    const interruptedMessages = store.messages.filter((entry) => entry.kind === "interrupted")
    expect(interruptedMessages).toHaveLength(1)
  })

  test("runTurn stops processing events after cancel", async () => {
    let resolveStream!: () => void

    const fakeCodexManager = {
      async startSession() {},
      async startTurn(): Promise<HarnessTurn> {
        async function* stream() {
          yield {
            type: "transcript" as const,
            entry: timestamped({
              kind: "system_init",
              provider: "codex",
              model: "gpt-5.4",
              tools: [],
              agents: [],
              slashCommands: [],
              mcpServers: [],
            }),
          }
          // Wait for cancel, then yield another event that should be ignored
          await new Promise<void>((resolve) => {
            resolveStream = resolve
          })
          // This event arrives after cancel — should not be processed
          yield {
            type: "transcript" as const,
            entry: timestamped({
              kind: "assistant_text",
              text: "this should be ignored after cancel",
            }),
          }
        }

        return {
          provider: "codex",
          stream: stream(),
          interrupt: async () => {
            resolveStream()
          },
          close: () => {},
        }
      },
    }

    const store = createFakeStore()
    const coordinator = new AgentCoordinator({
      store: store as never,
      onStateChange: () => {},
      codexManager: fakeCodexManager as never,
    })

    await coordinator.send({
      type: "chat.send",
      chatId: "chat-1",
      provider: "codex",
      content: "work",
    })

    await waitFor(() => coordinator.getActiveStatuses().get("chat-1") === "running")

    const messageCountBefore = store.messages.filter((entry) => entry.kind === "assistant_text").length
    await coordinator.cancel("chat-1")

    // Give the stream time to yield the extra event
    await new Promise((resolve) => setTimeout(resolve, 50))

    const postCancelTextMessages = store.messages.filter((entry) => entry.kind === "assistant_text")
    expect(postCancelTextMessages.length).toBe(messageCountBefore)
  })

  test("cancelling a waiting codex exit-plan prompt discards it without starting a follow-up turn", async () => {
    let releaseInterrupt!: () => void
    const interrupted = new Promise<void>((resolve) => {
      releaseInterrupt = resolve
    })
    const startTurnCalls: string[] = []

    const fakeCodexManager = {
      async startSession() {},
      async startTurn(args: {
        content: string
        onToolRequest: (request: any) => Promise<unknown>
      }): Promise<HarnessTurn> {
        startTurnCalls.push(args.content)

        async function* stream() {
          yield {
            type: "transcript" as const,
            entry: timestamped({
              kind: "system_init",
              provider: "codex",
              model: "gpt-5.4",
              tools: [],
              agents: [],
              slashCommands: [],
              mcpServers: [],
            }),
          }
          yield {
            type: "transcript" as const,
            entry: timestamped({
              kind: "tool_call",
              tool: {
                kind: "tool",
                toolKind: "exit_plan_mode",
                toolName: "ExitPlanMode",
                toolId: "exit-1",
                input: {
                  plan: "## Plan",
                },
              },
            }),
          }
          await args.onToolRequest({
            tool: {
              kind: "tool",
              toolKind: "exit_plan_mode",
              toolName: "ExitPlanMode",
              toolId: "exit-1",
              input: {
                plan: "## Plan",
              },
            },
          })
          await interrupted
        }

        return {
          provider: "codex",
          stream: stream(),
          interrupt: async () => {
            releaseInterrupt()
          },
          close: () => {},
        }
      },
    }

    const store = createFakeStore()
    const coordinator = new AgentCoordinator({
      store: store as never,
      onStateChange: () => {},
      codexManager: fakeCodexManager as never,
    })

    await coordinator.send({
      type: "chat.send",
      chatId: "chat-1",
      provider: "codex",
      content: "plan this",
      planMode: true,
    })

    await waitFor(() => coordinator.getPendingTool("chat-1")?.toolKind === "exit_plan_mode")
    await coordinator.cancel("chat-1")

    const discardedResult = store.messages.find((entry) => entry.kind === "tool_result" && entry.toolId === "exit-1")
    expect(discardedResult).toBeDefined()
    if (!discardedResult || discardedResult.kind !== "tool_result") {
      throw new Error("missing discarded exit-plan result")
    }
    expect(discardedResult.content).toEqual({ discarded: true })
    expect(startTurnCalls).toEqual(["plan this"])
  })
})

describe("AgentCoordinator claude integration", () => {
  test("tracks analytics for new chats, queued messages, and forks", async () => {
    const events = new AsyncEventQueue<any>()
    const analyticsEvents: string[] = []
    const store = createFakeStore()
    store.chat.provider = "claude"
    store.chat.sessionToken = "session-1"

    const coordinator = new AgentCoordinator({
      store: store as never,
      analytics: {
        track: (eventName: string) => {
          analyticsEvents.push(eventName)
        },
        trackLaunch: () => {},
      },
      onStateChange: () => {},
      startClaudeSession: async () => ({
        provider: "claude",
        stream: events,
        getAccountInfo: async () => null,
        interrupt: async () => {},
        close: () => {},
        setModel: async () => {},
        setPermissionMode: async () => {},
        sendPrompt: async () => {
          events.push({
            type: "transcript" as const,
            entry: timestamped({
              kind: "result",
              subtype: "success",
              isError: false,
              durationMs: 0,
              result: "done",
            }),
          })
        },
      }),
    })

    await coordinator.send({
      type: "chat.send",
      projectId: "project-1",
      provider: "claude",
      content: "first message",
    })
    await waitFor(() => store.turnFinishedCount === 1)

    await coordinator.enqueue({
      type: "message.enqueue",
      chatId: "chat-1",
      content: "queued message",
    })

    await coordinator.forkChat("chat-1")

    expect(analyticsEvents).toEqual([
      "chat_created",
      "message_sent",
      "message_sent",
      "chat_created",
    ])

    events.close()
  })

  test("reuses a persistent Claude session across turns", async () => {
    const events = new AsyncEventQueue<any>()
    const startSessionCalls: Array<{ model: string; planMode: boolean; sessionToken: string | null }> = []
    const prompts: string[] = []

    const store = createFakeStore()
    const coordinator = new AgentCoordinator({
      store: store as never,
      onStateChange: () => {},
      startClaudeSession: async (args) => {
        startSessionCalls.push({
          model: args.model,
          planMode: args.planMode,
          sessionToken: args.sessionToken,
        })

        return {
          provider: "claude",
          stream: events,
          getAccountInfo: async () => null,
          interrupt: async () => {},
          close: () => {},
          setModel: async () => {},
          setPermissionMode: async () => {},
          sendPrompt: async (content: string) => {
            prompts.push(content)
            if (prompts.length === 1) {
              events.push({ type: "session_token" as const, sessionToken: "claude-session-1" })
              events.push({
                type: "transcript" as const,
                entry: timestamped({
                  kind: "system_init",
                  provider: "claude",
                  model: "claude-opus-4-1",
                  tools: [],
                  agents: [],
                  slashCommands: [],
                  mcpServers: [],
                }),
              })
            }
            events.push({
              type: "transcript" as const,
              entry: timestamped({
                kind: "result",
                subtype: "success",
                isError: false,
                durationMs: 0,
                result: "done",
              }),
            })
          },
        }
      },
    })

    await coordinator.send({
      type: "chat.send",
      chatId: "chat-1",
      provider: "claude",
      content: "start background task",
      model: "claude-opus-4-1",
    })
    await waitFor(() => store.turnFinishedCount === 1)

    await coordinator.send({
      type: "chat.send",
      chatId: "chat-1",
      provider: "claude",
      content: "check task output",
      model: "claude-opus-4-1",
    })
    await waitFor(() => store.turnFinishedCount === 2)

    expect(startSessionCalls).toHaveLength(1)
    expect(startSessionCalls[0]?.planMode).toBe(false)
    expect(startSessionCalls[0]?.sessionToken).toBeNull()
    expect(prompts).toEqual(["start background task", "check task output"])
    expect(store.chat.sessionToken).toBe("claude-session-1")

    events.close()
  })

  test("passes Claude fast mode as a service tier and toggles it mid-session", async () => {
    const events = new AsyncEventQueue<any>()
    const startSessionCalls: Array<{ serviceTier?: string }> = []
    const fastModeCalls: boolean[] = []

    const store = createFakeStore()
    const coordinator = new AgentCoordinator({
      store: store as never,
      onStateChange: () => {},
      startClaudeSession: async (args) => {
        startSessionCalls.push({ serviceTier: args.serviceTier })

        return {
          provider: "claude",
          stream: events,
          getAccountInfo: async () => null,
          interrupt: async () => {},
          close: () => {},
          setModel: async () => {},
          setPermissionMode: async () => {},
          setFastMode: async (fastMode: boolean) => {
            fastModeCalls.push(fastMode)
          },
          sendPrompt: async () => {
            events.push({
              type: "transcript" as const,
              entry: timestamped({
                kind: "result",
                subtype: "success",
                isError: false,
                durationMs: 0,
                result: "done",
              }),
            })
          },
        }
      },
    })

    await coordinator.send({
      type: "chat.send",
      chatId: "chat-1",
      provider: "claude",
      content: "go fast",
      model: "claude-opus-4-8",
      modelOptions: { claude: { fastMode: true } },
    })
    await waitFor(() => store.turnFinishedCount === 1)

    await coordinator.send({
      type: "chat.send",
      chatId: "chat-1",
      provider: "claude",
      content: "back to standard",
      model: "claude-opus-4-8",
      modelOptions: { claude: { fastMode: false } },
    })
    await waitFor(() => store.turnFinishedCount === 2)

    expect(startSessionCalls).toEqual([{ serviceTier: "fast" }])
    expect(fastModeCalls).toEqual([false])

    events.close()
  })


  test("does not glue a failed first Claude prompt into the next send", async () => {
    const events = new AsyncEventQueue<any>()
    const prompts: string[] = []
    let startAttempts = 0

    const store = createFakeStore()
    const coordinator = new AgentCoordinator({
      store: store as never,
      onStateChange: () => {},
      startClaudeSession: async () => {
        startAttempts += 1
        if (startAttempts === 1) {
          throw new Error("Claude boot failed")
        }

        return {
          provider: "claude",
          stream: events,
          getAccountInfo: async () => null,
          interrupt: async () => {},
          close: () => {},
          setModel: async () => {},
          setPermissionMode: async () => {},
          sendPrompt: async (content: string) => {
            prompts.push(content)
            events.push({ type: "session_token" as const, sessionToken: "claude-session-1" })
            events.push({
              type: "transcript" as const,
              entry: timestamped({
                kind: "result",
                subtype: "success",
                isError: false,
                durationMs: 0,
                result: "done",
              }),
            })
          },
        }
      },
    })

    await expect(coordinator.send({
      type: "chat.send",
      chatId: "chat-1",
      provider: "claude",
      content: "failed first prompt",
      model: "claude-opus-4-1",
    })).rejects.toThrow("Claude boot failed")

    await coordinator.send({
      type: "chat.send",
      chatId: "chat-1",
      provider: "claude",
      content: "fresh second prompt",
      model: "claude-opus-4-1",
    })
    await waitFor(() => store.turnFinishedCount === 1)

    expect(prompts).toEqual(["fresh second prompt"])
    expect(store.messages.filter((entry) => entry.kind === "user_prompt").map((entry) => entry.content)).toEqual([
      "failed first prompt",
      "fresh second prompt",
    ])
    expect(store.chat.pendingForkUserPrompt).toBe(false)

    events.close()
  })

  test("Claude final results clear running state without using draining mode", async () => {
    const events = new AsyncEventQueue<any>()

    const store = createFakeStore()
    const coordinator = new AgentCoordinator({
      store: store as never,
      onStateChange: () => {},
      startClaudeSession: async () => ({
        provider: "claude",
        stream: events,
        getAccountInfo: async () => null,
        interrupt: async () => {},
        close: () => {},
        setModel: async () => {},
        setPermissionMode: async () => {},
        sendPrompt: async () => {
          events.push({
            type: "transcript" as const,
            entry: timestamped({
              kind: "system_init",
              provider: "claude",
              model: "claude-opus-4-1",
              tools: [],
              agents: [],
              slashCommands: [],
              mcpServers: [],
            }),
          })
          events.push({
            type: "transcript" as const,
            entry: timestamped({
              kind: "result",
              subtype: "success",
              isError: false,
              durationMs: 0,
              result: "done",
            }),
          })
        },
      }),
    })

    await coordinator.send({
      type: "chat.send",
      chatId: "chat-1",
      provider: "claude",
      content: "run something",
      model: "claude-opus-4-1",
    })

    await waitFor(() => store.turnFinishedCount === 1)
    expect(coordinator.getActiveStatuses().has("chat-1")).toBe(false)
    expect(coordinator.getDrainingChatIds().has("chat-1")).toBe(false)

    events.close()
  })

  test("Claude steer interrupts the active run and immediately sends the steered message", async () => {
    const events = new AsyncEventQueue<any>()
    const prompts: string[] = []

    const store = createFakeStore()
    await store.enqueueMessage("chat-1", {
      id: "queued-1",
      content: "queued follow up",
      attachments: [],
      provider: "claude",
      model: "claude-opus-4-1",
      planMode: false,
    })

    const coordinator = new AgentCoordinator({
      store: store as never,
      onStateChange: () => {},
      startClaudeSession: async () => ({
        provider: "claude",
        stream: events,
        getAccountInfo: async () => null,
        interrupt: async () => {},
        close: () => {},
        setModel: async () => {},
        setPermissionMode: async () => {},
        sendPrompt: async (content: string) => {
          prompts.push(content)
        },
      }),
    })

    await coordinator.send({
      type: "chat.send",
      chatId: "chat-1",
      provider: "claude",
      content: "first prompt",
      model: "claude-opus-4-1",
    })

    expect(prompts).toEqual(["first prompt"])
    await coordinator.steer({
      type: "message.steer",
      chatId: "chat-1",
      queuedMessageId: "queued-1",
    })

    expect(prompts).toHaveLength(2)
    expect(prompts[0]).toEqual("first prompt")
    expect(prompts[1]).toContain("queued follow up")
    expect(prompts[1]).toContain("<system-message>")
    expect(prompts[1]).toContain("</system-message>")
    expect(store.messages.some((entry) => entry.kind === "interrupted")).toBe(true)

    events.push({
      type: "transcript" as const,
      entry: timestamped({
        kind: "interrupted",
      }),
    })
    expect(coordinator.getActiveStatuses().get("chat-1")).toBe("running")

    events.close()
  })

  test("escape mid-turn does not surface the SDK's interrupt error result", async () => {
    const events = new AsyncEventQueue<any>()
    const store = createFakeStore()

    const coordinator = new AgentCoordinator({
      store: store as never,
      onStateChange: () => {},
      startClaudeSession: async () => ({
        provider: "claude",
        stream: events,
        getAccountInfo: async () => null,
        interrupt: async () => {},
        close: () => {},
        setModel: async () => {},
        setPermissionMode: async () => {},
        sendPrompt: async () => {},
      }),
    })

    await coordinator.send({
      type: "chat.send",
      chatId: "chat-1",
      provider: "claude",
      content: "do something slow",
      model: "claude-opus-4-1",
    })

    await coordinator.cancel("chat-1")
    expect(store.messages.some((entry) => entry.kind === "interrupted")).toBe(true)

    // The SDK reports the interrupt as an error result with no text.
    events.push({
      type: "transcript" as const,
      entry: timestamped({
        kind: "result",
        subtype: "error",
        isError: true,
        durationMs: 0,
        result: "",
      }),
    })
    // A later, genuine error result (after the cancel settled) still surfaces.
    events.push({
      type: "transcript" as const,
      entry: timestamped({
        kind: "result",
        subtype: "error",
        isError: true,
        durationMs: 0,
        result: "real failure",
      }),
    })

    await waitFor(() =>
      store.messages.some((entry) => entry.kind === "result" && entry.result === "real failure")
    )
    const errorResults = store.messages.filter((entry) => entry.kind === "result" && entry.isError)
    expect(errorResults).toHaveLength(1)

    events.close()
  })

  test("force-sending a queued message does not surface the cancelled prompt's error result", async () => {
    const events = new AsyncEventQueue<any>()
    const store = createFakeStore()
    await store.enqueueMessage("chat-1", {
      id: "queued-1",
      content: "queued follow up",
      attachments: [],
      provider: "claude",
      model: "claude-opus-4-1",
      planMode: false,
    })

    const coordinator = new AgentCoordinator({
      store: store as never,
      onStateChange: () => {},
      startClaudeSession: async () => ({
        provider: "claude",
        stream: events,
        getAccountInfo: async () => null,
        interrupt: async () => {},
        close: () => {},
        setModel: async () => {},
        setPermissionMode: async () => {},
        sendPrompt: async () => {},
      }),
    })

    await coordinator.send({
      type: "chat.send",
      chatId: "chat-1",
      provider: "claude",
      content: "first prompt",
      model: "claude-opus-4-1",
    })

    // Force send: cancels the active prompt and immediately sends the queued
    // one, which clears suppressResume before the interrupt error lands.
    await coordinator.steer({
      type: "message.steer",
      chatId: "chat-1",
      queuedMessageId: "queued-1",
    })

    // SDK reports the interrupt of prompt 1 as an empty error result.
    events.push({
      type: "transcript" as const,
      entry: timestamped({
        kind: "result",
        subtype: "error",
        isError: true,
        durationMs: 0,
        result: "",
      }),
    })
    // The steered prompt (seq 2) then completes normally.
    events.push({
      type: "transcript" as const,
      entry: timestamped({
        kind: "result",
        subtype: "success",
        isError: false,
        durationMs: 0,
        result: "done",
      }),
    })

    await waitFor(() => store.turnFinishedCount === 1)
    expect(store.messages.some((entry) => entry.kind === "result" && entry.isError)).toBe(false)
    expect(store.messages.some((entry) => entry.kind === "result" && entry.result === "done")).toBe(true)

    events.close()
  })


  test("keeps an edited Claude turn active when the stopped session stream closes late", async () => {
    const oldEvents = new AsyncEventQueue<any>()
    const editedEvents = new AsyncEventQueue<any>()
    const prompts: Array<{ sessionIndex: number; content: string }> = []
    let sessionIndex = 0
    let resolveOldStreamCleanup!: () => void
    const oldStreamCleanup = new Promise<void>((resolve) => {
      resolveOldStreamCleanup = resolve
    })
    const oldStream = {
      async *[Symbol.asyncIterator]() {
        try {
          yield* oldEvents
        } finally {
          setTimeout(resolveOldStreamCleanup, 0)
        }
      },
    }

    const store = createFakeStore()
    const coordinator = new AgentCoordinator({
      store: store as never,
      onStateChange: () => {},
      startClaudeSession: async () => {
        const currentSessionIndex = sessionIndex++
        const events = currentSessionIndex === 0 ? oldStream : editedEvents
        return {
          provider: "claude",
          stream: events,
          getAccountInfo: async () => null,
          interrupt: async () => {},
          close: () => {},
          setModel: async () => {},
          setPermissionMode: async () => {},
          sendPrompt: async (content: string) => {
            prompts.push({ sessionIndex: currentSessionIndex, content })
          },
        }
      },
    })

    await coordinator.send({
      type: "chat.send",
      chatId: "chat-1",
      provider: "claude",
      content: "original prompt",
      model: "claude-opus-4-1",
    })
    const originalPrompt = store.messages.find((entry) => entry.kind === "user_prompt")
    expect(originalPrompt).toBeDefined()

    await coordinator.cancel("chat-1")
    await coordinator.editUserPrompt({
      type: "chat.editUserPrompt",
      chatId: "chat-1",
      messageId: originalPrompt!._id,
      content: "edited prompt",
    })

    expect(prompts).toEqual([
      { sessionIndex: 0, content: "original prompt" },
      { sessionIndex: 1, content: "edited prompt" },
    ])
    expect(coordinator.getActiveStatuses().get("chat-1")).toBe("running")

    oldEvents.push({
      type: "transcript" as const,
      entry: timestamped({
        kind: "assistant_text",
        messageId: "stale-assistant-message",
        text: "stale answer",
      }),
    })
    oldEvents.close()
    await oldStreamCleanup

    try {
      expect(store.messages.some((entry) => entry.kind === "assistant_text" && entry.text === "stale answer")).toBe(false)
      expect(coordinator.getActiveStatuses().get("chat-1")).toBe("running")
    } finally {
      editedEvents.close()
    }
  })

  test("uses Claude forkSession when starting a forked chat", async () => {
    const startSessionCalls: Array<{ sessionToken: string | null; forkSession: boolean }> = []
    const events = new AsyncEventQueue<any>()
    const store = createFakeStore()
    store.chat.provider = "claude"
    store.chat.pendingForkSessionToken = "claude-parent-1"

    const coordinator = new AgentCoordinator({
      store: store as never,
      onStateChange: () => {},
      startClaudeSession: async (args) => {
        startSessionCalls.push({
          sessionToken: args.sessionToken,
          forkSession: args.forkSession,
        })

        return {
          provider: "claude",
          stream: events,
          getAccountInfo: async () => null,
          interrupt: async () => {},
          close: () => {},
          setModel: async () => {},
          setPermissionMode: async () => {},
          sendPrompt: async () => {
            events.push({ type: "session_token" as const, sessionToken: "claude-fork-1" })
            events.push({
              type: "transcript" as const,
              entry: timestamped({
                kind: "system_init",
                provider: "claude",
                model: "claude-opus-4-1",
                tools: [],
                agents: [],
                slashCommands: [],
                mcpServers: [],
              }),
            })
            events.push({
              type: "transcript" as const,
              entry: timestamped({
                kind: "result",
                subtype: "success",
                isError: false,
                durationMs: 0,
                result: "done",
              }),
            })
          },
        }
      },
    })

    await coordinator.send({
      type: "chat.send",
      chatId: "chat-1",
      provider: "claude",
      content: "branch this",
      model: "claude-opus-4-1",
    })

    await waitFor(() => store.turnFinishedCount === 1)

    expect(startSessionCalls).toEqual([{
      sessionToken: "claude-parent-1",
      forkSession: true,
    }])
    expect(store.chat.pendingForkSessionToken).toBeNull()
    events.close()
  })

  test("edits a Claude user prompt by forking at the previous assistant message", async () => {
    const startSessionCalls: Array<{
      sessionToken: string | null
      forkSession: boolean
      resumeSessionAt?: string
    }> = []
    const prompts: string[] = []
    const events = new AsyncEventQueue<any>()
    const store = createFakeStore()
    store.chat.provider = "claude"
    store.chat.sessionToken = "claude-session-1"
    const firstPrompt = timestamped({ kind: "user_prompt", content: "original task" })
    const assistant = timestamped({ kind: "assistant_text", messageId: "assistant-msg-1", text: "first answer" })
    const secondPrompt = timestamped({ kind: "user_prompt", content: "follow-up" })
    store.messages = [
      firstPrompt,
      assistant,
      timestamped({ kind: "result", subtype: "success", isError: false, durationMs: 0, result: "done" }),
      secondPrompt,
      timestamped({ kind: "assistant_text", messageId: "assistant-msg-2", text: "second answer" }),
      timestamped({ kind: "result", subtype: "success", isError: false, durationMs: 0, result: "done" }),
    ]

    const coordinator = new AgentCoordinator({
      store: store as never,
      onStateChange: () => {},
      startClaudeSession: async (args) => {
        startSessionCalls.push({
          sessionToken: args.sessionToken,
          forkSession: args.forkSession,
          resumeSessionAt: args.resumeSessionAt,
        })

        return {
          provider: "claude",
          stream: events,
          getAccountInfo: async () => null,
          interrupt: async () => {},
          close: () => {},
          setModel: async () => {},
          setPermissionMode: async () => {},
          sendPrompt: async (content: string) => {
            prompts.push(content)
            events.push({ type: "session_token" as const, sessionToken: "claude-edited-session" })
            events.push({
              type: "transcript" as const,
              entry: timestamped({
                kind: "result",
                subtype: "success",
                isError: false,
                durationMs: 0,
                result: "done",
              }),
            })
          },
        }
      },
    })

    await coordinator.editUserPrompt({
      type: "chat.editUserPrompt",
      chatId: "chat-1",
      messageId: secondPrompt._id,
      content: "edited follow-up",
    })

    await waitFor(() => store.turnFinishedCount === 1)

    expect(startSessionCalls).toEqual([{
      sessionToken: "claude-session-1",
      forkSession: false,
      resumeSessionAt: undefined,
    }])
    expect(prompts).toEqual(["edited follow-up"])
    expect(store.chat.sessionToken).toBe("claude-edited-session")
    expect(store.messages.map((entry) => entry.kind)).toEqual(["user_prompt", "assistant_text", "result", "user_prompt", "result"])
    expect(store.messages[3]).toMatchObject({ kind: "user_prompt", content: "edited follow-up" })

    events.close()
  })

  test("edits a Claude prompt by resuming at the last main-session message before sidechain work", async () => {
    const prepareSessionCalls: Array<{
      localPath: string
      sessionToken: string
      resumeSessionAt: string
    }> = []
    const startSessionCalls: Array<{
      sessionToken: string | null
      forkSession: boolean
      resumeSessionAt?: string
    }> = []
    const prompts: string[] = []
    const events = new AsyncEventQueue<any>()
    const store = createFakeStore()
    store.chat.provider = "claude"
    store.chat.sessionToken = "claude-session-1"
    const firstPrompt = timestamped({ kind: "user_prompt", content: "original task" })
    const mainSessionTask = timestamped({
      kind: "tool_call",
      messageId: "main-task-msg",
      tool: {
        kind: "tool",
        toolKind: "subagent_task",
        toolName: "Task",
        toolId: "toolu_task",
        input: { subagentType: "Plan" },
        rawInput: { subagent_type: "Plan" },
      },
      debugRaw: JSON.stringify({
        type: "assistant",
        uuid: "main-task-msg",
        parent_tool_use_id: null,
      }),
    })
    const sidechainTool = timestamped({
      kind: "tool_call",
      messageId: "sidechain-grep-msg",
      tool: {
        kind: "tool",
        toolKind: "grep",
        toolName: "Grep",
        toolId: "toolu_grep",
        input: { pattern: "source" },
        rawInput: { pattern: "source" },
      },
      debugRaw: JSON.stringify({
        type: "assistant",
        uuid: "sidechain-grep-msg",
        parent_tool_use_id: "toolu_task",
        subagent_type: "Plan",
      }),
    })
    const secondPrompt = timestamped({ kind: "user_prompt", content: "follow-up" })
    store.messages = [
      firstPrompt,
      mainSessionTask,
      timestamped({
        kind: "tool_result",
        messageId: "main-task-result",
        toolId: "toolu_task",
        content: "subagent output",
        isError: false,
      }),
      sidechainTool,
      timestamped({
        kind: "tool_result",
        messageId: "sidechain-grep-result",
        toolId: "toolu_grep",
        content: "matches",
        isError: false,
        debugRaw: JSON.stringify({
          type: "user",
          uuid: "sidechain-grep-result",
          parent_tool_use_id: "toolu_task",
          subagent_type: "Plan",
        }),
      }),
      secondPrompt,
      timestamped({ kind: "assistant_text", messageId: "assistant-msg-2", text: "second answer" }),
      timestamped({ kind: "result", subtype: "success", isError: false, durationMs: 0, result: "done" }),
    ]

    const coordinator = new AgentCoordinator({
      store: store as never,
      onStateChange: () => {},
      prepareClaudeSession: async (args) => {
        prepareSessionCalls.push(args)
        return "prepared-claude-session"
      },
      startClaudeSession: async (args) => {
        startSessionCalls.push({
          sessionToken: args.sessionToken,
          forkSession: args.forkSession,
          resumeSessionAt: args.resumeSessionAt,
        })

        return {
          provider: "claude",
          stream: events,
          getAccountInfo: async () => null,
          interrupt: async () => {},
          close: () => {},
          setModel: async () => {},
          setPermissionMode: async () => {},
          sendPrompt: async (content: string) => {
            prompts.push(content)
            events.push({ type: "session_token" as const, sessionToken: "claude-edited-session" })
            events.push({
              type: "transcript" as const,
              entry: timestamped({
                kind: "result",
                subtype: "success",
                isError: false,
                durationMs: 0,
                result: "done",
              }),
            })
          },
        }
      },
    })

    await coordinator.editUserPrompt({
      type: "chat.editUserPrompt",
      chatId: "chat-1",
      messageId: secondPrompt._id,
      content: "edited follow-up",
    })

    await waitFor(() => store.turnFinishedCount === 1)

    expect(prepareSessionCalls).toEqual([{
      localPath: "/tmp/project",
      sessionToken: "claude-session-1",
      resumeSessionAt: "main-task-msg",
    }])
    expect(startSessionCalls).toEqual([{
      sessionToken: "prepared-claude-session",
      forkSession: false,
      resumeSessionAt: undefined,
    }])
    expect(prompts).toEqual(["edited follow-up"])

    events.close()
  })

  test("edits a Claude prompt using the transcript resume session when chat state holds a failed fork token", async () => {
    const prepareSessionCalls: Array<{
      localPath: string
      sessionToken: string
      resumeSessionAt: string
    }> = []
    const startSessionCalls: Array<{
      sessionToken: string | null
      forkSession: boolean
      resumeSessionAt?: string
    }> = []
    const prompts: string[] = []
    const events = new AsyncEventQueue<any>()
    const store = createFakeStore()
    store.chat.provider = "claude"
    store.chat.sessionToken = "failed-fork-session"
    const firstPrompt = timestamped({ kind: "user_prompt", content: "original task" })
    const assistant = timestamped({
      kind: "assistant_text",
      messageId: "assistant-msg-1",
      text: "first answer",
      debugRaw: JSON.stringify({
        type: "assistant",
        uuid: "assistant-msg-1",
        session_id: "claude-session-1",
      }),
    })
    const secondPrompt = timestamped({ kind: "user_prompt", content: "follow-up" })
    store.messages = [
      firstPrompt,
      assistant,
      timestamped({ kind: "result", subtype: "success", isError: false, durationMs: 0, result: "done" }),
      secondPrompt,
      timestamped({
        kind: "result",
        subtype: "error",
        isError: true,
        durationMs: 0,
        result: "",
        debugRaw: JSON.stringify({
          type: "result",
          subtype: "error_during_execution",
          is_error: true,
          num_turns: 0,
          session_id: "failed-fork-session",
          errors: ["No conversation found with session ID: previous-failed-fork"],
        }),
      }),
    ]

    const coordinator = new AgentCoordinator({
      store: store as never,
      onStateChange: () => {},
      prepareClaudeSession: async (args) => {
        prepareSessionCalls.push(args)
        return "prepared-claude-session"
      },
      startClaudeSession: async (args) => {
        startSessionCalls.push({
          sessionToken: args.sessionToken,
          forkSession: args.forkSession,
          resumeSessionAt: args.resumeSessionAt,
        })

        return {
          provider: "claude",
          stream: events,
          getAccountInfo: async () => null,
          interrupt: async () => {},
          close: () => {},
          setModel: async () => {},
          setPermissionMode: async () => {},
          sendPrompt: async (content: string) => {
            prompts.push(content)
            events.push({ type: "session_token" as const, sessionToken: "claude-edited-session" })
            events.push({
              type: "transcript" as const,
              entry: timestamped({
                kind: "result",
                subtype: "success",
                isError: false,
                durationMs: 0,
                result: "done",
              }),
            })
          },
        }
      },
    })

    await coordinator.editUserPrompt({
      type: "chat.editUserPrompt",
      chatId: "chat-1",
      messageId: secondPrompt._id,
      content: "edited follow-up",
    })

    await waitFor(() => store.turnFinishedCount === 1)

    expect(prepareSessionCalls).toEqual([{
      localPath: "/tmp/project",
      sessionToken: "claude-session-1",
      resumeSessionAt: "assistant-msg-1",
    }])
    expect(startSessionCalls).toEqual([{
      sessionToken: "prepared-claude-session",
      forkSession: false,
      resumeSessionAt: undefined,
    }])
    expect(prompts).toEqual(["edited follow-up"])
    expect(store.chat.sessionToken).toBe("claude-edited-session")

    events.close()
  })

  test("reuses a prepared Claude edit session after provider boot failure", async () => {
    const prepareSessionCalls: Array<{
      sessionToken: string
      resumeSessionAt: string
    }> = []
    const startSessionTokens: Array<string | null> = []
    const events = new AsyncEventQueue<any>()
    let startSessionCount = 0
    const store = createFakeStore()
    store.chat.provider = "claude"
    store.chat.sessionToken = "claude-session-current"
    const firstPrompt = timestamped({ kind: "user_prompt", content: "first task" })
    const secondPrompt = timestamped({ kind: "user_prompt", content: "second task" })
    store.messages = [
      firstPrompt,
      timestamped({
        kind: "assistant_text",
        messageId: "assistant-msg-1",
        text: "first answer",
        debugRaw: JSON.stringify({
          type: "assistant",
          uuid: "assistant-msg-1",
          session_id: "claude-session-source",
        }),
      }),
      timestamped({ kind: "result", subtype: "success", isError: false, durationMs: 0, result: "done" }),
      secondPrompt,
      timestamped({ kind: "assistant_text", messageId: "assistant-msg-2", text: "second answer" }),
      timestamped({ kind: "result", subtype: "success", isError: false, durationMs: 0, result: "done" }),
    ]

    const coordinator = new AgentCoordinator({
      store: store as never,
      onStateChange: () => {},
      prepareClaudeSession: async (args) => {
        prepareSessionCalls.push(args)
        return "prepared-claude-session"
      },
      startClaudeSession: async (args) => {
        startSessionCount += 1
        startSessionTokens.push(args.sessionToken)
        if (startSessionCount === 1) {
          throw new Error("Claude boot failed")
        }

        return {
          provider: "claude",
          stream: events,
          getAccountInfo: async () => null,
          interrupt: async () => {},
          close: () => events.close(),
          setModel: async () => {},
          setPermissionMode: async () => {},
          sendPrompt: async () => {
            events.push({ type: "session_token" as const, sessionToken: "claude-edited-session" })
            events.push({
              type: "transcript" as const,
              entry: timestamped({
                kind: "result",
                subtype: "success",
                isError: false,
                durationMs: 0,
                result: "done",
              }),
            })
          },
        }
      },
    })
    const editCommand = {
      type: "chat.editUserPrompt" as const,
      chatId: "chat-1",
      messageId: secondPrompt._id,
      content: "edited second task",
    }

    await expect(coordinator.editUserPrompt(editCommand)).rejects.toThrow("Claude boot failed")

    expect(store.chat.sessionToken).toBe("claude-session-current")

    await coordinator.editUserPrompt(editCommand)
    await waitFor(() => store.turnFinishedCount === 1)

    expect(prepareSessionCalls).toMatchObject([{
      sessionToken: "claude-session-source",
      resumeSessionAt: "assistant-msg-1",
    }])
    expect(startSessionTokens).toEqual([
      "prepared-claude-session",
      "prepared-claude-session",
    ])
    expect(store.chat.sessionToken).toBe("claude-edited-session")

    events.close()
  })

  test("edits a Claude user prompt using persisted chat model settings when the command omits them", async () => {
    const startSessionCalls: Array<{
      model: string
      effort?: string
      planMode: boolean
    }> = []
    const prompts: string[] = []
    const events = new AsyncEventQueue<any>()
    const store = createFakeStore()
    store.chat.provider = "claude"
    store.chat.sessionToken = "claude-session-1"
    store.chat.model = "claude-opus-4-8"
    store.chat.modelOptions = { claude: { reasoningEffort: "max", contextWindow: "1m" } }
    store.chat.planMode = true
    const firstPrompt = timestamped({ kind: "user_prompt", content: "original task" })
    const assistant = timestamped({ kind: "assistant_text", messageId: "assistant-msg-1", text: "first answer" })
    const secondPrompt = timestamped({ kind: "user_prompt", content: "follow-up" })
    store.messages = [
      firstPrompt,
      assistant,
      timestamped({ kind: "result", subtype: "success", isError: false, durationMs: 0, result: "done" }),
      secondPrompt,
      timestamped({ kind: "assistant_text", messageId: "assistant-msg-2", text: "second answer" }),
      timestamped({ kind: "result", subtype: "success", isError: false, durationMs: 0, result: "done" }),
    ]

    const coordinator = new AgentCoordinator({
      store: store as never,
      onStateChange: () => {},
      startClaudeSession: async (args) => {
        startSessionCalls.push({
          model: args.model,
          effort: args.effort,
          planMode: args.planMode,
        })

        return {
          provider: "claude",
          stream: events,
          getAccountInfo: async () => null,
          interrupt: async () => {},
          close: () => {},
          setModel: async () => {},
          setPermissionMode: async () => {},
          sendPrompt: async (content: string) => {
            prompts.push(content)
            events.push({ type: "session_token" as const, sessionToken: "claude-edited-session" })
            events.push({
              type: "transcript" as const,
              entry: timestamped({
                kind: "result",
                subtype: "success",
                isError: false,
                durationMs: 0,
                result: "done",
              }),
            })
          },
        }
      },
    })

    await coordinator.editUserPrompt({
      type: "chat.editUserPrompt",
      chatId: "chat-1",
      messageId: secondPrompt._id,
      content: "edited follow-up",
    })

    await waitFor(() => store.turnFinishedCount === 1)

    expect(startSessionCalls).toEqual([{
      model: "claude-opus-4-8[1m]",
      effort: "max",
      planMode: true,
    }])
    expect(prompts).toEqual(["edited follow-up"])

    events.close()
  })

  test("edits the first Claude user prompt out of two by starting a fresh session", async () => {
    const startSessionCalls: Array<{
      sessionToken: string | null
      forkSession: boolean
      resumeSessionAt?: string
      resetSession?: boolean
    }> = []
    const prompts: string[] = []
    const events = new AsyncEventQueue<any>()
    const store = createFakeStore()
    store.chat.provider = "claude"
    store.chat.sessionToken = "claude-session-1"
    const firstPrompt = timestamped({ kind: "user_prompt", content: "first task" })
    const secondPrompt = timestamped({ kind: "user_prompt", content: "second task" })
    store.messages = [
      firstPrompt,
      timestamped({ kind: "assistant_text", messageId: "assistant-msg-1", text: "first answer" }),
      timestamped({ kind: "result", subtype: "success", isError: false, durationMs: 0, result: "done" }),
      secondPrompt,
      timestamped({ kind: "assistant_text", messageId: "assistant-msg-2", text: "second answer" }),
      timestamped({ kind: "result", subtype: "success", isError: false, durationMs: 0, result: "done" }),
    ]

    const coordinator = new AgentCoordinator({
      store: store as never,
      onStateChange: () => {},
      startClaudeSession: async (args) => {
        startSessionCalls.push({
          sessionToken: args.sessionToken,
          forkSession: args.forkSession,
          resumeSessionAt: args.resumeSessionAt,
          resetSession: args.resetSession,
        })

        return {
          provider: "claude",
          stream: events,
          getAccountInfo: async () => null,
          interrupt: async () => {},
          close: () => {},
          setModel: async () => {},
          setPermissionMode: async () => {},
          sendPrompt: async (content: string) => {
            prompts.push(content)
            events.push({ type: "session_token" as const, sessionToken: "claude-edited-session" })
            events.push({
              type: "transcript" as const,
              entry: timestamped({
                kind: "result",
                subtype: "success",
                isError: false,
                durationMs: 0,
                result: "done",
              }),
            })
          },
        }
      },
    })

    await coordinator.editUserPrompt({
      type: "chat.editUserPrompt",
      chatId: "chat-1",
      messageId: firstPrompt._id,
      content: "edited first task",
    })

    await waitFor(() => store.turnFinishedCount === 1)

    expect(startSessionCalls).toEqual([{
      sessionToken: null,
      forkSession: false,
      resumeSessionAt: undefined,
      resetSession: true,
    }])
    expect(prompts).toEqual(["edited first task"])
    expect(store.chat.sessionToken).toBe("claude-edited-session")
    expect(store.messages.map((entry) => entry.kind)).toEqual(["user_prompt", "result"])
    expect(store.messages[0]).toMatchObject({ kind: "user_prompt", content: "edited first task" })
    expect(store.messages.some((entry) => entry.kind === "user_prompt" && entry.content === "second task")).toBe(false)

    events.close()
  })

  test("keeps Claude history when editing the first prompt fails before provider start", async () => {
    const store = createFakeStore()
    store.chat.provider = "claude"
    store.chat.sessionToken = "claude-session-1"
    const firstPrompt = timestamped({ kind: "user_prompt", content: "first task" })
    const secondPrompt = timestamped({ kind: "user_prompt", content: "second task" })
    store.messages = [
      firstPrompt,
      timestamped({ kind: "assistant_text", messageId: "assistant-msg-1", text: "first answer" }),
      timestamped({ kind: "result", subtype: "success", isError: false, durationMs: 0, result: "done" }),
      secondPrompt,
      timestamped({ kind: "assistant_text", messageId: "assistant-msg-2", text: "second answer" }),
      timestamped({ kind: "result", subtype: "success", isError: false, durationMs: 0, result: "done" }),
    ]
    const originalMessages = [...store.messages]

    const coordinator = new AgentCoordinator({
      store: store as never,
      onStateChange: () => {},
      startClaudeSession: async () => {
        throw new Error("Claude boot failed")
      },
    })

    await expect(coordinator.editUserPrompt({
      type: "chat.editUserPrompt",
      chatId: "chat-1",
      messageId: firstPrompt._id,
      content: "edited first task",
    })).rejects.toThrow("Claude boot failed")

    expect(store.messages).toEqual(originalMessages)
  })

  test("retries a Claude edit from the source session after a fork fails during provider execution", async () => {
    const startSessionCalls: Array<{
      sessionToken: string | null
      forkSession: boolean
      resumeSessionAt?: string
    }> = []
    const prompts: string[] = []
    const queues: AsyncEventQueue<any>[] = []
    let turnFailedCount = 0
    const store = createFakeStore()
    store.recordTurnFailed = async () => {
      turnFailedCount += 1
    }
    store.chat.provider = "claude"
    store.chat.sessionToken = "claude-session-1"
    const firstPrompt = timestamped({ kind: "user_prompt", content: "first task" })
    const secondPrompt = timestamped({ kind: "user_prompt", content: "second task" })
    store.messages = [
      firstPrompt,
      timestamped({ kind: "assistant_text", messageId: "assistant-msg-1", text: "first answer" }),
      timestamped({ kind: "result", subtype: "success", isError: false, durationMs: 0, result: "done" }),
      secondPrompt,
      timestamped({ kind: "assistant_text", messageId: "assistant-msg-2", text: "second answer" }),
      timestamped({ kind: "result", subtype: "success", isError: false, durationMs: 0, result: "done" }),
    ]

    const coordinator = new AgentCoordinator({
      store: store as never,
      onStateChange: () => {},
      startClaudeSession: async (args) => {
        startSessionCalls.push({
          sessionToken: args.sessionToken,
          forkSession: args.forkSession,
          resumeSessionAt: args.resumeSessionAt,
        })
        const queue = new AsyncEventQueue<any>()
        queues.push(queue)
        const sessionIndex = queues.length

        return {
          provider: "claude",
          stream: queue,
          getAccountInfo: async () => null,
          interrupt: async () => {},
          close: () => queue.close(),
          setModel: async () => {},
          setPermissionMode: async () => {},
          sendPrompt: async (content: string) => {
            prompts.push(content)
            if (sessionIndex === 1) {
              queue.push({ type: "session_token" as const, sessionToken: "failed-fork-session" })
              queue.push({
                type: "transcript" as const,
                entry: timestamped({
                  kind: "result",
                  subtype: "error",
                  isError: true,
                  durationMs: 0,
                  result: "",
                  debugRaw: JSON.stringify({
                    type: "result",
                    subtype: "error_during_execution",
                    is_error: true,
                    num_turns: 0,
                    session_id: "failed-fork-session",
                    errors: ["No message found with message.uuid of: bad-resume-point"],
                  }),
                }),
              })
              return
            }

            queue.push({ type: "session_token" as const, sessionToken: "claude-edited-session" })
            queue.push({
              type: "transcript" as const,
              entry: timestamped({
                kind: "result",
                subtype: "success",
                isError: false,
                durationMs: 0,
                result: "done",
              }),
            })
          },
        }
      },
    })

    await coordinator.editUserPrompt({
      type: "chat.editUserPrompt",
      chatId: "chat-1",
      messageId: secondPrompt._id,
      content: "edited once",
    })

    await waitFor(() => turnFailedCount === 1)
    expect(store.chat.sessionToken).toBe("claude-session-1")

    const editedPrompt = store.messages.find((entry) => entry.kind === "user_prompt" && entry.content === "edited once")
    expect(editedPrompt?.kind).toBe("user_prompt")
    if (!editedPrompt || editedPrompt.kind !== "user_prompt") throw new Error("missing edited prompt")

    await coordinator.editUserPrompt({
      type: "chat.editUserPrompt",
      chatId: "chat-1",
      messageId: editedPrompt._id,
      content: "edited twice",
    })

    await waitFor(() => store.turnFinishedCount === 1)

    expect(startSessionCalls).toEqual([
      {
        sessionToken: "claude-session-1",
        forkSession: false,
        resumeSessionAt: undefined,
      },
      {
        sessionToken: "claude-session-1",
        forkSession: false,
        resumeSessionAt: undefined,
      },
    ])
    expect(prompts).toEqual(["edited once", "edited twice"])
    expect(store.chat.sessionToken).toBe("claude-edited-session")

    for (const queue of queues) {
      queue.close()
    }
  })

  test("edits the second Claude user prompt out of three and discards later turns", async () => {
    const startSessionCalls: Array<{
      sessionToken: string | null
      forkSession: boolean
      resumeSessionAt?: string
      resetSession?: boolean
    }> = []
    const prompts: string[] = []
    const events = new AsyncEventQueue<any>()
    const store = createFakeStore()
    store.chat.provider = "claude"
    store.chat.sessionToken = "claude-session-1"
    const firstPrompt = timestamped({ kind: "user_prompt", content: "first task" })
    const secondPrompt = timestamped({ kind: "user_prompt", content: "second task" })
    const thirdPrompt = timestamped({ kind: "user_prompt", content: "third task" })
    store.messages = [
      firstPrompt,
      timestamped({ kind: "assistant_text", messageId: "assistant-msg-1", text: "first answer" }),
      timestamped({ kind: "result", subtype: "success", isError: false, durationMs: 0, result: "done" }),
      secondPrompt,
      timestamped({ kind: "assistant_text", messageId: "assistant-msg-2", text: "second answer" }),
      timestamped({ kind: "result", subtype: "success", isError: false, durationMs: 0, result: "done" }),
      thirdPrompt,
      timestamped({ kind: "assistant_text", messageId: "assistant-msg-3", text: "third answer" }),
      timestamped({ kind: "result", subtype: "success", isError: false, durationMs: 0, result: "done" }),
    ]

    const coordinator = new AgentCoordinator({
      store: store as never,
      onStateChange: () => {},
      startClaudeSession: async (args) => {
        startSessionCalls.push({
          sessionToken: args.sessionToken,
          forkSession: args.forkSession,
          resumeSessionAt: args.resumeSessionAt,
          resetSession: args.resetSession,
        })

        return {
          provider: "claude",
          stream: events,
          getAccountInfo: async () => null,
          interrupt: async () => {},
          close: () => {},
          setModel: async () => {},
          setPermissionMode: async () => {},
          sendPrompt: async (content: string) => {
            prompts.push(content)
            events.push({ type: "session_token" as const, sessionToken: "claude-edited-session" })
            events.push({
              type: "transcript" as const,
              entry: timestamped({
                kind: "result",
                subtype: "success",
                isError: false,
                durationMs: 0,
                result: "done",
              }),
            })
          },
        }
      },
    })

    await coordinator.editUserPrompt({
      type: "chat.editUserPrompt",
      chatId: "chat-1",
      messageId: secondPrompt._id,
      content: "edited second task",
    })

    await waitFor(() => store.turnFinishedCount === 1)

    expect(startSessionCalls).toEqual([{
      sessionToken: "claude-session-1",
      forkSession: false,
      resumeSessionAt: undefined,
      resetSession: true,
    }])
    expect(prompts).toEqual(["edited second task"])
    expect(store.chat.sessionToken).toBe("claude-edited-session")
    expect(store.messages.map((entry) => entry.kind)).toEqual(["user_prompt", "assistant_text", "result", "user_prompt", "result"])
    expect(store.messages[0]).toBe(firstPrompt)
    expect(store.messages[3]).toMatchObject({ kind: "user_prompt", content: "edited second task" })
    expect(store.messages.some((entry) => entry.kind === "user_prompt" && entry.content === "third task")).toBe(false)

    events.close()
  })
})

function createFakeStore() {
  const chat = {
    id: "chat-1",
    projectId: "project-1",
    title: "New Chat",
    provider: null as "claude" | "codex" | null,
    model: null as string | null,
    modelOptions: null as any,
    planMode: false,
    sessionToken: null as string | null,
    pendingForkSessionToken: null as string | null,
    pendingForkResumeAt: null as string | null,
    pendingForkUserPrompt: false,
  }
  const project = {
    id: "project-1",
    localPath: "/tmp/project",
  }
  return {
    chat,
    turnFinishedCount: 0,
    messages: [] as TranscriptEntry[],
    queuedMessages: [] as any[],
    requireChat(chatId: string) {
      expect(chatId).toBe("chat-1")
      return chat
    },
    getChat(chatId: string) {
      expect(chatId).toBe("chat-1")
      return chat
    },
    getProject(projectId: string) {
      expect(projectId).toBe("project-1")
      return project
    },
    getMessages() {
      return this.messages
    },
    async setChatProvider(_chatId: string, provider: "claude" | "codex") {
      chat.provider = provider
    },
    async setPlanMode(_chatId: string, planMode: boolean) {
      chat.planMode = planMode
    },
    async setChatModelSettings(_chatId: string, settings: { model: string | null; modelOptions: any }) {
      chat.model = settings.model
      chat.modelOptions = settings.modelOptions
    },
    async renameChat(_chatId: string, title: string) {
      chat.title = title
    },
    async appendMessage(_chatId: string, entry: TranscriptEntry) {
      this.messages.push(entry)
    },
    async replaceTranscript(_chatId: string, entries: TranscriptEntry[]) {
      this.messages = [...entries]
    },
    async recordTurnStarted() {},
    async recordTurnFinished() {
      this.turnFinishedCount += 1
    },
    async recordTurnFailed(): Promise<void> {
      throw new Error("Did not expect turn failure")
    },
    async recordTurnCancelled() {},
    async setSessionToken(_chatId: string, sessionToken: string | null) {
      chat.sessionToken = sessionToken
    },
    async setPendingForkSessionToken(_chatId: string, pendingForkSessionToken: string | null) {
      chat.pendingForkSessionToken = pendingForkSessionToken
    },
    async setPendingForkResumeAt(_chatId: string, pendingForkResumeAt: string | null) {
      chat.pendingForkResumeAt = pendingForkResumeAt
    },
    async setPendingForkUserPrompt(_chatId: string, pendingForkUserPrompt: boolean) {
      chat.pendingForkUserPrompt = pendingForkUserPrompt
    },
    async createChat() {
      return chat
    },
    async forkChat() {
      return {
        ...chat,
        id: "chat-fork-1",
        title: "New Chat (forked)",
        sessionToken: null,
        pendingForkSessionToken: chat.sessionToken ?? chat.pendingForkSessionToken,
        pendingForkResumeAt: chat.pendingForkResumeAt,
        pendingForkUserPrompt: false,
      }
    },
    async enqueueMessage(_chatId: string, message: any) {
      const queuedMessage = {
        id: message.id ?? crypto.randomUUID(),
        content: message.content,
        attachments: message.attachments ?? [],
        createdAt: message.createdAt ?? Date.now(),
        provider: message.provider,
        model: message.model,
        modelOptions: message.modelOptions,
        planMode: message.planMode,
      }
      this.queuedMessages.push(queuedMessage)
      return queuedMessage
    },
    getQueuedMessages() {
      return [...this.queuedMessages]
    },
    getQueuedMessage(_chatId: string, queuedMessageId: string) {
      return this.queuedMessages.find((entry) => entry.id === queuedMessageId) ?? null
    },
    async removeQueuedMessage(_chatId: string, queuedMessageId: string) {
      this.queuedMessages = this.queuedMessages.filter((entry) => entry.id !== queuedMessageId)
    },
  }
}

function createForkableFakeStore(
  provider: "claude" | "codex",
  options: { title: string; sessionToken: string | null; pendingForkSessionToken?: string | null }
) {
  const sourceChat = {
    id: "chat-1",
    projectId: "project-1",
    title: options.title,
    provider,
    model: null as string | null,
    modelOptions: null as any,
    planMode: false,
    sessionToken: options.sessionToken,
    pendingForkSessionToken: options.pendingForkSessionToken ?? null,
    pendingForkResumeAt: null as string | null,
    pendingForkUserPrompt: false,
  }
  const project = {
    id: "project-1",
    localPath: "/tmp/project",
  }
  const chatsById = new Map<string, typeof sourceChat>([["chat-1", sourceChat]])
  const messagesByChatId = new Map<string, TranscriptEntry[]>([["chat-1", []]])

  return {
    chat: sourceChat,
    turnFinishedCount: 0,
    hiddenProviderSessions: [] as Array<{
      provider: "claude" | "codex"
      sessionToken: string
    }>,
    deletedChatIds: [] as string[],
    setMessages(chatId: string, entries: TranscriptEntry[]) {
      messagesByChatId.set(chatId, [...entries])
    },
    requireChat(chatId: string) {
      const chat = chatsById.get(chatId)
      if (!chat) {
        throw new Error(`Missing chat ${chatId}`)
      }
      return chat
    },
    getChat(chatId: string) {
      return chatsById.get(chatId) ?? null
    },
    getProject(projectId: string) {
      expect(projectId).toBe("project-1")
      return project
    },
    getMessages(chatId: string) {
      return messagesByChatId.get(chatId) ?? []
    },
    async setChatProvider(chatId: string, nextProvider: "claude" | "codex") {
      this.requireChat(chatId).provider = nextProvider
    },
    async setPlanMode(chatId: string, planMode: boolean) {
      this.requireChat(chatId).planMode = planMode
    },
    async setChatModelSettings(chatId: string, settings: { model: string | null; modelOptions: any }) {
      this.requireChat(chatId).model = settings.model
      this.requireChat(chatId).modelOptions = settings.modelOptions
    },
    async renameChat(chatId: string, title: string) {
      this.requireChat(chatId).title = title
    },
    async appendMessage(chatId: string, entry: TranscriptEntry) {
      messagesByChatId.set(chatId, [...this.getMessages(chatId), entry])
    },
    async replaceTranscript(chatId: string, entries: TranscriptEntry[]) {
      messagesByChatId.set(chatId, [...entries])
    },
    async recordTurnStarted() {},
    async recordTurnFinished() {
      this.turnFinishedCount += 1
    },
    async recordTurnFailed() {
      throw new Error("Did not expect turn failure")
    },
    async recordTurnCancelled() {},
    async setSessionToken(chatId: string, sessionToken: string | null) {
      this.requireChat(chatId).sessionToken = sessionToken
    },
    async hideProviderSession(nextProvider: "claude" | "codex", sessionToken: string) {
      this.hiddenProviderSessions.push({ provider: nextProvider, sessionToken })
    },
    async setPendingForkSessionToken(chatId: string, pendingForkSessionToken: string | null) {
      this.requireChat(chatId).pendingForkSessionToken = pendingForkSessionToken
    },
    async setPendingForkResumeAt(chatId: string, pendingForkResumeAt: string | null) {
      this.requireChat(chatId).pendingForkResumeAt = pendingForkResumeAt
    },
    async setPendingForkUserPrompt(chatId: string, pendingForkUserPrompt: boolean) {
      this.requireChat(chatId).pendingForkUserPrompt = pendingForkUserPrompt
    },
    async deleteChat(chatId: string) {
      this.requireChat(chatId)
      this.deletedChatIds.push(chatId)
    },
    async forkChat(sourceChatId: string, forkOptions?: {
      transcriptEntries?: TranscriptEntry[]
      pendingForkSessionToken?: string | null
      pendingForkResumeAt?: string | null
      pendingForkUserPrompt?: boolean
    }) {
      const source = this.requireChat(sourceChatId)
      const forked = {
        ...source,
        id: "chat-fork-1",
        title: `${source.title} (forked)`,
        sessionToken: null,
        pendingForkSessionToken: forkOptions && "pendingForkSessionToken" in forkOptions
          ? forkOptions.pendingForkSessionToken ?? null
          : source.sessionToken ?? source.pendingForkSessionToken,
        pendingForkResumeAt: forkOptions?.pendingForkResumeAt ?? null,
        pendingForkUserPrompt: Boolean(forkOptions?.pendingForkUserPrompt),
      }
      chatsById.set(forked.id, forked)
      messagesByChatId.set(forked.id, [...(forkOptions?.transcriptEntries ?? this.getMessages(sourceChatId))])
      return forked
    },
    getQueuedMessages() {
      return []
    },
  }
}
