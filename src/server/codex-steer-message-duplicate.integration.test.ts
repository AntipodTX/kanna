import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { AgentCoordinator } from "./agent"
import { AsyncQueue } from "./async-queue"
import { EventStore } from "./event-store"
import type { HarnessEvent } from "./harness-types"
import type { TranscriptEntry } from "../shared/types"
import { deriveChatSnapshot } from "./read-models"

test("native steering keeps the persisted prompt and queue row until RPC acceptance", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "kanna-steer-duplicate-"))
  const events = new AsyncQueue<HarnessEvent>()
  let accept!: () => void
  const accepted = new Promise<void>(resolve => { accept = resolve })
  let coordinator: AgentCoordinator | undefined
  try {
    const store = new EventStore(dir)
    await store.initialize()
    const project = await store.openProject(dir, "Project")
    const chat = await store.createChat(project.id)
    await store.setChatProvider(chat.id, "codex")
    const manager = {
      startSession: async () => ({ sessionToken: "native-session", resumeFellBack: false }),
      startTurn: async () => ({ provider: "codex", providerTurnId: "active-turn", stream: events,
        interrupt: async () => {}, close: () => events.finish() }),
      startSteerTurn: (args: { transcriptEntry: TranscriptEntry }) => {
        const persisted = new Promise<void>((resolve, reject) => {
          events.push({ type: "transcript", entry: args.transcriptEntry,
            onPersisted: error => error ? reject(error) : resolve() })
        })
        // Match the native manager: the echo can be durable before its RPC reply.
        return { accepted, settled: Promise.all([accepted, persisted]).then(() => {}) }
      },
      listModels: async () => [], stopSession: () => {}, stopAll: () => {}, getResourceCounts: () => ({}),
    }
    coordinator = new AgentCoordinator({ store, codexManager: manager as never, onStateChange: () => {} })
    await coordinator.send({ type: "chat.send", chatId: chat.id, content: "A", provider: "codex" })
    const enqueueing = coordinator.enqueue({ type: "message.enqueue", chatId: chat.id,
      content: "B", provider: "codex", steer: true })
    void enqueueing.catch(() => {})
    for (let i = 0; i < 100; i++) {
      const queued = store.getQueuedMessages(chat.id)[0]
      if (queued && store.getMessages(chat.id).some(entry => entry.kind === "user_prompt" && entry._id === queued.id)) break
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    const queued = store.getQueuedMessages(chat.id)[0]!
    expect(queued).toBeDefined()
    const snapshot = () => deriveChatSnapshot(store.state, coordinator!.getActiveStatuses(), new Set(), chat.id,
      () => ({ messages: store.getMessages(chat.id), startIndex: 0, readAnchor: null }),
      undefined, coordinator!.getPendingCodexSteerIds(chat.id))!
    expect(snapshot().queuedMessages).toMatchObject([{ id: queued.id, steering: true }])
    expect(snapshot().messages.filter(entry => entry.kind === "user_prompt" && entry._id === queued.id)).toHaveLength(1)
    accept()
    await enqueueing
    for (let i = 0; i < 100 && store.getQueuedMessage(chat.id, queued.id); i++)
      await new Promise(resolve => setTimeout(resolve, 10))
    expect(snapshot().queuedMessages).toEqual([])
    expect(snapshot().messages.filter(entry => entry.kind === "user_prompt" && entry._id === queued.id)).toHaveLength(1)
  } finally {
    accept()
    events.finish()
    for (let i = 0; i < 100 && coordinator && (coordinator.getResourceCounts().activeTurns || coordinator.getDrainingChatIds().size); i++)
      await new Promise(resolve => setTimeout(resolve, 10))
    await coordinator?.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})
