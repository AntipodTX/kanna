import { test, expect } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { EventStore } from "./event-store"
import { AgentCoordinator } from "./agent"
import { timestamped } from "./transcript"
import { CodexPromptHistory } from "./codex-prompt-history"

test("saved earlier-session merge actions remain disclosed after context reset", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "kanna-codex-old-actions-"))
  let coordinator: AgentCoordinator | undefined
  try {
    const store = new EventStore(dir)
    await store.initialize()
    const project = await store.openProject(dir, "Project"),
      chat = await store.createChat(project.id)
    await store.setChatProvider(chat.id, "codex")
    await store.setSessionToken(chat.id, "new-source")
    await store.replaceTranscript(chat.id, [
      {
        ...timestamped({ kind: "user_prompt", content: "Catalogue" }),
        _id: "first",
      },
      {
        ...timestamped({ kind: "user_prompt", content: "Search" }),
        _id: "target",
      },
      timestamped({ kind: "context_cleared" }),
      {
        ...timestamped({ kind: "user_prompt", content: "New task" }),
        _id: "new",
      },
    ])
    await new CodexPromptHistory(dir).remember(chat.id, {
      first: { sessionToken: "old-source", turnId: "old", mergeTurn: false },
      target: { sessionToken: "old-source", turnId: "old", mergeTurn: true },
      new: { sessionToken: "new-source", turnId: "new", mergeTurn: false },
    })
    const cuts: Array<{ threadId: string; beforeTurnId: string }> = []
    coordinator = new AgentCoordinator({
      store,
      onStateChange: () => {},
      codexManager: {
        readPromptHistory: async () => ({ inputs: [{ turnId: "new", userIndex: 0, text: "New task", promptId: "new" }] }),
        forkBeforeTurn: async (args: {
          threadId: string
          beforeTurnId: string
        }) => {
          cuts.push(args)
          return args.threadId === "new-source" ? "prepared" : "older-prepared"
        },
        stopAll: () => {},
        getResourceCounts: () => ({}),
      } as never,
    })
    expect((await coordinator.getHistoryActions(chat.id, { recover: true })).actions).toEqual({
      first: "ordinary",
      target: "merge-turn",
      new: "ordinary",
    })
    const child = await coordinator.forkChat({
      type: "chat.fork",
      chatId: chat.id,
      messageId: "new",
    })
    expect(
      (await new CodexPromptHistory(dir).read(child.chatId)).prompts.target
        ?.sessionToken,
    ).toBe("old-source")
    await coordinator.forkChat({
      type: "chat.fork",
      chatId: child.chatId,
      messageId: "target",
    })
    expect(
      cuts.map(({ threadId, beforeTurnId }) => ({ threadId, beforeTurnId })),
    ).toEqual([
      { threadId: "new-source", beforeTurnId: "new" },
      { threadId: "old-source", beforeTurnId: "old" },
    ])
  } finally {
    await coordinator?.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})

test("backfill uses a saved hidden-turn boundary before looking for a visible start marker", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "kanna-codex-hidden-binding-"))
  let coordinator: AgentCoordinator | undefined
  try {
    const store = new EventStore(dir)
    await store.initialize()
    const project = await store.openProject(dir, "Project"),
      chat = await store.createChat(project.id)
    await store.setChatProvider(chat.id, "codex")
    await store.setSessionToken(chat.id, "source")
    await store.replaceTranscript(chat.id, [
      {
        ...timestamped({ kind: "user_prompt", content: "Earlier" }),
        _id: "first",
      },
      {
        ...timestamped({ kind: "assistant_text", text: "prior result" }),
        _id: "before",
      },
      timestamped({ kind: "assistant_text", text: "hidden progress" }),
      {
        ...timestamped({ kind: "user_prompt", content: "Search" }),
        _id: "target",
      },
    ])
    await new CodexPromptHistory(dir).recordTurn(
      chat.id,
      "source",
      "hidden",
      "before",
    )
    coordinator = new AgentCoordinator({
      store,
      onStateChange: () => {},
      codexManager: {
        readPromptHistory: async () => ({
          inputs: [
            { turnId: "one", userIndex: 0, text: "Earlier", promptId: "first" },
            { turnId: "hidden", userIndex: 0, text: "Continue" },
            {
              turnId: "hidden",
              userIndex: 1,
              text: "Search",
              promptId: "target",
            },
          ],
        }),
        stopAll: () => {},
        getResourceCounts: () => ({}),
      } as never,
    })
    expect((await coordinator.getHistoryActions(chat.id, { recover: true })).actions).toEqual({
      first: "ordinary",
      target: "merge-turn",
    })
    expect(
      (await new CodexPromptHistory(dir).read(chat.id)).prompts.target
        ?.boundaryEntryId,
    ).toBe("before")
  } finally {
    await coordinator?.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})

test("cached Codex action classification refuses a chat changed during journal read", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "kanna-codex-action-race-"))
  let coordinator: AgentCoordinator | undefined
  try {
    const store = new EventStore(dir)
    await store.initialize()
    const project = await store.openProject(dir, "Project")
    const chat = await store.createChat(project.id)
    await store.setChatProvider(chat.id, "codex")
    await store.setSessionToken(chat.id, "source")
    await store.replaceTranscript(chat.id, [
      {
        ...timestamped({ kind: "user_prompt", content: "Search" }),
        _id: "target",
      },
    ])
    coordinator = new AgentCoordinator({
      store,
      onStateChange: () => {},
      codexManager: {
        readPromptHistory: async () => ({
          inputs: [
            {
              turnId: "turn",
              userIndex: 0,
              text: "Search",
              promptId: "target",
            },
          ],
        }),
        stopAll: () => {},
        getResourceCounts: () => ({}),
      } as never,
    })
    expect((await coordinator.getHistoryActions(chat.id, { recover: true })).actions).toEqual({
      target: "ordinary",
    })
    const history = (
      coordinator as unknown as {
        codexPromptHistory: { read: (id: string) => Promise<any> }
      }
    ).codexPromptHistory
    const read = history.read.bind(history)
    let entered: () => void = () => {},
      release: () => void = () => {}
    const reading = new Promise<void>((resolve) => (entered = resolve)),
      gate = new Promise<void>((resolve) => (release = resolve))
    history.read = async (id) => {
      entered()
      await gate
      return read(id)
    }
    const operation = coordinator.getHistoryActions(chat.id)
    await reading
    await store.setSessionToken(chat.id, "successor")
    release()
    await expect(operation).rejects.toThrow("changed")
  } finally {
    await coordinator?.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})

for (const scenario of [
  "cancel",
  "startup-failure",
  "pending-draft",
  "cancel-publication",
  "journal-failure",
  "retained-journal-failure",
  "cancel-fork-publication",
  "cancel-completion",
] as const)
  test(`Codex history handles ${scenario} without damaging source history`, async () => {
    const dir = await mkdtemp(
      path.join(tmpdir(), "kanna-codex-history-safety-"),
    )
    let coordinator: AgentCoordinator | undefined
    try {
      const store = new EventStore(dir)
      await store.initialize()
      const project = await store.openProject(dir, "Project")
      const chat = await store.createChat(project.id)
      await store.setChatProvider(chat.id, "codex")
      await store.setSessionToken(
        chat.id,
        scenario === "pending-draft" ? null : "source",
      )
      if (scenario === "pending-draft") {
        await store.setPendingForkSessionToken(chat.id, "prepared")
        await store.setPendingForkUserPrompt(chat.id, true)
      }
      await store.replaceTranscript(chat.id, [
        {
          ...timestamped({ kind: "user_prompt", content: "Search" }),
          _id: "target",
        },
      ])
      const original = store.getMessages(chat.id)
      let interrupts = 0
      let stops = 0
      let finishPreparation: () => void = () => {}
      let preparationStarted: () => void = () => {}
      const preparing = new Promise<void>(
        (resolve) => (preparationStarted = resolve),
      )
      const release = new Promise<void>(
        (resolve) => (finishPreparation = resolve),
      )
      let cuts = 0
      let cancellation: Promise<void> | undefined
      const manager = {
        readPromptHistory: async () => ({
          inputs: [
            {
              turnId: "turn",
              promptId: "target",
              text: "Search",
              userIndex: 0,
            },
          ],
        }),
        forkBeforeTurn: async () => {
          cuts++
          if (
            scenario !== "cancel-publication" &&
            scenario !== "cancel-fork-publication"
          )
            preparationStarted()
          if (scenario === "cancel") await release
          return "prepared"
        },
        startSession: async () => ({
          sessionToken: "prepared",
          resumeFellBack: false,
        }),
        startTurn: async () => {
          if (scenario === "startup-failure") throw new Error("startup failed")
          return {
            provider: "codex",
            providerTurnId: "new",
            stream: (async function* () {
              yield { type: "session_token", sessionToken: "prepared" }
              yield {
                type: "transcript",
                entry: timestamped({
                  kind: "result",
                  subtype: "success",
                  isError: false,
                  durationMs: 0,
                  result: "done",
                }),
              }
            })(),
            interrupt: async () => {
              interrupts++
            },
            close: () => {},
          }
        },
        listModels: async () => [],
        stopSession: () => {
          stops++
        },
        stopAll: () => {},
        getResourceCounts: () => ({}),
      }
      coordinator = new AgentCoordinator({
        store,
        codexManager: manager as never,
        onStateChange: () => {
          if (scenario === "cancel-completion" && coordinator?.getResourceCounts().activeTurns) {
            cancellation ??= coordinator.cancel(chat.id)
          }
        },
        checkSessionArtifact: () => ({ status: "exists" }) as never,
      })
      if (scenario === "journal-failure") {
        ;(
          coordinator as unknown as {
            codexPromptHistory: { recordTurn: () => Promise<void> }
          }
        ).codexPromptHistory.recordTurn = async () => {
          throw new Error("journal EIO")
        }
      }
      if (scenario === "retained-journal-failure") {
        const history = (
          coordinator as unknown as {
            codexPromptHistory: { remember: (...args: any[]) => Promise<void> }
          }
        ).codexPromptHistory
        const remember = history.remember.bind(history)
        let writes = 0
        history.remember = async (...args) => {
          if (++writes === 2) throw new Error("retained journal EIO")
          await remember(...args)
        }
      }
      if (scenario === "cancel-publication") {
        const replace = store.replaceTranscript.bind(store)
        store.replaceTranscript = async (
          ...args: Parameters<typeof replace>
        ) => {
          preparationStarted()
          await release
          await replace(...args)
        }
      }
      if (scenario === "cancel-fork-publication") {
        const fork = store.forkChat.bind(store)
        store.forkChat = async (...args: Parameters<typeof fork>) => {
          preparationStarted()
          await release
          return fork(...args)
        }
      }
      const operation =
        scenario === "cancel-fork-publication"
          ? coordinator.forkChat({
              type: "chat.fork",
              chatId: chat.id,
              messageId: "target",
            })
          : coordinator.editUserPrompt({
              type: "chat.editUserPrompt",
              chatId: chat.id,
              messageId: "target",
              content: "Find",
            })
      if (
        scenario === "cancel" ||
        scenario === "cancel-publication" ||
        scenario === "cancel-fork-publication"
      ) {
        await preparing
        await coordinator.cancel(chat.id)
        finishPreparation()
        await expect(operation).rejects.toThrow("cancelled")
      } else if (scenario === "cancel-completion") {
        await expect(operation).rejects.toThrow("cancelled")
        await cancellation
      } else if (scenario === "journal-failure") {
        await expect(operation).rejects.toThrow("journal EIO")
        expect(interrupts).toBe(1)
        expect(stops).toBeGreaterThan(0)
      } else if (scenario === "retained-journal-failure") {
        await expect(operation).rejects.toThrow("retained journal EIO")
        expect(interrupts).toBeGreaterThan(0)
      } else if (scenario === "startup-failure")
        await expect(operation).rejects.toThrow("startup failed")
      else {
        await operation
        for (
          let i = 0;
          i < 100 && coordinator.getResourceCounts().activeTurns;
          i++
        )
          await new Promise((resolve) => setTimeout(resolve, 10))
        expect(cuts).toBe(0)
        expect(
          store
            .getMessages(chat.id)
            .filter((e) => e.kind === "user_prompt")
            .map((e) => e.content),
        ).toEqual(["Find"])
      }
      if (scenario === "journal-failure" || scenario === "retained-journal-failure") {
        expect(store.getMessages(chat.id).filter((e) => e.kind === "user_prompt").map((e) => e.content)).toEqual(["Find"])
        expect(store.requireChat(chat.id).sessionToken).toBe("prepared")
      } else if (scenario !== "pending-draft") {
        expect(store.getMessages(chat.id)).toEqual(original)
        expect(store.requireChat(chat.id).sessionToken).toBe("source")
      }
      if (scenario === "cancel-fork-publication")
        expect(store.listChatsByProject(project.id)).toHaveLength(1)
      if (scenario === "cancel-publication") {
        expect(interrupts).toBeGreaterThan(0)
        expect(coordinator.getResourceCounts().activeTurns).toBe(0)
      }
    } finally {
      await coordinator?.dispose()
      await rm(dir, { recursive: true, force: true })
    }
  })

for (const action of ["edit", "fork"] as const)
  test(`Codex ${action} uses exact turn boundary and combines mid-turn inputs`, async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "kanna-codex-boundary-"))
    let coordinator: AgentCoordinator | undefined
    try {
      const store = new EventStore(dir)
      await store.initialize()
      const project = await store.openProject(dir, "Project")
      const chat = await store.createChat(project.id)
      await store.setChatProvider(chat.id, "codex")
      await store.setSessionToken(chat.id, "source")
      const first = {
        ...timestamped({ kind: "user_prompt", content: "Earlier" }),
        _id: "first",
      }
      const start = {
        ...timestamped({ kind: "user_prompt", content: "Catalogue" }),
        _id: "start",
      }
      const target = {
        ...timestamped({
          kind: "user_prompt",
          content: "Search",
          steered: true,
        }),
        _id: "target",
      }
      const later = {
        ...timestamped({ kind: "user_prompt", content: "Later" }),
        _id: "later",
      }
      const entries = [
        first,
        timestamped({ kind: "assistant_text", text: "old answer" }),
        start,
        timestamped({ kind: "assistant_text", text: "old progress" }),
        timestamped({
          kind: "user_prompt",
          content: "Child agent instructions",
          parentToolUseId: "subagent-tool",
        }),
        target,
        later,
      ]
      await store.replaceTranscript(chat.id, entries)
      const source = store.getMessages(chat.id)
      const cuts: unknown[] = []
      const sent: string[] = []
      const manager = {
        readPromptHistory: async () => ({
          inputs: [
            { turnId: "one", promptId: "first", text: "Earlier", userIndex: 0 },
            { turnId: "hidden", text: "Continue", userIndex: 0 },
            {
              turnId: "two",
              promptId: "start",
              text: "Catalogue",
              userIndex: 0,
            },
            { turnId: "two", promptId: "target", text: "Search", userIndex: 1 },
            { turnId: "three", promptId: "later", text: "Later", userIndex: 0 },
          ],
        }),
        forkBeforeTurn: async (args: unknown) => {
          cuts.push(args)
          return "prepared"
        },
        startSession: async () => ({
          sessionToken: "prepared",
          resumeFellBack: false,
        }),
        startTurn: async (args: { content: string }) => {
          sent.push(args.content)
          return {
            provider: "codex",
            providerTurnId: "new-turn",
            stream: (async function* () {
              yield { type: "session_token", sessionToken: "prepared" }
              yield {
                type: "transcript",
                entry: timestamped({
                  kind: "result",
                  subtype: "success",
                  isError: false,
                  durationMs: 0,
                  result: "done",
                }),
              }
            })(),
            interrupt: async () => {},
            close: () => {},
          }
        },
        listModels: async () => [],
        stopSession: () => {},
        stopAll: () => {},
        getResourceCounts: () => ({}),
      }
      coordinator = new AgentCoordinator({
        store,
        codexManager: manager as never,
        onStateChange: () => {},
        checkSessionArtifact: () => ({ status: "exists" }) as never,
      })
      const { actions } = await coordinator.getHistoryActions(chat.id, { recover: true })
      expect(actions.target).toBe("merge-turn")
      expect(actions.start).toBe("ordinary")
      const result =
        action === "edit"
          ? await coordinator.editUserPrompt({
              type: "chat.editUserPrompt",
              chatId: chat.id,
              messageId: "target",
              content: "Find by name",
            })
          : await coordinator.forkChat({
              type: "chat.fork",
              chatId: chat.id,
              messageId: "target",
            })
      expect(cuts).toMatchObject([{ threadId: "source", beforeTurnId: "two" }])
      if (action === "edit") {
        for (
          let i = 0;
          i < 100 && coordinator.getResourceCounts().activeTurns;
          i++
        )
          await new Promise((resolve) => setTimeout(resolve, 10))
        expect(coordinator.getResourceCounts().activeTurns).toBe(0)
        expect(sent[0]).toContain("Catalogue\nFind by name")
        const prompts = store
          .getMessages(chat.id)
          .filter((e) => e.kind === "user_prompt")
        expect(prompts.map((e) => e.content)).toEqual([
          "Earlier",
          "Catalogue\nFind by name",
        ])
      } else {
        expect(store.getMessages(chat.id)).toEqual(source)
        expect(store.requireChat(chat.id).sessionToken).toBe("source")
        const fork = store
          .getMessages(result.chatId)
          .filter((e) => e.kind === "user_prompt")
        expect(fork.map((e) => e.content)).toEqual([
          "Earlier",
          "Catalogue\nSearch",
        ])
      }
    } finally {
      await coordinator?.dispose()
      await rm(dir, { recursive: true, force: true })
    }
  })
