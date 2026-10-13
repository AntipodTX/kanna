import { describe, expect, test, afterAll } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { AgentCoordinator, startClaudeSession, buildAttachmentHintText, buildConcurrentAgentsNotice, buildPromptText, buildSteeredMessageContent, claudeToolset, formatQuestionAnswersFollowUp, maxClaudeContextWindowFromModelUsage, normalizeClaudeContextUsage, normalizeClaudeStreamMessage, normalizeClaudeUsageSnapshot, RESUME_AFTER_RESTART_MESSAGE, resolveClaudeRuntimeOptions, classifyClaudeBackgroundWorkState, createClaudeStopHook, type ClaudeBackgroundWorkState, buildClaudeSdkUserMessage } from "./agent"
import type { HarnessTurn } from "./harness-types"
import type { ContextRestoration } from "./events"
import type { SubagentActivityUpdate } from "./background-tasks"
import type { AgentProvider, ChatAttachment, TranscriptEntry } from "../shared/types"
import type { SessionArtifactStatus } from "./session-artifacts"
import { timestamped } from "./transcript"
import { CodexPromptHistory } from "./codex-prompt-history"
import { EventStore } from "./event-store"
import { getServerProviderCatalog } from "./provider-catalog"















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
    autoPlan: false,
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
    dataDir: fakeStoreDirectory(),
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
    getTranscriptLength(chatId: string) { return (messagesByChatId.get(chatId) ?? []).length },
    getContextBounds(chatId: string) {
      const entries = messagesByChatId.get(chatId) ?? []
      let start = 0
      entries.forEach((entry, index) => { if (entry.kind === "context_cleared") start = index + 1 })
      return { start, endExclusive: entries.length, hasConversation: entries.slice(start).some(entry => ["user_prompt", "assistant_text", "tool_call", "tool_result"].includes(entry.kind)) }
    },
    async setContextRestoration(chatId: string, restoration: any) { (this.requireChat(chatId) as any).contextRestoration = restoration },
    async acknowledgeContextRestoration(chatId: string, id: string) { const chat = this.requireChat(chatId) as any; if (chat.contextRestoration?.id === id) chat.contextRestoration = null },
    getPromptHistoryEntries(chatId:string) {return this.getMessages(chatId)},
    getEntryIdAt(chatId:string,index:number) {return (messagesByChatId.get(chatId) ?? [])[index]?._id??null},
    async setChatProvider(chatId: string, nextProvider: "claude" | "codex") {
      this.requireChat(chatId).provider = nextProvider
    },
    async setPlanMode(chatId: string, planMode: boolean) {
      this.requireChat(chatId).planMode = planMode
    },
    async setAutoPlan(chatId: string, autoPlan: boolean) {
      this.requireChat(chatId).autoPlan = autoPlan
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
        title: `Fork: ${source.title}`,
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

function fakeStoreDirectory() {
  const dir=mkdtempSync(path.join(tmpdir(),"kanna-fake-store-"))
  fakeStoreDirectories.push(dir)
  return dir
}

const fakeStoreDirectories: string[] = []

const codexStartResult = (sessionToken: string | null | undefined) => sessionToken
  ? { sessionToken, resumeFellBack: false }
  : undefined

const withChatLinks = (content: string) => content

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

describe("formatQuestionAnswersFollowUp", () => {
  test("quotes each question with its answer, keyed by id or by text", () => {
    const text = formatQuestionAnswersFollowUp(
      [
        { id: "db", question: "Which database?" },
        { question: "Add tests?" },
        { question: "Anything else?" },
      ],
      { answers: { db: ["Postgres"], "Add tests?": ["Yes", "Unit only"] } },
    )
    expect(text).toBe([
      "Here are my answers to your questions:",
      "",
      "- Which database?\n  Postgres",
      "- Add tests?\n  Yes, Unit only",
      "- Anything else?\n  (no answer)",
    ].join("\n"))
  })
})

describe("normalizeClaudeStreamMessage", () => {
  test("keeps the native session owning Claude message UUIDs", () => {
    for (const sessionField of ["session_id", "sessionId"]) {
      const entries = normalizeClaudeStreamMessage({
        type: "assistant", uuid: "answer-uuid", [sessionField]: "native-session",
        message: { content: [
          { type: "text", text: "answer" },
          { type: "tool_use", id: "tool-1", name: "Read", input: { file_path: "x" } },
        ] },
      })
      expect(entries).toHaveLength(2)
      for (const entry of entries) {
        expect(entry).toMatchObject({ messageId: "answer-uuid", claudeSessionToken: "native-session" })
      }
    }
  })
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

  test("keeps upstream prompt UUIDs on unpinned streaming Claude prompts", () => {
    expect(buildClaudeSdkUserMessage("edited task", "prompt-uuid")).toMatchObject({
      session_id: "",
      uuid: "prompt-uuid",
      message: { role: "user", content: "edited task" },
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

  test("stamps a subagent's entries with the Agent call that spawned them", () => {
    const sidechain = normalizeClaudeStreamMessage({
      type: "assistant",
      uuid: "msg-2",
      parent_tool_use_id: "agent-1",
      message: {
        content: [
          { type: "text", text: "Exploring." },
          { type: "tool_use", id: "tool-2", name: "Grep", input: { pattern: "runTurn" } },
        ],
      },
    })
    expect(sidechain).toHaveLength(2)
    expect(sidechain.every((entry) => entry.parentToolUseId === "agent-1")).toBe(true)

    const sidechainResult = normalizeClaudeStreamMessage({
      type: "user",
      uuid: "msg-3",
      parent_tool_use_id: "agent-1",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tool-2", content: "found" }] },
    })
    expect(sidechainResult[0]?.parentToolUseId).toBe("agent-1")

    // The main thread carries null there and gets no stamp at all.
    const main = normalizeClaudeStreamMessage({
      type: "assistant",
      uuid: "msg-4",
      parent_tool_use_id: null,
      message: { content: [{ type: "text", text: "Done." }] },
    })
    expect("parentToolUseId" in main[0]!).toBe(false)
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

  // debugRaw contract: raw SDK JSON is stamped ONLY on system_init, the one
  // entry with a raw JSON view. Tool results get `structuredResult` instead,
  // and only for the kinds that render it. Stamping more doubled transcript
  // size on disk (a screenshot read held its base64 twice). This test pins
  // the exact set.
  test("stamps debugRaw on system_init only and structuredResult on structured tool results", () => {
    const systemInit = {
      type: "system",
      subtype: "init",
      uuid: "sys-1",
      model: "claude-opus-4-8",
      tools: ["Bash"],
      agents: [],
      slash_commands: [],
      mcp_servers: [],
    }
    const assistant = {
      type: "assistant",
      uuid: "msg-1",
      message: {
        content: [
          { type: "text", text: "Running it now." },
          { type: "tool_use", id: "tool-1", name: "Bash", input: { command: "pwd" } },
        ],
      },
    }
    const toolResult = {
      type: "user",
      uuid: "msg-2",
      message: {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "tool-1", content: "/tmp", is_error: false },
        ],
      },
      tool_use_result: { stdout: "/tmp" },
    }
    const result = { type: "result", subtype: "success", is_error: false, duration_ms: 10, result: "done" }
    const status = { type: "system", subtype: "status", status: "compacting" }
    const compactBoundary = { type: "system", subtype: "compact_boundary" }

    const stamped = normalizeClaudeStreamMessage(systemInit)
    const unstamped = [
      ...normalizeClaudeStreamMessage(assistant),
      ...normalizeClaudeStreamMessage(toolResult),
      ...normalizeClaudeStreamMessage(result),
      ...normalizeClaudeStreamMessage(status),
      ...normalizeClaudeStreamMessage(compactBoundary),
    ]

    expect(stamped.map((entry) => entry.kind)).toEqual(["system_init"])
    expect(JSON.parse((stamped[0] as { debugRaw: string }).debugRaw)).toEqual(systemInit)

    expect(unstamped.map((entry) => entry.kind)).toEqual(["assistant_text", "tool_call", "tool_result", "result", "status", "compact_boundary"])
    for (const entry of unstamped) {
      expect(entry).not.toHaveProperty("debugRaw")
    }
    // A Bash result is not a structured kind: its tool_use_result duplicates
    // content and is dropped.
    expect(unstamped[2]).not.toHaveProperty("structuredResult")

    // A result whose call was recorded as structured keeps just that field.
    const [structured] = normalizeClaudeStreamMessage(
      { ...toolResult, tool_use_result: { approved: true } },
      { structuredToolIds: new Set(["tool-1"]) }
    )
    expect(structured).toMatchObject({ kind: "tool_result", structuredResult: { approved: true } })
    expect(structured).not.toHaveProperty("debugRaw")
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

describe("buildSteeredMessageContent", () => {
  test("prepends the steer block for plain messages", () => {
    const content = buildSteeredMessageContent("please also fix the tests")
    expect(content.startsWith("<system-message>")).toBe(true)
    expect(content.endsWith("please also fix the tests")).toBe(true)
  })

  test("appends the steer block for slash invocations so harness expansion still fires", () => {
    // claude gates slash dispatch on trim().startsWith("/") and pi on
    // startsWith("/") — a leading steer block would turn the command into
    // literal text.
    const content = buildSteeredMessageContent("/code-review src/server")
    expect(content.startsWith("/code-review src/server")).toBe(true)
    expect(content.endsWith("</system-message>")).toBe(true)
  })

  test("returns just the steer block for empty content", () => {
    expect(buildSteeredMessageContent("  ").startsWith("<system-message>")).toBe(true)
  })
})

describe("AgentCoordinator codex integration", () => {
  test("lists and executes /compact without sending prompt text", async () => {
    const slashCommandCalls: Array<{ chatId?: string; cwd: string; threadId: string; command: string }> = []
    const startedTurns: string[] = []
    const store = createFakeStore()
    store.chat.provider = "codex"
    store.chat.sessionToken = "thread-1"
    const coordinator = new AgentCoordinator({
      store: store as never,
      onStateChange: () => {},
      codexManager: {
        async listSkills() {
          return []
        },
        async runSlashCommand(args: { chatId?: string; cwd: string; threadId: string; command: string }) {
          slashCommandCalls.push(args)
        },
        async startTurn(args: { content: string }): Promise<HarnessTurn> {
          startedTurns.push(args.content)
          async function* stream() {}
          return { provider: "codex", stream: stream(), interrupt: async () => {}, close: () => {} }
        },
      } as never,
    })

    const listed = await coordinator.listSkills({ type: "chat.listSkills", provider: "codex", chatId: "chat-1" })
    expect(listed.skills).toContainEqual({
      name: "compact",
      description: "Compact the current Codex thread",
      source: "command",
    })

    await coordinator.send({ type: "chat.send", chatId: "chat-1", provider: "codex", content: "/compact", model: "gpt-5.4" })

    expect(slashCommandCalls).toEqual([{
      chatId: "chat-1",
      cwd: "/tmp/project",
      threadId: "thread-1",
      command: "/compact",
    }])
    expect(startedTurns).toEqual([])
    expect(store.messages.at(-1)?.kind).toBe("compact_boundary")
  })

  test.each(["success", "failure"])("publishes a manual Codex compaction boundary only after successful completion (%s)", async (outcome) => {
    const store = createFakeStore()
    store.chat.provider = "codex"
    store.chat.sessionToken = "thread-1"
    let finish!: () => void
    let fail!: (error: Error) => void
    const completion = new Promise<void>((resolve, reject) => { finish = resolve; fail = reject })
    let started = false
    const coordinator = new AgentCoordinator({ store: store as never, onStateChange: () => {},
      codexManager: { async runSlashCommand() { started = true; await completion } } as never,
    })
    const result = coordinator.send({ type: "chat.send", chatId: "chat-1", provider: "codex", content: "/compact" })
      .catch((error: Error) => error)
    await waitFor(() => started)
    expect(store.messages).toEqual([])
    if (outcome === "success") finish()
    else fail(new Error("compaction process lost"))
    const response = await result
    if (outcome === "success") {
      expect(response).toEqual({ chatId: "chat-1" })
      expect(store.messages.map((entry) => entry.kind)).toEqual(["compact_boundary"])
    } else {
      expect(response).toMatchObject({ message: "compaction process lost" })
      expect(store.messages).toEqual([])
    }
  })

  test("generates a chat title in the background on the first user message", async () => {
    let releaseTitle!: () => void
    const titleGate = new Promise<void>((resolve) => {
      releaseTitle = resolve
    })
    const titleCalls: Array<{ messageContent: string; cwd: string; preferredProvider?: "claude" | "codex" }> = []
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
      generateTitle: async (messageContent, cwd, preferredProvider) => {
        titleCalls.push({ messageContent, cwd, preferredProvider })
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
    expect(titleCalls).toEqual([{
      messageContent: "first message",
      cwd: "/tmp/project",
      preferredProvider: "codex",
    }])
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
    // Model the real manager's warm-session early return: once a chat has a
    // live session, later startSession calls (including the coordinator's
    // health-check preflight) no-op instead of re-resuming.
    const openSessions = new Set<string>()
    const fakeCodexManager = {
      async readPromptHistory() {
        return { inputs: store.messages.filter((entry) => entry.kind === "user_prompt").map((entry, i) => ({
          turnId: `native-${i}`, userIndex: 0, promptId: entry._id, text: (entry as { content: string }).content,
        })) }
      },
      async startSession(args: { chatId: string; sessionToken: string | null; pendingForkSessionToken?: string | null }) {
        if (openSessions.has(args.chatId) && !args.pendingForkSessionToken) return
        openSessions.add(args.chatId)
        sessionCalls.push({ chatId: args.chatId, sessionToken: args.sessionToken })
        return { sessionToken: "thread-1", resumeFellBack: false }
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
    // The warm app-server session is reused across turns — no fresh resume on
    // the second turn — and the resumed token is retained.
    expect(sessionCalls).toEqual([{ chatId: "chat-1", sessionToken: null }])
    expect(store.chat.sessionToken).toBe("thread-1")
  })

  test("maps codex model options into session and turn settings", async () => {
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
  })

  test("approving synthetic codex ExitPlanMode starts a hidden follow-up turn and can clear context", async () => {
    const sessionCalls: Array<{ chatId: string; sessionToken: string | null }> = []
    const startTurnCalls: Array<{ content: string; planMode: boolean }> = []
    let turnCount = 0
    const restorationAtStartup: any[] = []

    const fakeCodexManager = {
      stopSession() {},
      async startSession(args: { chatId: string; sessionToken: string | null }) {
        sessionCalls.push({ chatId: args.chatId, sessionToken: args.sessionToken })
        restorationAtStartup.push((store.chat as any).contextRestoration)
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
    expect(restorationAtStartup[1]).toMatchObject({ reason: "explicit_reset", provider: "codex" })
    expect((store.chat as any).contextRestoration).toBeNull()
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
    expect(coordinator.getPendingTool("chat-1")?.preview).toBe("Provider?")
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

    // Result persistence precedes the awaited completion bookkeeping. Observe
    // idle while the stream is still open rather than racing that bookkeeping.
    await waitFor(() => store.messages.some((entry) => entry.kind === "result")
      && !coordinator.getActiveStatuses().has("chat-1"))

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


  test("closes Codex sessions when a chat is closed", async () => {
    const stoppedChatIds: string[] = []
    const coordinator = new AgentCoordinator({
      store: createFakeStore() as never,
      onStateChange: () => {},
      codexManager: {
        stopSession(chatId: string) {
          stoppedChatIds.push(chatId)
        },
      } as never,
    })

    await coordinator.closeChat("chat-1")

    expect(stoppedChatIds).toEqual(["chat-1"])
  })


  test("closes inactive Codex sessions after the configured idle timeout", async () => {
    const stoppedChatIds: string[] = []
    const store = createFakeStore()
    const coordinator = new AgentCoordinator({
      store: store as never,
      onStateChange: () => {},
      codexManager: {
        async startSession() {},
        hasSession: () => true,
        getSessionChatIds: () => [],
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
        stopSession(chatId: string) {
          stoppedChatIds.push(chatId)
        },
      } as never,
    })
    coordinator.setIdleSessionTimeoutMs(20)

    await coordinator.send({
      type: "chat.send",
      chatId: "chat-1",
      provider: "codex",
      content: "first message",
      model: "gpt-5.4",
    })

    await waitFor(() => store.turnFinishedCount === 1)
    await waitFor(() => stoppedChatIds.includes("chat-1"))

    expect(stoppedChatIds).toEqual(["chat-1"])
  })


  test("steers queued Codex messages sequentially while earlier steers settle", async () => {
    const streams: AsyncEventQueue<any>[] = []
    const startTurnCalls: Array<{ content: string }> = []
    const steerTurnCalls: Array<{
      chatId: string
      expectedTurnId: string
      content: string
      clientUserMessageId: string
      transcriptEntry: TranscriptEntry
    }> = []
    let acceptSteer!: () => void
    const steerAccepted = new Promise<void>((resolve) => {
      acceptSteer = resolve
    })
    let interruptCalls = 0
    const store = createFakeStore()
    store.chat.provider = "codex"
    store.chat.title = "Chat"
    store.chat.sessionToken = "thread-1"
    await store.enqueueMessage("chat-1", {
      id: "queued-1",
      content: "queued follow up",
      attachments: [],
      provider: "codex",
      model: "gpt-5.4",
      planMode: false,
    })
    await store.enqueueMessage("chat-1", {
      id: "queued-2",
      content: "another queued follow up",
      attachments: [],
      provider: "codex",
      model: "gpt-5.4",
      planMode: false,
    })

    const coordinator = new AgentCoordinator({
      store: store as never,
      onStateChange: () => {},
      codexManager: {
        async startSession() {
          return "thread-1"
        },
        async startTurn(args: { content: string }): Promise<HarnessTurn> {
          startTurnCalls.push(args)
          const stream = new AsyncEventQueue<any>()
          streams.push(stream)
          return {
            provider: "codex",
            providerTurnId: "turn-1",
            stream,
            interrupt: async () => {
              interruptCalls += 1
            },
            close: () => stream.close(),
          }
        },
        startSteerTurn(args: {
          chatId: string
          expectedTurnId: string
          content: string
          clientUserMessageId: string
          transcriptEntry: TranscriptEntry
        }) {
          steerTurnCalls.push(args)
          return { accepted: steerAccepted, settled: steerAccepted }
        },
      } as never,
    })

    await coordinator.send({
      type: "chat.send",
      chatId: "chat-1",
      provider: "codex",
      content: "initial prompt",
      model: "gpt-5.4",
    })
    streams[0]?.push({
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
    })
    await waitFor(() => coordinator.getActiveStatuses().get("chat-1") === "running")

    try {
      await coordinator.steer({
        type: "message.steer",
        chatId: "chat-1",
        queuedMessageId: "queued-1",
      })
      await waitFor(() => steerTurnCalls.length === 1)

      expect(store.getQueuedMessage("chat-1", "queued-1")).not.toBeNull()
      expect(coordinator.getPendingCodexSteerIds("chat-1")).toEqual(new Set(["queued-1"]))

      const second = coordinator.steer({
        type: "message.steer",
        chatId: "chat-1",
        queuedMessageId: "queued-2",
      })
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(steerTurnCalls).toHaveLength(1)

      expect(store.getQueuedMessage("chat-1", "queued-2")).not.toBeNull()
      expect(coordinator.getPendingCodexSteerIds("chat-1")).toEqual(new Set(["queued-1"]))

      acceptSteer()
      await second
      await waitFor(() => coordinator.getPendingCodexSteerIds("chat-1").size === 0)

      expect(steerTurnCalls.map((call) => call.clientUserMessageId)).toEqual(["queued-1", "queued-2"])
      expect(steerTurnCalls[0]).toMatchObject({
        chatId: "chat-1",
        expectedTurnId: "turn-1",
        clientUserMessageId: "queued-1",
        transcriptEntry: {
          _id: "queued-1",
          kind: "user_prompt",
          attachments: [],
          steered: true,
        },
      })
      expect(steerTurnCalls[0]?.content).toContain("queued follow up")
      expect(startTurnCalls).toHaveLength(1)
      expect(interruptCalls).toBe(0)
      expect(store.getQueuedMessage("chat-1", "queued-1")).toBeNull()
      expect(store.getQueuedMessage("chat-1", "queued-2")).toBeNull()
      expect(store.messages.some((entry) => entry.kind === "interrupted")).toBe(false)
      expect(coordinator.getActiveStatuses().get("chat-1")).toBe("running")
    } finally {
      for (const stream of streams) stream.close()
    }
  })


  test("does not promote a queued Codex message while its native steer is still settling", async () => {
    const streams: AsyncEventQueue<any>[] = []
    const startTurnCalls: Array<{ content: string }> = []
    let rejectSteer!: (error: Error) => void
    const steerSettled = new Promise<void>((_resolve, reject) => {
      rejectSteer = reject
    })
    let steerTurnCalls = 0
    const store = createFakeStore()
    store.chat.provider = "codex"
    store.chat.title = "Chat"
    store.chat.sessionToken = "thread-1"
    await store.enqueueMessage("chat-1", {
      id: "queued-race",
      content: "follow up during completion",
      attachments: [],
      provider: "codex",
      model: "gpt-5.4",
      planMode: false,
    })

    const coordinator = new AgentCoordinator({
      store: store as never,
      onStateChange: () => {},
      codexManager: {
        async startSession() {
          return "thread-1"
        },
        async startTurn(args: { content: string }): Promise<HarnessTurn> {
          startTurnCalls.push(args)
          const stream = new AsyncEventQueue<any>()
          streams.push(stream)
          return {
            provider: "codex",
            providerTurnId: `turn-${startTurnCalls.length}`,
            stream,
            interrupt: async () => {},
            close: () => stream.close(),
          }
        },
        startSteerTurn() {
          steerTurnCalls += 1
          return { accepted: Promise.resolve(), settled: steerSettled }
        },
      } as never,
    })

    await coordinator.send({
      type: "chat.send",
      chatId: "chat-1",
      provider: "codex",
      content: "initial prompt",
      model: "gpt-5.4",
    })
    streams[0]?.push({
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
    })
    await waitFor(() => coordinator.getActiveStatuses().get("chat-1") === "running")

    await coordinator.steer({
      type: "message.steer",
      chatId: "chat-1",
      queuedMessageId: "queued-race",
    })
    await waitFor(() => steerTurnCalls === 1)

    streams[0]?.push({
      type: "transcript" as const,
      entry: timestamped({
        kind: "result",
        subtype: "success",
        isError: false,
        durationMs: 0,
        result: "",
      }),
    })
    streams[0]?.close()
    await waitFor(() => store.turnFinishedCount === 1)

    expect(startTurnCalls).toHaveLength(1)
    expect(store.getQueuedMessage("chat-1", "queued-race")).not.toBeNull()

    rejectSteer(new Error("turn completed before steer acknowledgement"))
    await waitFor(() => startTurnCalls.length === 2)

    expect(store.getQueuedMessage("chat-1", "queued-race")).toBeNull()
    expect(startTurnCalls[1]?.content).toContain("follow up during completion")

    for (const stream of streams) stream.close()
  })


  test("removes a recovered steer queue record without submitting its persisted prompt again", async () => {
    const startTurnCalls: Array<{ content: string }> = []
    const store = createFakeStore()
    store.chat.provider = "codex"
    store.chat.title = "Chat"
    store.chat.sessionToken = "thread-1"
    store.messages.push({
      ...timestamped({
        kind: "user_prompt",
        content: "already accepted follow up",
        steered: true,
      }),
      _id: "queued-persisted",
    } as TranscriptEntry)
    await store.enqueueMessage("chat-1", {
      id: "queued-persisted",
      content: "already accepted follow up",
      attachments: [],
      provider: "codex",
      model: "gpt-5.4",
      planMode: false,
    })

    const coordinator = new AgentCoordinator({
      store: store as never,
      onStateChange: () => {},
      codexManager: {
        async startSession() {
          return "thread-1"
        },
        async startTurn(args: { content: string }): Promise<HarnessTurn> {
          startTurnCalls.push(args)
          async function* stream() {
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
            providerTurnId: "turn-1",
            stream: stream(),
            interrupt: async () => {},
            close: () => {},
          }
        },
      } as never,
    })

    await coordinator.send({
      type: "chat.send",
      chatId: "chat-1",
      provider: "codex",
      content: "initial prompt",
      model: "gpt-5.4",
    })
    await waitFor(() => store.turnFinishedCount === 1)
    await waitFor(() => store.getQueuedMessage("chat-1", "queued-persisted") === null)

    expect(startTurnCalls).toHaveLength(1)
    expect(startTurnCalls[0]?.content.split("\n", 1)[0]).toBe("initial prompt")
    expect(startTurnCalls[0]?.content).not.toContain("already accepted follow up")
  })


  test("uses the restart fallback while a Codex plan response is pending", async () => {
    const streams: AsyncEventQueue<any>[] = []
    const startTurnCalls: Array<{ content: string }> = []
    let requestToolInput: ((request: any) => Promise<unknown>) | undefined
    let interruptCalls = 0
    let nativeSteerCalls = 0
    const store = createFakeStore()
    store.chat.provider = "codex"
    store.chat.title = "Chat"
    store.chat.sessionToken = "thread-1"
    await store.enqueueMessage("chat-1", {
      id: "queued-after-plan",
      content: "change the plan",
      attachments: [],
      provider: "codex",
      model: "gpt-5.4",
      planMode: true,
    })

    const coordinator = new AgentCoordinator({
      store: store as never,
      onStateChange: () => {},
      codexManager: {
        async startSession() {
          return "thread-1"
        },
        async startTurn(args: {
          content: string
          onToolRequest: (request: any) => Promise<unknown>
        }): Promise<HarnessTurn> {
          startTurnCalls.push(args)
          requestToolInput ??= args.onToolRequest
          const stream = new AsyncEventQueue<any>()
          streams.push(stream)
          return {
            provider: "codex",
            providerTurnId: `turn-${startTurnCalls.length}`,
            stream,
            interrupt: async () => {
              interruptCalls += 1
              stream.close()
            },
            close: () => stream.close(),
          }
        },
        startSteerTurn() {
          nativeSteerCalls += 1
          return { accepted: Promise.resolve(), settled: Promise.resolve() }
        },
      } as never,
    })

    await coordinator.send({
      type: "chat.send",
      chatId: "chat-1",
      provider: "codex",
      content: "make a plan",
      model: "gpt-5.4",
      planMode: true,
    })
    streams[0]?.push({
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
    })
    await waitFor(() => coordinator.getActiveStatuses().get("chat-1") === "running")
    if (!requestToolInput) throw new Error("missing Codex tool callback")
    const toolResponse = requestToolInput({
      tool: {
        kind: "tool",
        toolKind: "exit_plan_mode",
        toolName: "ExitPlanMode",
        toolId: "exit-plan-1",
        input: { plan: "Initial plan" },
      },
    })
    await waitFor(() => coordinator.getPendingTool("chat-1")?.toolKind === "exit_plan_mode")

    await coordinator.steer({
      type: "message.steer",
      chatId: "chat-1",
      queuedMessageId: "queued-after-plan",
    })
    await toolResponse

    expect(nativeSteerCalls).toBe(0)
    expect(interruptCalls).toBe(1)
    expect(startTurnCalls).toHaveLength(2)
    expect(startTurnCalls[1]?.content).toContain("change the plan")
    expect(store.getQueuedMessage("chat-1", "queued-after-plan")).toBeNull()

    for (const stream of streams) stream.close()
  })


  for (const selection of [
    { provider: "claude", model: undefined, expected: getServerProviderCatalog("codex").defaultModel },
    { provider: "claude", model: "custom-target-model", expected: "custom-target-model" },
    { provider: "codex", model: undefined, expected: "custom-stored-model" },
  ] as const) {
    test(`model fallback stays within its provider (${selection.provider}, ${selection.model ?? "implicit"})`, async () => {
      const store = createFakeStore()
      store.chat.title = "Existing chat"
      store.chat.provider = selection.provider
      store.chat.model = "custom-stored-model"
      const models: string[] = []
      const coordinator = new AgentCoordinator({
        store: store as never,
        onStateChange: () => {},
        codexManager: {
          stopSession() {},
          async startSession() {},
          async startTurn(args: { model: string }): Promise<HarnessTurn> {
            models.push(args.model)
            return {
              provider: "codex",
              stream: (async function* () {
                yield { type: "transcript" as const, entry: timestamped({ kind: "result", subtype: "success", isError: false, durationMs: 0, result: "done" }) }
              })(),
              interrupt: async () => {}, close: () => {},
            }
          },
        } as never,
      })
      await coordinator.send({ type: "chat.send", chatId: "chat-1", provider: "codex", content: "follow up", model: selection.model })
      await waitFor(() => store.turnFinishedCount === 1)
      expect(models).toEqual([selection.expected])
      expect(store.chat.model).toBe(selection.expected)
    })
  }


  test("pending Codex fork edits reconnect with Kanna tools before replacement startup", async () => {
    const store = createFakeStore()
    store.chat.provider = "codex"
    store.chat.sessionToken = null
    store.chat.pendingForkSessionToken = "source"
    store.chat.pendingForkUserPrompt = true
    const prompt = timestamped({ kind: "user_prompt", content: "task" })
    store.messages = [prompt]
    let connected = false
    let toolsAvailable = false
    const coordinator = new AgentCoordinator({ store: store as never, onStateChange: () => {},
      codexManager: {
        async startSession(args: { pendingForkSessionToken?: string | null; customTools?: unknown }) {
          if (connected && !args.pendingForkSessionToken) return
          connected = true
          toolsAvailable = Boolean(args.customTools)
          return codexStartResult("prepared")
        },
        async rollbackThread() {},
        stopSession() { connected = false },
        async startTurn(): Promise<HarnessTurn> {
          if (!toolsAvailable) throw new Error("Kanna tools are missing from the prepared session")
          return { provider: "codex", interrupt: async () => {}, close: () => {},
            stream: (async function* () {
              yield { type: "transcript" as const, entry: timestamped({ kind: "result", subtype: "success",
                isError: false, durationMs: 0, result: "done" }) }
            })(),
          }
        },
      } as never,
    })
    await coordinator.editUserPrompt({ type: "chat.editUserPrompt", chatId: "chat-1",
      messageId: prompt._id, content: "replacement" })
    await waitFor(() => store.turnFinishedCount === 1)
    expect(toolsAvailable).toBe(true)
  })


  test.each(["rollback", "reconnect", "turn"])("keeps the original Codex history intact after edit %s failure and retry", async (failure) => {
    const store = createFakeStore()
    store.chat.provider = "codex"
    store.chat.sessionToken = "source"
    const prompt = timestamped({ kind: "user_prompt", content: "first task" })
    const originalMessages = [prompt,
      timestamped({ kind: "assistant_text", text: "first answer" }),
      timestamped({ kind: "user_prompt", content: "second task" }),
      timestamped({ kind: "assistant_text", text: "second answer" })]
    store.messages = [...originalMessages]
    const histories = new Map<string, string[]>([["source", ["first task", "second task"]]])
    const rollbackThreads: string[] = []
    let currentThread = "source"
    let forks = 0
    let failed = false
    const failOnce = (stage: string) => {
      if (failure === stage && !failed) {
        failed = true
        throw new Error(`${stage} failed`)
      }
    }
    const coordinator = new AgentCoordinator({ store: store as never, onStateChange: () => {},
      codexManager: {
        async readPromptHistory() {
          return {inputs:originalMessages.filter(entry=>entry.kind==="user_prompt").map((entry,index)=>({turnId:`turn-${index}`,userIndex:0,promptId:entry._id,text:entry.content}))}
        },
        async forkBeforeTurn(args: {threadId:string;beforeTurnId:string}) {
          currentThread = `edit-${++forks}`
          const index=Number(args.beforeTurnId.slice(5))
          histories.set(currentThread,histories.get(args.threadId)!.slice(0,index))
          rollbackThreads.push(currentThread)
          failOnce("rollback")
          return currentThread
        },
        async startSession(args: {sessionToken:string;customTools?:unknown}) {
          failOnce("reconnect")
          currentThread=args.sessionToken
          expect(args.customTools).toBeDefined()
          return codexStartResult(currentThread)
        },
        stopSession() {},
        async startTurn(): Promise<HarnessTurn> {
          failOnce("turn")
          return { provider: "codex", interrupt: async () => {}, close: () => {},
            stream: (async function* () {
              yield { type: "transcript" as const, entry: timestamped({ kind: "result", subtype: "success",
                isError: false, durationMs: 0, result: "done" }) }
            })(),
          }
        },
      } as never,
    })
    const command = { type: "chat.editUserPrompt" as const, chatId: "chat-1", messageId: prompt._id, content: "replacement" }
    await expect(coordinator.editUserPrompt(command)).rejects.toThrow(`${failure} failed`)
    expect(histories.get("source")).toEqual(["first task", "second task"])
    expect(store.chat.sessionToken).toBe("source")
    expect(store.messages).toEqual(originalMessages)
    await coordinator.editUserPrompt(command)
    await waitFor(() => store.turnFinishedCount === 1)
    expect(rollbackThreads).toEqual(["edit-1", "edit-2"])
    expect(histories.get("source")).toEqual(["first task", "second task"])
    expect(store.chat.sessionToken).toBe("edit-2")
    expect(store.messages[0]).toMatchObject({ kind: "user_prompt", content: "replacement" })
  })


  test.each([
    { sessionToken: "fresh", resumeFellBack: true },
    { sessionToken: "unrelated", resumeFellBack: false },
    null,
  ])("preserves original Codex history when prepared fork reconnect loses its identity (%j)", async (reconnected) => {
    const store = createFakeStore()
    store.chat.provider = "codex"
    store.chat.sessionToken = "source"
    const prompt = timestamped({ kind: "user_prompt", content: "task" })
    const original = [prompt, timestamped({ kind: "assistant_text", text: "original answer" })]
    store.messages = [...original]
    let turns = 0
    let stops = 0
    const coordinator = new AgentCoordinator({ store: store as never, onStateChange: () => {},
      codexManager: {
        async readPromptHistory() {return {inputs:[{turnId:"turn",userIndex:0,promptId:prompt._id,text:"task"}]}},
        async forkBeforeTurn() {return "prepared"},
        async startSession() {return reconnected},
        stopSession() { stops++ },
        async startTurn(): Promise<HarnessTurn> {
          turns++
          return { provider: "codex", interrupt: async () => {}, close: () => {}, stream: (async function* () {})() }
        },
      } as never,
    })
    await expect(coordinator.editUserPrompt({ type: "chat.editUserPrompt", chatId: "chat-1", messageId: prompt._id,
      content: "replacement" })).rejects.toThrow("prepared edit session")
    expect(turns).toBe(0)
    expect(stops).toBe(2)
    expect(store.chat.sessionToken).toBe("source")
    expect(store.messages).toEqual(original)
    expect(coordinator.activeTurns.has("chat-1")).toBe(false)
  })


  test.each([null, "source"])("refuses to edit Codex history without an isolated fork (%s)", async (forkToken) => {
    const store = createFakeStore()
    store.chat.provider = "codex"
    store.chat.sessionToken = "source"
    const prompt = timestamped({ kind: "user_prompt", content: "task" })
    store.messages = [prompt]
    let rollbacks = 0
    let stops = 0
    const coordinator = new AgentCoordinator({ store: store as never, onStateChange: () => {},
      codexManager: {
        async readPromptHistory() {return {inputs:[{turnId:"turn",userIndex:0,promptId:prompt._id,text:"task"}]}},
        async forkBeforeTurn() {throw new Error(`Codex did not return an isolated forked session (${forkToken})`)},
        async rollbackThread() { rollbacks++ },
        stopSession() { stops++ },
      } as never,
    })
    await expect(coordinator.editUserPrompt({ type: "chat.editUserPrompt", chatId: "chat-1", messageId: prompt._id,
      content: "replacement" })).rejects.toThrow("forked session")
    expect(rollbacks).toBe(0)
    expect(stops).toBe(0)
    expect(store.chat.sessionToken).toBe("source")
    expect(store.messages).toEqual([prompt])
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
      title: "Fork: Claude Debug",
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


  test("maps explicit and legacy Codex options over persisted chat settings", async () => {
    const sessionCalls: Array<{ chatId: string; sessionToken: string | null; serviceTier?: string }> = []
    const turnCalls: Array<{ effort?: string; serviceTier?: string }> = []
    const openSessions = new Set<string>()

    const fakeCodexManager = {
      async readPromptHistory() {
        return { inputs: store.messages.filter((entry) => entry.kind === "user_prompt").map((entry, i) => ({
          turnId: `native-${i}`, userIndex: 0, promptId: entry._id, text: (entry as { content: string }).content,
        })) }
      },
      async startSession(args: { chatId: string; sessionToken: string | null; serviceTier?: string }) {
        if (openSessions.has(args.chatId)) return
        openSessions.add(args.chatId)
        sessionCalls.push({
          chatId: args.chatId,
          sessionToken: args.sessionToken,
          serviceTier: args.serviceTier,
        })
        return codexStartResult("thread-1")
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
})

describe("AgentCoordinator claude integration", () => {
  const readinessGate = () => {
    let release!: () => void
    const ready = new Promise<void>((resolve) => { release = resolve })
    return { ready, release }
  }

function createIdleAwareClaudeHarness(timeoutMs = 40) {
    const closeCalls: number[] = []
    const backgroundStateCallbacks: Array<(state: ClaudeBackgroundWorkState) => void> = []
    const eventStreams: Array<AsyncEventQueue<any>> = []
    const store = createFakeStore()
    const coordinator = new AgentCoordinator({
      store: store as never,
      onStateChange: () => {},
      startClaudeSession: async (args) => {
        const stream = new AsyncEventQueue<any>()
        const sessionIndex = eventStreams.push(stream) - 1
        backgroundStateCallbacks.push(args.onBackgroundWorkStateChange)
        return {
          provider: "claude",
          stream,
          getAccountInfo: async () => null,
          interrupt: async () => {},
          close: () => {
            closeCalls.push(sessionIndex)
            stream.close()
          },
          setModel: async () => {},
          setPermissionMode: async () => {},
          sendPrompt: async () => {
            stream.push({
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
    coordinator.setIdleSessionTimeoutMs(timeoutMs)

    return {
      coordinator,
      store,
      closeCalls,
      backgroundStateCallbacks,
      eventStreams,
    }
  }

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

  

  test("a Claude turn the CLI started on its own does not end the user's turn", async () => {
    const events = new AsyncEventQueue<any>()
    const promptIds: string[] = []
    const result = (text: string) => timestamped({
      kind: "result",
      subtype: "success",
      isError: false,
      durationMs: 0,
      result: text,
    })

    const store = createFakeStore()
    const coordinator = new AgentCoordinator({
      store: store as never,
      onStateChange: () => {},
      startClaudeSession: async () => ({
        provider: "claude",
        echoesPromptIds: true,
        stream: events,
        getAccountInfo: async () => null,
        interrupt: async () => {},
        close: () => {},
        setModel: async () => {},
        setPermissionMode: async () => {},
        sendPrompt: async (_content: string, promptId?: string) => {
          promptIds.push(promptId!)
          // A resumed session first runs the notification about background
          // commands the previous process left behind. Its result echoes no id.
          events.push({ type: "transcript" as const, entry: result("") })
        },
      }),
    })

    await coordinator.send({
      type: "chat.send",
      chatId: "chat-1",
      provider: "claude",
      content: "widen the page",
      model: "claude-opus-4-1",
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(store.turnFinishedCount).toBe(0)

    events.push({ type: "transcript" as const, entry: result("done"), promptIds: [promptIds[0]!] })
    await waitFor(() => store.turnFinishedCount === 1)

    events.close()
  })

  test("auto plan controls the EnterPlanMode tool and restarts the session when it changes", async () => {
    const queues: AsyncEventQueue<any>[] = []
    const startSessionCalls: Array<{ planMode: boolean; autoPlan: boolean }> = []
    const permissionModeCalls: boolean[] = []

    const store = createFakeStore()
    const coordinator = new AgentCoordinator({
      store: store as never,
      onStateChange: () => {},
      startClaudeSession: async (args) => {
        startSessionCalls.push({ planMode: args.planMode, autoPlan: args.autoPlan })
        // Each session gets its own stream so the restarted session doesn't
        // compete with the closed one for events.
        const events = new AsyncEventQueue<any>()
        queues.push(events)
        return {
          provider: "claude",
          stream: events,
          getAccountInfo: async () => null,
          interrupt: async () => {},
          close: () => events.close(),
          setModel: async () => {},
          setPermissionMode: async (planMode: boolean) => {
            permissionModeCalls.push(planMode)
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

    const send = async (options: { planMode?: boolean; autoPlan?: boolean }) => {
      await coordinator.send({
        type: "chat.send",
        chatId: "chat-1",
        provider: "claude",
        content: "go",
        model: "claude-opus-4-1",
        ...options,
      })
    }

    await send({})
    await waitFor(() => store.turnFinishedCount === 1)

    // Plan mode is applied to the live session — no restart.
    await send({ planMode: true })
    await waitFor(() => store.turnFinishedCount === 2)

    // Auto plan changes the tool allowlist, which forces a fresh session.
    await send({ autoPlan: true })
    await waitFor(() => store.turnFinishedCount === 3)

    expect(startSessionCalls).toEqual([
      { planMode: false, autoPlan: false },
      { planMode: true, autoPlan: true },
    ])
    expect(permissionModeCalls).toEqual([true])
    expect(store.chat.autoPlan).toBe(true)

    queues.forEach((queue) => queue.close())
  })

  test("claudeToolset only offers EnterPlanMode in auto plan", () => {
    expect(claudeToolset(false)).not.toContain("EnterPlanMode")
    // ExitPlanMode stays available so a mid-session switch into plan mode
    // isn't a one-way door.
    expect(claudeToolset(false)).toContain("ExitPlanMode")
    expect(claudeToolset(true)).toContain("EnterPlanMode")
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
    // The steer block is wire-only: the transcript keeps the user's typed
    // text verbatim, with the steered flag driving the UI affordance.
    const steeredEntry = store.messages.find(
      (entry) => entry.kind === "user_prompt" && entry.steered
    ) as Extract<TranscriptEntry, { kind: "user_prompt" }> | undefined
    expect(steeredEntry?.content).toBe("queued follow up")
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

  test("enqueue with steer goes through the same path as Send now on a queued message", async () => {
    const events = new AsyncEventQueue<any>()
    const prompts: string[] = []
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
    await coordinator.enqueue({
      type: "message.enqueue",
      chatId: "chat-1",
      content: "actually, do this instead",
      steer: true,
    })

    // Interrupted and re-prompted straight away, with the steer block —
    // exactly what steer() does, because it is steer().
    expect(prompts).toHaveLength(2)
    expect(prompts[1]).toContain("actually, do this instead")
    expect(prompts[1]).toContain("<system-message>")
    expect(store.messages.some((entry) => entry.kind === "interrupted")).toBe(true)
    expect(store.getQueuedMessages()).toEqual([])

    events.close()
  })

  test("enqueue with steer is not an error when the queue drained first", async () => {
    // The race the flag exists for: the turn ends while the message is being
    // queued, the drain starts it, and steer() finds nothing to steer. The
    // message is running — which is what was asked for — so that is success.
    const events = new AsyncEventQueue<any>()
    const prompts: string[] = []
    const store = createFakeStore()
    // Simulate the drain: the message is gone by the time steer() looks.
    const enqueueMessage = store.enqueueMessage.bind(store)
    store.enqueueMessage = async (chatId: string, message: any) => {
      const queued = await enqueueMessage(chatId, message)
      await store.removeQueuedMessage(chatId, queued.id)
      return queued
    }
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
    await expect(coordinator.enqueue({
      type: "message.enqueue",
      chatId: "chat-1",
      content: "late steer",
      steer: true,
    })).resolves.toEqual({ queuedMessageId: expect.any(String) })

    // Nothing was double-sent and the running turn was left alone.
    expect(prompts).toEqual(["first prompt"])
    expect(store.messages.some((entry) => entry.kind === "interrupted")).toBe(false)

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


  test("closes Claude sessions when a chat is closed", async () => {
    const closeCalls: string[] = []
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
        close: () => {
          closeCalls.push("close")
          events.close()
        },
        setModel: async () => {},
        setPermissionMode: async () => {},
        sendPrompt: async () => {},
      }),
    })

    await coordinator.send({
      type: "chat.send",
      chatId: "chat-1",
      provider: "claude",
      content: "first message",
      model: "claude-opus-4-7",
    })

    await coordinator.closeChat("chat-1")

    expect(closeCalls.length).toBeGreaterThan(0)
  })


  test("keeps unknown and active Claude background sessions out of idle cleanup", async () => {
    const harness = createIdleAwareClaudeHarness(20)

    await harness.coordinator.send({
      type: "chat.send",
      chatId: "chat-1",
      provider: "claude",
      content: "first message",
      model: "claude-opus-4-7",
    })

    await waitFor(() => harness.store.turnFinishedCount === 1)
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(harness.closeCalls).toEqual([])
    expect(harness.backgroundStateCallbacks).toHaveLength(1)

    harness.coordinator.setIdleSessionTimeoutMs(25)
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(harness.closeCalls).toEqual([])

    harness.backgroundStateCallbacks[0]?.("active")
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(harness.closeCalls).toEqual([])

    await harness.coordinator.closeChat("chat-1")
    expect(harness.closeCalls).toEqual([0])
  })


  test("starts the Claude idle timeout when background work becomes inactive", async () => {
    const harness = createIdleAwareClaudeHarness(50)

    await harness.coordinator.send({
      type: "chat.send",
      chatId: "chat-1",
      provider: "claude",
      content: "first message",
      model: "claude-opus-4-7",
    })

    await waitFor(() => harness.store.turnFinishedCount === 1)
    harness.backgroundStateCallbacks[0]?.("active")
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(harness.closeCalls).toEqual([])

    harness.backgroundStateCallbacks[0]?.("inactive")
    await new Promise((resolve) => setTimeout(resolve, 25))
    expect(harness.closeCalls).toEqual([])
    await waitFor(() => harness.closeCalls.length > 0, 500)
    expect(harness.closeCalls).toEqual([0])
  })


  test("cancels a pending Claude idle close when background work becomes active", async () => {
    const harness = createIdleAwareClaudeHarness(50)

    await harness.coordinator.send({
      type: "chat.send",
      chatId: "chat-1",
      provider: "claude",
      content: "first message",
      model: "claude-opus-4-7",
    })

    await waitFor(() => harness.store.turnFinishedCount === 1)
    harness.backgroundStateCallbacks[0]?.("inactive")
    await new Promise((resolve) => setTimeout(resolve, 25))
    harness.backgroundStateCallbacks[0]?.("active")
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(harness.closeCalls).toEqual([])

    await harness.coordinator.closeChat("chat-1")
    expect(harness.closeCalls).toEqual([0])
  })


  test("ignores background work callbacks from a replaced Claude session", async () => {
    const harness = createIdleAwareClaudeHarness(30)

    await harness.coordinator.send({
      type: "chat.send",
      chatId: "chat-1",
      provider: "claude",
      content: "first message",
      model: "claude-opus-4-8",
      modelOptions: {
        claude: { reasoningEffort: "low", contextWindow: "200k" },
      },
    })
    await waitFor(() => harness.store.turnFinishedCount === 1)
    harness.backgroundStateCallbacks[0]?.("active")

    await harness.coordinator.send({
      type: "chat.send",
      chatId: "chat-1",
      provider: "claude",
      content: "second message",
      model: "claude-opus-4-8",
      modelOptions: {
        claude: { reasoningEffort: "high", contextWindow: "200k" },
      },
    })
    await waitFor(() => harness.backgroundStateCallbacks.length === 2)
    harness.backgroundStateCallbacks[1]?.("active")
    await waitFor(() => harness.store.turnFinishedCount === 2)

    const closeCountAfterReplacement = harness.closeCalls.length
    harness.backgroundStateCallbacks[0]?.("inactive")
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(harness.closeCalls).toHaveLength(closeCountAfterReplacement)

    harness.backgroundStateCallbacks[1]?.("inactive")
    await waitFor(() => harness.closeCalls.includes(1), 500)
    expect(harness.closeCalls).toContain(1)
  })


  test("closes an idle Claude session while queue preparation is still pending", async () => {
    const events = new AsyncEventQueue<any>()
    const store = createFakeStore()
    let closes = 0
    let release!: () => void
    const preparation = new Promise<void>(resolve => { release = resolve })
    let entered!: () => void
    const preparing = new Promise<void>(resolve => { entered = resolve })
    const coordinator = new AgentCoordinator({ store: store as never, onStateChange: () => {},
      startClaudeSession: async args => ({ provider: "claude", stream: events,
        interrupt: async () => {}, close: () => { closes++; events.close() },
        setModel: async () => {}, setPermissionMode: async () => {},
        sendPrompt: async () => { args.onBackgroundWorkStateChange("inactive") },
      }),
    })
    // Hold the asynchronous preparation boundary after completion releases the turn.
    ;(coordinator as any).maybeStartNextQueuedMessage = async () => { entered(); await preparation; return false }
    coordinator.setIdleSessionTimeoutMs(20)
    try {
      await coordinator.send({ type: "chat.send", chatId: "chat-1", provider: "claude", content: "request" })
      events.push({ type: "transcript", entry: timestamped({ kind: "result", subtype: "success",
        isError: false, durationMs: 0, result: "done" }) })
      await preparing
      expect(store.turnFinishedCount).toBe(1)
      await new Promise(resolve => setTimeout(resolve, 100))
      expect(closes).toBe(1)
    } finally {
      release()
      events.close()
      coordinator.dispose()
    }
  })


  test("closes inactive Claude sessions after the configured idle timeout", async () => {
    const closeCalls: string[] = []
    const events = new AsyncEventQueue<any>()
    const store = createFakeStore()
    const coordinator = new AgentCoordinator({
      store: store as never,
      onStateChange: () => {},
      startClaudeSession: async (args) => ({
        provider: "claude",
        stream: events,
        getAccountInfo: async () => null,
        interrupt: async () => {},
        close: () => {
          closeCalls.push("close")
          events.close()
        },
        setModel: async () => {},
        setPermissionMode: async () => {},
        sendPrompt: async () => {
          args.onBackgroundWorkStateChange("inactive")
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
    coordinator.setIdleSessionTimeoutMs(20)

    await coordinator.send({
      type: "chat.send",
      chatId: "chat-1",
      provider: "claude",
      content: "first message",
      model: "claude-opus-4-7",
    })

    await waitFor(() => store.turnFinishedCount === 1)
    await waitFor(() => closeCalls.length > 0)

    expect(closeCalls.length).toBeGreaterThan(0)
  })


  test("resets the Claude idle timeout when a persistent session emits after the result", async () => {
    const closeCalls: string[] = []
    const events = new AsyncEventQueue<any>()
    const store = createFakeStore()
    const coordinator = new AgentCoordinator({
      store: store as never,
      onStateChange: () => {},
      startClaudeSession: async (args) => ({
        provider: "claude",
        stream: events,
        getAccountInfo: async () => null,
        interrupt: async () => {},
        close: () => {
          closeCalls.push("close")
          events.close()
        },
        setModel: async () => {},
        setPermissionMode: async () => {},
        sendPrompt: async () => {
          args.onBackgroundWorkStateChange("inactive")
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
    coordinator.setIdleSessionTimeoutMs(50)

    await coordinator.send({
      type: "chat.send",
      chatId: "chat-1",
      provider: "claude",
      content: "first message",
      model: "claude-opus-4-7",
    })

    await waitFor(() => store.turnFinishedCount === 1)
    await new Promise((resolve) => setTimeout(resolve, 30))
    events.push({
      type: "transcript" as const,
      entry: timestamped({
        kind: "account_info",
        accountInfo: {
          accountId: "acct-1",
          email: "dev@example.com",
        },
      }),
    })
    await new Promise((resolve) => setTimeout(resolve, 35))

    expect(closeCalls).toEqual([])

    await waitFor(() => closeCalls.length > 0)
  })


  test("tracks Claude startup as active so cancel and queuing work before the session is ready", async () => {
    const events = new AsyncEventQueue<any>()
    let resolveStartRequested!: () => void
    const startRequested = new Promise<void>((resolve) => {
      resolveStartRequested = resolve
    })
    let resolveStartSession!: (turn: any) => void
    const startSessionGate = new Promise<any>((resolve) => {
      resolveStartSession = resolve
    })
    let startAttempts = 0

    const store = createFakeStore()
    const coordinator = new AgentCoordinator({
      store: store as never,
      onStateChange: () => {},
      startClaudeSession: async () => {
        startAttempts += 1
        resolveStartRequested()
        if (startAttempts > 1) {
          throw new Error("Claude startup should not be re-entered")
        }
        return await startSessionGate
      },
    })

    const firstSend = coordinator.send({
      type: "chat.send",
      chatId: "chat-1",
      provider: "claude",
      content: "first prompt",
      model: "claude-opus-4-1",
    })

    await startRequested

    expect(coordinator.getActiveStatuses().get("chat-1")).toBe("starting")

    await expect(coordinator.send({
      type: "chat.send",
      chatId: "chat-1",
      provider: "claude",
      content: "second prompt",
      model: "claude-opus-4-1",
    })).resolves.toMatchObject({ chatId: "chat-1", queued: true })
    expect(startAttempts).toBe(1)
    expect(store.queuedMessages.map((message) => message.content)).toEqual(["second prompt"])

    let interrupted = false
    resolveStartSession({
      provider: "claude",
      stream: events,
      getAccountInfo: async () => null,
      interrupt: async () => {
        interrupted = true
      },
      close: () => {},
      setModel: async () => {},
      setPermissionMode: async () => {},
      sendPrompt: async () => {},
    })
    await firstSend

    await coordinator.cancel("chat-1")
    expect(interrupted).toBe(true)

    events.close()
  })


  test("Claude cancellation during startup interrupts the ready session without sending its prompt", async () => {
    const events = new AsyncEventQueue<any>()
    let markStarting!: () => void
    const starting = new Promise<void>((resolve) => { markStarting = resolve })
    let releaseStart!: (session: any) => void
    const ready = new Promise<any>((resolve) => { releaseStart = resolve })
    let prompts = 0
    let interrupts = 0
    const coordinator = new AgentCoordinator({
      store: createFakeStore() as never,
      onStateChange: () => {},
      startClaudeSession: async () => {
        markStarting()
        return await ready
      },
    })
    const send = coordinator.send({
      type: "chat.send", chatId: "chat-1", provider: "claude", content: "cancel before ready", model: "claude-opus-4-1",
    })
    await starting
    await coordinator.cancel("chat-1")
    releaseStart({
      provider: "claude", stream: events,
      interrupt: async () => { interrupts += 1 }, close: () => {},
      setModel: async () => {}, setPermissionMode: async () => {},
      sendPrompt: async () => { prompts += 1 },
    })
    await send
    events.close()
    expect(prompts).toBe(0)
    expect(interrupts).toBe(1)
    expect(coordinator.getActiveStatuses().has("chat-1")).toBe(false)
  })


  test("reserves a queued Claude start before removing its queue entry", async () => {
    const events = new AsyncEventQueue<any>()
    const store = createFakeStore()
    const queued = await store.enqueueMessage("chat-1", { content: "queued first", provider: "claude", model: "claude-opus-4-1" })
    let markRemoval!: () => void
    const removalStarted = new Promise<void>((resolve) => { markRemoval = resolve })
    let releaseRemoval!: () => void
    const removalReady = new Promise<void>((resolve) => { releaseRemoval = resolve })
    const remove = store.removeQueuedMessage.bind(store)
    store.removeQueuedMessage = async (chatId, id) => {
      if (id === queued.id) { markRemoval(); await removalReady }
      await remove(chatId, id)
    }
    const prompts: string[] = []
    let starts = 0
    const coordinator = new AgentCoordinator({ store: store as never, onStateChange: () => {},
      startClaudeSession: async () => {
        starts++
        return { provider: "claude", stream: events, interrupt: async () => {}, close: () => events.close(),
          setModel: async () => {}, setPermissionMode: async () => {},
          sendPrompt: async (content) => { prompts.push(content) },
        }
      },
    })
    const first = coordinator.steer({ type: "message.steer", chatId: "chat-1", queuedMessageId: queued.id })
    try {
      await removalStarted
      const second = await coordinator.send({ type: "chat.send", chatId: "chat-1", provider: "claude", content: "second", model: "claude-opus-4-1" })
      expect(second).toMatchObject({ queued: true })
      expect(starts).toBe(0)
      releaseRemoval()
      await first
      expect(prompts).toHaveLength(1)
      expect(prompts[0]).toContain("queued first")
      expect(store.queuedMessages.map(entry => entry.content)).toEqual(["second"])
    } finally {
      releaseRemoval()
      await first.catch(() => {})
      events.close()
    }
  })


  test("reserves Claude startup before asynchronous chat metadata and queues a concurrent send", async () => {
    const events = new AsyncEventQueue<any>()
    const store = createFakeStore()
    const prompts: string[] = []
    let markMetadata!: () => void
    const metadataStarted = new Promise<void>((resolve) => { markMetadata = resolve })
    let releaseMetadata!: () => void
    const metadataReady = new Promise<void>((resolve) => { releaseMetadata = resolve })
    let metadataCalls = 0
    store.setPlanMode = async (_chatId, planMode) => {
      if (++metadataCalls === 1) { markMetadata(); await metadataReady }
      store.chat.planMode = planMode
    }
    let starts = 0
    const coordinator = new AgentCoordinator({
      store: store as never, onStateChange: () => {},
      startClaudeSession: async () => {
        starts += 1
        return {
          provider: "claude", stream: events, echoesPromptIds: true,
          interrupt: async () => {}, close: () => events.close(),
          setModel: async () => {}, setPermissionMode: async () => {},
          sendPrompt: async (content, promptId) => {
            prompts.push(content)
            events.push({ type: "transcript", promptIds: [promptId], entry: timestamped({
              kind: "result", subtype: "success", isError: false, durationMs: 0, result: "done",
            }) })
          },
        }
      },
    })
    const send = (content: string) => coordinator.send({
      type: "chat.send", chatId: "chat-1", provider: "claude", content, model: "claude-opus-4-1",
    })
    const first = send("first")
    try {
      await metadataStarted
      const second = await send("second")
      expect(second).toMatchObject({ queued: true })
      expect(starts).toBe(0)
      expect(store.queuedMessages.map((entry) => entry.content)).toEqual(["second"])
      releaseMetadata()
      await first
      await waitFor(() => store.turnFinishedCount === 2)
      expect(starts).toBe(1)
      expect(prompts.map((content) => content.split("\n\n")[0])).toEqual(["first", "second"])
      expect(store.queuedMessages).toHaveLength(0)
    } finally {
      releaseMetadata()
      await first.catch(() => {})
      events.close()
    }
  })


  test("releases a Claude startup reservation after startup fails so a retry can run", async () => {
    const events = new AsyncEventQueue<any>()
    let starts = 0
    const prompts: string[] = []
    const coordinator = new AgentCoordinator({
      store: createFakeStore() as never, onStateChange: () => {},
      startClaudeSession: async () => {
        if (++starts === 1) throw new Error("boot failed")
        return {
          provider: "claude", stream: events,
          interrupt: async () => {}, close: () => events.close(),
          setModel: async () => {}, setPermissionMode: async () => {},
          sendPrompt: async (content) => { prompts.push(content) },
        }
      },
    })
    const command = { type: "chat.send" as const, chatId: "chat-1", provider: "claude" as const, content: "retry", model: "claude-opus-4-1" }
    try {
      await expect(coordinator.send(command)).rejects.toThrow("boot failed")
      await expect(coordinator.send(command)).resolves.toEqual({ chatId: "chat-1" })
      expect(starts).toBe(2)
      expect(prompts.map((content) => content.split("\n\n")[0])).toEqual(["retry"])
    } finally {
      events.close()
    }
  })


  test("stops reading a retired Claude stream without disturbing its replacement", async () => {
    const store = createFakeStore()
    const replacement = new AsyncEventQueue<any>()
    let release!: () => void
    const lateEvents = new Promise<void>(resolve => { release = resolve })
    let exited!: () => void
    const retired = new Promise<void>(resolve => { exited = resolve })
    let starts = 0
    let consumed = 0
    const coordinator = new AgentCoordinator({ store: store as never, onStateChange: () => {},
      startClaudeSession: async () => {
        const first = ++starts === 1
        return { provider: "claude", stream: first ? { async *[Symbol.asyncIterator]() {
          try {
            await lateEvents
            for (let i = 0; i < 3; i++) {
              consumed++
              yield { type: "transcript" as const, entry: timestamped({ kind: "assistant_text", text: "stale" }) }
            }
          } finally { exited() }
        } } : replacement,
          interrupt: async () => {}, close: () => { if (!first) replacement.close() },
          setModel: async () => {}, setPermissionMode: async () => {}, sendPrompt: async () => {},
        }
      },
    })
    try {
      await coordinator.send({ type: "chat.send", chatId: "chat-1", provider: "claude", content: "first", autoPlan: false })
      await coordinator.cancel("chat-1")
      await coordinator.send({ type: "chat.send", chatId: "chat-1", provider: "claude", content: "replacement", autoPlan: true })
      expect(starts).toBe(2)
      release()
      await retired
      expect(consumed).toBe(1)
      expect(store.messages.some(entry => entry.kind === "assistant_text" && entry.text === "stale")).toBe(false)
      expect(coordinator.getActiveStatuses().get("chat-1")).toBe("running")
      expect((coordinator as any).claudeSessions.has("chat-1")).toBe(true)
    } finally {
      release()
      replacement.close()
      coordinator.dispose()
    }
  })


  test("Claude cancel settles a late result before interrupted persistence finishes", async () => {
    const events = new AsyncEventQueue<any>()
    const store = createFakeStore()
    let failedTurns = 0
    store.recordTurnFailed = async () => {
      failedTurns += 1
    }
    const appendMessage = store.appendMessage.bind(store)
    let resolveInterruptedAppendStarted: (() => void) | null = null
    const interruptedAppendStarted = new Promise<void>((resolve) => {
      resolveInterruptedAppendStarted = resolve
    })
    let releaseInterruptedAppend!: () => void
    const interruptedAppendRelease = new Promise<void>((resolve) => {
      releaseInterruptedAppend = resolve
    })

    store.appendMessage = async (chatId: string, entry: TranscriptEntry) => {
      await appendMessage(chatId, entry)
      if (entry.kind !== "interrupted") return

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
      resolveInterruptedAppendStarted?.()
      await interruptedAppendRelease
    }

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

    const cancelPromise = coordinator.cancel("chat-1")
    try {
      await interruptedAppendStarted
      await waitFor(() => !coordinator.getActiveStatuses().has("chat-1"))
    } finally {
      releaseInterruptedAppend()
      await cancelPromise
      events.close()
    }

    expect(store.messages.filter((entry) => entry.kind === "result")).toHaveLength(0)
    expect(failedTurns).toBe(0)
  })


  for (const lateKind of ["success", "error", "interrupted"] as const) {
    for (const currentFirst of [false, true]) {
      test(`Claude UUID steering suppresses a late cancelled ${lateKind} (${currentFirst ? "current first" : "cancelled first"})`, async () => {
        const events = new AsyncEventQueue<any>()
        const store = createFakeStore()
        const promptIds: string[] = []
        let closed = false
        const coordinator = new AgentCoordinator({
          store: store as never,
          onStateChange: () => {},
          startClaudeSession: async () => ({
            provider: "claude",
            echoesPromptIds: true,
            stream: events,
            interrupt: async () => {},
            close: () => { closed = true },
            setModel: async () => {},
            setPermissionMode: async () => {},
            sendPrompt: async (_content: string, promptId?: string) => { promptIds.push(promptId!) },
          }),
        })
        await coordinator.send({
          type: "chat.send", chatId: "chat-1", provider: "claude", content: "first", model: "claude-opus-4-1",
        })
        await store.enqueueMessage("chat-1", {
          id: "queued-1", content: "current", attachments: [], provider: "claude", model: "claude-opus-4-1", planMode: false,
        })
        await coordinator.steer({ type: "message.steer", chatId: "chat-1", queuedMessageId: "queued-1" })
        const late = {
          type: "transcript" as const,
          promptIds: [promptIds[0]!],
          entry: lateKind === "interrupted"
            ? timestamped({ kind: "interrupted" })
            : timestamped({ kind: "result", subtype: lateKind, isError: lateKind === "error", durationMs: 0, result: "stale" }),
        }
        const current = {
          type: "transcript" as const,
          promptIds: [promptIds[1]!],
          entry: timestamped({ kind: "result", subtype: "success", isError: false, durationMs: 0, result: "current" }),
        }
        for (const event of currentFirst ? [current, late] : [late, current]) events.push(event)
        events.close()
        await waitFor(() => closed)
        expect(store.turnFinishedCount).toBe(1)
        expect(store.messages.filter((entry) => entry.kind === "result").map((entry) => entry.result)).toEqual(["current"])
        expect(store.messages.filter((entry) => entry.kind === "interrupted")).toHaveLength(1)
      })
    }
  }


  test("Claude result answering cancelled and current UUIDs completes the current prompt", async () => {
    const events = new AsyncEventQueue<any>()
    const store = createFakeStore()
    const promptIds: string[] = []
    const coordinator = new AgentCoordinator({
      store: store as never,
      onStateChange: () => {},
      startClaudeSession: async () => ({
        provider: "claude", echoesPromptIds: true, stream: events,
        interrupt: async () => {}, close: () => {},
        setModel: async () => {}, setPermissionMode: async () => {},
        sendPrompt: async (_content: string, promptId?: string) => { promptIds.push(promptId!) },
      }),
    })
    await coordinator.send({
      type: "chat.send", chatId: "chat-1", provider: "claude", content: "first", model: "claude-opus-4-1",
    })
    await store.enqueueMessage("chat-1", {
      id: "queued-1", content: "current", attachments: [], provider: "claude", model: "claude-opus-4-1", planMode: false,
    })
    await coordinator.steer({ type: "message.steer", chatId: "chat-1", queuedMessageId: "queued-1" })
    events.push({
      type: "transcript" as const, promptIds,
      entry: timestamped({ kind: "result", subtype: "success", isError: false, durationMs: 0, result: "combined" }),
    })
    await waitFor(() => store.turnFinishedCount === 1)
    expect(store.messages.some((entry) => entry.kind === "result" && entry.result === "combined")).toBe(true)
    expect(coordinator.getActiveStatuses().has("chat-1")).toBe(false)
    events.close()
  })


  for (const staleEvent of ["terminal", "stream error"] as const) {
    test(`Claude replacement ignores the old session's late ${staleEvent}`, async () => {
      const queues = [new AsyncEventQueue<any>(), new AsyncEventQueue<any>()]
      const promptIds: string[] = []
      const closeCounts = [0, 0]
      let settleOldStream!: () => void
      const oldStreamSettled = new Promise<void>((resolve) => { settleOldStream = resolve })
      let starts = 0
      const store = createFakeStore()
      const coordinator = new AgentCoordinator({
        store: store as never,
        onStateChange: () => {},
        startClaudeSession: async () => {
          const index = starts++
          const queue = queues[index]!
          return {
            provider: "claude",
            echoesPromptIds: true,
            stream: {
              async *[Symbol.asyncIterator]() {
                try {
                  for await (const event of queue) {
                    if (event.type === "throw") throw new Error("stale stream failure")
                    yield event
                  }
                } finally {
                  if (index === 0) settleOldStream()
                }
              },
            },
            interrupt: async () => {},
            close: () => { closeCounts[index]! += 1 },
            setModel: async () => {}, setPermissionMode: async () => {},
            sendPrompt: async (_content: string, promptId?: string) => { promptIds.push(promptId!) },
          }
        },
      })
      const send = (autoPlan: boolean) => coordinator.send({
        type: "chat.send", chatId: "chat-1", provider: "claude", content: "go", model: "claude-opus-4-1", autoPlan,
      })
      const result = (index: number, content: string) => ({
        type: "transcript" as const, promptIds: [promptIds[index]!],
        entry: timestamped({ kind: "result", subtype: "success", isError: false, durationMs: 0, result: content }),
      })
      await send(false)
      queues[0]!.push(result(0, "first"))
      await waitFor(() => store.turnFinishedCount === 1)
      await send(true)
      if (staleEvent === "stream error") {
        queues[0]!.push({ type: "throw" })
      } else {
        queues[0]!.push({ type: "session_token", sessionToken: "stale-token" })
        queues[0]!.push(result(0, "stale"))
      }
      queues[0]!.close()
      await oldStreamSettled
      expect(closeCounts[0]).toBe(1)
      expect(coordinator.getActiveStatuses().get("chat-1")).toBe("running")
      expect(store.chat.sessionToken).not.toBe("stale-token")
      expect(store.messages.some((entry) => entry.kind === "result" && entry.result.includes("stale"))).toBe(false)
      queues[1]!.push(result(1, "current"))
      await waitFor(() => store.turnFinishedCount === 2)
      queues[1]!.close()
    })
  }


  test("reuses a persistent Claude session without altering user text after a model change", async () => {
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
      model: "claude-sonnet-4-5",
    })
    await waitFor(() => store.turnFinishedCount === 2)

    expect(startSessionCalls).toHaveLength(1)
    expect(startSessionCalls[0]?.planMode).toBe(false)
    expect(startSessionCalls[0]?.sessionToken).toBeNull()
    expect(prompts).toEqual(["start background task", "check task output"])
    expect(store.chat.sessionToken).toBe("claude-session-1")

    events.close()
  })


  for (const failedPhase of ["history", "readiness"] as const) {
    test(`a failed deferred Claude ${failedPhase} commit retires startup without publishing native initialization`, async () => {
      const store = createFakeStore()
      store.chat.provider = "claude"
      store.chat.sessionToken = "source-session"
      const first = timestamped({ kind: "user_prompt", content: "first" })
      const answer = timestamped({ kind: "assistant_text", messageId: "source-answer", text: "answer" })
      const target = timestamped({ kind: "user_prompt", content: "second" })
      store.messages = [first, answer, target]
      const originalMessages = [...store.messages]
      const events = new AsyncEventQueue<any>()
      let closes = 0
      let prompts = 0
      const replace = store.replaceTranscript.bind(store)
      if (failedPhase === "history") store.replaceTranscript = async () => { throw new Error("history unavailable") }
      else store.setSessionToken = async () => { throw new Error("readiness unavailable") }
      const coordinator = new AgentCoordinator({
        store: store as never, onStateChange: () => {},
        prepareClaudeSession: async (args) => ({ sessionToken: "prepared-session", transcriptPrefix: args.transcriptPrefix }),
        startClaudeSession: async () => {
          events.push({ type: "session_token", sessionToken: "native-startup-session" })
          events.push({ type: "transcript", entry: timestamped({ kind: "system_init", provider: "claude",
            model: "claude-opus-4-1", tools: [], agents: [], slashCommands: [], mcpServers: [] }) })
          return { provider: "claude", stream: events,
            interrupt: async () => {}, close: () => { closes++; events.close() },
            setModel: async () => {}, setPermissionMode: async () => {}, sendPrompt: async () => { prompts++ },
          }
        },
      })
      await expect(coordinator.editUserPrompt({ type: "chat.editUserPrompt", chatId: "chat-1", messageId: target._id,
        content: "edited" })).rejects.toThrow(`${failedPhase} unavailable`)
      expect(store.chat.sessionToken).toBe("source-session")
      expect(store.messages.some((entry) => entry.kind === "system_init")).toBe(false)
      if (failedPhase === "history") expect(store.messages).toEqual(originalMessages)
      expect(coordinator.getActiveStatuses().has("chat-1")).toBe(false)
      expect(coordinator.claudeSessions.has("chat-1")).toBe(false)
      expect(closes).toBe(1)
      expect(prompts).toBe(0)
      store.replaceTranscript = replace
    })
  }


  for (const streamEnd of ["closed", "failed"] as const) {
    test(`a ${streamEnd} provisional Claude stream cannot publish before a deferred history failure`, async () => {
      const store = createFakeStore()
      store.chat.provider = "claude"
      store.chat.sessionToken = "source-session"
      const target = timestamped({ kind: "user_prompt", content: "first" })
      store.messages = [target]
      const history = readinessGate()
      const historyStarted = readinessGate()
      const iterated = readinessGate()
      let closes = 0
      let failures = 0
      let prompts = 0
      store.replaceTranscript = async () => { historyStarted.release(); await history.ready; throw new Error("history unavailable") }
      store.recordTurnFailed = async () => { failures++ }
      const coordinator = new AgentCoordinator({ store: store as never, onStateChange: () => {},
        startClaudeSession: async () => ({ provider: "claude",
          stream: { async *[Symbol.asyncIterator]() { iterated.release(); if (streamEnd === "failed") throw new Error("native stream failed") } },
          interrupt: async () => {}, close: () => { closes++ }, setModel: async () => {}, setPermissionMode: async () => {},
          sendPrompt: async () => { prompts++ },
        }),
      })
      const edit = coordinator.editUserPrompt({ type: "chat.editUserPrompt", chatId: "chat-1", messageId: target._id, content: "edited" })
      try {
        await Promise.all([historyStarted.ready, iterated.ready])
        expect(coordinator.getActiveStatuses().get("chat-1")).toBe("starting")
        expect(store.messages).toEqual([target])
        history.release()
        await expect(edit).rejects.toThrow("history unavailable")
        expect(store.messages).toEqual([target])
        expect(store.chat.sessionToken).toBe("source-session")
        expect(failures).toBe(0)
        expect(prompts).toBe(0)
        expect(closes).toBe(1)
        expect(coordinator.claudeSessions.has("chat-1")).toBe(false)
      } finally { history.release(); await edit.catch(() => {}) }
    })
  }


  for (const streamEnd of ["closed", "failed"] as const) {
    test(`a ${streamEnd} provisional Claude stream preserves source history even when its history write succeeds`, async () => {
      const store = createFakeStore()
      store.chat.provider = "claude"
      store.chat.sessionToken = "source-session"
      const target = timestamped({ kind: "user_prompt", content: "first" })
      store.messages = [target, timestamped({ kind: "assistant_text", text: "original answer" })]
      const original = [...store.messages]
      const history = readinessGate()
      const historyStarted = readinessGate()
      const die = readinessGate()
      const ended = readinessGate()
      const replace = store.replaceTranscript.bind(store)
      let writes = 0
      store.replaceTranscript = async (chatId, entries) => {
        if (++writes === 1) { historyStarted.release(); await history.ready }
        await replace(chatId, entries)
      }
      let prompts = 0
      const coordinator = new AgentCoordinator({ store: store as never, onStateChange: () => {},
        startClaudeSession: async () => ({ provider: "claude",
          stream: { async *[Symbol.asyncIterator]() {
            await die.ready
            ended.release()
            if (streamEnd === "failed") throw new Error("native startup failed")
          } },
          interrupt: async () => {}, close: () => {}, setModel: async () => {}, setPermissionMode: async () => {},
          sendPrompt: async () => { prompts++ },
        }),
      })
      const edit = coordinator.editUserPrompt({ type: "chat.editUserPrompt", chatId: "chat-1", messageId: target._id, content: "edited" })
      try {
        await historyStarted.ready
        die.release()
        await ended.ready
        await new Promise(resolve => setTimeout(resolve, 0))
        history.release()
        await expect(edit).rejects.toThrow(streamEnd === "failed" ? "native startup failed" : "ended before")
        expect(store.messages).toEqual(original)
        expect(store.chat.sessionToken).toBe("source-session")
        expect(prompts).toBe(0)
        expect(coordinator.getActiveStatuses().has("chat-1")).toBe(false)
        expect(coordinator.claudeSessions.has("chat-1")).toBe(false)
      } finally { die.release(); history.release(); await edit.catch(() => {}) }
    })
  }


  for (const streamEnd of ["closed", "failed"] as const) {
    for (const stop of [undefined, "cancel", "close", "dispose"] as const) {
      test(`a ${streamEnd} provisional Claude edit restores its turn count through restart${stop ? ` with ${stop} during rollback` : ""}`, async () => {
        const dir = fakeStoreDirectory()
        const store = new EventStore(dir)
        await store.initialize()
        const project = await store.openProject(dir)
        const chat = await store.createChat(project.id)
        await store.renameChat(chat.id, "Existing conversation")
        await store.setChatProvider(chat.id, "claude")
        await store.setSessionToken(chat.id, "source-session")
        await store.recordTurnStarted(chat.id, undefined, { turnCount: 7 })
        const target = timestamped({ kind: "user_prompt", content: "original" })
        const original = [target, timestamped({ kind: "assistant_text", text: "original answer" })]
        await store.replaceTranscript(chat.id, original)
        const rollbackWritten = readinessGate()
        const rollback = readinessGate()
        const replace = store.replaceTranscript.bind(store)
        let writes = 0
        store.replaceTranscript = async (...args) => {
          await replace(...args)
          if (++writes === 2 && stop) { rollbackWritten.release(); await rollback.ready }
        }
        const countWritten = readinessGate()
        const publication = readinessGate()
        const die = readinessGate()
        const ended = readinessGate()
        const record = store.recordTurnStarted.bind(store)
        store.recordTurnStarted = async (...args) => { await record(...args); countWritten.release(); await publication.ready }
        let prompts = 0
        const coordinator = new AgentCoordinator({ store, onStateChange: () => {},
          startClaudeSession: async () => ({ provider: "claude", startupOutcome: { kind: "resumed" },
            stream: { async *[Symbol.asyncIterator]() {
              await die.ready
              ended.release()
              if (streamEnd === "failed") throw new Error("native startup failed")
            } },
            interrupt: async () => {}, close: () => {}, setModel: async () => {}, setPermissionMode: async () => {},
            sendPrompt: async () => { prompts++ },
          }),
        })
        const edit = coordinator.editUserPrompt({ type: "chat.editUserPrompt", chatId: chat.id, messageId: target._id, content: "edited" })
        void edit.catch(() => {})
        try {
          await countWritten.ready
          expect(store.requireChat(chat.id).turnCount).toBe(1)
          die.release()
          await ended.ready
          await new Promise(resolve => setTimeout(resolve, 0))
          publication.release()
          if (stop) {
            await rollbackWritten.ready
            if (stop === "cancel") await coordinator.cancel(chat.id)
            else if (stop === "close") await coordinator.closeChat(chat.id)
            else coordinator.dispose()
            rollback.release()
          }
          await expect(edit).rejects.toThrow(stop ? "cancelled or replaced" : streamEnd === "failed" ? "native startup failed" : "ended before")
          const expectedTranscript = stop === "cancel"
            ? [...original, expect.objectContaining({ kind: "interrupted" })] : original
          expect(store.getMessages(chat.id)).toEqual(expectedTranscript)
          expect(store.requireChat(chat.id).sessionToken).toBe("source-session")
          expect(store.requireChat(chat.id).turnCount).toBe(7)
          expect(prompts).toBe(0)
          const reloaded = new EventStore(dir)
          await reloaded.initialize()
          expect(reloaded.getMessages(chat.id)).toEqual(expectedTranscript)
          expect(reloaded.requireChat(chat.id).turnCount).toBe(7)
        } finally { die.release(); publication.release(); rollback.release(); await edit.catch(() => {}); coordinator.dispose() }
      })
    }
  }


  test("a deferred first Claude edit holds native token and init publication until its history commits", async () => {
    const store = createFakeStore()
    store.chat.provider = "claude"
    store.chat.sessionToken = "source-session"
    const target = timestamped({ kind: "user_prompt", content: "first" })
    store.messages = [target, timestamped({ kind: "assistant_text", text: "original answer", messageId: "source-answer" })]
    const originalMessages = [...store.messages]
    const history = readinessGate()
    const historyStarted = readinessGate()
    const tokenObserved = readinessGate()
    const replace = store.replaceTranscript.bind(store)
    store.replaceTranscript = async (chatId, entries) => { historyStarted.release(); await history.ready; await replace(chatId, entries) }
    let prompts = 0
    const events = new AsyncEventQueue<any>()
    const assigned: Array<string | null> = []
    store.setSessionToken = async (_chatId, token) => { assigned.push(token); store.chat.sessionToken = token }
    const coordinator = new AgentCoordinator({ store: store as never, onStateChange: () => {},
      startClaudeSession: async () => ({ provider: "claude", echoesPromptIds: true,
        stream: { async *[Symbol.asyncIterator]() {
          tokenObserved.release()
          yield { type: "session_token" as const, sessionToken: "native-session" }
          yield { type: "transcript" as const, entry: timestamped({ kind: "system_init", provider: "claude",
            model: "claude-opus-4-1", tools: [], agents: [], slashCommands: [], mcpServers: [] }) }
          yield* events
        } },
        interrupt: async () => {}, close: () => events.close(), setModel: async () => {}, setPermissionMode: async () => {},
        sendPrompt: async (_content, promptId) => { prompts++; events.push({ type: "transcript", promptIds: [promptId],
          entry: timestamped({ kind: "result", subtype: "success", isError: false, durationMs: 0, result: "done" }) }) },
      }),
    })
    const edit = coordinator.editUserPrompt({ type: "chat.editUserPrompt", chatId: "chat-1", messageId: target._id, content: "edited" })
    try {
      await Promise.all([historyStarted.ready, tokenObserved.ready])
      expect(store.messages).toEqual(originalMessages)
      expect(store.chat.sessionToken).toBe("source-session")
      expect(assigned).toEqual([])
      expect(prompts).toBe(0)
      expect(coordinator.getActiveStatuses().get("chat-1")).toBe("starting")
      history.release()
      await edit
      await waitFor(() => store.turnFinishedCount === 1)
      expect(assigned).toEqual(["native-session"])
      expect(store.messages[0]).toMatchObject({ kind: "user_prompt", content: "edited" })
      expect(store.messages.some((entry) => entry.kind === "system_init")).toBe(true)
    } finally { history.release(); await edit.catch(() => {}); events.close() }
  })


  for (const blockedPhase of ["history", "readiness"] as const) {
    test(`cancellation during deferred Claude ${blockedPhase} drains before a successor and skips stale work`, async () => {
      const store = createFakeStore()
      store.chat.provider = "claude"
      store.chat.pendingForkSessionToken = "source-session"
      store.chat.pendingForkResumeAt = "source-answer"
      store.messages = [timestamped({ kind: "user_prompt", content: "first" }),
        timestamped({ kind: "assistant_text", text: "answer", messageId: "source-answer" })]
      const commit = readinessGate()
      const commitStarted = readinessGate()
      const replace = store.replaceTranscript.bind(store)
      let replaced = 0
      store.replaceTranscript = async (chatId, entries) => {
        if (blockedPhase === "history" && ++replaced === 1) { commitStarted.release(); await commit.ready }
        await replace(chatId, entries)
      }
      let assigned = 0
      store.setSessionToken = async (_chatId, token) => {
        if (blockedPhase === "readiness" && ++assigned === 1) { commitStarted.release(); await commit.ready }
        store.chat.sessionToken = token
      }
      const queues: AsyncEventQueue<any>[] = []
      const prompts: string[] = []
      const closes: number[] = []
      const starts: Array<string | null> = []
      const coordinator = new AgentCoordinator({ store: store as never, onStateChange: () => {},
        prepareClaudeSession: async (args) => ({ sessionToken: `prepared-${starts.length + 1}`, transcriptPrefix: args.transcriptPrefix }),
        startClaudeSession: async (args) => {
          starts.push(args.sessionToken)
          const index = starts.length
          const events = new AsyncEventQueue<any>()
          queues.push(events)
          events.push({ type: "session_token", sessionToken: args.sessionToken })
          return { provider: "claude", stream: events,
            interrupt: async () => {}, close: () => { closes.push(index); events.close() },
            setModel: async () => {}, setPermissionMode: async () => {},
            sendPrompt: async (content) => { prompts.push(content.split("\n\n")[0]!) },
          }
        },
      })
      const cancelled = coordinator.send({ type: "chat.send", chatId: "chat-1", provider: "claude", content: "cancelled" })
      let successor: ReturnType<typeof coordinator.send> | undefined
      try {
        await commitStarted.ready
        await coordinator.cancel("chat-1")
        successor = coordinator.send({ type: "chat.send", chatId: "chat-1", provider: "claude", content: "successor" })
        await waitFor(() => (coordinator as any).startingClaudeTurns.has("chat-1"))
        expect(starts).toHaveLength(1)
        commit.release()
        await Promise.all([cancelled, successor])
        expect(starts).toHaveLength(2)
        expect(prompts).toEqual(["successor"])
        expect(closes).toEqual([1])
        expect(store.chat.sessionToken).toBe("prepared-2")
        expect(coordinator.getActiveStatuses().get("chat-1")).toBe("running")
      } finally { commit.release(); await cancelled.catch(() => {}); await successor?.catch(() => {}); for (const queue of queues) queue.close() }
    })
  }


  test("a Claude edit preserves its source while the native initialize handshake fails", async () => {
    const store = createFakeStore()
    store.chat.provider = "claude"
    store.chat.sessionToken = "source-session"
    const target = timestamped({ kind: "user_prompt", content: "original" })
    store.messages = [target]
    const handshake = readinessGate()
    const handshakeStarted = readinessGate()
    let prompts = 0
    let closes = 0
    const events = new AsyncEventQueue<any>()
    const coordinator = new AgentCoordinator({ store: store as never, onStateChange: () => {},
      startClaudeSession: async () => ({ provider: "claude", stream: events,
        waitUntilReady: async () => { handshakeStarted.release(); await handshake.ready; throw new Error("initialize failed") },
        interrupt: async () => {}, close: () => { closes++; events.close() },
        setModel: async () => {}, setPermissionMode: async () => {}, sendPrompt: async () => { prompts++ },
      }),
    })
    const edit = coordinator.editUserPrompt({ type: "chat.editUserPrompt", chatId: "chat-1", messageId: target._id, content: "edited" })
    try {
      await Promise.race([handshakeStarted.ready, edit])
      expect(store.messages).toEqual([target])
      expect(store.chat.sessionToken).toBe("source-session")
      handshake.release()
      await expect(edit).rejects.toThrow("initialize failed")
      expect(store.messages).toEqual([target])
      expect(store.chat.sessionToken).toBe("source-session")
      expect(prompts).toBe(0)
      expect(closes).toBe(1)
    } finally { handshake.release(); events.close(); await edit.catch(() => {}) }
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
      resumeSessionAt?: string
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

    expect(prepareSessionCalls).toMatchObject([{
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
      resumeSessionAt?: string
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

    expect(prepareSessionCalls).toMatchObject([{
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
      resumeSessionAt?: string
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
      model: "opus[1m]",
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


  test.each(["text", "tool_use"])("skips normalized Claude child %s boundaries for edits and forks", async (childKind) => {
    const store = createForkableFakeStore("claude", { title: "Claude Debug", sessionToken: "source-session" })
    const prompt = timestamped({ kind: "user_prompt", content: "second task" })
    store.setMessages("chat-1", [
      timestamped({ kind: "user_prompt", content: "first task" }),
      ...normalizeClaudeStreamMessage({ type: "assistant", uuid: "main-answer", session_id: "source-session",
        message: { content: [{ type: "text", text: "answer" }] } }),
      ...normalizeClaudeStreamMessage({ type: "assistant", uuid: "child-answer", session_id: "source-session",
        parent_tool_use_id: "agent-tool", message: { content: [childKind === "text"
          ? { type: "text", text: "child answer" }
          : { type: "tool_use", name: "Read", id: "child-read", input: { file_path: "file" } }] } }),
      prompt,
    ])
    const prepared: string[] = []
    const coordinator = new AgentCoordinator({ store: store as never, onStateChange: () => {},
      prepareClaudeSession: async (args) => { prepared.push(args.resumeSessionAt!); return "prepared" },
      startClaudeSession: async () => { throw new Error("boot failed") },
    })
    await coordinator.forkChat({ type: "chat.fork", chatId: "chat-1", messageId: prompt._id })
    expect(store.requireChat("chat-fork-1").pendingForkResumeAt).toBe("main-answer")
    await expect(coordinator.editUserPrompt({ type: "chat.editUserPrompt", chatId: "chat-1",
      messageId: prompt._id, content: "edit" })).rejects.toThrow("boot failed")
    expect(prepared).toEqual(["main-answer"])
  })


  test.each([
    { childKind: "text", metadata: { isSidechain: true } },
    { childKind: "tool_use", metadata: { isSidechain: true } },
    { childKind: "text", metadata: { subagent_type: "Explore" } },
    { childKind: "tool_use", metadata: { subagent_type: "Explore" } },
  ])("skips normalized Claude child boundaries without a parent tool id (%j)", async ({ childKind, metadata }) => {
    const store = createForkableFakeStore("claude", { title: "Claude Debug", sessionToken: "source-session" })
    const prompt = timestamped({ kind: "user_prompt", content: "second task" })
    const children = normalizeClaudeStreamMessage({ type: "assistant", uuid: "child-answer", session_id: "source-session",
      ...metadata, message: { content: [childKind === "text" ? { type: "text", text: "child answer" }
        : { type: "tool_use", name: "Read", id: "child-read", input: { file_path: "file" } }] } })
    expect(children).toHaveLength(1)
    expect(children[0]).toMatchObject({ claudeSidechain: true })
    expect(children[0]?.parentToolUseId).toBeUndefined()
    expect(children[0]?.debugRaw).toBeUndefined()
    store.setMessages("chat-1", [timestamped({ kind: "user_prompt", content: "first task" }),
      ...normalizeClaudeStreamMessage({ type: "assistant", uuid: "main-answer", session_id: "source-session",
        message: { content: [{ type: "text", text: "main answer" }] } }), ...children, prompt])
    const prepared: string[] = []
    const coordinator = new AgentCoordinator({ store: store as never, onStateChange: () => {},
      prepareClaudeSession: async (args) => { prepared.push(args.resumeSessionAt!); return "prepared" },
      startClaudeSession: async () => { throw new Error("boot failed") },
    })
    await coordinator.forkChat({ type: "chat.fork", chatId: "chat-1", messageId: prompt._id })
    expect(store.requireChat("chat-fork-1").pendingForkResumeAt).toBe("main-answer")
    await expect(coordinator.editUserPrompt({ type: "chat.editUserPrompt", chatId: "chat-1", messageId: prompt._id,
      content: "edit" })).rejects.toThrow("boot failed")
    expect(prepared).toEqual(["main-answer"])
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
    const startedSessionTokens: Array<string | null> = []

    const coordinator = new AgentCoordinator({
      store: store as never,
      onStateChange: () => {},
      startClaudeSession: async (args) => {
        startedSessionTokens.push(args.sessionToken)
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
    expect(store.chat.sessionToken).toBe("claude-session-1")
    await expect(coordinator.send({ type: "chat.send", chatId: "chat-1", provider: "claude", content: "continue" }))
      .rejects.toThrow("Claude boot failed")
    expect(startedSessionTokens).toEqual([null, "claude-session-1"])
  })


  test("first-prompt readiness preserves a new Claude token already emitted by startup", async () => {
    const store = createFakeStore()
    store.chat.provider = "claude"
    store.chat.sessionToken = "old-session"
    const prompt = timestamped({ kind: "user_prompt", content: "original" })
    store.messages = [prompt, timestamped({ kind: "assistant_text", messageId: "old-answer", text: "old" })]
    const events = new AsyncEventQueue<any>()
    const assigned: Array<string | null> = []
    store.setSessionToken = async (_chatId, token) => { assigned.push(token); store.chat.sessionToken = token }
    const coordinator = new AgentCoordinator({
      store: store as never, onStateChange: () => {},
      startClaudeSession: async (args) => {
        expect(args.sessionToken).toBeNull()
        expect(store.chat.sessionToken).toBe("old-session")
        events.push({ type: "session_token", sessionToken: "ready-session" })
        return { provider: "claude", stream: events, getAccountInfo: async () => null,
          interrupt: async () => {}, close: () => events.close(), setModel: async () => {},
          setPermissionMode: async () => {}, sendPrompt: async () => {
            events.push({ type: "transcript", entry: timestamped({ kind: "result", subtype: "success",
              isError: false, durationMs: 0, result: "done" }) })
          } }
      },
    })
    await coordinator.editUserPrompt({ type: "chat.editUserPrompt", chatId: "chat-1", messageId: prompt._id,
      content: "replacement" })
    await waitFor(() => store.turnFinishedCount === 1)
    expect(store.chat.sessionToken).toBe("ready-session")
    expect(assigned).toEqual(["ready-session"])
    events.close()
  })


  test("publishes prepared Claude UUIDs with their owning session on repeated edits", async () => {
    const store = createFakeStore()
    store.chat.provider = "claude"
    store.chat.sessionToken = "original-session"
    const first = timestamped({ kind: "user_prompt", content: "same prompt" })
    const second = timestamped({ kind: "user_prompt", content: "same prompt" })
    const answer = timestamped({ kind: "assistant_text", messageId: "original-answer", text: "answer" })
    store.messages = [first, answer, second]
    const preparedCalls: Array<{ sessionToken: string; resumeSessionAt?: string }> = []
    const started: Array<string | null> = []
    const queues: AsyncEventQueue<any>[] = []
    const coordinator = new AgentCoordinator({
      store: store as never, onStateChange: () => {},
      prepareClaudeSession: (async (args: any) => {
        preparedCalls.push({ sessionToken: args.sessionToken, resumeSessionAt: args.resumeSessionAt })
        const sessionToken = `prepared-${preparedCalls.length}`
        return { sessionToken, transcriptPrefix: (args.transcriptPrefix ?? [first, answer]).map((entry: TranscriptEntry) =>
          entry.kind === "assistant_text"
            ? { ...entry, messageId: `mapped-${preparedCalls.length}`, claudeSessionToken: sessionToken }
            : entry) }
      }) as never,
      startClaudeSession: async (args) => {
        started.push(args.sessionToken)
        const events = new AsyncEventQueue<any>()
        queues.push(events)
        return { provider: "claude", stream: events, getAccountInfo: async () => null,
          interrupt: async () => {}, close: () => events.close(), setModel: async () => {},
          setPermissionMode: async () => {}, sendPrompt: async () => {
            events.push({ type: "transcript", entry: timestamped({ kind: "result", subtype: "success",
              isError: false, durationMs: 0, result: "done" }) })
          } }
      },
    })
    await coordinator.editUserPrompt({ type: "chat.editUserPrompt", chatId: "chat-1",
      messageId: second._id, content: "edit one" })
    await waitFor(() => store.turnFinishedCount === 1)
    const edited = store.messages.find((entry) => entry.kind === "user_prompt" && entry.content === "edit one")!
    await coordinator.editUserPrompt({ type: "chat.editUserPrompt", chatId: "chat-1",
      messageId: edited._id, content: "edit two" })
    await waitFor(() => store.turnFinishedCount === 2)
    expect(started).toEqual(["prepared-1", "prepared-2"])
    expect(preparedCalls).toEqual([
      { sessionToken: "original-session", resumeSessionAt: "original-answer" },
      { sessionToken: "prepared-1", resumeSessionAt: "mapped-1" },
    ])
    expect(store.messages[1]).toMatchObject({ _id: answer._id, createdAt: answer.createdAt,
      messageId: "mapped-2", claudeSessionToken: "prepared-2" })
    for (const queue of queues) queue.close()
  })


  test("maps a pending Claude fork before sending and reuses those UUIDs on another fork", async () => {
    const store = createForkableFakeStore("claude", { title: "Repeat", sessionToken: "source" })
    const answer = timestamped({ kind: "assistant_text", messageId: "a1", text: "answer" })
    const target = timestamped({ kind: "user_prompt", content: "repeat" })
    store.setMessages("chat-1", [timestamped({ kind: "user_prompt", content: "repeat" }), answer, target])
    const events = new AsyncEventQueue<any>()
    const starts: Array<{ token: string | null; fork: boolean }> = []
    const coordinator = new AgentCoordinator({
      store: store as never, onStateChange: () => {},
      prepareClaudeSession: async (args) => ({ sessionToken: "prepared-fork", transcriptPrefix:
        args.transcriptPrefix.map((entry) => entry.messageId === "a1"
          ? { ...entry, messageId: "fork-a1", claudeSessionToken: "prepared-fork" } : entry) }),
      startClaudeSession: async (args) => {
        starts.push({ token: args.sessionToken, fork: args.forkSession })
        return { provider: "claude", stream: events, getAccountInfo: async () => null,
          interrupt: async () => {}, close: () => events.close(), setModel: async () => {},
          setPermissionMode: async () => {}, sendPrompt: async () => {
            events.push({ type: "transcript", entry: timestamped({ kind: "result", subtype: "success",
              isError: false, durationMs: 0, result: "done" }) })
          } }
      },
    })
    const first = await coordinator.forkChat({ type: "chat.fork", chatId: "chat-1", messageId: target._id })
    await coordinator.send({ type: "chat.send", chatId: first.chatId, provider: "claude", content: "continue" })
    await waitFor(() => store.turnFinishedCount === 1)
    expect(starts).toEqual([{ token: "prepared-fork", fork: false }])
    const kept = store.getMessages(first.chatId)
    expect(kept[1]).toMatchObject({ _id: answer._id, createdAt: answer.createdAt,
      messageId: "fork-a1", claudeSessionToken: "prepared-fork" })
    const nextTarget = kept.find((entry) => entry.kind === "user_prompt" && entry.content.includes("continue"))!
    await coordinator.forkChat({ type: "chat.fork", chatId: first.chatId, messageId: nextTarget._id })
    expect(store.requireChat("chat-fork-1")).toMatchObject({ pendingForkSessionToken: "prepared-fork",
      pendingForkResumeAt: "fork-a1" })
    events.close()
  })


  test("keeps a pending Claude fork unchanged if native mapping fails", async () => {
    const store = createForkableFakeStore("claude", { title: "Repeat", sessionToken: "source" })
    const target = timestamped({ kind: "user_prompt", content: "repeat" })
    store.setMessages("chat-1", [timestamped({ kind: "user_prompt", content: "first" }),
      timestamped({ kind: "assistant_text", messageId: "a1", text: "answer" }), target])
    let started = false
    const coordinator = new AgentCoordinator({ store: store as never, onStateChange: () => {},
      prepareClaudeSession: async () => { throw new Error("native mapping unavailable") },
      startClaudeSession: async () => { started = true; throw new Error("unexpected provider start") },
    })
    const fork = await coordinator.forkChat({ type: "chat.fork", chatId: "chat-1", messageId: target._id })
    const before = JSON.stringify(store.getMessages(fork.chatId))
    await expect(coordinator.send({ type: "chat.send", chatId: fork.chatId, provider: "claude", content: "continue" }))
      .rejects.toThrow("native mapping unavailable")
    expect(started).toBe(false)
    expect(JSON.stringify(store.getMessages(fork.chatId))).toBe(before)
    expect(store.requireChat(fork.chatId)).toMatchObject({ sessionToken: null, pendingForkSessionToken: "source",
      pendingForkResumeAt: "a1", pendingForkUserPrompt: true })
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


  test("prepared Claude edits check their own artifact and retain the source on failed startup", async () => {
    const store = createFakeStore()
    store.chat.provider = "claude"
    store.chat.sessionToken = "source-session"
    const prompt = timestamped({ kind: "user_prompt", content: "second task" })
    store.messages = [
      timestamped({ kind: "user_prompt", content: "first task" }),
      timestamped({ kind: "assistant_text", text: "answer", messageId: "main-answer" }),
      prompt,
    ]
    const originalMessages = [...store.messages]
    const checkedTokens: Array<string | null | undefined> = []
    const startedTokens: Array<string | null> = []
    const coordinator = new AgentCoordinator({
      store: store as never, onStateChange: () => {},
      checkSessionArtifact: (_provider, args) => { checkedTokens.push(args.sessionToken); return "missing" },
      prepareClaudeSession: async () => "prepared-session",
      startClaudeSession: async (args) => { startedTokens.push(args.sessionToken); throw new Error("boot failed") },
    })
    await expect(coordinator.editUserPrompt({ type: "chat.editUserPrompt", chatId: "chat-1",
      messageId: prompt._id, content: "edit" })).rejects.toThrow("boot failed")
    expect(checkedTokens).toEqual(["prepared-session"])
    expect(startedTokens).toEqual([null])
    expect(store.chat.sessionToken).toBe("source-session")
    expect(store.messages).toEqual(originalMessages)
  })


  test("send waits for a cancelled history publication before inspecting history state", async () => {
    const store = createFakeStore()
    store.chat.provider = "claude"
    let release!: () => void
    const pendingPublication = new Promise<void>(resolve => { release = resolve })
    const events = new AsyncEventQueue<any>()
    const prompts: string[] = []
    const coordinator = new AgentCoordinator({ store: store as never, onStateChange: () => {},
      startClaudeSession: async () => ({ provider: "claude", stream: events,
        interrupt: async () => {}, close: () => events.close(),
        setModel: async () => {}, setPermissionMode: async () => {},
        sendPrompt: async content => { prompts.push(content.split("\n\n")[0]!) },
      }),
    })
    // Cancellation releases the active turn before an owned durable write settles.
    // Keep the publication and history locks until the source is restored.
    const state = coordinator as any
    state.claudeReadinessCommits.set("chat-1", pendingPublication)
    state.historyOperations.set("chat-1", { cancelled: true })
    let rejected: unknown
    const successor = coordinator.send({ type: "chat.send", chatId: "chat-1", provider: "claude", content: "successor" })
    void successor.catch(error => { rejected = error })
    try {
      await new Promise(resolve => setTimeout(resolve, 10))
      expect(rejected).toBeUndefined()
      expect(prompts).toEqual([])
      state.historyOperations.delete("chat-1")
      state.claudeReadinessCommits.delete("chat-1")
      release()
      await successor
      expect(prompts).toEqual(["successor"])
      expect(coordinator.getActiveStatuses().get("chat-1")).toBe("running")
    } finally {
      state.historyOperations.delete("chat-1")
      state.claudeReadinessCommits.delete("chat-1")
      release()
      await successor.catch(() => {})
      events.close()
    }
  })

})

describe("buildConcurrentAgentsNotice", () => {
  test("returns null when no other chats are running", () => {
    expect(buildConcurrentAgentsNotice([])).toBeNull()
  })

  test("lists each chat title with its transcript path inside one system-message block", () => {
    const notice = buildConcurrentAgentsNotice([
      { title: "Chat One", transcriptPath: "/tmp/transcripts/one.jsonl" },
      { title: "Chat Two", transcriptPath: "/tmp/transcripts/two.jsonl" },
    ])
    expect(notice?.startsWith("<system-message>")).toBe(true)
    expect(notice?.endsWith("</system-message>")).toBe(true)
    expect(notice).toContain("there are other agents working in the current directory")
    expect(notice).toContain("Chat One: /tmp/transcripts/one.jsonl")
    expect(notice).toContain("Chat Two: /tmp/transcripts/two.jsonl")
  })
})

describe("concurrent agents notice injection", () => {
  function createTwoChatCoordinator(store: ReturnType<typeof createFakeStore>) {
    const queues: AsyncEventQueue<any>[] = []
    const prompts: string[] = []
    const coordinator = new AgentCoordinator({
      store: store as never,
      onStateChange: () => {},
      startClaudeSession: async () => {
        const events = new AsyncEventQueue<any>()
        queues.push(events)
        return {
          provider: "claude" as const,
          stream: events,
          getAccountInfo: async () => null,
          interrupt: async () => {},
          close: () => {},
          setModel: async () => {},
          setPermissionMode: async () => {},
          sendPrompt: async (content: string) => {
            prompts.push(content)
          },
        }
      },
    })
    return { coordinator, prompts, close: () => queues.forEach((queue) => queue.close()) }
  }

  test("appends the notice to the wire prompt when another chat runs in the same directory", async () => {
    const store = createFakeStore({
      chats: [
        createFakeChat("chat-1", "project-1", "Fix login bug"),
        createFakeChat("chat-2", "project-1", "Chat Two"),
      ],
      projects: [{ id: "project-1", localPath: "/tmp/project" }],
    })
    const { coordinator, prompts, close } = createTwoChatCoordinator(store)

    await coordinator.send({ type: "chat.send", chatId: "chat-1", provider: "claude", content: "first prompt", model: "claude-opus-4-1" })
    await coordinator.send({ type: "chat.send", chatId: "chat-2", provider: "claude", content: "second prompt", model: "claude-opus-4-1" })

    expect(prompts).toHaveLength(2)
    // chat-1 started alone — no automatic instructions.
    expect(prompts[0]).toBe("first prompt")
    // chat-2 started while chat-1 was running in the same directory.
    expect(prompts[1]?.startsWith("second prompt")).toBe(true)
    expect(prompts[1]).toContain("there are other agents working in the current directory")
    expect(prompts[1]).toContain("Fix login bug: /tmp/transcripts/chat-1.jsonl")
    expect(prompts[1]).not.toContain("Chat Two:")

    // The transcript keeps the user's typed text verbatim — wire-only injection.
    const userPrompts = store.messages.filter((entry) => entry.kind === "user_prompt")
    expect(userPrompts.map((entry) => (entry as { content: string }).content)).toEqual([
      "first prompt",
      "second prompt",
    ])

    close()
  })

  test("does not append the notice when the other running chat is in a different directory", async () => {
    const store = createFakeStore({
      chats: [
        createFakeChat("chat-1", "project-1", "Chat One"),
        createFakeChat("chat-2", "project-2", "Chat Two"),
      ],
      projects: [
        { id: "project-1", localPath: "/tmp/project-a" },
        { id: "project-2", localPath: "/tmp/project-b" },
      ],
    })
    const { coordinator, prompts, close } = createTwoChatCoordinator(store)

    await coordinator.send({ type: "chat.send", chatId: "chat-1", provider: "claude", content: "first prompt", model: "claude-opus-4-1" })
    await coordinator.send({ type: "chat.send", chatId: "chat-2", provider: "claude", content: "second prompt", model: "claude-opus-4-1" })

    expect(prompts).toEqual(["first prompt", "second prompt"])

    close()
  })
})

describe("skill mentions", () => {
  test("claude expands the leading skill itself; later ones get the failsafe", async () => {
    const projectDir = mkdtempSync(path.join(tmpdir(), "kanna-skill-mentions-"))
    for (const name of ["review", "simplify"]) {
      mkdirSync(path.join(projectDir, ".claude", "skills", name), { recursive: true })
      writeFileSync(path.join(projectDir, ".claude", "skills", name, "SKILL.md"), `---\nname: ${name}\n---\n`)
    }
    const store = createFakeStore({
      chats: [createFakeChat("chat-1", "project-1", "Chat One")],
      projects: [{ id: "project-1", localPath: projectDir }],
    })
    const queues: AsyncEventQueue<any>[] = []
    const prompts: string[] = []
    const coordinator = new AgentCoordinator({
      store: store as never,
      onStateChange: () => {},
      startClaudeSession: async () => {
        const events = new AsyncEventQueue<any>()
        queues.push(events)
        return {
          provider: "claude" as const,
          stream: events,
          getAccountInfo: async () => null,
          interrupt: async () => {},
          close: () => {},
          setModel: async () => {},
          setPermissionMode: async () => {},
          sendPrompt: async (content: string) => {
            prompts.push(content)
          },
        }
      },
    })

    const content = "/review this, then /simplify it and read /etc/hosts"
    await coordinator.send({ type: "chat.send", chatId: "chat-1", provider: "claude", content, model: "claude-opus-4-1" })

    expect(prompts).toHaveLength(1)
    expect(prompts[0]?.startsWith(content)).toBe(true)
    const simplifyPath = path.join(projectDir, ".claude", "skills", "simplify", "SKILL.md")
    expect(prompts[0]).toContain(
      `<system-message>the user would like to use the skill available at ${simplifyPath}</system-message>`
    )
    expect(prompts[0]).not.toContain("skills/review/SKILL.md")

    queues.forEach((queue) => queue.close())
    rmSync(projectDir, { recursive: true, force: true })
  })

  test("codex sends every $skill as a structured item and keeps slash commands separate", async () => {
    const store = createFakeStore()
    store.chat.provider = "codex"
    store.chat.sessionToken = "thread-1"
    const turns: Array<{ content: string; skills?: Array<{ name: string; path: string }> }> = []
    const coordinator = new AgentCoordinator({
      store: store as never,
      onStateChange: () => {},
      codexManager: {
        async startSession() {
          return { sessionToken: "thread-1", resumeFellBack: false }
        },
        async listSkills() {
          return [
            { name: "review", description: "Review", path: "/skills/review/SKILL.md", scope: "user", enabled: true },
            { name: "template-bridge:verify", description: "Verify", path: "/plugins/template-bridge/verify/SKILL.md", scope: "user", enabled: true },
          ]
        },
        async startTurn(args: { content: string; skills?: Array<{ name: string; path: string }> }): Promise<HarnessTurn> {
          turns.push({ content: args.content, skills: args.skills })
          async function* stream() {
            yield {
              type: "transcript" as const,
              entry: timestamped({ kind: "result", subtype: "success", isError: false, durationMs: 0, result: "done" }),
            }
          }
          return { provider: "codex", stream: stream(), interrupt: async () => {}, close: () => {} }
        },
      } as never,
    })

    const content = "Use $review and $template-bridge:verify, then mention $review again; do not run /compact"
    await coordinator.send({ type: "chat.send", chatId: "chat-1", provider: "codex", content, model: "gpt-5.4" })
    await waitFor(() => store.turnFinishedCount === 1)

    expect(turns).toHaveLength(1)
    expect(turns[0]?.content.startsWith(content)).toBe(true)
    expect(turns[0]?.skills).toEqual([
      { name: "review", path: "/skills/review/SKILL.md" },
      { name: "template-bridge:verify", path: "/plugins/template-bridge/verify/SKILL.md" },
    ])
  })
})

describe("mid-conversation provider switch", () => {
  function createSwitchFixture() {
    const chat = createFakeChat("chat-1", "project-1", "Fix login bug")
    chat.provider = "claude"
    chat.sessionToken = "claude-session-1"
    chat.pendingForkSessionToken = "claude-fork-1"
    const store = createFakeStore({ chats: [chat] })
    store.messages.push(
      timestamped({ kind: "user_prompt", content: "fix the login bug" }),
      timestamped({ kind: "assistant_text", text: "Fixed it." }),
    )

    const sentContents: string[] = []
    const stoppedCodexSessions: string[] = []
    const fakeCodexManager = {
      async readPromptHistory() {
        return { inputs: store.messages.filter((entry) => entry.kind === "user_prompt").map((entry, i) => ({
          turnId: `native-${i}`, userIndex: 0, promptId: entry._id, text: (entry as { content: string }).content,
        })) }
      },
      // Accepted native sessions always expose their token, including this handoff fixture.

      async startSession() {
        return { sessionToken: "codex-thread-1", resumeFellBack: false }
      },
      stopSession(chatId: string) {
        stoppedCodexSessions.push(chatId)
      },
      async startTurn(args: { content: string }): Promise<HarnessTurn> {
        sentContents.push(args.content)
        async function* stream() {
          yield { type: "session_token" as const, sessionToken: "codex-thread-1" }
          yield {
            type: "transcript" as const,
            entry: timestamped({ kind: "result", subtype: "success", isError: false, durationMs: 0, result: "" }),
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

    const coordinator = new AgentCoordinator({
      store: store as never,
      onStateChange: () => {},
      codexManager: fakeCodexManager as never,
    })

    return { store, coordinator, sentContents, stoppedCodexSessions }
  }

  test("switching clears the session, marks a boundary, and prepends the handoff on the wire only", async () => {
    const { store, coordinator, sentContents, stoppedCodexSessions } = createSwitchFixture()

    await coordinator.send({
      type: "chat.send",
      chatId: "chat-1",
      provider: "codex",
      content: "keep going with codex",
      model: "gpt-5.4",
    })

    // Fresh native session on the new harness; the old one is never resumed.
    expect(store.chat.provider).toBe("codex")
    expect(store.chat.sessionToken).toBe("codex-thread-1")
    expect(store.chat.pendingForkSessionToken).toBeNull()
    expect(stoppedCodexSessions).toEqual(["chat-1"])

    // Boundary entry precedes the new user prompt and records the switch.
    const boundaryIndex = store.messages.findIndex((entry) => entry.kind === "handoff_boundary")
    const promptIndex = store.messages.findIndex(
      (entry) => entry.kind === "user_prompt" && (entry as { content: string }).content === "keep going with codex"
    )
    expect(boundaryIndex).toBeGreaterThan(-1)
    expect(promptIndex).toBeGreaterThan(boundaryIndex)
    const boundary = store.messages[boundaryIndex] as Extract<TranscriptEntry, { kind: "handoff_boundary" }>
    expect(boundary.fromProvider).toBe("claude")
    expect(boundary.toProvider).toBe("codex")
    expect(boundary.stats?.includedEntries).toBe(2)

    // Wire content leads with the handoff transcript and ends with the
    // user's prompt; the persisted prompt entry stays verbatim.
    expect(sentContents).toHaveLength(1)
    expect(sentContents[0]).toContain("<handoff_transcript>")
    expect(sentContents[0]).toContain("fix the login bug")
    expect(sentContents[0]?.endsWith("keep going with codex")).toBe(true)
    expect((store.messages[promptIndex] as { content: string }).content).toBe("keep going with codex")
  })

  test("sending with the chat's current provider does not hand off", async () => {
    const { store, coordinator, sentContents } = createSwitchFixture()

    await coordinator.send({
      type: "chat.send",
      chatId: "chat-1",
      provider: "codex",
      content: "keep going with codex",
      model: "gpt-5.4",
    })
    await waitFor(() => store.turnFinishedCount === 1)

    await coordinator.send({
      type: "chat.send",
      chatId: "chat-1",
      provider: "codex",
      content: "same harness again",
      model: "gpt-5.4",
    })

    const boundaries = store.messages.filter((entry) => entry.kind === "handoff_boundary")
    expect(boundaries).toHaveLength(1)
    expect(sentContents[1]).toBe("same harness again")
  })
})

describe("session restore on lost native session", () => {
  function createClaudeRestoreFixture(artifactStatus: SessionArtifactStatus) {
    const chat = createFakeChat("chat-1", "project-1", "Old conversation")
    chat.provider = "claude"
    chat.sessionToken = "claude-session-old"
    const store = createFakeStore({ chats: [chat] })
    store.messages.push(
      timestamped({ kind: "user_prompt", content: "earlier question" }),
      timestamped({ kind: "assistant_text", text: "earlier answer" }),
    )

    const events = new AsyncEventQueue<any>()
    const prompts: string[] = []
    const startSessionCalls: Array<{ sessionToken: string | null; forkSession: boolean }> = []
    const coordinator = new AgentCoordinator({
      store: store as never,
      onStateChange: () => {},
      checkSessionArtifact: () => artifactStatus,
      startClaudeSession: async (args) => {
        startSessionCalls.push({ sessionToken: args.sessionToken, forkSession: args.forkSession })
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
            events.push({ type: "session_token" as const, sessionToken: "claude-session-new" })
            events.push({
              type: "transcript" as const,
              entry: timestamped({ kind: "result", subtype: "success", isError: false, durationMs: 0, result: "done" }),
            })
          },
        }
      },
    })

    return { store, coordinator, events, prompts, startSessionCalls }
  }

  test("rebuilds context and marks a boundary when the Claude session file is gone", async () => {
    const { store, coordinator, events, prompts, startSessionCalls } = createClaudeRestoreFixture("missing")

    await coordinator.send({
      type: "chat.send",
      chatId: "chat-1",
      provider: "claude",
      content: "continue please",
      model: "claude-opus-4-1",
    })
    await waitFor(() => store.turnFinishedCount === 1)

    // Boundary precedes the new user prompt and records the provider + stats.
    const boundaryIndex = store.messages.findIndex((entry) => entry.kind === "session_restored")
    const promptIndex = store.messages.findIndex(
      (entry) => entry.kind === "user_prompt" && (entry as { content: string }).content === "continue please"
    )
    expect(boundaryIndex).toBeGreaterThan(-1)
    expect(promptIndex).toBeGreaterThan(boundaryIndex)
    const boundary = store.messages[boundaryIndex] as Extract<TranscriptEntry, { kind: "session_restored" }>
    expect(boundary.provider).toBe("claude")
    expect(boundary.stats?.includedEntries).toBe(2)

    // Stale token cleared; a fresh session is started (no resume, no fork).
    expect(startSessionCalls).toEqual([{ sessionToken: null, forkSession: false }])

    // Wire leads with the rebuilt transcript + restore preamble and ends with
    // the user's verbatim prompt.
    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toContain("<handoff_transcript>")
    expect(prompts[0]).toContain("restored from Kanna's saved transcript")
    expect(prompts[0]).toContain("earlier question")
    expect(prompts[0]?.endsWith("continue please")).toBe(true)
    expect((store.messages[promptIndex] as { content: string }).content).toBe("continue please")

    events.close()
  })

  test("does not restore when the session artifact status is unknown", async () => {
    const { store, coordinator, events, prompts, startSessionCalls } = createClaudeRestoreFixture("unknown")

    await coordinator.send({
      type: "chat.send",
      chatId: "chat-1",
      provider: "claude",
      content: "continue please",
      model: "claude-opus-4-1",
    })
    await waitFor(() => store.turnFinishedCount === 1)

    expect(store.messages.some((entry) => entry.kind === "session_restored")).toBe(false)
    // Normal resume with the existing token; prompt is not wrapped in a transcript.
    expect(startSessionCalls).toEqual([{ sessionToken: "claude-session-old", forkSession: false }])
    expect(prompts[0]).toBe("continue please")

    events.close()
  })

  test("marks a boundary once when codex resume falls back to a fresh thread", async () => {
    const chat = createFakeChat("chat-1", "project-1", "Old codex conversation")
    chat.provider = "codex"
    chat.sessionToken = "codex-thread-old"
    const store = createFakeStore({ chats: [chat] })
    store.messages.push(
      timestamped({ kind: "user_prompt", content: "earlier question" }),
      timestamped({ kind: "assistant_text", text: "earlier answer" }),
    )

    const sentContents: string[] = []
    let resumeFellBack = true
    const fakeCodexManager = {
      async readPromptHistory() {
        return { inputs: store.messages.filter((entry) => entry.kind === "user_prompt").map((entry, i) => ({
          turnId: `native-${i}`, userIndex: 0, promptId: entry._id, text: (entry as { content: string }).content,
        })) }
      },
      async startSession() {
        return { sessionToken: "codex-thread-new", resumeFellBack }
      },
      stopSession() {},
      async startTurn(args: { content: string }): Promise<HarnessTurn> {
        sentContents.push(args.content)
        async function* stream() {
          yield { type: "session_token" as const, sessionToken: "codex-thread-new" }
          yield {
            type: "transcript" as const,
            entry: timestamped({ kind: "result", subtype: "success", isError: false, durationMs: 0, result: "" }),
          }
        }
        return { provider: "codex", stream: stream(), interrupt: async () => {}, close: () => {} }
      },
    }

    const coordinator = new AgentCoordinator({
      store: store as never,
      onStateChange: () => {},
      codexManager: fakeCodexManager as never,
    })

    await coordinator.send({
      type: "chat.send",
      chatId: "chat-1",
      provider: "codex",
      content: "continue please",
      model: "gpt-5.4",
    })
    await waitFor(() => store.turnFinishedCount === 1)

    const boundaryIndex = store.messages.findIndex((entry) => entry.kind === "session_restored")
    const promptIndex = store.messages.findIndex(
      (entry) => entry.kind === "user_prompt" && (entry as { content: string }).content === "continue please"
    )
    expect(boundaryIndex).toBeGreaterThan(-1)
    expect(promptIndex).toBeGreaterThan(boundaryIndex)
    expect((store.messages[boundaryIndex] as Extract<TranscriptEntry, { kind: "session_restored" }>).provider).toBe("codex")
    expect(sentContents[0]).toContain("<handoff_transcript>")
    expect(sentContents[0]?.endsWith("continue please")).toBe(true)

    // Live session on the follow-up turn: resume succeeds, so no second boundary.
    resumeFellBack = false
    await coordinator.send({
      type: "chat.send",
      chatId: "chat-1",
      provider: "codex",
      content: "and again",
      model: "gpt-5.4",
    })
    await waitFor(() => store.turnFinishedCount === 2)

    expect(store.messages.filter((entry) => entry.kind === "session_restored")).toHaveLength(1)
    expect(sentContents[1]).toBe("and again")
  })
})

describe("AgentCoordinator restart resume", () => {
  test("shutdown cancels running turns and marks their chats for resume", async () => {
    const events = new AsyncEventQueue<any>()
    const fakeCodexManager = {
      async startSession() {},
      async startTurn(): Promise<HarnessTurn> {
        return {
          provider: "codex",
          stream: events,
          interrupt: async () => {},
          close: () => events.close(),
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
      content: "long running task",
    })
    await waitFor(() => coordinator.activeTurns.has("chat-1"))

    await coordinator.interruptForShutdown()

    expect(store.chat.resumePending).toBe(true)
    expect(coordinator.activeTurns.size).toBe(0)
    // The turn is still cancelled like any other, so a chat that never gets
    // resumed reads exactly as it does today.
    expect(store.messages.some((entry) => entry.kind === "interrupted")).toBe(true)
  })

  test("shutdown does not mark a chat that is waiting on the user", async () => {
    let releaseInterrupt!: () => void
    const interrupted = new Promise<void>((resolve) => {
      releaseInterrupt = resolve
    })

    const fakeCodexManager = {
      async startSession() {},
      async startTurn(args: { onToolRequest: (request: any) => Promise<unknown> }): Promise<HarnessTurn> {
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
              input: { questions: [{ question: "Provider?" }] },
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

    await coordinator.interruptForShutdown()

    // A resume would tell the model to carry on past a question nobody
    // answered, so the chat is cancelled like today and left unmarked.
    expect(store.chat.resumePending).toBeUndefined()
    expect(coordinator.activeTurns.size).toBe(0)
    expect(store.messages.some((entry) => entry.kind === "tool_result" && entry.toolId === "question-1")).toBe(true)
    expect(store.messages.some((entry) => entry.kind === "interrupted")).toBe(true)
  })

  test("a user-initiated cancel leaves no resume marker", async () => {
    const events = new AsyncEventQueue<any>()
    const fakeCodexManager = {
      async startSession() {},
      async startTurn(): Promise<HarnessTurn> {
        return {
          provider: "codex",
          stream: events,
          interrupt: async () => {},
          close: () => events.close(),
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
      content: "long running task",
    })
    await waitFor(() => coordinator.activeTurns.has("chat-1"))

    await coordinator.cancel("chat-1")

    expect(store.chat.resumePending).toBeUndefined()
  })

  test("resuming an interrupted turn sends a wire-only continuation, not a user prompt", async () => {
    const events = new AsyncEventQueue<any>()
    const prompts: string[] = []
    const store = createFakeStore()
    store.chat.provider = "claude"
    store.chat.sessionToken = "session-1"
    store.chat.resumePending = true
    store.chat.lastModel = "opus"

    const coordinator = new AgentCoordinator({
      store: store as never,
      onStateChange: () => {},
      checkSessionArtifact: () => "present" as SessionArtifactStatus,
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

    expect(await coordinator.resumeInterruptedTurn("chat-1")).toBe(true)

    expect(prompts).toEqual([RESUME_AFTER_RESTART_MESSAGE])
    // Nobody typed anything, so nothing lands in the transcript as if they had.
    expect(store.messages.some((entry) => entry.kind === "user_prompt")).toBe(false)
    expect(coordinator.activeTurns.has("chat-1")).toBe(true)
  })

  test("does not resume a chat with no session to resume into", async () => {
    const store = createFakeStore()
    store.chat.provider = "claude"
    store.chat.resumePending = true

    const coordinator = new AgentCoordinator({
      store: store as never,
      onStateChange: () => {},
      startClaudeSession: async () => {
        throw new Error("Should not start a session")
      },
    })

    expect(await coordinator.resumeInterruptedTurn("chat-1")).toBe(false)
    expect(store.messages).toEqual([])
  })
})

function createFakeChat(id: string, projectId: string, title = "New Chat") {
  return {
    id,
    projectId,
    title,
    provider: null as AgentProvider | null,
    model: null as string | null,
    modelOptions: null as any,
    planMode: false,
    autoPlan: false,
    sessionToken: null as string | null,
    pendingForkSessionToken: null as string | null,
    resumePending: undefined as boolean | undefined,
    lastModel: undefined as string | undefined,
    turnCount: undefined as number | undefined,
    deletedAt: undefined as number | undefined,
    pendingForkResumeAt: null as string | null,
    pendingForkUserPrompt: false,
    contextRestoration: null as ContextRestoration | null,
  }
}

function createFakeStore(options?: {
  chats?: ReturnType<typeof createFakeChat>[]
  projects?: { id: string; localPath: string }[]
}) {
  const chats = options?.chats ?? [createFakeChat("chat-1", "project-1")]
  const projects = options?.projects ?? [{ id: "project-1", localPath: "/tmp/project" }]
  const chatsById = new Map(chats.map((entry) => [entry.id, entry]))
  const projectsById = new Map(projects.map((entry) => [entry.id, entry]))
  const chat = chats[0]!
  const messageOwners = new Map<string, string>()
  function requireChat(chatId: string) {
    const found = chatsById.get(chatId)
    if (!found) throw new Error(`Chat not found: ${chatId}`)
    return found
  }
  return {
    dataDir: fakeStoreDirectory(),
    chat,
    turnFinishedCount: 0,
    turnStartedCounts: [] as Array<number | undefined>,
    messages: [] as TranscriptEntry[],
    queuedMessages: [] as any[],
    requireChat,
    getChat(chatId: string) {
      return chatsById.get(chatId) ?? null
    },
    getProject(projectId: string) {
      return projectsById.get(projectId) ?? null
    },
    getTranscriptPath(chatId: string) {
      return `/tmp/transcripts/${chatId}.jsonl`
    },
    getMessages(chatId = chat.id) {
      return chats.length === 1 ? this.messages : this.messages.filter(entry => (messageOwners.get(entry._id) ?? chat.id) === chatId)
    },
    getPromptHistoryEntries(chatId = chat.id) {return this.messages.filter(entry => (messageOwners.get(entry._id) ?? chat.id) === chatId)},
    getEntryIdAt(chatId:string,index:number) {return this.messages.filter(entry => (messageOwners.get(entry._id) ?? chat.id) === chatId)[index]?._id??null},
    getTranscriptLength(chatId = chat.id) { return this.messages.filter(entry => (messageOwners.get(entry._id) ?? chat.id) === chatId).length },
    hasUserPrompt(chatId: string, messageId: string) { return this.messages.some(entry => (messageOwners.get(entry._id) ?? chat.id) === chatId && entry.kind === "user_prompt" && entry._id === messageId) },
    getContextBounds(chatId = chat.id) {
      const entries = this.messages.filter(entry => (messageOwners.get(entry._id) ?? chat.id) === chatId)
      let start = 0
      entries.forEach((entry, index) => { if (entry.kind === "context_cleared") start = index + 1 })
      return { start, endExclusive: entries.length, hasConversation: entries.slice(start).some(entry => ["user_prompt", "assistant_text", "tool_call", "tool_result"].includes(entry.kind)) }
    },
    async setContextRestoration(chatId: string, restoration: any) { (requireChat(chatId) as any).contextRestoration = restoration },
    async acknowledgeContextRestoration(chatId: string, id: string) { const chat = requireChat(chatId) as any; if (chat.contextRestoration?.id === id) chat.contextRestoration = null },
    async setCodexHistoryIntegrity(chatId: string, integrity: any) { (requireChat(chatId) as any).codexHistoryIntegrity = structuredClone(integrity) },
    async setChatProvider(chatId: string, provider: AgentProvider) {
      requireChat(chatId).provider = provider
    },
    async setPlanMode(chatId: string, planMode: boolean) {
      requireChat(chatId).planMode = planMode
    },
    async setAutoPlan(chatId: string, autoPlan: boolean) {
      requireChat(chatId).autoPlan = autoPlan
    },
    async setChatModelSettings(chatId: string, settings: { model: string | null; modelOptions: any }) {
      requireChat(chatId).model = settings.model
      requireChat(chatId).modelOptions = settings.modelOptions
    },
    async renameChat(chatId: string, title: string) {
      requireChat(chatId).title = title
    },
    async appendMessage(chatId: string, entry: TranscriptEntry) {
      messageOwners.set(entry._id, chatId)
      this.messages.push(entry)
      if (entry.kind === "user_prompt" && !entry.hidden && !entry.parentToolUseId)
        (requireChat(chatId) as any).promptHistoryRevision = crypto.randomUUID()
    },
    async replaceTranscript(_chatId: string, entries: TranscriptEntry[]) {
      this.messages = [...entries]
      ;(requireChat(_chatId) as any).promptHistoryRevision = crypto.randomUUID()
    },
    async recordTurnStarted(
      _chatId: string,
      _model?: string,
      options?: { turnCount?: number }
    ) {
      this.turnStartedCounts.push(options?.turnCount)
    },
    async recordTurnFinished() {
      this.turnFinishedCount += 1
    },
    async restoreTurnCount(chatId: string, turnCount: number | undefined) {
      requireChat(chatId).turnCount = turnCount
    },
    async recordTurnFailed(): Promise<void> {
      throw new Error("Did not expect turn failure")
    },
    async recordTurnCancelled() {},
    async setTurnResumePending(chatId: string, pending: boolean) {
      const target = requireChat(chatId)
      if (pending) {
        target.resumePending = true
      } else {
        delete target.resumePending
      }
    },
    async setSessionToken(chatId: string, sessionToken: string | null) {
      requireChat(chatId).sessionToken = sessionToken
    },
    async setPendingForkSessionToken(chatId: string, pendingForkSessionToken: string | null) {
      requireChat(chatId).pendingForkSessionToken = pendingForkSessionToken
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
        title: "Fork: New Chat",
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

describe("shared display tool lifecycle", () => {
  for (const provider of ["claude", "codex", "cursor", "pi"] as const) {
    test(`${provider} displays charts and attachments through the shared host`, async () => {
      const events = new AsyncEventQueue<any>()
      let host: import("./kanna-tools").KannaToolHost | undefined
      const capture = (args: { customTools?: import("./kanna-tools").KannaToolHost }) => { host = args.customTools }
      const manager = {
        async startSession(args: { customTools?: import("./kanna-tools").KannaToolHost }) { capture(args) },
        async startTurn(args: { customTools?: import("./kanna-tools").KannaToolHost }): Promise<HarnessTurn> {
          if (args.customTools) capture(args)
          return { provider, stream: events, interrupt: async () => { events.close() }, close: () => { events.close() } }
        },
      }
      const store = createFakeStore()
      const coordinator = new AgentCoordinator({
        store: store as never,
        onStateChange: () => {},
        codexManager: manager as never,
        cursorManager: manager as never,
        piManager: manager as never,
        resolvePiConnection: async () => ({ provider: "openai", baseUrl: "https://example.invalid", apiKey: "test" }),
        generateTitle: async () => ({ title: "Tool test", usedFallback: false, failureMessage: null }),
        startClaudeSession: async (args) => {
          capture(args)
          return {
            provider: "claude", stream: events,
            interrupt: async () => { events.close() }, close: () => { events.close() },
            sendPrompt: async () => {}, setModel: async () => {}, setPermissionMode: async () => {},
          }
        },
      })
      await coordinator.send({ type: "chat.send", chatId: "chat-1", provider, content: "Test tools", model: "test-model" })
      expect(host).toBeDefined()
      try {
        const chart = await host!.execute("show_chart", {
          title: "Sales", description: "Sales by month", type: "bar", data: [{ month: "Jan", sales: 10 }],
        })
        expect(chart).toMatchObject({ structuredContent: { displayed: true } })
        const attachments = await host!.execute("send_attachments", {
          attachments: [{ url: "https://example.com/report.pdf" }],
        })
        expect(attachments).toMatchObject({ structuredContent: { displayed: true } })
        expect(coordinator.getPendingTool("chat-1")).toBeNull()
        expect(store.messages.filter(entry => entry.kind === "tool_call")).toHaveLength(2)
        expect(store.messages.filter(entry => entry.kind === "tool_result")).toHaveLength(2)
      } finally {
        await coordinator.cancel("chat-1")
        events.close()
      }
    })
  }
})

describe("subagent activity", () => {
  function coordinator() {
    const store = createFakeStore()
    return new AgentCoordinator({ store: store as never, onStateChange: () => {} })
  }

  test("tracks an agent from start to stop", () => {
    const agent = coordinator()
    agent.applySubagentActivity("chat-1", { kind: "started", id: "a1", type: "subagent", label: "code-reviewer" }, 1000)

    expect(agent.getSubagents("chat-1")).toEqual([
      { id: "a1", type: "subagent", label: "code-reviewer", status: "running", startedAt: 1000 },
    ])
    expect(agent.getSubagents("chat-1").some((a) => a.status === "running")).toBe(true)

    agent.applySubagentActivity("chat-1", { kind: "stopped", id: "a1", failed: false }, 4000)
    expect(agent.getSubagents("chat-1")[0]).toMatchObject({ status: "completed", endedAt: 4000 })
    expect(agent.getSubagents("chat-1").some((a) => a.status === "running")).toBe(false)
  })

  test("the Stop sweep closes an agent whose stop hook never landed", () => {
    // The whole feature rests on a count you can believe. A killed or crashed
    // agent never fires SubagentStop, and without the sweep it would pin the
    // chat in "waiting" forever — the stuck-spinner bug in a new costume.
    const agent = coordinator()
    agent.applySubagentActivity("chat-1", { kind: "started", id: "gone", type: "subagent", label: "lost" }, 1000)
    agent.applySubagentActivity("chat-1", { kind: "started", id: "live", type: "subagent", label: "still going" }, 1000)

    agent.applySubagentActivity(
      "chat-1",
      { kind: "inFlight", ids: [{ id: "live", type: "subagent", label: "still going" }] },
      5000
    )

    const byId = new Map(agent.getSubagents("chat-1").map((entry) => [entry.id, entry]))
    expect(byId.get("gone")).toMatchObject({ status: "completed", endedAt: 5000 })
    expect(byId.get("live")).toMatchObject({ status: "running" })
    expect(agent.getSubagents("chat-1").some((a) => a.status === "running")).toBe(true)
  })

  test("the sweep discovers background work that never fired a start hook", () => {
    // A backgrounded shell or a monitor is registered on the session without a
    // SubagentStart, so Stop is the first time we hear of it. The turn is not
    // done, and the count has to say so.
    const agent = coordinator()
    agent.applySubagentActivity(
      "chat-1",
      { kind: "inFlight", ids: [{ id: "sh1", type: "shell", label: "bun test" }] },
      2000
    )

    expect(agent.getSubagents("chat-1")).toEqual([
      { id: "sh1", type: "shell", label: "bun test", status: "running", startedAt: 2000 },
    ])
  })

  test("an empty sweep ends the turn", () => {
    const agent = coordinator()
    agent.applySubagentActivity("chat-1", { kind: "started", id: "a1", type: "subagent", label: "x" }, 1000)
    agent.applySubagentActivity("chat-1", { kind: "inFlight", ids: [] }, 3000)

    expect(agent.getSubagents("chat-1").some((a) => a.status === "running")).toBe(false)
    expect(agent.getSubagents("chat-1")[0]).toMatchObject({ status: "completed", endedAt: 3000 })
  })

  test("a late stop does not reopen or re-stamp a closed agent", () => {
    const agent = coordinator()
    agent.applySubagentActivity("chat-1", { kind: "started", id: "a1", type: "subagent", label: "x" }, 1000)
    agent.applySubagentActivity("chat-1", { kind: "inFlight", ids: [] }, 3000)
    agent.applySubagentActivity("chat-1", { kind: "stopped", id: "a1", failed: true }, 9000)

    expect(agent.getSubagents("chat-1")[0]).toMatchObject({ status: "completed", endedAt: 3000 })
  })

  test("chats without delegated work stay empty", () => {
    expect(coordinator().getSubagents("chat-1")).toEqual([])
  })

  test("a monitor shows the moment it starts, not at the next Stop", () => {
    const agent = coordinator()
    agent.applySubagentActivity("chat-1", {
      kind: "started", id: "m1", type: "monitor", label: "Watch deploy", toolUseId: "toolu_m", description: "Watch deploy", stoppable: true,
    }, 1000)
    expect(agent.getSubagents("chat-1")).toEqual([{
      id: "m1", type: "monitor", label: "Watch deploy", status: "running", startedAt: 1000,
      toolUseId: "toolu_m", description: "Watch deploy", stoppable: true,
    }])

    agent.applySubagentActivity("chat-1", { kind: "stopped", id: "m1", failed: false, stopped: true }, 5000)
    expect(agent.getSubagents("chat-1")[0]).toMatchObject({ status: "stopped", endedAt: 5000 })
  })

  test("a workflow's progress replaces its agents, and ties its agents' own tasks to it", () => {
    const agent = coordinator()
    agent.applySubagentActivity("chat-1", { kind: "started", id: "w1", type: "workflow", label: "review", workflowName: "review" }, 1000)
    agent.applySubagentActivity("chat-1", { kind: "started", id: "agent-a", type: "subagent", label: "general-purpose" }, 1100)
    agent.applySubagentActivity("chat-1", {
      kind: "progress",
      id: "w1",
      usage: { totalTokens: 500, toolUses: 2 },
      workflow: {
        phases: [{ index: 1, title: "Review" }],
        agents: [
          { index: 1, label: "a", state: "running", agentId: "agent-a", phaseIndex: 1 },
          { index: 2, label: "b", state: "queued", phaseIndex: 1 },
        ],
      },
    }, 2000)

    const byId = new Map(agent.getSubagents("chat-1").map((entry) => [entry.id, entry]))
    expect(byId.get("w1")?.workflow).toEqual({
      name: "review",
      phases: [{ index: 1, title: "Review" }],
      agents: [
        { index: 1, label: "a", state: "running", agentId: "agent-a", phaseIndex: 1 },
        { index: 2, label: "b", state: "queued", phaseIndex: 1 },
      ],
    })
    expect(byId.get("w1")?.usage).toEqual({ totalTokens: 500, toolUses: 2 })
    expect(byId.get("agent-a")?.workflowId).toBe("w1")

    // An agent starting after the run named it is tied at once.
    agent.applySubagentActivity("chat-1", {
      kind: "progress",
      id: "w1",
      workflow: { phases: [], agents: [{ index: 2, label: "b", state: "running", agentId: "agent-b" }] },
    }, 3000)
    agent.applySubagentActivity("chat-1", { kind: "started", id: "agent-b", type: "subagent", label: "x" }, 3100)
    expect(agent.getSubagents("chat-1").find((entry) => entry.id === "agent-b")?.workflowId).toBe("w1")
  })

  test("a workflow first heard of mid-run is picked up from its progress", () => {
    const agent = coordinator()
    agent.applySubagentActivity("chat-1", {
      kind: "progress", id: "w1", workflow: { phases: [], agents: [{ index: 1, label: "a", state: "running" }] },
    }, 1000)
    expect(agent.getSubagents("chat-1")[0]).toMatchObject({ id: "w1", type: "workflow", status: "running", stoppable: true })
  })

  test("the notification's totals land even after task_updated closed it", () => {
    const agent = coordinator()
    agent.applySubagentActivity("chat-1", { kind: "started", id: "w1", type: "workflow", label: "review" }, 1000)
    agent.applySubagentActivity("chat-1", { kind: "stopped", id: "w1", failed: false }, 2000)
    agent.applySubagentActivity("chat-1", { kind: "stopped", id: "w1", failed: true, usage: { totalTokens: 9, toolUses: 1 }, summary: "all good" }, 3000)
    expect(agent.getSubagents("chat-1")[0]).toMatchObject({
      status: "completed", endedAt: 2000, usage: { totalTokens: 9, toolUses: 1 }, summary: "all good",
    })
  })

  test("the sweep keeps ambient tasks out", () => {
    const agent = coordinator()
    agent.applySubagentActivity("chat-1", { kind: "ambient", id: "watcher" }, 1000)
    agent.applySubagentActivity("chat-1", {
      kind: "inFlight", ids: [{ id: "watcher", type: "monitor", label: "live update" }, { id: "sh1", type: "shell", label: "bun test" }],
    }, 2000)
    expect(agent.getSubagents("chat-1").map((entry) => entry.id)).toEqual(["sh1"])
  })

  test("a start after the sweep found the task keeps when the sweep saw it start", () => {
    const agent = coordinator()
    agent.applySubagentActivity("chat-1", { kind: "inFlight", ids: [{ id: "sh1", type: "shell", label: "bun test" }] }, 1000)
    agent.applySubagentActivity("chat-1", { kind: "started", id: "sh1", type: "shell", label: "Run tests", toolUseId: "t1", stoppable: true }, 4000)
    expect(agent.getSubagents("chat-1")[0]).toMatchObject({ startedAt: 1000, label: "Run tests", toolUseId: "t1" })
  })

  test("a foreground shell gets no row unless it moves to the background", () => {
    const agent = coordinator()
    const task = { id: "sh1", type: "shell", label: "Find viewport meta tag", stoppable: true }
    agent.applySubagentActivity("chat-1", { kind: "foreground", task }, 1000)
    agent.applySubagentActivity("chat-1", { kind: "stopped", id: "sh1", failed: false }, 2000)
    expect(agent.getSubagents("chat-1")).toEqual([])
    // Its end took it off the held list, so a stray move can't raise it.
    agent.applySubagentActivity("chat-1", { kind: "backgrounded", id: "sh1" }, 2500)
    expect(agent.getSubagents("chat-1")).toEqual([])

    agent.applySubagentActivity("chat-1", { kind: "foreground", task: { ...task, id: "sh2" } }, 3000)
    agent.applySubagentActivity("chat-1", { kind: "backgrounded", id: "sh2" }, 9000)
    expect(agent.getSubagents("chat-1")).toEqual([
      { id: "sh2", type: "shell", label: "Find viewport meta tag", status: "running", startedAt: 3000, stoppable: true },
    ])
  })

  test("a Claude session's task reports reach the registry, and Stop reaches the CLI", async () => {
    const events = new AsyncEventQueue<any>()
    const stopped: string[] = []
    let report: ((update: SubagentActivityUpdate) => void) | undefined
    const store = createFakeStore()
    const coordinator = new AgentCoordinator({
      store: store as never,
      onStateChange: () => {},
      startClaudeSession: async (args) => {
        report = args.onSubagentActivity
        return {
          provider: "claude",
          stream: events,
          getAccountInfo: async () => null,
          interrupt: async () => {},
          stopTask: async (taskId: string) => { stopped.push(taskId) },
          close: () => {},
          setModel: async () => {},
          setPermissionMode: async () => {},
          sendPrompt: async () => {},
        }
      },
    })
    await coordinator.send({ type: "chat.send", projectId: "project-1", provider: "claude", content: "watch it" })
    await waitFor(() => report !== undefined)

    report!({ kind: "started", id: "m1", type: "monitor", label: "Watch deploy", stoppable: true })
    expect(coordinator.getSubagents("chat-1")[0]).toMatchObject({ id: "m1", type: "monitor", status: "running" })

    await coordinator.stopBackgroundTask("chat-1", "m1")
    expect(stopped).toEqual(["m1"])
    events.close()
  })

  test("stopping a task needs a live session that can", async () => {
    const agent = coordinator()
    agent.applySubagentActivity("chat-1", { kind: "started", id: "m1", type: "monitor", label: "Watch", stoppable: true }, 1000)
    await expect(agent.stopBackgroundTask("chat-1", "m1")).rejects.toThrow("can't be stopped")
    // Stopping something already over is a no-op, not an error.
    agent.applySubagentActivity("chat-1", { kind: "stopped", id: "m1", failed: false }, 2000)
    await agent.stopBackgroundTask("chat-1", "m1")
  })

  test("interrupting the turn closes agents still marked running", async () => {
    // An interrupt ends the turn without the Stop hook's sweep, so nothing
    // else would ever close these.
    let release!: () => void
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
          await new Promise<void>((resolve) => { release = resolve })
        }
        return { provider: "codex", stream: stream(), interrupt: async () => release(), close: () => {} }
      },
    }
    const agent = new AgentCoordinator({
      store: createFakeStore() as never,
      onStateChange: () => {},
      codexManager: fakeCodexManager as never,
    })
    await agent.send({ type: "chat.send", chatId: "chat-1", provider: "codex", content: "work" })
    await waitFor(() => agent.getActiveStatuses().get("chat-1") === "running")
    agent.applySubagentActivity("chat-1", { kind: "started", id: "a1", type: "subagent", label: "x" }, 1000)
    agent.applySubagentActivity("chat-1", { kind: "started", id: "a2", type: "subagent", label: "y" }, 1000)
    agent.applySubagentActivity("chat-1", { kind: "stopped", id: "a2", failed: false }, 2000)

    await agent.cancel("chat-1")

    const byId = new Map(agent.getSubagents("chat-1").map((entry) => [entry.id, entry]))
    expect(byId.get("a1")).toMatchObject({ status: "failed" })
    expect(byId.get("a1")?.endedAt).toBeDefined()
    // Work that already finished keeps its outcome.
    expect(byId.get("a2")).toMatchObject({ status: "completed", endedAt: 2000 })
  })
})


describe("resolveClaudeRuntimeOptions", () => {
  test("forwards SDK effort levels without extra settings", () => {
    expect(resolveClaudeRuntimeOptions("xhigh")).toEqual({
      effort: "xhigh",
      settings: undefined,
    })
    expect(resolveClaudeRuntimeOptions("max")).toEqual({
      effort: "max",
      settings: undefined,
    })
  })

  test("maps Ultracode to xhigh plus the session setting", () => {
    expect(resolveClaudeRuntimeOptions("ultracode")).toEqual({
      effort: "xhigh",
      settings: { ultracode: true },
    })
  })
})


describe("Claude background work snapshots", () => {
  test("classifies complete Stop snapshots as active or inactive", () => {
    expect(classifyClaudeBackgroundWorkState({
      background_tasks: [],
      session_crons: [],
    })).toBe("inactive")
    expect(classifyClaudeBackgroundWorkState({
      background_tasks: [{} as never],
      session_crons: [],
    })).toBe("active")
    expect(classifyClaudeBackgroundWorkState({
      background_tasks: [],
      session_crons: [{} as never],
    })).toBe("active")
  })

  test("classifies incomplete or malformed Stop snapshots as unknown", () => {
    expect(classifyClaudeBackgroundWorkState({
      background_tasks: [],
    })).toBe("unknown")
    expect(classifyClaudeBackgroundWorkState({
      session_crons: [],
    })).toBe("unknown")
    expect(classifyClaudeBackgroundWorkState({
      background_tasks: null as never,
      session_crons: [],
    })).toBe("unknown")
    expect(classifyClaudeBackgroundWorkState({
      background_tasks: [],
      session_crons: {} as never,
    })).toBe("unknown")
  })

  test("reports Stop state without propagating observer failures", async () => {
    const states: ClaudeBackgroundWorkState[] = []
    const hook = createClaudeStopHook((state) => states.push(state))
    const stopInput = {
      hook_event_name: "Stop",
      background_tasks: [],
      session_crons: [],
    } as never
    const hookOptions = { signal: new AbortController().signal }

    await expect(hook(stopInput, undefined, hookOptions)).resolves.toEqual({})
    expect(states).toEqual(["inactive"])

    const failingHook = createClaudeStopHook(() => {
      throw new Error("observer failed")
    })
    await expect(failingHook(stopInput, undefined, hookOptions)).resolves.toEqual({})

    let firstObservation = true
    const recoveredStates: ClaudeBackgroundWorkState[] = []
    const recoveringHook = createClaudeStopHook((state) => {
      if (firstObservation) {
        firstObservation = false
        throw new Error("first observation failed")
      }
      recoveredStates.push(state)
    })
    await expect(recoveringHook(stopInput, undefined, hookOptions)).resolves.toEqual({})
    expect(recoveredStates).toEqual(["unknown"])
  })
})


describe("provider context read contract", () => {
  async function fixture(provider: AgentProvider, options: { fallback?: boolean; failInput?: boolean } = {}) {
    const chat = createFakeChat("chat-1", "project-1", "New Chat")
    chat.provider = provider as never
    chat.sessionToken = "native-old"
    const store = createFakeStore({ chats: [chat] })
    store.messages.push(
      timestamped({ kind: "user_prompt", content: "prior question" }),
      timestamped({ kind: "assistant_text", text: "prior answer" }),
    )
    const sent: string[] = []
    let starts = 0
    const startupArgs: any[] = []
    const stream = new AsyncEventQueue<any>()
    const manager = {
      async readPromptHistory() {
        return { inputs: store.getPromptHistoryEntries("chat-1").filter((e) => e.kind === "user_prompt").map((e, i) => ({
          turnId: `native-${i}`, promptId: e._id, text: (e as { content: string }).content, userIndex: 0,
        })) }
      },
      async startSession(args: any) {
        starts++
        startupArgs.push(args)
        return { sessionToken: options.fallback ? "native-new" : "native-old", resumeFellBack: Boolean(options.fallback),
          startupOutcome: { kind: options.fallback ? "fresh" : "resumed" } }
      },
      async startTurn(args: any): Promise<HarnessTurn> {
        startupArgs.push(args)
        const content = args.prepareContent
          ? await args.prepareContent({ kind: options.fallback ? "fresh" : "resumed" })
          : args.content
        if (options.failInput) throw new Error("input rejected")
        sent.push(content)
        return { provider, providerTurnId: `accepted-${sent.length}`, stream, interrupt: async () => {}, close: () => stream.close() }
      },
      stopSession() {}, closeChat() {},
    }
    const coordinator = new AgentCoordinator({
      store: store as never, onStateChange: () => {}, checkSessionArtifact: () => "unknown",
      codexManager: manager as never, cursorManager: manager as never, grokManager: manager as never,
      piManager: manager as never, resolvePiConnection: async () => ({ provider: "openrouter", apiKey: "unused", baseUrl: "https://example.invalid" }),
      startClaudeSession: async () => ({
        provider: "claude", stream, startupOutcome: { kind: "resumed" },
        getAccountInfo: async () => null, interrupt: async () => {}, close: () => stream.close(),
        setModel: async () => {}, setPermissionMode: async () => {},
        sendPrompt: async (content: string) => { if (options.failInput) throw new Error("input rejected"); sent.push(content) },
      }) as never,
    })
    if (provider === "codex") await new CodexPromptHistory(store.dataDir).remember("chat-1", {
      [store.messages[0]!._id]: { sessionToken: "native-old", turnId: "native-0", mergeTurn: false, boundaryEntryId: null },
    })
    return { store, coordinator, sent, stream, startupArgs, starts: () => starts }
  }
for (const provider of ["claude", "codex", "cursor", "grok", "pi"] as const) {
    test(`${provider} cold resume and queued continuation never load the full payload`, async () => {
      const f = await fixture(provider)
      f.store.getMessages = () => { throw new Error("full payload read on native reuse") }
      try {
        await f.coordinator.send({ type: "chat.send", chatId: "chat-1", provider, content: "next" })
        expect(f.sent[0]).toContain("next")
        expect(f.sent[0]).not.toContain("prior answer")
        await f.coordinator.send({ type: "chat.send", chatId: "chat-1", provider, content: "queued next" })
        f.stream.push({ type: "transcript", entry: timestamped({ kind: "result", subtype: "success", isError: false, durationMs: 0, result: "done" }) })
        if (provider !== "claude") f.stream.close()
        await waitFor(() => f.sent.length === 2)
        expect(f.sent[1]).toContain("queued next")
        expect(f.sent[1]).not.toContain("prior answer")
      } finally { f.stream.close() }
    })
  }

  test("actual Codex fresh fallback starts once and restores before the first input", async () => {
    const f = await fixture("codex", { fallback: true })
    try {
      await f.coordinator.send({ type: "chat.send", chatId: "chat-1", provider: "codex", content: "next" })
      expect(f.starts()).toBe(1)
      expect(f.sent[0]).toContain("prior answer")
      expect(f.sent[0]?.match(/next/g)).toHaveLength(1)
    } finally { f.stream.close() }
  })

  test("Claude waits for actual native startup before sending new input", async () => {
    const store = createFakeStore()
    store.chat.provider = "claude"
    store.chat.sessionToken = "native-old"
    store.messages.push(timestamped({ kind: "user_prompt", content: "prior" }))
    store.getMessages = () => { throw new Error("resume must not load full payload") }
    let finish!: (outcome: { kind: "resumed" }) => void
    const ready = new Promise<{ kind: "resumed" }>(resolve => { finish = resolve })
    const stream = new AsyncEventQueue<any>()
    const sent: string[] = []
    const coordinator = new AgentCoordinator({ store: store as never, onStateChange: () => {}, checkSessionArtifact: () => "unknown",
      startClaudeSession: async () => ({ provider: "claude", stream, interrupt: async () => {}, close: () => stream.close(), setModel: async () => {}, setPermissionMode: async () => {},
        waitForStartupOutcome: () => ready, sendPrompt: async (content: string) => { sent.push(content) } }) as never,
    })
    const sending = coordinator.send({ type: "chat.send", chatId: "chat-1", provider: "claude", content: "next" })
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(sent).toEqual([])
    finish({ kind: "resumed" })
    await sending
    expect(sent).toEqual([withChatLinks("next")])
    stream.close()
  })

  test("restart continuation restores a tokenless durable obligation without adding a user prompt", async () => {
    const f = await fixture("codex", { fallback: true })
    f.store.chat.sessionToken = null
    await f.store.setContextRestoration("chat-1", { id: "persisted", provider: "codex", fromProvider: "claude", reason: "provider_switch", endExclusive: 2 })
    try {
      expect(await f.coordinator.resumeInterruptedTurn("chat-1")).toBe(true)
      expect(f.sent[0]).toContain("prior question")
      expect(f.sent[0]).toContain("prior answer")
      expect(f.sent[0]).toContain(RESUME_AFTER_RESTART_MESSAGE)
      expect(f.store.messages.filter(entry => entry.kind === "user_prompt")).toHaveLength(1)
    } finally { f.stream.close() }
  })

  test("all ordered provider switches send the preceding conversation once", async () => {
    const providers = ["claude", "codex", "cursor", "grok", "pi"] as const
    for (const from of providers) for (const to of providers) {
      if (from === to) continue
      const f = await fixture(from)
      try {
        await f.coordinator.send({ type: "chat.send", chatId: "chat-1", provider: to, content: "destination input" })
        expect(f.sent).toHaveLength(1)
        expect(f.sent[0]).toContain("prior question")
        expect(f.sent[0]).toContain("prior answer")
        expect(f.sent[0]?.match(/destination input/g)).toHaveLength(1)
        expect((f.store.chat as any).contextRestoration?.provider).toBe(to)
      } finally { f.stream.close() }
    }
  })

  test("failed turn partial progress belongs to a different retry's restoration", async () => {
    const f = await fixture("codex")
    f.store.recordTurnFailed = async () => { f.store.turnFinishedCount++ }
    try {
      await f.coordinator.send({ type: "chat.send", chatId: "chat-1", provider: "pi", content: "implement parser" })
      f.stream.push({ type: "transcript", entry: timestamped({ kind: "assistant_text", text: "partial parser implementation" }) })
      f.stream.push({ type: "transcript", entry: timestamped({ kind: "result", subtype: "error", isError: true, durationMs: 0, result: "transport lost" }) })
      f.stream.close()
      await waitFor(() => f.store.turnFinishedCount === 1)
      await new Promise(resolve => setTimeout(resolve, 10))
      await f.coordinator.send({ type: "chat.send", chatId: "chat-1", provider: "pi", content: "continue" })
      expect(f.sent[1]).toContain("implement parser")
      expect(f.sent[1]).toContain("partial parser implementation")
      expect((f.store.chat as any).contextRestoration).not.toBeNull()
    } finally { f.stream.close() }
  })

  test("warm Claude survives native file loss but a required restart restores context", async () => {
    const store = createFakeStore()
    store.chat.provider = "claude"
    store.chat.sessionToken = "native-old"
    store.messages.push(timestamped({ kind: "user_prompt", content: "prior question" }), timestamped({ kind: "assistant_text", text: "prior answer" }))
    let artifact: SessionArtifactStatus = "present"
    const tokens: Array<string | null> = []
    const sent: string[] = []
    const streams: AsyncEventQueue<any>[] = []
    const coordinator = new AgentCoordinator({ store: store as never, onStateChange: () => {}, checkSessionArtifact: () => artifact,
      startClaudeSession: async args => {
        tokens.push(args.sessionToken)
        const stream = new AsyncEventQueue<any>()
        streams.push(stream)
        return { provider: "claude", stream, startupOutcome: { kind: args.sessionToken ? "resumed" : "fresh" }, interrupt: async () => {}, close: () => stream.close(), setModel: async () => {}, setPermissionMode: async () => {},
          sendPrompt: async (content: string) => { sent.push(content); stream.push({ type: "session_token", sessionToken: "native-current" }); stream.push({ type: "transcript", entry: timestamped({ kind: "result", subtype: "success", isError: false, durationMs: 0, result: "done" }) }) },
        } as never
      },
    })
    try {
      await coordinator.send({ type: "chat.send", chatId: "chat-1", provider: "claude", content: "first" })
      await waitFor(() => store.turnFinishedCount === 1)
      artifact = "missing"
      const read = store.getMessages.bind(store)
      store.getMessages = () => { throw new Error("usable warm session must not read payload") }
      await coordinator.send({ type: "chat.send", chatId: "chat-1", provider: "claude", content: "warm next" })
      await waitFor(() => store.turnFinishedCount === 2)
      expect(tokens).toEqual(["native-old"])
      expect(sent[1]).toBe(withChatLinks("warm next"))
      store.getMessages = read
      await coordinator.send({ type: "chat.send", chatId: "chat-1", provider: "claude", content: "restart next", autoPlan: true })
      await waitFor(() => store.turnFinishedCount === 3)
      expect(tokens[1]).toBeNull()
      expect(sent[2]).toContain("prior answer")
    } finally { streams.forEach(stream => stream.close()) }
  })

  test("failed native Claude readiness closes its new unsent handle without loading history", async () => {
    const store = createFakeStore()
    store.chat.provider = "claude"
    store.chat.sessionToken = "native-old"
    store.messages.push(timestamped({ kind: "user_prompt", content: "prior" }))
    store.getMessages = () => { throw new Error("failed resume must not speculate full replay") }
    const sent: string[] = []
    let closed = 0
    const stream = new AsyncEventQueue<any>()
    const coordinator = new AgentCoordinator({ store: store as never, onStateChange: () => {}, checkSessionArtifact: () => "unknown",
      startClaudeSession: async () => ({ provider: "claude", stream, interrupt: async () => {}, close: () => { closed++; stream.close() }, setModel: async () => {}, setPermissionMode: async () => {},
        waitForStartupOutcome: async () => { throw new Error("native load rejected") }, sendPrompt: async (content: string) => { sent.push(content) } }) as never,
    })
    await expect(coordinator.send({ type: "chat.send", chatId: "chat-1", provider: "claude", content: "next" })).rejects.toThrow("native load rejected")
    expect(sent).toEqual([])
    expect(closed).toBe(1)
    expect(store.chat.sessionToken).toBe("native-old")
  })

  test("retry reconciles a durable destination written before provider metadata changed", async () => {
    const f = await fixture("codex")
    await f.store.setContextRestoration("chat-1", { id: "switch-interrupted", provider: "pi", fromProvider: "codex", reason: "provider_switch", endExclusive: 2 })
    try {
      await f.coordinator.send({ type: "chat.send", chatId: "chat-1", provider: "codex", content: "continue here" })
      expect(f.startupArgs[0].sessionToken).toBeNull()
      expect((f.store.chat as any).contextRestoration?.provider).toBe("codex")
      expect(f.sent[0]).toContain("prior answer")
    } finally { f.stream.close() }
  })

  test("a different retry prompt also restores the preceding failed user request", async () => {
    const options = { failInput: true }
    const f = await fixture("codex", options)
    try {
      await expect(f.coordinator.send({ type: "chat.send", chatId: "chat-1", provider: "pi", content: "implement the parser" })).rejects.toThrow("input rejected")
      options.failInput = false
      await f.coordinator.send({ type: "chat.send", chatId: "chat-1", provider: "pi", content: "continue" })
      expect(f.sent[0]).toContain("implement the parser")
      expect(f.sent[0]).toContain("prior answer")
      expect(f.sent[0]?.endsWith(withChatLinks("continue"))).toBe(true)
      expect((f.store.chat as any).contextRestoration).not.toBeNull()
      f.stream.push({ type: "transcript", entry: timestamped({ kind: "result", subtype: "success", isError: false, durationMs: 0, result: "done" }) })
      f.stream.close()
      await waitFor(() => (f.store.chat as any).contextRestoration === null)
    } finally { f.stream.close() }
  })

  test("a fresh startup after explicit clear cannot restore the previous epoch", async () => {
    const f = await fixture("codex", { fallback: true })
    f.store.messages.push(timestamped({ kind: "context_cleared" }), timestamped({ kind: "user_prompt", content: "new epoch task" }), timestamped({ kind: "assistant_text", text: "new epoch answer" }))
    try {
      await f.coordinator.send({ type: "chat.send", chatId: "chat-1", provider: "codex", content: "continue" })
      expect(f.sent[0]).toContain("new epoch task")
      expect(f.sent[0]).toContain("new epoch answer")
      expect(f.sent[0]).not.toContain("prior question")
      expect(f.sent[0]).not.toContain("/tmp/transcripts/chat-1.jsonl")
    } finally { f.stream.close() }
  })

  test("failed provider-switch input retains a bounded durable restoration obligation", async () => {
    const f = await fixture("codex", { failInput: true })
    try {
      await expect(f.coordinator.send({ type: "chat.send", chatId: "chat-1", provider: "pi", content: "next" })).rejects.toThrow("input rejected")
      expect((f.store.chat as any).contextRestoration).toMatchObject({ provider: "pi", fromProvider: "codex", endExclusive: 2 })
    } finally { f.stream.close() }
  })


  for (const provider of ["cursor", "grok", "pi"] as const) {
    test(`${provider} prefix handoff never receives the old provider's token`, async () => {
      const f = await fixture("claude")
      const prefix = [...f.store.messages]
      try {
        await (f.coordinator as any).startTurnForChat({ chatId: "chat-1", provider, content: "next", attachments: [], model: "model", planMode: false, autoPlan: false, appendUserPrompt: true, replaceTranscriptPrefix: prefix })
        expect(f.startupArgs[0].sessionToken).toBeNull()
        expect(f.startupArgs[0].forkSession ?? false).toBe(false)
        expect(f.sent[0]).toContain("prior answer")
        expect(f.store.chat.sessionToken).toBeNull()
      } finally { f.stream.close() }
    })
  }


  test("pending restoration actually forces fresh startup despite a prepared token override", async () => {
    const f = await fixture("codex")
    await f.store.setContextRestoration("chat-1", { id: "failed", provider: "codex", fromProvider: "claude", reason: "provider_switch", endExclusive: 2 })
    try {
      await (f.coordinator as any).startTurnForChat({ chatId: "chat-1", provider: "codex", content: "replacement", attachments: [], model: "gpt-5.4", planMode: false, autoPlan: false, appendUserPrompt: true, replaceTranscriptPrefix: [...f.store.messages], sessionToken: "prepared-but-incomplete", pendingForkSessionToken: "fork-source" })
      expect(f.startupArgs[0].sessionToken).toBeNull()
      expect(f.startupArgs[0].pendingForkSessionToken).toBeNull()
      expect(f.sent[0]).toContain("prior answer")
    } finally { f.stream.close() }
  })


  test("preserved prepared native prefix sends only the replacement input", async () => {
    const f = await fixture("codex")
    const prefix = [...f.store.messages]
    f.store.getMessages = () => { throw new Error("prepared native prefix must not replay full payload") }
    try {
      await (f.coordinator as any).startTurnForChat({ chatId: "chat-1", provider: "codex", content: "replacement", attachments: [], model: "gpt-5.4", planMode: false, autoPlan: false, appendUserPrompt: true, replaceTranscriptPrefix: prefix, sessionToken: "prepared" })
      expect(f.sent[0]).toBe(withChatLinks("replacement"))
    } finally { f.stream.close() }
  })


  test("a fresh prepared edit restores only its prefix and never advertises the old transcript", async () => {
    const f = await fixture("codex", { fallback: true })
    const prefix = [...f.store.messages]
    f.store.messages.push(timestamped({ kind: "user_prompt", content: "discard this task" }), timestamped({ kind: "assistant_text", text: "deleted answer" }))
    try {
      await (f.coordinator as any).startTurnForChat({ chatId: "chat-1", provider: "codex", content: "replacement", attachments: [], model: "gpt-5.4", planMode: false, autoPlan: false, appendUserPrompt: true, replaceTranscriptPrefix: prefix, sessionToken: "prepared-prefix" })
      expect(f.sent[0]).toContain("prior answer")
      expect(f.sent[0]).not.toContain("deleted answer")
      expect(f.sent[0]).not.toContain("/tmp/transcripts/chat-1.jsonl")
      expect(f.sent[0]?.match(/replacement/g)).toHaveLength(1)
    } finally { f.stream.close() }
  })
})


  test("native Claude factory exposes the first initialize barrier before consuming prompt input", async () => {
  let captured: any
  let initialized!: () => void
  const initialization = new Promise<any>(resolve => { initialized = () => resolve({ models: [] }) })
  let initializations = 0
  const native = {
    initializationResult: () => { initializations++; return initialization },
    close: () => {},
  }
  const handle = await startClaudeSession({ localPath: "/tmp/project", model: "opus", planMode: false, autoPlan: false,
    sessionToken: "native-source", forkSession: true, onToolRequest: async () => ({}) }, {
    query: ((args: any) => { captured = args; return native }) as never,
    resolveExecutable: async () => ({ ok: true, path: "/fake/claude", version: "2.1.284" }),
  })
  expect(typeof handle.waitForStartupOutcome).toBe("function")
  let outcome: unknown = null
  const preparing = handle.waitForStartupOutcome!().then(value => { outcome = value })
  await new Promise(resolve => setTimeout(resolve, 10))
  expect(outcome).toBeNull()
  const input = captured.prompt[Symbol.asyncIterator]().next()
  initialized()
  await preparing
  expect(outcome).toEqual({ kind: "forked" })
  await handle.waitForStartupOutcome!()
  expect(initializations).toBe(1)
  expect(captured.options.resume).toBe("native-source")
  expect(captured.options.forkSession).toBe(true)
  await handle.sendPrompt("new input", "prompt-id")
  expect((await input).value.message.content).toBe("new input")
  handle.close()
})


  for (const version of [null, "2.1.277", "2.1.285"] as const) {
  test(`Claude version ${version ?? "wrapper"} keeps unaudited native continuity explicit`, async () => {
    const handle = await startClaudeSession({ localPath: "/tmp/project", model: "opus", planMode: false, autoPlan: false,
      sessionToken: "native-source", forkSession: false, onToolRequest: async () => ({}) }, {
      query: (() => ({ initializationResult: async () => ({}), close: () => {} })) as never,
      resolveExecutable: async () => ({ ok: true, path: "/fake/claude", version }),
    })
    expect((await handle.waitForStartupOutcome!()).kind).toBe("unknown")
    handle.close()
  })
}


  for (const provider of ["cursor", "grok"] as const) {
  test(`${provider} explicit fresh invocation keeps actual startup unknown while restoring required context`, async () => {
    const chat = createFakeChat("chat-1", "project-1", "Conversation")
    chat.provider = provider as never
    const store = createFakeStore({ chats: [chat] })
    store.messages.push(timestamped({ kind: "user_prompt", content: "old task" }), timestamped({ kind: "assistant_text", text: "old answer" }))
    const stream = new AsyncEventQueue<any>()
    const sent: string[] = []
    const outcomes: any[] = []
    const manager = { async startTurn(args: any) { sent.push(args.content); return { provider, stream, interrupt: async () => {}, close: () => stream.close() } } }
    const coordinator = new AgentCoordinator({ store: store as never, onStateChange: () => {}, cursorManager: manager as never, grokManager: manager as never })
    try {
      await (coordinator as any).startTurnForChat({ chatId: "chat-1", provider, content: "next", attachments: [], model: "model", planMode: false, autoPlan: false, appendUserPrompt: true,
        onProviderReady: async (_isCurrentTurn: any, outcome: any) => { outcomes.push(outcome) },
      })
      expect(outcomes[0].kind).toBe("unknown")
      expect(sent[0]).toContain("old answer")
      expect((store.chat as any).contextRestoration).not.toBeNull()
    } finally { stream.close() }
  })
}


describe("owned provider context preparation integration", () => {
  function gate() {
    let release!: () => void
    return { ready: new Promise<void>(resolve => { release = resolve }), release: () => release() }
  }
  async function contextStore(provider: AgentProvider) {
    const store = createFakeStore()
    store.chat.provider = provider
    store.chat.title = "Existing conversation"
    store.chat.sessionToken = "native-old"
    store.messages = [timestamped({ kind: "user_prompt", content: "original question" }),
      timestamped({ kind: "assistant_text", text: "original answer" })]
    if (provider === "codex") await new CodexPromptHistory(store.dataDir).remember("chat-1", {
      [store.messages[0]!._id]: { sessionToken: "native-old", turnId: "native-0", mergeTurn: false, boundaryEntryId: null },
    })
    return store
  }
  const success = () => ({ type: "transcript", entry: timestamped({ kind: "result", subtype: "success", isError: false, durationMs: 0, result: "done" }) })
  for (const stop of ["cancel", "close", "dispose"] as const) {
    test(`a ${stop} during Pi native preparation cannot run its lazy callback or submit old input`, async () => {
      const store = await contextStore("pi")
      store.getMessages = () => { throw new Error("cancelled preparation must not load history") }
      const entered = gate(), blocked = gate()
      const prompts: string[] = []
      const queues: AsyncEventQueue<any>[] = []
      let starts = 0
      const manager = {
        closeChat() {}, dispose() {},
        async startTurn(args: any) {
          if (++starts === 1) { entered.release(); await blocked.ready }
          const content = await args.prepareContent({ kind: "resumed" })
          prompts.push(content)
          const stream = new AsyncEventQueue<any>(); queues.push(stream)
          return { provider: "pi", stream, interrupt: async () => {}, close: () => stream.close() }
        },
      }
      const coordinator = new AgentCoordinator({ store: store as never, onStateChange: () => {}, piManager: manager as never,
        resolvePiConnection: async () => ({ provider: "openrouter", apiKey: "unused", baseUrl: "https://example.invalid" }) })
      const send = (content: string) => coordinator.send({ type: "chat.send", chatId: "chat-1", provider: "pi", content })
      const original = send("cancelled request")
      try {
        await entered.ready
        if (stop === "cancel") await coordinator.cancel("chat-1"); else if (stop === "close") await coordinator.closeChat("chat-1"); else coordinator.dispose()
        await send("successor request")
        const successor = coordinator.activeTurns.get("chat-1")
        blocked.release(); await original
        expect(prompts).toEqual(["successor request"])
        expect(coordinator.activeTurns.get("chat-1")).toBe(successor)
      } finally { blocked.release(); await original.catch(() => {}); for (const queue of queues) queue.close() }
    })
  }

  test("Claude restoration ACK waits for its own successful native result", async () => {
    const store = await contextStore("claude")
    store.chat.contextRestoration = { id: "pending", provider: "claude", fromProvider: "claude", reason: "session_restore", endExclusive: 2 }
    const stream = new AsyncEventQueue<any>()
    let promptId: string | undefined
    const coordinator = new AgentCoordinator({ store: store as never, onStateChange: () => {},
      startClaudeSession: async () => ({ provider: "claude", echoesPromptIds: true, stream, startupOutcome: { kind: "fresh" },
        interrupt: async () => {}, close: () => stream.close(), setModel: async () => {}, setPermissionMode: async () => {},
        sendPrompt: async (_content, id) => { promptId = id },
      }),
    })
    try {
      await coordinator.send({ type: "chat.send", chatId: "chat-1", provider: "claude", content: "next" })
      expect(store.chat.contextRestoration).not.toBeNull()
      stream.push({ type: "transcript", promptIds: [promptId], entry: timestamped({ kind: "result", subtype: "success", isError: false, durationMs: 0, result: "done" }) })
      await waitFor(() => store.turnFinishedCount === 1)
      expect(store.chat.contextRestoration).toBeNull()
    } finally { stream.close() }
  })

  for (const stop of ["cancel", "close", "dispose"] as const) test(`a ${stop} result awaiting transcript persistence cannot ACK or remove a successor`, async () => {
    const store = await contextStore("codex")
    store.chat.provider = "grok"
    const resultEntered = gate(), resultBlocked = gate()
    const append = store.appendMessage.bind(store)
    store.appendMessage = async (chatId, entry) => {
      if (entry.kind === "result") { resultEntered.release(); await resultBlocked.ready }
      await append(chatId, entry)
    }
    let acknowledgements = 0
    const ack = store.acknowledgeContextRestoration.bind(store)
    store.acknowledgeContextRestoration = async (chatId, id) => { acknowledgements++; await ack(chatId, id) }
    const queues: AsyncEventQueue<any>[] = []
    const manager = {
      stopSession() {}, stopAll() {},
      async startSession() { return { sessionToken: "new", resumeFellBack: false, startupOutcome: { kind: "fresh" } } },
      async startTurn() { const stream = new AsyncEventQueue<any>(); queues.push(stream); return { provider: "codex", providerTurnId: "accepted-turn", stream, interrupt: async () => {}, close: () => stream.close() } },
    }
    const coordinator = new AgentCoordinator({ store: store as never, onStateChange: () => {}, codexManager: manager as never })
    const send = (content: string) => coordinator.send({ type: "chat.send", chatId: "chat-1", provider: "codex", content })
    try {
      await send("original request")
      queues[0]!.push(success())
      await resultEntered.ready
      if (stop === "cancel") await coordinator.cancel("chat-1"); else if (stop === "close") await coordinator.closeChat("chat-1"); else coordinator.dispose()
      await send("successor request")
      const successor = coordinator.activeTurns.get("chat-1")
      const successorIntent = store.chat.contextRestoration
      resultBlocked.release()
      await new Promise(resolve => setTimeout(resolve, 10))
      expect(acknowledgements).toBe(0)
      expect(coordinator.activeTurns.get("chat-1")).toBe(successor)
      expect(store.chat.contextRestoration).toEqual(successorIntent)
      expect(store.turnFinishedCount).toBe(0)
    } finally { resultBlocked.release(); for (const queue of queues) queue.close() }
  })



  test("a late cancelled Codex startup cannot publish its prompt over an accepted successor", async () => {
    const store = await contextStore("codex")
    store.getMessages = () => { throw new Error("native continuity must stay lazy") }
    const entered = gate(), blocked = gate()
    const prompts: string[] = []
    const queues: AsyncEventQueue<any>[] = []
    let starts = 0
    const manager = {
      stopSession() {},
      async readPromptHistory() { return { inputs: [{ turnId: "native-0", promptId: store.messages[0]!._id, text: "original question", userIndex: 0 }] } },
      async startSession() { if (++starts === 1) { entered.release(); await blocked.ready }; return { sessionToken: `native-${starts}`, resumeFellBack: false, startupOutcome: { kind: "resumed" } } },
      async startTurn(args: any) { prompts.push(args.content); const stream = new AsyncEventQueue<any>(); queues.push(stream); return { provider: "codex", providerTurnId: "accepted-turn", stream, interrupt: async () => {}, close: () => stream.close() } },
    }
    const coordinator = new AgentCoordinator({ store: store as never, onStateChange: () => {}, codexManager: manager as never })
    const send = (content: string) => coordinator.send({ type: "chat.send", chatId: "chat-1", provider: "codex", content })
    const original = send("cancelled request")
    try {
      await entered.ready
      await coordinator.cancel("chat-1")
      await send("successor request")
      blocked.release(); await original
      expect(prompts).toHaveLength(1)
      expect(prompts[0]).toContain("successor request")
      expect(prompts[0]).not.toContain("cancelled request")
      expect(coordinator.activeTurns.has("chat-1")).toBe(true)
      expect(store.messages.some(entry => entry.kind === "user_prompt" && entry.content === "cancelled request")).toBe(false)
    } finally { blocked.release(); await original.catch(() => {}); for (const queue of queues) queue.close() }
  })


  test("a cancelled blocked restoration write drains without publishing its unaccepted prompt", async () => {
    const store = await contextStore("codex")
    const entered = gate(), blocked = gate()
    const setIntent = store.setContextRestoration.bind(store)
    let writes = 0
    store.setContextRestoration = async (chatId, intent) => {
      if (++writes === 1) { entered.release(); await blocked.ready }
      await setIntent(chatId, intent)
    }
    const prompts: string[] = []
    let starts = 0
    const queues: AsyncEventQueue<any>[] = []
    const manager = {
      stopSession() {},
      async readPromptHistory() { return { inputs: [{ turnId: "native-0", promptId: store.messages[0]!._id, text: "original question", userIndex: 0 }] } },
      async startSession() { starts++; return { sessionToken: "native-new", resumeFellBack: false, startupOutcome: { kind: "fresh" } } },
      async startTurn(args: any) { prompts.push(args.content); const stream = new AsyncEventQueue<any>(); queues.push(stream); return { provider: "codex", providerTurnId: "accepted-turn", stream, interrupt: async () => {}, close: () => stream.close() } },
    }
    const coordinator = new AgentCoordinator({ store: store as never, onStateChange: () => {}, codexManager: manager as never })
    // Force an explicit destination obligation before any native startup.
    store.chat.provider = "grok"
    const send = (content: string) => coordinator.send({ type: "chat.send", chatId: "chat-1", provider: "codex", content })
    const original = send("cancelled request")
    let successor: Promise<unknown> | undefined
    try {
      await entered.ready
      expect(coordinator.activeTurns.has("chat-1")).toBe(true)
      await coordinator.cancel("chat-1")
      successor = send("successor request").catch(error => error)
      await new Promise(resolve => setTimeout(resolve, 10))
      expect(starts).toBe(0)
      blocked.release()
      await original
      expect(await successor).toEqual({ chatId: "chat-1" })
      expect(starts).toBe(1)
      expect(prompts).toHaveLength(1)
      expect(prompts[0]).toContain("successor request")
      expect(prompts[0]).not.toContain("cancelled request")
      expect(store.messages.some(entry => entry.kind === "user_prompt" && entry.content === "cancelled request")).toBe(false)
    } finally { blocked.release(); await original.catch(() => {}); await successor?.catch(() => {}); for (const queue of queues) queue.close() }
  })
})


  test("cancellation during explicit context clear drains its local write and preserves the successor reset epoch", async () => {
  const store = createFakeStore()
  store.chat.provider = "codex"
  store.chat.title = "Existing conversation"
  store.chat.sessionToken = "source-session"
  store.messages = [timestamped({ kind: "user_prompt", content: "old question" })]
  let entered!: () => void, release!: () => void
  const observed = new Promise<void>(resolve => { entered = resolve })
  const blocked = new Promise<void>(resolve => { release = resolve })
  const append = store.appendMessage.bind(store)
  store.appendMessage = async (chatId, entry) => {
    if (entry.kind === "context_cleared") { entered(); await blocked }
    await append(chatId, entry)
  }
  let prompt!: { onToolRequest: (request: any) => Promise<unknown> }
  const queues: AsyncEventQueue<any>[] = []
  const starts: Array<string | null> = []
  const manager = {
    stopSession() {},
    async readPromptHistory() { return { inputs: store.getPromptHistoryEntries("chat-1").filter(e => e.kind === "user_prompt").map((e, i) => ({ turnId: `native-${i}`, promptId: e._id, text: (e as { content: string }).content, userIndex: 0 })) } },
    async startSession(args: any) { starts.push(args.sessionToken); return { sessionToken: "new", resumeFellBack: false, startupOutcome: { kind: "resumed" } } },
    async startTurn(args: any) { prompt = args; const stream = new AsyncEventQueue<any>(); queues.push(stream); return { provider: "codex", providerTurnId: "accepted-turn", stream, interrupt: async () => {}, close: () => stream.close() } },
  }
  const coordinator = new AgentCoordinator({ store: store as never, onStateChange: () => {}, codexManager: manager as never })
  let responding: ReturnType<typeof coordinator.respondTool> | undefined
  let successor: ReturnType<typeof coordinator.send> | undefined
  try {
    await coordinator.send({ type: "chat.send", chatId: "chat-1", provider: "codex", content: "make a plan" })
    void prompt.onToolRequest({ tool: { kind: "tool", toolKind: "exit_plan_mode", toolName: "ExitPlanMode", toolId: "plan", input: { plan: "plan" } } }).catch(() => {})
    await waitFor(() => coordinator.getPendingTool("chat-1") !== undefined)
    responding = coordinator.respondTool({ type: "chat.respondTool", chatId: "chat-1", toolUseId: "plan", result: { confirmed: true, clearContext: true } })
    await observed
    await coordinator.cancel("chat-1")
    successor = coordinator.send({ type: "chat.send", chatId: "chat-1", provider: "codex", content: "successor" })
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(starts).toHaveLength(1)
    release(); await Promise.all([responding, successor])
    expect(starts).toHaveLength(2)
    expect(starts[1]).toBeNull()
    expect(store.chat.contextRestoration?.reason).toBe("explicit_reset")
    expect(store.chat.sessionToken).toBe("new")
    expect(coordinator.activeTurns.get("chat-1")?.postToolFollowUp).toBeNull()
  } finally { release(); await responding?.catch(() => {}); await successor?.catch(() => {}); for (const queue of queues) queue.close() }
})


  test("a failed reset boundary keeps its durable lower bound and never restores the older epoch", async () => {
  const store = createFakeStore()
  store.chat.provider = "codex"
  store.chat.title = "Existing conversation"
  store.chat.sessionToken = "source-session"
  store.messages = [timestamped({ kind: "user_prompt", content: "forbidden old question" }), timestamped({ kind: "assistant_text", text: "forbidden old answer" })]
  const append = store.appendMessage.bind(store)
  store.appendMessage = async (chatId, entry) => { if (entry.kind === "context_cleared") throw new Error("boundary unavailable"); await append(chatId, entry) }
  const queues: AsyncEventQueue<any>[] = []
  let prompt!: { onToolRequest: (request: any) => Promise<unknown> }
  const content: string[] = []
  const manager = {
    stopSession() {},
    async readPromptHistory() { return { inputs: store.getPromptHistoryEntries("chat-1").filter(e => e.kind === "user_prompt").map((e, i) => ({ turnId: `native-${i}`, promptId: e._id, text: (e as { content: string }).content, userIndex: 0 })) } },
    async startSession() { return { sessionToken: "new", resumeFellBack: false, startupOutcome: { kind: "fresh" } } },
    async startTurn(args: any) { prompt = args; content.push(args.content); const stream = new AsyncEventQueue<any>(); queues.push(stream); return { provider: "codex", providerTurnId: "accepted-turn", stream, interrupt: async () => {}, close: () => stream.close() } },
  }
  const coordinator = new AgentCoordinator({ store: store as never, onStateChange: () => {}, codexManager: manager as never })
  try {
    await coordinator.send({ type: "chat.send", chatId: "chat-1", provider: "codex", content: "make a plan" })
    void prompt.onToolRequest({ tool: { kind: "tool", toolKind: "exit_plan_mode", toolName: "ExitPlanMode", toolId: "plan", input: { plan: "plan" } } }).catch(() => {})
    await waitFor(() => coordinator.getPendingTool("chat-1") !== undefined)
    await expect(coordinator.respondTool({ type: "chat.respondTool", chatId: "chat-1", toolUseId: "plan", result: { confirmed: true, clearContext: true } })).rejects.toThrow("boundary unavailable")
    expect(store.chat.contextRestoration?.startInclusive).toBe(store.messages.length)
    await coordinator.cancel("chat-1")
    await coordinator.send({ type: "chat.send", chatId: "chat-1", provider: "codex", content: "new epoch input" })
    expect(content[1]).toBe("new epoch input")
    expect(content[1]).not.toContain("forbidden old")
    expect(content[1]).not.toContain("/tmp/transcripts/")
  } finally { for (const queue of queues) queue.close() }
})


  


describe("main integration review of early preparation ownership", () => {
  test.each(["question", "execution"])("main review: an old Claude tool %s waiting for startup cannot cross native replacement", async kind => {
    const store = createFakeStore()
    store.chat.provider = "claude"
    store.chat.title = "Existing conversation"
    let entered!: () => void, release!: () => void
    const blocked = new Promise<void>(resolve => { release = resolve })
    const preparing = new Promise<void>(resolve => { entered = resolve })
    const nativeArgs: any[] = []
    const queues: AsyncEventQueue<any>[] = []
    let attached = 0, executed = 0
    const coordinator = new AgentCoordinator({ store: store as never, onStateChange: () => {},
      startClaudeSession: async args => {
        const stream = new AsyncEventQueue<any>(); queues.push(stream); nativeArgs.push(args)
        return { provider: "claude", stream, interrupt: async () => {}, close: () => stream.close(),
          sendPrompt: async () => { if (nativeArgs.length === 1) stream.push({ type: "transcript", entry: timestamped({ kind: "result", subtype: "success", isError: false, durationMs: 0, result: "done" }) }) },
          setModel: async () => {}, setPermissionMode: async () => {}, setFastMode: async () => {} }
      } }) as any
    coordinator.refreshClaudeModelCatalog = async () => {}
    coordinator.requestToolInput = async () => { attached++; return {} }
    let successor: Promise<unknown> | undefined, oldCallback: Promise<any> | undefined
    try {
      await coordinator.send({ type: "chat.send", chatId: "chat-1", provider: "claude", content: "first" })
      await waitFor(() => !coordinator.activeTurns.has("chat-1"))
      const oldSession = coordinator.claudeSessions.get("chat-1")
      const setPlanMode = store.setPlanMode.bind(store)
      store.setPlanMode = async (chatId, mode) => { entered(); await blocked; await setPlanMode(chatId, mode) }
      successor = coordinator.startTurnForChat({ chatId: "chat-1", provider: "claude", content: "second",
        attachments: [], model: "model", planMode: false, autoPlan: false, appendUserPrompt: true, resetSession: true })
      await preparing
      const owner = coordinator.activeTurns.get("chat-1")
      owner.customTools = { abort() {}, async execute() { executed++; return { content: [{ type: "text", text: "wrong session" }] } } }
      oldCallback = (kind === "question" ? nativeArgs[0].onToolRequest({})
        : nativeArgs[0].customTools.execute("old_tool", {}, new AbortController().signal)).catch((error: unknown) => error)
      await new Promise(resolve => setTimeout(resolve, 0))
      release()
      await successor
      expect(nativeArgs).toHaveLength(2)
      expect(coordinator.claudeSessions.get("chat-1")).not.toBe(oldSession)
      const result = await oldCallback
      if (kind === "question") expect(result).toBeInstanceOf(Error)
      else expect(result.isError).toBe(true)
      expect(attached).toBe(0)
      expect(executed).toBe(0)
    } finally { release(); for (const queue of queues) queue.close(); await successor; await oldCallback; coordinator.dispose() }
  })


  for (const provider of ["codex", "pi", "cursor", "grok"] as const) {
    for (const stop of ["cancel", "close", "dispose"] as const) {
      test(`main review: ${stop} invalidates ${provider} waiting for a predecessor write`, async () => {
        const store = createFakeStore()
        store.chat.provider = provider
        store.chat.title = "Existing conversation"
        let release!: () => void
        const drain = new Promise<void>(resolve => { release = resolve })
        let starts = 0
        const manager = {
          async startSession() { starts++; throw new Error("late native preparation") },
          async startTurn() { starts++; throw new Error("late native input") },
          stopSession() {}, stopAll() {}, closeChat() {}, dispose() {},
        }
        const coordinator = new AgentCoordinator({ store: store as never, onStateChange: () => {},
          codexManager: manager as never, piManager: manager as never,
          cursorManager: manager as never, grokManager: manager as never }) as any
        coordinator.resolvePiConnection = async () => ({ provider: "openai", apiKey: "test", baseUrl: "https://example.invalid" })
        coordinator.claudeReadinessCommits.set("chat-1", drain)
        const pending = coordinator.startTurnForChat({ chatId: "chat-1", provider, content: "cancelled input",
          attachments: [], model: "model", planMode: false, autoPlan: false, appendUserPrompt: true }).catch((error: unknown) => error)
        try {
          if (stop === "cancel") await coordinator.cancel("chat-1")
          else if (stop === "close") await coordinator.closeChat("chat-1")
          else coordinator.dispose()
          release()
          await pending
          expect(starts).toBe(0)
          expect(coordinator.activeTurns.has("chat-1")).toBe(false)
          expect(store.messages.some(entry => entry.kind === "user_prompt")).toBe(false)
        } finally { release(); await pending; coordinator.dispose() }
      })
    }
  }


  test("main review: a warm native tool host serves the current turn", async () => {
    const store = createFakeStore()
    store.chat.provider = "codex"
    store.chat.title = "Existing conversation"
    let nativeHost: any
    let turns = 0
    const queues: AsyncEventQueue<any>[] = []
    const manager = {
      stopSession() {}, stopAll() {},
      async startSession(args: any) {
        nativeHost ??= args.customTools
        return { sessionToken: "native", resumeFellBack: false, startupOutcome: { kind: turns ? "reused" : "fresh" } }
      },
      async startTurn() {
        const stream = new AsyncEventQueue<any>(); queues.push(stream)
        if (++turns === 1) {
          stream.push({ type: "transcript", entry: timestamped({ kind: "result", subtype: "success", isError: false, durationMs: 0, result: "done" }) })
          stream.close()
        }
        return { provider: "codex", providerTurnId: "accepted-turn", stream, interrupt: async () => {}, close: () => stream.close() }
      },
    }
    const coordinator = new AgentCoordinator({ store: store as never, onStateChange: () => {}, codexManager: manager as never }) as any
    const send = (content: string) => coordinator.send({ type: "chat.send", chatId: "chat-1", provider: "codex", content })
    try {
      await send("first")
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(coordinator.activeTurns.has("chat-1")).toBe(false)
      await send("second")
      const owner = coordinator.activeTurns.get("chat-1")
      let executed = 0
      owner.customTools = { abort() {}, async execute() { executed++; return { content: [{ type: "text", text: "current turn" }] } } }
      const result = await nativeHost.execute("test_current_owner", {}, new AbortController().signal)
      expect(result).toEqual({ content: [{ type: "text", text: "current turn" }] })
      expect(executed).toBe(1)
      expect(coordinator.activeTurns.get("chat-1")).toBe(owner)
    } finally { for (const queue of queues) queue.close(); coordinator.dispose() }
  })


  test("main review: a warm Claude tool request serves the current turn", async () => {
    const store = createFakeStore()
    store.chat.provider = "claude"
    store.chat.title = "Existing conversation"
    const events = new AsyncEventQueue<any>()
    let nativeCallback!: (request: any) => Promise<unknown>
    let prompts = 0
    const coordinator = new AgentCoordinator({ store: store as never, onStateChange: () => {},
      startClaudeSession: async args => {
        nativeCallback = args.onToolRequest
        return { provider: "claude", stream: events, interrupt: async () => {}, close: () => events.close(),
          sendPrompt: async () => {
            if (++prompts === 1) events.push({ type: "transcript", entry: timestamped({ kind: "result", subtype: "success", isError: false, durationMs: 0, result: "done" }) })
          }, setModel: async () => {}, setPermissionMode: async () => {}, setFastMode: async () => {} }
      } }) as any
    coordinator.refreshClaudeModelCatalog = async () => {}
    let requests = 0
    coordinator.requestToolInput = async () => { requests++; return { answer: "current turn" } }
    const send = (content: string) => coordinator.send({ type: "chat.send", chatId: "chat-1", provider: "claude", content })
    try {
      await send("first")
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(coordinator.activeTurns.has("chat-1")).toBe(false)
      await send("second")
      await expect(nativeCallback({})).resolves.toEqual({ answer: "current turn" })
      expect(requests).toBe(1)
    } finally { events.close(); coordinator.dispose() }
  })


  test.each(["selected prefix", "last completed turn"])("main review: %s fork restores history before a later uncommitted reset", async kind => {
    const { EventStore } = await import("./event-store")
    const dataDir = mkdtempSync(path.join(tmpdir(), "kanna-reset-prefix-fork-"))
    const store = new EventStore(dataDir)
    const stream = new AsyncEventQueue<any>()
    let coordinator: AgentCoordinator | undefined
    let forkId: string | undefined
    try {
      await store.initialize()
      const project = await store.openProject(dataDir, "Project")
      const source = await store.createChat(project.id)
      await store.renameChat(source.id, "Existing conversation")
      await store.setChatProvider(source.id, "codex")
      await store.setSessionToken(source.id, "source-native")
      const prefix = [timestamped({ kind: "user_prompt", content: "allowed earlier question" }),
        timestamped({ kind: "assistant_text", text: "allowed earlier answer" }),
        timestamped({ kind: "result", subtype: "success", isError: false, durationMs: 0, result: "done" })]
      await store.replaceTranscript(source.id, [...prefix, timestamped({ kind: "user_prompt", content: "forbidden later tail" })])
      await store.setContextRestoration(source.id, { id: "uncommitted-reset", provider: "codex", fromProvider: "codex",
        reason: "explicit_reset", startInclusive: 4, endExclusive: 4 })
      const fullFork = await store.forkChat(source.id)
      expect(fullFork.contextRestoration?.startInclusive).toBe(4)
      const fork = await store.forkChat(source.id, kind === "selected prefix" ? { transcriptEntries: prefix } : { atLastCompletedTurn: true })
      forkId = fork.id
      const sent: string[] = []
      coordinator = new AgentCoordinator({ store, onStateChange: () => {}, codexManager: {
        stopSession() {}, stopAll() {},
        async readPromptHistory() { return { inputs: [{ turnId: "source-turn", promptId: prefix[0]!._id, text: "allowed earlier question", userIndex: 0 }] } },
        async startSession() { return { sessionToken: "fresh-destination", resumeFellBack: false, startupOutcome: { kind: "fresh" } } },
        async startTurn(args: any) { sent.push(args.content); return { provider: "codex", providerTurnId: "accepted-turn", stream, interrupt: async () => {}, close: () => stream.close() } },
      } as never })
      await coordinator.send({ type: "chat.send", chatId: fork.id, provider: "codex", content: "continue the fork" })
      expect(sent).toHaveLength(1)
      expect(sent[0]).toContain("allowed earlier question")
      expect(sent[0]).toContain("allowed earlier answer")
      expect(sent[0]).toContain("continue the fork")
      expect(sent[0]).not.toContain("forbidden later tail")
      expect(sent[0]).not.toContain(store.getTranscriptPath(source.id))
      expect(source.contextRestoration?.startInclusive).toBe(4)
      expect(store.getMessages(source.id)).toHaveLength(4)
    } finally {
      if (coordinator && forkId) await coordinator.cancel(forkId)
      stream.close(); coordinator?.dispose(); rmSync(dataDir, { recursive: true, force: true })
    }
  })


  test.each(["system_init", "stream error"])("main review: old Claude %s cannot alter a pending provider switch", async kind => {
    const store = createFakeStore()
    store.chat.provider = "claude"
    store.chat.title = "Existing conversation"
    const events = new AsyncEventQueue<any>()
    let entered!: () => void, release!: () => void
    const blocked = new Promise<void>(resolve => { release = resolve })
    const intentEntered = new Promise<void>(resolve => { entered = resolve })
    let failures = 0
    store.recordTurnFailed = async () => { failures++ }
    const coordinator = new AgentCoordinator({ store: store as never, onStateChange: () => {},
      codexManager: { startSession: async () => { throw new Error("end controlled startup") }, stopSession() {}, stopAll() {} } as never,
      startClaudeSession: async () => ({ provider: "claude",
        stream: { async *[Symbol.asyncIterator]() { for await (const event of events) { if (event === "fail") throw new Error("old Claude failure"); yield event } } },
        interrupt: async () => {}, close: () => events.close(),
        sendPrompt: async () => { events.push({ type: "transcript", entry: timestamped({ kind: "result", subtype: "success", isError: false, durationMs: 0, result: "done" }) }) },
        setModel: async () => {}, setPermissionMode: async () => {}, setFastMode: async () => {} }) }) as any
    coordinator.refreshClaudeModelCatalog = async () => {}
    let successor: Promise<unknown> | undefined
    try {
      await coordinator.send({ type: "chat.send", chatId: "chat-1", provider: "claude", content: "first" })
      await waitFor(() => !coordinator.activeTurns.has("chat-1"))
      const setIntent = store.setContextRestoration.bind(store)
      store.setContextRestoration = async (chatId, intent) => { entered(); await blocked; await setIntent(chatId, intent) }
      successor = coordinator.send({ type: "chat.send", chatId: "chat-1", provider: "codex", content: "second" }).catch((error: unknown) => error)
      await intentEntered
      const owner = coordinator.activeTurns.get("chat-1")
      expect(owner?.provider).toBe("codex")
      expect(owner?.status).toBe("starting")
      if (kind === "stream error") events.push("fail")
      else events.push({ type: "transcript", entry: timestamped({ kind: "system_init", model: "old-model" }) })
      await new Promise(resolve => setTimeout(resolve, 10))
      expect(failures).toBe(0)
      expect(owner.status).toBe("starting")
      expect(coordinator.activeTurns.get("chat-1")).toBe(owner)
    } finally { release(); events.close(); await successor; coordinator.dispose() }
  })


  test.each(["headers", "deferred prefix"])("main review: failed %s loading releases the provisional owner", async kind => {
    const store = createFakeStore()
    store.chat.provider = "claude"
    store.chat.title = "Existing conversation"
    store.chat.sessionToken = "preserved-native"
    if (kind === "headers") store.getContextBounds = () => { throw new Error("local history read failed") }
    else store.getMessages = () => { throw new Error("local history read failed") }
    const coordinator = new AgentCoordinator({ store: store as never, onStateChange: () => {} }) as any
    try {
      await expect(coordinator.startTurnForChat({ chatId: "chat-1", provider: "claude", content: "replacement",
        attachments: [], model: "model", planMode: false, autoPlan: false, appendUserPrompt: true,
        ...(kind === "deferred prefix" ? { replaceTranscriptPrefix: [] } : {}) })).rejects.toThrow("local history read failed")
      expect(coordinator.activeTurns.has("chat-1")).toBe(false)
      expect(store.chat.sessionToken).toBe("preserved-native")
    } finally { coordinator.dispose() }
  })
})


describe("ordinary user prompt delivery", () => {
  for (const provider of ["claude", "codex", "cursor", "grok", "pi"] as const) {
    test(`${provider} receives the user's text without automatic Kanna instructions`, async () => {
      const events = new AsyncEventQueue<any>()
      const prompts: string[] = []
      const content = "  Explain this change.\nKeep my formatting.  "
      const manager = {
        async startSession() { return { sessionToken: "native-session", resumeFellBack: false } },
        async listModels() { return [] },
        async startTurn(args: { content: string }): Promise<HarnessTurn> {
          prompts.push(args.content)
          return { provider, stream: events, interrupt: async () => {}, close: () => {} }
        },
      }
      const store = createFakeStore()
      store.chat.provider = provider
      const coordinator = new AgentCoordinator({
        store: store as never,
        onStateChange: () => {},
        codexManager: manager as never,
        cursorManager: manager as never,
        grokManager: manager as never,
        piManager: manager as never,
        resolvePiConnection: async () => ({ provider: "openai", baseUrl: "https://example.invalid", apiKey: "test" }),
        startClaudeSession: async () => ({
          provider: "claude", stream: events,
          interrupt: async () => {}, close: () => {},
          sendPrompt: async (text: string) => { prompts.push(text) },
          setModel: async () => {}, setPermissionMode: async () => {},
        }),
      })
      try {
        await coordinator.send({ type: "chat.send", chatId: "chat-1", provider, content, model: "test-model" })
        expect(prompts).toEqual(["Explain this change.\nKeep my formatting."])
      } finally {
        await coordinator.cancel("chat-1")
        events.close()
      }
    })
  }
})


  test("a missing prepared Claude edit restores only its admissible prefix", async () => {
  const store = createFakeStore()
  store.chat.provider = "claude"
  store.chat.sessionToken = "original-source"
  const prefix = [timestamped({ kind: "user_prompt", content: "allowed task" }), timestamped({ kind: "assistant_text", text: "allowed reply" })]
  store.messages.push(...prefix, timestamped({ kind: "user_prompt", content: "discard task" }), timestamped({ kind: "assistant_text", text: "discard answer" }))
  const stream = new AsyncEventQueue<any>()
  const tokens: Array<string | null> = []
  const sent: string[] = []
  const checked: Array<string | null | undefined> = []
  const outcomes: any[] = []
  const coordinator = new AgentCoordinator({ store: store as never, onStateChange: () => {},
    checkSessionArtifact: (_provider, args) => { checked.push(args.sessionToken); return args.sessionToken === "prepared-prefix" ? "missing" : "present" },
    startClaudeSession: async args => {
      tokens.push(args.sessionToken)
      return { provider: "claude", stream, startupOutcome: { kind: args.sessionToken ? "resumed" : "fresh" }, interrupt: async () => {}, close: () => stream.close(), setModel: async () => {}, setPermissionMode: async () => {}, sendPrompt: async content => { sent.push(content) } }
    },
  })
  try {
    await (coordinator as any).startTurnForChat({ chatId: "chat-1", provider: "claude", content: "replacement", attachments: [], model: "opus", planMode: false, autoPlan: false, appendUserPrompt: true,
      sessionToken: "prepared-prefix", resetSession: true, forkSession: false, replaceTranscriptPrefix: prefix,
      onProviderReady: async (_isCurrentTurn: any, outcome: any) => { outcomes.push(outcome) },
    })
    expect(checked).toContain("prepared-prefix")
    expect(tokens).toEqual([null])
    expect(outcomes[0].kind).toBe("fresh")
    expect(sent[0]).toContain("allowed reply")
    expect(sent[0]).not.toContain("discard answer")
    expect(sent[0]).not.toContain("/tmp/transcripts/chat-1.jsonl")
  } finally { stream.close() }
})


  for (const stop of ["cancel", "close", "dispose"] as const) {
  test(`${stop} while a Claude edit mapper is pending invalidates only its reservation and cannot adopt its prefix`, async () => {
    let release!: () => void, entered!: () => void
    const blocked = new Promise<void>(resolve => { release = resolve })
    const observed = new Promise<void>(resolve => { entered = resolve })
    const store = createFakeStore()
    store.chat.provider = "claude"
    store.chat.title = "Existing conversation"
    store.chat.sessionToken = "source-session"
    const target = timestamped({ kind: "user_prompt", content: "second question" })
    store.messages = [timestamped({ kind: "user_prompt", content: "first question" }),
      timestamped({ kind: "assistant_text", text: "first answer", messageId: "native-answer" }), target]
    const sent: string[] = [], tokens: Array<string | null> = []
    const events = new AsyncEventQueue<any>()
    const coordinator = new AgentCoordinator({ store: store as never, onStateChange: () => {},
      prepareClaudeSession: async args => { entered(); await blocked; return { sessionToken: "obsolete-prepared", transcriptPrefix: args.transcriptPrefix } },
      startClaudeSession: async args => { tokens.push(args.sessionToken); return { provider: "claude", stream: events, startupOutcome: { kind: "resumed" },
        interrupt: async () => {}, close: () => events.close(), setModel: async () => {}, setPermissionMode: async () => {}, sendPrompt: async content => { sent.push(content) } } },
    })
    const edit = coordinator.editUserPrompt({ type: "chat.editUserPrompt", chatId: "chat-1", messageId: target._id, content: "cancelled edit" })
    try {
      await observed
      if (stop === "cancel") await coordinator.cancel("chat-1"); else if (stop === "close") await coordinator.closeChat("chat-1"); else coordinator.dispose()
      await coordinator.send({ type: "chat.send", chatId: "chat-1", provider: "claude", content: "successor input" })
      release(); await edit
      expect(tokens).toEqual(["source-session"])
      expect(sent).toEqual(["successor input"])
      expect(store.chat.sessionToken).toBe("source-session")
      expect(store.messages.some(entry => entry.kind === "user_prompt" && entry.content === "second question")).toBe(true)
      expect(store.messages.some(entry => entry.kind === "user_prompt" && entry.content === "cancelled edit")).toBe(false)
      expect((coordinator as any).preparedClaudeEditSessions.size).toBe(0)
    } finally { release(); await edit.catch(() => {}); events.close() }
  })
}

afterAll(() => {for(const dir of fakeStoreDirectories) rmSync(dir,{recursive:true,force:true})})
