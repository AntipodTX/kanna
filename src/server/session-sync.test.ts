import { afterEach, describe, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import type { TranscriptEntry } from "../shared/types"
import { getDataRootDir, LOG_PREFIX } from "../shared/branding"
import { EventStore } from "./event-store"
import type { GenerateChatTitleResult } from "./generate-title"
import { syncExternalSessions } from "./session-sync"
import { processTranscriptMessages } from "../client/lib/parseTranscript"

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function createTempDir(prefix: string) {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

function projectFolderName(localPath: string) {
  return localPath.replaceAll("/", "-")
}

function messageKinds(entries: TranscriptEntry[]) {
  return entries.map((entry) => entry.kind)
}

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

describe("syncExternalSessions", () => {
  test("preserves native child attribution for array-form prompts and results after reimport", async () => {
    const homeDir = await createTempDir("kanna-sync-array-home-")
    const dataDir = await createTempDir("kanna-sync-array-data-")
    const projectDir = await createTempDir("kanna-sync-array-project-")
    const sessionToken = "claude-array-child-owner"
    const sessionDir = join(homeDir, ".claude", "projects", projectFolderName(projectDir))
    await mkdir(sessionDir, { recursive: true })
    const rows = [
      { type: "user", uuid: "root", message: { role: "user", content: "Root request" } },
      { type: "user", uuid: "child", parent_tool_use_id: "parent-tool", message: { role: "user", content: [
        { type: "text", text: "Investigate subtask" },
        { type: "tool_result", tool_use_id: "child-tool", content: "Child result" },
      ] } },
      { type: "user", uuid: "sidechain", isSidechain: true, message: { role: "user", content: [{ type: "text", text: "Side work" }] } },
      { type: "user", uuid: "named-child", subagent_type: "researcher", message: { role: "user", content: [{ type: "text", text: "Named child work" }] } },
    ]
    await writeFile(join(sessionDir, `${sessionToken}.jsonl`), rows.map(row => JSON.stringify(row)).join("\n"))
    const store = new EventStore(dataDir)
    await store.initialize()
    const args = {
      store, homeDir,
      discoveredProjects: [{ localPath: projectDir, title: "Project", modifiedAt: Date.now() }],
      generateTitle: async () => ({ title: "Root request", usedFallback: false, failureMessage: null }),
      codexClient: { async listThreads() { return [] }, async readThread() { return null } },
    }
    await syncExternalSessions(args)
    const project = store.listProjects()[0]!
    const chat = store.listChatsByProject(project.id)[0]!
    const entries = store.getMessages(chat.id)
    const child = entries.filter(entry => entry.messageId === "child")
    expect(child.map(entry => entry.kind)).toEqual(["user_prompt", "tool_result"])
    expect(child.every(entry => entry.parentToolUseId === "parent-tool")).toBe(true)
    expect(entries.find(entry => entry.messageId === "sidechain")).toMatchObject({ kind: "user_prompt", claudeSidechain: true })
    expect(entries.find(entry => entry.messageId === "named-child")).toMatchObject({ kind: "user_prompt", claudeSidechain: true })
    expect(entries.every(entry => entry.claudeSessionToken === sessionToken)).toBe(true)
    const replayed = new EventStore(dataDir)
    await replayed.initialize()
    await syncExternalSessions({ ...args, store: replayed })
    expect(replayed.getMessages(chat.id)).toEqual(entries)
  })

  test("imports native file ownership without session fields or fabricated message IDs", async () => {
    const homeDir = await createTempDir("kanna-sync-home-")
    const dataDir = await createTempDir("kanna-sync-data-")
    const projectDir = await createTempDir("kanna-sync-project-")
    const sessionToken = "claude-file-owner"
    const sessionDir = join(homeDir, ".claude", "projects", projectFolderName(projectDir))
    await mkdir(sessionDir, { recursive: true })
    const init = { type: "system", subtype: "init", uuid: "native-init", model: "fixture-model", tools: [] }
    const rows = [
      init,
      { type: "user", uuid: "native-prompt", message: { role: "user", content: "Start work" } },
      { type: "user", uuid: "child-prompt", parent_tool_use_id: "parent-tool", message: { role: "user", content: "Child work" } },
      { type: "assistant", uuid: "child-blocks", parent_tool_use_id: "parent-tool", message: { role: "assistant", content: [
        { type: "text", text: "Child answer" }, { type: "tool_use", name: "Bash", id: "child-tool", input: { command: "pwd" } },
      ] } },
      { type: "user", uuid: "child-result", parent_tool_use_id: "parent-tool", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "child-tool", content: "/fixture" }] } },
      { type: "user", uuid: "child-resume", parent_tool_use_id: "parent-tool", message: { role: "user", content: [{ type: "text", text: "This session is being continued after compaction." }] } },
      { type: "user", uuid: "orphan-child-prompt", isSidechain: true, message: { role: "user", content: "Child without a parent ID" } },
      { type: "assistant", uuid: "named-child", subagent_type: "researcher", message: { role: "assistant", content: [{ type: "text", text: "Named child without a parent ID" }] } },
      { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Record without a native UUID" }] } },
      { type: "user", uuid: "array-prompt", message: { role: "user", content: [{ type: "text", text: "Ordinary array text" }] } },
    ]
    await writeFile(join(sessionDir, `${sessionToken}.jsonl`), rows.map(row => JSON.stringify(row)).join("\n"))
    const store = new EventStore(dataDir)
    await store.initialize()
    const args = { store, homeDir, discoveredProjects: [{ localPath: projectDir, title: "Project", modifiedAt: Date.now() }],
      generateTitle: async () => ({ title: "Start work", usedFallback: false, failureMessage: null }),
      codexClient: { async listThreads() { return [] }, async readThread() { return null } } }
    await syncExternalSessions(args)
    const project = store.listProjects()[0]!
    const chat = store.listChatsByProject(project.id)[0]!
    const entries = store.getMessages(chat.id)
    expect(entries).toHaveLength(11)
    expect(entries.every(entry => entry.claudeSessionToken === sessionToken)).toBe(true)
    expect(entries.map(entry => entry.messageId)).toEqual([
      "native-init", "native-prompt", "child-prompt", "child-blocks", "child-blocks", "child-result", "child-resume", "orphan-child-prompt", "named-child", undefined, "array-prompt",
    ])
    expect(entries.every(entry => entry._id !== entry.messageId)).toBe(true)
    expect(new Set(entries.map(entry => entry._id)).size).toBe(entries.length)
    expect(entries.slice(2, 7).every(entry => entry.parentToolUseId === "parent-tool")).toBe(true)
    expect(entries.slice(7, 9).every(entry => entry.claudeSidechain === true && !entry.parentToolUseId)).toBe(true)
    expect(entries[0]).toMatchObject({ kind: "system_init", debugRaw: JSON.stringify(init) })
    expect(entries.find(entry => entry.messageId === "array-prompt")).toMatchObject({ kind: "user_prompt", content: "Ordinary array text" })
    const replayed = new EventStore(dataDir)
    await replayed.initialize()
    await syncExternalSessions({ ...args, store: replayed })
    expect(replayed.getMessages(chat.id)).toEqual(entries)
  })

  test("refreshes matched native user provenance and preserves local fields after restart", async () => {
    const homeDir = await createTempDir("kanna-sync-home-")
    const dataDir = await createTempDir("kanna-sync-data-")
    const projectDir = await createTempDir("kanna-sync-project-")
    const sessionToken = "claude-matched-user-owner"
    const sessionDir = join(homeDir, ".claude", "projects", projectFolderName(projectDir))
    await mkdir(sessionDir, { recursive: true })
    await writeFile(join(sessionDir, `${sessionToken}.jsonl`), JSON.stringify({
      type: "user", uuid: "native-user-uuid", timestamp: "2026-04-01T10:00:00.000Z",
      message: { role: "user", content: "Keep my prompt" },
    }))
    const store = new EventStore(dataDir)
    await store.initialize()
    const project = await store.openProject(projectDir)
    const chat = await store.createChat(project.id)
    await store.setChatProvider(chat.id, "claude")
    await store.setSessionToken(chat.id, sessionToken)
    const prompt: Extract<TranscriptEntry, { kind: "user_prompt" }> = {
      _id: "kanna-local-user", createdAt: 123, kind: "user_prompt", content: "Keep my prompt", hidden: true, steered: true,
      attachments: [{ id: "local-attachment", kind: "file", displayName: "notes.txt", absolutePath: "/fixture/notes.txt", relativePath: "notes.txt", contentUrl: "/fixture/notes", mimeType: "text/plain", size: 42 }],
      messageId: "stale-source-uuid", claudeSessionToken: "old-source-session", parentToolUseId: "old-parent", debugRaw: "stale metadata",
    }
    await store.appendMessage(chat.id, prompt)
    const args = { store, homeDir, discoveredProjects: [{ localPath: projectDir, title: "Project", modifiedAt: Date.now() }],
      codexClient: { async listThreads() { return [] }, async readThread() { return null } } }
    await syncExternalSessions(args)
    const expected: TranscriptEntry = {
      _id: prompt._id, createdAt: prompt.createdAt, kind: "user_prompt", content: prompt.content,
      hidden: prompt.hidden, steered: prompt.steered, attachments: prompt.attachments,
      messageId: "native-user-uuid", claudeSessionToken: sessionToken,
    }
    expect(store.getMessages(chat.id)).toEqual([expected])
    expect(store.getTranscriptSyncState(chat.id)?.canonicalMetadataVersion).toBe(1)
    const replayed = new EventStore(dataDir)
    await replayed.initialize()
    await syncExternalSessions({ ...args, store: replayed })
    expect(replayed.getMessages(chat.id)).toEqual([expected])
    await syncExternalSessions({ ...args, store: replayed })
    expect(replayed.getMessages(chat.id)).toEqual([expected])
  })

  test("keeps pruned empty provider sessions hidden after compaction, restart and resync", async () => {
    const homeDir = await createTempDir("kanna-sync-home-")
    const dataDir = await createTempDir("kanna-sync-data-")
    const projectDir = await createTempDir("kanna-sync-project-")
    const sessionId = "claude-pruned-empty"
    const sessionDir = join(homeDir, ".claude", "projects", projectFolderName(projectDir))
    await mkdir(sessionDir, { recursive: true })
    await writeFile(join(sessionDir, `${sessionId}.jsonl`), JSON.stringify({
      type: "user", sessionId, uuid: "prompt-1", timestamp: "2026-04-01T10:00:00.000Z",
      message: { role: "user", content: "Native history was not yet imported" },
    }))
    const store = new EventStore(dataDir)
    await store.initialize()
    const project = await store.openProject(projectDir)
    const chat = await store.createChat(project.id)
    await store.setChatProvider(chat.id, "claude")
    await store.setSessionToken(chat.id, sessionId)
    const now = chat.createdAt + 1000
    expect(await store.pruneStaleEmptyChats({ now, maxAgeMs: 100 })).toEqual([chat.id])
    await store.compact()
    const replayed = new EventStore(dataDir)
    await replayed.initialize()
    expect(replayed.getChat(chat.id)).toBeNull()
    await syncExternalSessions({
      store: replayed, homeDir,
      discoveredProjects: [{ localPath: projectDir, title: "Project", modifiedAt: now }],
      generateTitle: async () => ({ title: "Should remain hidden", usedFallback: false, failureMessage: null }),
      codexClient: { async listThreads() { return [] }, async readThread() { return null } },
    })
    expect(replayed.listChatsByProject(project.id).some(chat => chat.sessionToken === sessionId)).toBe(false)
    expect(replayed.isProviderSessionHidden("claude", sessionId)).toBe(true)
  })


  test("repairs previously acknowledged stale metadata once after restart", async () => {
    const homeDir = await createTempDir("kanna-sync-home-")
    const dataDir = await createTempDir("kanna-sync-data-")
    const projectDir = await createTempDir("kanna-sync-project-")
    const sessionId = "claude-legacy-acknowledged-metadata"
    const sessionDir = join(homeDir, ".claude", "projects", projectFolderName(projectDir))
    await mkdir(sessionDir, { recursive: true })
    await writeFile(join(sessionDir, `${sessionId}.jsonl`), [
      { type: "user", sessionId, uuid: "native-prompt", message: { role: "user", content: "Hello" } },
      { type: "assistant", sessionId, uuid: "native-answer", message: { role: "assistant", content: [{ type: "text", text: "answer" }] } },
    ].map(row => JSON.stringify(row)).join("\n"))
    const store = new EventStore(dataDir)
    await store.initialize()
    const project = await store.openProject(projectDir)
    const chat = await store.createChat(project.id)
    await store.setChatProvider(chat.id, "claude")
    await store.setSessionToken(chat.id, sessionId)
    const stale: TranscriptEntry = { _id: "local-answer", createdAt: 2, kind: "assistant_text", text: "answer", messageId: "old-native-id", parentToolUseId: "stale-child" }
    await store.appendMessage(chat.id, stale)
    const replaceTranscript = store.replaceTranscript.bind(store)
    // Reproduce the prior matching behavior while letting the real importer
    // write its acknowledged canonical hash and the hash of the stale rows.
    store.replaceTranscript = async (chatId, entries) => replaceTranscript(chatId,
      entries.map(entry => entry.kind === "assistant_text" ? stale : entry))
    const logs: string[] = []
    const args = { store, homeDir, discoveredProjects: [{ localPath: projectDir, title: "Project", modifiedAt: Date.now() }],
      onProgress: (message: string) => logs.push(message),
      codexClient: { async listThreads() { return [] }, async readThread() { return null } } }
    await syncExternalSessions(args)
    store.replaceTranscript = replaceTranscript
    const legacyState = { ...store.getTranscriptSyncState(chat.id)! }
    delete (legacyState as typeof legacyState & { canonicalMetadataVersion?: number }).canonicalMetadataVersion
    await store.setTranscriptSyncState(chat.id, legacyState)
    const replayed = new EventStore(dataDir)
    await replayed.initialize()
    await syncExternalSessions({ ...args, store: replayed })
    expect(replayed.getMessages(chat.id).find(entry => entry.kind === "assistant_text")).toEqual({
      _id: stale._id, createdAt: stale.createdAt, kind: "assistant_text", text: "answer", messageId: "native-answer",
      claudeSessionToken: sessionId,
    })
    logs.length = 0
    await syncExternalSessions({ ...args, store: replayed })
    expect(logs.some(line => line.includes("action=unchanged"))).toBe(true)
  })


  test("keeps stale-delete provider sessions hidden after GC, compaction and resync", async () => {
    const homeDir = await createTempDir("kanna-sync-home-")
    const dataDir = await createTempDir("kanna-sync-data-")
    const projectDir = await createTempDir("kanna-sync-project-")
    const sessionId = "claude-stale-delete"
    const sessionDir = join(homeDir, ".claude", "projects", projectFolderName(projectDir))
    await mkdir(sessionDir, { recursive: true })
    await writeFile(join(sessionDir, `${sessionId}.jsonl`), JSON.stringify({
      type: "user", sessionId, uuid: "prompt-1", timestamp: "2026-04-01T10:00:00.000Z",
      message: { role: "user", content: "Native history remains on disk" },
    }))
    const store = new EventStore(dataDir)
    await store.initialize()
    const project = await store.openProject(projectDir)
    const chat = await store.createChat(project.id)
    await store.setChatProvider(chat.id, "claude")
    await store.setSessionToken(chat.id, sessionId)
    const now = chat.createdAt + 1000
    await store.appendMessage(chat.id, { _id: "old-prompt", createdAt: chat.createdAt, kind: "user_prompt", content: "old" })
    const recent = await store.createChat(project.id)
    await store.appendMessage(recent.id, { _id: "recent-prompt", createdAt: now, kind: "user_prompt", content: "recent" })
    const deleted = await store.deleteStaleChats({ now, maxAgeMs: 100 })
    expect(deleted).toEqual([chat.id])
    await store.compact()
    const replayed = new EventStore(dataDir)
    await replayed.initialize()
    expect(replayed.getChat(chat.id)).toBeNull()
    await syncExternalSessions({
      store: replayed, homeDir,
      discoveredProjects: [{ localPath: projectDir, title: "Project", modifiedAt: now }],
      generateTitle: async () => ({ title: "Should remain hidden", usedFallback: false, failureMessage: null }),
      codexClient: { async listThreads() { return [] }, async readThread() { return null } },
    })
    expect(replayed.listChatsByProject(project.id).some(chat => chat.sessionToken === sessionId)).toBe(false)
    expect(replayed.isProviderSessionHidden("claude", sessionId)).toBe(true)
  })

  test("refreshes matched Claude provider metadata while retaining local identity and overlays", async () => {
    const homeDir = await createTempDir("kanna-sync-home-")
    const dataDir = await createTempDir("kanna-sync-data-")
    const projectDir = await createTempDir("kanna-sync-project-")
    const sessionId = "claude-parent-metadata"
    const sessionDir = join(homeDir, ".claude", "projects", projectFolderName(projectDir))
    await mkdir(sessionDir, { recursive: true })
    const assistant = {
      type: "assistant", sessionId, uuid: "native-assistant", timestamp: "2026-04-01T10:00:01.000Z",
      parent_tool_use_id: "parent-1",
      message: { role: "assistant", content: [{ type: "text", text: "child reply" }] },
    }
    const nativePath = join(sessionDir, `${sessionId}.jsonl`)
    const writeNative = () => writeFile(nativePath, [
      JSON.stringify({ type: "user", sessionId, uuid: "native-prompt", timestamp: "2026-04-01T10:00:00.000Z", message: { role: "user", content: "Hello" } }),
      JSON.stringify(assistant),
    ].join("\n"))
    await writeNative()
    const store = new EventStore(dataDir)
    await store.initialize()
    const project = await store.openProject(projectDir)
    const chat = await store.createChat(project.id)
    await store.setChatProvider(chat.id, "claude")
    await store.setSessionToken(chat.id, sessionId)
    const prompt: TranscriptEntry = { _id: "local-prompt", createdAt: 1, kind: "user_prompt", content: "Hello", hidden: true, steered: true, attachments: [] }
    const reply: TranscriptEntry = { _id: "local-reply", createdAt: 2, kind: "assistant_text", text: "child reply", messageId: "local-message-id", hidden: true, debugRaw: "local debug metadata" }
    const overlay: TranscriptEntry = { _id: "local-status", createdAt: 3, kind: "status", status: "local overlay" }
    for (const entry of [prompt, reply, overlay]) await store.appendMessage(chat.id, entry)
    const args = {
      store, homeDir,
      discoveredProjects: [{ localPath: projectDir, title: "Project", modifiedAt: Date.now() }],
      generateTitle: async () => { throw new Error("existing title must remain") },
      codexClient: { async listThreads() { return [] }, async readThread() { return null } },
    } satisfies Parameters<typeof syncExternalSessions>[0]
    await syncExternalSessions(args)
    const canonicalPrompt: TranscriptEntry = { ...prompt, messageId: "native-prompt", claudeSessionToken: sessionId }
    const canonicalReply: Extract<TranscriptEntry, { kind: "assistant_text" }> = { _id: reply._id, createdAt: reply.createdAt, kind: "assistant_text", text: "child reply", messageId: "native-assistant", claudeSessionToken: sessionId, hidden: true }
    expect(store.getMessages(chat.id)).toEqual([canonicalPrompt, { ...canonicalReply, parentToolUseId: "parent-1" }, overlay])
    // Same text and native record id, with only provider metadata corrected.
    assistant.parent_tool_use_id = "parent-2"
    await writeNative()
    await syncExternalSessions(args)
    const corrected = [canonicalPrompt, { ...canonicalReply, parentToolUseId: "parent-2" }, overlay]
    expect(store.getMessages(chat.id)).toEqual(corrected)
    await syncExternalSessions(args)
    expect(store.getMessages(chat.id)).toEqual(corrected)
    assistant.parent_tool_use_id = ""
    await writeNative()
    await syncExternalSessions(args)
    const mainThreadEntries = [canonicalPrompt, canonicalReply, overlay]
    expect(store.getMessages(chat.id)).toEqual(mainThreadEntries)
    const reloaded = new EventStore(dataDir)
    await reloaded.initialize()
    await syncExternalSessions({ ...args, store: reloaded })
    expect(reloaded.getMessages(chat.id)).toEqual(mainThreadEntries)
  })

  test("removes stale provider tool-result metadata on a matched canonical row", async () => {
    const homeDir = await createTempDir("kanna-sync-home-")
    const dataDir = await createTempDir("kanna-sync-data-")
    const projectDir = await createTempDir("kanna-sync-project-")
    const sessionId = "claude-result-metadata"
    const sessionDir = join(homeDir, ".claude", "projects", projectFolderName(projectDir))
    await mkdir(sessionDir, { recursive: true })
    await writeFile(join(sessionDir, `${sessionId}.jsonl`), [
      { type: "user", sessionId, uuid: "prompt", message: { role: "user", content: "Run" } },
      { type: "assistant", sessionId, uuid: "call", message: { role: "assistant", content: [{ type: "tool_use", name: "Bash", id: "bash-1", input: { command: "pwd" } }] } },
      { type: "user", sessionId, uuid: "result", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "bash-1", content: "/project", is_error: false }] } },
    ].map(record => JSON.stringify(record)).join("\n"))
    const store = new EventStore(dataDir)
    await store.initialize()
    const project = await store.openProject(projectDir)
    const chat = await store.createChat(project.id)
    await store.setChatProvider(chat.id, "claude")
    await store.setSessionToken(chat.id, sessionId)
    const stale: TranscriptEntry = { _id: "local-result", createdAt: 2, kind: "tool_result", toolId: "bash-1", content: "/project", isError: false, messageId: "old-result", debugRaw: "stale provider JSON", structuredResult: { obsolete: true }, parentToolUseId: "old-child", hidden: true }
    await store.appendMessage(chat.id, stale)
    const args = { store, homeDir, discoveredProjects: [{ localPath: projectDir, title: "Project", modifiedAt: Date.now() }], codexClient: { async listThreads() { return [] }, async readThread() { return null } } }
    await syncExternalSessions(args)
    const result = store.getMessages(chat.id).find(entry => entry.kind === "tool_result")!
    expect(result).toEqual({ _id: stale._id, createdAt: stale.createdAt, kind: "tool_result", toolId: "bash-1", content: "/project", isError: false, messageId: "result", claudeSessionToken: sessionId, hidden: true })
    await syncExternalSessions(args)
    expect(store.getMessages(chat.id).find(entry => entry.kind === "tool_result")).toEqual(result)
  })

  test("imports async Codex question cards and their native replies without duplicating on resync", async () => {
    const homeDir = await createTempDir("kanna-sync-home-")
    const dataDir = await createTempDir("kanna-sync-data-")
    const projectDir = await createTempDir("kanna-sync-project-")
    const store = new EventStore(dataDir)
    await store.initialize()
    const questionItemId = '["request_user_input_async","question-1",0]'
    const thread = {
      id: "thread-async", preview: "Cleanup?", ephemeral: false, modelProvider: "openai" as const,
      createdAt: 1_710_000_000, updatedAt: 1_710_000_005, status: "idle" as const,
      path: null, cwd: projectDir, cliVersion: "0.159.0", source: "cli" as const,
      turns: [{ id: "turn-1", status: "completed" as const, error: null, items: [
        { type: "userMessage" as const, id: "prompt-1", content: [{ type: "text" as const, text: "Clean the workspace", text_elements: [] as [] }] },
        { type: "agentMessage" as const, id: "question-1", text: "Cleanup?\n- All", delivery: "async" as const,
          questions: [{ title: "Cleanup?", options: ["All"] }] },
        { type: "userMessage" as const, id: "answer-1", content: [{ type: "text" as const,
          text: `<send_user_message_question_reply>${JSON.stringify([{ questionItemId, question: "Cleanup?", answer: "All" }])}</send_user_message_question_reply>`,
          text_elements: [] as [],
        }] },
      ] }],
    }
    const syncArgs = {
      store, homeDir,
      discoveredProjects: [{ localPath: projectDir, title: "Project", modifiedAt: 1_710_000_005_000 }],
      generateTitle: async () => ({ title: "Cleanup", usedFallback: false, failureMessage: null }),
      codexClient: { async listThreads() { return [thread] }, async readThread() { return thread } },
    } satisfies Parameters<typeof syncExternalSessions>[0]
    await syncExternalSessions(syncArgs)
    const project = store.listProjects()[0]!
    const chat = store.listChatsByProject(project.id)[0]!
    const entries = store.getMessages(chat.id)
    const question = entries.find(entry => entry.kind === "tool_call" && entry.tool.toolKind === "ask_user_question")
    expect(question).toMatchObject({ kind: "tool_call", tool: { toolId: "question-1", input: {
      codexAsync: { threadId: "thread-async" }, questions: [{ id: questionItemId }],
    } } })
    expect(entries.some(entry => entry.kind === "assistant_text")).toBe(false)
    const hydrated = processTranscriptMessages(entries)
    expect(hydrated.find(entry => entry.kind === "tool")).toMatchObject({ result: { answers: { [questionItemId]: ["All"] } } })
    await syncExternalSessions(syncArgs)
    expect(store.getMessages(chat.id)).toEqual(entries)

    // A changed provider snapshot must replace native cards, not preserve
    // them as additional Kanna-specific overlays beside their replacements.
    thread.updatedAt += 1
    const changedQuestion = thread.turns[0]!.items.find(item => item.type === "agentMessage")!
    changedQuestion.questions![0]!.options.push("Selected files")
    await syncExternalSessions(syncArgs)
    const reconciled = store.getMessages(chat.id)
    expect(reconciled.filter(entry => entry.kind === "tool_call")).toHaveLength(1)
    expect(reconciled.filter(entry => entry.kind === "tool_result")).toHaveLength(1)
  })

  for (const toolName of ["AskUserQuestion", "ExitPlanMode", "TodoWrite"]) {
    test(`reconciles native ${toolName} rows without stale overlays and retains local questions`, async () => {
      const homeDir = await createTempDir("kanna-sync-home-")
      const dataDir = await createTempDir("kanna-sync-data-")
      const projectDir = await createTempDir("kanna-sync-project-")
      const sessionId = `native-${toolName}`
      const sessionDir = join(homeDir, ".claude", "projects", projectFolderName(projectDir))
      await mkdir(sessionDir, { recursive: true })
      const nativePath = join(sessionDir, `${sessionId}.jsonl`)
      const call = { type: "assistant", sessionId, uuid: "native-call", message: { role: "assistant", content: [{ type: "tool_use", name: toolName, id: "native-tool", input: {
        questions: [{ question: "Continue?", options: [{ label: "Yes" }] }], plan: "First plan", todos: [{ content: "First step", status: "pending", activeForm: "Doing first step" }],
      } }] } }
      const result = { type: "user", sessionId, uuid: "native-result", tool_use_result: { answers: { "Continue?": ["Yes"] }, confirmed: true }, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "native-tool", content: "Old native result" }] } }
      const prompt = { type: "user", sessionId, uuid: "native-prompt", message: { role: "user", content: "Work" } }
      const tail = { type: "assistant", sessionId, uuid: "native-tail", message: { role: "assistant", content: [{ type: "text", text: "Shared tail" }] } }
      const writeNative = (includeTool = true) => writeFile(nativePath, [prompt, ...(includeTool ? [call, result] : []), tail].map(record => JSON.stringify(record)).join("\n"))
      await writeNative()
      const store = new EventStore(dataDir)
      await store.initialize()
      const args = { store, homeDir, discoveredProjects: [{ localPath: projectDir, title: "Project", modifiedAt: Date.now() }], generateTitle: async () => ({ title: "Work", usedFallback: false, failureMessage: null }), codexClient: { async listThreads() { return [] }, async readThread() { return null } } }
      await syncExternalSessions(args)
      const project = store.listProjects()[0]!
      const chat = store.listChatsByProject(project.id)[0]!
      const localCall: TranscriptEntry = { _id: "local-call", createdAt: 1, kind: "tool_call", tool: { kind: "tool", toolKind: "ask_user_question", toolName: "AskUserQuestion", toolId: "local-tool", input: { questions: [{ question: "Local only?" }] } } }
      const localResult: TranscriptEntry = { _id: "local-result", createdAt: 2, kind: "tool_result", toolId: "local-tool", content: { answers: { "Local only?": ["Keep"] } } }
      await store.appendMessage(chat.id, localCall)
      await store.appendMessage(chat.id, localResult)
      if (toolName !== "TodoWrite") {
        const original = store.getMessages(chat.id).find(entry => entry.kind === "tool_result" && entry.toolId === "native-tool")!
        result.tool_use_result.answers["Continue?"] = ["Metadata-only correction"]
        await writeNative()
        await syncExternalSessions(args)
        const metadataOnly = store.getMessages(chat.id).filter(entry => entry.kind === "tool_result" && entry.toolId === "native-tool")
        expect(metadataOnly).toMatchObject([{ _id: original._id, createdAt: original.createdAt, content: "Old native result", structuredResult: { answers: { "Continue?": ["Metadata-only correction"] } } }])
      }
      result.message.content[0]!.content = "Corrected native result"
      result.tool_use_result.answers["Continue?"] = ["Corrected"]
      call.message.content[0]!.input.plan = "Corrected plan"
      call.message.content[0]!.input.questions[0]!.options.push({ label: "No" })
      await writeNative()
      await syncExternalSessions(args)
      const corrected = store.getMessages(chat.id)
      expect(corrected.filter(entry => entry.kind === "tool_call" && entry.tool.toolId === "native-tool")).toHaveLength(1)
      expect(corrected.filter(entry => entry.kind === "tool_result" && entry.toolId === "native-tool")).toMatchObject([{ content: "Corrected native result" }])
      expect(corrected.filter(entry => entry._id === localCall._id || entry._id === localResult._id)).toEqual([localCall, localResult])
      await syncExternalSessions(args)
      expect(store.getMessages(chat.id)).toEqual(corrected)
      // A provider rewrite may remove its tools. Past provider provenance must
      // survive a locally changed transcript hash and prevent resurrection.
      await store.appendMessage(chat.id, { _id: "local-status", createdAt: 3, kind: "status", status: "Local progress" })
      await writeNative(false)
      await syncExternalSessions(args)
      const removed = store.getMessages(chat.id)
      expect(removed.some(entry => entry.kind === "tool_call" && entry.tool.toolId === "native-tool" || entry.kind === "tool_result" && entry.toolId === "native-tool")).toBe(false)
      expect(removed.filter(entry => entry._id === localCall._id || entry._id === localResult._id)).toEqual([localCall, localResult])
      const replayed = new EventStore(dataDir)
      await replayed.initialize()
      await syncExternalSessions({ ...args, store: replayed })
      expect(replayed.getMessages(chat.id)).toEqual(removed)
    })
  }

  test("retains a Kanna-only answer to a native question until the provider owns the result", async () => {
    const homeDir = await createTempDir("kanna-sync-home-")
    const dataDir = await createTempDir("kanna-sync-data-")
    const projectDir = await createTempDir("kanna-sync-project-")
    const sessionId = "native-question-local-answer"
    const sessionDir = join(homeDir, ".claude", "projects", projectFolderName(projectDir))
    await mkdir(sessionDir, { recursive: true })
    const nativePath = join(sessionDir, `${sessionId}.jsonl`)
    const call = { type: "assistant", sessionId, uuid: "call", message: { role: "assistant", content: [{ type: "tool_use", name: "AskUserQuestion", id: "shared-tool", input: { questions: [{ question: "Continue?", options: [{ label: "Yes" }] }] } }] } }
    const writeNative = () => writeFile(nativePath, [
      { type: "user", sessionId, uuid: "prompt", message: { role: "user", content: "Work" } }, call,
    ].map(record => JSON.stringify(record)).join("\n"))
    await writeNative()
    const store = new EventStore(dataDir)
    await store.initialize()
    const args = { store, homeDir, discoveredProjects: [{ localPath: projectDir, title: "Project", modifiedAt: Date.now() }], generateTitle: async () => ({ title: "Work", usedFallback: false, failureMessage: null }), codexClient: { async listThreads() { return [] }, async readThread() { return null } } }
    await syncExternalSessions(args)
    const chat = store.listChatsByProject(store.listProjects()[0]!.id)[0]!
    const originalCall = store.getMessages(chat.id).find(entry => entry.kind === "tool_call")!
    const localResult: TranscriptEntry = { _id: "local-answer", createdAt: 2, kind: "tool_result", toolId: "shared-tool", content: { answers: { "Continue?": ["Yes"] } } }
    await store.appendMessage(chat.id, localResult)
    call.message.content[0]!.input.questions[0]!.options.push({ label: "No" })
    await writeNative()
    await syncExternalSessions(args)
    const corrected = store.getMessages(chat.id)
    expect(corrected.map(entry => entry.kind)).toEqual(["user_prompt", "tool_call", "tool_result"])
    expect(corrected[1]).toMatchObject({ _id: originalCall._id, createdAt: originalCall.createdAt })
    expect(corrected[2]).toEqual(localResult)
    // Once the provider records this same tool's answer, its result wins.
    await writeFile(nativePath, `${await readFile(nativePath, "utf8")}\n${JSON.stringify({
      type: "user", sessionId, uuid: "native-answer", tool_use_result: { answers: { "Continue?": ["Native confirmation"] } },
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "shared-tool", content: "Native confirmation" }] },
    })}`)
    await syncExternalSessions(args)
    expect(store.getMessages(chat.id).filter(entry => entry.kind === "tool_result")).toMatchObject([{ messageId: "native-answer", content: "Native confirmation" }])
  })

  test("removes legacy native tools by stable provider keys after acknowledging a corrected payload", async () => {
    const homeDir = await createTempDir("kanna-sync-home-")
    const dataDir = await createTempDir("kanna-sync-data-")
    const projectDir = await createTempDir("kanna-sync-project-")
    const sessionId = "legacy-stale-question"
    const sessionDir = join(homeDir, ".claude", "projects", projectFolderName(projectDir))
    await mkdir(sessionDir, { recursive: true })
    const nativePath = join(sessionDir, `${sessionId}.jsonl`)
    const call = { type: "assistant", sessionId, uuid: "native-call", message: { role: "assistant", content: [{ type: "tool_use", name: "AskUserQuestion", id: "shared-tool", input: { questions: [{ question: "Old question?" }] } }] } }
    const result = { type: "user", sessionId, uuid: "native-result", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "shared-tool", content: "Old answer" }] } }
    const prompt = { type: "user", sessionId, uuid: "prompt", message: { role: "user", content: "Work" } }
    const tail = { type: "assistant", sessionId, uuid: "tail", message: { role: "assistant", content: [{ type: "text", text: "Shared tail" }] } }
    const writeNative = (includeTools = true) => writeFile(nativePath, [prompt, ...(includeTools ? [call, result] : []), tail].map(record => JSON.stringify(record)).join("\n"))
    await writeNative()
    const store = new EventStore(dataDir)
    await store.initialize()
    const args = { store, homeDir, discoveredProjects: [{ localPath: projectDir, title: "Project", modifiedAt: Date.now() }], generateTitle: async () => ({ title: "Work", usedFallback: false, failureMessage: null }), codexClient: { async listThreads() { return [] }, async readThread() { return null } } }
    await syncExternalSessions(args)
    const chat = store.listChatsByProject(store.listProjects()[0]!.id)[0]!
    const originalEntries = store.getMessages(chat.id)
    const originalState = store.getTranscriptSyncState(chat.id)!
    call.message.content[0]!.input.questions[0]!.question = "Corrected question?"
    result.message.content[0]!.content = "Corrected answer"
    await writeNative()
    await syncExternalSessions(args)
    const correctedState = store.getTranscriptSyncState(chat.id)!
    expect(correctedState.canonicalHash).not.toBe(originalState.canonicalHash)
    expect(correctedState.providerSequence.map(record => record.providerKey)).toEqual(originalState.providerSequence.map(record => record.providerKey))
    // Legacy reconciliation acknowledged newer native payloads while retaining
    // old rows. Their match keys differ; their native UUIDs remain authoritative.
    await store.replaceTranscript(chat.id, originalEntries)
    await store.setTranscriptSyncState(chat.id, { ...correctedState, transcriptHash: originalState.transcriptHash })
    const localAnswer: TranscriptEntry = { _id: "local-answer", createdAt: 1, kind: "tool_result", toolId: "shared-tool", content: { answers: { Local: ["Keep"] } } }
    await store.appendMessage(chat.id, localAnswer)
    await writeNative(false)
    const replayed = new EventStore(dataDir)
    await replayed.initialize()
    await syncExternalSessions({ ...args, store: replayed })
    const repaired = replayed.getMessages(chat.id)
    expect(repaired.some(entry => entry.messageId === "native-call" || entry.messageId === "native-result")).toBe(false)
    expect(repaired.filter(entry => entry.kind === "tool_result")).toEqual([localAnswer])
    await syncExternalSessions({ ...args, store: replayed })
    expect(replayed.getMessages(chat.id)).toEqual(repaired)
  })

  test("uses the Web UI title-generation flow for newly imported chats", async () => {
    const homeDir = await createTempDir("kanna-sync-home-")
    const dataDir = await createTempDir("kanna-sync-data-")
    const projectDir = await createTempDir("kanna-sync-project-")
    const store = new EventStore(dataDir)
    await store.initialize()

    const titleCalls: Array<{ messageContent: string; cwd: string; preferredProvider?: "claude" | "codex" }> = []
    const generatedTitle: GenerateChatTitleResult = {
      title: "Auth flow bugfix",
      usedFallback: false,
      failureMessage: null,
    }

    const buildCodexThread = (name: string, preview = name) => ({
      id: "thread-1",
      preview,
      ephemeral: false,
      modelProvider: "openai" as const,
      createdAt: 1_710_000_000,
      updatedAt: 1_710_000_005,
      status: "idle" as const,
      path: null,
      cwd: projectDir,
      cliVersion: "0.0.0",
      source: "cli" as const,
      name,
      turns: [{
        id: "turn-1",
        status: "completed" as const,
        error: null,
        items: [
          {
            type: "userMessage" as const,
            id: "user-msg-1",
            content: [{
              type: "text" as const,
              text: "Please fix the login race and flaky retry loop in auth before release",
              text_elements: [] as [],
            }],
          },
        ],
      }],
    })

    let currentThreadName = "Please fix the login race and flaky retry loop in auth before release"

    const syncArgs = {
      store,
      homeDir,
      discoveredProjects: [{
        localPath: projectDir,
        title: "Project",
        modifiedAt: Date.parse("2026-04-01T10:00:05.000Z"),
      }],
      generateTitle: async (messageContent: string, cwd: string, preferredProvider?: "claude" | "codex") => {
        titleCalls.push({ messageContent, cwd, preferredProvider })
        return generatedTitle
      },
      codexClient: {
        async listThreads() {
          return [buildCodexThread(currentThreadName, currentThreadName)]
        },
        async readThread() {
          return buildCodexThread(currentThreadName, currentThreadName)
        },
      },
    } satisfies Parameters<typeof syncExternalSessions>[0]

    await syncExternalSessions(syncArgs)

    const [project] = store.listProjects()
    let [chat] = store.listChatsByProject(project!.id)
    expect(chat?.title).toBe("Auth flow bugfix")
    expect(chat?.hasLocalTitleOverride).toBe(false)
    expect(titleCalls).toEqual([{
      messageContent: "Please fix the login race and flaky retry loop in auth before release",
      cwd: projectDir,
      preferredProvider: "codex",
    }])

    currentThreadName = "Provider title changed later but should not sync back"
    await syncExternalSessions(syncArgs)

    ;[chat] = store.listChatsByProject(project!.id)
    expect(chat?.title).toBe("Auth flow bugfix")
    expect(chat?.hasLocalTitleOverride).toBe(false)
    expect(titleCalls).toHaveLength(1)
  })

  test("imports Claude history files and normalizes Kanna attachment prompts back into user messages", async () => {
    const homeDir = await createTempDir("kanna-sync-home-")
    const dataDir = await createTempDir("kanna-sync-data-")
    const projectDir = await createTempDir("kanna-sync-project-")
    const sessionId = "claude-session-1"
    const sessionDir = join(homeDir, ".claude", "projects", projectFolderName(projectDir))
    await mkdir(sessionDir, { recursive: true })

    const transcriptPath = join(sessionDir, `${sessionId}.jsonl`)
    await writeFile(transcriptPath, [
      JSON.stringify({
        type: "user",
        sessionId,
        uuid: "user-1",
        timestamp: "2026-04-01T10:00:00.000Z",
        message: {
          role: "user",
          content: "Review this file\n\n<kanna-attachments>\n<attachment kind=\"file\" path=\"/tmp/spec.txt\" project_path=\"./spec.txt\" size_bytes=\"32\" display_name=\"spec.txt\" mime_type=\"text/plain\" />\n</kanna-attachments>",
        },
      }),
      JSON.stringify({
        type: "assistant",
        sessionId,
        uuid: "assistant-1",
        timestamp: "2026-04-01T10:00:01.000Z",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "I will inspect it." },
            { type: "tool_use", id: "tool-1", name: "Bash", input: { command: "pwd" } },
          ],
        },
      }),
      JSON.stringify({
        type: "user",
        sessionId,
        uuid: "user-2",
        timestamp: "2026-04-01T10:00:02.000Z",
        message: {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "tool-1", content: "/tmp/project\n", is_error: false },
          ],
        },
      }),
    ].join("\n"), "utf8")

    const store = new EventStore(dataDir)
    await store.initialize()

    await syncExternalSessions({
      store,
      homeDir,
      discoveredProjects: [{
        localPath: projectDir,
        title: "Project",
        modifiedAt: Date.parse("2026-04-01T10:00:02.000Z"),
      }],
      generateTitle: async () => ({
        title: "Review this file",
        usedFallback: false,
        failureMessage: null,
      }),
      codexClient: {
        async listThreads() {
          return []
        },
        async readThread() {
          return null
        },
      },
    })

    const [project] = store.listProjects()
    expect(project?.localPath).toBe(projectDir)

    const [chat] = store.listChatsByProject(project!.id)
    expect(chat?.provider).toBe("claude")
    expect(chat?.sessionToken).toBe(sessionId)
    expect(chat?.title).toBe("Review this file")

    const messages = store.getMessages(chat!.id)
    expect(messageKinds(messages)).toEqual([
      "user_prompt",
      "assistant_text",
      "tool_call",
      "tool_result",
    ])
    expect(messages[0]).toMatchObject({
      kind: "user_prompt",
      content: "Review this file",
    })
  })

  test("skips unreadable Claude history files while importing the rest", async () => {
    const homeDir = await createTempDir("kanna-sync-home-")
    const dataDir = await createTempDir("kanna-sync-data-")
    const projectDir = await createTempDir("kanna-sync-project-")
    const sessionDir = join(homeDir, ".claude", "projects", projectFolderName(projectDir))
    await mkdir(sessionDir, { recursive: true })

    const badSessionId = "claude-unreadable-session"
    const badTranscriptPath = join(sessionDir, `${badSessionId}.jsonl`)
    await writeFile(badTranscriptPath, "unreadable\n", "utf8")
    await chmod(badTranscriptPath, 0)

    const goodSessionId = "claude-readable-session"
    await writeFile(join(sessionDir, `${goodSessionId}.jsonl`), JSON.stringify({
      type: "user",
      sessionId: goodSessionId,
      uuid: "user-readable",
      timestamp: "2026-04-01T10:00:00.000Z",
      message: {
        role: "user",
        content: "Keep importing the readable session",
      },
    }), "utf8")

    const store = new EventStore(dataDir)
    await store.initialize()
    const progressMessages: string[] = []

    await syncExternalSessions({
      store,
      homeDir,
      discoveredProjects: [{
        localPath: projectDir,
        title: "Project",
        modifiedAt: Date.parse("2026-04-01T10:00:00.000Z"),
      }],
      generateTitle: async () => ({
        title: "Readable session",
        usedFallback: false,
        failureMessage: null,
      }),
      codexClient: {
        async listThreads() {
          return []
        },
        async readThread() {
          return null
        },
      },
      onProgress: (message) => {
        progressMessages.push(message)
      },
    })

    const [project] = store.listProjects()
    const [chat] = store.listChatsByProject(project!.id)
    expect(chat?.sessionToken).toBe(goodSessionId)
    expect(progressMessages.some((message) => (
      message.includes("Claude session read failed")
      && message.includes(`session=${badSessionId}`)
    ))).toBe(true)
  })

  test("skips unreadable Claude project directories while importing Codex sessions", async () => {
    const homeDir = await createTempDir("kanna-sync-home-")
    const dataDir = await createTempDir("kanna-sync-data-")
    const projectDir = await createTempDir("kanna-sync-project-")
    const sessionDir = join(homeDir, ".claude", "projects", projectFolderName(projectDir))
    await mkdir(sessionDir, { recursive: true })
    await chmod(sessionDir, 0)

    const store = new EventStore(dataDir)
    await store.initialize()
    const progressMessages: string[] = []
    const codexThread = {
      id: "thread-unreadable-claude-dir",
      preview: "Import this Codex thread even if Claude scan fails",
      ephemeral: false,
      modelProvider: "openai" as const,
      createdAt: 1_710_000_000,
      updatedAt: 1_710_000_005,
      status: "idle" as const,
      path: null,
      cwd: projectDir,
      cliVersion: "0.0.0",
      source: "cli" as const,
      name: "",
      turns: [{
        id: "turn-1",
        status: "completed" as const,
        error: null,
        items: [
          {
            type: "userMessage" as const,
            id: "user-msg-1",
            content: [{
              type: "text" as const,
              text: "Import this Codex thread even if Claude scan fails",
              text_elements: [] as [],
            }],
          },
        ],
      }],
    }

    try {
      await syncExternalSessions({
        store,
        homeDir,
        discoveredProjects: [{
          localPath: projectDir,
          title: "Project",
          modifiedAt: Date.parse("2026-04-01T10:00:00.000Z"),
        }],
        generateTitle: async () => ({
          title: "Codex session",
          usedFallback: false,
          failureMessage: null,
        }),
        codexClient: {
          async listThreads() {
            return [codexThread]
          },
          async readThread() {
            return codexThread
          },
        },
        onProgress: (message) => {
          progressMessages.push(message)
        },
      })
    } finally {
      await chmod(sessionDir, 0o700)
    }

    const [project] = store.listProjects()
    const [chat] = store.listChatsByProject(project!.id)
    expect(chat?.provider).toBe("codex")
    expect(chat?.sessionToken).toBe(codexThread.id)
    expect(progressMessages.some((message) => (
      message.includes("Claude project dir read failed")
      && message.includes(`path=${projectDir}`)
      && message.includes(`dir=${sessionDir}`)
    ))).toBe(true)
  })

  test("skips Claude attachment-only prompts when attachment import is unavailable", async () => {
    const homeDir = await createTempDir("kanna-sync-home-")
    const dataDir = await createTempDir("kanna-sync-data-")
    const projectDir = await createTempDir("kanna-sync-project-")
    const sessionId = "claude-attachment-only-session"
    const sessionDir = join(homeDir, ".claude", "projects", projectFolderName(projectDir))
    await mkdir(sessionDir, { recursive: true })

    await writeFile(join(sessionDir, `${sessionId}.jsonl`), [
      JSON.stringify({
        type: "user",
        sessionId,
        uuid: "user-attachment-only",
        timestamp: "2026-04-01T10:00:00.000Z",
        message: {
          role: "user",
          content: "Please inspect the attached files.\n\n<kanna-attachments>\n<attachment kind=\"file\" path=\"/tmp/spec.txt\" project_path=\"./spec.txt\" size_bytes=\"32\" display_name=\"spec.txt\" mime_type=\"text/plain\" />\n</kanna-attachments>",
        },
      }),
    ].join("\n"), "utf8")

    const store = new EventStore(dataDir)
    await store.initialize()
    let titleCalls = 0

    await syncExternalSessions({
      store,
      homeDir,
      discoveredProjects: [{
        localPath: projectDir,
        title: "Project",
        modifiedAt: Date.parse("2026-04-01T10:00:00.000Z"),
      }],
      generateTitle: async () => {
        titleCalls += 1
        throw new Error("title generation should not run for attachment-only prompts")
      },
      codexClient: {
        async listThreads() {
          return []
        },
        async readThread() {
          return null
        },
      },
    })

    expect(titleCalls).toBe(0)
    expect(store.listProjects()).toHaveLength(0)
  })

  test("skips Claude local command records during history import", async () => {
    const homeDir = await createTempDir("kanna-sync-home-")
    const dataDir = await createTempDir("kanna-sync-data-")
    const projectDir = await createTempDir("kanna-sync-project-")
    const sessionId = "claude-local-command-session"
    const sessionDir = join(homeDir, ".claude", "projects", projectFolderName(projectDir))
    await mkdir(sessionDir, { recursive: true })

    const transcriptPath = join(sessionDir, `${sessionId}.jsonl`)
    await writeFile(transcriptPath, [
      JSON.stringify({
        type: "user",
        sessionId,
        uuid: "local-command-1",
        timestamp: "2026-04-01T10:00:00.000Z",
        message: {
          role: "user",
          content: [
            "<command-name>/model</command-name>",
            "<command-message>model</command-message>",
            "<command-args></command-args>",
          ].join("\n"),
        },
      }),
      JSON.stringify({
        type: "user",
        sessionId,
        uuid: "local-command-output-1",
        timestamp: "2026-04-01T10:00:00.000Z",
        message: {
          role: "user",
          content: "<local-command-stdout>Set model to \u001b[1mOpus 4.7 (1M context)\u001b[22m</local-command-stdout>",
        },
      }),
      JSON.stringify({
        type: "user",
        sessionId,
        uuid: "local-command-output-2",
        timestamp: "2026-04-01T10:00:00.000Z",
        message: {
          role: "user",
          content: "<local-command-stdout>Login successful</local-command-stdout>",
        },
      }),
      JSON.stringify({
        type: "user",
        sessionId,
        uuid: "user-1",
        timestamp: "2026-04-01T10:00:01.000Z",
        message: {
          role: "user",
          content: "Now inspect the deployment config",
        },
      }),
      JSON.stringify({
        type: "assistant",
        sessionId,
        uuid: "assistant-1",
        timestamp: "2026-04-01T10:00:02.000Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "I will inspect it." }],
        },
      }),
    ].join("\n"), "utf8")

    const store = new EventStore(dataDir)
    await store.initialize()

    await syncExternalSessions({
      store,
      homeDir,
      discoveredProjects: [{
        localPath: projectDir,
        title: "Project",
        modifiedAt: Date.parse("2026-04-01T10:00:02.000Z"),
      }],
      generateTitle: async () => ({
        title: "Inspect deployment config",
        usedFallback: false,
        failureMessage: null,
      }),
      codexClient: {
        async listThreads() {
          return []
        },
        async readThread() {
          return null
        },
      },
    })

    const [project] = store.listProjects()
    const [chat] = store.listChatsByProject(project!.id)
    const messages = store.getMessages(chat!.id)

    expect(messageKinds(messages)).toEqual([
      "user_prompt",
      "assistant_text",
    ])
    expect(messages[0]).toMatchObject({
      kind: "user_prompt",
      content: "Now inspect the deployment config",
    })
  })

  test("preserves previously imported Claude local command records on resync", async () => {
    const homeDir = await createTempDir("kanna-sync-home-")
    const dataDir = await createTempDir("kanna-sync-data-")
    const projectDir = await createTempDir("kanna-sync-project-")
    const sessionId = "claude-local-command-resync-session"
    const sessionDir = join(homeDir, ".claude", "projects", projectFolderName(projectDir))
    await mkdir(sessionDir, { recursive: true })

    const localCommandContent = [
      "<command-name>/model</command-name>",
      "<command-message>model</command-message>",
      "<command-args></command-args>",
    ].join("\n")
    const localCommandOutput = "<local-command-stdout>Login successful</local-command-stdout>"
    const transcriptPath = join(sessionDir, `${sessionId}.jsonl`)
    await writeFile(transcriptPath, [
      JSON.stringify({
        type: "user",
        sessionId,
        uuid: "local-command-1",
        timestamp: "2026-04-01T10:00:00.000Z",
        message: {
          role: "user",
          content: localCommandContent,
        },
      }),
      JSON.stringify({
        type: "user",
        sessionId,
        uuid: "local-command-output-1",
        timestamp: "2026-04-01T10:00:00.000Z",
        message: {
          role: "user",
          content: localCommandOutput,
        },
      }),
      JSON.stringify({
        type: "user",
        sessionId,
        uuid: "user-1",
        timestamp: "2026-04-01T10:00:01.000Z",
        message: {
          role: "user",
          content: "Now inspect the deployment config",
        },
      }),
      JSON.stringify({
        type: "assistant",
        sessionId,
        uuid: "assistant-1",
        timestamp: "2026-04-01T10:00:02.000Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "I will inspect it." }],
        },
      }),
    ].join("\n"), "utf8")

    const store = new EventStore(dataDir)
    await store.initialize()

    const project = await store.openProject(projectDir)
    const chat = await store.createChat(project.id)
    await store.setChatProvider(chat.id, "claude")
    await store.setSessionToken(chat.id, sessionId)
    await store.appendMessage(chat.id, {
      _id: "local-command-1",
      createdAt: Date.parse("2026-04-01T10:00:00.000Z"),
      kind: "user_prompt",
      content: localCommandContent,
    })
    await store.appendMessage(chat.id, {
      _id: "local-command-output-1",
      createdAt: Date.parse("2026-04-01T10:00:00.000Z"),
      kind: "user_prompt",
      content: localCommandOutput,
    })
    await store.appendMessage(chat.id, {
      _id: "user-1",
      createdAt: Date.parse("2026-04-01T10:00:01.000Z"),
      kind: "user_prompt",
      content: "Now inspect the deployment config",
    })
    await store.appendMessage(chat.id, {
      _id: "assistant-1",
      createdAt: Date.parse("2026-04-01T10:00:02.000Z"),
      kind: "assistant_text",
      text: "I will inspect it.",
    })

    await syncExternalSessions({
      store,
      homeDir,
      discoveredProjects: [{
        localPath: projectDir,
        title: "Project",
        modifiedAt: Date.parse("2026-04-01T10:00:02.000Z"),
      }],
      generateTitle: async () => {
        throw new Error("title generation should not run for existing chats")
      },
      codexClient: {
        async listThreads() {
          return []
        },
        async readThread() {
          return null
        },
      },
    })

    const messages = store.getMessages(chat.id)
    expect(messageKinds(messages)).toEqual([
      "user_prompt",
      "user_prompt",
      "user_prompt",
      "assistant_text",
    ])
    expect(messages[0]).toMatchObject({
      kind: "user_prompt",
      content: localCommandContent,
    })
    expect(messages[1]).toMatchObject({
      kind: "user_prompt",
      content: localCommandOutput,
    })
    expect(messages[2]).toMatchObject({
      kind: "user_prompt",
      content: "Now inspect the deployment config",
    })
  })

  test("leaves existing Claude chats unchanged when local command filtering makes the source session empty", async () => {
    const homeDir = await createTempDir("kanna-sync-home-")
    const dataDir = await createTempDir("kanna-sync-data-")
    const projectDir = await createTempDir("kanna-sync-project-")
    const sessionId = "claude-exit-command-session"
    const sessionDir = join(homeDir, ".claude", "projects", projectFolderName(projectDir))
    await mkdir(sessionDir, { recursive: true })

    const localCommandOutput = "<local-command-stdout>Goodbye!</local-command-stdout>"
    await writeFile(join(sessionDir, `${sessionId}.jsonl`), [
      JSON.stringify({
        type: "user",
        sessionId,
        uuid: "local-command-output-1",
        timestamp: "2026-04-01T10:00:00.000Z",
        message: {
          role: "user",
          content: localCommandOutput,
        },
      }),
    ].join("\n"), "utf8")

    const store = new EventStore(dataDir)
    await store.initialize()

    const project = await store.openProject(projectDir)
    const chat = await store.createChat(project.id, { title: "Exit Command Session" })
    await store.setChatProvider(chat.id, "claude")
    await store.setSessionToken(chat.id, sessionId)
    await store.appendMessage(chat.id, {
      _id: "local-command-output-1",
      createdAt: Date.parse("2026-04-01T10:00:00.000Z"),
      kind: "user_prompt",
      content: localCommandOutput,
    })

    const logs: string[] = []
    await syncExternalSessions({
      store,
      homeDir,
      discoveredProjects: [{
        localPath: projectDir,
        title: "Project",
        modifiedAt: Date.parse("2026-04-01T10:00:00.000Z"),
      }],
      onProgress: (message) => {
        logs.push(message)
      },
      generateTitle: async () => {
        throw new Error("title generation should not run for existing chats")
      },
      codexClient: {
        async listThreads() {
          return []
        },
        async readThread() {
          return null
        },
      },
    })

    expect(store.getMessages(chat.id)).toMatchObject([{
      kind: "user_prompt",
      content: localCommandOutput,
    }])
    expect(logs).toContainEqual(
      expect.stringMatching(
        new RegExp(
          `^${escapeRegex(LOG_PREFIX)} session sync: processed 1/1 action=empty_skipped duration=\\d+ms provider=claude session=${escapeRegex(sessionId)} project=${escapeRegex(projectDir)}$`
        )
      )
    )
  })

  test("skips Claude service-only sessions during history import", async () => {
    const homeDir = await createTempDir("kanna-sync-home-")
    const dataDir = await createTempDir("kanna-sync-data-")
    const projectDir = await createTempDir("kanna-sync-project-")
    const sessionId = "claude-service-only-session"
    const sessionDir = join(homeDir, ".claude", "projects", projectFolderName(projectDir))
    await mkdir(sessionDir, { recursive: true })

    await writeFile(join(sessionDir, `${sessionId}.jsonl`), [
      JSON.stringify({
        type: "system",
        subtype: "init",
        sessionId,
        uuid: "system-1",
        timestamp: "2026-04-01T10:00:00.000Z",
        model: "claude-opus-4-7",
        tools: [],
      }),
      JSON.stringify({
        type: "user",
        sessionId,
        uuid: "resume-1",
        timestamp: "2026-04-01T10:00:01.000Z",
        message: {
          role: "user",
          content: "This session is being continued from a previous conversation that ran out of context.",
        },
      }),
      JSON.stringify({
        type: "system",
        subtype: "compact_boundary",
        sessionId,
        uuid: "compact-1",
        timestamp: "2026-04-01T10:00:02.000Z",
      }),
      JSON.stringify({
        type: "result",
        subtype: "success",
        sessionId,
        uuid: "result-1",
        timestamp: "2026-04-01T10:00:03.000Z",
        is_error: false,
        duration_ms: 10,
        result: "",
      }),
    ].join("\n"), "utf8")

    const store = new EventStore(dataDir)
    await store.initialize()
    let titleCalls = 0

    await syncExternalSessions({
      store,
      homeDir,
      discoveredProjects: [{
        localPath: projectDir,
        title: "Project",
        modifiedAt: Date.parse("2026-04-01T10:00:03.000Z"),
      }],
      generateTitle: async () => {
        titleCalls += 1
        throw new Error("title generation should not run for service-only sessions")
      },
      codexClient: {
        async listThreads() {
          return []
        },
        async readThread() {
          return null
        },
      },
    })

    expect(titleCalls).toBe(0)
    expect(store.listProjects()).toHaveLength(0)
  })

  test("skips importing external sessions with no messages", async () => {
    const homeDir = await createTempDir("kanna-sync-home-")
    const dataDir = await createTempDir("kanna-sync-data-")
    const claudeProjectDir = await createTempDir("kanna-sync-claude-project-")
    const codexProjectDir = await createTempDir("kanna-sync-codex-project-")
    const sessionDir = join(homeDir, ".claude", "projects", projectFolderName(claudeProjectDir))
    await mkdir(sessionDir, { recursive: true })
    await writeFile(join(sessionDir, "claude-empty.jsonl"), "", "utf8")

    const store = new EventStore(dataDir)
    await store.initialize()

    let titleCalls = 0
    await syncExternalSessions({
      store,
      homeDir,
      discoveredProjects: [
        {
          localPath: claudeProjectDir,
          title: "Claude Project",
          modifiedAt: Date.parse("2026-04-01T10:00:00.000Z"),
        },
        {
          localPath: codexProjectDir,
          title: "Codex Project",
          modifiedAt: Date.parse("2026-04-01T10:00:00.000Z"),
        },
      ],
      generateTitle: async () => {
        titleCalls += 1
        throw new Error("title generation should not run for empty chats")
      },
      codexClient: {
        async listThreads() {
          return [{
            id: "codex-empty",
            preview: "",
            ephemeral: false,
            modelProvider: "openai",
            createdAt: 1_710_000_000,
            updatedAt: 1_710_000_005,
            status: "idle",
            path: null,
            cwd: codexProjectDir,
            cliVersion: "0.0.0",
            source: "cli",
            name: "",
            turns: [],
          }]
        },
        async readThread() {
          return {
            id: "codex-empty",
            preview: "",
            ephemeral: false,
            modelProvider: "openai",
            createdAt: 1_710_000_000,
            updatedAt: 1_710_000_005,
            status: "idle",
            path: null,
            cwd: codexProjectDir,
            cliVersion: "0.0.0",
            source: "cli",
            name: "",
            turns: [],
          }
        },
      },
    })

    expect(titleCalls).toBe(0)
    expect(store.listProjects()).toHaveLength(0)
  })

  test("skips importing provider sessions hidden after chat edits", async () => {
    const homeDir = await createTempDir("kanna-sync-home-")
    const dataDir = await createTempDir("kanna-sync-data-")
    const projectDir = await createTempDir("kanna-sync-project-")
    const sessionId = "claude-superseded-session"
    const sessionDir = join(homeDir, ".claude", "projects", projectFolderName(projectDir))
    await mkdir(sessionDir, { recursive: true })
    await writeFile(join(sessionDir, `${sessionId}.jsonl`), [
      JSON.stringify({
        type: "user",
        sessionId,
        uuid: "user-1",
        timestamp: "2026-04-01T10:00:00.000Z",
        message: {
          role: "user",
          content: "Old prompt before edit",
        },
      }),
    ].join("\n"), "utf8")

    const store = new EventStore(dataDir)
    await store.initialize()
    await store.hideProviderSession("claude", sessionId)
    const logs: string[] = []
    let titleCalls = 0

    await syncExternalSessions({
      store,
      homeDir,
      discoveredProjects: [{
        localPath: projectDir,
        title: "Project",
        modifiedAt: Date.parse("2026-04-01T10:00:00.000Z"),
      }],
      onProgress: (message) => {
        logs.push(message)
      },
      generateTitle: async () => {
        titleCalls += 1
        throw new Error("title generation should not run for hidden provider sessions")
      },
      codexClient: {
        async listThreads() {
          return []
        },
        async readThread() {
          return null
        },
      },
    })

    expect(titleCalls).toBe(0)
    expect(store.listProjects()).toHaveLength(0)
    expect(logs).toContainEqual(
      expect.stringMatching(
        new RegExp(
          `^${escapeRegex(LOG_PREFIX)} session sync: processed 1/1 action=hidden duration=\\d+ms provider=claude session=${escapeRegex(sessionId)} project=${escapeRegex(projectDir)}$`
        )
      )
    )
    expect(logs.at(-1)).toMatch(
      new RegExp(`^${escapeRegex(LOG_PREFIX)} session sync: complete in \\d+ms; 1 processed, 0 created, 0 appended, 0 reconciled, 0 unchanged, 1 hidden, 0 empty skipped, 0 title skipped$`)
    )
  })

  test("skips importing a new external chat when title generation falls back", async () => {
    const homeDir = await createTempDir("kanna-sync-home-")
    const dataDir = await createTempDir("kanna-sync-data-")
    const projectDir = await createTempDir("kanna-sync-project-")
    const store = new EventStore(dataDir)
    await store.initialize()
    const logs: string[] = []

    await syncExternalSessions({
      store,
      homeDir,
      discoveredProjects: [{
        localPath: projectDir,
        title: "Project",
        modifiedAt: Date.parse("2026-04-01T10:00:05.000Z"),
      }],
      onProgress: (message) => {
        logs.push(message)
      },
      generateTitle: async () => ({
        title: "Please fix the login race and flaky...",
        usedFallback: true,
        failureMessage: "claude returned no result; codex returned no result",
        provider: null,
        attempts: [
          {
            provider: "claude",
            outcome: "no_result",
            durationMs: 5000,
          },
          {
            provider: "codex",
            outcome: "no_result",
            durationMs: 2500,
          },
        ],
      }),
      codexClient: {
        async listThreads() {
          return [{
            id: "thread-1",
            preview: "Please fix the login race and flaky retry loop in auth before release",
            ephemeral: false,
            modelProvider: "openai",
            createdAt: 1_710_000_000,
            updatedAt: 1_710_000_005,
            status: "idle",
            path: null,
            cwd: projectDir,
            cliVersion: "0.0.0",
            source: "cli",
            name: "",
            turns: [{
              id: "turn-1",
              status: "completed",
              error: null,
              items: [
                {
                  type: "userMessage",
                  id: "user-msg-1",
                  content: [{
                    type: "text",
                    text: "Please fix the login race and flaky retry loop in auth before release",
                    text_elements: [],
                  }],
                },
              ],
            }],
          }]
        },
        async readThread() {
          return {
            id: "thread-1",
            preview: "Please fix the login race and flaky retry loop in auth before release",
            ephemeral: false,
            modelProvider: "openai",
            createdAt: 1_710_000_000,
            updatedAt: 1_710_000_005,
            status: "idle",
            path: null,
            cwd: projectDir,
            cliVersion: "0.0.0",
            source: "cli",
            name: "",
            turns: [{
              id: "turn-1",
              status: "completed",
              error: null,
              items: [
                {
                  type: "userMessage",
                  id: "user-msg-1",
                  content: [{
                    type: "text",
                    text: "Please fix the login race and flaky retry loop in auth before release",
                    text_elements: [],
                  }],
                },
              ],
            }],
          }
        },
      },
    })

    expect(store.listProjects()).toHaveLength(0)
    expect(logs).toContainEqual(
      expect.stringMatching(
        new RegExp(
          `^${escapeRegex(LOG_PREFIX)} session sync: processed 1/1 action=title_skipped duration=\\d+ms provider=codex session=thread-1 project=${escapeRegex(projectDir)} title=fallback titleAttempts=claude:no_result:5000ms,codex:no_result:2500ms titleMs=\\d+ms$`
        )
      )
    )
  })

  test("excludes the Kanna data root from startup sync even when it exists in discovered and saved projects", async () => {
    const homeDir = await createTempDir("kanna-sync-home-")
    const dataDir = await createTempDir("kanna-sync-data-")
    const projectDir = await createTempDir("kanna-sync-project-")
    const internalProjectDir = getDataRootDir(homeDir)
    await mkdir(internalProjectDir, { recursive: true })
    const internalSessionId = "claude-internal-session"
    const internalSessionDir = join(homeDir, ".claude", "projects", projectFolderName(internalProjectDir))
    await mkdir(internalSessionDir, { recursive: true })
    await writeFile(join(internalSessionDir, `${internalSessionId}.jsonl`), [
      JSON.stringify({
        type: "user",
        sessionId: internalSessionId,
        uuid: "user-1",
        timestamp: "2026-04-01T10:00:00.000Z",
        message: {
          role: "user",
          content: "Internal quick-response session",
        },
      }),
    ].join("\n"), "utf8")

    const store = new EventStore(dataDir)
    await store.initialize()
    await store.openProject(internalProjectDir, "Internal")

    const codexCwds: string[] = []
    const logs: string[] = []

    await syncExternalSessions({
      store,
      homeDir,
      discoveredProjects: [
        {
          localPath: internalProjectDir,
          title: "Internal",
          modifiedAt: Date.parse("2026-04-01T10:00:00.000Z"),
        },
        {
          localPath: projectDir,
          title: "Project",
          modifiedAt: Date.parse("2026-04-01T10:00:00.000Z"),
        },
      ],
      onProgress: (message) => {
        logs.push(message)
      },
      generateTitle: async () => {
        throw new Error("title generation should not run for the internal workspace")
      },
      codexClient: {
        async listThreads({ cwd }) {
          codexCwds.push(cwd)
          return []
        },
        async readThread() {
          return null
        },
      },
    })

    const [internalProject] = store.listProjects()
    expect(internalProject?.localPath).toBe(internalProjectDir)
    expect(store.listChatsByProject(internalProject!.id)).toHaveLength(0)
    expect(codexCwds).toEqual([projectDir])
    expect(logs[0]).toBe(`${LOG_PREFIX} session sync: starting for 1 projects`)
    expect(logs.some((message) => message.includes(internalProjectDir))).toBe(false)
  })

  test("reports startup sync progress through onProgress", async () => {
    const homeDir = await createTempDir("kanna-sync-home-")
    const dataDir = await createTempDir("kanna-sync-data-")
    const projectDir = await createTempDir("kanna-sync-project-")
    const sessionId = "claude-session-logs"
    const sessionDir = join(homeDir, ".claude", "projects", projectFolderName(projectDir))
    await mkdir(sessionDir, { recursive: true })

    await writeFile(join(sessionDir, `${sessionId}.jsonl`), [
      JSON.stringify({
        type: "user",
        sessionId,
        uuid: "user-1",
        timestamp: "2026-04-01T10:00:00.000Z",
        message: {
          role: "user",
          content: "Inspect auth sync logs",
        },
      }),
    ].join("\n"), "utf8")

    const store = new EventStore(dataDir)
    await store.initialize()
    const logs: string[] = []

    await syncExternalSessions({
      store,
      homeDir,
      discoveredProjects: [{
        localPath: projectDir,
        title: "Project",
        modifiedAt: Date.parse("2026-04-01T10:00:00.000Z"),
      }],
      onProgress: (message) => {
        logs.push(message)
      },
      generateTitle: async () => ({
        title: "Auth logs",
        usedFallback: false,
        failureMessage: null,
        provider: "claude",
        attempts: [{
          provider: "claude",
          outcome: "success",
          durationMs: 12,
        }],
      }),
      codexClient: {
        async listThreads() {
          return []
        },
        async readThread() {
          return null
        },
      },
    })

    expect(logs[0]).toBe(`${LOG_PREFIX} session sync: starting for 1 projects`)
    expect(logs[1]).toBe(`${LOG_PREFIX} session sync: scanning Claude sessions`)
    expect(logs[2]).toMatch(new RegExp(`^${escapeRegex(LOG_PREFIX)} session sync: Claude scan complete in \\d+ms; 1 sessions$`))
    expect(logs[3]).toBe(`${LOG_PREFIX} session sync: scanning Codex sessions`)
    expect(logs[4]).toMatch(
      new RegExp(`^${escapeRegex(LOG_PREFIX)} session sync: Codex project 1/1 listThreads complete in \\d+ms \\(0 threads\\) path=${escapeRegex(projectDir)}$`)
    )
    expect(logs[5]).toMatch(
      new RegExp(`^${escapeRegex(LOG_PREFIX)} session sync: Codex project 1/1 readThread complete in \\d+ms \\(0 threads\\) path=${escapeRegex(projectDir)}$`)
    )
    expect(logs[6]).toMatch(new RegExp(`^${escapeRegex(LOG_PREFIX)} session sync: Codex scan complete in \\d+ms; 0 sessions$`))
    expect(logs[7]).toBe(`${LOG_PREFIX} session sync: found 1 external sessions (1 Claude, 0 Codex)`)
    expect(logs[8]).toBe(
      `${LOG_PREFIX} session sync: processing 1/1 provider=claude session=${sessionId} project=${projectDir}`
    )
    expect(logs[9]).toMatch(
      new RegExp(
        `^${escapeRegex(LOG_PREFIX)} session sync: processed 1/1 action=created\\+appended duration=\\d+ms provider=claude session=${escapeRegex(sessionId)} project=${escapeRegex(projectDir)} title=generated titleProvider=claude titleAttempts=claude:success:12ms titleMs=\\d+ms$`
      )
    )
    expect(logs[10]).toMatch(
      new RegExp(`^${escapeRegex(LOG_PREFIX)} session sync: complete in \\d+ms; 1 processed, 1 created, 1 appended, 0 reconciled, 0 unchanged, 0 hidden, 0 empty skipped, 0 title skipped$`)
    )
  })

  test("includes the Codex listThreads failure reason in startup logs", async () => {
    const homeDir = await createTempDir("kanna-sync-home-")
    const dataDir = await createTempDir("kanna-sync-data-")
    const projectDir = await createTempDir("kanna-sync-project-")
    const store = new EventStore(dataDir)
    await store.initialize()
    const logs: string[] = []

    await syncExternalSessions({
      store,
      homeDir,
      discoveredProjects: [{
        localPath: projectDir,
        title: "Project",
        modifiedAt: Date.parse("2026-04-01T10:00:00.000Z"),
      }],
      onProgress: (message) => {
        logs.push(message)
      },
      codexClient: {
        async listThreads() {
          throw new Error("spawn codex ENOENT")
        },
        async readThread() {
          return null
        },
      },
    })

    expect(logs).toContainEqual(
      expect.stringMatching(
        new RegExp(
          `^${escapeRegex(LOG_PREFIX)} session sync: Codex project 1/1 listThreads failed in \\d+ms path=${escapeRegex(projectDir)} error=spawn codex ENOENT$`
        )
      )
    )
  })

  test("merges Codex API history into an existing chat without duplicating already logged transcript entries", async () => {
    const homeDir = await createTempDir("kanna-sync-home-")
    const dataDir = await createTempDir("kanna-sync-data-")
    const projectDir = await createTempDir("kanna-sync-project-")
    const store = new EventStore(dataDir)
    await store.initialize()

    const project = await store.openProject(projectDir)
    const chat = await store.createChat(project.id)
    await store.setChatProvider(chat.id, "codex")
    await store.setSessionToken(chat.id, "thread-1")
    await store.setTurnResumePending(chat.id, true)
    await store.renameChat(chat.id, "Manual alias")
    await store.appendMessage(chat.id, {
      _id: "user-1",
      createdAt: 1,
      kind: "user_prompt",
      content: "Hello",
    })
    await store.appendMessage(chat.id, {
      _id: "assistant-1",
      createdAt: 2,
      kind: "assistant_text",
      text: "Hi there",
    })

    await syncExternalSessions({
      store,
      homeDir,
      discoveredProjects: [{
        localPath: projectDir,
        title: "Project",
        modifiedAt: Date.parse("2026-04-01T10:00:05.000Z"),
      }],
      generateTitle: async () => {
        throw new Error("title generation should not run for existing chats")
      },
      codexClient: {
        async listThreads() {
          return [{
            id: "thread-1",
            preview: "Hello",
            ephemeral: false,
            modelProvider: "openai",
            createdAt: 1_710_000_000,
            updatedAt: 1_710_000_005,
            status: "idle",
            path: null,
            cwd: projectDir,
            cliVersion: "0.0.0",
            source: "cli",
            name: "Provider title",
            turns: [],
          }]
        },
        async readThread() {
          return {
            id: "thread-1",
            preview: "Hello",
            ephemeral: false,
            modelProvider: "openai",
            createdAt: 1_710_000_000,
            updatedAt: 1_710_000_005,
            status: "idle",
            path: null,
            cwd: projectDir,
            cliVersion: "0.0.0",
            source: "cli",
            name: "Provider title",
            turns: [{
              id: "turn-1",
              status: "completed",
              error: null,
              items: [
                {
                  type: "userMessage",
                  id: "user-msg-1",
                  content: [{ type: "text", text: "Hello", text_elements: [] }],
                },
                {
                  type: "agentMessage",
                  id: "assistant-msg-1",
                  text: "Hi there",
                },
                {
                  type: "commandExecution",
                  id: "cmd-1",
                  command: "pwd",
                  status: "completed",
                  aggregatedOutput: "/tmp/project\n",
                  exitCode: 0,
                },
              ],
            }],
          }
        },
      },
    })

    const syncedChat = store.getChat(chat.id)
    expect(syncedChat?.title).toBe("Manual alias")
    expect(syncedChat?.resumePending).toBeUndefined()

    const messages = store.getMessages(chat.id)
    expect(messageKinds(messages)).toEqual([
      "user_prompt",
      "assistant_text",
      "tool_call",
      "tool_result",
    ])
    expect(messages[2]).toMatchObject({
      kind: "tool_call",
    })
    expect(messages[3]).toMatchObject({
      kind: "tool_result",
      toolId: "cmd-1",
      content: "/tmp/project\n",
    })
  })

  test("rewrites diverged provider history while preserving anchored Kanna-specific entries", async () => {
    const homeDir = await createTempDir("kanna-sync-home-")
    const dataDir = await createTempDir("kanna-sync-data-")
    const projectDir = await createTempDir("kanna-sync-project-")
    const store = new EventStore(dataDir)
    await store.initialize()

    const project = await store.openProject(projectDir)
    const chat = await store.createChat(project.id)
    await store.setChatProvider(chat.id, "codex")
    await store.setSessionToken(chat.id, "thread-1")
    await store.appendMessage(chat.id, {
      _id: "user-1",
      createdAt: 1,
      kind: "user_prompt",
      content: "Old prompt",
    })
    await store.appendMessage(chat.id, {
      _id: "assistant-1",
      createdAt: 2,
      kind: "assistant_text",
      text: "Old answer",
    })
    await store.appendMessage(chat.id, {
      _id: "tool-call-1",
      createdAt: 3,
      kind: "tool_call",
      tool: {
        kind: "tool",
        toolKind: "ask_user_question",
        toolName: "AskUserQuestion",
        toolId: "ask-1",
        input: { questions: [{ question: "Continue?" }] },
      },
    })
    await store.appendMessage(chat.id, {
      _id: "tool-result-1",
      createdAt: 4,
      kind: "tool_result",
      toolId: "ask-1",
      content: { answers: { Continue: ["Yes"] } },
    })
    await store.appendMessage(chat.id, {
      _id: "assistant-2",
      createdAt: 5,
      kind: "assistant_text",
      text: "Shared tail",
    })

    await syncExternalSessions({
      store,
      homeDir,
      discoveredProjects: [{
        localPath: projectDir,
        title: "Project",
        modifiedAt: Date.parse("2026-04-01T10:00:02.000Z"),
      }],
      codexClient: {
        async listThreads() {
          return [{
            id: "thread-1",
            preview: "New prompt",
            ephemeral: false,
            modelProvider: "openai",
            createdAt: 1_710_000_000,
            updatedAt: 1_710_000_010,
            status: "idle",
            path: null,
            cwd: projectDir,
            cliVersion: "0.0.0",
            source: "cli",
            name: "Provider title",
            turns: [],
          }]
        },
        async readThread() {
          return {
            id: "thread-1",
            preview: "New prompt",
            ephemeral: false,
            modelProvider: "openai",
            createdAt: 1_710_000_000,
            updatedAt: 1_710_000_010,
            status: "idle",
            path: null,
            cwd: projectDir,
            cliVersion: "0.0.0",
            source: "cli",
            name: "Provider title",
            turns: [{
              id: "turn-1",
              status: "completed",
              error: null,
              items: [
                {
                  type: "userMessage",
                  id: "user-msg-1",
                  content: [{ type: "text", text: "New prompt", text_elements: [] }],
                },
                {
                  type: "agentMessage",
                  id: "assistant-msg-1",
                  text: "New answer",
                },
                {
                  type: "agentMessage",
                  id: "assistant-msg-2",
                  text: "Shared tail",
                },
              ],
            }],
          }
        },
      },
    })

    const messages = store.getMessages(chat.id)
    expect(messages).toMatchObject([
      { kind: "user_prompt", content: "New prompt" },
      { kind: "assistant_text", text: "New answer" },
      {
        kind: "tool_call",
        tool: {
          toolKind: "ask_user_question",
          toolId: "ask-1",
        },
      },
      {
        kind: "tool_result",
        toolId: "ask-1",
      },
      { kind: "assistant_text", text: "Shared tail" },
    ])
    expect(messages.map((entry) => entry.kind)).toEqual([
      "user_prompt",
      "assistant_text",
      "tool_call",
      "tool_result",
      "assistant_text",
    ])

    const transcriptSyncPath = join(dataDir, "transcript-sync", `${chat.id}.json`)
    const transcriptSync = JSON.parse(await readFile(transcriptSyncPath, "utf8")) as {
      canonicalHash: string
      providerSequence: unknown[]
    }
    expect(typeof transcriptSync.canonicalHash).toBe("string")
    expect(transcriptSync.providerSequence).toHaveLength(3)
  })
})
