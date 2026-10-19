import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { AgentCoordinator } from "./agent"
import { EventStore } from "./event-store"
import { CodexPromptHistory } from "./codex-prompt-history"
import { timestamped } from "./transcript"

async function fixture(run: (f: {
  store: EventStore; coordinator: AgentCoordinator; history: CodexPromptHistory;
  chatId: string; dir: string; state: { reads: number; inputs: any[]; error?: Error; rejectTurn?: boolean };
}) => Promise<void>) {
  const dir = await mkdtemp(path.join(tmpdir(), "kanna-integrity-"))
  let coordinator: AgentCoordinator | undefined
  try {
    const store = new EventStore(dir)
    await store.initialize()
    const project = await store.openProject(dir, "Test")
    const chat = await store.createChat(project.id)
    await store.setChatProvider(chat.id, "codex")
    await store.setSessionToken(chat.id, "source")
    await store.replaceTranscript(chat.id, ["A", "B", "C"].flatMap((content) => [
      { ...timestamped({ kind: "user_prompt", content }), _id: content.toLowerCase() },
      { ...timestamped({ kind: "assistant_text", text: `Answer ${content}` }), _id: `answer-${content.toLowerCase()}` },
    ]))
    const history = new CodexPromptHistory(dir)
    await history.remember(chat.id, {
      a: { sessionToken: "source", turnId: "turn-a", mergeTurn: false, boundaryEntryId: null },
    })
    const state: { reads: number; inputs: any[]; error?: Error; rejectTurn?: boolean } = { reads: 0, inputs: [
      { turnId: "turn-a", promptId: "a", text: "A", userIndex: 0 },
      { turnId: "turn-c", promptId: "c", text: "C", userIndex: 0 },
    ] }
    coordinator = new AgentCoordinator({ store, onStateChange: () => {},
      checkSessionArtifact: (() => ({ status: "exists" })) as never,
      codexManager: {
      readPromptHistory: async () => { state.reads++; if (state.error) throw state.error; return { inputs: state.inputs } },
      startSession: async () => ({ sessionToken: "source", resumeFellBack: false, startupOutcome: { kind: "resumed" } }),
      startTurn: async () => {
        if (state.rejectTurn) throw new Error("Codex launch rejected")
        return { provider: "codex", providerTurnId: "turn-d", stream: (async function* () {
          yield { type: "session_token", sessionToken: "source" }
          yield { type: "transcript", entry: timestamped({ kind: "result", subtype: "success", isError: false, durationMs: 0, result: "done" }) }
        })(), interrupt: async () => {}, close: () => {} }
      },
      listModels: async () => [], stopSession: () => {}, stopAll: () => {}, getResourceCounts: () => ({}),
    } as never })
    await run({ store, coordinator, history, chatId: chat.id, dir, state })
  } finally {
    for (let i = 0; i < 100 && coordinator?.getResourceCounts().activeTurns; i++) await new Promise(resolve => setTimeout(resolve, 10))
    await coordinator?.dispose()
    await rm(dir, { recursive: true, force: true })
  }
}

test("opening history actions uses saved prefix and offers recovery without native reads", () => fixture(async ({ coordinator, chatId, state }) => {
  const actions = await coordinator.getHistoryActions(chatId)
  expect(state.reads).toBe(0)
  expect(actions.actions).toEqual({ a: "ordinary", b: "recover", c: "recover" })
  expect(actions.gap).toBeUndefined()
}))

test("explicit recovery saves a gap and opening or continuation never retries it automatically", () => fixture(async ({ coordinator, chatId, state }) => {
  const actions = await coordinator.getHistoryActions(chatId, { recover: true })
  expect(state.reads).toBe(1)
  expect(actions.actions).toEqual({ a: "ordinary", b: "ordinary", c: "ordinary" })
  expect(actions.gap?.messageId).toBe("b")
  await coordinator.getHistoryActions(chatId)
  await (coordinator as any).assertCodexHistoryReady(chatId)
  expect(state.reads).toBe(1)
}))

test("temporary native errors preserve bindings and do not invent a replayable gap", () => fixture(async ({ coordinator, history, chatId, state }) => {
  state.error = new Error("Codex unavailable")
  await expect(coordinator.getHistoryActions(chatId, { recover: true })).rejects.toThrow("Codex unavailable")
  const actions = await coordinator.getHistoryActions(chatId)
  expect(actions.gap).toBeUndefined()
  expect(actions.actions.a).toBe("ordinary")
  expect(actions.actions.b).toBe("recover")
  expect((await history.read(chatId)).prompts.a?.turnId).toBe("turn-a")
}))

test("a confirmed target does not recover an unrelated later gap", () => fixture(async ({ coordinator, chatId, state }) => {
  await coordinator.getHistoryActions(chatId, { recover: true, messageId: "a" })
  expect(state.reads).toBe(0)
}))

test("a saved target before a context boundary does not recover the current unknown segment", () => fixture(async ({ coordinator, store, chatId, state }) => {
  await store.appendMessage(chatId, timestamped({ kind: "context_cleared" }))
  await store.appendMessage(chatId, { ...timestamped({ kind: "user_prompt", content: "D" }), _id: "d" })
  state.error = new Error("Unrelated current history must stay unread")
  const actions = await coordinator.getHistoryActions(chatId, { recover: true, messageId: "a" })
  expect(actions.actions.a).toBe("ordinary")
  expect(actions.actions.d).toBe("recover")
  expect(state.reads).toBe(0)
}))

test("a legacy user append invalidates a checkpoint even without a revision field", () => fixture(async ({ coordinator, store, chatId, state }) => {
  state.inputs.splice(1, 0, { turnId: "turn-b", promptId: "b", text: "B", userIndex: 0 })
  await coordinator.getHistoryActions(chatId, { recover: true })
  const key = store.requireChat(chatId).codexHistoryIntegrity!.key
  // An older Kanna version retains unknown snapshot fields but appends the old event shape.
  ;(store as any).applyEvent({ type: "chat_last_message_at_set", chatId, at: Date.now() + 1000 })
  expect((coordinator as any).codexIntegrityKey(chatId)).not.toBe(key)
}))

for (const service of [{ hidden: true }, { parentToolUseId: "subagent" }]) {
  test(`local-only input preserves a classified gap and readiness: ${JSON.stringify(service)}`, () => fixture(async ({ coordinator, store, chatId, dir, state }) => {
    await coordinator.getHistoryActions(chatId, { recover: true })
    const key = store.requireChat(chatId).codexHistoryIntegrity!.key
    const revision = store.requireChat(chatId).promptHistoryRevision
    // An existing snapshot predates the dedicated integrity timestamp.
    delete store.requireChat(chatId).promptHistoryLastMessageAt
    await store.compact()
    await store.appendMessage(chatId, timestamped({ kind: "user_prompt", content: "service input", ...service }, Date.now() + 1000))
    expect(store.requireChat(chatId).promptHistoryRevision).toBe(revision)
    expect((coordinator as any).codexIntegrityKey(chatId)).toBe(key)
    store.getPromptHistoryEntries = () => { throw new Error("Local-only entry forced a transcript scan") }
    await (coordinator as any).assertCodexHistoryReady(chatId)
    expect(state.reads).toBe(1)
    for (const compacted of [false, true]) {
      if (compacted) await store.compact()
      const restartedStore = new EventStore(dir)
      await restartedStore.initialize()
      restartedStore.getPromptHistoryEntries = () => { throw new Error("Local-only entry forced a scan after restart") }
      const restarted = new AgentCoordinator({ store: restartedStore, onStateChange: () => {}, codexManager: {
        readPromptHistory: async () => { throw new Error("Native history reread after restart") },
        stopAll: () => {}, getResourceCounts: () => ({}),
      } as never })
      try {
        await (restarted as any).assertCodexHistoryReady(chatId)
        expect(restartedStore.requireChat(chatId).codexHistoryIntegrity?.messages?.b).toBe("missing")
      } finally { await restarted.dispose() }
    }
  }))
}

test("a visible input still invalidates readiness after a local-only timestamp change", () => fixture(async ({ coordinator, store, chatId }) => {
  await coordinator.getHistoryActions(chatId, { recover: true })
  const key = store.requireChat(chatId).codexHistoryIntegrity!.key
  const serviceAt = Date.now() + 1000
  await store.appendMessage(chatId, timestamped({ kind: "user_prompt", content: "service input", hidden: true }, serviceAt))
  // Visible inputs may arrive with an older timestamp than a service entry.
  await store.appendMessage(chatId, { ...timestamped({ kind: "user_prompt", content: "D" }, serviceAt - 500), _id: "d" })
  expect((coordinator as any).codexIntegrityKey(chatId)).not.toBe(key)
  expect((await coordinator.getHistoryActions(chatId)).actions.d).toBe("recover")
}))

test("local-only input arriving during recovery does not supersede the visible sequence", () => fixture(async ({ coordinator, store, chatId, state }) => {
  const manager = (coordinator as any).codexManager
  let release!: () => void, started!: () => void
  const gate = new Promise<void>(resolve => { release = resolve }), begun = new Promise<void>(resolve => { started = resolve })
  manager.readPromptHistory = async () => { state.reads++; started(); await gate; return { inputs: state.inputs } }
  const scanning = coordinator.getHistoryActions(chatId, { recover: true })
  const outcome = scanning.then(value => ({ value }), error => ({ error }))
  await begun
  await store.appendMessage(chatId, timestamped({ kind: "user_prompt", content: "service input", hidden: true }, Date.now() + 1000))
  release()
  expect(await outcome).toMatchObject({ value: { messages: { b: "missing" } } })
  await (coordinator as any).assertCodexHistoryReady(chatId)
  expect(state.reads).toBe(1)
}))

test("ready continuation reads a compact checkpoint without scanning transcript or native history", () => fixture(async ({ coordinator, store, chatId, state }) => {
  state.inputs.splice(1, 0, { turnId: "turn-b", promptId: "b", text: "B", userIndex: 0 })
  await coordinator.getHistoryActions(chatId, { recover: true })
  expect(state.reads).toBe(1)
  store.getPromptHistoryEntries = () => { throw new Error("Whole transcript scanned") }
  state.error = new Error("Native history reread")
  await (coordinator as any).assertCodexHistoryReady(chatId)
  expect(state.reads).toBe(1)
}))

test("the ready checkpoint survives a cold store restart", () => fixture(async ({ coordinator, chatId, dir, state }) => {
  state.inputs.splice(1, 0, { turnId: "turn-b", promptId: "b", text: "B", userIndex: 0 })
  await coordinator.getHistoryActions(chatId, { recover: true })
  const restartedStore = new EventStore(dir)
  await restartedStore.initialize()
  restartedStore.getPromptHistoryEntries = () => { throw new Error("Whole transcript scanned after restart") }
  const restarted = new AgentCoordinator({ store: restartedStore, onStateChange: () => {}, codexManager: {
    readPromptHistory: async () => { throw new Error("Native history reread after restart") },
    stopAll: () => {}, getResourceCounts: () => ({}),
  } as never })
  try { await (restarted as any).assertCodexHistoryReady(chatId) }
  finally { await restarted.dispose() }
}))

test("history replacement invalidates ready state even when message IDs stay unchanged", () => fixture(async ({ coordinator, store, chatId, state }) => {
  state.inputs.splice(1, 0, { turnId: "turn-b", promptId: "b", text: "B", userIndex: 0 })
  await coordinator.getHistoryActions(chatId, { recover: true })
  const before = store.requireChat(chatId).promptHistoryRevision
  await store.replaceTranscript(chatId, store.getMessages(chatId))
  expect(store.requireChat(chatId).promptHistoryRevision).not.toBe(before)
  expect(store.requireChat(chatId).codexHistoryIntegrity?.key).not.toBe((coordinator as any).codexIntegrityKey(chatId))
}))

test("ordinary accepted continuation updates ready state without a full history scan", () => fixture(async ({ coordinator, store, chatId, state }) => {
  state.inputs.splice(1, 0, { turnId: "turn-b", promptId: "b", text: "B", userIndex: 0 })
  await coordinator.getHistoryActions(chatId, { recover: true })
  store.getPromptHistoryEntries = () => { throw new Error("Whole transcript scanned during send") }
  state.error = new Error("Native history reread during send")
  await coordinator.send({ type: "chat.send", chatId, content: "D", provider: "codex" })
  expect(state.reads).toBe(1)
  expect(store.requireChat(chatId).codexHistoryIntegrity?.key).toBe((coordinator as any).codexIntegrityKey(chatId))
}))

test("a rejected native turn preserves confirmed history and its ready checkpoint", () => fixture(async ({ coordinator, store, chatId, state }) => {
  state.inputs.splice(1, 0, { turnId: "turn-b", promptId: "b", text: "B", userIndex: 0 })
  await coordinator.getHistoryActions(chatId, { recover: true })
  state.rejectTurn = true
  const original = store.getMessages(chatId), checkpoint = store.requireChat(chatId).codexHistoryIntegrity
  await expect(coordinator.send({ type: "chat.send", chatId, content: "D", provider: "codex" })).rejects.toThrow("Codex launch rejected")
  expect(store.getMessages(chatId)).toEqual(original)
  expect(store.requireChat(chatId).codexHistoryIntegrity).toEqual(checkpoint)
  expect(state.reads).toBe(1)
}))

test("checkpoint persistence failure stops an accepted turn and reports it without deleting the input", () => fixture(async ({ coordinator, store, chatId, state }) => {
  state.inputs.splice(1, 0, { turnId: "turn-b", promptId: "b", text: "B", userIndex: 0 })
  await coordinator.getHistoryActions(chatId, { recover: true })
  store.setCodexHistoryIntegrity = async () => { throw new Error("checkpoint EIO") }
  await expect(coordinator.send({ type: "chat.send", chatId, content: "D", provider: "codex" })).rejects.toThrow("checkpoint EIO")
  expect(store.getMessages(chatId).some(entry => entry.kind === "user_prompt" && entry.content === "D")).toBe(true)
  expect(store.getMessages(chatId).some(entry => entry.kind === "result" && entry.isError && entry.result.includes("checkpoint EIO"))).toBe(true)
  expect(coordinator.activeTurns.has(chatId)).toBe(false)
}))

test("the shared live binding writer advances readiness without scanning either history", () => fixture(async ({ coordinator, store, chatId, state }) => {
  state.inputs.splice(1, 0, { turnId: "turn-b", promptId: "b", text: "B", userIndex: 0 })
  await coordinator.getHistoryActions(chatId, { recover: true })
  await store.appendMessage(chatId, { ...timestamped({ kind: "user_prompt", content: "D" }), _id: "d" })
  store.getPromptHistoryEntries = () => { throw new Error("Whole transcript scanned") }
  state.error = new Error("Native history reread")
  await (coordinator as any).codexPromptHistory.recordPrompt(chatId, "d", {
    sessionToken: "source", turnId: "turn-c", mergeTurn: true,
  })
  expect(store.requireChat(chatId).codexHistoryIntegrity?.key).toBe((coordinator as any).codexIntegrityKey(chatId))
  await (coordinator as any).assertCodexHistoryReady(chatId)
  expect(state.reads).toBe(1)
}))

test("a shared binding checkpoint error propagates after the binding is durably saved", () => fixture(async ({ coordinator, history, store, chatId }) => {
  store.setCodexHistoryIntegrity = async () => { throw new Error("shared checkpoint EIO") }
  await expect((coordinator as any).codexPromptHistory.recordPrompt(chatId, "b", {
    sessionToken: "source", turnId: "turn-b", mergeTurn: false,
  })).rejects.toThrow("shared checkpoint EIO")
  expect((await history.read(chatId)).prompts.b?.turnId).toBe("turn-b")
}))

test("a pending binding write cannot publish readiness for a replaced native session", () => fixture(async ({ coordinator, store, chatId }) => {
  const history = (coordinator as any).codexPromptHistory as CodexPromptHistory
  let release!: () => void
  const pending = new Promise<void>(resolve => { release = resolve })
  ;(history as any).tails.set(chatId, pending)
  const original = store.requireChat(chatId).codexHistoryIntegrity
  const saving = history.recordPrompt(chatId, "b", { sessionToken: "source", turnId: "turn-b", mergeTurn: false })
  try {
    await store.setSessionToken(chatId, "replacement")
    release()
    await saving
    expect(store.requireChat(chatId).codexHistoryIntegrity).toEqual(original)
  } finally { release(); await saving }
}))

for (const outcome of ["accepted", "rejected", "write-failed"])
  test(`fork startup in a new native session: ${outcome}`, () => fixture(async ({ coordinator, store, history, chatId, dir, state }) => {
    state.inputs.splice(1, 0, { turnId: "turn-b", promptId: "b", text: "B", userIndex: 0 })
    await coordinator.getHistoryActions(chatId, { recover: true })
    const manager = (coordinator as any).codexManager
    manager.forkBeforeTurn = async () => "prepared-fork"
    manager.startSession = async (args: any) => {
      expect(args.pendingForkSessionToken).toBe("prepared-fork")
      return { sessionToken: "started-fork", resumeFellBack: false, startupOutcome: { kind: "forked" } }
    }
    manager.startTurn = async () => {
      if (outcome === "rejected") throw new Error("Fork input rejected")
      return { provider: "codex", providerTurnId: "new-turn", stream: (async function* () {
        yield { type: "session_token", sessionToken: "started-fork" }
        yield { type: "transcript", entry: timestamped({ kind: "result", subtype: "success", isError: false, durationMs: 0, result: "done" }) }
      })(), interrupt: async () => {}, close: () => {} }
    }
    state.error = new Error("Native history must not be reread")
    const child = await coordinator.forkChat({ type: "chat.fork", chatId, messageId: "b" })
    // Older local records store the boundary separately from the binding.
    await history.remember(child.chatId, {
      a: { sessionToken: "prepared-fork", turnId: "turn-a", mergeTurn: false },
    })
    await history.recordTurn(child.chatId, "prepared-fork", "turn-a", null)
    const before = store.getMessages(child.chatId)
    expect((await history.read(child.chatId)).prompts.a?.sessionToken).toBe("prepared-fork")
    if (outcome === "write-failed")
      (coordinator as any).codexPromptHistory.rebindSession = async () => { throw new Error("Fork bindings EIO") }
    const sending = coordinator.send({ type: "chat.send", chatId: child.chatId, content: "Edited B", provider: "codex" })
    if (outcome === "rejected") {
      await expect(sending).rejects.toThrow("Fork input rejected")
      expect(store.getMessages(child.chatId)).toEqual(before)
      expect((await history.read(child.chatId)).prompts.a?.sessionToken).toBe("prepared-fork")
    } else if (outcome === "write-failed") {
      await expect(sending).rejects.toThrow("Fork bindings EIO")
      const messages = store.getMessages(child.chatId)
      expect(messages.some(entry => entry.kind === "user_prompt" && entry.content.includes("Edited B"))).toBe(true)
      expect(messages.some(entry => entry.kind === "result" && entry.isError && entry.result.includes("Fork bindings EIO"))).toBe(true)
      expect(coordinator.activeTurns.has(child.chatId)).toBe(false)
      expect((await history.read(child.chatId)).prompts.a?.sessionToken).toBe("prepared-fork")
    } else {
      await sending
      for (let i = 0; i < 100 && coordinator.activeTurns.has(child.chatId); i++) await new Promise(resolve => setTimeout(resolve, 10))
      expect((await history.read(child.chatId)).prompts.a?.sessionToken).toBe("started-fork")
      expect((await history.read(child.chatId)).turns["started-fork:turn-a"]).toEqual({ boundaryEntryId: null })
      const restartedStore = new EventStore(dir)
      await restartedStore.initialize()
      const restarted = new AgentCoordinator({ store: restartedStore, onStateChange: () => {}, codexManager: {
        readPromptHistory: async () => { throw new Error("Native history read after fork restart") },
        stopAll: () => {}, getResourceCounts: () => ({}),
      } as never })
      try {
        const actions = await restarted.getHistoryActions(child.chatId)
        const prompts = restartedStore.getMessages(child.chatId).filter(entry => entry.kind === "user_prompt")
        expect(Object.values(actions.actions)).toEqual(prompts.map(() => "ordinary"))
        expect(actions.gap).toBeUndefined()
      } finally { await restarted.dispose() }
    }
    expect(state.reads).toBe(1)
  }))

for (const recoveryAction of ["open-action", "send"])
  test(`classification retains all chat history and metadata on ${recoveryAction}`, () => fixture(async ({ coordinator, store, history, chatId, state, dir }) => {
    state.inputs = []
    await history.remember(chatId, {}, ["a", "b", "c"])
    await store.renameChat(chatId, "Preserve this title")
    const original = [...store.getMessages(chatId)], revision = store.requireChat(chatId).promptHistoryRevision
    if (recoveryAction === "send") {
      await coordinator.send({ type: "chat.send", chatId, content: "D", provider: "codex" })
      for (let i = 0; i < 100 && coordinator.getResourceCounts().activeTurns; i++) await new Promise(resolve => setTimeout(resolve, 10))
      expect(store.requireChat(chatId).promptHistoryRevision).not.toBe(revision)
    } else {
      await coordinator.getHistoryActions(chatId, { recover: true })
      expect(store.requireChat(chatId).promptHistoryRevision).toBe(revision)
    }
    const after = [...store.getMessages(chatId)]
    expect(after.slice(0, original.length)).toEqual(original)
    expect(store.requireChat(chatId).title).toBe("Preserve this title")
    const actions = await coordinator.getHistoryActions(chatId)
    expect(actions.actions.a).toBe("ordinary")
    expect(actions.actions.b).toBeUndefined()
    expect(actions.actions.c).toBeUndefined()
    expect((actions as any).messages).toEqual({ a: "missing", b: "missing", c: "missing" })
    await coordinator.getHistoryActions(chatId, { recover: true, retry: true, messageId: "a" })
    expect(state.reads).toBe(1)
    const restartedStore = new EventStore(dir)
    await restartedStore.initialize()
    const restarted = new AgentCoordinator({ store: restartedStore, onStateChange: () => {}, codexManager: {
      readPromptHistory: async () => { throw new Error("Known gap reread after restart") }, stopAll: () => {}, getResourceCounts: () => ({}),
    } as never })
    try {
      expect((await restarted.getHistoryActions(chatId, { recover: true }) as any).messages).toEqual({ a: "missing", b: "missing", c: "missing" })
      expect(restartedStore.getMessages(chatId)).toEqual(after)
    } finally { await restarted.dispose() }
  }))

test("a failed scan never certifies readiness for a later send", () => fixture(async ({ coordinator, store, chatId, state }) => {
  const original = store.getMessages(chatId)
  state.error = new Error("Temporary API outage")
  await expect(coordinator.send({ type: "chat.send", chatId, content: "D", provider: "codex" })).rejects.toThrow("Temporary API outage")
  state.error = undefined
  await coordinator.send({ type: "chat.send", chatId, content: "D", provider: "codex" })
  for (let i = 0; i < 100 && coordinator.getResourceCounts().activeTurns; i++) await new Promise(resolve => setTimeout(resolve, 10))
  expect(state.reads).toBe(2)
  expect(store.getMessages(chatId).slice(0, original.length)).toEqual(original)
}))

test("checking progress is visible before the API response and cancellation keeps the transcript", () => fixture(async ({ coordinator, store, chatId, state }) => {
  const manager = (coordinator as any).codexManager
  let release!: () => void, started!: () => void
  const gate = new Promise<void>(resolve => { release = resolve }), begun = new Promise<void>(resolve => { started = resolve })
  manager.readPromptHistory = async () => { started(); await gate; return { inputs: state.inputs } }
  const original = store.getMessages(chatId)
  const scanning = coordinator.getHistoryActions(chatId, { recover: true })
  const rejected = scanning.then(() => "unexpected success", error => error.message)
  await begun
  expect(store.requireChat(chatId).codexHistoryIntegrity?.repair?.phase).toBe("running")
  expect(coordinator.getActiveStatuses().get(chatId)).toBe("starting")
  await expect(coordinator.send({ type: "chat.send", chatId, content: "D", provider: "codex" })).rejects.toThrow("being prepared")
  await coordinator.cancel(chatId)
  release()
  expect(await rejected).toContain("cancelled")
  expect(store.getMessages(chatId)).toEqual(original)
}))

for (const action of ["edit", "fork"])
  test(`provider-rejected saved boundary triggers one non-destructive scan on ${action}`, () => fixture(async ({ coordinator, history, store, chatId, state }) => {
    const { CodexRequestError } = await import("./codex-app-server")
    await history.remember(chatId, {
      b: { sessionToken: "source", turnId: "turn-b", mergeTurn: false, boundaryEntryId: "answer-a" },
      c: { sessionToken: "source", turnId: "turn-c", mergeTurn: false, boundaryEntryId: "answer-b" },
    })
    const manager = (coordinator as any).codexManager
    manager.forkBeforeTurn = async () => { throw new CodexRequestError("thread/fork", -32600, "beforeTurnId 'turn-b' was not found: invalid boundary") }
    const original = store.getMessages(chatId)
    await expect(action === "edit"
      ? coordinator.editUserPrompt({ type: "chat.editUserPrompt", chatId, messageId: "b", content: "Corrected B" })
      : coordinator.forkChat({ type: "chat.fork", chatId, messageId: "b" })).rejects.toThrow("History checked")
    expect(state.reads).toBe(1)
    expect(store.getMessages(chatId)).toEqual(original)
    const actions = await coordinator.getHistoryActions(chatId)
    expect(actions.actions).toEqual({ a: "ordinary", b: "ordinary", c: "ordinary" })
    expect(actions.messages).toEqual({ b: "missing" })
    expect((await history.read(chatId)).prompts.b).toBeUndefined()
  }))

test("transport failure while using a saved boundary does not invalidate bindings or scan", () => fixture(async ({ coordinator, history, chatId, state }) => {
  await history.remember(chatId, {
    b: { sessionToken: "source", turnId: "turn-b", mergeTurn: false, boundaryEntryId: "answer-a" },
    c: { sessionToken: "source", turnId: "turn-c", mergeTurn: false, boundaryEntryId: "answer-b" },
  })
  ;(coordinator as any).codexManager.forkBeforeTurn = async () => { throw new Error("Socket disconnected: turn not found in reply") }
  await expect(coordinator.editUserPrompt({ type: "chat.editUserPrompt", chatId, messageId: "b", content: "Corrected B" })).rejects.toThrow("Socket disconnected")
  expect(state.reads).toBe(0)
  expect((await history.read(chatId)).prompts.b?.turnId).toBe("turn-b")
}))

test("a rejected boundary from an earlier context scans that session without blocking the current one", () => fixture(async ({ coordinator, history, store, chatId, state }) => {
  const { CodexRequestError } = await import("./codex-app-server")
  await history.remember(chatId, {
    b: { sessionToken: "source", turnId: "turn-b", mergeTurn: false, boundaryEntryId: "answer-a" },
    c: { sessionToken: "source", turnId: "turn-c", mergeTurn: false, boundaryEntryId: "answer-b" },
    d: { sessionToken: "current", turnId: "turn-d", mergeTurn: false, boundaryEntryId: "reset" },
  })
  await store.appendMessage(chatId, { ...timestamped({ kind: "context_cleared" }), _id: "reset" })
  await store.appendMessage(chatId, { ...timestamped({ kind: "user_prompt", content: "D" }), _id: "d" })
  await store.setSessionToken(chatId, "current")
  const manager = (coordinator as any).codexManager
  manager.readPromptHistory = async (args: any) => { state.reads++; expect(args.threadId).toBe("source"); return { inputs: state.inputs } }
  manager.forkBeforeTurn = async () => { throw new CodexRequestError("thread/fork", -32600, "beforeTurnId 'turn-b' was not found") }
  const original = store.getMessages(chatId)
  await expect(coordinator.editUserPrompt({ type: "chat.editUserPrompt", chatId, messageId: "b", content: "Corrected B" })).rejects.toThrow("History checked")
  const actions = await coordinator.getHistoryActions(chatId)
  expect(actions.actions).toEqual({ a: "ordinary", b: "ordinary", c: "ordinary", d: "ordinary" })
  expect(actions.messages).toEqual({ b: "missing" })
  await (coordinator as any).assertCodexHistoryReady(chatId)
  expect(state.reads).toBe(1)
  expect(store.getMessages(chatId)).toEqual(original)
}))

test("legacy gap metadata is classified once without losing local-only service entries or overlays", () => fixture(async ({ coordinator, store, chatId, state }) => {
  const entries = store.getMessages(chatId)
  const prompt = entries[2] as any
  prompt.questions = [{ id: "question", question: "Keep the local answer", answer: "Yes" }]
  prompt.attachments = [{ id: "attachment", name: "local.txt", path: "/fixture/local.txt", mimeType: "text/plain" }]
  await store.replaceTranscript(chatId, [...entries,
    { ...timestamped({ kind: "context_window_updated", contextWindow: 100 }), _id: "local-only" } as any,
  ])
  await store.setCodexHistoryIntegrity(chatId, { key: (coordinator as any).codexIntegrityKey(chatId), gap: { messageId: "b", error: "legacy gap" } })
  const original = store.getMessages(chatId)
  expect(state.reads).toBe(0)
  await (coordinator as any).assertCodexHistoryReady(chatId)
  expect(state.reads).toBe(1)
  expect(store.getMessages(chatId)).toEqual(original)
  expect((await coordinator.getHistoryActions(chatId)).messages).toEqual({ b: "missing" })
  await (coordinator as any).assertCodexHistoryReady(chatId)
  expect(state.reads).toBe(1)
}))

test("full-chat fork cannot copy an in-flight history check", () => fixture(async ({ coordinator, chatId, state }) => {
  let started!: () => void, release!: () => void
  const begun = new Promise<void>(resolve => { started = resolve }), gate = new Promise<void>(resolve => { release = resolve })
  ;(coordinator as any).codexManager.readPromptHistory = async () => { started(); await gate; return { inputs: state.inputs } }
  const scan = coordinator.getHistoryActions(chatId, { recover: true })
  await begun
  try { await expect(coordinator.forkChat(chatId)).rejects.toThrow("history check") }
  finally { release(); await scan }
}))

test("a classified gap keeps its markers and replay after a new context is accepted", () => fixture(async ({ coordinator, store, chatId, state }) => {
  await coordinator.getHistoryActions(chatId, { recover: true })
  await store.appendMessage(chatId, { ...timestamped({ kind: "context_cleared" }), _id: "reset" })
  await store.setSessionToken(chatId, "current")
  expect((await coordinator.getHistoryActions(chatId)).messages).toEqual({ b: "missing" })
  await store.appendMessage(chatId, { ...timestamped({ kind: "user_prompt", content: "D" }), _id: "d" })
  await (coordinator as any).codexPromptHistory.recordPrompt(chatId, "d", {
    sessionToken: "current", turnId: "turn-d", mergeTurn: false,
  })
  state.error = new Error("Classified old gap must not be reread")
  const actions = await coordinator.getHistoryActions(chatId, { recover: true, messageId: "b" })
  expect(actions.messages).toEqual({ b: "missing" })
  expect(actions.actions).toEqual({ a: "ordinary", b: "ordinary", c: "ordinary", d: "ordinary" })
  expect(state.reads).toBe(1)
}))

test("historical recovery returns both historical and current gap markers and replay actions", () => fixture(async ({ coordinator, store, history, chatId, state }) => {
  await store.appendMessage(chatId, { ...timestamped({ kind: "context_cleared" }), _id: "reset" })
  await store.appendMessage(chatId, { ...timestamped({ kind: "user_prompt", content: "D" }), _id: "d" })
  await store.appendMessage(chatId, { ...timestamped({ kind: "assistant_text", text: "Answer D" }), _id: "answer-d" })
  await store.appendMessage(chatId, { ...timestamped({ kind: "user_prompt", content: "E" }), _id: "e" })
  await store.setSessionToken(chatId, "current")
  await history.remember(chatId, {
    b: { sessionToken: "source", turnId: "turn-b", mergeTurn: false, boundaryEntryId: "answer-a" },
    d: { sessionToken: "current", turnId: "turn-d", mergeTurn: false, boundaryEntryId: "reset" },
  })
  const oldInputs = state.inputs
  ;(coordinator as any).codexManager.readPromptHistory = async ({ threadId }: any) => {
    state.reads++
    return { inputs: threadId === "source" ? oldInputs : [{ turnId: "turn-d", promptId: "d", text: "D", userIndex: 0 }] }
  }
  await coordinator.getHistoryActions(chatId, { recover: true })
  const actions = await coordinator.getHistoryActions(chatId, { recover: true, messageId: "b", ...{ force: true } })
  expect(actions.messages).toEqual({ b: "missing", e: "missing" })
  expect(actions.actions).toEqual({ a: "ordinary", b: "ordinary", c: "ordinary", d: "ordinary", e: "ordinary" })
  expect(state.reads).toBe(2)
}))

for (const message of ["unknown field 'beforeTurnId'", "missing authentication token while returning thread"])
  test(`structured non-history error preserves bindings: ${message}`, () => fixture(async ({ coordinator, history, chatId, state }) => {
    const { CodexRequestError } = await import("./codex-app-server")
    await history.remember(chatId, { b: { sessionToken: "source", turnId: "turn-b", mergeTurn: false, boundaryEntryId: "answer-a" } })
    ;(coordinator as any).codexManager.forkBeforeTurn = async () => { throw new CodexRequestError("thread/fork", -32602, message) }
    await expect(coordinator.editUserPrompt({ type: "chat.editUserPrompt", chatId, messageId: "b", content: "Corrected B" })).rejects.toThrow(message)
    expect(state.reads).toBe(0)
    expect((await history.read(chatId)).prompts.b?.turnId).toBe("turn-b")
  }))


test("ordinary continuation retains classified missing messages and their later native bindings", () => fixture(async ({ coordinator, store, history, chatId, state }) => {
  const original = [...store.getMessages(chatId)]
  await coordinator.getHistoryActions(chatId, { recover: true })
  await coordinator.send({ type: "chat.send", chatId, content: "D", provider: "codex" })
  for (let i = 0; i < 100 && coordinator.getResourceCounts().activeTurns; i++) await new Promise(resolve => setTimeout(resolve, 10))
  expect(store.getMessages(chatId).slice(0, original.length)).toEqual(original)
  const actions = await coordinator.getHistoryActions(chatId)
  expect(actions.messages).toEqual({ b: "missing" })
  expect(actions.actions.c).toBe("ordinary")
  const last = store.getPromptHistoryEntries(chatId).filter(entry => entry.kind === "user_prompt").at(-1)!
  expect(actions.actions[last._id]).toBe("ordinary")
  expect((await history.read(chatId)).prompts.c?.turnId).toBe("turn-c")
  expect(state.reads).toBe(1)
}))

test("legacy classifications offer recovery for an unmarked later message only when used", () => fixture(async ({ coordinator, store, chatId, state }) => {
  const gap = { messageId: "b", error: "Old prefix-only classification" }
  await store.setCodexHistoryIntegrity(chatId, { key: (coordinator as any).codexIntegrityKey(chatId), gap, messages: { b: "missing" },
    segments: { source: { ids: ["a", "b", "c"], gap, messages: { b: "missing" } } } })
  expect((await coordinator.getHistoryActions(chatId)).actions.c).toBe("recover")
  expect(state.reads).toBe(0)
  expect((await coordinator.getHistoryActions(chatId, { recover: true, messageId: "c" })).actions.c).toBe("ordinary")
  expect(state.reads).toBe(1)
}))


test("editing a confirmed message after a missing one retains the missing marker and replay boundary", () => fixture(async ({ coordinator, store, chatId, state }) => {
  await coordinator.getHistoryActions(chatId, { recover: true })
  const manager = (coordinator as any).codexManager
  manager.forkBeforeTurn = async () => "prepared"
  manager.startSession = async () => ({ sessionToken: "prepared", resumeFellBack: false, startupOutcome: { kind: "resumed" } })
  manager.startTurn = async () => ({ provider: "codex", providerTurnId: "edited", stream: (async function* () {
    yield { type: "session_token", sessionToken: "prepared" }
    yield { type: "transcript", entry: timestamped({ kind: "result", subtype: "success", isError: false, durationMs: 0, result: "done" }) }
  })(), interrupt: async () => {}, close: () => {} })
  await coordinator.editUserPrompt({ type: "chat.editUserPrompt", chatId, messageId: "c", content: "Corrected C" })
  for (let i = 0; i < 100 && coordinator.getResourceCounts().activeTurns; i++) await new Promise(resolve => setTimeout(resolve, 10))
  const actions = await coordinator.getHistoryActions(chatId)
  expect(actions.messages).toEqual({ b: "missing" })
  expect(actions.actions.b).toBe("ordinary")
  expect(store.requireChat(chatId).codexHistoryIntegrity?.segments?.prepared?.messages).toEqual({ b: "missing" })
  expect(state.reads).toBe(1)
}))


test("a classified native context cannot fall back to resending its retained local history", () => fixture(async ({ coordinator, store, chatId }) => {
  await coordinator.getHistoryActions(chatId, { recover: true })
  const original = [...store.getMessages(chatId)]
  ;(coordinator as any).codexManager.startSession = async () => ({ sessionToken: "fresh", resumeFellBack: true, startupOutcome: { kind: "fresh" } })
  await expect(coordinator.send({ type: "chat.send", chatId, content: "D", provider: "codex" })).rejects.toThrow("resume")
  expect(store.getMessages(chatId)).toEqual(original)
}))

test("forking a confirmed message after a missing one copies markers without changing the source", () => fixture(async ({ coordinator, store, chatId, state }) => {
  await coordinator.getHistoryActions(chatId, { recover: true })
  ;(coordinator as any).codexManager.forkBeforeTurn = async () => "prepared"
  const original = [...store.getMessages(chatId)]
  const fork = await coordinator.forkChat({ type: "chat.fork", chatId, messageId: "c" })
  const actions = await coordinator.getHistoryActions(fork.chatId)
  expect(actions.messages).toEqual({ b: "missing" })
  expect(actions.actions.b).toBe("ordinary")
  expect(store.getMessages(chatId)).toEqual(original)
  expect(state.reads).toBe(1)
}))

test("the first fork continuation moves missing classifications with the accepted native prefix", () => fixture(async ({ coordinator, store, chatId, state }) => {
  await coordinator.getHistoryActions(chatId, { recover: true })
  const manager = (coordinator as any).codexManager
  manager.forkBeforeTurn = async () => "prepared"
  const fork = await coordinator.forkChat({ type: "chat.fork", chatId, messageId: "c" })
  manager.startSession = async () => ({ sessionToken: "accepted-fork", resumeFellBack: false, startupOutcome: { kind: "forked" } })
  manager.startTurn = async () => ({ provider: "codex", providerTurnId: "continued", stream: (async function* () {
    yield { type: "session_token", sessionToken: "accepted-fork" }
    yield { type: "transcript", entry: timestamped({ kind: "result", subtype: "success", isError: false, durationMs: 0, result: "done" }) }
  })(), interrupt: async () => {}, close: () => {} })
  await coordinator.send({ type: "chat.send", chatId: fork.chatId, content: "D", provider: "codex" })
  for (let i = 0; i < 100 && coordinator.getResourceCounts().activeTurns; i++) await new Promise(resolve => setTimeout(resolve, 10))
  const actions = await coordinator.getHistoryActions(fork.chatId)
  expect(actions.messages).toEqual({ b: "missing" })
  expect(actions.actions.b).toBe("ordinary")
  expect(actions.actions.a).toBe("ordinary")
  const accepted = store.getPromptHistoryEntries(fork.chatId).filter(entry => entry.kind === "user_prompt").at(-1)!
  expect(actions.actions[accepted._id]).toBe("ordinary")
  expect(store.requireChat(fork.chatId).codexHistoryIntegrity?.segments?.["accepted-fork"]?.messages).toEqual({ b: "missing" })
  await (coordinator as any).assertCodexHistoryReady(fork.chatId)
  expect(state.reads).toBe(1)
}))
