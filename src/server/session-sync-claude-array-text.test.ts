import { afterEach, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { EventStore } from "./event-store"
import { syncExternalSessions } from "./session-sync"

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

async function nativeClaudeFixture(rows: unknown[]) {
  const root = await mkdtemp(join(tmpdir(), "kanna-claude-array-import-"))
  tempDirs.push(root)
  const homeDir = join(root, "home")
  const dataDir = join(root, "data")
  const projectDir = join(root, "project")
  await mkdir(projectDir, { recursive: true })
  const sessionDir = join(homeDir, ".claude", "projects", projectDir.replaceAll("/", "-"))
  await mkdir(sessionDir, { recursive: true })
  const sessionFile = join(sessionDir, "native-array-session.jsonl")
  async function writeRows(nextRows: unknown[]) {
    await writeFile(sessionFile, nextRows.map(row => JSON.stringify(row)).join("\n"))
  }
  await writeRows(rows)
  const store = new EventStore(dataDir)
  await store.initialize()
  const titlePrompts: string[] = []
  const args = {
    store,
    homeDir,
    discoveredProjects: [{ localPath: projectDir, title: "Project", modifiedAt: Date.now() }],
    generateTitle: async (content: string) => {
      titlePrompts.push(content)
      return { title: "Imported", usedFallback: false, failureMessage: null }
    },
    codexClient: { async listThreads() { return [] }, async readThread() { return null } },
  }
  return { store, dataDir, args, writeRows, titlePrompts }
}

test("imports ordinary Claude text blocks in order without tool output, and keeps stable IDs on reimport", async () => {
  const rows = [
    { type: "user", uuid: "first", timestamp: "2026-10-01T10:00:00.000Z", message: { role: "user", content: [{ type: "text", text: "Build app" }] } },
    { type: "user", uuid: "second", timestamp: "2026-10-01T10:01:00.000Z", message: { role: "user", content: [
      { type: "text", text: "Add search" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "AA==" } },
      { type: "tool_result", tool_use_id: "native-tool", content: "Tool output is not user text" },
      { type: "text", text: "Sort results" },
    ] } },
    { type: "assistant", uuid: "answer", timestamp: "2026-10-01T10:02:00.000Z", message: { role: "assistant", content: [{ type: "text", text: "Done" }] } },
  ]
  const fixture = await nativeClaudeFixture(rows)
  await syncExternalSessions(fixture.args)
  const project = fixture.store.listProjects()[0]!
  const chat = fixture.store.listChatsByProject(project.id)[0]!
  const entries = fixture.store.getMessages(chat.id)
  expect(entries.filter(entry => entry.kind === "user_prompt").map(entry => entry.content)).toEqual([
    "Build app", "Add search\nSort results",
  ])
  expect(entries.filter(entry => entry.kind === "tool_result")).toMatchObject([
    { toolId: "native-tool", content: "Tool output is not user text" },
  ])
  expect(fixture.titlePrompts).toEqual(["Build app"])
  await syncExternalSessions(fixture.args)
  expect(fixture.store.getMessages(chat.id)).toEqual(entries)
  const replayed = new EventStore(fixture.dataDir)
  await replayed.initialize()
  await syncExternalSessions({ ...fixture.args, store: replayed })
  expect(replayed.getMessages(chat.id)).toEqual(entries)
  await fixture.writeRows([{ ...rows[0], message: { role: "user", content: "Build app" } }, ...rows.slice(1)])
  await syncExternalSessions({ ...fixture.args, store: replayed })
  expect(replayed.getMessages(chat.id).map(entry => entry._id)).toEqual(entries.map(entry => entry._id))
  expect(replayed.getMessages(chat.id).filter(entry => entry.kind === "user_prompt")).toHaveLength(2)
})

test("keeps existing Claude service filters for array content and preserves native results and compaction", async () => {
  const text = (value: string) => [{ type: "text", text: value }]
  const fixture = await nativeClaudeFixture([
    { type: "user", uuid: "ordinary", message: { role: "user", content: text("Ordinary prompt") } },
    { type: "user", uuid: "meta", isMeta: true, message: { role: "user", content: text("Internal instruction") } },
    { type: "user", uuid: "resume", message: { role: "user", content: text("This session is being continued after compaction.") } },
    { type: "user", uuid: "command", message: { role: "user", content: [
      { type: "text", text: "<command-name>/clear</command-name>" },
      { type: "text", text: "<local-command-stdout>Cleared</local-command-stdout>" },
    ] } },
    { type: "user", uuid: "result", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "native-tool", content: "Native result" }] } },
    { type: "user", uuid: "image", message: { role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "AA==" } }] } },
    { type: "user", uuid: "empty", message: { role: "user", content: text(" \n ") } },
    { type: "user", uuid: "attachment-only", message: { role: "user", content: text("Please inspect the attached files.\n<kanna-attachments>internal metadata</kanna-attachments>") } },
  ])
  await syncExternalSessions(fixture.args)
  const project = fixture.store.listProjects()[0]!
  const chat = fixture.store.listChatsByProject(project.id)[0]!
  const entries = fixture.store.getMessages(chat.id)
  expect(entries.filter(entry => entry.kind === "user_prompt").map(entry => entry.content)).toEqual(["Ordinary prompt"])
  expect(entries.filter(entry => entry.kind === "compact_summary")).toMatchObject([{ summary: "This session is being continued after compaction." }])
  expect(entries.filter(entry => entry.kind === "tool_result")).toMatchObject([{ toolId: "native-tool", content: "Native result" }])
})
