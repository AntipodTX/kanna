import { describe, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import type { StartupSyncSnapshot } from "../../shared/types"
import { StartupSyncProgressDialog } from "./StartupSyncProgressDialog"

describe("StartupSyncProgressDialog", () => {
  test("renders startup sync messages while sync is running", () => {
    const snapshot: StartupSyncSnapshot = {
      enabled: true,
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
})
