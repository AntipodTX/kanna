import { AsyncQueue } from "./async-queue"
import type { HarnessEvent } from "./harness-types"
import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { AgentCoordinator } from "./agent"
import { EventStore } from "./event-store"
import { timestamped } from "./transcript"
import { CodexPromptHistory } from "./codex-prompt-history"

async function fixture(run: (f: {
  store: EventStore; coordinator: AgentCoordinator; chatId: string; dir: string;
  cuts: any[]; starts: any[]; manager: any; state: { failStart: boolean; interrupts: number; stops: number; native: any[] };
}) => Promise<void>, prompts = ["A", "B", "C"], steered = false) {
  const dir = await mkdtemp(path.join(tmpdir(), "kanna-sequential-codex-"))
  let coordinator: AgentCoordinator | undefined
  try {
    const store = new EventStore(dir)
    await store.initialize()
    const project = await store.openProject(dir, "Project"), chat = await store.createChat(project.id)
    await store.setChatProvider(chat.id, "codex")
    await store.renameChat(chat.id, "Task")
    await store.setSessionToken(chat.id, "source")
    await store.replaceTranscript(chat.id, prompts.flatMap((content, i) => [
      { ...timestamped({ kind: "user_prompt", content, steered: steered && i === 1 }), _id: content.toLowerCase() },
      { ...timestamped({ kind: "assistant_text", text: `Answer ${content}` }), _id: `answer-${content.toLowerCase()}` },
    ]))
    const cuts: any[] = [], starts: any[] = []
    const state = { failStart: false, interrupts: 0, stops: 0, native: prompts.filter((p) => p !== "B").map((text) =>
      ({ turnId: `turn-${text.toLowerCase()}`, promptId: text.toLowerCase(), text, userIndex: 0 })) }
    let activeSessionToken = "source"
    const manager = {
      readPromptHistory: async () => ({ inputs: state.native }),
      forkBeforeTurn: async (args: any) => { cuts.push(args); return "prepared" },
      forkAfterTurn: async (args: any) => { cuts.push(args); return "prepared" },
      startSession: async (args: any) => {
        starts.push(args)
        activeSessionToken = args.sessionToken ?? args.pendingForkSessionToken ?? "prepared"
        return { sessionToken: activeSessionToken, resumeFellBack: false }
      },
      startTurn: async (args: any) => {
        if (state.failStart) throw new Error("launch rejected")
        return { provider: "codex", providerTurnId: "new", stream: (async function* () {
          yield { type: "session_token", sessionToken: activeSessionToken }
          yield { type: "transcript", entry: timestamped({ kind: "result", subtype: "success", isError: false, durationMs: 0, result: "done" }) }
        })(), interrupt: async () => { state.interrupts++ }, close: () => {} }
      },
      listModels: async () => [], stopSession: () => { state.stops++ }, stopAll: () => {}, getResourceCounts: () => ({}),
    }
    coordinator = new AgentCoordinator({ store, codexManager: manager as never, onStateChange: () => {},
      checkSessionArtifact: (() => "exists") as never })
    await run({ store, coordinator, chatId: chat.id, dir, cuts, starts, manager, state })
  } finally {
    for (let i = 0; i < 100 && coordinator && (coordinator.getResourceCounts().activeTurns || coordinator.getDrainingChatIds().size); i++)
      await new Promise((resolve) => setTimeout(resolve, 10))
    await coordinator?.dispose()
    await rm(dir, { recursive: true, force: true })
  }
}

for (const rejected of [false, true])
  test(`replaying the first of three absent messages retains the source until startup: rejected=${rejected}`, () => fixture(async ({ coordinator, store, chatId, state }) => {
    state.native = state.native.filter(input => input.promptId === "p")
    state.failStart = rejected
    const original = store.getMessages(chatId)
    const actions = await coordinator.getHistoryActions(chatId, { recover: true })
    expect(actions.messages).toEqual({ a: "missing", b: "missing", c: "missing" })
    expect(actions.actions).toEqual({ p: "ordinary", a: "ordinary" })
    expect(store.getMessages(chatId)).toEqual(original)
    const editing = coordinator.editUserPrompt({ type: "chat.editUserPrompt", chatId, messageId: "a", content: "Corrected A" })
    if (rejected) {
      await expect(editing).rejects.toThrow("launch rejected")
      expect(store.getMessages(chatId)).toEqual(original)
    } else {
      await editing
      expect(store.getMessages(chatId).filter(entry => entry.kind === "user_prompt").map(entry => entry.content)).toEqual(["P", "Corrected A"])
    }
  }, ["P", "A", "B", "C"]))

test("history actions preserve A and C and offer B replay", () => fixture(async ({ coordinator, chatId }) => {
  const result = await coordinator.getHistoryActions(chatId, { recover: true })
  expect(result.actions).toEqual({ a: "ordinary", b: "ordinary", c: "ordinary" })
  expect(result.gap?.messageId).toBe("b")
  expect(result.gap?.error).toContain("native history")
}))

test("failed native recovery preserves the saved consecutive prefix", () => fixture(async ({ coordinator, chatId, dir, manager }) => {
  await new CodexPromptHistory(dir).remember(chatId, {
    a: { sessionToken: "source", turnId: "turn-a", mergeTurn: false, boundaryEntryId: null },
  })
  manager.readPromptHistory = async () => { throw new Error("native history unavailable") }
  await expect(coordinator.getHistoryActions(chatId, { recover: true })).rejects.toThrow("native history unavailable")
  const result = await coordinator.getHistoryActions(chatId)
  expect(result.actions.a).toBe("ordinary")
  expect(result.actions.b).toBe("recover")
  expect(result.gap).toBeUndefined()
}))

for (const historyMode of [undefined, "paginated"])
test(`recovery uses native history without reading the ${historyMode ?? "legacy"} journal`, () => fixture(async ({ coordinator, chatId, dir, manager, state }) => {
  const file = path.join(dir, "native.jsonl")
  await Bun.write(file, [
    { type: "session_meta", payload: { id: "source", history_mode: "paginated" } },
    ...["A", "B", "C"].flatMap((message) => [
      { type: "event_msg", payload: { type: "task_started", turn_id: "turn-" + message.toLowerCase() } },
      { type: "event_msg", payload: { type: "user_message", message } },
      { type: "event_msg", payload: { type: "task_complete", turn_id: "turn-" + message.toLowerCase() } },
    ]),
  ].map((row) => JSON.stringify(row)).join("\n") + "\n")
  manager.readPromptHistory = async () => ({ inputs: state.native, path: file, historyMode })
  const actions = await coordinator.getHistoryActions(chatId, { recover: true })
  expect(actions.gap?.messageId).toBe("b")
  expect(actions.actions.c).toBe("ordinary")
  expect((await new CodexPromptHistory(dir).read(chatId)).prompts.b).toBeUndefined()
}))

test("saved complete bindings do not trigger repeated native reconciliation", () => fixture(async ({ coordinator, chatId, dir, manager }) => {
  const history = new CodexPromptHistory(dir)
  await history.remember(chatId, {
    a: { sessionToken: "source", turnId: "turn-a", mergeTurn: false },
    b: { sessionToken: "source", turnId: "turn-b", mergeTurn: false },
    c: { sessionToken: "source", turnId: "turn-c", mergeTurn: false },
  })
  manager.readPromptHistory = async () => { throw new Error("Unexpected full history read") }
  expect((await coordinator.getHistoryActions(chatId)).actions).toEqual({ a: "ordinary", b: "ordinary", c: "ordinary" })
  await (coordinator as any).assertCodexHistoryReady(chatId)
}))

for (const action of ["edit", "fork"] as const)
  test(`first gap ${action} replays from A and preserves source until publication`, () => fixture(async ({ coordinator, store, chatId, cuts }) => {
    const original = store.getMessages(chatId)
    const result = action === "edit"
      ? await coordinator.editUserPrompt({ type: "chat.editUserPrompt", chatId, messageId: "b", content: "Edited B" })
      : await coordinator.forkChat({ type: "chat.fork", chatId, messageId: "b" })
    expect(cuts).toMatchObject([{ threadId: "source", afterTurnId: "turn-a" }])
    const destination = store.getMessages(result.chatId)
    expect(destination.filter((e) => e.kind === "user_prompt").map((e) => e.content)).toEqual(["A", action === "edit" ? "Edited B" : "B"])
    expect(destination.find((e) => e._id === "answer-a")).toEqual(original[1])
    if (action === "fork") {
      expect(store.getMessages(chatId)).toEqual(original)
      expect(store.requireChat(result.chatId).pendingForkUserPrompt).toBe(true)
    }
  }))

test("ordinary sends retain missing messages and confirmed later messages remain editable", () => fixture(async ({ coordinator, store, chatId }) => {
  const original = [...store.getMessages(chatId)]
  await coordinator.editUserPrompt({ type: "chat.editUserPrompt", chatId, messageId: "c", content: "Edited C" })
  for (let i = 0; i < 100 && coordinator.getResourceCounts().activeTurns; i++) await new Promise(resolve => setTimeout(resolve, 10))
  expect(store.getMessages(chatId).slice(0, 4)).toEqual(original.slice(0, 4))
  expect((await coordinator.getHistoryActions(chatId)).messages).toEqual({ b: "missing" })
  await coordinator.send({ type: "chat.send", chatId, content: "D", provider: "codex" })
  expect(store.getMessages(chatId).filter(entry => entry.kind === "user_prompt").map(entry => entry.content)).toEqual(["A", "B", "Edited C", "D"])
}))

test("session fallback cannot hide an unresolved prompt behind a restoration marker", () => fixture(async ({ coordinator, store, chatId, manager, starts }) => {
  const original = store.getMessages(chatId)
  manager.startSession = async () => { starts.push("fallback"); return { sessionToken: "fresh", resumeFellBack: true } }
  await expect(coordinator.send({ type: "chat.send", chatId, content: "D", provider: "codex" })).rejects.toThrow("resume")
  expect(store.getMessages(chatId)).toEqual(original)
  expect(starts).toEqual(["fallback"])
}))

test("a classified absence does not block a queued successor", () => fixture(async ({ coordinator, store, chatId }) => {
  await coordinator.enqueue({ type: "message.enqueue", chatId, content: "D", provider: "codex" })
  await (coordinator as any).maybeStartNextQueuedMessage(chatId)
  expect(store.getQueuedMessages(chatId)).toEqual([])
  expect(store.getMessages(chatId).filter(entry => entry.kind === "user_prompt").map(entry => entry.content)).toEqual(["A", "B", "C", "D"])
}))

test("a rejected ordinary start preserves history without recording a prompt or started turn", () => fixture(async ({ coordinator, store, chatId, state }) => {
  state.failStart = true
  const before = store.requireChat(chatId).turnCount
  await expect(coordinator.send({ type: "chat.send", chatId, content: "B", provider: "codex" })).rejects.toThrow("launch rejected")
  expect(store.getMessages(chatId).filter((e) => e.kind === "user_prompt").map((e) => e.content)).toEqual(["A"])
  expect(store.requireChat(chatId).turnCount).toBe(before)
}, ["A"]))

test("binding persistence failure interrupts acceptance and recovered absence permits a successor after restart", () => fixture(async ({ coordinator, store, chatId, state, manager }) => {
  const history = (coordinator as unknown as { codexPromptHistory: CodexPromptHistory }).codexPromptHistory
  history.recordPrompt = async () => { throw new Error("binding EIO") }
  await expect(coordinator.send({ type: "chat.send", chatId, content: "B", provider: "codex" })).rejects.toThrow("binding EIO")
  expect(state.interrupts).toBeGreaterThan(0)
  expect(store.getMessages(chatId).filter((e) => e.kind === "user_prompt").map((e) => e.content)).toEqual(["A", "B"])
  const failedPromptId = store.getMessages(chatId).find(e => e.kind === "user_prompt" && e.content === "B")!._id
  await coordinator.dispose()
  const restarted = new AgentCoordinator({ store, codexManager: manager as never, onStateChange: () => {}, checkSessionArtifact: (() => "exists") as never })
  try {
    await restarted.send({ type: "chat.send", chatId, content: "C", provider: "codex" })
    for (let i = 0; i < 100 && restarted.getResourceCounts().activeTurns; i++) await new Promise(resolve => setTimeout(resolve, 10))
    expect((await restarted.getHistoryActions(chatId)).messages?.[failedPromptId]).toBe("missing")
  } finally { await restarted.dispose() }
}, ["A"]))

test("a failed binding retires the session without waiting for an interrupt reply", () => fixture(async ({ coordinator, chatId, manager, state }) => {
  const original = manager.startTurn
  let beginInterrupt!: () => void
  const interruptStarted = new Promise<void>(resolve => { beginInterrupt = resolve })
  manager.startTurn = async (...args: any[]) => ({ ...await original(...args), interrupt: () => {
    state.interrupts++; beginInterrupt(); return new Promise(() => {})
  } })
  ;(coordinator as any).codexPromptHistory.recordPrompt = async () => { throw new Error("binding EIO") }
  const sending = coordinator.send({ type: "chat.send", chatId, content: "B", provider: "codex" })
    .then(() => "accepted", (e) => e.message)
  await interruptStarted
  const result = await Promise.race([
    sending,
    new Promise((resolve) => setTimeout(() => resolve("still pending"), 1000)),
  ])
  expect(result).toBe("binding EIO")
  expect(state.stops).toBeGreaterThan(0)
}, ["A"]))

test("failed gap replay startup leaves the original history intact", () => fixture(async ({ coordinator, store, chatId, state }) => {
  state.failStart = true
  const original = store.getMessages(chatId)
  await expect(coordinator.editUserPrompt({ type: "chat.editUserPrompt", chatId, messageId: "b", content: "Edited B" })).rejects.toThrow("launch rejected")
  expect(store.getMessages(chatId)).toEqual(original)
  expect(store.requireChat(chatId).sessionToken).toBe("source")
}))

test("accepted gap replay publishes the edited prompt before a binding write fails", () => fixture(async ({ coordinator, store, chatId, state }) => {
  ;(coordinator as any).codexPromptHistory.recordPrompt = async () => { throw new Error("binding EIO") }
  await expect(coordinator.editUserPrompt({ type: "chat.editUserPrompt", chatId, messageId: "b", content: "Edited B" })).rejects.toThrow("binding EIO")
  expect(store.getMessages(chatId).filter((e) => e.kind === "user_prompt").map((e) => e.content)).toEqual(["A", "Edited B"])
  expect(state.interrupts).toBeGreaterThan(0)
}))

test("disposal cancels a prepared history operation before it publishes a child", () => fixture(async ({ coordinator, store, chatId, manager }) => {
  let enter!: () => void, release!: () => void
  const entered = new Promise<void>((resolve) => { enter = resolve }), waiting = new Promise<void>((resolve) => { release = resolve })
  manager.forkAfterTurn = async () => { enter(); await waiting; return "prepared" }
  const original = store.getMessages(chatId)
  const forking = coordinator.forkChat({ type: "chat.fork", chatId, messageId: "b" })
  await entered
  coordinator.dispose()
  release()
  await expect(forking).rejects.toThrow("cancelled")
  expect(store.getMessages(chatId)).toEqual(original)
}))

test("steering gap edit combines its turn and uses its start boundary", () => fixture(async ({ coordinator, store, chatId, cuts }) => {
  await coordinator.editUserPrompt({ type: "chat.editUserPrompt", chatId, messageId: "b", content: "Edited B" })
  expect(cuts).toMatchObject([{ beforeTurnId: "turn-a" }])
  expect(store.getMessages(chatId).filter((e) => e.kind === "user_prompt").map((e) => e.content)).toEqual(["A\nEdited B"])
}, ["A", "B", "C"], true))

test("a fork of the first unresolved message remains one sendable draft without a native token", () => fixture(async ({ coordinator, store, chatId }) => {
  const child = await coordinator.forkChat({ type: "chat.fork", chatId, messageId: "b" })
  await coordinator.send({ type: "chat.send", chatId: child.chatId, content: "", provider: "codex" })
  expect(store.getMessages(child.chatId).filter((e) => e.kind === "user_prompt").map((e) => e.content)).toEqual(["B"])
}, ["B"]))

test("an unsent fork draft can continue while an earlier absent message is retained", () => fixture(async ({ coordinator, store, chatId, state }) => {
  await store.setSessionToken(chatId, null)
  await store.setPendingForkSessionToken(chatId, "prepared")
  await store.setPendingForkUserPrompt(chatId, true)
  state.native = []
  const original = store.getMessages(chatId)
  expect((await coordinator.getHistoryActions(chatId, { recover: true })).actions.b).toBeUndefined()
  await coordinator.send({ type: "chat.send", chatId, content: "", provider: "codex" })
  expect(store.getMessages(chatId).slice(0, original.length)).toEqual(original)
  expect(store.requireChat(chatId).pendingForkUserPrompt).toBe(false)
}, ["A", "B"]))

test("cancellation during ordinary Codex startup preserves history and rejects late acceptance", () => fixture(async ({ coordinator, store, chatId, manager }) => {
  let enter!: () => void, release!: () => void
  const entered = new Promise<void>((resolve) => { enter = resolve }), waiting = new Promise<void>((resolve) => { release = resolve })
  manager.startSession = async () => { enter(); await waiting; return { sessionToken: "source", resumeFellBack: false } }
  const sending = coordinator.send({ type: "chat.send", chatId, content: "B", provider: "codex" })
  await entered
  await coordinator.cancel(chatId)
  release()
  await sending.catch((error) => expect(error.message).toContain("cancelled"))
  expect(store.getMessages(chatId).filter((e) => e.kind === "user_prompt").map((e) => e.content)).toEqual(["A"])
  expect(coordinator.getResourceCounts().activeTurns).toBe(0)
}, ["A"]))



test("a failed accepted edit token publication cannot remap edited text onto the source session", () => fixture(async ({ coordinator, store, chatId, state }) => {
  const original = store.getMessages(chatId)
  state.native.splice(1, 0, { turnId: "turn-b", promptId: "b", text: "B", userIndex: 0 })
  const setToken = store.setSessionToken.bind(store)
  store.setSessionToken = async (id, token) => {
    if (token === "prepared") throw new Error("token publication EIO")
    await setToken(id, token)
  }
  await expect(coordinator.editUserPrompt({ type: "chat.editUserPrompt", chatId, messageId: "b", content: "B" })).rejects.toThrow("token publication EIO")
  expect(store.getMessages(chatId)).toEqual(original)
  expect(store.requireChat(chatId).sessionToken).toBe("source")
  expect(state.interrupts).toBeGreaterThan(0)
}))

for (const action of ["edit", "fork"] as const)
  test(`the first confirmed Codex prompt after handoff retains prior context on ${action}`, () => fixture(async ({ coordinator, store, chatId, state, manager, cuts }) => {
    await store.setChatProvider(chatId, "claude")
    await store.setSessionToken(chatId, "claude-old")
    manager.startSession = async (args: any) => ({ sessionToken: args.sessionToken ?? args.pendingForkSessionToken ?? "prepared", resumeFellBack: false,
      startupOutcome: { kind: args.sessionToken || args.pendingForkSessionToken ? "resumed" : "fresh" } })
    const inputs: string[] = [], start = manager.startTurn
    manager.startTurn = async (args: any) => { inputs.push(args.content); return start(args) }
    await coordinator.send({ type: "chat.send", chatId, content: "B", provider: "codex" })
    for (let i = 0; i < 100 && coordinator.getResourceCounts().activeTurns; i++) await new Promise(resolve => setTimeout(resolve, 10))
    expect(store.requireChat(chatId).contextRestoration).toBeNull()
    const original = store.getMessages(chatId), b = original.find(e => e.kind === "user_prompt" && e.content === "B")!
    const marker = original.find(e => e.kind === "handoff_boundary")!
    const record = await (coordinator as any).codexPromptHistory.read(chatId)
    expect(record.prompts[b._id].boundaryEntryId).toBe(marker._id)
    state.native = [{ turnId: "new", promptId: b._id, text: "B", userIndex: 0 }]
    const destination = action === "edit"
      ? await coordinator.editUserPrompt({ type: "chat.editUserPrompt", chatId, messageId: b._id, content: "Edited B" })
      : await coordinator.forkChat({ type: "chat.fork", chatId, messageId: b._id })
    if (action === "fork") {
      expect(store.getMessages(chatId)).toEqual(original)
      await coordinator.send({ type: "chat.send", chatId: destination.chatId, content: "", provider: "codex" })
    }
    expect(cuts).toMatchObject([{ beforeTurnId: "new" }])
    expect(inputs).toHaveLength(2)
    expect(inputs[1]).toContain("Answer A")
    expect(inputs[1]).not.toContain(store.getTranscriptPath(chatId))
    expect(inputs[1]).toContain(action === "edit" ? "Edited B" : "B")
    expect(store.getMessages(destination.chatId).some(e => e._id === marker._id)).toBe(true)
  }, ["A"]))

for (const originalCount of [undefined, 0, 7])
  test(`failed Codex edit publication restores turnCount ${originalCount ?? "absent"} through restart`, () => fixture(async ({ coordinator, store, chatId, dir }) => {
    if (originalCount !== undefined) await store.recordTurnStarted(chatId, undefined, { turnCount: originalCount })
    const original = store.getMessages(chatId)
    const setToken = store.setSessionToken.bind(store)
    store.setSessionToken = async (id, token) => {
      if (token === "prepared") throw new Error("token publication EIO")
      await setToken(id, token)
    }
    await expect(coordinator.editUserPrompt({ type: "chat.editUserPrompt", chatId, messageId: "a", content: "Edited A" }))
      .rejects.toThrow("token publication EIO")
    expect(store.getMessages(chatId)).toEqual(original)
    expect(store.requireChat(chatId).turnCount).toBe(originalCount)
    const reloaded = new EventStore(dir)
    await reloaded.initialize()
    expect(reloaded.getMessages(chatId)).toEqual(original)
    expect(reloaded.requireChat(chatId).turnCount).toBe(originalCount)
  }))

for (const stop of ["cancel", "close", "dispose"] as const)
  test(`${stop} during Codex edit turn-count publication restores the source count through restart`, () => fixture(async ({ coordinator, store, chatId, dir }) => {
    await store.recordTurnStarted(chatId, undefined, { turnCount: 7 })
    const original = store.getMessages(chatId)
    let enter!: () => void, release!: () => void
    const entered = new Promise<void>(resolve => { enter = resolve })
    const waiting = new Promise<void>(resolve => { release = resolve })
    const record = store.recordTurnStarted.bind(store)
    store.recordTurnStarted = async (...args) => { await record(...args); enter(); await waiting }
    const editing = coordinator.editUserPrompt({ type: "chat.editUserPrompt", chatId, messageId: "a", content: "Edited A" })
    const settled = editing.catch(error => error)
    try {
      await entered
      expect(store.requireChat(chatId).turnCount).toBe(1)
      if (stop === "cancel") await coordinator.cancel(chatId)
      else if (stop === "close") await coordinator.closeChat(chatId)
      else coordinator.dispose()
      release()
      await expect(settled).resolves.toMatchObject({ message: expect.stringContaining("cancelled") })
      expect(store.getMessages(chatId)).toEqual(original)
      expect(store.requireChat(chatId).turnCount).toBe(7)
      const reloaded = new EventStore(dir)
      await reloaded.initialize()
      expect(reloaded.getMessages(chatId)).toEqual(original)
      expect(reloaded.requireChat(chatId).turnCount).toBe(7)
    } finally { release(); await settled }
  }))

test("cancel during classification publication restores the original segment and replay actions", () => fixture(async ({ coordinator, store, chatId, manager }) => {
  await coordinator.getHistoryActions(chatId, { recover: true })
  const original = [...store.getMessages(chatId)]
  const integrity = structuredClone(store.requireChat(chatId).codexHistoryIntegrity)
  let enter!: () => void, release!: () => void
  const entered = new Promise<void>(resolve => { enter = resolve })
  const waiting = new Promise<void>(resolve => { release = resolve })
  const save = store.setCodexHistoryIntegrity.bind(store)
  store.setCodexHistoryIntegrity = async (id, value) => {
    await save(id, value)
    if (value?.segments?.prepared) { enter(); await waiting }
  }
  const settled = coordinator.editUserPrompt({ type: "chat.editUserPrompt", chatId, messageId: "c", content: "Edited C" }).catch(error => error)
  try {
    await entered
    await coordinator.cancel(chatId)
    release()
    await expect(settled).resolves.toMatchObject({ message: expect.stringContaining("cancelled") })
    expect(store.getMessages(chatId)).toEqual(original)
    const restored = store.requireChat(chatId).codexHistoryIntegrity
    expect(restored?.key).toBe((coordinator as any).codexIntegrityKey(chatId))
    expect(restored?.segments).toEqual(integrity?.segments)
    expect(restored?.messages).toEqual(integrity?.messages)
    expect(restored?.gap).toEqual(integrity?.gap)
    manager.readPromptHistory = async () => { throw new Error("Known absence must not be scanned again after cancellation") }
    const actions = await coordinator.getHistoryActions(chatId)
    expect(actions.actions.b).toBe("ordinary")
    expect(actions.actions.c).toBe("ordinary")
    await coordinator.send({ type: "chat.send", chatId, content: "D", provider: "codex" })
  } finally { release(); await settled }
}))

test("stopping a fully published Codex edit keeps its replacement turn count", () => fixture(async ({ coordinator, store, chatId, dir, manager }) => {
  await store.recordTurnStarted(chatId, undefined, { turnCount: 7 })
  const events = new AsyncQueue<HarnessEvent>()
  manager.startTurn = async () => ({ provider: "codex", providerTurnId: "new", stream: events,
    interrupt: async () => {}, close: () => events.finish() })
  try {
    await coordinator.editUserPrompt({ type: "chat.editUserPrompt", chatId, messageId: "a", content: "Edited A" })
    await coordinator.cancel(chatId)
    expect(store.getMessages(chatId).filter(e => e.kind === "user_prompt").map(e => e.content)).toEqual(["Edited A"])
    expect(store.requireChat(chatId).turnCount).toBe(1)
    const reloaded = new EventStore(dir)
    await reloaded.initialize()
    expect(reloaded.requireChat(chatId).turnCount).toBe(1)
  } finally { events.finish() }
}))


for (const action of ["edit", "fork"] as const)
  test(`a first gap after provider handoff can ${action} with its known previous context`, () => fixture(async ({ coordinator, store, chatId, state, manager }) => {
    await store.setChatProvider(chatId, "claude")
    await store.setSessionToken(chatId, "claude-old")
    state.native = []
    state.failStart = true
    await expect(coordinator.send({ type: "chat.send", chatId, content: "B", provider: "codex" })).rejects.toThrow("launch rejected")
    // Old versions persisted inputs before native acceptance. Recover that
    // existing gap; new rejected launches themselves leave no such message.
    await store.appendMessage(chatId, timestamped({ kind: "user_prompt", content: "B" }))
    const original = store.getMessages(chatId), b = original.find(e => e.kind === "user_prompt" && e.content === "B")!
    expect((await coordinator.getHistoryActions(chatId, { recover: true })).actions[b._id]).toBe("ordinary")
    await expect(coordinator.editUserPrompt({ type: "chat.editUserPrompt", chatId, messageId: b._id, content: "Edited B" })).rejects.toThrow("launch rejected")
    expect(store.getMessages(chatId)).toEqual(original)
    state.failStart = false
    const inputs: string[] = []
    const start = manager.startTurn
    manager.startTurn = async (args: any) => { inputs.push(args.content); return start(args) }
    const destination = action === "edit"
      ? await coordinator.editUserPrompt({ type: "chat.editUserPrompt", chatId, messageId: b._id, content: "Edited B" })
      : await coordinator.forkChat({ type: "chat.fork", chatId, messageId: b._id })
    if (action === "fork") {
      expect(store.getMessages(chatId)).toEqual(original)
      expect(inputs).toEqual([])
      await coordinator.send({ type: "chat.send", chatId: destination.chatId, content: "", provider: "codex" })
    }
    expect(inputs).toHaveLength(1)
    expect(inputs[0]).toContain("Answer A")
    expect(inputs[0]).toContain(action === "edit" ? "Edited B" : "B")
  }, ["A"]))


  test("failed steering provenance stops the turn and keeps the waiting successor queued", () => fixture(async ({ coordinator, store, chatId, manager, state }) => {
  const events = new AsyncQueue<HarnessEvent>()
  let nativeInputs = 0
  manager.startTurn = async () => ({ provider: "codex", providerTurnId: "a", stream: events,
    interrupt: async () => {}, close: () => events.finish() })
  manager.startSteerTurn = (args: any) => {
    nativeInputs++
    return { accepted: Promise.resolve(), settled: Promise.resolve() }
  }
  await coordinator.send({ type: "chat.send", chatId, content: "A", provider: "codex" })
  const b = await coordinator.enqueue({ type: "message.enqueue", chatId, content: "B", provider: "codex" })
  const c = await coordinator.enqueue({ type: "message.enqueue", chatId, content: "C", provider: "codex" })
  let enter!: () => void, release!: () => void
  const entered = new Promise<void>((resolve) => { enter = resolve }), waiting = new Promise<void>((resolve) => { release = resolve })
  ;(coordinator as any).codexPromptHistory.recordPrompt = async () => { enter(); await waiting; throw new Error("binding EIO") }
  await coordinator.steer({ type: "message.steer", chatId, queuedMessageId: b.queuedMessageId })
  const successor = coordinator.steer({ type: "message.steer", chatId, queuedMessageId: c.queuedMessageId }).catch((error) => error.message)
  await entered
  expect(nativeInputs).toBe(1)
  release()
  expect(await successor).toContain("recovery")
  expect(nativeInputs).toBe(1)
  expect(store.getQueuedMessage(chatId, b.queuedMessageId)).toBeNull()
  expect(store.getQueuedMessage(chatId, c.queuedMessageId)).not.toBeNull()
  expect(coordinator.getResourceCounts().activeTurns).toBe(0)
  expect(state.stops).toBeGreaterThan(0)
  expect(store.getMessages(chatId).filter((e) => e.kind === "user_prompt").map((e) => e.content)).toEqual(["A", expect.stringContaining("B")])
  expect(store.getMessages(chatId).some((e) => e.kind === "result" && e.isError && e.result.includes("binding EIO"))).toBe(true)
}, []))


  for (const stop of ["cancel", "close", "dispose"] as const)
  test(`${stop} during a pending native steer cannot submit its waiting successor`, () => fixture(async ({ coordinator, store, chatId, manager }) => {
    const events = new AsyncQueue<HarnessEvent>()
    manager.startTurn = async () => ({ provider: "codex", providerTurnId: "a", stream: events,
      interrupt: async () => {}, close: () => events.finish() })
    let release!: () => void, nativeInputs = 0
    const settled = new Promise<void>(resolve => { release = resolve })
    manager.startSteerTurn = () => { nativeInputs++; return { accepted: Promise.resolve(), settled } }
    await coordinator.send({ type: "chat.send", chatId, content: "A", provider: "codex" })
    const b = await coordinator.enqueue({ type: "message.enqueue", chatId, content: "B", provider: "codex" })
    const c = await coordinator.enqueue({ type: "message.enqueue", chatId, content: "C", provider: "codex" })
    await coordinator.steer({ type: "message.steer", chatId, queuedMessageId: b.queuedMessageId })
    const successor = coordinator.steer({ type: "message.steer", chatId, queuedMessageId: c.queuedMessageId }).catch(error => error.message)
    if (stop === "cancel") await coordinator.cancel(chatId)
    else if (stop === "close") await coordinator.closeChat(chatId)
    else coordinator.dispose()
    release()
    expect(await successor).toContain("cancelled")
    expect(nativeInputs).toBe(1)
    expect(store.getQueuedMessage(chatId, c.queuedMessageId)).not.toBeNull()
    events.finish()
  }, []))


  for (const failure of ["before input", "acceptance", "confirmation"] as const)
  test(`native steer failure at ${failure} stops the turn and preserves both user requests`, () => fixture(async ({ coordinator, store, chatId, manager, state }) => {
    const events = new AsyncQueue<HarnessEvent>()
    manager.startTurn = async () => ({ provider: "codex", providerTurnId: "a", stream: events,
      interrupt: async () => {}, close: () => events.finish() })
    await coordinator.send({ type: "chat.send", chatId, content: "A", provider: "codex" })
    const b = await coordinator.enqueue({ type: "message.enqueue", chatId, content: "B", provider: "codex" })
    const c = await coordinator.enqueue({ type: "message.enqueue", chatId, content: "C", provider: "codex" })
    let release!: () => void, nativeInputs = 0
    const waiting = new Promise<void>(resolve => { release = resolve })
    if (failure === "before input") {
      const append = store.appendMessage.bind(store)
      store.appendMessage = async (id, entry) => { if (entry._id === b.queuedMessageId) { await waiting; throw new Error("transcript EIO") }; await append(id, entry) }
    }
    manager.startSteerTurn = () => {
      nativeInputs++
      const rejected = waiting.then(() => { throw new Error("native confirmation failed") })
      void rejected.catch(() => {})
      return { accepted: failure === "acceptance" ? rejected : Promise.resolve(), settled: rejected }
    }
    const first = coordinator.steer({ type: "message.steer", chatId, queuedMessageId: b.queuedMessageId }).catch(error => error)
    const successor = coordinator.steer({ type: "message.steer", chatId, queuedMessageId: c.queuedMessageId }).catch(error => error.message)
    await new Promise(resolve => setTimeout(resolve, 0))
    release(); await first
    expect(await successor).toContain("recovery")
    expect(nativeInputs).toBe(failure === "before input" ? 0 : 1)
    expect(store.getQueuedMessage(chatId, b.queuedMessageId)).not.toBeNull()
    expect(store.getQueuedMessage(chatId, c.queuedMessageId)).not.toBeNull()
    expect(state.stops).toBeGreaterThan(0)
    expect(coordinator.getResourceCounts().activeTurns).toBe(0)
    events.finish()
  }, []))
