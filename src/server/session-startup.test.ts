import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { startKannaServer } from "./server"
import { PROTOCOL_VERSION, type StartupSyncSnapshot } from "../shared/types"

const tempDirs: string[] = []
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})
async function isolatedOptions() {
  const homeDir = await mkdtemp(path.join(tmpdir(), "kanna-session-startup-"))
  tempDirs.push(homeDir)
  return { homeDir, dataDir: path.join(homeDir, "data"), port: 4388, strictPort: true }
}

describe("optional startup session import", () => {
  test("waits for reconciliation before resuming turns while serving progress", async () => {
    let finishSync!: () => void
    const syncGate = new Promise<void>(resolve => { finishSync = resolve })
    const order: string[] = []
    const server = await startKannaServer({
      ...await isolatedOptions(), syncSessions: true,
      sessionSync: async ({ onProgress }) => {
        order.push("sync")
        onProgress?.("scanning provider history")
        await syncGate
      },
      resumeTurns: async () => { order.push("resume"); return [] },
    })
    try {
      expect(order).toEqual(["sync"])
      const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`)
      const snapshot = await new Promise<StartupSyncSnapshot>((resolve, reject) => {
        ws.onopen = () => ws.send(JSON.stringify({ v: PROTOCOL_VERSION, type: "subscribe", id: "progress", topic: { type: "startup-sync" } }))
        ws.onerror = reject
        ws.onmessage = event => {
          const message = JSON.parse(String(event.data))
          if (message.type === "snapshot" && message.id === "progress") resolve(message.snapshot.data)
        }
      })
      ws.close()
      expect(snapshot).toMatchObject({ status: "running", messages: ["scanning provider history"] })
      finishSync()
      await server.startupSyncDone
      expect(order).toEqual(["sync", "resume"])
    } finally {
      finishSync()
      await server.stop()
    }
  })

  test("keeps import opt-in and blocks automatic resume after sync failure", async () => {
    let imports = 0
    let resumes = 0
    for (const enabled of [false, true]) {
      const server = await startKannaServer({
        ...await isolatedOptions(), syncSessions: enabled,
        sessionSync: async () => { imports++; throw new Error("cannot reconcile") },
        resumeTurns: async () => { resumes++; return [] },
      })
      try { await server.startupSyncDone } finally { await server.stop() }
    }
    expect(imports).toBe(1)
    expect(resumes).toBe(1)
  })
})
