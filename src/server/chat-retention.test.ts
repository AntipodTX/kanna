import { expect, spyOn, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { EventStore } from "./event-store"
import { startKannaServer } from "./server"

test("startup and restart retain old chats and drafts until explicit removal", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "kanna-chat-retention-"))
  let server: Awaited<ReturnType<typeof startKannaServer>> | undefined
  const intervalSpy = spyOn(globalThis, "setInterval")
  try {
    const seed = new EventStore(dataDir)
    await seed.initialize()
    const project = await seed.openProject(dataDir)
    const chats = []
    for (const [index, ageDays] of [120, 45, 120, 120, 0].entries()) {
      const chat = await seed.createChat(project.id)
      const at = Date.now() - ageDays * 86400000
      chat.createdAt = at
      chat.updatedAt = at
      if (index !== 0) await seed.appendMessage(chat.id, {
        _id: `message-${index}`, kind: "user_prompt", createdAt: at, content: `History ${index}`,
      })
      if (index === 3) await seed.archiveChat(chat.id)
      chats.push({ id: chat.id, archivedAt: seed.requireChat(chat.id).archivedAt })
    }
    await seed.compact()

    for (let boot = 0; boot < 2; boot++) {
      server = await startKannaServer({ dataDir, port: 0, password: null })
      // Reading a transcript joins the store's write queue, after startup work.
      await server.store.prepareTranscript(chats[4]!.id)
      for (const [index, chat] of chats.entries()) {
        expect(server.store.getChat(chat.id)?.id).toBe(chat.id)
        expect(server.store.getChat(chat.id)?.archivedAt).toBe(chat.archivedAt)
        if (index !== 0) expect(await readFile(path.join(dataDir, "transcripts", `${chat.id}.jsonl`), "utf8"))
          .toContain(`History ${index}`)
      }
      if (boot === 0) {
        await server.stop()
        server = undefined
      }
    }
    const cleanupTimers = intervalSpy.mock.calls.filter(([callback]) =>
      typeof callback === "function" && /PruneStale|AutoArchiveStale|DeleteStale/.test(callback.name))
    expect(cleanupTimers).toHaveLength(0)

    await server!.store.archiveChat(chats[1]!.id)
    expect(server!.store.requireChat(chats[1]!.id).archivedAt).toBeNumber()
    await server!.store.unarchiveChat(chats[1]!.id)
    expect(server!.store.requireChat(chats[1]!.id).archivedAt).toBeUndefined()
    await server!.store.deleteChat(chats[0]!.id)
    expect(server!.store.getChat(chats[0]!.id)).toBeNull()
  } finally {
    intervalSpy.mockRestore()
    await server?.stop()
    await rm(dataDir, { recursive: true, force: true })
  }
}, 30000)
