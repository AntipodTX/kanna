import { test, expect } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "node:os"
import { EventStore } from "./event-store"
import { AgentCoordinator } from "./agent"
import { CodexPromptHistory } from "./codex-prompt-history"
import { AsyncQueue } from "./async-queue"
import type { HarnessEvent } from "./harness-types"

test("a cancelled provenance write cannot stop the successor Codex session", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "kanna-provenance-owner-"))
  let coordinator: AgentCoordinator | undefined
  const queues: Array<AsyncQueue<HarnessEvent>> = []
  let release = () => {}
  try {
    const store = new EventStore(dir)
    await store.initialize()
    const project = await store.openProject(dir, "Project")
    const chat = await store.createChat(project.id)
    await store.setChatProvider(chat.id, "codex")
    await store.setSessionToken(chat.id, "source")
    let started = 0
    let currentTurn: string | null = null
    const stopped: Array<string | null> = []
    let entered = () => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    const writing = new Promise<void>((resolve) => { entered = resolve })
    coordinator = new AgentCoordinator({
      store,
      onStateChange: () => {},
      generateTitle: async () => ({ title: null, usedFallback: false, failureMessage: null }),
      checkSessionArtifact: () => ({ status: "exists" }) as never,
      codexManager: {
        readPromptHistory: async () => ({ inputs: store.getMessages(chat.id).filter((e) => e.kind === "user_prompt").map((e, i) => ({
          turnId: `turn-${i + 1}`, promptId: e._id, text: (e as { content: string }).content, userIndex: 0,
        })) }),
        startSession: async () => ({ sessionToken: "source", resumeFellBack: false, startupOutcome: { kind: "resumed" } }),
        startTurn: async () => {
          const id = `turn-${++started}`
          currentTurn = id
          const queue = new AsyncQueue<HarnessEvent>()
          queues.push(queue)
          return {
            provider: "codex",
            providerTurnId: id,
            stream: queue,
            close: () => queue.finish(),
            interrupt: async () => { if (currentTurn === id) currentTurn = null },
          }
        },
        stopSession: () => { stopped.push(currentTurn); currentTurn = null },
        stopAll: () => {},
        getResourceCounts: () => ({}),
        listModels: async () => [],
      } as never,
    })
    const journal = (coordinator as unknown as { codexPromptHistory: CodexPromptHistory }).codexPromptHistory
    const record = journal.recordTurn.bind(journal)
    let records = 0
    journal.recordTurn = async (...args) => {
      if (++records === 1) { entered(); await gate }
      await record(...args)
    }
    const first = coordinator.send({ type: "chat.send", chatId: chat.id, content: "First" })
    await writing
    await coordinator.cancel(chat.id)
    await coordinator.send({ type: "chat.send", chatId: chat.id, content: "Successor" })
    expect(currentTurn as string | null).toBe("turn-2")
    release()
    await first
    expect(currentTurn as string | null).toBe("turn-2")
    expect(stopped).not.toContain("turn-2")
    expect(coordinator.activeTurns.get(chat.id)?.turn?.providerTurnId).toBe("turn-2")
  } finally {
    release()
    // Complete cancellation writes before removing the fixture's data.
    for (const chatId of coordinator?.activeTurns.keys() ?? []) {
      await coordinator?.cancel(chatId)
    }
    for (const queue of queues) queue.finish()
    await coordinator?.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})

