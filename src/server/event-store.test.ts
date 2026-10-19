import { ExitPlanModeMessage } from "../client/components/messages/ExitPlanModeMessage"
import { renderToStaticMarkup } from "react-dom/server"
import { createElement } from "react"
import { TranscriptPayloadIndex } from "./transcript-payloads"
import { processTranscriptMessages } from "../client/lib/parseTranscript"
import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rename, rm, writeFile, readdir } from "node:fs/promises"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import type { TranscriptEntry } from "../shared/types"
import type { SnapshotFile } from "./events"
import { EventStore } from "./event-store"
import { deriveLocalProjectsSnapshot, SIDEBAR_ACTIVITY_RESOLUTION_MS } from "./read-models"

const originalRuntimeProfile = process.env.KANNA_RUNTIME_PROFILE
const tempDirs: string[] = []

afterEach(async () => {
  if (originalRuntimeProfile === undefined) {
    delete process.env.KANNA_RUNTIME_PROFILE
  } else {
    process.env.KANNA_RUNTIME_PROFILE = originalRuntimeProfile
  }

  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function createTempDataDir() {
  const dir = await mkdtemp(join(tmpdir(), "kanna-event-store-"))
  tempDirs.push(dir)
  return dir
}

function entry(
  kind: "user_prompt" | "assistant_text" | "result",
  createdAt: number,
  extra: Record<string, unknown> = {},
): TranscriptEntry {
  const base = { _id: `${kind}-${createdAt}`, createdAt }
  if (kind === "user_prompt") {
    return { ...base, kind, content: String(extra.content ?? "") }
  }
  if (kind === "result") {
    return {
      ...base,
      kind,
      subtype: "success",
      isError: false,
      durationMs: Number(extra.durationMs ?? 0),
      result: String(extra.result ?? ""),
    }
  }
  return { ...base, kind, text: String(extra.content ?? extra.text ?? "") }
}

describe("EventStore", () => {
  test("reconciles transcripts using payload sidecars and provider activity timestamps", async () => {
    const dataDir = await createTempDataDir()
    const store = new EventStore(dataDir)
    await store.initialize()
    const project = await store.openProject(dataDir, "Project")
    const chat = await store.createChat(project.id)
    const original: TranscriptEntry = { _id: "result-1", createdAt: 300, kind: "tool_result", toolId: "call-1", content: "old output" }
    await store.appendMessage(chat.id, original)
    // Warm the old payload index: the replacement must invalidate it.
    expect(store.getMessages(chat.id)[0]).toMatchObject({ content: "old output" })
    const entries: TranscriptEntry[] = [
      { _id: "call-1", createdAt: 100, kind: "tool_call", tool: { kind: "tool", toolKind: "write_file", toolId: "call-1", toolName: "Write", input: { filePath: "output.txt", content: "new body" } } },
      { ...original, createdAt: 200, content: "new output" },
      { _id: "assistant-1", createdAt: 150, kind: "assistant_text", text: "Provider reply" },
      { _id: "status-1", createdAt: 500, kind: "status", status: "Imported status" },
    ]
    const replaced: string[] = []
    store.onTranscriptReplaced = chatId => { replaced.push(chatId) }
    await store.replaceTranscript(chat.id, entries)
    expect(replaced).toEqual([chat.id])
    const headers = (await readFile(store.getTranscriptPath(chat.id), "utf8")).trim().split("\n").map(line => JSON.parse(line))
    expect(headers[0].tool.input.content).toBeUndefined()
    expect(headers[1].content).toBeUndefined()
    expect(store.getMessages(chat.id)).toEqual(entries)
    expect(store.getChat(chat.id)?.lastAgentMessageAt).toBe(200)
    expect(store.getChat(chat.id)?.lastAgentMessagePreviewAt).toBe(150)
    const replayed = new EventStore(dataDir)
    await replayed.initialize()
    expect(replayed.getMessages(chat.id)).toEqual(entries)
    expect(replayed.getChat(chat.id)?.lastAgentMessageAt).toBe(200)
  })

  

  test.each([false, true])("publishes a committed transcript replacement when metadata append fails (empty=%s)", async (empty) => {
    const dataDir = await createTempDataDir()
    const store = new EventStore(dataDir)
    await store.initialize()
    const project = await store.openProject(dataDir, "Project")
    const chat = await store.createChat(project.id)
    const original: TranscriptEntry[] = [
      { _id: "result-1", createdAt: 300, kind: "tool_result", toolId: "call-1", content: "old output" },
      { _id: "assistant-1", createdAt: 400, kind: "assistant_text", text: "old answer" },
    ]
    for (const message of original) await store.appendMessage(chat.id, message)
    expect(store.getEntriesById(chat.id, ["result-1"])[0]).toMatchObject({ content: "old output" })
    expect(store.getMessages(chat.id)).toEqual(original)
    const replacement: TranscriptEntry[] = empty ? [] : [
      { ...original[0]!, createdAt: 200, content: "new output" } as TranscriptEntry,
      { _id: "assistant-2", createdAt: 150, kind: "assistant_text", text: "new answer" },
    ]
    const notifications: string[] = []
    store.onTranscriptReplaced = id => { notifications.push(id) }
    // Only the metadata journal write fails; transcript/payload writes remain writable.
    const journal = join(dataDir, "chats.jsonl")
    const heldJournal = join(dataDir, "chats-held.jsonl")
    await rename(journal, heldJournal)
    await mkdir(journal)
    try {
      await expect(store.replaceTranscript(chat.id, replacement)).rejects.toThrow()
      const text = await readFile(store.getTranscriptPath(chat.id), "utf8")
      const headers = text.trim() ? text.trim().split("\n").map(line => JSON.parse(line)) : []
      expect(headers.map(header => header._id)).toEqual(replacement.map(message => message._id))
      if (!empty) expect(headers[0].content).toBeUndefined()
      expect(store.getMessages(chat.id)).toEqual(replacement)
      expect(store.getEntriesById(chat.id, ["result-1"])).toEqual(empty ? [] : [replacement[0]!])
      expect(store.getTranscriptLength(chat.id)).toBe(replacement.length)
      expect(store.getChat(chat.id)?.hasMessages).toBe(!empty)
      expect(store.getChat(chat.id)?.lastAgentMessagePreview).toBe(empty ? undefined : "new answer")
      expect(store.getChat(chat.id)?.lastAgentMessageAt).toBe(empty ? undefined : 200)
      expect(notifications).toEqual([chat.id])
    } finally {
      await rm(journal, { recursive: true })
      await rename(heldJournal, journal)
    }
    const replayed = new EventStore(dataDir)
    await replayed.initialize()
    expect(replayed.getMessages(chat.id)).toEqual(replacement)
    expect(replayed.getChat(chat.id)?.hasMessages).toBe(!empty)
    // The failed journal write does not poison the serialized write queue.
    await store.replaceTranscript(chat.id, [entry("assistant_text", 500, { text: "later answer" })])
    expect(store.getMessages(chat.id)).toEqual([entry("assistant_text", 500, { text: "later answer" })])
  })

  test("uses the runtime profile for the default data dir", () => {
    process.env.KANNA_RUNTIME_PROFILE = "dev"

    const store = new EventStore()

    expect(store.dataDir).toEndWith("/.kanna-dev/data")
  })

  test("migrates legacy snapshot and messages log transcripts into per-chat files", async () => {
    const dataDir = await createTempDataDir()
    const snapshotPath = join(dataDir, "snapshot.json")
    const messagesLogPath = join(dataDir, "messages.jsonl")
    const chatId = "chat-1"

    const snapshot: SnapshotFile = {
      v: 2,
      generatedAt: 10,
      projects: [{
        id: "project-1",
        localPath: "/tmp/project",
        title: "Project",
        createdAt: 1,
        updatedAt: 5,
      }],
      chats: [{
        id: chatId,
        projectId: "project-1",
        title: "Chat",
        createdAt: 1,
        updatedAt: 5,
        unread: false,
        provider: null,
        planMode: false,
        autoPlan: false,
        sessionToken: null,
        lastTurnOutcome: null,
      }],
      messages: [{
        chatId,
        entries: [
          entry("user_prompt", 100, { content: "hello" }),
        ],
      }],
    }

    await writeFile(snapshotPath, JSON.stringify(snapshot, null, 2), "utf8")
    await writeFile(messagesLogPath, `${JSON.stringify({
      v: 2,
      type: "message_appended",
      timestamp: 101,
      chatId,
      entry: entry("assistant_text", 101, { content: "world" }),
    })}\n`, "utf8")

    const store = new EventStore(dataDir)
    await store.initialize()

    const progress: string[] = []
    const migrated = await store.migrateLegacyTranscripts((message) => {
      progress.push(message)
    })

    expect(migrated).toBe(true)
    expect(progress.some((message) => message.includes("transcript migration detected"))).toBe(true)
    expect(progress.at(-1)).toContain("transcript migration complete")
    expect(store.getMessages(chatId)).toEqual([
      entry("user_prompt", 100, { content: "hello" }),
      entry("assistant_text", 101, { text: "world" }),
    ])

    const migratedSnapshot = JSON.parse(await readFile(snapshotPath, "utf8")) as SnapshotFile
    expect(migratedSnapshot.messages).toBeUndefined()
    expect(await readFile(messagesLogPath, "utf8")).toBe("")
    expect(await readFile(join(dataDir, "transcripts", `${chatId}.jsonl`), "utf8")).toContain('"kind":"assistant_text"')
  })

  test("appends new transcript entries only to the per-chat transcript file", async () => {
    const dataDir = await createTempDataDir()
    const store = new EventStore(dataDir)
    await store.initialize()

    const project = await store.openProject("/tmp/project")
    const chat = await store.createChat(project.id)
    await store.appendMessage(chat.id, entry("user_prompt", 200, { content: "hello" }))
    await store.appendMessage(chat.id, entry("assistant_text", 201, { content: "world" }))
    await store.compact()

    expect(store.getMessages(chat.id)).toEqual([
      entry("user_prompt", 200, { content: "hello" }),
      entry("assistant_text", 201, { text: "world" }),
    ])
    expect(await readFile(join(dataDir, "messages.jsonl"), "utf8")).toBe("")

    const snapshot = JSON.parse(await readFile(join(dataDir, "snapshot.json"), "utf8")) as SnapshotFile
    expect(snapshot.messages).toBeUndefined()
    expect(existsSync(join(dataDir, "transcripts", `${chat.id}.jsonl`))).toBe(true)
  })

  test("getTranscriptPath points at the per-chat transcript file", async () => {
    const dataDir = await createTempDataDir()
    const store = new EventStore(dataDir)
    await store.initialize()

    const project = await store.openProject("/tmp/project")
    const chat = await store.createChat(project.id)
    await store.appendMessage(chat.id, entry("user_prompt", 200, { content: "hello" }))

    expect(store.getTranscriptPath(chat.id)).toBe(join(dataDir, "transcripts", `${chat.id}.jsonl`))
    expect(existsSync(store.getTranscriptPath(chat.id))).toBe(true)
  })

  test("persists queued messages across restart and removes promoted entries", async () => {
    const dataDir = await createTempDataDir()
    const store = new EventStore(dataDir)
    await store.initialize()

    const project = await store.openProject("/tmp/project")
    const chat = await store.createChat(project.id)

    const first = await store.enqueueMessage(chat.id, {
      content: "first queued",
      attachments: [],
      provider: "codex",
      model: "gpt-5.4",
      planMode: false,
      autoPlan: false,
    })
    const second = await store.enqueueMessage(chat.id, {
      content: "second queued",
      attachments: [],
      provider: "claude",
      model: "claude-sonnet-4-6",
      planMode: true,
      autoPlan: false,
    })

    expect(store.getQueuedMessages(chat.id).map((message) => message.content)).toEqual([
      "first queued",
      "second queued",
    ])

    const reloaded = new EventStore(dataDir)
    await reloaded.initialize()
    expect(reloaded.getQueuedMessages(chat.id).map((message) => message.content)).toEqual([
      "first queued",
      "second queued",
    ])

    await reloaded.removeQueuedMessage(chat.id, first.id)
    expect(reloaded.getQueuedMessages(chat.id).map((message) => message.id)).toEqual([second.id])
  })

  test("marks chats unread on completed turns and clears unread when marked read", async () => {
    const dataDir = await createTempDataDir()
    const store = new EventStore(dataDir)
    await store.initialize()

    const project = await store.openProject("/tmp/project")
    const chat = await store.createChat(project.id)

    expect(store.getChat(chat.id)?.unread).toBe(false)

    await store.recordTurnFinished(chat.id)
    expect(store.getChat(chat.id)?.unread).toBe(true)

    await store.setChatReadState(chat.id, false)
    expect(store.getChat(chat.id)?.unread).toBe(false)

    await store.recordTurnFailed(chat.id, "boom")
    expect(store.getChat(chat.id)?.unread).toBe(true)

    await store.recordTurnCancelled(chat.id)
    expect(store.getChat(chat.id)?.unread).toBe(true)

    await store.compact()

    const reloaded = new EventStore(dataDir)
    await reloaded.initialize()
    expect(reloaded.getChat(chat.id)?.unread).toBe(true)
  })

  test("stores and resolves a read anchor across restart", async () => {
    const dataDir = await createTempDataDir()
    const store = new EventStore(dataDir)
    await store.initialize()

    const project = await store.openProject("/tmp/project")
    const chat = await store.createChat(project.id)

    expect(store.getChatReadAnchor(chat.id)).toBeNull()

    await store.appendMessage(chat.id, entry("user_prompt", 200, { content: "hello" }))
    await store.appendMessage(chat.id, entry("assistant_text", 201, { content: "world" }))
    await store.appendMessage(chat.id, entry("assistant_text", 202, { content: "again" }))

    await store.setChatReadAnchor(chat.id, "user_prompt-200", false)

    expect(store.getChatReadAnchor(chat.id)).toEqual({
      messageId: "user_prompt-200",
      atEnd: false,
    })

    const reloaded = new EventStore(dataDir)
    await reloaded.initialize()
    expect(reloaded.getChatReadAnchor(chat.id)).toEqual({
      messageId: "user_prompt-200",
      atEnd: false,
    })
  })

  test("survives compaction", async () => {
    const dataDir = await createTempDataDir()
    const store = new EventStore(dataDir)
    await store.initialize()

    const project = await store.openProject("/tmp/project")
    const chat = await store.createChat(project.id)

    await store.appendMessage(chat.id, entry("user_prompt", 200, { content: "hello" }))
    await store.setChatReadAnchor(chat.id, "user_prompt-200", true)
    await store.appendMessage(chat.id, entry("assistant_text", 201, { content: "world" }))

    await store.compact()

    const reloaded = new EventStore(dataDir)
    await reloaded.initialize()
    expect(reloaded.getChatReadAnchor(chat.id)).toEqual({
      messageId: "user_prompt-200",
      atEnd: true,
    })
  })

  test("resolves a read anchor to null when the anchored message is gone", async () => {
    const dataDir = await createTempDataDir()
    const store = new EventStore(dataDir)
    await store.initialize()

    const project = await store.openProject("/tmp/project")
    const chat = await store.createChat(project.id)

    await store.appendMessage(chat.id, entry("user_prompt", 200, { content: "hello" }))
    await store.setChatReadAnchor(chat.id, "missing-entry", false)

    expect(store.getChat(chat.id)?.readAnchor?.messageId).toBe("missing-entry")
    expect(store.getChatReadAnchor(chat.id)).toBeNull()
  })

  test("skips redundant read anchor writes", async () => {
    const dataDir = await createTempDataDir()
    const store = new EventStore(dataDir)
    await store.initialize()

    const project = await store.openProject("/tmp/project")
    const chat = await store.createChat(project.id)
    await store.appendMessage(chat.id, entry("user_prompt", 200, { content: "hello" }))

    const chatsLogPath = join(dataDir, "chats.jsonl")
    const countAnchorEvents = async () => {
      const contents = await readFile(chatsLogPath, "utf8")
      return contents.split("\n").filter((line) => line.includes("chat_read_anchor_set")).length
    }

    await store.setChatReadAnchor(chat.id, "user_prompt-200", false)
    expect(await countAnchorEvents()).toBe(1)

    // Same anchor + same atEnd -> no second event.
    await store.setChatReadAnchor(chat.id, "user_prompt-200", false)
    expect(await countAnchorEvents()).toBe(1)

    // Flipping atEnd alone is still a real change.
    await store.setChatReadAnchor(chat.id, "user_prompt-200", true)
    expect(await countAnchorEvents()).toBe(2)
  })

  test("preserves read state after a finished turn across restart", async () => {
    const dataDir = await createTempDataDir()
    const store = new EventStore(dataDir)
    await store.initialize()

    const project = await store.openProject("/tmp/project")
    const chat = await store.createChat(project.id)

    await store.recordTurnFinished(chat.id)
    await store.setChatReadState(chat.id, false)

    expect(store.getChat(chat.id)?.unread).toBe(false)

    const reloaded = new EventStore(dataDir)
    await reloaded.initialize()

    expect(reloaded.getChat(chat.id)?.unread).toBe(false)
  })

  test("preserves read state after a failed turn across restart", async () => {
    const dataDir = await createTempDataDir()
    const store = new EventStore(dataDir)
    await store.initialize()

    const project = await store.openProject("/tmp/project")
    const chat = await store.createChat(project.id)

    await store.recordTurnFailed(chat.id, "boom")
    await store.setChatReadState(chat.id, false)

    expect(store.getChat(chat.id)?.unread).toBe(false)

    const reloaded = new EventStore(dataDir)
    await reloaded.initialize()

    expect(reloaded.getChat(chat.id)?.unread).toBe(false)
  })

  test("prefers mark-read over turn completion when replay timestamps tie", async () => {
    const dataDir = await createTempDataDir()
    const chatsLogPath = join(dataDir, "chats.jsonl")
    const turnsLogPath = join(dataDir, "turns.jsonl")
    const projectId = "project-1"
    const chatId = "chat-1"
    const timestamp = 100

    await writeFile(chatsLogPath, [
      JSON.stringify({
        v: 2,
        type: "chat_created",
        timestamp,
        chatId,
        projectId,
        title: "Chat",
      }),
      JSON.stringify({
        v: 2,
        type: "chat_read_state_set",
        timestamp,
        chatId,
        unread: false,
      }),
      "",
    ].join("\n"), "utf8")
    await writeFile(turnsLogPath, [
      JSON.stringify({
        v: 2,
        type: "turn_finished",
        timestamp,
        chatId,
      }),
      "",
    ].join("\n"), "utf8")

    const store = new EventStore(dataDir)
    await store.initialize()

    expect(store.getChat(chatId)?.unread).toBe(false)
  })

  test("loads chats without unread from older snapshots as read", async () => {
    const dataDir = await createTempDataDir()
    const snapshotPath = join(dataDir, "snapshot.json")

    const snapshot = {
      v: 2,
      generatedAt: 10,
      projects: [{
        id: "project-1",
        localPath: "/tmp/project",
        title: "Project",
        createdAt: 1,
        updatedAt: 5,
      }],
      chats: [{
        id: "chat-1",
        projectId: "project-1",
        title: "Chat",
        createdAt: 1,
        updatedAt: 5,
        provider: null,
        planMode: false,
        autoPlan: false,
        sessionToken: null,
        lastTurnOutcome: null,
      }],
    }

    await writeFile(snapshotPath, JSON.stringify(snapshot, null, 2), "utf8")

    const store = new EventStore(dataDir)
    await store.initialize()

    expect(store.getChat("chat-1")?.unread).toBe(false)
  })

  test("persists sidebar project order across restart and compaction", async () => {
    const dataDir = await createTempDataDir()
    const store = new EventStore(dataDir)
    await store.initialize()

    const first = await store.openProject("/tmp/project-a")
    const second = await store.openProject("/tmp/project-b")

    await store.setSidebarProjectOrder([second.id, first.id])
    expect(store.getSidebarProjectOrder()).toEqual([second.id, first.id])
    expect(JSON.parse(await readFile(join(dataDir, "sidebar-order.json"), "utf8"))).toEqual([second.id, first.id])

    await store.compact()

    const snapshot = JSON.parse(await readFile(join(dataDir, "snapshot.json"), "utf8")) as SnapshotFile
    expect(snapshot.sidebarProjectOrder).toBeUndefined()

    const reloaded = new EventStore(dataDir)
    await reloaded.initialize()
    expect(reloaded.getSidebarProjectOrder()).toEqual([second.id, first.id])
  })

  test("renames a project sidebar title without changing project metadata or local path", async () => {
    const dataDir = await createTempDataDir()
    const store = new EventStore(dataDir)
    await store.initialize()

    const project = await store.openProject("/tmp/project")
    await store.renameProjectSidebarTitle(project.id, "Sidebar Name")

    expect(store.getProject(project.id)?.title).toBe("project")
    expect(store.getProject(project.id)?.sidebarTitle).toBe("Sidebar Name")
    expect(store.getProject(project.id)?.localPath).toBe("/tmp/project")
    expect(store.state.projectIdsByPath.get("/tmp/project")).toBe(project.id)

    const reloaded = new EventStore(dataDir)
    await reloaded.initialize()

    expect(reloaded.getProject(project.id)?.title).toBe("project")
    expect(reloaded.getProject(project.id)?.sidebarTitle).toBe("Sidebar Name")
    expect(reloaded.getProject(project.id)?.localPath).toBe("/tmp/project")
    expect(reloaded.state.projectIdsByPath.get("/tmp/project")).toBe(project.id)

    await reloaded.renameProjectSidebarTitle(project.id, "")
    expect(reloaded.getProject(project.id)?.title).toBe("project")
    expect(reloaded.getProject(project.id)?.sidebarTitle).toBeUndefined()
    expect(reloaded.getProject(project.id)?.localPath).toBe("/tmp/project")
  })

  test("migrates legacy sidebar project order from existing snapshots and project logs", async () => {
    const dataDir = await createTempDataDir()
    const snapshotPath = join(dataDir, "snapshot.json")
    const projectsLogPath = join(dataDir, "projects.jsonl")

    const snapshot: SnapshotFile = {
      v: 2,
      generatedAt: 10,
      projects: [
        {
          id: "project-1",
          localPath: "/tmp/project-a",
          title: "Project A",
          createdAt: 1,
          updatedAt: 1,
        },
        {
          id: "project-2",
          localPath: "/tmp/project-b",
          title: "Project B",
          createdAt: 2,
          updatedAt: 2,
        },
      ],
      chats: [],
      sidebarProjectOrder: ["project-1"],
    }

    await writeFile(snapshotPath, JSON.stringify(snapshot, null, 2), "utf8")
    await writeFile(projectsLogPath, [
      JSON.stringify({
        v: 2,
        type: "sidebar_project_order_set",
        timestamp: 20,
        projectIds: ["project-2", "project-1"],
      }),
      "",
    ].join("\n"), "utf8")

    const store = new EventStore(dataDir)
    await store.initialize()

    expect(store.getSidebarProjectOrder()).toEqual(["project-2", "project-1"])
    expect(JSON.parse(await readFile(join(dataDir, "sidebar-order.json"), "utf8"))).toEqual(["project-2", "project-1"])
  })

  test("ignores an invalid sidebar order file without resetting store state", async () => {
    const dataDir = await createTempDataDir()
    await writeFile(join(dataDir, "sidebar-order.json"), "{not-json", "utf8")

    const originalWarn = console.warn
    console.warn = () => {}
    try {
      const store = new EventStore(dataDir)
      await store.initialize()

      const project = await store.openProject("/tmp/project")

      const reloaded = new EventStore(dataDir)
      await reloaded.initialize()

      expect(reloaded.getProject(project.id)?.localPath).toBe("/tmp/project")
      expect(reloaded.getSidebarProjectOrder()).toEqual([])
    } finally {
      console.warn = originalWarn
    }
  })

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  

  test("auto plan defaults to false and survives a replay", async () => {
    const dataDir = await createTempDataDir()
    const store = new EventStore(dataDir)
    await store.initialize()

    const project = await store.openProject("/tmp/project")
    const chat = await store.createChat(project.id)
    // A chat that never saw a chat_auto_plan_set event — i.e. every chat in a
    // log written before Auto Plan existed — reads as Full Access.
    expect(store.requireChat(chat.id).autoPlan).toBe(false)

    await store.setAutoPlan(chat.id, true)
    expect(store.requireChat(chat.id).autoPlan).toBe(true)

    const reloaded = new EventStore(dataDir)
    await reloaded.initialize()
    expect(reloaded.requireChat(chat.id).autoPlan).toBe(true)
  })

  test("forks a chat with copied transcript and pending fork session token", async () => {
    const dataDir = await createTempDataDir()
    const store = new EventStore(dataDir)
    await store.initialize()

    const project = await store.openProject("/tmp/project")
    const source = await store.createChat(project.id)
    await store.setChatProvider(source.id, "claude")
    await store.setPlanMode(source.id, true)
    await store.setAutoPlan(source.id, true)
    await store.setSessionToken(source.id, "session-1")
    await store.appendMessage(source.id, entry("user_prompt", source.createdAt + 1, { content: "analyze this" }))
    await store.appendMessage(source.id, entry("assistant_text", source.createdAt + 2, { text: "done" }))

    const forked = await store.forkChat(source.id)

    expect(forked.id).not.toBe(source.id)
    expect(forked.title).toBe("Fork: New Chat")
    expect(forked.provider).toBe("claude")
    expect(forked.planMode).toBe(true)
    expect(forked.autoPlan).toBe(true)
    expect(forked.sessionToken).toBeNull()
    expect(forked.pendingForkSessionToken).toBe("session-1")
    expect(forked.lastTurnOutcome).toBeNull()
    // The fork inherits the copied conversation's recency, so it shows up in
    // recency-driven sidebar sections instead of reading as an empty draft.
    expect(forked.lastMessageAt).toBe(source.createdAt + 2)
    expect(forked.hasMessages).toBe(true)
    expect(store.getMessages(forked.id)).toEqual(store.getMessages(source.id))
  })

  test("forking mid-turn branches from the last completed turn", async () => {
    const dataDir = await createTempDataDir()
    const store = new EventStore(dataDir)
    await store.initialize()

    const project = await store.openProject("/tmp/project")
    const source = await store.createChat(project.id)
    await store.setChatProvider(source.id, "claude")
    await store.setSessionToken(source.id, "session-1")

    // A turn that finished.
    await store.recordTurnStarted(source.id)
    await store.appendMessage(source.id, entry("user_prompt", 1_000, { content: "analyze this" }))
    await store.appendMessage(source.id, entry("assistant_text", 2_000, { text: "analysis done" }))
    await store.appendMessage(source.id, entry("result", 3_000, { result: "ok", durationMs: 5 }))
    await store.recordTurnFinished(source.id)

    // …and one still running: a prompt and a reply whose tool results haven't landed.
    await store.recordTurnStarted(source.id)
    await store.appendMessage(source.id, entry("user_prompt", 4_000, { content: "now refactor it" }))
    await store.appendMessage(source.id, entry("assistant_text", 5_000, { text: "starting the refactor" }))

    const forked = await store.forkChat(source.id, { atLastCompletedTurn: true })

    // The copy stops at the completed turn's result — the in-flight prompt and
    // its half-written reply stay behind with the source.
    expect(store.getMessages(forked.id)).toEqual(store.getMessages(source.id).slice(0, 3))
    expect(forked.lastMessageAt).toBe(3_000)
    // Previews describe the branch point, not the turn the fork left behind.
    expect(forked.lastUserMessagePreview).toBe("analyze this")
    expect(forked.lastAgentMessagePreview).toBe("analysis done")
    expect(forked.lastAgentMessageAt).toBe(3_000)
    expect(forked.turnCount).toBe(1)
    // The source is untouched: its turn is still running.
    expect(store.getMessages(source.id)).toHaveLength(5)

    const reloaded = new EventStore(dataDir)
    await reloaded.initialize()
    expect(reloaded.getMessages(forked.id)).toHaveLength(3)
  })

  test("refuses a mid-turn fork when no turn has completed yet", async () => {
    const dataDir = await createTempDataDir()
    const store = new EventStore(dataDir)
    await store.initialize()

    const project = await store.openProject("/tmp/project")
    const source = await store.createChat(project.id)
    await store.setChatProvider(source.id, "claude")
    await store.setSessionToken(source.id, "session-1")
    await store.recordTurnStarted(source.id)
    await store.appendMessage(source.id, entry("user_prompt", 1_000, { content: "first ever prompt" }))

    const chatsBefore = store.listChatsByProject(project.id).length
    await expect(store.forkChat(source.id, { atLastCompletedTurn: true })).rejects.toThrow(/no completed turn/)
    // The refusal happens before anything is written — no half-built fork.
    expect(store.listChatsByProject(project.id).length).toBe(chatsBefore)
  })

  test("the resume marker survives a restart and a compaction", async () => {
    const dataDir = await createTempDataDir()
    const store = new EventStore(dataDir)
    await store.initialize()

    const project = await store.openProject("/tmp/project")
    const chat = await store.createChat(project.id)
    await store.recordTurnStarted(chat.id)
    await store.setTurnResumePending(chat.id, true)
    // Shutdown cancels the turn like any other cancel; the marker is what tells
    // the next boot the difference.
    await store.recordTurnCancelled(chat.id)
    expect(store.requireChat(chat.id).resumePending).toBe(true)
    expect(store.requireChat(chat.id).lastTurnOutcome).toBe("cancelled")

    const reloaded = new EventStore(dataDir)
    await reloaded.initialize()
    expect(reloaded.requireChat(chat.id).resumePending).toBe(true)

    // Cleared by the boot that acts on it, and the clear sticks the same way.
    await reloaded.setTurnResumePending(chat.id, false)
    await reloaded.compact()
    expect(reloaded.requireChat(chat.id).resumePending).toBeUndefined()

    const afterCompaction = new EventStore(dataDir)
    await afterCompaction.initialize()
    expect(afterCompaction.requireChat(chat.id).resumePending).toBeUndefined()
  })

  test("lastAgentMessageAt tracks agent entries mid-turn, ignoring user prompts", async () => {
    const dataDir = await createTempDataDir()
    const store = new EventStore(dataDir)
    await store.initialize()

    const project = await store.openProject("/tmp/project")
    const chat = await store.createChat(project.id)
    await store.appendMessage(chat.id, entry("user_prompt", 1_000, { content: "plan this" }))
    // The user's own prompt is not agent activity.
    expect(store.requireChat(chat.id).lastAgentMessageAt).toBeUndefined()

    await store.appendMessage(chat.id, entry("assistant_text", 2_000, { text: "here's the plan" }))
    expect(store.requireChat(chat.id).lastAgentMessageAt).toBe(2_000)

    // No turn ended (the chat is parked waiting on plan approval), so this is
    // the only timestamp that reflects how fresh the chat actually is.
    expect(store.requireChat(chat.id).lastTurnEndedAt).toBeUndefined()
    expect(store.requireChat(chat.id).lastMessageAt).toBe(1_000)

    // A later user prompt doesn't drag the agent timestamp backwards.
    await store.appendMessage(chat.id, entry("user_prompt", 3_000, { content: "go" }))
    expect(store.requireChat(chat.id).lastAgentMessageAt).toBe(2_000)

    // Rebuilt from the transcript on boot, like lastMessageAt.
    const reloaded = new EventStore(dataDir)
    await reloaded.initialize()
    expect(reloaded.requireChat(chat.id).lastAgentMessageAt).toBe(2_000)
  })

  test("a fork inherits the source's touched paths", async () => {
    const dataDir = await createTempDataDir()
    const store = new EventStore(dataDir)
    await store.initialize()

    const project = await store.openProject("/tmp/project")
    const source = await store.createChat(project.id)
    await store.setChatProvider(source.id, "claude")
    await store.setSessionToken(source.id, "session-1")
    await store.appendMessage(source.id, entry("user_prompt", 1_000, { content: "edit files" }))
    await store.recordFilesTouched(source.id, [
      { path: "src/app.ts", baseBlob: "blob-app" },
      { path: "src/util.ts", baseBlob: null },
    ])

    const forked = await store.forkChat(source.id)

    // Same conversation, same claim on the files it changed — the fork belongs
    // in Relevant next to its source, not with an empty touched set. Base blobs
    // come too, so the fork expires with the same commit its source does.
    const inherited = [
      { path: "src/app.ts", baseBlob: "blob-app" },
      { path: "src/util.ts", baseBlob: null },
    ]
    expect(forked.touchedFiles).toEqual(inherited)
    const reloaded = new EventStore(dataDir)
    await reloaded.initialize()
    expect(reloaded.requireChat(forked.id).touchedFiles).toEqual(inherited)
  })

  test("a later turn's base blob replaces an earlier one for the same path", async () => {
    // The path was committed between the two turns, so the newer commit is what
    // the claim must be measured against — otherwise a chat with live work in a
    // file it had previously landed would read as settled.
    const dataDir = await createTempDataDir()
    const store = new EventStore(dataDir)
    await store.initialize()

    const project = await store.openProject("/tmp/project")
    const chat = await store.createChat(project.id)
    await store.recordFilesTouched(chat.id, [{ path: "src/app.ts", baseBlob: "blob-first" }])
    await store.recordFilesTouched(chat.id, [{ path: "src/app.ts", baseBlob: "blob-second" }])

    expect(store.requireChat(chat.id).touchedFiles).toEqual([{ path: "src/app.ts", baseBlob: "blob-second" }])
    const reloaded = new EventStore(dataDir)
    await reloaded.initialize()
    expect(reloaded.requireChat(chat.id).touchedFiles).toEqual([{ path: "src/app.ts", baseBlob: "blob-second" }])
  })

  test("line counts accumulate across turns while the base stays the latest", async () => {
    // Each event carries one turn's numstat, so a chat that keeps editing one
    // file has written the sum of them — while its *position* (the base blob)
    // is only ever the most recent commit it worked from.
    const dataDir = await createTempDataDir()
    const store = new EventStore(dataDir)
    await store.initialize()

    const project = await store.openProject("/tmp/project")
    const chat = await store.createChat(project.id)
    await store.recordFilesTouched(chat.id, [{ path: "src/app.ts", baseBlob: "blob-first", additions: 10, deletions: 2 }])
    await store.recordFilesTouched(chat.id, [{ path: "src/app.ts", baseBlob: "blob-second", additions: 5, deletions: 3 }])

    const expected = [{ path: "src/app.ts", baseBlob: "blob-second", additions: 15, deletions: 5 }]
    expect(store.requireChat(chat.id).touchedFiles).toEqual(expected)
    const reloaded = new EventStore(dataDir)
    await reloaded.initialize()
    expect(reloaded.requireChat(chat.id).touchedFiles).toEqual(expected)
  })

  test("a file with no counts keeps the totals it already had", async () => {
    // The backfill re-records paths to date them, carrying no numstat of its
    // own; dating a claim must not erase how much the chat wrote there.
    const dataDir = await createTempDataDir()
    const store = new EventStore(dataDir)
    await store.initialize()

    const project = await store.openProject("/tmp/project")
    const chat = await store.createChat(project.id)
    await store.recordFilesTouched(chat.id, [{ path: "src/app.ts", additions: 7, deletions: 1 }])
    await store.recordFilesTouched(chat.id, [{ path: "src/app.ts", baseBlob: "dated-later" }])

    expect(store.requireChat(chat.id).touchedFiles)
      .toEqual([{ path: "src/app.ts", baseBlob: "dated-later", additions: 7, deletions: 1 }])
  })

  test("re-recording the same file with the same base writes nothing", async () => {
    const dataDir = await createTempDataDir()
    const store = new EventStore(dataDir)
    await store.initialize()

    const project = await store.openProject("/tmp/project")
    const chat = await store.createChat(project.id)
    await store.recordFilesTouched(chat.id, [{ path: "src/app.ts", baseBlob: "blob-first" }])
    const afterFirst = await Bun.file(join(dataDir, "chats.jsonl")).text()
    await store.recordFilesTouched(chat.id, [{ path: "src/app.ts", baseBlob: "blob-first" }])

    // The common case — a chat iterating on the same handful of files, turn
    // after turn — must not grow the log with a repeat of what it already says.
    expect(await Bun.file(join(dataDir, "chats.jsonl")).text()).toBe(afterFirst)
  })

  test("a fork inherits lastTurnEndedAt, so it keeps the conversation's recency", async () => {
    const dataDir = await createTempDataDir()
    const store = new EventStore(dataDir)
    await store.initialize()

    const project = await store.openProject("/tmp/project")
    const source = await store.createChat(project.id)
    await store.setChatProvider(source.id, "claude")
    await store.setSessionToken(source.id, "session-1")
    await store.appendMessage(source.id, entry("user_prompt", source.createdAt + 1, { content: "edit files" }))
    await store.recordTurnFinished(source.id)
    const sourceTurnEndedAt = store.requireChat(source.id).lastTurnEndedAt
    expect(sourceTurnEndedAt).toBeNumber()

    const forked = await store.forkChat(source.id)
    expect(forked.lastTurnEndedAt).toBe(sourceTurnEndedAt!)
    // A fork has no turn events of its own, so the timestamp has to ride on
    // chat_created to survive a replay of the log.
    const reloaded = new EventStore(dataDir)
    await reloaded.initialize()
    expect(reloaded.requireChat(forked.id).lastTurnEndedAt).toBe(sourceTurnEndedAt!)
    // The fork itself hasn't run a turn — only the timestamp is inherited.
    expect(reloaded.requireChat(forked.id).lastTurnOutcome).toBeNull()
  })

  test("hidden projects stay absent after restart until reopened with their existing chats", async () => {
    const dataDir = await createTempDataDir()
    const store = new EventStore(dataDir)
    await store.initialize()

    const project = await store.openProject("/tmp/project")
    const chat = await store.createChat(project.id)
    const discovered = [{ localPath: project.localPath, title: project.title, modifiedAt: 1 }]
    expect(deriveLocalProjectsSnapshot(store.state, discovered, "Machine").projects).toHaveLength(1)

    await store.removeProject(project.id)
    expect(store.getProject(project.id)).toBeNull()
    expect(deriveLocalProjectsSnapshot(store.state, discovered, "Machine").projects).toEqual([])

    const reloaded = new EventStore(dataDir)
    await reloaded.initialize()
    expect(deriveLocalProjectsSnapshot(reloaded.state, discovered, "Machine").projects).toEqual([])

    const reopened = await reloaded.openProject("/tmp/project")

    expect(reopened.id).toBe(project.id)
    expect(reloaded.listChatsByProject(reopened.id).map((entry) => entry.id)).toEqual([chat.id])
    expect(deriveLocalProjectsSnapshot(reloaded.state, discovered, "Machine").projects).toMatchObject([
      { localPath: project.localPath, source: "saved", chatCount: 1 },
    ])
  })

  test("reopening a removed project preserves its sidebar title", async () => {
    const dataDir = await createTempDataDir()
    const store = new EventStore(dataDir)
    await store.initialize()

    const project = await store.openProject("/tmp/project", "Original Name")
    await store.renameProjectSidebarTitle(project.id, "Sidebar Name")
    await store.removeProject(project.id)

    const reopened = await store.openProject("/tmp/project", "Synced Name")

    expect(reopened.id).toBe(project.id)
    expect(reopened.title).toBe("Synced Name")
    expect(reopened.sidebarTitle).toBe("Sidebar Name")

    const reloaded = new EventStore(dataDir)
    await reloaded.initialize()

    expect(reloaded.getProject(project.id)?.title).toBe("Synced Name")
    expect(reloaded.getProject(project.id)?.sidebarTitle).toBe("Sidebar Name")
  })

  test("archives chats without deleting their transcript", async () => {
    const dataDir = await createTempDataDir()
    const store = new EventStore(dataDir)
    await store.initialize()

    const project = await store.openProject("/tmp/project")
    const chat = await store.createChat(project.id)
    await store.appendMessage(chat.id, entry("user_prompt", chat.createdAt + 1, { content: "keep this" }))

    await store.archiveChat(chat.id)

    expect(store.getChat(chat.id)?.archivedAt).toBeNumber()
    expect(store.listChatsByProject(project.id)).toEqual([])
    expect(store.getMessages(chat.id).map((message) => message.kind)).toEqual(["user_prompt"])

    await store.unarchiveChat(chat.id)

    expect(store.getChat(chat.id)?.archivedAt).toBeUndefined()
    expect(store.listChatsByProject(project.id).map((entry) => entry.id)).toEqual([chat.id])
  })

  test("rehydrates message metadata from transcripts after a restart without compaction", async () => {
    const dataDir = await createTempDataDir()
    const store = new EventStore(dataDir)
    await store.initialize()

    const project = await store.openProject("/tmp/project")
    const chat = await store.createChat(project.id)
    await store.appendMessage(chat.id, entry("user_prompt", 1_000, { content: "  Fix the   login bug  " }))
    await store.appendMessage(chat.id, entry("assistant_text", 2_000, { text: "Done, the fix is in auth.ts" }))

    // No compact() — a restart between compactions must not lose transcript-derived metadata.
    const reloaded = new EventStore(dataDir)
    await reloaded.initialize()

    const reloadedChat = reloaded.getChat(chat.id)
    expect(reloadedChat?.hasMessages).toBe(true)
    expect(reloadedChat?.lastMessageAt).toBe(1_000)
    expect(reloadedChat?.lastUserMessagePreview).toBe("Fix the login bug")
    expect(reloadedChat?.lastAgentMessagePreview).toBe("Done, the fix is in auth.ts")
  })

  describe("lastMessageAt survives a restart", () => {
    /** An assistant entry big enough to push everything before it out of the tail window. */
    function bulkyEntry(createdAt: number) {
      return entry("assistant_text", createdAt, { text: "x".repeat(300 * 1024) })
    }

    test("keeps the prompt's timestamp when the transcript tail no longer holds it", async () => {
      // The failure this fixes: boot re-derives `lastMessageAt` from the last
      // 256 KB of the transcript, so one long agentic turn buries the prompt
      // and the chat comes back with no timestamp — invisible in every
      // recency-driven sidebar section despite a full conversation.
      const dataDir = await createTempDataDir()
      const store = new EventStore(dataDir)
      await store.initialize()

      const project = await store.openProject("/tmp/project")
      const chat = await store.createChat(project.id)
      await store.appendMessage(chat.id, entry("user_prompt", 1_000, { content: "start the big refactor" }))
      await store.appendMessage(chat.id, bulkyEntry(2_000))

      const reloaded = new EventStore(dataDir)
      await reloaded.initialize()

      // The prompt's own timestamp, from the log — not the trailing entry's.
      expect(reloaded.getChat(chat.id)?.lastMessageAt).toBe(1_000)
      expect(reloaded.getChat(chat.id)?.hasMessages).toBe(true)
    })

    test("falls back to the newest transcript entry for chats logged before the stamp existed", async () => {
      // Same shape, but with no logged stamp — every chat that ran before this
      // was recorded. Dating it by its last entry is a turn's length off and
      // still puts it back in the sidebar.
      const dataDir = await createTempDataDir()
      const store = new EventStore(dataDir)
      await store.initialize()
      const project = await store.openProject("/tmp/project")
      const chat = await store.createChat(project.id)

      // Written straight to the transcript, bypassing the store's stamp — a
      // conversation as an older build left it on disk.
      await writeFile(
        join(dataDir, "transcripts", `${chat.id}.jsonl`),
        [entry("user_prompt", 1_000, { content: "buried prompt" }), bulkyEntry(2_000), entry("assistant_text", 3_000, { text: "done" })]
          .map((line) => JSON.stringify(line)).join("\n") + "\n",
        "utf8"
      )

      const reloaded = new EventStore(dataDir)
      await reloaded.initialize()

      expect(reloaded.getChat(chat.id)?.lastMessageAt).toBe(3_000)
      expect(reloaded.getChat(chat.id)?.hasMessages).toBe(true)
    })

    test("the fallback never overrides a prompt the tail still holds", async () => {
      const dataDir = await createTempDataDir()
      const store = new EventStore(dataDir)
      await store.initialize()
      const project = await store.openProject("/tmp/project")
      const chat = await store.createChat(project.id)

      await writeFile(
        join(dataDir, "transcripts", `${chat.id}.jsonl`),
        [entry("user_prompt", 1_000, { content: "hello" }), entry("assistant_text", 2_000, { text: "hi" })]
          .map((line) => JSON.stringify(line)).join("\n") + "\n",
        "utf8"
      )

      const reloaded = new EventStore(dataDir)
      await reloaded.initialize()

      // The agent replied later, but "when you last messaged" is the prompt.
      expect(reloaded.getChat(chat.id)?.lastMessageAt).toBe(1_000)
    })

    test("leaves a chat with no transcript undated", async () => {
      // An empty new chat must stay hidden; the fallback only speaks for chats
      // that actually have entries.
      const dataDir = await createTempDataDir()
      const store = new EventStore(dataDir)
      await store.initialize()
      const project = await store.openProject("/tmp/project")
      const chat = await store.createChat(project.id)

      const reloaded = new EventStore(dataDir)
      await reloaded.initialize()

      expect(reloaded.getChat(chat.id)?.lastMessageAt).toBeUndefined()
    })

    test("stamps once per prompt, never per entry", async () => {
      const dataDir = await createTempDataDir()
      const store = new EventStore(dataDir)
      await store.initialize()
      const project = await store.openProject("/tmp/project")
      const chat = await store.createChat(project.id)

      const countStamps = async () =>
        (await readFile(join(dataDir, "chats.jsonl"), "utf8"))
          .split("\n").filter((line) => line.includes('"chat_last_message_at_set"')).length

      await store.appendMessage(chat.id, entry("user_prompt", 1_000, { content: "one" }))
      expect(await countStamps()).toBe(1)

      // A whole turn's worth of agent output adds nothing to the chat log.
      await store.appendMessage(chat.id, entry("assistant_text", 2_000, { text: "working" }))
      await store.appendMessage(chat.id, entry("assistant_text", 3_000, { text: "still working" }))
      expect(await countStamps()).toBe(1)

      await store.appendMessage(chat.id, entry("user_prompt", 4_000, { content: "two" }))
      expect(await countStamps()).toBe(2)

      // An older prompt still invalidates history integrity without moving recency.
      await store.appendMessage(chat.id, entry("user_prompt", 500, { content: "out of order" }))
      expect(await countStamps()).toBe(3)
      expect(store.getChat(chat.id)?.lastMessageAt).toBe(4_000)
    })

    test("a fork keeps its inherited recency across a restart", async () => {
      const dataDir = await createTempDataDir()
      const store = new EventStore(dataDir)
      await store.initialize()

      const project = await store.openProject("/tmp/project")
      const source = await store.createChat(project.id)
      await store.setChatProvider(source.id, "claude")
      await store.setSessionToken(source.id, "session-1")
      await store.appendMessage(source.id, entry("user_prompt", 1_000, { content: "do the thing" }))
      await store.appendMessage(source.id, entry("assistant_text", 2_000, { text: "done" }))

      const forked = await store.forkChat(source.id)
      expect(forked.lastMessageAt).toBe(2_000)

      const reloaded = new EventStore(dataDir)
      await reloaded.initialize()
      expect(reloaded.getChat(forked.id)?.lastMessageAt).toBe(2_000)
    })
  })

  test("counts turns, and survives the replay that would double-count them", async () => {
    // The hazard this guards: the count accumulates, so it lives on the *store*
    // event rather than in `applyMessageMetadata`, which boot re-runs over each
    // transcript tail on top of an already-loaded snapshot. Put it there and a
    // restart inflates every chat.
    const dataDir = await createTempDataDir()
    const store = new EventStore(dataDir)
    await store.initialize()

    const project = await store.openProject("/tmp/project")
    const chat = await store.createChat(project.id)
    expect(store.getChat(chat.id)?.turnCount).toBeUndefined()

    await store.recordTurnStarted(chat.id)
    await store.appendMessage(chat.id, entry("user_prompt", 1_000, { content: "first" }))
    await store.recordTurnStarted(chat.id)
    await store.appendMessage(chat.id, entry("user_prompt", 2_000, { content: "second" }))

    expect(store.getChat(chat.id)?.turnCount).toBe(2)

    const reloaded = new EventStore(dataDir)
    await reloaded.initialize()

    expect(reloaded.getChat(chat.id)?.turnCount).toBe(2)
  })

  test("a fork inherits the turns behind the conversation it copied", async () => {
    const dataDir = await createTempDataDir()
    const store = new EventStore(dataDir)
    await store.initialize()

    const project = await store.openProject("/tmp/project")
    const source = await store.createChat(project.id)
    await store.setChatProvider(source.id, "claude")
    await store.setSessionToken(source.id, "session-1")
    await store.recordTurnStarted(source.id)
    await store.appendMessage(source.id, entry("user_prompt", 1_000, { content: "first" }))
    await store.recordTurnStarted(source.id)

    const fork = await store.forkChat(source.id)

    // Starting from zero would read as a fresh chat, which a fork of a
    // two-turn conversation is not.
    expect(store.getChat(fork.id)?.turnCount).toBe(2)
  })

  test("strips markdown while the message still has lines to strip it by", async () => {
    // Headings, list markers and quotes are anchored to the start of a line,
    // and this is the last place the lines exist — the preview is one string
    // by the time the client sees it. Getting this wrong shows up as `##` and
    // `- ` stranded mid-sentence in the sidebar's hover card.
    const dataDir = await createTempDataDir()
    const store = new EventStore(dataDir)
    await store.initialize()

    const project = await store.openProject("/tmp/project")
    const chat = await store.createChat(project.id)
    await store.appendMessage(chat.id, entry("user_prompt", 1_000, {
      content: "## Plan\n\n- rewrite the **router**\n- drop `parseTranscript`\n\n> and ship it",
    }))

    expect(store.getChat(chat.id)?.lastUserMessagePreview)
      .toBe("Plan rewrite the router drop parseTranscript and ship it")
  })

  test("advances each preview independently, so a new prompt keeps the old reply", async () => {
    const dataDir = await createTempDataDir()
    const store = new EventStore(dataDir)
    await store.initialize()

    const project = await store.openProject("/tmp/project")
    const chat = await store.createChat(project.id)
    await store.appendMessage(chat.id, entry("user_prompt", 1_000, { content: "first ask" }))
    await store.appendMessage(chat.id, entry("assistant_text", 2_000, { text: "first answer" }))
    await store.appendMessage(chat.id, entry("user_prompt", 3_000, { content: "second ask" }))

    const updated = store.getChat(chat.id)

    // The card uses the timestamps to notice the reply belongs to the previous
    // turn and hides it; the store's job is only to keep them apart.
    expect(updated?.lastUserMessagePreview).toBe("second ask")
    expect(updated?.lastAgentMessagePreview).toBe("first answer")
    expect(updated?.lastAgentMessagePreviewAt).toBe(2_000)
  })

  test("marks chats done until a new turn starts, surviving reads and reloads", async () => {
    const dataDir = await createTempDataDir()
    const store = new EventStore(dataDir)
    await store.initialize()

    const project = await store.openProject("/tmp/project")
    const chat = await store.createChat(project.id)

    await store.recordTurnFinished(chat.id)
    await store.setChatDoneState(chat.id, true)
    expect(store.getChat(chat.id)?.doneAt).toBeNumber()

    // Reading only clears unread; done state is untouched.
    await store.setChatReadState(chat.id, false)
    expect(store.getChat(chat.id)?.unread).toBe(false)
    expect(store.getChat(chat.id)?.doneAt).toBeNumber()

    const reloaded = new EventStore(dataDir)
    await reloaded.initialize()
    expect(reloaded.getChat(chat.id)?.doneAt).toBeNumber()

    // A new turn means the user re-engaged, clearing the done state.
    await reloaded.recordTurnStarted(chat.id)
    expect(reloaded.getChat(chat.id)?.doneAt).toBeUndefined()

    await reloaded.setChatDoneState(chat.id, true)
    await reloaded.setChatDoneState(chat.id, false)
    expect(reloaded.getChat(chat.id)?.doneAt).toBeUndefined()
  })

  test("hides deleted provider chats in the compacted snapshot so they stay hidden after restart", async () => {
    const dataDir = await createTempDataDir()
    const store = new EventStore(dataDir)
    await store.initialize()

    const project = await store.openProject("/tmp/project")
    const chat = await store.createChat(project.id)
    await store.setChatProvider(chat.id, "claude")
    await store.setSessionToken(chat.id, "session-1")
    await store.deleteChat(chat.id)
    expect(store.isProviderSessionHidden("claude", "session-1")).toBe(true)
    await store.compact()

    const snapshot = JSON.parse(await readFile(join(dataDir, "snapshot.json"), "utf8")) as SnapshotFile
    expect(snapshot.chats).toHaveLength(0)
    expect(snapshot.hiddenProviderSessions).toContainEqual({
      provider: "claude",
      sessionToken: "session-1",
      hiddenAt: expect.any(Number),
    })

    const reloaded = new EventStore(dataDir)
    await reloaded.initialize()

    expect(reloaded.getChat(chat.id)).toBeNull()
    expect(reloaded.state.chatsById.get(chat.id)).toBeUndefined()
    expect(reloaded.isProviderSessionHidden("claude", "session-1")).toBe(true)
  })

  test("preserves hidden provider sessions through replay and compaction", async () => {
    const dataDir = await createTempDataDir()
    const store = new EventStore(dataDir)
    await store.initialize()

    await store.hideProviderSession("claude", "session-1")

    expect(store.isProviderSessionHidden("claude", "session-1")).toBe(true)
    expect(store.isProviderSessionHidden("codex", "session-1")).toBe(false)

    const replayed = new EventStore(dataDir)
    await replayed.initialize()
    expect(replayed.isProviderSessionHidden("claude", "session-1")).toBe(true)

    await replayed.compact()

    const snapshot = JSON.parse(await readFile(join(dataDir, "snapshot.json"), "utf8")) as SnapshotFile
    expect(snapshot.hiddenProviderSessions).toContainEqual({
      provider: "claude",
      sessionToken: "session-1",
      hiddenAt: expect.any(Number),
    })

    const compacted = new EventStore(dataDir)
    await compacted.initialize()
    expect(compacted.isProviderSessionHidden("claude", "session-1")).toBe(true)
  })


  test("recovers from replay logs when snapshot is corrupt", async () => {
    const dataDir = await createTempDataDir()
    const snapshotPath = join(dataDir, "snapshot.json")
    const projectsLogPath = join(dataDir, "projects.jsonl")
    const chatsLogPath = join(dataDir, "chats.jsonl")

    await writeFile(snapshotPath, "{not-json", "utf8")
    await writeFile(projectsLogPath, `${JSON.stringify({
      v: 2,
      type: "project_opened",
      timestamp: 1,
      projectId: "project-1",
      localPath: "/tmp/project",
      title: "Project",
    })}\n`, "utf8")
    await writeFile(chatsLogPath, `${JSON.stringify({
      v: 2,
      type: "chat_created",
      timestamp: 2,
      chatId: "chat-1",
      projectId: "project-1",
      title: "Chat",
    })}\n`, "utf8")

    const originalWarn = console.warn
    console.warn = () => {}
    try {
      const store = new EventStore(dataDir)
      await store.initialize()

      expect(store.getProject("project-1")?.title).toBe("Project")
      expect(store.getChat("chat-1")?.title).toBe("Chat")
    } finally {
      console.warn = originalWarn
    }

    const recoveredSnapshot = JSON.parse(await readFile(snapshotPath, "utf8")) as SnapshotFile
    expect(recoveredSnapshot.projects.map((project) => project.id)).toEqual(["project-1"])
    expect(recoveredSnapshot.chats.map((chat) => chat.id)).toEqual(["chat-1"])
    expect(await readFile(projectsLogPath, "utf8")).toBe("")
    expect(await readFile(chatsLogPath, "utf8")).toBe("")
  })


  test("backs up a corrupt snapshot before replaying logs", async () => {
    const dataDir = await createTempDataDir()
    const snapshotPath = join(dataDir, "snapshot.json")
    const projectsLogPath = join(dataDir, "projects.jsonl")

    await writeFile(snapshotPath, "{not-json", "utf8")
    await writeFile(projectsLogPath, `${JSON.stringify({
      v: 2,
      type: "project_opened",
      timestamp: 1,
      projectId: "project-1",
      localPath: "/tmp/project",
      title: "Project",
    })}\n`, "utf8")

    const originalWarn = console.warn
    console.warn = () => {}
    try {
      const store = new EventStore(dataDir)
      await store.initialize()

      const backupFiles = await readdir(join(dataDir, "recovery"))
      const snapshotBackup = backupFiles.find((file) => file.includes("snapshot") && file.endsWith(".json"))
      expect(snapshotBackup).toBeString()
      expect(await readFile(join(dataDir, "recovery", snapshotBackup!), "utf8")).toBe("{not-json")
      expect(store.getStartupRecoveryIncidents()).toContainEqual(expect.objectContaining({
        kind: "snapshot",
        sourcePath: snapshotPath,
        backupPath: join(dataDir, "recovery", snapshotBackup!),
      }))
    } finally {
      console.warn = originalWarn
    }
  })


  test("replaces a corrupt snapshot after recovery even when logs are small", async () => {
    const dataDir = await createTempDataDir()
    const snapshotPath = join(dataDir, "snapshot.json")
    const projectsLogPath = join(dataDir, "projects.jsonl")

    await writeFile(snapshotPath, "{not-json", "utf8")
    await writeFile(projectsLogPath, `${JSON.stringify({
      v: 2,
      type: "project_opened",
      timestamp: 1,
      projectId: "project-1",
      localPath: "/tmp/project",
      title: "Project",
    })}\n`, "utf8")

    const originalWarn = console.warn
    console.warn = () => {}
    try {
      const store = new EventStore(dataDir)
      await store.initialize()

      const recoveredSnapshot = JSON.parse(await readFile(snapshotPath, "utf8")) as SnapshotFile
      expect(recoveredSnapshot.projects.map((project) => project.id)).toEqual(["project-1"])
      expect(await readFile(projectsLogPath, "utf8")).toBe("")

      const reloaded = new EventStore(dataDir)
      await reloaded.initialize()
      expect(reloaded.getStartupRecoveryIncidents()).toEqual([])
      expect(reloaded.getProject("project-1")?.title).toBe("Project")
    } finally {
      console.warn = originalWarn
    }
  })


  test("backs up a log with a corrupt middle line and records a startup incident", async () => {
    const dataDir = await createTempDataDir()
    const projectsLogPath = join(dataDir, "projects.jsonl")

    await writeFile(projectsLogPath, [
      JSON.stringify({
        v: 2,
        type: "project_opened",
        timestamp: 1,
        projectId: "project-1",
        localPath: "/tmp/project",
        title: "Project",
      }),
      "{not-json",
      JSON.stringify({
        v: 2,
        type: "project_opened",
        timestamp: 2,
        projectId: "project-2",
        localPath: "/tmp/project-2",
        title: "Project 2",
      }),
      "",
    ].join("\n"), "utf8")

    const originalWarn = console.warn
    console.warn = () => {}
    try {
      const store = new EventStore(dataDir)
      await store.initialize()

      const backupFiles = await readdir(join(dataDir, "recovery"))
      const logBackup = backupFiles.find((file) => file.includes("projects") && file.endsWith(".jsonl"))
      expect(logBackup).toBeString()
      expect(await readFile(join(dataDir, "recovery", logBackup!), "utf8")).toContain("{not-json")
      expect(store.getProject("project-1")?.title).toBe("Project")
      expect(store.getProject("project-2")?.title).toBe("Project 2")
      expect(store.getStartupRecoveryIncidents()).toContainEqual(expect.objectContaining({
        kind: "log",
        sourcePath: projectsLogPath,
        backupPath: join(dataDir, "recovery", logBackup!),
        line: 2,
      }))
    } finally {
      console.warn = originalWarn
    }
  })


  


  test("records only one startup incident for an incompatible event log", async () => {
    const dataDir = await createTempDataDir()
    const projectsLogPath = join(dataDir, "projects.jsonl")

    await writeFile(projectsLogPath, [
      JSON.stringify({
        v: 1,
        type: "project_opened",
        timestamp: 1,
        projectId: "project-1",
        localPath: "/tmp/project",
        title: "Project",
      }),
      JSON.stringify({
        v: 1,
        type: "project_opened",
        timestamp: 2,
        projectId: "project-2",
        localPath: "/tmp/project-2",
        title: "Project 2",
      }),
      "",
    ].join("\n"), "utf8")

    const originalWarn = console.warn
    console.warn = () => {}
    try {
      const store = new EventStore(dataDir)
      await store.initialize()

      const incidents = store.getStartupRecoveryIncidents()
      expect(incidents).toHaveLength(1)
      expect(incidents[0]).toMatchObject({
        kind: "log",
        sourcePath: projectsLogPath,
        line: 1,
        reason: "incompatible event version 1",
      })
      expect(incidents[0]!.backupPath).toBeString()
      expect(await readFile(incidents[0]!.backupPath!, "utf8")).toContain("project-2")
    } finally {
      console.warn = originalWarn
    }
  })


  test("persists replaced transcript metadata across restart", async () => {
    const dataDir = await createTempDataDir()
    const store = new EventStore(dataDir)
    await store.initialize()

    const project = await store.openProject("/tmp/project")
    const chat = await store.createChat(project.id)
    const first = entry("user_prompt", chat.createdAt + 1, { content: "first" })
    const firstAnswer = entry("assistant_text", chat.createdAt + 2, { text: "first answer" })
    const second = entry("user_prompt", chat.createdAt + 3, { content: "second" })
    const staleAnswer = entry("assistant_text", chat.createdAt + 4, { text: "stale answer" })
    await store.appendMessage(chat.id, first)
    await store.appendMessage(chat.id, firstAnswer)
    await store.appendMessage(chat.id, second)
    await store.appendMessage(chat.id, staleAnswer)
    await store.compact()

    await store.replaceTranscript(chat.id, [first, firstAnswer])

    expect(store.requireChat(chat.id).lastMessageAt).toBe(first.createdAt)
    expect(store.requireChat(chat.id).lastUserMessagePreview).toBe("first")
    expect(store.requireChat(chat.id).lastAgentMessagePreview).toBe("first answer")
    expect(store.requireChat(chat.id).lastAgentMessagePreviewAt).toBe(firstAnswer.createdAt)
    expect(store.requireChat(chat.id).lastAgentMessageAt).toBe(firstAnswer.createdAt)

    const reloaded = new EventStore(dataDir)
    await reloaded.initialize()

    expect(reloaded.requireChat(chat.id).hasMessages).toBe(true)
    expect(reloaded.requireChat(chat.id).lastMessageAt).toBe(first.createdAt)
    expect(reloaded.requireChat(chat.id).lastUserMessagePreview).toBe("first")
    expect(reloaded.requireChat(chat.id).lastAgentMessagePreview).toBe("first answer")
    expect(reloaded.requireChat(chat.id).lastAgentMessagePreviewAt).toBe(firstAnswer.createdAt)
    expect(reloaded.requireChat(chat.id).lastAgentMessageAt).toBe(firstAnswer.createdAt)
  })


  test("clears replaced transcript metadata for an empty transcript across restart", async () => {
    const dataDir = await createTempDataDir()
    const store = new EventStore(dataDir)
    await store.initialize()

    const project = await store.openProject("/tmp/project")
    const chat = await store.createChat(project.id)
    await store.appendMessage(chat.id, entry("user_prompt", chat.createdAt + 1, { content: "stale prompt" }))
    await store.appendMessage(chat.id, entry("assistant_text", chat.createdAt + 2, { text: "stale answer" }))
    await store.compact()

    await store.replaceTranscript(chat.id, [])

    expect(store.requireChat(chat.id)).toMatchObject({ hasMessages: false })
    expect(store.requireChat(chat.id).lastMessageAt).toBeUndefined()
    expect(store.requireChat(chat.id).lastUserMessagePreview).toBeUndefined()
    expect(store.requireChat(chat.id).lastAgentMessagePreview).toBeUndefined()
    expect(store.requireChat(chat.id).lastAgentMessagePreviewAt).toBeUndefined()
    expect(store.requireChat(chat.id).lastAgentMessageAt).toBeUndefined()

    const reloaded = new EventStore(dataDir)
    await reloaded.initialize()

    expect(reloaded.requireChat(chat.id)).toMatchObject({ hasMessages: false })
    expect(reloaded.requireChat(chat.id).lastMessageAt).toBeUndefined()
    expect(reloaded.requireChat(chat.id).lastUserMessagePreview).toBeUndefined()
    expect(reloaded.requireChat(chat.id).lastAgentMessagePreview).toBeUndefined()
    expect(reloaded.requireChat(chat.id).lastAgentMessagePreviewAt).toBeUndefined()
    expect(reloaded.requireChat(chat.id).lastAgentMessageAt).toBeUndefined()
  })


  test("clears the stale agent preview when a replacement has no assistant messages", async () => {
    const dataDir = await createTempDataDir()
    const store = new EventStore(dataDir)
    await store.initialize()

    const project = await store.openProject("/tmp/project")
    const chat = await store.createChat(project.id)
    await store.appendMessage(chat.id, entry("user_prompt", chat.createdAt + 1, { content: "stale prompt" }))
    await store.appendMessage(chat.id, entry("assistant_text", chat.createdAt + 2, { text: "stale answer" }))
    await store.compact()

    const replacement = entry("user_prompt", chat.createdAt + 3, { content: "replacement prompt" })
    await store.replaceTranscript(chat.id, [replacement])

    expect(store.requireChat(chat.id).hasMessages).toBe(true)
    expect(store.requireChat(chat.id).lastMessageAt).toBe(replacement.createdAt)
    expect(store.requireChat(chat.id).lastUserMessagePreview).toBe("replacement prompt")
    expect(store.requireChat(chat.id).lastAgentMessagePreview).toBeUndefined()
    expect(store.requireChat(chat.id).lastAgentMessagePreviewAt).toBeUndefined()
    expect(store.requireChat(chat.id).lastAgentMessageAt).toBeUndefined()

    const reloaded = new EventStore(dataDir)
    await reloaded.initialize()

    expect(reloaded.requireChat(chat.id).hasMessages).toBe(true)
    expect(reloaded.requireChat(chat.id).lastMessageAt).toBe(replacement.createdAt)
    expect(reloaded.requireChat(chat.id).lastUserMessagePreview).toBe("replacement prompt")
    expect(reloaded.requireChat(chat.id).lastAgentMessagePreview).toBeUndefined()
    expect(reloaded.requireChat(chat.id).lastAgentMessagePreviewAt).toBeUndefined()
    expect(reloaded.requireChat(chat.id).lastAgentMessageAt).toBeUndefined()
  })


  test("persists exact replacement metadata when the transcript tail exceeds 256 KiB", async () => {
    const dataDir = await createTempDataDir()
    const store = new EventStore(dataDir)
    await store.initialize()

    const project = await store.openProject("/tmp/project")
    const chat = await store.createChat(project.id)
    const prompt = entry("user_prompt", chat.createdAt + 1, { content: "large transcript prompt" })
    const longAnswer = "A".repeat(300 * 1024)
    const answer = entry("assistant_text", chat.createdAt + 2, { text: longAnswer })

    await store.replaceTranscript(chat.id, [prompt, answer])

    const reloaded = new EventStore(dataDir)
    await reloaded.initialize()

    expect(reloaded.requireChat(chat.id).hasMessages).toBe(true)
    expect(reloaded.requireChat(chat.id).lastMessageAt).toBe(prompt.createdAt)
    expect(reloaded.requireChat(chat.id).lastUserMessagePreview).toBe("large transcript prompt")
    expect(reloaded.requireChat(chat.id).lastAgentMessagePreview).toBe(`${"A".repeat(160)}…`)
  })


  test("forks a chat with a selected transcript prefix", async () => {
    const dataDir = await createTempDataDir()
    const store = new EventStore(dataDir)
    await store.initialize()

    const project = await store.openProject("/tmp/project")
    const source = await store.createChat(project.id, { title: "Debug Session" })
    await store.setChatProvider(source.id, "codex")
    await store.setSessionToken(source.id, "thread-1")
    const first = entry("user_prompt", source.createdAt + 1, { content: "first" })
    const second = entry("assistant_text", source.createdAt + 2, { text: "done" })
    const third = entry("user_prompt", source.createdAt + 3, { content: "second" })
    await store.appendMessage(source.id, first)
    await store.appendMessage(source.id, second)
    await store.appendMessage(source.id, third)

    const forked = await store.forkChat(source.id, {
      transcriptEntries: [first, second],
      pendingForkSessionToken: null,
      pendingForkResumeAt: "assistant-msg-1",
    })

    expect(forked.id).not.toBe(source.id)
    expect(forked.title).toBe("Fork: Debug Session")
    expect(forked.provider).toBe("codex")
    expect(forked.sessionToken).toBeNull()
    expect(forked.pendingForkSessionToken).toBeNull()
    expect(forked.pendingForkResumeAt).toBe("assistant-msg-1")
    expect(store.getMessages(forked.id)).toEqual([first, second])

    const reloaded = new EventStore(dataDir)
    await reloaded.initialize()
    expect(reloaded.requireChat(forked.id).pendingForkResumeAt).toBe("assistant-msg-1")
  })


  test("persists a pending fork user prompt marker across reloads", async () => {
    const dataDir = await createTempDataDir()
    const store = new EventStore(dataDir)
    await store.initialize()

    const project = await store.openProject("/tmp/project")
    const source = await store.createChat(project.id, { title: "Claude Debug" })
    await store.setChatProvider(source.id, "claude")
    await store.setSessionToken(source.id, "session-1")
    const prompt = entry("user_prompt", source.createdAt + 1, { content: "first" })
    await store.appendMessage(source.id, prompt)

    const forked = await store.forkChat(source.id, {
      transcriptEntries: [prompt],
      pendingForkSessionToken: null,
      pendingForkUserPrompt: true,
    })

    expect(forked.pendingForkUserPrompt).toBe(true)

    const reloaded = new EventStore(dataDir)
    await reloaded.initialize()
    expect(reloaded.requireChat(forked.id).pendingForkUserPrompt).toBe(true)
  })


  test("persists chat model settings across reloads and copies them to forks", async () => {
    const dataDir = await createTempDataDir()
    const store = new EventStore(dataDir)
    await store.initialize()

    const project = await store.openProject("/tmp/project", "Project")
    const chat = await store.createChat(project.id, { title: "Chat" })
    await store.setChatProvider(chat.id, "claude")
    await store.setPlanMode(chat.id, true)
    await store.setSessionToken(chat.id, "claude-session-1")
    await store.setChatModelSettings(chat.id, {
      model: "claude-opus-4-7",
      modelOptions: { claude: { reasoningEffort: "max", contextWindow: "1m" } },
    })
    await store.compact()

    const cursorChat = await store.createChat(project.id, { title: "Cursor chat" })
    await store.setChatProvider(cursorChat.id, "cursor")
    await store.setSessionToken(cursorChat.id, "cursor-session-1")
    await store.setChatModelSettings(cursorChat.id, {
      model: "composer-2.5",
      modelOptions: { cursor: { fastMode: true } },
    })

    const reloaded = new EventStore(dataDir)
    await reloaded.initialize()
    expect(reloaded.requireChat(chat.id)).toMatchObject({
      model: "claude-opus-4-7",
      modelOptions: { claude: { reasoningEffort: "max", contextWindow: "1m" } },
      planMode: true,
    })
    expect(reloaded.requireChat(cursorChat.id)).toMatchObject({
      provider: "cursor",
      model: "composer-2.5",
      modelOptions: { cursor: { fastMode: true } },
      planMode: false,
    })

    const forked = await reloaded.forkChat(chat.id)
    expect(forked).toMatchObject({
      provider: "claude",
      model: "claude-opus-4-7",
      modelOptions: { claude: { reasoningEffort: "max", contextWindow: "1m" } },
      planMode: true,
    })

    await reloaded.compact()
    const compactedReload = new EventStore(dataDir)
    await compactedReload.initialize()
    expect(compactedReload.requireChat(cursorChat.id).modelOptions).toEqual({
      cursor: { fastMode: true },
    })
  })


  test("resets the turn count when a rewritten transcript starts an edited turn", async () => {
    const dataDir = await createTempDataDir()
    const store = new EventStore(dataDir)
    await store.initialize()

    const project = await store.openProject("/tmp/project")
    const chat = await store.createChat(project.id)
    await store.recordTurnStarted(chat.id)
    await store.recordTurnStarted(chat.id)
    await store.recordTurnStarted(chat.id)

    await store.recordTurnStarted(chat.id, "claude-opus-4-6", { turnCount: 2 })

    expect(store.getChat(chat.id)?.turnCount).toBe(2)

    const reloaded = new EventStore(dataDir)
    await reloaded.initialize()
    expect(reloaded.getChat(chat.id)?.turnCount).toBe(2)
  })


  for (const originalCount of [undefined, 0, 7]) {
    test(`turn count restoration preserves lifecycle metadata and same-millisecond journal order (${originalCount ?? "absent"})`, async () => {
      const dataDir = await createTempDataDir()
      const clock = spyOn(Date, "now").mockReturnValue(Date.now())
      try {
        const store = new EventStore(dataDir)
        await store.initialize()
        const project = await store.openProject("/tmp/project")
        const chat = await store.createChat(project.id)
        await store.recordTurnStarted(chat.id, "edited-model", { turnCount: 1 })
        const beforeRestore = { ...store.requireChat(chat.id) }

        await store.restoreTurnCount(chat.id, originalCount)
        const expected = { ...beforeRestore, turnCount: originalCount }
        if (originalCount === undefined) delete expected.turnCount
        expect(store.requireChat(chat.id)).toEqual(expected)

        const reloaded = new EventStore(dataDir)
        await reloaded.initialize()
        expect(reloaded.requireChat(chat.id)).toEqual(expected)

        await store.recordTurnStarted(chat.id)
        const successorCount = (originalCount ?? 0) + 1
        expect(store.requireChat(chat.id).turnCount).toBe(successorCount)
        const successorReload = new EventStore(dataDir)
        await successorReload.initialize()
        expect(successorReload.requireChat(chat.id).turnCount).toBe(successorCount)

        await store.restoreTurnCount(chat.id, originalCount)
        await store.compact()
        const compacted = new EventStore(dataDir)
        await compacted.initialize()
        expect(compacted.requireChat(chat.id).turnCount).toBe(originalCount)
      } finally { clock.mockRestore() }
    })
  }


  test("stops startup and preserves a corrupt log when its recovery backup fails", async () => {
    const dataDir = await createTempDataDir()
    const projectsLogPath = join(dataDir, "projects.jsonl")

    await writeFile(projectsLogPath, [
      JSON.stringify({
        v: 2,
        type: "project_opened",
        timestamp: 1,
        projectId: "project-1",
        localPath: "/tmp/project",
        title: "Project",
      }),
      "{not-json",
      JSON.stringify({
        v: 2,
        type: "project_opened",
        timestamp: 2,
        projectId: "project-2",
        localPath: "/tmp/project-2",
        title: "Project 2",
      }),
      "",
    ].join("\n"), "utf8")
    await writeFile(join(dataDir, "recovery"), "not-a-directory", "utf8")
    const originalLog = await readFile(projectsLogPath, "utf8")

    const originalWarn = console.warn
    console.warn = () => {}
    try {
      const store = new EventStore(dataDir)
      await expect(store.initialize()).rejects.toThrow("Cannot back up recovery source")

      const incidents = store.getStartupRecoveryIncidents()
      expect(await readFile(projectsLogPath, "utf8")).toBe(originalLog)
      expect(existsSync(join(dataDir, "snapshot.json"))).toBe(false)
      expect(incidents).toHaveLength(1)
      expect(incidents[0]).toMatchObject({
        kind: "log",
        sourcePath: projectsLogPath,
        backupPath: null,
        line: 2,
      })
      expect(incidents[0]!.reason).toContain("backup failed:")
      // Once backup storage is repaired, ordinary recovery can safely proceed.
      await rm(join(dataDir, "recovery"))
      const restarted = new EventStore(dataDir)
      await restarted.initialize()
      expect(restarted.getProject("project-1")?.title).toBe("Project")
      expect(restarted.getProject("project-2")?.title).toBe("Project 2")
      const recoveredIncident = restarted.getStartupRecoveryIncidents()[0]!
      expect(await readFile(recoveredIncident.backupPath!, "utf8")).toBe(originalLog)
    } finally {
      console.warn = originalWarn
    }
  })


  for (const corruption of ["invalid JSON", "incompatible version"] as const) {
    test(`stops startup without overwriting a snapshot with ${corruption} when backup fails`, async () => {
      const dataDir = await createTempDataDir()
      const snapshotPath = join(dataDir, "snapshot.json")
      const originalSnapshot = corruption === "invalid JSON"
        ? "{not-json"
        : JSON.stringify({ v: 1, projects: [], chats: [] })
      await writeFile(snapshotPath, originalSnapshot, "utf8")
      const journals = ["projects.jsonl", "chats.jsonl", "messages.jsonl", "queued-messages.jsonl", "turns.jsonl"]
      for (const journal of journals) await writeFile(join(dataDir, journal), "\n", "utf8")
      await writeFile(join(dataDir, "recovery"), "not-a-directory", "utf8")
      const warn = spyOn(console, "warn").mockImplementation(() => {})
      try {
        const store = new EventStore(dataDir)
        await expect(store.initialize()).rejects.toThrow(snapshotPath)
        expect(await readFile(snapshotPath, "utf8")).toBe(originalSnapshot)
        for (const journal of journals) expect(await readFile(join(dataDir, journal), "utf8")).toBe("\n")
        expect(store.getStartupRecoveryIncidents()).toHaveLength(1)
      } finally {
        warn.mockRestore()
      }
    })
  }


  test("does not swallow failed backup of an incompatible final log event as a truncated trailing line", async () => {
    const dataDir = await createTempDataDir()
    const logPath = join(dataDir, "projects.jsonl")
    const originalLog = `${JSON.stringify({ v: 1, type: "project_opened", timestamp: 1 })}\n`
    await writeFile(logPath, originalLog, "utf8")
    await writeFile(join(dataDir, "recovery"), "not-a-directory", "utf8")
    const warn = spyOn(console, "warn").mockImplementation(() => {})
    try {
      const store = new EventStore(dataDir)
      await expect(store.initialize()).rejects.toThrow(logPath)
      expect(await readFile(logPath, "utf8")).toBe(originalLog)
      expect(existsSync(join(dataDir, "snapshot.json"))).toBe(false)
      expect(store.getStartupRecoveryIncidents()).toHaveLength(1)
    } finally {
      warn.mockRestore()
    }
  })
})

describe("on-demand tool payloads", () => {
  test("returns the requested entries with their payloads, minus debugRaw", async () => {
    const dataDir = await createTempDataDir()
    const store = new EventStore(dataDir)
    await store.initialize()
    const project = await store.openProject(dataDir, "payloads")
    const chat = await store.createChat(project.id)

    await store.appendMessage(chat.id, {
      _id: "call-1",
      createdAt: 1,
      kind: "tool_call",
      debugRaw: "{}",
      tool: { kind: "tool", toolKind: "write_file", toolName: "Write", toolId: "t1", input: { filePath: "a.ts", content: "body" } },
    } as unknown as TranscriptEntry)
    await store.appendMessage(chat.id, {
      _id: "result-1",
      createdAt: 2,
      kind: "tool_result",
      toolId: "t1",
      content: "written",
    } as unknown as TranscriptEntry)

    const found = store.getEntriesById(chat.id, ["call-1", "result-1"])

    expect(found).toHaveLength(2)
    // The payloads the wire dropped are exactly what this exists to return.
    expect((found[0] as unknown as { tool: { input: { content?: string } } }).tool.input.content).toBe("body")
    expect((found[1] as unknown as { content?: unknown }).content).toBe("written")
    expect(found[0]?.debugRaw).toBeUndefined()
  })

  test("silently omits ids that are not in the transcript", async () => {
    const dataDir = await createTempDataDir()
    const store = new EventStore(dataDir)
    await store.initialize()
    const project = await store.openProject(dataDir, "payloads")
    const chat = await store.createChat(project.id)
    await store.appendMessage(chat.id, entry("assistant_text", 1, { text: "hi" }))

    expect(store.getEntriesById(chat.id, ["nope"])).toEqual([])
    expect(store.getEntriesById(chat.id, [])).toEqual([])
  })
})

describe("transcript windows", () => {
  test("sizes the first window by assistant messages, reaching the read anchor, and widens from there", async () => {
    const dataDir = await createTempDataDir()
    const store = new EventStore(dataDir)
    await store.initialize()
    const project = await store.openProject(dataDir, "windows")
    const chat = await store.createChat(project.id)
    // Three turns of prompt + two assistant messages: indexes 0..8.
    for (let turn = 1; turn <= 3; turn += 1) {
      await store.appendMessage(chat.id, { _id: `p${turn}`, createdAt: turn, kind: "user_prompt", content: `q${turn}` } as unknown as TranscriptEntry)
      await store.appendMessage(chat.id, entry("assistant_text", turn * 10 + 1, { text: "one" }))
      await store.appendMessage(chat.id, entry("assistant_text", turn * 10 + 2, { text: "two" }))
    }

    expect(store.getInitialTranscriptWindowStart(chat.id, 2)).toBe(6)
    expect(store.getInitialTranscriptWindowStart(chat.id, 4)).toBe(3)
    expect(store.getInitialTranscriptWindowStart(chat.id, 50)).toBe(0)

    // A stored read position pulls the window back to it.
    await store.setChatReadAnchor(chat.id, "p1", false)
    expect(store.getInitialTranscriptWindowStart(chat.id, 2)).toBe(0)
    await store.setChatReadAnchor(chat.id, "p3", true)
    expect(store.getInitialTranscriptWindowStart(chat.id, 2)).toBe(6)

    expect(store.widenTranscriptWindowStart(chat.id, 6, { assistantMessages: 2 })).toBe(3)
    expect(store.widenTranscriptWindowStart(chat.id, 6, { assistantMessages: 2, untilMessageId: "p1" })).toBe(0)
    // Already inside the window: nothing moves.
    expect(store.widenTranscriptWindowStart(chat.id, 6, { assistantMessages: 2, untilMessageId: "p3" })).toBe(6)
    expect(store.widenTranscriptWindowStart(chat.id, 6, { assistantMessages: 2, all: true })).toBe(0)
    expect(store.widenTranscriptWindowStart(chat.id, 0, { assistantMessages: 2 })).toBe(0)
  })
})

describe("payload sidecar", () => {
  test("appends headers to the transcript and bodies to the sidecar, and merges them back on demand", async () => {
    const dataDir = await createTempDataDir()
    const store = new EventStore(dataDir)
    await store.initialize()
    const project = await store.openProject(dataDir, "sidecar")
    const chat = await store.createChat(project.id)
    const body = "x".repeat(10_000)

    await store.appendMessage(chat.id, {
      _id: "call-1", createdAt: 1, kind: "tool_call",
      tool: { kind: "tool", toolKind: "write_file", toolName: "Write", toolId: "t1", input: { filePath: "a.ts", content: body } },
    } as unknown as TranscriptEntry)
    await store.appendMessage(chat.id, { _id: "result-1", createdAt: 2, kind: "tool_result", toolId: "t1", content: "written" } as unknown as TranscriptEntry)
    await store.appendMessage(chat.id, {
      _id: "call-2", createdAt: 3, kind: "tool_call",
      tool: { kind: "tool", toolKind: "todo_write", toolName: "TodoWrite", toolId: "t2", input: { todos: [] } },
    } as unknown as TranscriptEntry)
    await store.appendMessage(chat.id, { _id: "result-2", createdAt: 4, kind: "tool_result", toolId: "t2", content: { ok: true } } as unknown as TranscriptEntry)

    const transcript = await readFile(store.getTranscriptPath(chat.id), "utf8")
    expect(transcript).not.toContain(body)
    expect(transcript).not.toContain("written")
    // Inline kinds keep their content in the header: there is no row to open.
    expect(transcript).toContain('"content":{"ok":true}')
    const sidecar = await readFile(join(dataDir, "transcripts", `${chat.id}.payloads.jsonl`), "utf8")
    expect(sidecar.split("\n").filter(Boolean)).toHaveLength(2)
    expect(sidecar).toContain(body)

    // The wire sees headers, expansion sees bodies, export sees everything.
    const wire = store.getClientTranscript(chat.id).messages
    expect((wire[0] as unknown as { tool: { input: Record<string, unknown> } }).tool.input).toEqual({ filePath: "a.ts" })
    expect(wire[1]!.trimmed).toBe(true)
    const [call, result] = store.getEntriesById(chat.id, ["call-1", "result-1"])
    expect((call as unknown as { tool: { input: Record<string, unknown> } }).tool.input.content).toBe(body)
    expect(call!.trimmed).toBeUndefined()
    expect((result as unknown as { content: unknown }).content).toBe("written")
    const full = store.getMessages(chat.id)
    expect((full[0] as unknown as { tool: { input: Record<string, unknown> } }).tool.input.content).toBe(body)
    expect((full[1] as unknown as { content: unknown }).content).toBe("written")
    expect((full[3] as unknown as { content: unknown }).content).toEqual({ ok: true })

    // A cold store rebuilds the index from the sidecar alone.
    const reopened = new EventStore(dataDir)
    await reopened.initialize()
    expect((reopened.getEntriesById(chat.id, ["result-1"])[0] as unknown as { content: unknown }).content).toBe("written")

    // A fork carries the bodies with it.
    await reopened.setChatProvider(chat.id, "claude")
    await reopened.setSessionToken(chat.id, "session-1")
    const fork = await reopened.forkChat(chat.id)
    expect((reopened.getMessages(fork.id)[1] as unknown as { content: unknown }).content).toBe("written")
  })

  test("the slim sweep splits a transcript written before the sidecar", async () => {
    const dataDir = await createTempDataDir()
    const store = new EventStore(dataDir)
    await store.initialize()
    const project = await store.openProject(dataDir, "legacy")
    const chat = await store.createChat(project.id)
    const legacy = [
      { _id: "call-1", createdAt: 1, kind: "tool_call", tool: { kind: "tool", toolKind: "bash", toolName: "Bash", toolId: "t1", input: { command: "ls" } } },
      { _id: "result-1", createdAt: 2, kind: "tool_result", toolId: "t1", content: "a\nb\nc", debugRaw: "{}" },
    ]
    await writeFile(store.getTranscriptPath(chat.id), legacy.map((entry) => JSON.stringify(entry)).join("\n") + "\n")

    const stats = await store.slimTranscripts({ force: true })
    expect(stats.rewritten).toBe(1)
    const transcript = await readFile(store.getTranscriptPath(chat.id), "utf8")
    expect(transcript).not.toContain("a\\nb\\nc")
    expect(transcript).not.toContain("debugRaw")
    expect((store.getClientTranscript(chat.id).messages[1] as { trimmed?: true }).trimmed).toBe(true)
    expect((store.getEntriesById(chat.id, ["result-1"])[0] as unknown as { content: unknown }).content).toBe("a\nb\nc")
  })
})

describe("tool result images", () => {
  const PNG_BASE64 = Buffer.from("89504e470d0a1a0a", "hex").toString("base64")

  test("appendMessage stores the bytes on disk and the transcript keeps a URL", async () => {
    const dataDir = await createTempDataDir()
    const store = new EventStore(dataDir)
    await store.initialize()
    const project = await store.openProject(dataDir, "media")
    const chat = await store.createChat(project.id)

    await store.appendMessage(chat.id, {
      _id: "result-1",
      createdAt: 2,
      kind: "tool_result",
      toolId: "t1",
      content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: PNG_BASE64 } }],
    } as unknown as TranscriptEntry)

    const url = `/api/chats/${chat.id}/media/result-1-0.png`
    const onDisk = await readFile(store.getTranscriptPath(chat.id), "utf8")
    expect(onDisk).not.toContain(PNG_BASE64)
    // The result body (now just a URL block) sits in the payload sidecar.
    const sidecar = await readFile(join(dataDir, "transcripts", `${chat.id}.payloads.jsonl`), "utf8")
    expect(sidecar).not.toContain(PNG_BASE64)
    expect(sidecar).toContain(url)
    expect((store.getMessages(chat.id)[0] as unknown as { content: unknown[] }).content).toEqual([
      { type: "image", url, mimeType: "image/png" },
    ])
    const mediaPath = store.resolveTranscriptMediaPath(url)
    expect(mediaPath).toBeString()
    expect(existsSync(mediaPath!)).toBe(true)
    expect(store.resolveTranscriptMediaPath("/api/chats/nope/media/x.png")).toBeNull()

    // `deleteChat` is a soft delete that keeps the transcript, so the media
    // stays with it; both go together in the prune sweeps.
    await store.deleteChat(chat.id)
    expect(existsSync(mediaPath!)).toBe(true)
  })
})

describe("slimTranscripts", () => {
  test("rewrites tool results on disk, drops the cache, and runs once", async () => {
    const dataDir = await createTempDataDir()
    const store = new EventStore(dataDir)
    await store.initialize()
    const project = await store.openProject(dataDir, "slim")
    const chat = await store.createChat(project.id)

    await store.appendMessage(chat.id, {
      _id: "call-1",
      createdAt: 1,
      kind: "tool_call",
      tool: { kind: "tool", toolKind: "exit_plan_mode", toolName: "ExitPlanMode", toolId: "t1", input: { plan: "p" } },
    } as unknown as TranscriptEntry)
    await store.appendMessage(chat.id, {
      _id: "result-1",
      createdAt: 2,
      kind: "tool_result",
      toolId: "t1",
      content: "ok",
      debugRaw: JSON.stringify({ tool_use_result: { approved: true } }),
    } as unknown as TranscriptEntry)
    await store.appendMessage(chat.id, {
      _id: "result-2",
      createdAt: 3,
      kind: "tool_result",
      toolId: "t9",
      content: [{ type: "image", data: Buffer.from("89504e470d0a1a0a", "hex").toString("base64"), mimeType: "image/png" }],
    } as unknown as TranscriptEntry)
    // Warm the cache so the drop after the rewrite is what gets exercised.
    expect(store.getMessages(chat.id)[1]?.debugRaw).toBeString()

    const stats = await store.slimTranscripts()
    expect(stats.rewritten).toBe(1)
    expect(stats.bytesAfter).toBeLessThan(stats.bytesBefore)

    const reread = store.getMessages(chat.id)
    const cached = reread[1] as unknown as { debugRaw?: string; structuredResult?: unknown }
    expect(cached.debugRaw).toBeUndefined()
    expect(cached.structuredResult).toEqual({ approved: true })
    // The image appended above was already externalized at write time, so
    // the sweep leaves it alone; it stays a URL block.
    expect((reread[2] as unknown as { content: Array<{ url?: string }> }).content[0]?.url).toContain("/media/result-2-0.png")

    const onDisk = (await readFile(store.getTranscriptPath(chat.id), "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line))
    expect(onDisk[1]).not.toHaveProperty("debugRaw")
    expect(onDisk[1].structuredResult).toEqual({ approved: true })
    expect(existsSync(join(dataDir, "transcripts-slim.json"))).toBe(true)

    // The marker makes the boot sweep a no-op; `force` repeats it.
    expect((await store.slimTranscripts()).chats).toBe(0)
    expect((await store.slimTranscripts({ force: true })).chats).toBe(1)
  })
})

describe("getClientTranscript window and outline", () => {
  test("clones from the requested index and keeps the outline whole", async () => {
    const dataDir = await createTempDataDir()
    const store = new EventStore(dataDir)
    await store.initialize()
    const project = await store.openProject(join(dataDir, "project"))
    const chat = await store.createChat(project.id)
    const at = Date.now()
    await store.appendMessage(chat.id, { _id: "p1", createdAt: at, kind: "user_prompt", content: "first" } as TranscriptEntry)
    await store.appendMessage(chat.id, { _id: "a1", createdAt: at + 1, kind: "assistant_text", text: "x" } as TranscriptEntry)
    await store.appendMessage(chat.id, { _id: "p2", createdAt: at + 2, kind: "user_prompt", content: "second" } as TranscriptEntry)
    await store.appendMessage(chat.id, { _id: "a2", createdAt: at + 3, kind: "assistant_text", text: "y" } as TranscriptEntry)

    const windowed = store.getClientTranscript(chat.id, 2)
    expect(windowed.startIndex).toBe(2)
    expect(windowed.messages.map((entry) => entry._id)).toEqual(["p2", "a2"])
    expect(windowed.outline.map((entry) => entry.index)).toEqual([0, 2])

    const outlineBefore = windowed.outline
    await store.appendMessage(chat.id, { _id: "a3", createdAt: at + 4, kind: "assistant_text", text: "z" } as TranscriptEntry)
    expect(store.getClientTranscript(chat.id).outline).toBe(outlineBefore)
    await store.appendMessage(chat.id, { _id: "p3", createdAt: at + 5, kind: "user_prompt", content: "third" } as TranscriptEntry)
    expect(store.getClientTranscript(chat.id).outline.map((entry) => entry.id)).toEqual(["p1", "p2", "p3"])
    await rm(dataDir, { recursive: true, force: true })
  })
})


describe("stateVersion", () => {
  /**
   * `stateVersion` is the sidebar memo key in ws-router. A transcript append
   * must bump it only when it moved something the sidebar can actually show,
   * otherwise a streaming turn re-derives and re-serializes the whole sidebar
   * many times a second for bytes that come out identical.
   */
  test("agent entries inside one activity bucket do not bump it", async () => {
    const dataDir = await createTempDataDir()
    const store = new EventStore(dataDir)
    await store.initialize()
    const project = await store.openProject(dataDir, "proj")
    const chat = await store.createChat(project.id)

    const at = Math.floor(Date.now() / SIDEBAR_ACTIVITY_RESOLUTION_MS) * SIDEBAR_ACTIVITY_RESOLUTION_MS
    await store.appendMessage(chat.id, entry("user_prompt", at, { content: "go" }))

    const before = store.stateVersion
    for (let i = 0; i < 20; i++) {
      // This fixture starts at the aligned activity bucket boundary.
      await store.appendMessage(chat.id, entry("assistant_text", at + 100 + i * 20, { text: `step ${i}` }))
    }
    // The first one moves lastAgentMessageAt into a bucket; the rest are free.
    expect(store.stateVersion - before).toBe(1)
  })

  test("still bumps when a sidebar-visible field moves", async () => {
    const dataDir = await createTempDataDir()
    const store = new EventStore(dataDir)
    await store.initialize()
    const project = await store.openProject(dataDir, "proj")
    const chat = await store.createChat(project.id)

    const at = Date.now()
    // hasMessages false -> true, and lastMessageAt is the sidebar sort key.
    const afterFirstPrompt = store.stateVersion
    await store.appendMessage(chat.id, entry("user_prompt", at, { content: "one" }))
    expect(store.stateVersion).toBeGreaterThan(afterFirstPrompt)

    // A later user prompt moves lastMessageAt, so it must bump again.
    const beforeSecond = store.stateVersion
    await store.appendMessage(chat.id, entry("user_prompt", at + 1_000, { content: "two" }))
    expect(store.stateVersion).toBeGreaterThan(beforeSecond)

    // Crossing into the next 15s activity bucket must bump.
    const beforeBucketCross = store.stateVersion
    await store.appendMessage(chat.id, entry("assistant_text", at + 40_000, { text: "much later" }))
    expect(store.stateVersion).toBeGreaterThan(beforeBucketCross)
  })
})


describe("chat pins", () => {
  test("persists pin and unpin through replay and compaction", async () => {
    const dataDir = await createTempDataDir()
    const store = new EventStore(dataDir)
    await store.initialize()
    const project = await store.openProject("/tmp/project")
    const chat = await store.createChat(project.id)
    await store.setChatPinned(chat.id, true)
    const pinnedAt = store.getChat(chat.id)!.pinnedAt
    expect(pinnedAt).toBeNumber()
    await store.setChatPinned(chat.id, true)
    expect(store.getChat(chat.id)!.pinnedAt).toBe(pinnedAt)

    const replayed = new EventStore(dataDir)
    await replayed.initialize()
    expect(replayed.getChat(chat.id)!.pinnedAt).toBe(pinnedAt)
    await replayed.compact()
    const compacted = new EventStore(dataDir)
    await compacted.initialize()
    expect(compacted.getChat(chat.id)!.pinnedAt).toBe(pinnedAt)
    await compacted.setChatPinned(chat.id, false)
    const unpinned = new EventStore(dataDir)
    await unpinned.initialize()
    expect(unpinned.getChat(chat.id)!.pinnedAt).toBeUndefined()
  })

  test("replay preserves repinning after archive within the same millisecond", async () => {
    const dataDir = await createTempDataDir()
    const store = new EventStore(dataDir)
    await store.initialize()
    const project = await store.openProject("/tmp/project")
    const chat = await store.createChat(project.id)
    const timestamp = Date.now()
    const clock = spyOn(Date, "now").mockReturnValue(timestamp)
    try {
      await store.setChatPinned(chat.id, true)
      await store.archiveChat(chat.id)
      await store.unarchiveChat(chat.id)
      await store.setChatPinned(chat.id, true)
    } finally {
      clock.mockRestore()
    }
    const replayed = new EventStore(dataDir)
    await replayed.initialize()
    expect(replayed.getChat(chat.id)!.pinnedAt).toBe(timestamp)
    expect(replayed.getChat(chat.id)!.archivedAt).toBeUndefined()
  })

  

  test("manual archive clears the pin and restore keeps it unpinned", async () => {
    const store = new EventStore(await createTempDataDir())
    await store.initialize()
    const project = await store.openProject("/tmp/project")
    const chat = await store.createChat(project.id)
    await store.setChatPinned(chat.id, true)
    await store.archiveChat(chat.id)
    expect(store.getChat(chat.id)!.pinnedAt).toBeUndefined()
    await store.setChatPinned(chat.id, true)
    expect(store.getChat(chat.id)!.pinnedAt).toBeUndefined()
    await store.unarchiveChat(chat.id)
    expect(store.getChat(chat.id)!.pinnedAt).toBeUndefined()
  })
})


describe("stored Claude plan recovery", () => {
  const planPath = "/missing-project/.claude/plans/review.md"
  function call(id: string, toolKind: "write_file" | "edit_file" | "exit_plan_mode", input: Record<string, unknown>, rawInput?: Record<string, unknown>): TranscriptEntry {
    return {
      _id: id, createdAt: 1, kind: "tool_call",
      tool: { kind: "tool", toolId: id, toolKind, toolName: toolKind, input, rawInput },
    } as TranscriptEntry
  }
  function result(id: string, isError = false): TranscriptEntry {
    return { _id: `${id}-result`, createdAt: 2, kind: "tool_result", toolId: id, isError, content: "done" }
  }
  function plan(entries: TranscriptEntry[], id: string) {
    const found = entries.find((entry) => entry._id === id)
    if (found?.kind !== "tool_call" || found.tool.toolKind !== "exit_plan_mode") throw new Error("missing exit")
    return found.tool.input.plan
  }
  async function setup() {
    const dataDir = await createTempDataDir()
    const store = new EventStore(dataDir)
    await store.initialize()
    const project = await store.openProject(join(dataDir, "project"))
    const chat = await store.createChat(project.id)
    return { dataDir, store, chat }
  }

  test("recovers persisted skinny Write/Edit into the real client plan card across reload", async () => {
    const { dataDir, store, chat } = await setup()
    const sourceExit = call("exit", "exit_plan_mode", { plan: "" })
    for (const entry of [
      call("write", "write_file", { filePath: planPath, content: "## Plan\n\n- First step\n- First step" }), result("write"),
      call("edit", "edit_file", { filePath: planPath, oldString: "First", newString: "Updated" }, { replace_all: true }), result("edit"),
      sourceExit,
    ]) await store.appendMessage(chat.id, entry)
    const expected = "## Plan\n\n- Updated step\n- Updated step"
    const diskBefore = await readFile(store.getTranscriptPath(chat.id), "utf8")
    const sidecarBefore = await readFile(join(dataDir, "transcripts", `${chat.id}.payloads.jsonl`), "utf8")
    expect(diskBefore).not.toContain("First step")
    expect(sidecarBefore).toContain("First step")

    const assertSnapshot = (snapshot: ReturnType<EventStore["getClientTranscript"]>) => {
      expect(plan(snapshot.messages, "exit")).toBe(expected)
      for (const entry of snapshot.messages) {
        if (entry.kind !== "tool_call" || entry.tool.toolKind === "exit_plan_mode") continue
        expect(entry.trimmed).toBe(true)
        expect(entry.tool.input).toEqual({ filePath: planPath })
        expect(entry.tool.rawInput).toBeUndefined()
      }
      const rendered = processTranscriptMessages(snapshot.messages).find((message) => message.kind === "tool" && message.toolId === "exit")
      if (rendered?.kind !== "tool" || rendered.toolKind !== "exit_plan_mode") throw new Error("missing plan message")
      expect(rendered.input.plan).toBe(expected)
      const html = renderToStaticMarkup(createElement(ExitPlanModeMessage, { message: rendered, onConfirm: () => {}, isLatest: true }))
      expect(html).toContain("Updated step")
      expect(html).not.toContain("No plan provided")
    }
    assertSnapshot(store.getClientTranscript(chat.id))
    assertSnapshot(store.getClientTranscript(chat.id, 4))
    expect(plan(store.getEntriesById(chat.id, ["exit"]), "exit")).toBe("")
    expect(sourceExit.kind === "tool_call" && sourceExit.tool.input).toEqual({ plan: "" })
    expect(await readFile(store.getTranscriptPath(chat.id), "utf8")).toBe(diskBefore)
    expect(await readFile(join(dataDir, "transcripts", `${chat.id}.payloads.jsonl`), "utf8")).toBe(sidecarBefore)

    const reloaded = new EventStore(dataDir)
    await reloaded.initialize()
    await reloaded.prepareTranscript(chat.id)
    assertSnapshot(reloaded.getClientTranscript(chat.id, 4))
  })

  test("replacing a warmed transcript through the slim import boundary discards old recovery", async () => {
    const { dataDir, store, chat } = await setup()
    for (const entry of [call("write", "write_file", { filePath: planPath, content: "Old plan" }), result("write"), call("exit", "exit_plan_mode", {})]) {
      await store.appendMessage(chat.id, entry)
    }
    expect(plan(store.getClientTranscript(chat.id).messages, "exit")).toBe("Old plan")
    // Imported full entries are replaced on disk and normalized by the real
    // sweep, which invalidates loaded headers and sidecar offsets.
    const imported = [call("write", "write_file", { filePath: planPath, content: "Imported plan" }), result("write"), call("exit", "exit_plan_mode", {})]
    await writeFile(store.getTranscriptPath(chat.id), imported.map((entry) => JSON.stringify(entry)).join("\n") + "\n")
    expect((await store.slimTranscripts({ force: true })).rewritten).toBe(1)
    expect(plan(store.getClientTranscript(chat.id, 2).messages, "exit")).toBe("Imported plan")
    const reloaded = new EventStore(dataDir)
    await reloaded.initialize()
    expect(plan(reloaded.getClientTranscript(chat.id).messages, "exit")).toBe("Imported plan")
    await writeFile(store.getTranscriptPath(chat.id), JSON.stringify(call("exit", "exit_plan_mode", {})) + "\n")
    // A header-only replacement is picked up by a fresh loaded lifecycle.
    const replaced = new EventStore(dataDir)
    await replaced.initialize()
    expect(plan(replaced.getClientTranscript(chat.id).messages, "exit")).toBeUndefined()
  })

  test("hydrates only successful plan calls once as empty exits stream beyond retained slices", async () => {
    const { store, chat } = await setup()
    const read = spyOn(TranscriptPayloadIndex.prototype, "read")
    const fullRead = spyOn(store, "getMessages")
    try {
      for (const entry of [
        call("ordinary", "write_file", { filePath: "/project/a.md", content: "large unrelated body" }), result("ordinary"),
        call("write", "write_file", { filePath: planPath, content: "First First" }), result("write"),
        call("failed-write", "write_file", { filePath: planPath, content: "Wrong" }), result("failed-write", true),
      ]) {
        await store.appendMessage(chat.id, entry)
        store.getClientTranscript(chat.id)
      }
      expect(read).not.toHaveBeenCalled()
      await store.appendMessage(chat.id, call("exit", "exit_plan_mode", {}))
      const first = store.getClientTranscript(chat.id, 6)
      expect(plan(first.messages, "exit")).toBe("First First")
      for (let i = 0; i < 5; i++) store.getClientTranscript(chat.id, i)
      expect(read.mock.calls.map(([id]) => id)).toEqual(["write"])
      const tailStart = store.getTranscriptLength(chat.id)
      for (const entry of [
        call("failed-edit", "edit_file", { filePath: planPath, oldString: "First", newString: "Wrong" }), result("failed-edit", true),
        call("edit", "edit_file", { filePath: planPath, oldString: "First", newString: "Second" }), result("edit"),
        call("exit-edit", "exit_plan_mode", {}),
      ]) {
        await store.appendMessage(chat.id, entry)
        store.getClientTranscript(chat.id, tailStart)
      }
      const next = store.getClientTranscript(chat.id, tailStart)
      expect(plan(next.messages, "exit-edit")).toBe("Second First")
      expect(plan(first.messages, "exit")).toBe("First First")
      expect(plan(store.getClientTranscript(chat.id).messages, "exit")).toBe("First First")
      expect(read.mock.calls.map(([id]) => id)).toEqual(["write", "edit"])
      expect(fullRead).not.toHaveBeenCalled()
    } finally {
      read.mockRestore()
      fullRead.mockRestore()
    }
  })

  test("preserves explicit plans and consumes latest boundaries across multiple files and exits", async () => {
    const { store, chat } = await setup()
    const otherPath = "/missing-project/.claude/plans/other.md"
    for (const entry of [
      call("write", "write_file", { filePath: planPath, content: "Older older" }), result("write"),
      call("other", "write_file", { filePath: otherPath, content: "Latest" }), result("other"),
      call("unknown-edit", "edit_file", { filePath: "/missing-project/.claude/plans/unknown.md", oldString: "x", newString: "Invented" }), result("unknown-edit"),
      call("mismatch", "edit_file", { filePath: planPath, oldString: "missing", newString: "Invented" }), result("mismatch"),
      call("exit-latest", "exit_plan_mode", {}), call("exit-unrelated", "exit_plan_mode", {}),
      call("edit-older", "edit_file", { filePath: planPath, oldString: "older", newString: "updated" }), result("edit-older"),
      call("exit-explicit", "exit_plan_mode", { plan: "Explicit", allowedPrompts: [] }),
      call("exit-after-explicit", "exit_plan_mode", {}),
      call("edit-again", "edit_file", { filePath: planPath, oldString: "Older", newString: "Revised" }), result("edit-again"),
      call("exit-revised", "exit_plan_mode", {}),
    ]) await store.appendMessage(chat.id, entry)
    const wire = store.getClientTranscript(chat.id).messages
    expect(plan(wire, "exit-latest")).toBe("Latest")
    expect(plan(wire, "exit-unrelated")).toBeUndefined()
    expect(plan(wire, "exit-explicit")).toBe("Explicit")
    expect(wire.find((entry) => entry._id === "exit-explicit")).toMatchObject({ tool: { input: { plan: "Explicit", allowedPrompts: [] } } })
    expect(plan(wire, "exit-after-explicit")).toBeUndefined()
    expect(plan(wire, "exit-revised")).toBe("Revised updated")
  })

  test("leaves honest empty cards when only failed operations or missing/corrupt payloads exist", async () => {
    for (const payloadState of ["failed", "missing", "corrupt"] as const) {
      const { dataDir, store, chat } = await setup()
      for (const entry of [call("write", "write_file", { filePath: planPath, content: "Unavailable" }), result("write", payloadState === "failed"), call("exit", "exit_plan_mode", {})]) {
        await store.appendMessage(chat.id, entry)
      }
      const sidecar = join(dataDir, "transcripts", `${chat.id}.payloads.jsonl`)
      if (payloadState === "missing") await rm(sidecar)
      if (payloadState === "corrupt") await writeFile(sidecar, '{"_id":"write",garbled}\n')
      const wire = store.getClientTranscript(chat.id).messages
      expect(plan(wire, "exit")).toBeUndefined()
      const rendered = processTranscriptMessages(wire).find((message) => message.kind === "tool" && message.toolId === "exit")
      if (rendered?.kind !== "tool" || rendered.toolKind !== "exit_plan_mode") throw new Error("missing plan message")
      expect(renderToStaticMarkup(createElement(ExitPlanModeMessage, { message: rendered, onConfirm: () => {}, isLatest: true }))).toContain("No plan provided")
    }
  })

  test("an explicit-only plan snapshot never reads payloads", async () => {
    const { store, chat } = await setup()
    for (const entry of [call("write", "write_file", { filePath: planPath, content: "Stored" }), result("write"), call("exit", "exit_plan_mode", { plan: "Explicit" })]) {
      await store.appendMessage(chat.id, entry)
    }
    const read = spyOn(TranscriptPayloadIndex.prototype, "read")
    try {
      expect(plan(store.getClientTranscript(chat.id).messages, "exit")).toBe("Explicit")
      expect(read).not.toHaveBeenCalled()
    } finally {
      read.mockRestore()
    }
  })

  test("a lost newer successful payload cannot expose stale plan text", async () => {
    for (const toolKind of ["write_file", "edit_file"] as const) {
      const { dataDir, store, chat } = await setup()
      for (const entry of [call("write", "write_file", { filePath: planPath, content: "Old text" }), result("write"), call("exit-old", "exit_plan_mode", {})]) {
        await store.appendMessage(chat.id, entry)
      }
      expect(plan(store.getClientTranscript(chat.id).messages, "exit-old")).toBe("Old text")
      for (const entry of [
        call("lost", toolKind, toolKind === "write_file"
          ? { filePath: planPath, content: "New text" }
          : { filePath: planPath, oldString: "Old", newString: "New" }),
        result("lost"), call("exit-lost", "exit_plan_mode", {}),
      ]) await store.appendMessage(chat.id, entry)
      const sidecar = join(dataDir, "transcripts", `${chat.id}.payloads.jsonl`)
      const lines = (await readFile(sidecar, "utf8")).split("\n").filter((line) => !line.startsWith('{"_id":"lost",'))
      await writeFile(sidecar, lines.join("\n"))
      const reloaded = new EventStore(dataDir)
      await reloaded.initialize()
      expect(plan(reloaded.getClientTranscript(chat.id).messages, "exit-lost")).toBeUndefined()
      // Losing an edit base also prevents later edits inventing a plan.
      for (const entry of [
        call("later-edit", "edit_file", { filePath: planPath, oldString: "Old", newString: "Invented" }), result("later-edit"), call("exit-after-lost", "exit_plan_mode", {}),
      ]) await reloaded.appendMessage(chat.id, entry)
      expect(plan(reloaded.getClientTranscript(chat.id).messages, "exit-after-lost")).toBeUndefined()
      for (const entry of [call("fresh", "write_file", { filePath: planPath, content: "Fresh text" }), result("fresh"), call("exit-fresh", "exit_plan_mode", {})]) {
        await reloaded.appendMessage(chat.id, entry)
      }
      expect(plan(reloaded.getClientTranscript(chat.id).messages, "exit-fresh")).toBe("Fresh text")
    }
  })

  test("evicts large revision histories and recomputes historical plans and edit bases", async () => {
    const { store, chat } = await setup()
    const paths = [planPath, "/missing-project/.claude/plans/other.md"]
    const expected: string[] = []
    const read = spyOn(TranscriptPayloadIndex.prototype, "read")
    const fullRead = spyOn(store, "getMessages")
    try {
      for (let revision = 0; revision < 6; revision += 1) {
        const content = `Revision ${revision}\n` + "x".repeat(1024 * 1024)
        expected.push(content)
        for (const entry of [
          call(`large-write-${revision}`, "write_file", { filePath: paths[revision % 2], content }),
          result(`large-write-${revision}`), call(`large-exit-${revision}`, "exit_plan_mode", {}),
        ]) await store.appendMessage(chat.id, entry)
        const wire = store.getClientTranscript(chat.id, revision * 3 + 2).messages
        expect(plan(wire, `large-exit-${revision}`)).toBe(content)
        expect(wire).toHaveLength(1)
      }
      // Six distinct 1 MiB versions exceed the 4 MiB recovery budget even
      // though the transcript cache holds only skinny headers. Repeating a
      // historical request must read stored payloads again after eviction.
      const before = read.mock.calls.length
      const history = store.getClientTranscript(chat.id, 2).messages
      expect(read.mock.calls.slice(before).map(([id]) => id)).toEqual(expected.map((_, revision) => `large-write-${revision}`))
      for (let revision = 0; revision < expected.length; revision += 1) {
        expect(plan(history, `large-exit-${revision}`)).toBe(expected[revision])
      }
      const again = read.mock.calls.length
      expect(plan(store.getClientTranscript(chat.id, 17).messages, "large-exit-5")).toBe(expected[5])
      expect(read.mock.calls.length).toBeGreaterThan(again)

      const tailStart = store.getTranscriptLength(chat.id)
      for (const entry of [
        call("late-edit", "edit_file", { filePath: paths[0], oldString: "Revision 4", newString: "Edited fourth" }), result("late-edit"),
        call("late-exit", "exit_plan_mode", {}), call("unrelated-exit", "exit_plan_mode", {}),
      ]) await store.appendMessage(chat.id, entry)
      const tail = store.getClientTranscript(chat.id, tailStart).messages
      expect(plan(tail, "late-exit")).toBe(expected[4]!.replace("Revision 4", "Edited fourth"))
      expect(plan(tail, "unrelated-exit")).toBeUndefined()
      const historicalAfterEdit = store.getClientTranscript(chat.id).messages
      for (let revision = 0; revision < expected.length; revision += 1) {
        expect(plan(historicalAfterEdit, `large-exit-${revision}`)).toBe(expected[revision])
      }
      expect(plan(store.getEntriesById(chat.id, ["large-exit-0"]), "large-exit-0")).toBeUndefined()
      expect(fullRead).not.toHaveBeenCalled()
    } finally {
      read.mockRestore()
      fullRead.mockRestore()
    }
  })

  test("a single oversized plan is transient and ordinary tail pushes do not rehydrate it", async () => {
    const { store, chat } = await setup()
    const content = "Large plan\n" + "x".repeat(3 * 1024 * 1024)
    for (const entry of [call("oversized-write", "write_file", { filePath: planPath, content }), result("oversized-write"), call("oversized-exit", "exit_plan_mode", {})]) {
      await store.appendMessage(chat.id, entry)
    }
    const read = spyOn(TranscriptPayloadIndex.prototype, "read")
    try {
      expect(plan(store.getClientTranscript(chat.id).messages, "oversized-exit")).toBe(content)
      expect(read.mock.calls.map(([id]) => id)).toEqual(["oversized-write"])
      expect(plan(store.getClientTranscript(chat.id, 2).messages, "oversized-exit")).toBe(content)
      expect(read.mock.calls.map(([id]) => id)).toEqual(["oversized-write", "oversized-write"])
      await store.appendMessage(chat.id, entry("assistant_text", 3, { text: "continuing" }))
      const before = read.mock.calls.length
      expect(store.getClientTranscript(chat.id, 3).messages).toEqual([entry("assistant_text", 3, { text: "continuing" })])
      expect(read.mock.calls.length).toBe(before)
      const reloaded = new EventStore(store.dataDir)
      await reloaded.initialize()
      expect(plan(reloaded.getClientTranscript(chat.id, 2).messages, "oversized-exit")).toBe(content)
    } finally {
      read.mockRestore()
    }
  })

  test("accounts for large pending mismatched edit payloads without inventing a plan", async () => {
    const { store, chat } = await setup()
    for (const entry of [
      call("small-write", "write_file", { filePath: planPath, content: "Known plan" }), result("small-write"), call("known-exit", "exit_plan_mode", {}),
      call("large-mismatch", "edit_file", { filePath: planPath, oldString: "missing", newString: "x".repeat(3 * 1024 * 1024) }), result("large-mismatch"),
      call("mismatched-exit", "exit_plan_mode", {}),
    ]) await store.appendMessage(chat.id, entry)
    const read = spyOn(TranscriptPayloadIndex.prototype, "read")
    try {
      const first = store.getClientTranscript(chat.id).messages
      expect(plan(first, "known-exit")).toBe("Known plan")
      expect(plan(first, "mismatched-exit")).toBeUndefined()
      expect(read.mock.calls.map(([id]) => id)).toEqual(["small-write", "large-mismatch"])
      const before = read.mock.calls.length
      const second = store.getClientTranscript(chat.id).messages
      expect(plan(second, "known-exit")).toBe("Known plan")
      expect(plan(second, "mismatched-exit")).toBeUndefined()
      expect(read.mock.calls.slice(before).map(([id]) => id)).toEqual(["small-write", "large-mismatch"])
    } finally {
      read.mockRestore()
    }
  })
})


describe("durable context restoration", () => {
  test("survives log and snapshot reload and rejects a stale acknowledgement", async () => {
    const dataDir = await createTempDataDir()
    const store = new EventStore(dataDir)
    await store.initialize()
    const project = await store.openProject(dataDir, "Project")
    const chat = await store.createChat(project.id)
    const obligation = { id: "restore-a", provider: "codex" as const, fromProvider: "claude" as const, reason: "provider_switch" as const, endExclusive: 2, startInclusive: 1 }
    await store.setContextRestoration(chat.id, obligation)
    const reloaded = new EventStore(dataDir)
    await reloaded.initialize()
    expect(reloaded.requireChat(chat.id).contextRestoration).toEqual(obligation)
    await reloaded.setContextRestoration(chat.id, { ...obligation, id: "restore-b" })
    await reloaded.acknowledgeContextRestoration(chat.id, "restore-a")
    expect(reloaded.requireChat(chat.id).contextRestoration?.id).toBe("restore-b")
    await reloaded.compact()
    const snapshotted = new EventStore(dataDir)
    await snapshotted.initialize()
    expect(snapshotted.requireChat(chat.id).contextRestoration?.id).toBe("restore-b")
    expect(snapshotted.requireChat(chat.id).contextRestoration?.startInclusive).toBe(1)
    await snapshotted.acknowledgeContextRestoration(chat.id, "restore-b")
    expect(snapshotted.requireChat(chat.id).contextRestoration).toBeNull()
  })

  test("header context bounds begin after the most recent explicit clear", async () => {
    const dataDir = await createTempDataDir()
    const store = new EventStore(dataDir)
    await store.initialize()
    const project = await store.openProject(dataDir, "Project")
    const chat = await store.createChat(project.id)
    await store.appendMessage(chat.id, entry("user_prompt", 1, { content: "old" }))
    await store.appendMessage(chat.id, { _id: "clear", createdAt: 2, kind: "context_cleared" })
    await store.appendMessage(chat.id, entry("assistant_text", 3, { text: "new epoch" }))
    store.getMessages = () => { throw new Error("header probe loaded payload") }
    expect(store.getContextBounds(chat.id)).toEqual({ start: 2, endExclusive: 3, hasConversation: true })
  })
})


  test("a mid-turn fork inherits pending restoration restricted to its completed prefix", async () => {
  const dataDir = await createTempDataDir()
  const store = new EventStore(dataDir)
  await store.initialize()
  const project = await store.openProject(dataDir, "Project")
  const source = await store.createChat(project.id)
  await store.setChatProvider(source.id, "codex")
  await store.setSessionToken(source.id, "partially-restored-native")
  const prefix = [entry("user_prompt", 1, { content: "allowed" }), entry("assistant_text", 2, { text: "allowed answer" }), entry("result", 3, { subtype: "success", isError: false, durationMs: 0, result: "done" })]
  for (const message of [...prefix, entry("user_prompt", 4, { content: "removed" })]) await store.appendMessage(source.id, message)
  await store.setContextRestoration(source.id, { id: "source-obligation", provider: "codex", fromProvider: "claude", reason: "provider_switch", endExclusive: 4 })
  const fork = await store.forkChat(source.id, { atLastCompletedTurn: true })
  expect(fork.contextRestoration).toMatchObject({ provider: "codex", fromProvider: "claude", endExclusive: 3 })
  expect(fork.contextRestoration?.id).not.toBe("source-obligation")
})


  test("queued prompt identity is checked in headers without payload reads", async () => {
  const dataDir = await createTempDataDir()
  const store = new EventStore(dataDir)
  await store.initialize()
  const project = await store.openProject(dataDir, "Project")
  const chat = await store.createChat(project.id)
  await store.appendMessage(chat.id, { _id: "queued-id", createdAt: 1, kind: "user_prompt", content: "persisted steer" })
  await store.appendMessage(chat.id, { _id: "tool-id", createdAt: 2, kind: "tool_result", toolId: "t", content: "payload" })
  store.getMessages = () => { throw new Error("queue identity loaded full payload") }
  expect(store.hasUserPrompt(chat.id, "queued-id")).toBe(true)
  expect(store.hasUserPrompt(chat.id, "tool-id")).toBe(false)
  expect(store.hasUserPrompt(chat.id, "missing-id")).toBe(false)
})


  test("a selected fork inherits pending restoration restricted to its copied prefix", async () => {
  const dataDir = await createTempDataDir()
  const store = new EventStore(dataDir)
  await store.initialize()
  const project = await store.openProject(dataDir, "Project")
  const source = await store.createChat(project.id)
  await store.setChatProvider(source.id, "codex")
  await store.setSessionToken(source.id, "partially-restored-native")
  const prefix = [entry("user_prompt", 1, { content: "allowed" }), entry("assistant_text", 2, { text: "allowed answer" })]
  await store.replaceTranscript(source.id, [...prefix, entry("user_prompt", 3, { content: "removed" })])
  await store.setContextRestoration(source.id, { id: "source-obligation", provider: "codex", fromProvider: "claude", reason: "provider_switch", endExclusive: 3 })
  const fork = await store.forkChat(source.id, { transcriptEntries: prefix })
  expect(fork.contextRestoration).toMatchObject({ provider: "codex", fromProvider: "claude", endExclusive: 2 })
  expect(fork.contextRestoration?.id).not.toBe("source-obligation")
})
