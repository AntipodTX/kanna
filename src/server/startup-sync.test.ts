import { describe, expect, test } from "bun:test"
import { StartupSyncProgress } from "./startup-sync"

describe("StartupSyncProgress", () => {
  test("records session sync messages and publishes lifecycle snapshots", () => {
    const progress = new StartupSyncProgress()
    const snapshots = [progress.getSnapshot()]
    const unsubscribe = progress.onChange((snapshot) => snapshots.push(snapshot))

    progress.begin()
    progress.append("[kanna] session sync: starting for 2 projects")
    progress.append("[kanna] session sync: complete in 42ms; 1 processed")
    progress.complete()
    unsubscribe()

    expect(snapshots.map((snapshot) => snapshot.status)).toEqual([
      "idle",
      "running",
      "running",
      "running",
      "completed",
    ])
    expect(progress.getSnapshot()).toMatchObject({
      enabled: true,
      status: "completed",
      error: null,
      messages: [
        "[kanna] session sync: starting for 2 projects",
        "[kanna] session sync: complete in 42ms; 1 processed",
      ],
    })
    expect(progress.getSnapshot().startedAt).toEqual(expect.any(Number))
    expect(progress.getSnapshot().completedAt).toEqual(expect.any(Number))
  })

  test("marks failed sync attempts with the error message", () => {
    const progress = new StartupSyncProgress()

    progress.begin()
    progress.fail(new Error("sync exploded"))

    expect(progress.getSnapshot()).toMatchObject({
      enabled: true,
      status: "failed",
      error: "sync exploded",
    })
  })
})
