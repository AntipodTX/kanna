import { describe, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import type { StartupSyncSnapshot } from "../../shared/types"
import { isStartupSyncDialogBlocking, StartupSyncProgressDialog } from "./StartupSyncProgressDialog"

describe("StartupSyncProgressDialog", () => {
  test("renders startup sync messages while sync is running", () => {
    const snapshot: StartupSyncSnapshot = {
      enabled: true,
      mode: "session-sync",
      status: "running",
      messages: [
        "[kanna] session sync: starting for 2 projects",
        "[kanna] session sync: scanning Claude sessions",
      ],
      startedAt: 1,
      completedAt: null,
      error: null,
    }

    const html = renderToStaticMarkup(
      <StartupSyncProgressDialog snapshot={snapshot} onDismiss={() => {}} />
    )

    expect(html).toContain("Synchronizing Sessions")
    expect(html).toContain('role="dialog"')
    expect(html).toContain('aria-modal="true"')
    expect(html).toContain('tabindex="-1"')
    expect(html).toContain("bg-slate-950/55")
    expect(html).toContain("[kanna] session sync: starting for 2 projects")
    expect(html).toContain("[kanna] session sync: scanning Claude sessions")
    expect(html).not.toContain("Close")
  })

  test("renders completion state with a close action", () => {
    const snapshot: StartupSyncSnapshot = {
      enabled: true,
      mode: "session-sync",
      status: "completed",
      messages: ["[kanna] session sync: complete in 42ms; 1 processed"],
      startedAt: 1,
      completedAt: 2,
      error: null,
    }

    const html = renderToStaticMarkup(
      <StartupSyncProgressDialog snapshot={snapshot} onDismiss={() => {}} />
    )

    expect(html).toContain("Session Sync Complete")
    expect(html).toContain("[kanna] session sync: complete in 42ms; 1 processed")
    expect(html).toContain("Close")
  })

  test("renders storage recovery messages with a close action", () => {
    const snapshot: StartupSyncSnapshot = {
      enabled: true,
      mode: "storage-recovery",
      status: "completed",
      messages: [
        "[kanna] storage recovery: corrupt snapshot backed up to /tmp/snapshot.json",
      ],
      startedAt: 1,
      completedAt: 2,
      error: null,
    }

    const html = renderToStaticMarkup(
      <StartupSyncProgressDialog snapshot={snapshot} onDismiss={() => {}} />
    )

    expect(html).toContain("Storage Recovery Mode")
    expect(html).toContain("corrupt snapshot backed up")
    expect(html).toContain("Close")
  })

  test("keeps completed startup dialogs blocking until dismissed", () => {
    expect(isStartupSyncDialogBlocking({
      enabled: true,
      mode: "storage-recovery",
      status: "completed",
      messages: [],
      startedAt: 1,
      completedAt: 2,
      error: null,
    })).toBe(true)
    expect(isStartupSyncDialogBlocking({
      enabled: true,
      mode: "session-sync",
      status: "completed",
      messages: [],
      startedAt: 1,
      completedAt: 2,
      error: null,
    })).toBe(true)
    expect(isStartupSyncDialogBlocking({
      enabled: false,
      mode: "session-sync",
      status: "idle",
      messages: [],
      startedAt: null,
      completedAt: null,
      error: null,
    })).toBe(false)
  })
})
