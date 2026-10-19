import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { EventStore } from "./event-store"
import { createWsRouter, type ClientState } from "./ws-router"
import type { ChatSnapshot } from "../shared/types"

const onChange = () => () => {}

test("stream updates read only the new tail and release subscription maps", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "kanna-router-performance-"))
  const store = new EventStore(directory)
  await store.initialize()
  const project = await store.openProject(directory)
  const chat = await store.createChat(project.id)
  const router = createWsRouter({
    store,
    agent: {
      getActiveStatuses: () => new Map(),
      getDrainingChatIds: () => new Set(),
      getPendingCodexSteerIds: () => new Set(),
    },
    diffStore: {}, worktreeProbe: {}, terminals: { onEvent: onChange },
    keybindings: { onChange }, appSettings: { onChange, getSnapshot: () => ({ transcript: { windowAssistantMessages: 5 } }) },
    llmProvider: {}, refreshDiscovery: async () => [], getDiscoveredProjects: () => [],
    machineDisplayName: "test", updateManager: null,
  } as never)
  const data: ClientState = { subscriptions: new Map(), snapshotSignatures: new Map() }
  const sent: Array<{ type: string; snapshot?: { data: ChatSnapshot } }> = []
  const ws = { data, send: (text: string) => { sent.push(JSON.parse(text)); return 1 } } as never
  const send = (value: object) => router.handleMessage(ws, JSON.stringify({ v: 1, ...value }))
  router.handleOpen(ws)
  try {
    for (let i = 0; i < 20; i++) await store.appendMessage(chat.id, { _id: `${i}`, kind: "assistant_text", createdAt: i, text: "test" })
    await send({ type: "subscribe", id: "chat", topic: { type: "chat", chatId: chat.id } })
    const starts: number[] = []
    const original = store.getClientTranscript.bind(store)
    store.getClientTranscript = (id, start = 0) => { starts.push(start); return original(id, start) }
    await store.appendMessage(chat.id, { _id: "20", kind: "assistant_text", createdAt: 20, text: "test" })
    await router.broadcastSnapshots()
    expect(starts).toEqual([20])
    const appended = sent.at(-1)!.snapshot!.data
    expect(appended.messages.map(entry => entry._id)).toEqual(["20"])
    expect(appended.incremental).toBe(true)
    expect(data.chatEntrySpans?.get("chat")).toEqual({ start: 15, end: 21 })
    await send({ type: "command", id: "anchor", command: { type: "chat.setReadAnchor", chatId: chat.id, messageId: "20", atEnd: true } })
    for (let i = 21; i < 120; i++) await store.appendMessage(chat.id, { _id: `${i}`, kind: "assistant_text", createdAt: i, text: "test" })
    await router.broadcastSnapshots()
    const rolled = sent.at(-1)!.snapshot!.data
    expect(rolled.startIndex).toBe(110)
    expect(rolled.messages).toHaveLength(10)
    expect(rolled.incremental).not.toBe(true)
    await send({ type: "command", id: "older", command: { type: "chat.loadOlder", chatId: chat.id, all: true } })
    for (let i = 120; i < 220; i++) await store.appendMessage(chat.id, { _id: `${i}`, kind: "assistant_text", createdAt: i, text: "test" })
    await router.broadcastSnapshots()
    expect(data.chatWindowStarts?.get("chat")).toBe(0)
    await send({ type: "unsubscribe", id: "chat" })
    for (const value of Object.values(data)) if (value instanceof Map) expect(value.size).toBe(0)
  } finally {
    router.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})
