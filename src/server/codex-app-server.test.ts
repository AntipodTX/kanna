import { timestamped } from "./transcript"
import { describe, expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import { CodexAppServerManager } from "./codex-app-server"

class FakeCodexProcess extends EventEmitter {
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly messages: unknown[] = []
  killed = false

  constructor(
    private readonly onMessage?: (message: any, process: FakeCodexProcess) => void
  ) {
    super()
    let buffer = ""
    this.stdin.on("data", (chunk) => {
      buffer += chunk.toString()
      const lines = buffer.split("\n")
      buffer = lines.pop() ?? ""
      for (const line of lines) {
        if (!line.trim()) continue
        const message = JSON.parse(line)
        this.messages.push(message)
        this.onMessage?.(message, this)
      }
    })
  }

  kill() {
    this.killed = true
    this.emit("close", 0)
  }

  writeServerMessage(message: unknown) {
    this.stdout.write(`${JSON.stringify(message)}\n`)
  }

  writeStderr(message: string) {
    this.stderr.write(`${message}\n`)
  }

  closeWithCode(code: number) {
    this.emit("close", code)
  }
}

async function collectStream(stream: AsyncIterable<any>) {
  const items: any[] = []
  for await (const item of stream) {
    items.push(item)
  }
  return items
}

function compactionProcess(onCompact?: (message: any, child: FakeCodexProcess) => void) {
  return new FakeCodexProcess((message, child) => {
    if (message.method === "initialize") {
      child.writeServerMessage({ id: message.id, result: { userAgent: "codex-test" } })
    } else if (message.method === "thread/start" || message.method === "thread/resume") {
      child.writeServerMessage({ id: message.id, result: { thread: { id: "thread-1" }, model: "gpt-5.4", reasoningEffort: "high" } })
    } else if (message.method === "thread/compact/start") {
      if (onCompact) onCompact(message, child)
      else child.writeServerMessage({ id: message.id, result: {} })
    }
  })
}

function compactionStarted(process: FakeCodexProcess) {
  process.writeServerMessage({ method: "turn/started", params: { threadId: "thread-1", turn: { id: "compact-1", status: "inProgress" } } })
}

describe("CodexAppServerManager", () => {
  test("initializes app-server and starts a fresh thread", async () => {
    const process = new FakeCodexProcess((message, child) => {
      if (message.method === "initialize") {
        child.writeServerMessage({ id: message.id, result: { userAgent: "codex-test" } })
      } else if (message.method === "thread/start") {
        child.writeServerMessage({
          id: message.id,
          result: { thread: { id: "thread-1" }, model: "gpt-5.4", reasoningEffort: "high" },
        })
      }
    })

    const manager = new CodexAppServerManager({
      spawnProcess: () => process as never,
    })

    await manager.startSession({
      chatId: "chat-1",
      cwd: "/tmp/project",
      model: "gpt-5.4",
      sessionToken: null,
    })

    expect(process.messages).toHaveLength(3)
    expect((process.messages[0] as any).method).toBe("initialize")
    expect((process.messages[0] as any).params.capabilities).toMatchObject({
      experimentalApi: true,
      requestAttestation: false,
    })
    expect((process.messages[1] as any).method).toBe("initialized")
    expect((process.messages[2] as any).method).toBe("thread/start")
    expect((process.messages[2] as any).params.experimentalRawEvents).toBe(false)
    expect((process.messages[2] as any).params).not.toHaveProperty("persistExtendedHistory")
  })

  test("falls back to thread/start when thread/resume is recoverably missing", async () => {
    const process = new FakeCodexProcess((message, child) => {
      if (message.method === "initialize") {
        child.writeServerMessage({ id: message.id, result: { userAgent: "codex-test" } })
      } else if (message.method === "thread/resume") {
        child.writeServerMessage({
          id: message.id,
          error: { message: "thread/resume failed: thread not found" },
        })
      } else if (message.method === "thread/start") {
        child.writeServerMessage({
          id: message.id,
          result: { thread: { id: "thread-2" }, model: "gpt-5.4", reasoningEffort: "high" },
        })
      }
    })

    const manager = new CodexAppServerManager({
      spawnProcess: () => process as never,
    })

    const started = await manager.startSession({
      chatId: "chat-1",
      cwd: "/tmp/project",
      model: "gpt-5.4",
      sessionToken: "missing-thread",
    })

    expect(started).toEqual({ sessionToken: "thread-2", resumeFellBack: true })
    expect(process.messages.map((message: any) => message.method)).toEqual([
      "initialize",
      "initialized",
      "thread/resume",
      "thread/start",
    ])
    expect((process.messages[2] as any).params).not.toHaveProperty("persistExtendedHistory")
    expect((process.messages[3] as any).params).not.toHaveProperty("persistExtendedHistory")
  })

  // Regression coverage for the real-world "thread/resume failed: thread X
  // already has an active writer" incidents (both observed on Codex chats).
  // handleErrorNotification's non-retryable branch calls failContext(),
  // which used to clear the manager's own bookkeeping (this.sessions,
  // context.closed) without killing context.child — the app-server
  // subprocess for the old thread stayed running, so a later retry spawned
  // a second process that collided with the still-alive first one over the
  // same thread's write lock.
  test("a non-retryable error notification kills the app-server child process", async () => {
    const firstProcess = new FakeCodexProcess((message, child) => {
      if (message.method === "initialize") {
        child.writeServerMessage({ id: message.id, result: { userAgent: "codex-test" } })
      } else if (message.method === "thread/start") {
        child.writeServerMessage({
          id: message.id,
          result: { thread: { id: "thread-1" }, model: "gpt-5.4", reasoningEffort: "high" },
        })
      } else if (message.method === "turn/start") {
        child.writeServerMessage({ id: message.id, result: { turn: { id: "turn-1", status: "in_progress", error: null } } })
        // A fatal, non-retryable error arriving mid-turn — e.g. a usage-limit hit.
        child.writeServerMessage({
          method: "error",
          params: { error: { message: "You've hit your usage limit." }, willRetry: false },
        })
      }
    })

    const processes = [firstProcess]
    const manager = new CodexAppServerManager({
      spawnProcess: () => (processes.shift() ?? firstProcess) as never,
    })

    await manager.startSession({ chatId: "chat-1", cwd: "/tmp/project", model: "gpt-5.4", sessionToken: null })
    const turn = await manager.startTurn({
      chatId: "chat-1",
      model: "gpt-5.4",
      content: "do something",
      planMode: false,
      onToolRequest: async () => ({}),
    })
    const events = await collectStream(turn.stream)
    expect(events.some((event: any) => event.type === "transcript" && event.entry.kind === "result" && event.entry.isError)).toBe(true)

    // failContext() must kill the real process, not just clear bookkeeping —
    // otherwise it survives orphaned, still holding thread-1's write lock.
    expect(firstProcess.killed).toBe(true)

    // A retry (matching a user's "Continue"/"Resume") sees no session for
    // chat-1 anymore and spawns a brand-new process. Since the old one is
    // now actually dead, this is a clean resume rather than a collision.
    const secondProcess = new FakeCodexProcess((message, child) => {
      if (message.method === "initialize") {
        child.writeServerMessage({ id: message.id, result: { userAgent: "codex-test" } })
      } else if (message.method === "thread/resume") {
        child.writeServerMessage({
          id: message.id,
          result: { thread: { id: "thread-1" }, model: "gpt-5.4", reasoningEffort: "high" },
        })
      }
    })
    processes.push(secondProcess)

    await manager.startSession({ chatId: "chat-1", cwd: "/tmp/project", model: "gpt-5.4", sessionToken: "thread-1" })

    expect(secondProcess.messages.map((message: any) => message.method)).toContain("thread/resume")
    expect(firstProcess.killed).toBe(true)
  })

  test("forks a thread when a pending fork session token is provided", async () => {
    const process = new FakeCodexProcess((message, child) => {
      if (message.method === "initialize") {
        child.writeServerMessage({ id: message.id, result: { userAgent: "codex-test" } })
      } else if (message.method === "thread/fork") {
        child.writeServerMessage({
          id: message.id,
          result: { thread: { id: "thread-fork-1" }, model: "gpt-5.4", reasoningEffort: "high" },
        })
      }
    })

    const manager = new CodexAppServerManager({
      spawnProcess: () => process as never,
    })

    const started = await manager.startSession({
      chatId: "chat-1",
      cwd: "/tmp/project",
      model: "gpt-5.4",
      sessionToken: null,
      pendingForkSessionToken: "thread-source",
    })

    expect(started).toEqual({ sessionToken: "thread-fork-1", resumeFellBack: false })
    expect(process.messages.map((message: any) => message.method)).toEqual([
      "initialize",
      "initialized",
      "thread/fork",
    ])
  })

  test("maps fast mode and reasoning into app-server params", async () => {
    const process = new FakeCodexProcess((message, child) => {
      if (message.method === "initialize") {
        child.writeServerMessage({ id: message.id, result: { userAgent: "codex-test" } })
      } else if (message.method === "thread/start") {
        child.writeServerMessage({
          id: message.id,
          result: { thread: { id: "thread-1" }, model: "gpt-5.4", reasoningEffort: "high" },
        })
      } else if (message.method === "turn/start") {
        child.writeServerMessage({
          id: message.id,
          result: { turn: { id: "turn-1", status: "completed", error: null } },
        })
        child.writeServerMessage({
          method: "turn/completed",
          params: {
            threadId: "thread-1",
            turn: { id: "turn-1", status: "completed", error: null },
          },
        })
      }
    })

    const manager = new CodexAppServerManager({
      spawnProcess: () => process as never,
    })

    await manager.startSession({
      chatId: "chat-1",
      cwd: "/tmp/project",
      model: "gpt-5.4",
      serviceTier: "fast",
      sessionToken: null,
    })

    const turn = await manager.startTurn({
      chatId: "chat-1",
      model: "gpt-5.4",
      effort: "xhigh",
      serviceTier: "fast",
      content: "Run pwd",
      planMode: false,
      onToolRequest: async () => ({}),
    })

    await collectStream(turn.stream)

    const threadStart = process.messages.find((message: any) => message.method === "thread/start") as
      | { method: "thread/start"; params: { approvalPolicy?: string; serviceTier?: string } }
      | undefined
    const turnStart = process.messages.find((message: any) => message.method === "turn/start") as
      | { method: "turn/start"; params: { approvalPolicy?: string; effort?: string; serviceTier?: string; collaborationMode?: { settings?: { reasoning_effort?: string | null } } } }
      | undefined

    expect(threadStart?.params.approvalPolicy).toBe("on-request")
    expect(threadStart?.params.serviceTier).toBe("fast")
    expect(turnStart?.params.approvalPolicy).toBe("on-request")
    expect(turnStart?.params.effort).toBe("xhigh")
    expect(turnStart?.params.serviceTier).toBe("fast")
    expect(turnStart?.params.collaborationMode?.settings?.reasoning_effort).toBe("xhigh")
  })

  test("attaches a structured skill item plus system-message failsafe when invoking a skill", async () => {
    const process = new FakeCodexProcess((message, child) => {
      if (message.method === "initialize") {
        child.writeServerMessage({ id: message.id, result: { userAgent: "codex-test" } })
      } else if (message.method === "thread/start") {
        child.writeServerMessage({
          id: message.id,
          result: { thread: { id: "thread-1" }, model: "gpt-5.4", reasoningEffort: "high" },
        })
      } else if (message.method === "turn/start") {
        child.writeServerMessage({
          id: message.id,
          result: { turn: { id: "turn-1", status: "completed", error: null } },
        })
        child.writeServerMessage({
          method: "turn/completed",
          params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed", error: null } },
        })
      }
    })

    const manager = new CodexAppServerManager({ spawnProcess: () => process as never })
    await manager.startSession({ chatId: "chat-1", cwd: "/tmp/project", model: "gpt-5.4", sessionToken: null })

    const turn = await manager.startTurn({
      chatId: "chat-1",
      model: "gpt-5.4",
      content: "/deploy-helper ship to prod",
      skills: [{ name: "deploy-helper", path: "/tmp/project/.agents/skills/deploy-helper/SKILL.md" }],
      planMode: false,
      onToolRequest: async () => ({}),
    })
    await collectStream(turn.stream)

    const turnStart = process.messages.find((message: any) => message.method === "turn/start") as any
    expect(turnStart.params.input).toHaveLength(2)
    expect(turnStart.params.input[0].type).toBe("text")
    expect(turnStart.params.input[0].text.startsWith("/deploy-helper ship to prod")).toBe(true)
    expect(turnStart.params.input[0].text).toContain(
      "<system-message>the user would like to use the skill available at /tmp/project/.agents/skills/deploy-helper/SKILL.md</system-message>"
    )
    expect(turnStart.params.input[1]).toEqual({
      type: "skill",
      name: "deploy-helper",
      path: "/tmp/project/.agents/skills/deploy-helper/SKILL.md",
    })
  })

  test("listSkills maps skills/list and filters disabled skills", async () => {
    const process = new FakeCodexProcess((message, child) => {
      if (message.method === "initialize") {
        child.writeServerMessage({ id: message.id, result: { userAgent: "codex-test" } })
      } else if (message.method === "thread/start") {
        child.writeServerMessage({
          id: message.id,
          result: { thread: { id: "thread-1" }, model: "gpt-5.4", reasoningEffort: "high" },
        })
      } else if (message.method === "skills/list") {
        child.writeServerMessage({
          id: message.id,
          result: {
            data: [
              {
                cwd: "/tmp/project",
                skills: [
                  {
                    name: "deploy-helper",
                    description: "Deploys things",
                    path: "/tmp/project/.agents/skills/deploy-helper/SKILL.md",
                    scope: "repo",
                    enabled: true,
                  },
                  {
                    name: "disabled-skill",
                    description: "Off",
                    path: "/tmp/project/.agents/skills/disabled-skill/SKILL.md",
                    scope: "repo",
                    enabled: false,
                  },
                ],
              },
            ],
          },
        })
      }
    })

    const manager = new CodexAppServerManager({ spawnProcess: () => process as never })
    await manager.startSession({ chatId: "chat-1", cwd: "/tmp/project", model: "gpt-5.4", sessionToken: null })

    const skills = await manager.listSkills({ chatId: "chat-1", cwd: "/tmp/project" })
    expect(skills?.map((skill) => skill.name)).toEqual(["deploy-helper"])

    const request = process.messages.find((message: any) => message.method === "skills/list") as any
    expect(request.params.cwds).toEqual(["/tmp/project"])
  })

  test("listSkills degrades to null when the server lacks skills/list", async () => {
    const process = new FakeCodexProcess((message, child) => {
      if (message.method === "initialize") {
        child.writeServerMessage({ id: message.id, result: { userAgent: "codex-test" } })
      } else if (message.method === "thread/start") {
        child.writeServerMessage({
          id: message.id,
          result: { thread: { id: "thread-1" }, model: "gpt-5.4", reasoningEffort: "high" },
        })
      } else if (message.method === "skills/list") {
        child.writeServerMessage({ id: message.id, error: { code: -32601, message: "method not found" } })
      }
    })

    const manager = new CodexAppServerManager({ spawnProcess: () => process as never })
    await manager.startSession({ chatId: "chat-1", cwd: "/tmp/project", model: "gpt-5.4", sessionToken: null })

    expect(await manager.listSkills({ chatId: "chat-1", cwd: "/tmp/project" })).toBeNull()
    expect(await manager.listSkills({ chatId: "chat-unknown", cwd: "/tmp/project" })).toBeNull()
  })

  test.each(["live", "probe"])("waits for actual compaction completion on a %s app-server", async (mode) => {
    const process = new FakeCodexProcess((message, child) => {
      if (message.method === "initialize") {
        child.writeServerMessage({ id: message.id, result: { userAgent: "codex-test" } })
      } else if (message.method === "thread/start" || message.method === "thread/resume") {
        child.writeServerMessage({
          id: message.id,
          result: { thread: { id: "thread-1" }, model: "gpt-5.4", reasoningEffort: "high" },
        })
      } else if (message.method === "thread/compact/start") {
        child.writeServerMessage({ id: message.id, result: {} })
      }
    })

    const manager = new CodexAppServerManager({ spawnProcess: () => process as never })
    if (mode === "live") {
      await manager.startSession({ chatId: "chat-1", cwd: "/tmp/project", model: "gpt-5.4", sessionToken: null })
    }

    let finished = false
    const compact = manager.runSlashCommand({
      chatId: mode === "live" ? "chat-1" : undefined,
      cwd: "/tmp/project",
      threadId: "thread-1",
      command: "/compact",
    }).then(() => { finished = true })
    await new Promise((resolve) => setTimeout(resolve, 10))

    const request = process.messages.find((message: any) => message.method === "thread/compact/start") as any
    expect(request.params).toEqual({ threadId: "thread-1" })
    expect(finished).toBe(false)
    expect(process.killed).toBe(false)
    process.writeServerMessage({ method: "turn/started", params: { threadId: "thread-1", turn: { id: "compact-1", status: "inProgress" } } })
    process.writeServerMessage({ method: "item/completed", params: { threadId: "thread-1", turnId: "compact-1",
      item: { id: "compact-item", type: "contextCompaction" } } })
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(finished).toBe(false)
    process.writeServerMessage({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "compact-1", status: "completed" } } })
    await compact
    expect(finished).toBe(true)
    expect(process.killed).toBe(mode === "probe")
  })

  test("correlates compaction events and waits for an ACK even when lifecycle notifications arrive first", async () => {
    let compactRequest: any
    const process = compactionProcess((message) => { compactRequest = message })
    const manager = new CodexAppServerManager({ spawnProcess: () => process as never })
    await manager.startSession({ chatId: "chat-1", cwd: "/tmp/project", model: "gpt-5.4", sessionToken: null })
    let finished = false
    const compact = manager.runSlashCommand({ chatId: "chat-1", cwd: "/tmp/project", threadId: "thread-1", command: "/compact" })
      .then(() => { finished = true })
    compactionStarted(process)
    process.writeServerMessage({ method: "error", params: { threadId: "thread-1", turnId: "compact-1", willRetry: true, error: { message: "Reconnecting" } } })
    process.writeServerMessage({ method: "thread/compacted", params: { threadId: "different", turnId: "compact-1" } })
    process.writeServerMessage({ method: "thread/compacted", params: { threadId: "thread-1", turnId: "different" } })
    process.writeServerMessage({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "different", status: "completed" } } })
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(finished).toBe(false)
    await expect(manager.runSlashCommand({ chatId: "chat-1", cwd: "/tmp/project", threadId: "thread-1", command: "/compact" }))
      .rejects.toThrow("already running")
    await expect(manager.startTurn({ chatId: "chat-1", model: "gpt-5.4", content: "follow up", planMode: false, onToolRequest: async () => ({}) }))
      .rejects.toThrow("already running")
    process.writeServerMessage({ method: "thread/compacted", params: { threadId: "thread-1", turnId: "compact-1" } })
    process.writeServerMessage({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "compact-1", status: "completed" } } })
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(finished).toBe(false)
    process.writeServerMessage({ id: compactRequest.id, result: {} })
    await compact
    expect(finished).toBe(true)
  })

  test.each(["failed", "interrupted", "missing-result"])("rejects unsuccessful compaction (%s)", async (outcome) => {
    const process = compactionProcess()
    const manager = new CodexAppServerManager({ spawnProcess: () => process as never })
    await manager.startSession({ chatId: "chat-1", cwd: "/tmp/project", model: "gpt-5.4", sessionToken: null })
    const compact = manager.runSlashCommand({ chatId: "chat-1", cwd: "/tmp/project", threadId: "thread-1", command: "/compact" })
    const result = compact.catch((error: Error) => error)
    compactionStarted(process)
    process.writeServerMessage({ method: "turn/completed", params: { threadId: "thread-1",
      turn: { id: "compact-1", status: outcome === "missing-result" ? "completed" : outcome } } })
    expect(await result).toMatchObject({ message: expect.stringContaining(outcome === "missing-result" ? "without a compaction result" : outcome) })
    expect(manager.getResourceCounts().codexPendingRequests).toBe(0)
    manager.stopSession("chat-1")
  })

  test("clears a compaction request when its turn fails before the ACK", async () => {
    const process = compactionProcess((_message, child) => {
      compactionStarted(child)
      child.writeServerMessage({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "compact-1", status: "failed" } } })
    })
    const manager = new CodexAppServerManager({ spawnProcess: () => process as never })
    await manager.startSession({ chatId: "chat-1", cwd: "/tmp/project", model: "gpt-5.4", sessionToken: null })
    await expect(manager.runSlashCommand({ chatId: "chat-1", cwd: "/tmp/project", threadId: "thread-1", command: "/compact" })).rejects.toThrow("failed")
    expect(manager.getResourceCounts().codexPendingRequests).toBe(0)
    manager.stopSession("chat-1")
  })

  test.each(["exit", "error", "stop"])("rejects compaction when the process is lost (%s)", async (outcome) => {
    const process = compactionProcess()
    const manager = new CodexAppServerManager({ spawnProcess: () => process as never })
    await manager.startSession({ chatId: "chat-1", cwd: "/tmp/project", model: "gpt-5.4", sessionToken: null })
    const compact = manager.runSlashCommand({ chatId: "chat-1", cwd: "/tmp/project", threadId: "thread-1", command: "/compact" })
    const result = compact.catch((error: Error) => error)
    if (outcome === "exit") process.closeWithCode(1)
    else if (outcome === "stop") manager.stopSession("chat-1")
    else process.writeServerMessage({ method: "error", params: { threadId: "thread-1", willRetry: false, error: { message: "compact failed" } } })
    expect(await result).toMatchObject({ message: expect.stringContaining(outcome === "exit" ? "exited" : outcome === "error" ? "compact failed" : "session closed") })
    expect(manager.getResourceCounts().codexSessions).toBe(0)
    expect(manager.getResourceCounts().codexPendingRequests).toBe(0)
  })

  test.each(["live", "probe"])("times out compaction without an ACK or completion on a %s process", async (mode) => {
    const process = compactionProcess(() => {})
    const manager = new CodexAppServerManager({ spawnProcess: () => process as never, compactionTimeoutMs: 30 })
    if (mode === "live") await manager.startSession({ chatId: "chat-1", cwd: "/tmp/project", model: "gpt-5.4", sessionToken: null })
    await expect(manager.runSlashCommand({ chatId: mode === "live" ? "chat-1" : undefined,
      cwd: "/tmp/project", threadId: "thread-1", command: "/compact" })).rejects.toThrow("timed out")
    expect(process.killed).toBe(true)
    expect(manager.getResourceCounts().codexSessions).toBe(0)
    expect(manager.getResourceCounts().codexPendingRequests).toBe(0)
  })

  test.each(["live", "probe"])("times out compaction after its ACK when completion never arrives on a %s process", async (mode) => {
    let acknowledged = false
    const process = compactionProcess((message, child) => {
      acknowledged = true
      child.writeServerMessage({ id: message.id, result: {} })
      compactionStarted(child)
    })
    const manager = new CodexAppServerManager({ spawnProcess: () => process as never, compactionTimeoutMs: 60 })
    if (mode === "live") await manager.startSession({ chatId: "chat-1", cwd: "/tmp/project", model: "gpt-5.4", sessionToken: null })
    const result = manager.runSlashCommand({ chatId: mode === "live" ? "chat-1" : undefined,
      cwd: "/tmp/project", threadId: "thread-1", command: "/compact" }).catch((error: Error) => error)
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(acknowledged).toBe(true)
    expect(process.killed).toBe(false)
    expect(manager.getResourceCounts().codexPendingRequests).toBe(0)
    expect(await result).toMatchObject({ message: expect.stringContaining("timed out") })
    expect(process.killed).toBe(true)
    expect(manager.getResourceCounts().codexSessions).toBe(0)
    expect(manager.getResourceCounts().codexPendingRequests).toBe(0)
  })

  test("clears a rejected compaction start before a later command", async () => {
    let attempts = 0
    const process = compactionProcess((message, child) => {
      if (attempts++ === 0) child.writeServerMessage({ id: message.id, error: { code: -32601, message: "method not found" } })
      else {
        child.writeServerMessage({ id: message.id, result: {} })
        compactionStarted(child)
        child.writeServerMessage({ method: "item/completed", params: { threadId: "thread-1", turnId: "compact-1", item: { id: "item-1", type: "contextCompaction" } } })
        child.writeServerMessage({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "compact-1", status: "completed" } } })
      }
    })
    const manager = new CodexAppServerManager({ spawnProcess: () => process as never })
    await manager.startSession({ chatId: "chat-1", cwd: "/tmp/project", model: "gpt-5.4", sessionToken: null })
    const command = { chatId: "chat-1", cwd: "/tmp/project", threadId: "thread-1", command: "/compact" }
    await expect(manager.runSlashCommand(command)).rejects.toThrow("method not found")
    await manager.runSlashCommand(command)
    expect(attempts).toBe(2)
    expect(manager.getResourceCounts().codexPendingRequests).toBe(0)
  })

  test("listModels probes a throwaway app-server, pages model/list and drops hidden rows", async () => {
    const row = (model: string, extra: Record<string, unknown> = {}) => ({
      id: model,
      model,
      displayName: model,
      description: "",
      hidden: false,
      isDefault: false,
      defaultReasoningEffort: "medium",
      supportedReasoningEfforts: [{ reasoningEffort: "medium", description: "" }],
      ...extra,
    })
    const process = new FakeCodexProcess((message, child) => {
      if (message.method === "initialize") {
        child.writeServerMessage({ id: message.id, result: { userAgent: "codex-test" } })
      } else if (message.method === "model/list") {
        child.writeServerMessage(message.params.cursor === "page-2"
          ? { id: message.id, result: { data: [row("gpt-5.6-sol")], nextCursor: null } }
          : { id: message.id, result: { data: [row("gpt-6-astra"), row("gpt-reserve", { hidden: true })], nextCursor: "page-2" } })
      }
    })
    const manager = new CodexAppServerManager({ spawnProcess: () => process as never })

    const models = await manager.listModels("/tmp/home")
    expect(models?.map((model) => model.model)).toEqual(["gpt-6-astra", "gpt-5.6-sol"])
    expect(process.messages.map((message: any) => message.method)).toEqual([
      "initialize",
      "initialized",
      "model/list",
      "model/list",
    ])
    expect((process.messages[2] as any).params).toEqual({})
    expect((process.messages[3] as any).params).toEqual({ cursor: "page-2" })
    // The probe process is torn down once the list is in.
    expect(process.killed).toBe(true)
  })

  test("listModels reuses a live session and surfaces an old server's method-not-found", async () => {
    const process = new FakeCodexProcess((message, child) => {
      if (message.method === "initialize") {
        child.writeServerMessage({ id: message.id, result: { userAgent: "codex-test" } })
      } else if (message.method === "thread/start") {
        child.writeServerMessage({
          id: message.id,
          result: { thread: { id: "thread-1" }, model: "gpt-5.4", reasoningEffort: "high" },
        })
      } else if (message.method === "model/list") {
        child.writeServerMessage({ id: message.id, error: { code: -32601, message: "method not found" } })
      }
    })
    const manager = new CodexAppServerManager({ spawnProcess: () => process as never })
    await manager.startSession({ chatId: "chat-1", cwd: "/tmp/project", model: "gpt-5.4", sessionToken: null })

    await expect(manager.listModels("/tmp/home")).rejects.toThrow("method not found")
    // No second process: the chat's own app-server answered.
    expect(process.messages.filter((message: any) => message.method === "initialize")).toHaveLength(1)
    expect(process.killed).toBe(false)
  })

  test("forwards every supported GPT-5.6 model and reasoning combination", async () => {
    const combinations = [
      ...(["low", "medium", "high", "xhigh", "max", "ultra"] as const)
        .map((effort) => ({ model: "gpt-5.6-sol", effort })),
      ...(["low", "medium", "high", "xhigh", "max", "ultra"] as const)
        .map((effort) => ({ model: "gpt-5.6-terra", effort })),
      ...(["low", "medium", "high", "xhigh", "max"] as const)
        .map((effort) => ({ model: "gpt-5.6-luna", effort })),
    ]

    expect(combinations).toHaveLength(17)

    for (const [index, combination] of combinations.entries()) {
      const threadId = `thread-matrix-${index}`
      const process = new FakeCodexProcess((message, child) => {
        if (message.method === "initialize") {
          child.writeServerMessage({ id: message.id, result: { userAgent: "codex-test" } })
        } else if (message.method === "thread/start") {
          child.writeServerMessage({
            id: message.id,
            result: { thread: { id: threadId }, model: combination.model, reasoningEffort: combination.effort },
          })
        } else if (message.method === "turn/start") {
          child.writeServerMessage({
            id: message.id,
            result: { turn: { id: `turn-matrix-${index}`, status: "completed", error: null } },
          })
          child.writeServerMessage({
            method: "turn/completed",
            params: {
              threadId,
              turn: { id: `turn-matrix-${index}`, status: "completed", error: null },
            },
          })
        }
      })
      const manager = new CodexAppServerManager({ spawnProcess: () => process as never })
      const chatId = `chat-matrix-${index}`

      await manager.startSession({
        chatId,
        cwd: "/tmp/project",
        model: combination.model,
        sessionToken: null,
      })
      const turn = await manager.startTurn({
        chatId,
        model: combination.model,
        effort: combination.effort,
        content: "matrix test",
        planMode: false,
        onToolRequest: async () => ({}),
      })
      await collectStream(turn.stream)

      const threadStart = process.messages.find((message: any) => message.method === "thread/start") as any
      const turnStart = process.messages.find((message: any) => message.method === "turn/start") as any
      expect(threadStart.params.model).toBe(combination.model)
      expect(turnStart.params.model).toBe(combination.model)
      expect(turnStart.params.effort).toBe(combination.effort)
      expect(turnStart.params.collaborationMode?.settings?.reasoning_effort).toBe(combination.effort)

      manager.stopSession(chatId)
    }
  })

  test("maps thread token usage updates into context window transcript entries", async () => {
    const process = new FakeCodexProcess((message, child) => {
      if (message.method === "initialize") {
        child.writeServerMessage({ id: message.id, result: { userAgent: "codex-test" } })
      } else if (message.method === "thread/start") {
        child.writeServerMessage({
          id: message.id,
          result: { thread: { id: "thread-usage" }, model: "gpt-5.4", reasoningEffort: "high" },
        })
      } else if (message.method === "turn/start") {
        child.writeServerMessage({
          id: message.id,
          result: { turn: { id: "turn-usage", status: "completed", error: null } },
        })
        child.writeServerMessage({
          method: "thread/tokenUsage/updated",
          params: {
            threadId: "thread-usage",
            turnId: "turn-usage",
            tokenUsage: {
              total: {
                inputTokens: 11_833,
                cachedInputTokens: 3456,
                outputTokens: 6,
                reasoningOutputTokens: 0,
                totalTokens: 11_839,
              },
              last: {
                inputTokens: 120,
                cachedInputTokens: 0,
                outputTokens: 6,
                reasoningOutputTokens: 0,
                totalTokens: 126,
              },
              modelContextWindow: 258_400,
            },
          },
        })
        child.writeServerMessage({
          method: "turn/completed",
          params: {
            threadId: "thread-usage",
            turn: { id: "turn-usage", status: "completed", error: null },
          },
        })
      }
    })

    const manager = new CodexAppServerManager({
      spawnProcess: () => process as never,
    })

    await manager.startSession({
      chatId: "chat-1",
      cwd: "/tmp/project",
      model: "gpt-5.4",
      sessionToken: null,
    })

    const turn = await manager.startTurn({
      chatId: "chat-1",
      model: "gpt-5.4",
      content: "Hello",
      planMode: false,
      onToolRequest: async () => ({}),
    })

    const events = await collectStream(turn.stream)
    const usageEvent = events.find((event) => event.type === "transcript" && event.entry.kind === "context_window_updated")

    expect(usageEvent).toBeDefined()
    if (!usageEvent || usageEvent.type !== "transcript" || usageEvent.entry.kind !== "context_window_updated") {
      throw new Error("missing usage event")
    }

    expect(usageEvent.entry.usage).toMatchObject({
      usedTokens: 126,
      totalProcessedTokens: 11_839,
      maxTokens: 258_400,
      inputTokens: 120,
      cachedInputTokens: 0,
      outputTokens: 6,
      reasoningOutputTokens: 0,
      lastUsedTokens: 126,
      compactsAutomatically: true,
    })
  })

  test("generateStructured returns the final assistant JSON and stops the transient session", async () => {
    const process = new FakeCodexProcess((message, child) => {
      if (message.method === "initialize") {
        child.writeServerMessage({ id: message.id, result: { userAgent: "codex-test" } })
      } else if (message.method === "thread/start") {
        child.writeServerMessage({
          id: message.id,
          result: { thread: { id: "thread-structured" }, model: "gpt-5.5", reasoningEffort: "high" },
        })
      } else if (message.method === "turn/start") {
        child.writeServerMessage({
          id: message.id,
          result: { turn: { id: "turn-structured", status: "completed", error: null } },
        })
        child.writeServerMessage({
          method: "item/completed",
          params: {
            threadId: "thread-structured",
            turnId: "turn-structured",
            item: {
              type: "agentMessage",
              id: "msg-structured",
              text: "{\"title\":\"Codex title\"}",
              phase: "final_answer",
            },
          },
        })
        child.writeServerMessage({
          method: "turn/completed",
          params: {
            threadId: "thread-structured",
            turn: { id: "turn-structured", status: "completed", error: null },
          },
        })
      }
    })

    const manager = new CodexAppServerManager({
      spawnProcess: () => process as never,
    })

    const result = await manager.generateStructured({
      cwd: "/tmp/project",
      prompt: "Return JSON",
      model: "gpt-5.3-codex",
      effort: "low",
      outputSchema: {
        type: "object",
        properties: {
          title: { type: "string" },
        },
        required: ["title"],
        additionalProperties: false,
      },
    })

    expect(result).toBe("{\"title\":\"Codex title\"}")
    expect(process.killed).toBe(true)
    const threadStart = process.messages.find((message: any) => message.method === "thread/start") as
      | { method: "thread/start"; params: { model?: string } }
      | undefined
    const turnStart = process.messages.find((message: any) => message.method === "turn/start") as
      | { method: "turn/start"; params: { model?: string; effort?: string; outputSchema?: unknown } }
      | undefined
    expect(threadStart?.params.model).toBe("gpt-5.3-codex")
    expect(turnStart?.params.model).toBe("gpt-5.3-codex")
    expect(turnStart?.params.effort).toBe("low")
    expect(turnStart?.params.outputSchema).toEqual({
      type: "object",
      properties: {
        title: { type: "string" },
      },
      required: ["title"],
      additionalProperties: false,
    })
  })

  test("maps command execution and agent output into the shared transcript stream", async () => {
    const process = new FakeCodexProcess((message, child) => {
      if (message.method === "initialize") {
        child.writeServerMessage({ id: message.id, result: { userAgent: "codex-test" } })
      } else if (message.method === "thread/start") {
        child.writeServerMessage({
          id: message.id,
          result: { thread: { id: "thread-1" }, model: "gpt-5.4", reasoningEffort: "high" },
        })
      } else if (message.method === "turn/start") {
        child.writeServerMessage({
          id: message.id,
          result: { turn: { id: "turn-1", status: "inProgress", error: null } },
        })
        child.writeServerMessage({
          method: "item/started",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            item: {
              type: "commandExecution",
              id: "call-1",
              command: "/bin/zsh -lc pwd",
              status: "inProgress",
            },
          },
        })
        child.writeServerMessage({
          method: "item/completed",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            item: {
              type: "commandExecution",
              id: "call-1",
              command: "/bin/zsh -lc pwd",
              status: "completed",
              aggregatedOutput: "/tmp/project\n",
              exitCode: 0,
            },
          },
        })
        child.writeServerMessage({
          method: "item/completed",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            item: {
              type: "agentMessage",
              id: "msg-1",
              text: "/tmp/project",
              phase: "final_answer",
            },
          },
        })
        child.writeServerMessage({
          method: "turn/completed",
          params: {
            threadId: "thread-1",
            turn: { id: "turn-1", status: "completed", error: null },
          },
        })
      }
    })

    const manager = new CodexAppServerManager({
      spawnProcess: () => process as never,
    })

    await manager.startSession({
      chatId: "chat-1",
      cwd: "/tmp/project",
      model: "gpt-5.4",
      sessionToken: null,
    })

    const turn = await manager.startTurn({
      chatId: "chat-1",
      model: "gpt-5.4",
      content: "Run pwd",
      planMode: false,
      onToolRequest: async () => ({}),
    })

    const events = await collectStream(turn.stream)
    const transcriptKinds = events
      .filter((event) => event.type === "transcript")
      .map((event) => event.entry.kind)

    expect(events[0]).toEqual({ type: "session_token", sessionToken: "thread-1" })
    expect(transcriptKinds).toEqual(["system_init", "tool_call", "tool_result", "assistant_text", "result"])
  })

  test("emits only a compact boundary when Codex reports thread compaction", async () => {
    const process = new FakeCodexProcess((message, child) => {
      if (message.method === "initialize") {
        child.writeServerMessage({ id: message.id, result: { userAgent: "codex-test" } })
      } else if (message.method === "thread/start") {
        child.writeServerMessage({
          id: message.id,
          result: { thread: { id: "thread-1" }, model: "gpt-5.4", reasoningEffort: "high" },
        })
      } else if (message.method === "turn/start") {
        child.writeServerMessage({
          id: message.id,
          result: { turn: { id: "turn-1", status: "inProgress", error: null } },
        })
        child.writeServerMessage({
          method: "thread/compacted",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
          },
        })
        child.writeServerMessage({
          method: "turn/completed",
          params: {
            threadId: "thread-1",
            turn: { id: "turn-1", status: "completed", error: null },
          },
        })
      }
    })

    const manager = new CodexAppServerManager({
      spawnProcess: () => process as never,
    })

    await manager.startSession({
      chatId: "chat-1",
      cwd: "/tmp/project",
      model: "gpt-5.4",
      sessionToken: null,
    })

    const turn = await manager.startTurn({
      chatId: "chat-1",
      model: "gpt-5.4",
      content: "/compact",
      planMode: false,
      onToolRequest: async () => ({}),
    })

    const events = await collectStream(turn.stream)
    const transcriptKinds = events
      .filter((event) => event.type === "transcript")
      .map((event) => event.entry.kind)

    expect(transcriptKinds).toEqual(["system_init", "compact_boundary", "result"])
    expect(transcriptKinds).not.toContain("context_cleared")
  })

  test("maps fileChange updates into edit_file tool calls", async () => {
    const process = new FakeCodexProcess((message, child) => {
      if (message.method === "initialize") {
        child.writeServerMessage({ id: message.id, result: { userAgent: "codex-test" } })
      } else if (message.method === "thread/start") {
        child.writeServerMessage({
          id: message.id,
          result: { thread: { id: "thread-1" }, model: "gpt-5.4", reasoningEffort: "high" },
        })
      } else if (message.method === "turn/start") {
        child.writeServerMessage({
          id: message.id,
          result: { turn: { id: "turn-1", status: "inProgress", error: null } },
        })
        child.writeServerMessage({
          method: "item/started",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            item: {
              type: "fileChange",
              id: "call-1",
              changes: [
                {
                  path: "/tmp/project/test.md",
                  kind: {
                    type: "update",
                    move_path: null,
                  },
                  diff: "@@ -1,2 +1,2 @@\n-old line\n+new line",
                },
              ],
              status: "inProgress",
            },
          },
        })
        child.writeServerMessage({
          method: "item/completed",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            item: {
              type: "fileChange",
              id: "call-1",
              changes: [
                {
                  path: "/tmp/project/test.md",
                  kind: {
                    type: "update",
                    move_path: null,
                  },
                  diff: "@@ -1,2 +1,2 @@\n-old line\n+new line",
                },
              ],
              status: "completed",
            },
          },
        })
        child.writeServerMessage({
          method: "turn/completed",
          params: {
            threadId: "thread-1",
            turn: { id: "turn-1", status: "completed", error: null },
          },
        })
      }
    })

    const manager = new CodexAppServerManager({
      spawnProcess: () => process as never,
    })

    await manager.startSession({
      chatId: "chat-1",
      cwd: "/tmp/project",
      model: "gpt-5.4",
      sessionToken: null,
    })

    const turn = await manager.startTurn({
      chatId: "chat-1",
      model: "gpt-5.4",
      content: "edit a file",
      planMode: false,
      onToolRequest: async () => ({}),
    })

    const events = await collectStream(turn.stream)
    const toolCall = events.find((event) => event.type === "transcript" && event.entry.kind === "tool_call")

    expect(toolCall?.entry.kind).toBe("tool_call")
    if (!toolCall || toolCall.entry.kind !== "tool_call") throw new Error("missing tool call")
    expect(toolCall.entry.tool.toolKind).toBe("edit_file")
    expect(toolCall.entry.tool.toolName).toBe("Edit")
    expect(toolCall.entry.tool.input).toEqual({
      filePath: "/tmp/project/test.md",
      oldString: "old line",
      newString: "new line",
    })
  })

  test("maps fileChange adds into write_file tool calls", async () => {
    const process = new FakeCodexProcess((message, child) => {
      if (message.method === "initialize") {
        child.writeServerMessage({ id: message.id, result: { userAgent: "codex-test" } })
      } else if (message.method === "thread/start") {
        child.writeServerMessage({
          id: message.id,
          result: { thread: { id: "thread-1" }, model: "gpt-5.4", reasoningEffort: "high" },
        })
      } else if (message.method === "turn/start") {
        child.writeServerMessage({
          id: message.id,
          result: { turn: { id: "turn-1", status: "inProgress", error: null } },
        })
        child.writeServerMessage({
          method: "item/started",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            item: {
              type: "fileChange",
              id: "call-1",
              changes: [
                {
                  path: "/tmp/project/test.md",
                  kind: {
                    type: "add",
                    move_path: null,
                  },
                  diff: "@@ -0,0 +1,2 @@\n+hello\n+world",
                },
              ],
              status: "inProgress",
            },
          },
        })
        child.writeServerMessage({
          method: "item/completed",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            item: {
              type: "fileChange",
              id: "call-1",
              changes: [
                {
                  path: "/tmp/project/test.md",
                  kind: {
                    type: "add",
                    move_path: null,
                  },
                  diff: "@@ -0,0 +1,2 @@\n+hello\n+world",
                },
              ],
              status: "completed",
            },
          },
        })
        child.writeServerMessage({
          method: "turn/completed",
          params: {
            threadId: "thread-1",
            turn: { id: "turn-1", status: "completed", error: null },
          },
        })
      }
    })

    const manager = new CodexAppServerManager({
      spawnProcess: () => process as never,
    })

    await manager.startSession({
      chatId: "chat-1",
      cwd: "/tmp/project",
      model: "gpt-5.4",
      sessionToken: null,
    })

    const turn = await manager.startTurn({
      chatId: "chat-1",
      model: "gpt-5.4",
      content: "write a file",
      planMode: false,
      onToolRequest: async () => ({}),
    })

    const events = await collectStream(turn.stream)
    const toolCall = events.find((event) => event.type === "transcript" && event.entry.kind === "tool_call")

    expect(toolCall?.entry.kind).toBe("tool_call")
    if (!toolCall || toolCall.entry.kind !== "tool_call") throw new Error("missing tool call")
    expect(toolCall.entry.tool.toolKind).toBe("write_file")
    expect(toolCall.entry.tool.toolName).toBe("Write")
    expect(toolCall.entry.tool.input).toEqual({
      filePath: "/tmp/project/test.md",
      content: "hello\nworld",
    })
  })

  test("maps plain-text fileChange adds into write_file tool calls", async () => {
    const process = new FakeCodexProcess((message, child) => {
      if (message.method === "initialize") {
        child.writeServerMessage({ id: message.id, result: { userAgent: "codex-test" } })
      } else if (message.method === "thread/start") {
        child.writeServerMessage({
          id: message.id,
          result: { thread: { id: "thread-1" }, model: "gpt-5.4", reasoningEffort: "high" },
        })
      } else if (message.method === "turn/start") {
        child.writeServerMessage({
          id: message.id,
          result: { turn: { id: "turn-1", status: "inProgress", error: null } },
        })
        child.writeServerMessage({
          method: "item/completed",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            item: {
              type: "fileChange",
              id: "call-1",
              changes: [
                {
                  path: "/tmp/project/test.md",
                  kind: {
                    type: "add",
                    move_path: null,
                  },
                  diff: "hello\nworld\n",
                },
              ],
              status: "completed",
            },
          },
        })
        child.writeServerMessage({
          method: "turn/completed",
          params: {
            threadId: "thread-1",
            turn: { id: "turn-1", status: "completed", error: null },
          },
        })
      }
    })

    const manager = new CodexAppServerManager({
      spawnProcess: () => process as never,
    })

    await manager.startSession({
      chatId: "chat-1",
      cwd: "/tmp/project",
      model: "gpt-5.4",
      sessionToken: null,
    })

    const turn = await manager.startTurn({
      chatId: "chat-1",
      model: "gpt-5.4",
      content: "write a file",
      planMode: false,
      onToolRequest: async () => ({}),
    })

    const events = await collectStream(turn.stream)
    const toolCall = events.find((event) => event.type === "transcript" && event.entry.kind === "tool_call")

    expect(toolCall?.entry.kind).toBe("tool_call")
    if (!toolCall || toolCall.entry.kind !== "tool_call") throw new Error("missing tool call")
    expect(toolCall.entry.tool.toolKind).toBe("write_file")
    expect(toolCall.entry.tool.input).toEqual({
      filePath: "/tmp/project/test.md",
      content: "hello\nworld\n",
    })
  })

  test("maps plain-text fileChange deletes into delete_file tool calls", async () => {
    const process = new FakeCodexProcess((message, child) => {
      if (message.method === "initialize") {
        child.writeServerMessage({ id: message.id, result: { userAgent: "codex-test" } })
      } else if (message.method === "thread/start") {
        child.writeServerMessage({
          id: message.id,
          result: { thread: { id: "thread-1" }, model: "gpt-5.4", reasoningEffort: "high" },
        })
      } else if (message.method === "turn/start") {
        child.writeServerMessage({
          id: message.id,
          result: { turn: { id: "turn-1", status: "inProgress", error: null } },
        })
        child.writeServerMessage({
          method: "item/completed",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            item: {
              type: "fileChange",
              id: "call-1",
              changes: [
                {
                  path: "/tmp/project/test.md",
                  kind: {
                    type: "delete",
                    move_path: null,
                  },
                  diff: "hello\nworld\n",
                },
              ],
              status: "completed",
            },
          },
        })
        child.writeServerMessage({
          method: "turn/completed",
          params: {
            threadId: "thread-1",
            turn: { id: "turn-1", status: "completed", error: null },
          },
        })
      }
    })

    const manager = new CodexAppServerManager({
      spawnProcess: () => process as never,
    })

    await manager.startSession({
      chatId: "chat-1",
      cwd: "/tmp/project",
      model: "gpt-5.4",
      sessionToken: null,
    })

    const turn = await manager.startTurn({
      chatId: "chat-1",
      model: "gpt-5.4",
      content: "delete a file",
      planMode: false,
      onToolRequest: async () => ({}),
    })

    const events = await collectStream(turn.stream)
    const toolCall = events.find((event) => event.type === "transcript" && event.entry.kind === "tool_call")

    expect(toolCall?.entry.kind).toBe("tool_call")
    if (!toolCall || toolCall.entry.kind !== "tool_call") throw new Error("missing tool call")
    expect(toolCall.entry.tool.toolKind).toBe("delete_file")
    expect(toolCall.entry.tool.toolName).toBe("Delete")
    expect(toolCall.entry.tool.input).toEqual({
      filePath: "/tmp/project/test.md",
      content: "hello\nworld\n",
    })
  })

  test("splits multi-change fileChange items into multiple tool calls and results", async () => {
    const process = new FakeCodexProcess((message, child) => {
      if (message.method === "initialize") {
        child.writeServerMessage({ id: message.id, result: { userAgent: "codex-test" } })
      } else if (message.method === "thread/start") {
        child.writeServerMessage({
          id: message.id,
          result: { thread: { id: "thread-1" }, model: "gpt-5.4", reasoningEffort: "high" },
        })
      } else if (message.method === "turn/start") {
        child.writeServerMessage({
          id: message.id,
          result: { turn: { id: "turn-1", status: "inProgress", error: null } },
        })
        child.writeServerMessage({
          method: "item/completed",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            item: {
              type: "fileChange",
              id: "call-1",
              changes: [
                {
                  path: "/tmp/project/one.md",
                  kind: {
                    type: "add",
                    move_path: null,
                  },
                  diff: "@@ -0,0 +1,2 @@\n+hello\n+world",
                },
                {
                  path: "/tmp/project/two.md",
                  kind: {
                    type: "update",
                    move_path: null,
                  },
                  diff: "@@ -1,2 +1,2 @@\n-old line\n+new line",
                },
              ],
              status: "completed",
            },
          },
        })
        child.writeServerMessage({
          method: "turn/completed",
          params: {
            threadId: "thread-1",
            turn: { id: "turn-1", status: "completed", error: null },
          },
        })
      }
    })

    const manager = new CodexAppServerManager({
      spawnProcess: () => process as never,
    })

    await manager.startSession({
      chatId: "chat-1",
      cwd: "/tmp/project",
      model: "gpt-5.4",
      sessionToken: null,
    })

    const turn = await manager.startTurn({
      chatId: "chat-1",
      model: "gpt-5.4",
      content: "change multiple files",
      planMode: false,
      onToolRequest: async () => ({}),
    })

    const events = await collectStream(turn.stream)
    const toolCalls = events.filter((event) => event.type === "transcript" && event.entry.kind === "tool_call")
    const toolResults = events.filter((event) => event.type === "transcript" && event.entry.kind === "tool_result")

    expect(toolCalls).toHaveLength(2)
    expect(toolResults).toHaveLength(2)

    expect(toolCalls[0]?.entry.kind).toBe("tool_call")
    expect(toolCalls[1]?.entry.kind).toBe("tool_call")
    if (toolCalls[0]?.entry.kind !== "tool_call" || toolCalls[1]?.entry.kind !== "tool_call") {
      throw new Error("missing tool calls")
    }

    expect(toolCalls[0].entry.tool.toolKind).toBe("write_file")
    expect(toolCalls[0].entry.tool.toolId).toBe("call-1:change:0")
    expect(toolCalls[0].entry.tool.input).toEqual({
      filePath: "/tmp/project/one.md",
      content: "hello\nworld",
    })

    expect(toolCalls[1].entry.tool.toolKind).toBe("edit_file")
    expect(toolCalls[1].entry.tool.toolId).toBe("call-1:change:1")
    expect(toolCalls[1].entry.tool.input).toEqual({
      filePath: "/tmp/project/two.md",
      oldString: "old line",
      newString: "new line",
    })

    expect(toolResults[0]?.entry.kind).toBe("tool_result")
    expect(toolResults[1]?.entry.kind).toBe("tool_result")
    if (toolResults[0]?.entry.kind !== "tool_result" || toolResults[1]?.entry.kind !== "tool_result") {
      throw new Error("missing tool results")
    }

    expect(toolResults[0].entry.toolId).toBe("call-1:change:0")
    expect(toolResults[1].entry.toolId).toBe("call-1:change:1")
  })

  test("maps plan updates into TodoWrite and synthesizes ExitPlanMode on successful plan turns", async () => {
    const process = new FakeCodexProcess((message, child) => {
      if (message.method === "initialize") {
        child.writeServerMessage({ id: message.id, result: { userAgent: "codex-test" } })
      } else if (message.method === "thread/start") {
        child.writeServerMessage({
          id: message.id,
          result: { thread: { id: "thread-1" }, model: "gpt-5.4", reasoningEffort: "high" },
        })
      } else if (message.method === "turn/start") {
        child.writeServerMessage({
          id: message.id,
          result: { turn: { id: "turn-1", status: "inProgress", error: null } },
        })
        child.writeServerMessage({
          method: "turn/plan/updated",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            explanation: "Plan the work",
            plan: [
              { step: "Inspect repo", status: "completed" },
              { step: "Implement changes", status: "inProgress" },
            ],
          },
        })
        child.writeServerMessage({
          method: "item/started",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            item: {
              type: "plan",
              id: "plan-1",
              text: "",
            },
          },
        })
        child.writeServerMessage({
          method: "item/plan/delta",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            itemId: "plan-1",
            delta: "## Plan\n\n- [x] Inspect repo\n- [ ] Implement changes",
          },
        })
        child.writeServerMessage({
          method: "turn/completed",
          params: {
            threadId: "thread-1",
            turn: { id: "turn-1", status: "completed", error: null },
          },
        })
      }
    })

    const manager = new CodexAppServerManager({
      spawnProcess: () => process as never,
    })

    await manager.startSession({
      chatId: "chat-1",
      cwd: "/tmp/project",
      model: "gpt-5.4",
      sessionToken: null,
    })

    const turn = await manager.startTurn({
      chatId: "chat-1",
      model: "gpt-5.4",
      content: "make a plan",
      planMode: true,
      onToolRequest: async () => ({ confirmed: true }),
    })

    const events = await collectStream(turn.stream)
    const toolCalls = events
      .filter((event) => event.type === "transcript" && event.entry.kind === "tool_call")
      .map((event) => event.entry.tool)

    expect(toolCalls[0]?.toolKind).toBe("todo_write")
    expect(toolCalls[1]?.toolKind).toBe("exit_plan_mode")
    if (!toolCalls[1] || toolCalls[1].toolKind !== "exit_plan_mode") {
      throw new Error("missing ExitPlanMode tool")
    }
    expect(toolCalls[1].input.summary).toBe("Plan the work")
    expect(toolCalls[1].input.plan).toContain("## Plan")
  })

  test("maps collab agent tool calls into subagent_task", async () => {
    const process = new FakeCodexProcess((message, child) => {
      if (message.method === "initialize") {
        child.writeServerMessage({ id: message.id, result: { userAgent: "codex-test" } })
      } else if (message.method === "thread/start") {
        child.writeServerMessage({
          id: message.id,
          result: { thread: { id: "thread-1" }, model: "gpt-5.4", reasoningEffort: "high" },
        })
      } else if (message.method === "turn/start") {
        child.writeServerMessage({
          id: message.id,
          result: { turn: { id: "turn-1", status: "inProgress", error: null } },
        })
        child.writeServerMessage({
          method: "item/completed",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            item: {
              type: "collabAgentToolCall",
              id: "agent-1",
              tool: "spawnAgent",
              status: "completed",
              senderThreadId: "thread-1",
              receiverThreadIds: ["thread-2"],
              prompt: "Inspect tests",
              agentsStates: {
                "thread-2": { status: "running", message: "Inspecting" },
              },
            },
          },
        })
        child.writeServerMessage({
          method: "turn/completed",
          params: {
            threadId: "thread-1",
            turn: { id: "turn-1", status: "completed", error: null },
          },
        })
      }
    })

    const manager = new CodexAppServerManager({
      spawnProcess: () => process as never,
    })

    await manager.startSession({
      chatId: "chat-1",
      cwd: "/tmp/project",
      model: "gpt-5.4",
      sessionToken: null,
    })

    const turn = await manager.startTurn({
      chatId: "chat-1",
      model: "gpt-5.4",
      content: "spawn an agent",
      planMode: false,
      onToolRequest: async () => ({}),
    })

    const events = await collectStream(turn.stream)
    const toolCall = events.find((event) => event.type === "transcript" && event.entry.kind === "tool_call")

    expect(toolCall?.entry.kind).toBe("tool_call")
    if (!toolCall || toolCall.entry.kind !== "tool_call") throw new Error("missing tool call")
    expect(toolCall.entry.tool.toolKind).toBe("subagent_task")
    expect(toolCall.entry.tool.input).toEqual({ subagentType: "spawnAgent", prompt: "Inspect tests" })
  })

  test("uses the completed webSearch query when the started item is empty", async () => {
    const process = new FakeCodexProcess((message, child) => {
      if (message.method === "initialize") {
        child.writeServerMessage({ id: message.id, result: { userAgent: "codex-test" } })
      } else if (message.method === "thread/start") {
        child.writeServerMessage({
          id: message.id,
          result: { thread: { id: "thread-1" }, model: "gpt-5.4", reasoningEffort: "high" },
        })
      } else if (message.method === "turn/start") {
        child.writeServerMessage({
          id: message.id,
          result: { turn: { id: "turn-1", status: "inProgress", error: null } },
        })
        child.writeServerMessage({
          method: "item/started",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            item: {
              type: "webSearch",
              id: "ws-1",
              query: "",
            },
          },
        })
        child.writeServerMessage({
          method: "item/completed",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            item: {
              type: "webSearch",
              id: "ws-1",
              query: "jake mor",
              action: {
                type: "search",
                query: "jake mor",
                queries: ["jake mor"],
              },
            },
          },
        })
        child.writeServerMessage({
          method: "turn/completed",
          params: {
            threadId: "thread-1",
            turn: { id: "turn-1", status: "completed", error: null },
          },
        })
      }
    })

    const manager = new CodexAppServerManager({
      spawnProcess: () => process as never,
    })

    await manager.startSession({
      chatId: "chat-1",
      cwd: "/tmp/project",
      model: "gpt-5.4",
      sessionToken: null,
    })

    const turn = await manager.startTurn({
      chatId: "chat-1",
      model: "gpt-5.4",
      content: "search",
      planMode: false,
      onToolRequest: async () => ({}),
    })

    const events = await collectStream(turn.stream)
    const toolCalls = events.filter((event) => event.type === "transcript" && event.entry.kind === "tool_call")

    expect(toolCalls).toHaveLength(1)
    const toolCall = toolCalls[0]
    if (toolCall.entry.kind !== "tool_call") throw new Error("missing tool call")
    expect(toolCall.entry.tool.toolKind).toBe("web_search")
    expect(toolCall.entry.tool.input).toEqual({ query: "jake mor" })
  })

  test("responds to unsupported dynamic tool requests with a generic tool error", async () => {
    const process = new FakeCodexProcess((message, child) => {
      if (message.method === "initialize") {
        child.writeServerMessage({ id: message.id, result: { userAgent: "codex-test" } })
      } else if (message.method === "thread/start") {
        child.writeServerMessage({
          id: message.id,
          result: { thread: { id: "thread-1" }, model: "gpt-5.4", reasoningEffort: "high" },
        })
      } else if (message.method === "turn/start") {
        child.writeServerMessage({
          id: message.id,
          result: { turn: { id: "turn-1", status: "inProgress", error: null } },
        })
        child.writeServerMessage({
          id: "dyn-1",
          method: "item/tool/call",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            callId: "call-1",
            tool: "custom_tool",
            arguments: { value: 1 },
          },
        })
        child.writeServerMessage({
          method: "turn/completed",
          params: {
            threadId: "thread-1",
            turn: { id: "turn-1", status: "completed", error: null },
          },
        })
      }
    })

    const manager = new CodexAppServerManager({
      spawnProcess: () => process as never,
    })

    await manager.startSession({
      chatId: "chat-1",
      cwd: "/tmp/project",
      model: "gpt-5.4",
      sessionToken: null,
    })

    const turn = await manager.startTurn({
      chatId: "chat-1",
      model: "gpt-5.4",
      content: "call tool",
      planMode: false,
      onToolRequest: async () => ({}),
    })

    const events = await collectStream(turn.stream)
    const toolCall = events.find((event) => event.type === "transcript" && event.entry.kind === "tool_call")
    const toolResult = events.find((event) => event.type === "transcript" && event.entry.kind === "tool_result")
    const response = process.messages.find((message: any) => message.id === "dyn-1")

    expect(toolCall?.entry.kind).toBe("tool_call")
    if (!toolCall || toolCall.entry.kind !== "tool_call") throw new Error("missing tool call")
    expect(toolCall.entry.tool.toolKind).toBe("unknown_tool")
    expect(toolCall.entry.tool.toolName).toBe("custom_tool")
    expect(toolResult?.entry.kind).toBe("tool_result")
    expect(response).toEqual({
      id: "dyn-1",
      result: {
        contentItems: [{ type: "inputText", text: "Unsupported dynamic tool call: custom_tool" }],
        success: false,
      },
    })
  })

  test("answers requestUserInput requests with the official JSON-RPC result payload", async () => {
    const process = new FakeCodexProcess((message, child) => {
      if (message.method === "initialize") {
        child.writeServerMessage({ id: message.id, result: { userAgent: "codex-test" } })
      } else if (message.method === "thread/start") {
        child.writeServerMessage({
          id: message.id,
          result: { thread: { id: "thread-1" }, model: "gpt-5.4", reasoningEffort: "high" },
        })
      } else if (message.method === "turn/start") {
        child.writeServerMessage({
          id: message.id,
          result: { turn: { id: "turn-1", status: "inProgress", error: null } },
        })
        child.writeServerMessage({
          id: "req-1",
          method: "item/tool/requestUserInput",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            itemId: "ask-1",
            questions: [
              {
                id: "runtime",
                header: "Runtime",
                question: "Which runtime?",
                isOther: false,
                isSecret: false,
                options: null,
              },
            ],
          },
        })
        child.writeServerMessage({
          method: "turn/completed",
          params: {
            threadId: "thread-1",
            turn: { id: "turn-1", status: "completed", error: null },
          },
        })
      }
    })

    const manager = new CodexAppServerManager({
      spawnProcess: () => process as never,
    })

    await manager.startSession({
      chatId: "chat-1",
      cwd: "/tmp/project",
      model: "gpt-5.4",
      sessionToken: null,
    })

    const turn = await manager.startTurn({
      chatId: "chat-1",
      model: "gpt-5.4",
      content: "ask me",
      planMode: false,
      onToolRequest: async () => ({
        questions: [{
          id: "runtime",
          question: "Which runtime?",
        }],
        answers: {
          runtime: "bun",
        },
      }),
    })

    const events = await collectStream(turn.stream)
    const askEntry = events.find((event) => event.type === "transcript" && event.entry.kind === "tool_call")
    expect(askEntry?.entry.tool.toolKind).toBe("ask_user_question")

    const response = process.messages.find((message: any) => message.id === "req-1")
    expect(response).toEqual({
      id: "req-1",
      result: {
        answers: {
          runtime: {
            answers: ["bun"],
          },
        },
      },
    })
  })

  test("falls back to question text when requestUserInput answers are keyed by prompt text", async () => {
    const process = new FakeCodexProcess((message, child) => {
      if (message.method === "initialize") {
        child.writeServerMessage({ id: message.id, result: { userAgent: "codex-test" } })
      } else if (message.method === "thread/start") {
        child.writeServerMessage({
          id: message.id,
          result: { thread: { id: "thread-1" }, model: "gpt-5.4", reasoningEffort: "high" },
        })
      } else if (message.method === "turn/start") {
        child.writeServerMessage({
          id: message.id,
          result: { turn: { id: "turn-1", status: "inProgress", error: null } },
        })
        child.writeServerMessage({
          id: "req-1",
          method: "item/tool/requestUserInput",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            itemId: "ask-1",
            questions: [
              {
                id: "favorite_color",
                header: "Color",
                question: "What is your favorite color right now?",
                isOther: true,
                isSecret: false,
                options: [
                  { label: "Red", description: null },
                  { label: "Blue", description: null },
                ],
              },
            ],
          },
        })
        child.writeServerMessage({
          method: "turn/completed",
          params: {
            threadId: "thread-1",
            turn: { id: "turn-1", status: "completed", error: null },
          },
        })
      }
    })

    const manager = new CodexAppServerManager({
      spawnProcess: () => process as never,
    })

    await manager.startSession({
      chatId: "chat-1",
      cwd: "/tmp/project",
      model: "gpt-5.4",
      sessionToken: null,
    })

    const turn = await manager.startTurn({
      chatId: "chat-1",
      model: "gpt-5.4",
      content: "ask me",
      planMode: false,
      onToolRequest: async () => ({
        questions: [{
          id: "favorite_color",
          question: "What is your favorite color right now?",
        }],
        answers: {
          "What is your favorite color right now?": "Red",
        },
      }),
    })

    await collectStream(turn.stream)

    const response = process.messages.find((message: any) => message.id === "req-1")
    expect(response).toEqual({
      id: "req-1",
      result: {
        answers: {
          favorite_color: {
            answers: ["Red"],
          },
        },
      },
    })
  })

  test("infers multi-select Codex questions from prompt text and returns multiple answers", async () => {
    const process = new FakeCodexProcess((message, child) => {
      if (message.method === "initialize") {
        child.writeServerMessage({ id: message.id, result: { userAgent: "codex-test" } })
      } else if (message.method === "thread/start") {
        child.writeServerMessage({
          id: message.id,
          result: { thread: { id: "thread-1" }, model: "gpt-5.4", reasoningEffort: "high" },
        })
      } else if (message.method === "turn/start") {
        child.writeServerMessage({
          id: message.id,
          result: { turn: { id: "turn-1", status: "inProgress", error: null } },
        })
        child.writeServerMessage({
          id: "req-1",
          method: "item/tool/requestUserInput",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            itemId: "ask-1",
            questions: [
              {
                id: "runtimes",
                header: "Runtime",
                question: "Select all runtimes that apply",
                isOther: true,
                isSecret: false,
                options: [
                  { label: "bun", description: null },
                  { label: "node", description: null },
                ],
              },
            ],
          },
        })
        child.writeServerMessage({
          method: "turn/completed",
          params: {
            threadId: "thread-1",
            turn: { id: "turn-1", status: "completed", error: null },
          },
        })
      }
    })

    const manager = new CodexAppServerManager({
      spawnProcess: () => process as never,
    })

    await manager.startSession({
      chatId: "chat-1",
      cwd: "/tmp/project",
      model: "gpt-5.4",
      sessionToken: null,
    })

    const turn = await manager.startTurn({
      chatId: "chat-1",
      model: "gpt-5.4",
      content: "ask me",
      planMode: false,
      onToolRequest: async ({ tool }) => {
        expect(tool.toolKind).toBe("ask_user_question")
        if (tool.toolKind !== "ask_user_question") {
          return {}
        }

        expect(tool.input.questions[0]?.multiSelect).toBe(true)

        return {
          questions: [{
            id: "runtimes",
            question: "Select all runtimes that apply",
            multiSelect: true,
          }],
          answers: {
            runtimes: ["bun", "node"],
          },
        }
      },
    })

    await collectStream(turn.stream)

    const response = process.messages.find((message: any) => message.id === "req-1")
    expect(response).toEqual({
      id: "req-1",
      result: {
        answers: {
          runtimes: {
            answers: ["bun", "node"],
          },
        },
      },
    })
  })

  test("sends approval decisions back to the app-server", async () => {
    const process = new FakeCodexProcess((message, child) => {
      if (message.method === "initialize") {
        child.writeServerMessage({ id: message.id, result: { userAgent: "codex-test" } })
      } else if (message.method === "thread/start") {
        child.writeServerMessage({
          id: message.id,
          result: { thread: { id: "thread-1" }, model: "gpt-5.4", reasoningEffort: "high" },
        })
      } else if (message.method === "turn/start") {
        child.writeServerMessage({
          id: message.id,
          result: { turn: { id: "turn-1", status: "inProgress", error: null } },
        })
        child.writeServerMessage({
          id: "approval-1",
          method: "item/commandExecution/requestApproval",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            itemId: "call-1",
            command: "rm -rf .",
            cwd: "/tmp/project",
          },
        })
        child.writeServerMessage({
          method: "turn/completed",
          params: {
            threadId: "thread-1",
            turn: { id: "turn-1", status: "completed", error: null },
          },
        })
      }
    })

    const manager = new CodexAppServerManager({
      spawnProcess: () => process as never,
    })

    await manager.startSession({
      chatId: "chat-1",
      cwd: "/tmp/project",
      model: "gpt-5.4",
      sessionToken: null,
    })

    const turn = await manager.startTurn({
      chatId: "chat-1",
      model: "gpt-5.4",
      content: "approve something",
      planMode: false,
      onToolRequest: async () => ({}),
      onApprovalRequest: async () => "accept",
    })

    await collectStream(turn.stream)

    const response = process.messages.find((message: any) => message.id === "approval-1")
    expect(response).toEqual({
      id: "approval-1",
      result: {
        decision: "accept",
      },
    })
  })

  test("interrupt sends turn/interrupt for the active turn", async () => {
    const process = new FakeCodexProcess((message, child) => {
      if (message.method === "initialize") {
        child.writeServerMessage({ id: message.id, result: { userAgent: "codex-test" } })
      } else if (message.method === "thread/start") {
        child.writeServerMessage({
          id: message.id,
          result: { thread: { id: "thread-1" }, model: "gpt-5.4", reasoningEffort: "high" },
        })
      } else if (message.method === "turn/start") {
        child.writeServerMessage({
          id: message.id,
          result: { turn: { id: "turn-1", status: "inProgress", error: null } },
        })
      } else if (message.method === "turn/interrupt") {
        child.writeServerMessage({ id: message.id, result: {} })
      }
    })

    const manager = new CodexAppServerManager({
      spawnProcess: () => process as never,
    })

    await manager.startSession({
      chatId: "chat-1",
      cwd: "/tmp/project",
      model: "gpt-5.4",
      sessionToken: null,
    })

    const turn = await manager.startTurn({
      chatId: "chat-1",
      model: "gpt-5.4",
      content: "wait",
      planMode: false,
      onToolRequest: async () => ({}),
    })

    await turn.interrupt()

    const interruptRequest = process.messages.find((message: any) => message.method === "turn/interrupt") as
      | { id: string; method: "turn/interrupt"; params: { threadId: string; turnId: string } }
      | undefined
    expect(interruptRequest).toBeDefined()
    if (!interruptRequest) throw new Error("missing interrupt request")
    expect(interruptRequest).toEqual({
      id: interruptRequest.id,
      method: "turn/interrupt",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
      },
    })
  })

  test("interrupt clears a pending exit-plan wait so a new turn can start immediately", async () => {
    let resolveToolRequest!: (value: unknown) => void

    const process = new FakeCodexProcess((message, child) => {
      if (message.method === "initialize") {
        child.writeServerMessage({ id: message.id, result: { userAgent: "codex-test" } })
      } else if (message.method === "thread/start") {
        child.writeServerMessage({
          id: message.id,
          result: { thread: { id: "thread-1" }, model: "gpt-5.4", reasoningEffort: "high" },
        })
      } else if (message.method === "turn/start") {
        if (message.params.input[0]?.text === "make a plan") {
          child.writeServerMessage({
            id: message.id,
            result: { turn: { id: "turn-plan", status: "completed", error: null } },
          })
          child.writeServerMessage({
            method: "turn/plan/updated",
            params: {
              threadId: "thread-1",
              turnId: "turn-plan",
              explanation: "Plan the work",
              plan: [{ step: "Inspect repo", status: "completed" }],
            },
          })
          child.writeServerMessage({
            method: "turn/completed",
            params: {
              threadId: "thread-1",
              turn: { id: "turn-plan", status: "completed", error: null },
            },
          })
        } else {
          child.writeServerMessage({
            id: message.id,
            result: { turn: { id: "turn-next", status: "completed", error: null } },
          })
          child.writeServerMessage({
            method: "turn/completed",
            params: {
              threadId: "thread-1",
              turn: { id: "turn-next", status: "completed", error: null },
            },
          })
        }
      }
    })

    const manager = new CodexAppServerManager({
      spawnProcess: () => process as never,
    })

    await manager.startSession({
      chatId: "chat-1",
      cwd: "/tmp/project",
      model: "gpt-5.4",
      sessionToken: null,
    })

    const turn = await manager.startTurn({
      chatId: "chat-1",
      model: "gpt-5.4",
      content: "make a plan",
      planMode: true,
      onToolRequest: async () => await new Promise((resolve) => {
        resolveToolRequest = resolve
      }),
    })

    const iterator = turn.stream[Symbol.asyncIterator]()
    await iterator.next()
    await iterator.next()
    await iterator.next()
    await turn.interrupt()

    const nextTurn = await manager.startTurn({
      chatId: "chat-1",
      model: "gpt-5.4",
      content: "continue",
      planMode: false,
      onToolRequest: async () => ({}),
    })

    await collectStream(nextTurn.stream)
    resolveToolRequest({})
  })

  test("emits an error result when the app-server exits mid-turn", async () => {
    const process = new FakeCodexProcess((message, child) => {
      if (message.method === "initialize") {
        child.writeServerMessage({ id: message.id, result: { userAgent: "codex-test" } })
      } else if (message.method === "thread/start") {
        child.writeServerMessage({
          id: message.id,
          result: { thread: { id: "thread-1" }, model: "gpt-5.4", reasoningEffort: "high" },
        })
      } else if (message.method === "turn/start") {
        child.writeServerMessage({
          id: message.id,
          result: { turn: { id: "turn-1", status: "inProgress", error: null } },
        })
        child.writeStderr("fatal: app-server crashed")
        child.closeWithCode(1)
      }
    })

    const manager = new CodexAppServerManager({
      spawnProcess: () => process as never,
    })

    await manager.startSession({
      chatId: "chat-1",
      cwd: "/tmp/project",
      model: "gpt-5.4",
      sessionToken: null,
    })

    const turn = await manager.startTurn({
      chatId: "chat-1",
      model: "gpt-5.4",
      content: "crash",
      planMode: false,
      onToolRequest: async () => ({}),
    })

    const events = await collectStream(turn.stream)
    const resultEvent = events.find((event) => event.type === "transcript" && event.entry.kind === "result")
    expect(resultEvent?.entry.subtype).toBe("error")
    expect(resultEvent?.entry.result).toContain("fatal: app-server crashed")
  })

  test("keeps the turn running through a retryable error and reports it as status", async () => {
    const process = new FakeCodexProcess((message, child) => {
      if (message.method === "initialize") {
        child.writeServerMessage({ id: message.id, result: { userAgent: "codex-test" } })
      } else if (message.method === "thread/start") {
        child.writeServerMessage({
          id: message.id,
          result: { thread: { id: "thread-1" }, model: "gpt-5.4", reasoningEffort: "high" },
        })
      } else if (message.method === "turn/start") {
        child.writeServerMessage({
          id: message.id,
          result: { turn: { id: "turn-1", status: "inProgress", error: null } },
        })
        child.writeServerMessage({
          method: "error",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            willRetry: true,
            error: { message: "Reconnecting... 2/5" },
          },
        })
        child.writeServerMessage({
          method: "item/completed",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            item: { id: "item-1", type: "agentMessage", text: "recovered" },
          },
        })
        child.writeServerMessage({
          method: "turn/completed",
          params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed", error: null } },
        })
      }
    })

    const manager = new CodexAppServerManager({ spawnProcess: () => process as never })
    await manager.startSession({ chatId: "chat-1", cwd: "/tmp/project", model: "gpt-5.4", sessionToken: null })

    const turn = await manager.startTurn({
      chatId: "chat-1",
      model: "gpt-5.4",
      content: "keep going",
      planMode: false,
      onToolRequest: async () => ({}),
    })

    const events = await collectStream(turn.stream)
    const entries = events.filter((event) => event.type === "transcript").map((event) => event.entry)
    expect(entries.find((entry) => entry.kind === "status")?.status).toBe("Reconnecting... 2/5")
    expect(entries.find((entry) => entry.kind === "assistant_text")?.text).toBe("recovered")
    const resultEntry = entries.find((entry) => entry.kind === "result")
    expect(resultEntry?.subtype).toBe("success")
    expect(resultEntry?.isError).toBe(false)
  })

  test("reports the underlying failure, not the retry notice, when a retried turn fails", async () => {
    const process = new FakeCodexProcess((message, child) => {
      if (message.method === "initialize") {
        child.writeServerMessage({ id: message.id, result: { userAgent: "codex-test" } })
      } else if (message.method === "thread/start") {
        child.writeServerMessage({
          id: message.id,
          result: { thread: { id: "thread-1" }, model: "gpt-5.4", reasoningEffort: "high" },
        })
      } else if (message.method === "turn/start") {
        child.writeServerMessage({
          id: message.id,
          result: { turn: { id: "turn-1", status: "inProgress", error: null } },
        })
        child.writeServerMessage({
          method: "error",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            willRetry: true,
            error: { message: "stream disconnected", codexErrorInfo: "unexpected EOF" },
          },
        })
        child.writeServerMessage({
          method: "turn/completed",
          params: { threadId: "thread-1", turn: { id: "turn-1", status: "failed", error: null } },
        })
      }
    })

    const manager = new CodexAppServerManager({ spawnProcess: () => process as never })
    await manager.startSession({ chatId: "chat-1", cwd: "/tmp/project", model: "gpt-5.4", sessionToken: null })

    const turn = await manager.startTurn({
      chatId: "chat-1",
      model: "gpt-5.4",
      content: "keep going",
      planMode: false,
      onToolRequest: async () => ({}),
    })

    const events = await collectStream(turn.stream)
    const resultEntry = events
      .filter((event) => event.type === "transcript")
      .map((event) => event.entry)
      .find((entry) => entry.kind === "result")
    expect(resultEntry?.subtype).toBe("error")
    expect(resultEntry?.result).toBe("stream disconnected: unexpected EOF")
  })

  test("keeps the cause through later progress notices when a retried turn fails", async () => {
    const process = new FakeCodexProcess((message, child) => {
      if (message.method === "initialize") {
        child.writeServerMessage({ id: message.id, result: { userAgent: "codex-test" } })
      } else if (message.method === "thread/start") {
        child.writeServerMessage({
          id: message.id,
          result: { thread: { id: "thread-1" }, model: "gpt-5.4", reasoningEffort: "high" },
        })
      } else if (message.method === "turn/start") {
        child.writeServerMessage({
          id: message.id,
          result: { turn: { id: "turn-1", status: "inProgress", error: null } },
        })
        for (const error of [
          { message: "stream disconnected", codexErrorInfo: "unexpected EOF" },
          { message: "Reconnecting... 2/5" },
          { message: "Reconnecting... 3/5" },
        ]) {
          child.writeServerMessage({
            method: "error",
            params: { threadId: "thread-1", turnId: "turn-1", willRetry: true, error },
          })
        }
        child.writeServerMessage({
          method: "turn/completed",
          params: { threadId: "thread-1", turn: { id: "turn-1", status: "failed", error: null } },
        })
      }
    })

    const manager = new CodexAppServerManager({ spawnProcess: () => process as never })
    await manager.startSession({ chatId: "chat-1", cwd: "/tmp/project", model: "gpt-5.4", sessionToken: null })

    const turn = await manager.startTurn({
      chatId: "chat-1",
      model: "gpt-5.4",
      content: "keep going",
      planMode: false,
      onToolRequest: async () => ({}),
    })

    const entries = (await collectStream(turn.stream))
      .filter((event) => event.type === "transcript")
      .map((event) => event.entry)

    // Every notice is still shown in order; only the last one renders.
    expect(entries.filter((entry) => entry.kind === "status").map((entry) => entry.status)).toEqual([
      "stream disconnected: unexpected EOF",
      "Reconnecting... 2/5",
      "Reconnecting... 3/5",
    ])
    // The counters must not have displaced the cause.
    expect(entries.find((entry) => entry.kind === "result")?.result).toBe(
      "stream disconnected: unexpected EOF"
    )
  })

  test("reads an object-variant cause so a stream drop is not mistaken for a bare counter", async () => {
    const process = new FakeCodexProcess((message, child) => {
      if (message.method === "initialize") {
        child.writeServerMessage({ id: message.id, result: { userAgent: "codex-test" } })
      } else if (message.method === "thread/start") {
        child.writeServerMessage({
          id: message.id,
          result: { thread: { id: "thread-1" }, model: "gpt-5.4", reasoningEffort: "high" },
        })
      } else if (message.method === "turn/start") {
        child.writeServerMessage({
          id: message.id,
          result: { turn: { id: "turn-1", status: "inProgress", error: null } },
        })
        // The shape codex really sends for a dropped SSE stream: the cause is
        // a one-key object, not a string.
        for (const error of [
          { message: "Reconnecting... 2/5" },
          { message: "stream disconnected", codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: 502 } } },
          { message: "Reconnecting... 3/5" },
        ]) {
          child.writeServerMessage({
            method: "error",
            params: { threadId: "thread-1", turnId: "turn-1", willRetry: true, error },
          })
        }
        child.writeServerMessage({
          method: "turn/completed",
          params: { threadId: "thread-1", turn: { id: "turn-1", status: "failed", error: null } },
        })
      }
    })

    const manager = new CodexAppServerManager({ spawnProcess: () => process as never })
    await manager.startSession({ chatId: "chat-1", cwd: "/tmp/project", model: "gpt-5.4", sessionToken: null })

    const turn = await manager.startTurn({
      chatId: "chat-1",
      model: "gpt-5.4",
      content: "keep going",
      planMode: false,
      onToolRequest: async () => ({}),
    })

    const entries = (await collectStream(turn.stream))
      .filter((event) => event.type === "transcript")
      .map((event) => event.entry)

    expect(entries.filter((entry) => entry.kind === "status").map((entry) => entry.status)).toEqual([
      "Reconnecting... 2/5",
      "stream disconnected: responseStreamDisconnected (HTTP 502)",
      "Reconnecting... 3/5",
    ])
    expect(entries.find((entry) => entry.kind === "result")?.result).toBe(
      "stream disconnected: responseStreamDisconnected (HTTP 502)"
    )
  })

  test("upgrades to the cause when the retry sequence opens with a bare counter", async () => {
    const process = new FakeCodexProcess((message, child) => {
      if (message.method === "initialize") {
        child.writeServerMessage({ id: message.id, result: { userAgent: "codex-test" } })
      } else if (message.method === "thread/start") {
        child.writeServerMessage({
          id: message.id,
          result: { thread: { id: "thread-1" }, model: "gpt-5.4", reasoningEffort: "high" },
        })
      } else if (message.method === "turn/start") {
        child.writeServerMessage({
          id: message.id,
          result: { turn: { id: "turn-1", status: "inProgress", error: null } },
        })
        for (const error of [
          { message: "Reconnecting... 2/5" },
          { message: "stream disconnected", codexErrorInfo: "unexpected EOF" },
        ]) {
          child.writeServerMessage({
            method: "error",
            params: { threadId: "thread-1", turnId: "turn-1", willRetry: true, error },
          })
        }
        child.writeServerMessage({
          method: "turn/completed",
          params: { threadId: "thread-1", turn: { id: "turn-1", status: "failed", error: null } },
        })
      }
    })

    const manager = new CodexAppServerManager({ spawnProcess: () => process as never })
    await manager.startSession({ chatId: "chat-1", cwd: "/tmp/project", model: "gpt-5.4", sessionToken: null })

    const turn = await manager.startTurn({
      chatId: "chat-1",
      model: "gpt-5.4",
      content: "keep going",
      planMode: false,
      onToolRequest: async () => ({}),
    })

    const resultEntry = (await collectStream(turn.stream))
      .filter((event) => event.type === "transcript")
      .map((event) => event.entry)
      .find((entry) => entry.kind === "result")
    expect(resultEntry?.result).toBe("stream disconnected: unexpected EOF")
  })

  test("fails the turn with the real error when codex will not retry", async () => {
    const process = new FakeCodexProcess((message, child) => {
      if (message.method === "initialize") {
        child.writeServerMessage({ id: message.id, result: { userAgent: "codex-test" } })
      } else if (message.method === "thread/start") {
        child.writeServerMessage({
          id: message.id,
          result: { thread: { id: "thread-1" }, model: "gpt-5.4", reasoningEffort: "high" },
        })
      } else if (message.method === "turn/start") {
        child.writeServerMessage({
          id: message.id,
          result: { turn: { id: "turn-1", status: "inProgress", error: null } },
        })
        child.writeServerMessage({
          method: "error",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            willRetry: false,
            error: { message: "usage limit reached", codexErrorInfo: "resets at 5pm" },
          },
        })
      }
    })

    const manager = new CodexAppServerManager({ spawnProcess: () => process as never })
    await manager.startSession({ chatId: "chat-1", cwd: "/tmp/project", model: "gpt-5.4", sessionToken: null })

    const turn = await manager.startTurn({
      chatId: "chat-1",
      model: "gpt-5.4",
      content: "go",
      planMode: false,
      onToolRequest: async () => ({}),
    })

    const events = await collectStream(turn.stream)
    const resultEntry = events
      .filter((event) => event.type === "transcript")
      .map((event) => event.entry)
      .find((entry) => entry.kind === "result")
    expect(resultEntry?.subtype).toBe("error")
    expect(resultEntry?.result).toBe("usage limit reached: resets at 5pm")
  })


  test("maps repeated plan updates with snake_case progress statuses into the latest TodoWrite state", async () => {
    const process = new FakeCodexProcess((message, child) => {
      if (message.method === "initialize") {
        child.writeServerMessage({ id: message.id, result: { userAgent: "codex-test" } })
      } else if (message.method === "thread/start") {
        child.writeServerMessage({
          id: message.id,
          result: { thread: { id: "thread-1" }, model: "gpt-5.4", reasoningEffort: "high" },
        })
      } else if (message.method === "turn/start") {
        child.writeServerMessage({
          id: message.id,
          result: { turn: { id: "turn-1", status: "inProgress", error: null } },
        })
        child.writeServerMessage({
          method: "turn/plan/updated",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            explanation: null,
            plan: [
              { step: "Inspect repo", status: "in_progress" },
              { step: "Implement changes", status: "pending" },
            ],
          },
        })
        child.writeServerMessage({
          method: "turn/plan/updated",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            explanation: null,
            plan: [
              { step: "Inspect repo", status: "completed" },
              { step: "Implement changes", status: "in_progress" },
            ],
          },
        })
        child.writeServerMessage({
          method: "item/completed",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            item: {
              type: "agentMessage",
              id: "answer-1",
              text: "plan-progress-test-done",
              phase: "final_answer",
            },
          },
        })
        child.writeServerMessage({
          method: "turn/completed",
          params: {
            threadId: "thread-1",
            turn: { id: "turn-1", status: "completed", error: null },
          },
        })
      }
    })

    const manager = new CodexAppServerManager({ spawnProcess: () => process as never })
    await manager.startSession({
      chatId: "chat-1",
      cwd: "/tmp/project",
      model: "gpt-5.4",
      sessionToken: null,
    })

    const turn = await manager.startTurn({
      chatId: "chat-1",
      model: "gpt-5.4",
      content: "make a plan",
      planMode: false,
      onToolRequest: async () => ({ confirmed: true }),
    })

    const events = await collectStream(turn.stream)
    const todoCalls = events
      .filter((event) => event.type === "transcript" && event.entry.kind === "tool_call" && event.entry.tool.toolKind === "todo_write")
      .map((event) => event.entry.tool)
    expect(todoCalls.map((tool) => tool.input.todos.map((todo: { status: string }) => todo.status))).toEqual([
      ["in_progress", "pending"],
      ["completed", "in_progress"],
      ["completed", "completed"],
    ])
  })


  test("does not complete the parent plan from a subagent final answer", async () => {
    const process = new FakeCodexProcess((message, child) => {
      if (message.method === "initialize") {
        child.writeServerMessage({ id: message.id, result: { userAgent: "codex-test" } })
      } else if (message.method === "thread/start") {
        child.writeServerMessage({
          id: message.id,
          result: { thread: { id: "parent-thread" }, model: "gpt-5.4", reasoningEffort: "high" },
        })
      } else if (message.method === "turn/start") {
        child.writeServerMessage({
          id: message.id,
          result: { turn: { id: "parent-turn", status: "inProgress", error: null } },
        })
        child.writeServerMessage({
          method: "turn/plan/updated",
          params: {
            threadId: "parent-thread",
            turnId: "parent-turn",
            explanation: null,
            plan: [{ step: "Wait for the subagent", status: "in_progress" }],
          },
        })
        child.writeServerMessage({
          method: "item/completed",
          params: {
            threadId: "child-thread",
            turnId: "child-turn",
            item: {
              type: "agentMessage",
              id: "child-answer",
              text: "child final",
              phase: "final_answer",
            },
          },
        })
        child.writeServerMessage({
          method: "item/completed",
          params: {
            threadId: "parent-thread",
            turnId: "parent-turn",
            item: {
              type: "agentMessage",
              id: "parent-answer",
              text: "parent final",
              phase: "final_answer",
            },
          },
        })
        child.writeServerMessage({
          method: "turn/completed",
          params: {
            threadId: "parent-thread",
            turn: { id: "parent-turn", status: "completed", error: null },
          },
        })
      }
    })

    const manager = new CodexAppServerManager({ spawnProcess: () => process as never })
    await manager.startSession({
      chatId: "chat-1",
      cwd: "/tmp/project",
      model: "gpt-5.4",
      sessionToken: null,
    })

    const turn = await manager.startTurn({
      chatId: "chat-1",
      model: "gpt-5.4",
      content: "delegate part of the plan",
      planMode: false,
      onToolRequest: async () => ({}),
    })

    const events = await collectStream(turn.stream)
    const todoIds = events
      .filter((event) => event.type === "transcript" && event.entry.kind === "tool_call" && event.entry.tool.toolKind === "todo_write")
      .map((event) => event.entry.tool.toolId)

    expect(todoIds).toEqual([
      "parent-turn:todo-1",
      "parent-turn:todo-2",
    ])
  })


  test("sends permission approval grants back to the app-server", async () => {
    const requestedPermissions = {
      network: { enabled: true },
      fileSystem: {
        read: ["/tmp/project"],
        write: ["/tmp/project"],
        entries: [],
      },
    }
    const approvalRequests: any[] = []
    const process = new FakeCodexProcess((message, child) => {
      if (message.method === "initialize") {
        child.writeServerMessage({ id: message.id, result: { userAgent: "codex-test" } })
      } else if (message.method === "thread/start") {
        child.writeServerMessage({
          id: message.id,
          result: { thread: { id: "thread-1" }, model: "gpt-5.6-sol", reasoningEffort: "low" },
        })
      } else if (message.method === "turn/start") {
        child.writeServerMessage({
          id: message.id,
          result: { turn: { id: "turn-1", status: "inProgress", error: null } },
        })
        child.writeServerMessage({
          id: "permissions-1",
          method: "item/permissions/requestApproval",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            itemId: "permission-call-1",
            environmentId: "local",
            startedAtMs: 1,
            cwd: "/tmp/project",
            reason: "Need workspace access",
            permissions: requestedPermissions,
          },
        })
        child.writeServerMessage({
          method: "turn/completed",
          params: {
            threadId: "thread-1",
            turn: { id: "turn-1", status: "completed", error: null },
          },
        })
      }
    })

    const manager = new CodexAppServerManager({
      spawnProcess: () => process as never,
    })

    await manager.startSession({
      chatId: "chat-1",
      cwd: "/tmp/project",
      model: "gpt-5.6-sol",
      sessionToken: null,
    })

    const turn = await manager.startTurn({
      chatId: "chat-1",
      model: "gpt-5.6-sol",
      content: "grant permissions",
      planMode: false,
      onToolRequest: async () => ({}),
      onApprovalRequest: async (request) => {
        approvalRequests.push(request)
        return "acceptForSession"
      },
    })

    await collectStream(turn.stream)

    expect(approvalRequests.map((request) => request.kind)).toEqual(["permissions"])
    const response = process.messages.find((message: any) => message.id === "permissions-1")
    expect(response).toEqual({
      id: "permissions-1",
      result: {
        permissions: requestedPermissions,
        scope: "session",
        strictAutoReview: true,
      },
    })
  })


  test("emits approval requests as interactive transcript tools", async () => {
    const process = new FakeCodexProcess((message, child) => {
      if (message.method === "initialize") {
        child.writeServerMessage({ id: message.id, result: { userAgent: "codex-test" } })
      } else if (message.method === "thread/start") {
        child.writeServerMessage({
          id: message.id,
          result: { thread: { id: "thread-1" }, model: "gpt-5.4", reasoningEffort: "high" },
        })
      } else if (message.method === "turn/start") {
        child.writeServerMessage({
          id: message.id,
          result: { turn: { id: "turn-1", status: "inProgress", error: null } },
        })
        child.writeServerMessage({
          id: "approval-1",
          method: "item/commandExecution/requestApproval",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            itemId: "call-1",
            command: "/home/ap24/.bun/bin/bun test",
            cwd: "/tmp/project",
            reason: "Retry outside sandbox",
          },
        })
        child.writeServerMessage({
          method: "turn/completed",
          params: {
            threadId: "thread-1",
            turn: { id: "turn-1", status: "completed", error: null },
          },
        })
      }
    })

    const manager = new CodexAppServerManager({ spawnProcess: () => process as never })
    await manager.startSession({
      chatId: "chat-1",
      cwd: "/tmp/project",
      model: "gpt-5.4",
      sessionToken: null,
    })
    const turn = await manager.startTurn({
      chatId: "chat-1",
      model: "gpt-5.4",
      content: "approve something",
      planMode: false,
      onToolRequest: async (request) => {
        expect(request.tool.toolKind).toBe("codex_approval")
        if (request.tool.toolKind !== "codex_approval") throw new Error("unexpected tool")
        expect(request.tool.input).toMatchObject({
          approvalKind: "command_execution",
          command: "/home/ap24/.bun/bin/bun test",
          cwd: "/tmp/project",
          reason: "Retry outside sandbox",
        })
        return { decision: "acceptForSession" }
      },
    })

    const events = await collectStream(turn.stream)
    const toolCall = events.find((event) => event.type === "transcript" && event.entry.kind === "tool_call")
    expect(toolCall?.entry.kind).toBe("tool_call")
    if (!toolCall || toolCall.entry.kind !== "tool_call") throw new Error("missing tool call")
    expect(toolCall.entry.tool.toolKind).toBe("codex_approval")
    expect(toolCall.entry.tool.toolId).toBe("call-1:approval")
    const threadStart = process.messages.find((message: any) => message.method === "thread/start") as any
    expect(threadStart?.params.approvalPolicy).toBe("on-request")
    expect(process.messages.find((message: any) => message.id === "approval-1")).toEqual({
      id: "approval-1",
      result: { decision: "acceptForSession" },
    })
  })


  test("emits MCP tool approvals and persists acceptance for the session", async () => {
    const process = new FakeCodexProcess((message, child) => {
      if (message.method === "initialize") {
        child.writeServerMessage({ id: message.id, result: { userAgent: "codex-test" } })
      } else if (message.method === "thread/start") {
        child.writeServerMessage({
          id: message.id,
          result: { thread: { id: "thread-1" }, model: "gpt-5.4", reasoningEffort: "high" },
        })
      } else if (message.method === "turn/start") {
        child.writeServerMessage({
          id: message.id,
          result: { turn: { id: "turn-1", status: "inProgress", error: null } },
        })
        child.writeServerMessage({
          id: "mcp-approval-1",
          method: "mcpServer/elicitation/request",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            serverName: "serena",
            mode: "form",
            _meta: {
              codex_approval_kind: "mcp_tool_call",
              tool_name: "write_memory",
              tool_title: "Write memory",
              persist: ["session", "always"],
            },
            message: "Allow Serena to write this project memory?",
            requestedSchema: { type: "object", properties: {} },
          },
        })
        child.writeServerMessage({
          method: "turn/completed",
          params: {
            threadId: "thread-1",
            turn: { id: "turn-1", status: "completed", error: null },
          },
        })
      }
    })

    const manager = new CodexAppServerManager({ spawnProcess: () => process as never })
    await manager.startSession({
      chatId: "chat-1",
      cwd: "/tmp/project",
      model: "gpt-5.4",
      sessionToken: null,
    })
    const turn = await manager.startTurn({
      chatId: "chat-1",
      model: "gpt-5.4",
      content: "write memory",
      planMode: false,
      onToolRequest: async (request) => {
        expect(request.tool.toolKind).toBe("codex_approval")
        return { decision: "acceptForSession" }
      },
    })

    const events = await collectStream(turn.stream)
    const toolCall = events.find((event) => event.type === "transcript" && event.entry.kind === "tool_call")
    expect(toolCall?.entry.tool.toolKind).toBe("codex_approval")
    expect(process.messages.find((message: any) => message.id === "mcp-approval-1")).toEqual({
      id: "mcp-approval-1",
      result: { action: "accept", content: null, _meta: { persist: "session" } },
    })
  })


  test("persists MCP tool approval acceptance across sessions when advertised", async () => {
    const process = new FakeCodexProcess((message, child) => {
      if (message.method === "initialize") {
        child.writeServerMessage({ id: message.id, result: { userAgent: "codex-test" } })
      } else if (message.method === "thread/start") {
        child.writeServerMessage({
          id: message.id,
          result: { thread: { id: "thread-1" }, model: "gpt-5.4", reasoningEffort: "high" },
        })
      } else if (message.method === "turn/start") {
        child.writeServerMessage({
          id: message.id,
          result: { turn: { id: "turn-1", status: "inProgress", error: null } },
        })
        child.writeServerMessage({
          id: "mcp-approval-1",
          method: "mcpServer/elicitation/request",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            serverName: "serena",
            mode: "form",
            _meta: {
              codex_approval_kind: "mcp_tool_call",
              tool_name: "write_memory",
              persist: "always",
            },
            message: "Allow Serena to write memory?",
            requestedSchema: { type: "object", properties: {} },
          },
        })
        child.writeServerMessage({
          method: "turn/completed",
          params: {
            threadId: "thread-1",
            turn: { id: "turn-1", status: "completed", error: null },
          },
        })
      }
    })

    const manager = new CodexAppServerManager({ spawnProcess: () => process as never })
    await manager.startSession({
      chatId: "chat-1",
      cwd: "/tmp/project",
      model: "gpt-5.4",
      sessionToken: null,
    })

    const turn = await manager.startTurn({
      chatId: "chat-1",
      model: "gpt-5.4",
      content: "write memory",
      planMode: false,
      onToolRequest: async () => ({ decision: "acceptAlways" }),
    })

    await collectStream(turn.stream)

    expect(process.messages.find((message: any) => message.id === "mcp-approval-1")).toEqual({
      id: "mcp-approval-1",
      result: { action: "accept", content: null, _meta: { persist: "always" } },
    })
  })


  test("cancels unsupported MCP elicitations without prompting", async () => {
    let toolRequestCount = 0
    const process = new FakeCodexProcess((message, child) => {
      if (message.method === "initialize") {
        child.writeServerMessage({ id: message.id, result: { userAgent: "codex-test" } })
      } else if (message.method === "thread/start") {
        child.writeServerMessage({
          id: message.id,
          result: { thread: { id: "thread-1" }, model: "gpt-5.4", reasoningEffort: "high" },
        })
      } else if (message.method === "turn/start") {
        child.writeServerMessage({
          id: message.id,
          result: { turn: { id: "turn-1", status: "inProgress", error: null } },
        })
        child.writeServerMessage({
          id: "mcp-form-1",
          method: "mcpServer/elicitation/request",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            serverName: "example",
            mode: "form",
            _meta: null,
            message: "Choose a value",
            requestedSchema: {
              type: "object",
              properties: { choice: { type: "string" } },
            },
          },
        })
        child.writeServerMessage({
          method: "turn/completed",
          params: {
            threadId: "thread-1",
            turn: { id: "turn-1", status: "completed", error: null },
          },
        })
      }
    })

    const manager = new CodexAppServerManager({ spawnProcess: () => process as never })
    await manager.startSession({
      chatId: "chat-1",
      cwd: "/tmp/project",
      model: "gpt-5.4",
      sessionToken: null,
    })

    const turn = await manager.startTurn({
      chatId: "chat-1",
      model: "gpt-5.4",
      content: "request input",
      planMode: false,
      onToolRequest: async () => {
        toolRequestCount += 1
        return {}
      },
    })

    await collectStream(turn.stream)

    expect(toolRequestCount).toBe(0)
    expect(process.messages.find((message: any) => message.id === "mcp-form-1")).toEqual({
      id: "mcp-form-1",
      result: { action: "cancel", content: null, _meta: null },
    })
  })


  test("emits permission approval requests as interactive transcript tools", async () => {
    const requestedPermissions = {
      network: { enabled: true },
      fileSystem: {
        read: ["/tmp/project"],
        write: ["/tmp/project"],
        entries: [],
      },
    }
    const process = new FakeCodexProcess((message, child) => {
      if (message.method === "initialize") {
        child.writeServerMessage({ id: message.id, result: { userAgent: "codex-test" } })
      } else if (message.method === "thread/start") {
        child.writeServerMessage({
          id: message.id,
          result: { thread: { id: "thread-1" }, model: "gpt-5.6-sol", reasoningEffort: "low" },
        })
      } else if (message.method === "turn/start") {
        child.writeServerMessage({
          id: message.id,
          result: { turn: { id: "turn-1", status: "inProgress", error: null } },
        })
        child.writeServerMessage({
          id: "permissions-1",
          method: "item/permissions/requestApproval",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            itemId: "permission-call-1",
            environmentId: "local",
            startedAtMs: 1,
            cwd: "/tmp/project",
            reason: "Need workspace access",
            permissions: requestedPermissions,
          },
        })
        child.writeServerMessage({
          method: "turn/completed",
          params: {
            threadId: "thread-1",
            turn: { id: "turn-1", status: "completed", error: null },
          },
        })
      }
    })

    const manager = new CodexAppServerManager({
      spawnProcess: () => process as never,
    })

    await manager.startSession({
      chatId: "chat-1",
      cwd: "/tmp/project",
      model: "gpt-5.6-sol",
      sessionToken: null,
    })

    const turn = await manager.startTurn({
      chatId: "chat-1",
      model: "gpt-5.6-sol",
      content: "grant permissions",
      planMode: false,
      onToolRequest: async (request) => {
        expect(request.tool.toolKind).toBe("codex_approval")
        if (request.tool.toolKind !== "codex_approval") throw new Error("unexpected tool")
        expect(request.tool.input).toMatchObject({
          approvalKind: "permissions",
          cwd: "/tmp/project",
          reason: "Need workspace access",
          permissions: requestedPermissions,
        })
        return { decision: "accept" }
      },
    })

    const events = await collectStream(turn.stream)
    const toolCall = events.find((event) => event.type === "transcript" && event.entry.kind === "tool_call")
    expect(toolCall?.entry.kind).toBe("tool_call")
    if (!toolCall || toolCall.entry.kind !== "tool_call") throw new Error("missing tool call")
    expect(toolCall.entry.tool.toolKind).toBe("codex_approval")
    expect(toolCall.entry.tool.toolId).toBe("permission-call-1:approval")

    const response = process.messages.find((message: any) => message.id === "permissions-1")
    expect(response).toEqual({
      id: "permissions-1",
      result: {
        permissions: requestedPermissions,
        scope: "turn",
        strictAutoReview: true,
      },
    })
  })


  test("handles code-mode exec command approvals as interactive transcript tools", async () => {
    const process = new FakeCodexProcess((message, child) => {
      if (message.method === "initialize") {
        child.writeServerMessage({ id: message.id, result: { userAgent: "codex-test" } })
      } else if (message.method === "thread/start") {
        child.writeServerMessage({
          id: message.id,
          result: { thread: { id: "thread-1" }, model: "gpt-5.6-sol", reasoningEffort: "low" },
        })
      } else if (message.method === "turn/start") {
        child.writeServerMessage({
          id: message.id,
          result: { turn: { id: "turn-1", status: "inProgress", error: null } },
        })
        child.writeServerMessage({
          id: "exec-approval-1",
          method: "execCommandApproval",
          params: {
            conversationId: "thread-1",
            callId: "exec-call-1",
            approvalId: "approval-root-1",
            command: ["/home/ap24/.bun/bin/bun", "test"],
            cwd: "/tmp/project",
            reason: "Run the test suite",
            parsedCmd: [],
          },
        })
        child.writeServerMessage({
          method: "turn/completed",
          params: {
            threadId: "thread-1",
            turn: { id: "turn-1", status: "completed", error: null },
          },
        })
      }
    })

    const manager = new CodexAppServerManager({
      spawnProcess: () => process as never,
    })

    await manager.startSession({
      chatId: "chat-1",
      cwd: "/tmp/project",
      model: "gpt-5.6-sol",
      sessionToken: null,
    })

    const turn = await manager.startTurn({
      chatId: "chat-1",
      model: "gpt-5.6-sol",
      content: "approve code mode command",
      planMode: false,
      onToolRequest: async (request) => {
        expect(request.tool.toolKind).toBe("codex_approval")
        if (request.tool.toolKind !== "codex_approval") throw new Error("unexpected tool")
        expect(request.tool.input).toMatchObject({
          approvalKind: "command_execution",
          command: "/home/ap24/.bun/bin/bun test",
          cwd: "/tmp/project",
          reason: "Run the test suite",
          approvalId: "approval-root-1",
        })
        return { decision: "acceptForSession" }
      },
    })

    const events = await collectStream(turn.stream)
    const toolCall = events.find((event) => event.type === "transcript" && event.entry.kind === "tool_call")
    expect(toolCall?.entry.kind).toBe("tool_call")
    if (!toolCall || toolCall.entry.kind !== "tool_call") throw new Error("missing tool call")
    expect(toolCall.entry.tool.toolKind).toBe("codex_approval")
    expect(toolCall.entry.tool.toolId).toBe("approval-root-1")

    const response = process.messages.find((message: any) => message.id === "exec-approval-1")
    expect(response).toEqual({
      id: "exec-approval-1",
      result: {
        decision: "approved_for_session",
      },
    })
  })


  test("handles code-mode apply patch approvals as interactive transcript tools", async () => {
    const process = new FakeCodexProcess((message, child) => {
      if (message.method === "initialize") {
        child.writeServerMessage({ id: message.id, result: { userAgent: "codex-test" } })
      } else if (message.method === "thread/start") {
        child.writeServerMessage({
          id: message.id,
          result: { thread: { id: "thread-1" }, model: "gpt-5.6-sol", reasoningEffort: "low" },
        })
      } else if (message.method === "turn/start") {
        child.writeServerMessage({
          id: message.id,
          result: { turn: { id: "turn-1", status: "inProgress", error: null } },
        })
        child.writeServerMessage({
          id: "patch-approval-1",
          method: "applyPatchApproval",
          params: {
            conversationId: "thread-1",
            callId: "patch-call-1",
            fileChanges: {
              "/tmp/project/src/app.ts": {
                type: "update",
                unified_diff: "@@\n-old\n+new\n",
                move_path: null,
              },
            },
            reason: "Apply generated edit",
            grantRoot: "/tmp/project",
          },
        })
        child.writeServerMessage({
          method: "turn/completed",
          params: {
            threadId: "thread-1",
            turn: { id: "turn-1", status: "completed", error: null },
          },
        })
      }
    })

    const manager = new CodexAppServerManager({
      spawnProcess: () => process as never,
    })

    await manager.startSession({
      chatId: "chat-1",
      cwd: "/tmp/project",
      model: "gpt-5.6-sol",
      sessionToken: null,
    })

    const turn = await manager.startTurn({
      chatId: "chat-1",
      model: "gpt-5.6-sol",
      content: "approve code mode patch",
      planMode: false,
      onToolRequest: async (request) => {
        expect(request.tool.toolKind).toBe("codex_approval")
        if (request.tool.toolKind !== "codex_approval") throw new Error("unexpected tool")
        expect(request.tool.input).toMatchObject({
          approvalKind: "file_change",
          grantRoot: "/tmp/project",
          reason: "Apply generated edit",
        })
        return { decision: "accept" }
      },
    })

    const events = await collectStream(turn.stream)
    const toolCall = events.find((event) => event.type === "transcript" && event.entry.kind === "tool_call")
    expect(toolCall?.entry.kind).toBe("tool_call")
    if (!toolCall || toolCall.entry.kind !== "tool_call") throw new Error("missing tool call")
    expect(toolCall.entry.tool.toolKind).toBe("codex_approval")
    expect(toolCall.entry.tool.toolId).toBe("patch-call-1:approval")

    const response = process.messages.find((message: any) => message.id === "patch-approval-1")
    expect(response).toEqual({
      id: "patch-approval-1",
      result: {
        decision: "approved",
      },
    })
  })


  test("keeps approval tool ids separate from approved command items", async () => {
    const process = new FakeCodexProcess((message, child) => {
      if (message.method === "initialize") {
        child.writeServerMessage({ id: message.id, result: { userAgent: "codex-test" } })
      } else if (message.method === "thread/start") {
        child.writeServerMessage({
          id: message.id,
          result: { thread: { id: "thread-1" }, model: "gpt-5.4", reasoningEffort: "high" },
        })
      } else if (message.method === "turn/start") {
        child.writeServerMessage({
          id: message.id,
          result: { turn: { id: "turn-1", status: "inProgress", error: null } },
        })
        child.writeServerMessage({
          id: "approval-1",
          method: "item/commandExecution/requestApproval",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            itemId: "call-1",
            command: "echo approved",
            cwd: "/tmp/project",
          },
        })
      } else if (message.id === "approval-1") {
        child.writeServerMessage({
          method: "item/started",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            item: {
              type: "commandExecution",
              id: "call-1",
              command: "echo approved",
              cwd: "/tmp/project",
              status: "inProgress",
            },
          },
        })
        child.writeServerMessage({
          method: "item/completed",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            item: {
              type: "commandExecution",
              id: "call-1",
              command: "echo approved",
              cwd: "/tmp/project",
              status: "completed",
              aggregatedOutput: "approved\n",
              exitCode: 0,
            },
          },
        })
        child.writeServerMessage({
          method: "turn/completed",
          params: {
            threadId: "thread-1",
            turn: { id: "turn-1", status: "completed", error: null },
          },
        })
      }
    })

    const manager = new CodexAppServerManager({ spawnProcess: () => process as never })
    await manager.startSession({
      chatId: "chat-1",
      cwd: "/tmp/project",
      model: "gpt-5.4",
      sessionToken: null,
    })

    const turn = await manager.startTurn({
      chatId: "chat-1",
      model: "gpt-5.4",
      content: "approve and run",
      planMode: false,
      onToolRequest: async () => ({ decision: "accept" }),
    })

    const events = await collectStream(turn.stream)
    const toolCalls = events
      .filter((event) => event.type === "transcript" && event.entry.kind === "tool_call")
      .map((event) => event.entry.tool)
    const toolResults = events
      .filter((event) => event.type === "transcript" && event.entry.kind === "tool_result")
      .map((event) => event.entry)

    expect(toolCalls.map((tool) => [tool.toolKind, tool.toolId])).toContainEqual(["codex_approval", "call-1:approval"])
    expect(toolCalls.map((tool) => [tool.toolKind, tool.toolId])).toContainEqual(["bash", "call-1"])
    expect(toolResults.map((result) => [result.toolId, result.content])).toContainEqual(["call-1", "approved\n"])
  })


  test("lists threads using the snake_case updated_at sort key", async () => {
    const process = new FakeCodexProcess((message, child) => {
      if (message.method === "initialize") {
        child.writeServerMessage({ id: message.id, result: { userAgent: "codex-test" } })
      } else if (message.method === "thread/list") {
        child.writeServerMessage({
          id: message.id,
          result: {
            data: [],
            nextCursor: null,
          },
        })
      }
    })

    const manager = new CodexAppServerManager({
      spawnProcess: () => process as never,
    })

    const threads = await manager.listThreads({
      cwd: "/tmp/project",
    })

    expect(threads).toEqual([])
    const threadList = process.messages.find((message: any) => message.method === "thread/list") as
      | { method: "thread/list"; params: { sortKey?: string } }
      | undefined
    expect(threadList?.params.sortKey).toBe("updated_at")
  })


  test("lists available models through the app-server", async () => {
    const process = new FakeCodexProcess((message, child) => {
      if (message.method === "initialize") {
        child.writeServerMessage({ id: message.id, result: { userAgent: "codex-test" } })
      } else if (message.method === "model/list") {
        child.writeServerMessage({
          id: message.id,
          result: {
            data: [
              {
                id: "gpt-5.4-mini",
                model: "gpt-5.4-mini",
                displayName: "GPT-5.4-Mini",
                description: "Small, fast, and cost-efficient model for simpler coding tasks.",
                hidden: false,
                supportedReasoningEfforts: [
                  { reasoningEffort: "low", description: "Fast responses with lighter reasoning" },
                  { reasoningEffort: "medium", description: "Balances speed and reasoning depth" },
                ],
                defaultReasoningEffort: "medium",
                inputModalities: ["text"],
                serviceTiers: [],
                defaultServiceTier: null,
                isDefault: false,
              },
            ],
            nextCursor: null,
          },
        })
      }
    })

    const manager = new CodexAppServerManager({
      spawnProcess: () => process as never,
    })

    const models = await manager.listModels({ cwd: "/tmp/project" })

    expect(models.map((model) => model.id)).toEqual(["gpt-5.4-mini"])
    const modelList = process.messages.find((message: any) => message.method === "model/list") as
      | { method: "model/list"; params: { cursor?: string | null; includeHidden?: boolean; limit?: number } }
      | undefined
    expect(modelList?.params).toEqual({
      cursor: null,
      includeHidden: false,
      limit: 200,
    })
  })


  test("stops utility sessions when initialization fails", async () => {
    const process = new FakeCodexProcess((message, child) => {
      if (message.method === "initialize") {
        child.writeServerMessage({
          id: message.id,
          error: { message: "initialize failed" },
        })
      }
    })

    const manager = new CodexAppServerManager({
      spawnProcess: () => process as never,
    })

    await expect(manager.listThreads({
      cwd: "/tmp/project",
    })).rejects.toThrow("initialize failed")

    expect(process.killed).toBe(true)
  })


  test("generateStructured reads structured JSON from raw response items", async () => {
    const process = new FakeCodexProcess((message, child) => {
      if (message.method === "initialize") {
        child.writeServerMessage({ id: message.id, result: { userAgent: "codex-test" } })
      } else if (message.method === "thread/start") {
        child.writeServerMessage({
          id: message.id,
          result: { thread: { id: "thread-structured" }, model: "gpt-5.5", reasoningEffort: "high" },
        })
      } else if (message.method === "turn/start") {
        child.writeServerMessage({
          id: message.id,
          result: { turn: { id: "turn-structured", status: "completed", error: null } },
        })
        child.writeServerMessage({
          method: "rawResponseItem/completed",
          params: {
            threadId: "thread-structured",
            turnId: "turn-structured",
            item: {
              type: "message",
              role: "assistant",
              content: [
                {
                  type: "output_text",
                  text: "{\"title\":\"Raw Codex title\"}",
                },
              ],
              phase: "final_answer",
            },
          },
        })
        child.writeServerMessage({
          method: "turn/completed",
          params: {
            threadId: "thread-structured",
            turn: { id: "turn-structured", status: "completed", error: null },
          },
        })
      }
    })

    const manager = new CodexAppServerManager({
      spawnProcess: () => process as never,
    })

    const result = await manager.generateStructured({
      cwd: "/tmp/project",
      prompt: "Return JSON",
      model: "gpt-5.3-codex",
      effort: "low",
      outputSchema: {
        type: "object",
        properties: {
          title: { type: "string" },
        },
        required: ["title"],
        additionalProperties: false,
      },
    })

    expect(result).toBe("{\"title\":\"Raw Codex title\"}")
    expect(process.killed).toBe(true)
  })


  test("generateStructured reads structured JSON from agent message deltas", async () => {
    const process = new FakeCodexProcess((message, child) => {
      if (message.method === "initialize") {
        child.writeServerMessage({ id: message.id, result: { userAgent: "codex-test" } })
      } else if (message.method === "thread/start") {
        child.writeServerMessage({
          id: message.id,
          result: { thread: { id: "thread-structured" }, model: "gpt-5.5", reasoningEffort: "high" },
        })
      } else if (message.method === "turn/start") {
        child.writeServerMessage({
          id: message.id,
          result: { turn: { id: "turn-structured", status: "completed", error: null } },
        })
        child.writeServerMessage({
          method: "item/agentMessage/delta",
          params: {
            threadId: "thread-structured",
            turnId: "turn-structured",
            itemId: "msg-structured",
            delta: "{\"title\":",
          },
        })
        child.writeServerMessage({
          method: "item/agentMessage/delta",
          params: {
            threadId: "thread-structured",
            turnId: "turn-structured",
            itemId: "msg-structured",
            delta: "\"Delta Codex title\"}",
          },
        })
        child.writeServerMessage({
          method: "turn/completed",
          params: {
            threadId: "thread-structured",
            turn: { id: "turn-structured", status: "completed", error: null },
          },
        })
      }
    })

    const manager = new CodexAppServerManager({
      spawnProcess: () => process as never,
    })

    const result = await manager.generateStructured({
      cwd: "/tmp/project",
      prompt: "Return JSON",
      model: "gpt-5.3-codex",
      effort: "low",
      outputSchema: {
        type: "object",
        properties: {
          title: { type: "string" },
        },
        required: ["title"],
        additionalProperties: false,
      },
    })

    expect(result).toBe("{\"title\":\"Delta Codex title\"}")
    expect(process.killed).toBe(true)
  })


  test("generateStructured throws Codex error notification details", async () => {
    const process = new FakeCodexProcess((message, child) => {
      if (message.method === "initialize") {
        child.writeServerMessage({ id: message.id, result: { userAgent: "codex-test" } })
      } else if (message.method === "thread/start") {
        child.writeServerMessage({
          id: message.id,
          result: { thread: { id: "thread-structured" }, model: "gpt-5.5", reasoningEffort: "high" },
        })
      } else if (message.method === "turn/start") {
        child.writeServerMessage({
          id: message.id,
          result: { turn: { id: "turn-structured", status: "inProgress", error: null } },
        })
        child.writeServerMessage({
          method: "error",
          params: {
            error: {
              message: "Reconnecting... 2/5",
              additionalDetails: "unexpected status 503 Service Unavailable: No accounts with a plan supporting model",
            },
            willRetry: true,
            threadId: "thread-structured",
            turnId: "turn-structured",
          },
        })
        child.writeServerMessage({
          method: "turn/completed",
          params: {
            threadId: "thread-structured",
            turn: { id: "turn-structured", status: "failed", error: null },
          },
        })
      }
    })

    const manager = new CodexAppServerManager({
      spawnProcess: () => process as never,
    })

    await expect(manager.generateStructured({
      cwd: "/tmp/project",
      prompt: "Return JSON",
      model: "gpt-5.3-codex",
      effort: "low",
      outputSchema: {
        type: "object",
        properties: {
          title: { type: "string" },
        },
        required: ["title"],
        additionalProperties: false,
      },
    })).rejects.toThrow("No accounts with a plan supporting model")

    expect(process.killed).toBe(true)
  })


  test("keeps parent fallback output isolated from subagent notifications", async () => {
    const process = new FakeCodexProcess((message, child) => {
      if (message.method === "initialize") {
        child.writeServerMessage({ id: message.id, result: { userAgent: "codex-test" } })
      } else if (message.method === "thread/start") {
        child.writeServerMessage({
          id: message.id,
          result: { thread: { id: "parent-thread" }, model: "gpt-5.4", reasoningEffort: "high" },
        })
      } else if (message.method === "turn/start") {
        child.writeServerMessage({
          id: message.id,
          result: { turn: { id: "parent-turn", status: "inProgress", error: null } },
        })
        child.writeServerMessage({
          method: "item/completed",
          params: {
            threadId: "child-thread",
            turnId: "child-turn",
            item: {
              type: "agentMessage",
              id: "child-answer",
              text: "child final",
              phase: "final_answer",
            },
          },
        })
        child.writeServerMessage({
          method: "rawResponseItem/completed",
          params: {
            threadId: "child-thread",
            turnId: "child-turn",
            item: {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "stale child fallback" }],
              phase: "final_answer",
            },
          },
        })
        child.writeServerMessage({
          method: "rawResponseItem/completed",
          params: {
            threadId: "parent-thread",
            turnId: "parent-turn",
            item: {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "parent fallback" }],
              phase: "final_answer",
            },
          },
        })
        child.writeServerMessage({
          method: "turn/completed",
          params: {
            threadId: "parent-thread",
            turn: { id: "parent-turn", status: "completed", error: null },
          },
        })
      }
    })

    const manager = new CodexAppServerManager({
      spawnProcess: () => process as never,
    })
    await manager.startSession({
      chatId: "chat-1",
      cwd: "/tmp/project",
      model: "gpt-5.4",
      sessionToken: null,
    })

    const turn = await manager.startTurn({
      chatId: "chat-1",
      model: "gpt-5.4",
      content: "delegate part of the task",
      planMode: false,
      onToolRequest: async () => ({}),
    })
    const events = await collectStream(turn.stream)
    const assistantTexts = events
      .filter((event) => event.type === "transcript" && event.entry.kind === "assistant_text")
      .map((event) => event.entry.text)

    expect(assistantTexts).toEqual(["child final", "parent fallback"])
  })


  test("waits for in-flight thread initialization before starting a turn", async () => {
    let resolveThreadStartObserved!: () => void
    const threadStartObserved = new Promise<void>((resolve) => {
      resolveThreadStartObserved = resolve
    })
    let threadStartRequestId: string | undefined
    const process = new FakeCodexProcess((message, child) => {
      if (message.method === "initialize") {
        child.writeServerMessage({ id: message.id, result: { userAgent: "codex-test" } })
      } else if (message.method === "thread/start") {
        threadStartRequestId = message.id
        resolveThreadStartObserved()
      } else if (message.method === "turn/start") {
        child.writeServerMessage({
          id: message.id,
          result: { turn: { id: "turn-1", status: "inProgress", error: null } },
        })
      }
    })

    const manager = new CodexAppServerManager({
      spawnProcess: () => process as never,
    })
    const sessionArgs = {
      chatId: "chat-1",
      cwd: "/tmp/project",
      model: "gpt-5.4",
      sessionToken: null,
    }

    const firstSession = manager.startSession(sessionArgs)
    const secondTurn = manager.startSession(sessionArgs).then(() => manager.startTurn({
      chatId: "chat-1",
      model: "gpt-5.4",
      content: "Hello",
      planMode: false,
      onToolRequest: async () => ({}),
    }))

    await threadStartObserved
    await Promise.resolve()
    expect(process.messages.some((message: any) => message.method === "turn/start")).toBe(false)
    process.writeServerMessage({
      id: threadStartRequestId,
      result: { thread: { id: "thread-1" }, model: "gpt-5.4", reasoningEffort: "high" },
    })
    await firstSession
    await secondTurn

    const turnStart = process.messages.find((message: any) => message.method === "turn/start") as any
    expect(turnStart.params.threadId).toBe("thread-1")
    expect(process.messages.filter((message: any) => message.method === "thread/start")).toHaveLength(1)
  })


  test("rejects in-flight thread initialization when the session is stopped", async () => {
    let resolveThreadStartObserved!: () => void
    const threadStartObserved = new Promise<void>((resolve) => {
      resolveThreadStartObserved = resolve
    })
    const process = new FakeCodexProcess((message, child) => {
      if (message.method === "initialize") {
        child.writeServerMessage({ id: message.id, result: { userAgent: "codex-test" } })
      } else if (message.method === "thread/start") {
        resolveThreadStartObserved()
      }
    })
    const replacementProcess = new FakeCodexProcess((message, child) => {
      if (message.method === "initialize") {
        child.writeServerMessage({ id: message.id, result: { userAgent: "codex-test" } })
      } else if (message.method === "thread/start") {
        child.writeServerMessage({
          id: message.id,
          result: { thread: { id: "thread-2" }, model: "gpt-5.4", reasoningEffort: "high" },
        })
      }
    })
    let spawnCount = 0
    const manager = new CodexAppServerManager({
      spawnProcess: () => (spawnCount++ === 0 ? process : replacementProcess) as never,
    })

    const sessionStart = manager.startSession({
      chatId: "chat-1",
      cwd: "/tmp/project",
      model: "gpt-5.4",
      sessionToken: null,
    })
    await threadStartObserved

    let startError: unknown
    const settledSessionStart = sessionStart.catch((error) => {
      startError = error
    })
    manager.stopSession("chat-1")
    await settledSessionStart

    expect(startError).toBeInstanceOf(Error)
    expect((startError as Error).message).toBe("Codex session closed")

    const replacementSession = await manager.startSession({
      chatId: "chat-1",
      cwd: "/tmp/project",
      model: "gpt-5.4",
      sessionToken: null,
    })
    expect(replacementSession).toEqual({ sessionToken: "thread-2", resumeFellBack: false })
  })


  test("accepts a steer before its echoed user message is persisted", async () => {
    let allowSteeredEntryPersistence!: () => void
    const steeredEntryPersistenceGate = new Promise<void>((resolve) => {
      allowSteeredEntryPersistence = resolve
    })
    let sawSteeredEntry = false
    const process = new FakeCodexProcess((message, child) => {
      if (message.method === "initialize") {
        child.writeServerMessage({ id: message.id, result: { userAgent: "codex-test" } })
      } else if (message.method === "thread/start") {
        child.writeServerMessage({
          id: message.id,
          result: { thread: { id: "thread-1" }, model: "gpt-5.4", reasoningEffort: "high" },
        })
      } else if (message.method === "turn/start") {
        child.writeServerMessage({
          id: message.id,
          result: { turn: { id: "turn-1", status: "inProgress", error: null } },
        })
      } else if (message.method === "turn/steer") {
        child.writeServerMessage({
          id: message.id,
          result: { turnId: "turn-1" },
        })
        child.writeServerMessage({
          method: "item/started",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            item: {
              type: "userMessage",
              id: "item-steer-1",
              clientId: "queued-1",
              content: [{ type: "text", text: "steered prompt", text_elements: [] }],
            },
          },
        })
        child.writeServerMessage({
          method: "turn/completed",
          params: {
            threadId: "thread-1",
            turn: { id: "turn-1", status: "completed", error: null },
          },
        })
      }
    })

    const manager = new CodexAppServerManager({
      spawnProcess: () => process as never,
    })

    await manager.startSession({
      chatId: "chat-1",
      cwd: "/tmp/project",
      model: "gpt-5.4",
      sessionToken: null,
    })

    const turn = await manager.startTurn({
      chatId: "chat-1",
      model: "gpt-5.4",
      content: "initial prompt",
      planMode: false,
      onToolRequest: async () => ({}),
    })
    const steeredEntry = timestamped({
      kind: "user_prompt",
      content: "steered prompt",
      attachments: [],
      steered: true,
    }) as Extract<ReturnType<typeof timestamped>, { kind: "user_prompt" }>
    const eventsPromise = (async () => {
      const events: any[] = []
      for await (const event of turn.stream) {
        events.push(event)
        if (event.entry === steeredEntry) {
          sawSteeredEntry = true
          await steeredEntryPersistenceGate
        }
        event.onPersisted?.()
      }
      return events
    })()

    await expect(manager.steerTurn({
      chatId: "chat-1",
      expectedTurnId: "stale-turn",
      content: "stale steer",
      clientUserMessageId: "queued-stale",
      transcriptEntry: timestamped({ kind: "user_prompt", content: "stale steer", steered: true }) as
        Extract<ReturnType<typeof timestamped>, { kind: "user_prompt" }>,
    })).rejects.toThrow("Codex turn changed before steering")
    expect(process.messages.some((message: any) => message.method === "turn/steer")).toBe(false)

    const steer = manager.startSteerTurn({
      chatId: "chat-1",
      expectedTurnId: "turn-1",
      content: "steered prompt",
      clientUserMessageId: "queued-1",
      transcriptEntry: steeredEntry,
    })
    await steer.accepted
    let steerSettled = false
    const steerPromise = steer.settled.then(() => {
      steerSettled = true
    })
    while (!sawSteeredEntry) {
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    const settledBeforePersistence = steerSettled
    allowSteeredEntryPersistence()
    await steerPromise
    expect(settledBeforePersistence).toBe(false)

    const events = await eventsPromise
    const steerRequest = process.messages.find((message: any) => message.method === "turn/steer") as
      | { id: string; method: "turn/steer"; params: Record<string, unknown> }
      | undefined
    expect(steerRequest).toBeDefined()
    if (!steerRequest) throw new Error("missing steer request")
    expect(steerRequest).toEqual({
      id: steerRequest.id,
      method: "turn/steer",
      params: {
        threadId: "thread-1",
        input: [
          { type: "text", text: "steered prompt", text_elements: [] },
        ],
        expectedTurnId: "turn-1",
        clientUserMessageId: "queued-1",
      },
    })
    expect(process.messages.filter((message: any) => message.method === "turn/start")).toHaveLength(1)
    expect(process.messages.some((message: any) => message.method === "turn/interrupt")).toBe(false)
    expect(events.filter((event) => event.type === "transcript").map((event) => event.entry)).toContainEqual(steeredEntry)
    expect(events.filter((event) => event.type === "transcript" && event.entry.kind === "result")).toHaveLength(1)
  })


  test("keeps selected skill intent on the steer wire when its path no longer matches discovery", async () => {
    const selectedSkills = [{
      name: "deploy-helper",
      path: "/tmp/old-project/.agents/skills/deploy-helper/SKILL.md",
    }]
    const discoveredSkillPath = "/tmp/project/.agents/skills/deploy-helper/SKILL.md"
    let resolvedSkillCount = 0
    let modelVisibleText = ""
    const process = new FakeCodexProcess((message, child) => {
      if (message.method === "initialize") {
        child.writeServerMessage({ id: message.id, result: { userAgent: "codex-test" } })
      } else if (message.method === "thread/start") {
        child.writeServerMessage({
          id: message.id,
          result: { thread: { id: "thread-1" }, model: "gpt-5.4", reasoningEffort: "high" },
        })
      } else if (message.method === "turn/start") {
        child.writeServerMessage({
          id: message.id,
          result: { turn: { id: "turn-1", status: "inProgress", error: null } },
        })
      } else if (message.method === "turn/steer") {
        // Codex silently skips structured skills whose paths no longer match
        // discovery. The remaining text must still carry the selected intent.
        resolvedSkillCount = message.params.input.filter((item: any) =>
          item.type === "skill" && item.path === discoveredSkillPath
        ).length
        modelVisibleText = message.params.input
          .filter((item: any) => item.type === "text")
          .map((item: any) => item.text)
          .join("\n")
        child.writeServerMessage({ id: message.id, result: { turnId: "turn-1" } })
        const echoedItem = {
          type: "userMessage",
          id: "item-steer-skill",
          clientId: message.params.clientUserMessageId,
          content: [{ type: "text", text: modelVisibleText, text_elements: [] }],
        }
        for (const method of ["item/started", "item/completed"]) {
          child.writeServerMessage({
            method,
            params: { threadId: "thread-1", turnId: "turn-1", item: echoedItem },
          })
        }
        child.writeServerMessage({
          method: "turn/completed",
          params: {
            threadId: "thread-1",
            turn: { id: "turn-1", status: "completed", error: null },
          },
        })
      }
    })
    const manager = new CodexAppServerManager({ spawnProcess: () => process as never })
    await manager.startSession({ chatId: "chat-1", cwd: "/tmp/project", model: "gpt-5.4", sessionToken: null })
    const turn = await manager.startTurn({
      chatId: "chat-1",
      model: "gpt-5.4",
      content: "initial prompt",
      planMode: false,
      onToolRequest: async () => ({}),
    })
    const content = "  Use /deploy-helper for the next step  "
    const steeredEntry = timestamped({ kind: "user_prompt", content, steered: true }) as
      Extract<ReturnType<typeof timestamped>, { kind: "user_prompt" }>
    const eventsPromise = (async () => {
      const events: any[] = []
      for await (const event of turn.stream) {
        events.push(event)
        event.onPersisted?.()
      }
      return events
    })()

    const steer = manager.startSteerTurn({
      chatId: "chat-1",
      expectedTurnId: "turn-1",
      content,
      selectedSkills,
      clientUserMessageId: "queued-skill",
      transcriptEntry: steeredEntry,
    })
    await steer.accepted
    await steer.settled
    const events = await eventsPromise
    const steerRequest = process.messages.find((message: any) => message.method === "turn/steer") as any
    expect(steerRequest.params.input.filter((item: any) => item.type === "skill")).toEqual([
      { type: "skill", ...selectedSkills[0] },
    ])
    expect(resolvedSkillCount).toBe(0)
    expect(modelVisibleText).toBe(
      `${content.trim()}\n\n<system-message>the user would like to use the skill available at ${selectedSkills[0]!.path}</system-message>`
    )
    const userEvents = events.filter((event) => event.type === "transcript" && event.entry.kind === "user_prompt")
    expect(userEvents).toHaveLength(1)
    expect(userEvents[0].entry).toBe(steeredEntry)
    expect(userEvents[0].entry.content).toBe(content)
    expect(process.messages.filter((message: any) => message.method === "turn/start")).toHaveLength(1)
    expect(process.messages.some((message: any) => message.method === "turn/interrupt")).toBe(false)
  })


  test("rejects steering when the active turn completes without echoing the queued message", async () => {
    const process = new FakeCodexProcess((message, child) => {
      if (message.method === "initialize") {
        child.writeServerMessage({ id: message.id, result: { userAgent: "codex-test" } })
      } else if (message.method === "thread/start") {
        child.writeServerMessage({
          id: message.id,
          result: { thread: { id: "thread-1" }, model: "gpt-5.4", reasoningEffort: "high" },
        })
      } else if (message.method === "turn/start") {
        child.writeServerMessage({
          id: message.id,
          result: { turn: { id: "turn-1", status: "inProgress", error: null } },
        })
      } else if (message.method === "turn/steer") {
        child.writeServerMessage({ id: message.id, result: { turnId: "turn-1" } })
        child.writeServerMessage({
          method: "turn/completed",
          params: {
            threadId: "thread-1",
            turn: { id: "turn-1", status: "completed", error: null },
          },
        })
      }
    })
    const manager = new CodexAppServerManager({ spawnProcess: () => process as never })

    await manager.startSession({
      chatId: "chat-1",
      cwd: "/tmp/project",
      model: "gpt-5.4",
      sessionToken: null,
    })
    const turn = await manager.startTurn({
      chatId: "chat-1",
      model: "gpt-5.4",
      content: "initial prompt",
      planMode: false,
      onToolRequest: async () => ({}),
    })
    const eventsPromise = collectStream(turn.stream)

    await expect(manager.steerTurn({
      chatId: "chat-1",
      expectedTurnId: "turn-1",
      content: "late follow up",
      clientUserMessageId: "queued-late",
      transcriptEntry: timestamped({
        kind: "user_prompt",
        content: "late follow up",
        steered: true,
      }) as Extract<ReturnType<typeof timestamped>, { kind: "user_prompt" }>,
    })).rejects.toThrow("Codex turn ended before steering was acknowledged")

    const events = await eventsPromise
    expect(events.some((event) => event.entry?.kind === "user_prompt")).toBe(false)
    expect(events.filter((event) => event.entry?.kind === "result")).toHaveLength(1)
  })
})

describe("Codex shared tools", () => {
  for (const method of ["thread/start", "thread/resume", "thread/fork"] as const) {
    test(`registers the chat MCP server on ${method}`, async () => {
      let config: any
      const process = new FakeCodexProcess((message, child) => {
        if (message.method === "initialize") child.writeServerMessage({ id: message.id, result: {} })
        if (message.method === method) {
          config = message.params.config["mcp_servers.kanna"]
          child.writeServerMessage({ id: message.id, result: { thread: { id: "thread-tools" } } })
        }
      })
      const manager = new CodexAppServerManager({ spawnProcess: () => process as never })
      try {
        await manager.startSession({
          chatId: "tools", cwd: "/repo", model: "gpt-5.4",
          sessionToken: method === "thread/resume" ? "existing" : null,
          pendingForkSessionToken: method === "thread/fork" ? "parent" : null,
          customTools: { execute: async () => ({ content: [{ type: "text", text: "ok" }] }) },
        })
        expect(config.url).toStartWith("http://127.0.0.1:")
        expect(config.tool_timeout_sec).toBeGreaterThan(3600)
        expect((await fetch(config.url)).status).toBe(401)
        manager.stopSession("tools")
        await expect(fetch(config.url)).rejects.toThrow()
      } finally {
        manager.stopAll()
      }
    })
  }
})
