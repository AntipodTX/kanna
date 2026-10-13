import { describe, expect, test } from "bun:test"
import type { ClientCommand, ServerEnvelope, SubscriptionTopic } from "../shared/protocol"
import type { ChatDiffSnapshot, ChatSnapshot, SidebarData, StartupSyncSnapshot } from "../shared/types"
import { DEMO_UNAVAILABLE_MESSAGE, DemoBackend, type DemoClock } from "./backend"
import { createUnifiedPatch } from "./patch"
import { DEMO_FEATURED_CHAT_ID } from "./scenario"

class ManualClock implements DemoClock {
  private time = 1_800_000_000_000
  private nextHandle = 1
  private timers = new Map<number, { at: number; callback: () => void }>()

  now() {
    return this.time
  }

  setTimeout(callback: () => void, ms: number) {
    const handle = this.nextHandle++
    this.timers.set(handle, { at: this.time + ms, callback })
    return handle
  }

  clearTimeout(handle: unknown) {
    this.timers.delete(handle as number)
  }

  /** Runs timers in order until none are left, or `limitMs` has passed. */
  advance(limitMs = 600_000) {
    const end = this.time + limitMs
    for (;;) {
      const due = [...this.timers.entries()].sort((left, right) => left[1].at - right[1].at)[0]
      if (!due || due[1].at > end) break
      this.timers.delete(due[0])
      this.time = due[1].at
      due[1].callback()
    }
    this.time = end
  }
}

function findLast<T>(items: readonly T[], predicate: (item: T) => boolean) {
  return [...items].reverse().find(predicate)
}

function createHarness() {
  const clock = new ManualClock()
  const sent: ServerEnvelope[] = []
  const backend = new DemoBackend((envelope) => sent.push(envelope), clock)
  let nextId = 0

  function subscribe(topic: SubscriptionTopic) {
    const id = `sub-${++nextId}`
    backend.receive({ v: 1, type: "subscribe", id, topic })
    return id
  }

  function latest<T>(subscriptionId: string): T {
    const envelope = findLast(sent, (candidate) => candidate.type === "snapshot" && candidate.id === subscriptionId)
    if (!envelope || envelope.type !== "snapshot") throw new Error(`No snapshot for ${subscriptionId}`)
    return envelope.snapshot.data as T
  }

  function command(value: ClientCommand) {
    const id = `cmd-${++nextId}`
    backend.receive({ v: 1, type: "command", id, command: value })
    const reply = sent.find((candidate) => (candidate.type === "ack" || candidate.type === "error") && candidate.id === id)
    if (!reply) throw new Error(`No reply to ${value.type}`)
    if (reply.type === "error") throw new Error(reply.message)
    return (reply as Extract<ServerEnvelope, { type: "ack" }>).result
  }

  return { backend, clock, sent, subscribe, latest, command }
}

function findRow(sidebar: SidebarData, chatId: string) {
  return sidebar.projectGroups.flatMap((group) => group.chats).find((chat) => chat.chatId === chatId)
}

describe("DemoBackend", () => {
  test("startup sync is disabled and idle so the demo does not block on native imports", () => {
    const { subscribe, latest } = createHarness()
    const snapshot = latest<StartupSyncSnapshot>(subscribe({ type: "startup-sync" }))

    expect(snapshot).toEqual({
      enabled: false,
      mode: "session-sync",
      status: "idle",
      messages: [],
      startedAt: null,
      completedAt: null,
      error: null,
    } satisfies StartupSyncSnapshot)
  })

  test("opens with a chat running, one waiting on the user, and one unread", () => {
    const { subscribe, latest } = createHarness()
    const sidebar = latest<SidebarData>(subscribe({ type: "sidebar", patches: true }))

    expect(sidebar.projectGroups.map((group) => group.title)).toEqual(["tidepool", "ledger-api", "portfolio"])
    expect(findRow(sidebar, "demo-chat-readme")?.status).toBe("running")
    expect(findRow(sidebar, "demo-chat-deploy")).toMatchObject({ status: "waiting_for_user", pendingToolKind: "ask_user_question" })
    expect(findRow(sidebar, "demo-chat-safari")).toMatchObject({ status: "idle", unread: true })
    expect(findRow(sidebar, DEMO_FEATURED_CHAT_ID)).toMatchObject({ status: "idle", uncommittedWork: true })
    // Its fix was committed, so it no longer claims the working tree.
    expect(findRow(sidebar, "demo-chat-safari")?.uncommittedWork).toBeUndefined()
  })

  test("the running chat finishes on its own once started", () => {
    const { backend, clock, subscribe, latest } = createHarness()
    const sidebarId = subscribe({ type: "sidebar" })
    backend.start()
    clock.advance()

    expect(findRow(latest<SidebarData>(sidebarId), "demo-chat-readme")).toMatchObject({ status: "idle", unread: true })
    const git = latest<ChatDiffSnapshot>(subscribe({ type: "project-git", projectId: "demo-project-ledger" }))
    expect(git.files.map((file) => file.path)).toEqual(["README.md"])
  })

  test("the featured chat's edits are uncommitted, the Safari fix is not", () => {
    const { subscribe, latest, command } = createHarness()
    const chat = latest<ChatSnapshot>(subscribe({ type: "chat", chatId: DEMO_FEATURED_CHAT_ID }))
    expect(chat.messages.at(-1)?.kind).toBe("result")
    expect(chat.messages.filter((entry) => entry.kind === "tool_call").length).toBeGreaterThan(5)

    const git = latest<ChatDiffSnapshot>(subscribe({ type: "project-git", projectId: "demo-project-tidepool" }))
    expect(git.files.map((file) => [file.path, file.changeType])).toEqual([
      ["src/components/ForecastCard.tsx", "modified"],
      ["src/hooks/useHeightUnit.ts", "added"],
      ["src/lib/units.test.ts", "added"],
      ["src/lib/units.ts", "modified"],
    ])

    const { patch } = command({ type: "project.readDiffPatch", projectId: "demo-project-tidepool", path: "src/lib/units.ts" }) as { patch: string }
    expect(patch).toContain("-export function formatFeet(meters: number) {")
    expect(patch).toContain("+export function formatHeight(meters: number, unit: HeightUnit) {")
  })

  test("a prompt plays a scripted turn that writes PLAN.md", () => {
    const { clock, subscribe, latest, command } = createHarness()
    const chatId = subscribe({ type: "chat", chatId: DEMO_FEATURED_CHAT_ID })

    command({ type: "chat.send", chatId: DEMO_FEATURED_CHAT_ID, content: "Show the swell direction as an arrow", attachments: [] })
    expect(latest<ChatSnapshot>(chatId).runtime.status).toBe("running")

    clock.advance()
    const chat = latest<ChatSnapshot>(chatId)
    expect(chat.runtime.status).toBe("idle")
    expect(chat.messages.at(-1)?.kind).toBe("result")
    const grep = chat.messages.find((entry) => entry.kind === "tool_call" && entry.tool.toolKind === "grep" && entry.tool.input.pattern === "direction")
    expect(grep).toBeDefined()

    const git = latest<ChatDiffSnapshot>(subscribe({ type: "project-git", projectId: "demo-project-tidepool" }))
    expect(git.files.map((file) => file.path)).toContain("PLAN.md")
  })

  test("a prompt without a chat creates one named after it", () => {
    const { subscribe, latest, command } = createHarness()
    const sidebarId = subscribe({ type: "sidebar" })
    const { chatId } = command({
      type: "chat.send",
      projectId: "demo-project-portfolio",
      content: "add a contact form to the footer",
      attachments: [],
      provider: "codex",
      model: "gpt-5.5",
    }) as { chatId: string }

    expect(findRow(latest<SidebarData>(sidebarId), chatId)).toMatchObject({
      title: "Add a contact form to the footer",
      provider: "codex",
      status: "running",
    })
  })

  test("answering the deploy question finishes the turn with that host", () => {
    const { clock, subscribe, latest, command } = createHarness()
    const chatId = subscribe({ type: "chat", chatId: "demo-chat-deploy" })
    const question = findLast(latest<ChatSnapshot>(chatId).messages, (entry) => entry.kind === "tool_call")
    if (question?.kind !== "tool_call") throw new Error("expected the question")

    command({
      type: "chat.respondTool",
      chatId: "demo-chat-deploy",
      toolUseId: question.tool.toolId,
      result: { questions: [], answers: { "Where should tidepool deploy?": ["Vercel"] } },
    })
    clock.advance()

    const chat = latest<ChatSnapshot>(chatId)
    expect(chat.runtime.status).toBe("idle")
    const summary = findLast(chat.messages, (entry) => entry.kind === "assistant_text")
    expect(summary?.kind === "assistant_text" && summary.text).toContain("VERCEL_TOKEN")
  })

  test("cancel interrupts a running turn", () => {
    const { clock, subscribe, latest, command } = createHarness()
    const chatId = subscribe({ type: "chat", chatId: DEMO_FEATURED_CHAT_ID })
    command({ type: "chat.send", chatId: DEMO_FEATURED_CHAT_ID, content: "hello there", attachments: [] })
    clock.advance(1_000)
    command({ type: "chat.cancel", chatId: DEMO_FEATURED_CHAT_ID })
    clock.advance()

    const chat = latest<ChatSnapshot>(chatId)
    expect(chat.runtime.status).toBe("idle")
    expect(chat.messages.at(-1)?.kind).toBe("interrupted")
  })

  test("the terminal answers from the project's files", () => {
    const { sent, command, subscribe } = createHarness()
    subscribe({ type: "terminal", terminalId: "term-1" })
    command({ type: "terminal.create", projectId: "demo-project-tidepool", terminalId: "term-1", cols: 80, rows: 24, scrollback: 1000 })
    command({ type: "terminal.input", terminalId: "term-1", data: "ls\r" })

    const output = sent
      .flatMap((envelope) => (envelope.type === "event" && envelope.event.type === "terminal.output" ? [envelope.event.data] : []))
      .join("")
    expect(output).toContain("README.md  package.json  src")
  })

  test("commands outside the demo fail with a pointer to the install", () => {
    const { command } = createHarness()
    expect(() => command({ type: "project.clone", cloneUrl: "https://github.com/a/b", localPath: "/tmp/b", title: "b" }))
      .toThrow(DEMO_UNAVAILABLE_MESSAGE)
  })

  test("snapshots only go out when they change", () => {
    const { sent, subscribe, command } = createHarness()
    const sidebarId = subscribe({ type: "sidebar" })
    const count = () => sent.filter((envelope) => envelope.type === "snapshot" && envelope.id === sidebarId).length
    command({ type: "system.ping" })
    expect(count()).toBe(1)
    command({ type: "chat.rename", chatId: DEMO_FEATURED_CHAT_ID, title: "Units" })
    expect(count()).toBe(2)
  })
})

describe("createUnifiedPatch", () => {
  test("marks changed lines inside one hunk with context", () => {
    const { patch, additions, deletions } = createUnifiedPatch("a.txt", "one\ntwo\nthree\n", "one\n2\nthree\nfour\n", "modified")
    expect(patch).toBe([
      "diff --git a/a.txt b/a.txt",
      "--- a/a.txt",
      "+++ b/a.txt",
      "@@ -1,3 +1,4 @@",
      " one",
      "-two",
      "+2",
      " three",
      "+four",
      "",
    ].join("\n"))
    expect([additions, deletions]).toEqual([2, 1])
  })

  test("a new file diffs against /dev/null", () => {
    const { patch } = createUnifiedPatch("new.ts", "", "export {}\n", "added")
    expect(patch).toContain("new file mode 100644\n--- /dev/null\n+++ b/new.ts\n@@ -0,0 +1 @@\n+export {}")
  })
})
