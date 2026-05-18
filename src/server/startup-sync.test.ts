import { describe, expect, test } from "bun:test"
import { StartupSyncProgress } from "./startup-sync"

describe("StartupSyncProgress", () => {
  test("records session sync messages and publishes lifecycle snapshots", () => {
    const startupSync = new StartupSyncProgress()
    const snapshots = [startupSync.getSnapshot()]
    startupSync.onChange((snapshot) => snapshots.push(snapshot))

    startupSync.begin()
    startupSync.append("[kanna] session sync: scanning Claude sessions")
    startupSync.complete()

    expect(snapshots[0]).toMatchObject({
      enabled: false,
      mode: "session-sync",
      status: "idle",
      messages: [],
      startedAt: null,
      completedAt: null,
      error: null,
    })
    expect(snapshots[1]).toMatchObject({
      enabled: true,
      mode: "session-sync",
      status: "running",
      messages: [],
      completedAt: null,
      error: null,
    })
    expect(snapshots[2]).toMatchObject({
      enabled: true,
      mode: "session-sync",
      status: "running",
      messages: ["[kanna] session sync: scanning Claude sessions"],
    })
    expect(snapshots[3]).toMatchObject({
      enabled: true,
      mode: "session-sync",
      status: "completed",
      messages: ["[kanna] session sync: scanning Claude sessions"],
      error: null,
    })
    expect(snapshots[3].completedAt).toBeNumber()
  })

  test("marks failed sync attempts with the error message", () => {
    const startupSync = new StartupSyncProgress()

    startupSync.begin()
    startupSync.fail(new Error("boom"))

    expect(startupSync.getSnapshot()).toMatchObject({
      enabled: true,
      mode: "session-sync",
      status: "failed",
      error: "boom",
    })
  })
})
