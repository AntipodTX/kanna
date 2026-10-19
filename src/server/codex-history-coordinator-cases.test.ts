import { test, expect } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { EventStore } from "./event-store"
import { AgentCoordinator } from "./agent"
import { timestamped } from "./transcript"
import type { TranscriptEntry } from "../shared/types"

async function fixture(
  run: (args: {
    store: EventStore
    coordinator: AgentCoordinator
    chatId: string
    prompts: Extract<TranscriptEntry, { kind: "user_prompt" }>[]
    cuts: any[]
    starts: any[]
    fail: { preparation: boolean; startup: boolean }
    entries: TranscriptEntry[]
  }) => Promise<void>,
  count = 3,
  pending = false,
) {
  const dir = await mkdtemp(path.join(tmpdir(), "kanna-codex-action-cases-"))
  let coordinator: AgentCoordinator | undefined
  try {
    const store = new EventStore(dir)
    await store.initialize()
    const project = await store.openProject(dir, "Project")
    const chat = await store.createChat(project.id)
    await store.setChatProvider(chat.id, "codex")
    await store.renameChat(chat.id, "Task")
    await store.setSessionToken(chat.id, pending ? null : "source")
    if (pending) {
      await store.setPendingForkSessionToken(chat.id, "pending-source")
      await store.setPendingForkUserPrompt(chat.id, true)
    }
    const prompts = Array.from(
      { length: count },
      (_, i) =>
        ({
          ...timestamped({ kind: "user_prompt", content: `Task ${i + 1}` }),
          _id: `prompt-${i + 1}`,
        }) as Extract<TranscriptEntry, { kind: "user_prompt" }>,
    )
    const entries = prompts.flatMap((prompt, i) =>
      pending && i === count - 1
        ? [prompt]
        : [
            prompt,
            timestamped({ kind: "assistant_text", text: `Answer ${i + 1}` }),
            timestamped({
              kind: "result",
              subtype: "success",
              isError: false,
              durationMs: 0,
              result: "done",
            }),
          ],
    )
    await store.replaceTranscript(chat.id, entries)
    const cuts: any[] = []
    const starts: any[] = []
    const fail = { preparation: false, startup: false }
    const manager = {
      readPromptHistory: async () => ({
        inputs: prompts.slice(0, pending ? -1 : undefined).map((prompt, i) => ({
          turnId: `native-${i + 1}`,
          userIndex: 0,
          promptId: prompt._id,
          text: prompt.content,
        })),
      }),
      forkBeforeTurn: async (args: any) => {
        cuts.push(args)
        if (fail.preparation) throw new Error("native preparation failed")
        return "prepared"
      },
      startSession: async (args: any) => {
        starts.push(args)
        if (fail.startup) throw new Error("provider startup failed")
        return { sessionToken: "prepared", resumeFellBack: false }
      },
      startTurn: async () => ({
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
        interrupt: async () => {},
        close: () => {},
      }),
      stopSession: () => {},
      stopAll: () => {},
      listModels: async () => [],
      getResourceCounts: () => ({}),
    }
    coordinator = new AgentCoordinator({
      store,
      codexManager: manager as never,
      onStateChange: () => {},
      checkSessionArtifact: () => ({ status: "exists" }) as never,
    })
    await run({
      store,
      coordinator,
      chatId: chat.id,
      prompts,
      cuts,
      starts,
      fail,
      entries,
    })
    for (let i = 0; i < 100 && coordinator.getResourceCounts().activeTurns; i++)
      await new Promise((resolve) => setTimeout(resolve, 10))
    expect(coordinator.getResourceCounts().activeTurns).toBe(0)
  } finally {
    await coordinator?.dispose()
    await rm(dir, { recursive: true, force: true })
  }
}

for (const count of [1, 2, 3])
  for (const target of count === 1 ? [0] : [0, 1])
    test(`Codex edit selects native turn ${target + 1} of ${count} and preserves the preceding prefix`, () =>
      fixture(async ({ store, coordinator, chatId, prompts, cuts }) => {
        await coordinator.editUserPrompt({
          type: "chat.editUserPrompt",
          chatId,
          messageId: prompts[target]!._id,
          content: "Edited",
        })
        expect(cuts).toMatchObject([
          { threadId: "source", beforeTurnId: `native-${target + 1}` },
        ])
        expect(
          store
            .getMessages(chatId)
            .filter((e) => e.kind === "user_prompt")
            .map((e) => e.content),
        ).toEqual([...prompts.slice(0, target).map((e) => e.content), "Edited"])
        expect(store.requireChat(chatId).sessionToken).toBe("prepared")
      }, count))

test("Codex fork preserves source, attachments and persisted model options", () =>
  fixture(async ({ store, coordinator, chatId, prompts, cuts, entries }) => {
    await store.setChatModelSettings(chatId, {
      model: "gpt-5.4",
      modelOptions: { codex: { fastMode: true } },
    })
    const attachment = {
      id: "a",
      kind: "file",
      displayName: "a.txt",
      absolutePath: "/a.txt",
      relativePath: "a.txt",
      contentUrl: "",
      mimeType: "text/plain",
      size: 1,
    } as const
    entries[3] = { ...prompts[1]!, attachments: [attachment] }
    await store.replaceTranscript(chatId, entries)
    const original = store.getMessages(chatId)
    const result = await coordinator.forkChat({
      type: "chat.fork",
      chatId,
      messageId: prompts[1]!._id,
    })
    expect(cuts).toMatchObject([
      {
        threadId: "source",
        beforeTurnId: "native-2",
        model: "gpt-5.4",
        serviceTier: "fast",
      },
    ])
    expect(store.getMessages(chatId)).toEqual(original)
    expect(store.requireChat(chatId).sessionToken).toBe("source")
    const child = store
      .getMessages(result.chatId)
      .filter((e) => e.kind === "user_prompt")
    expect(child.map((e) => e.content)).toEqual(["Task 1", "Task 2"])
    expect(child[1]!.attachments).toEqual([attachment])
    expect(store.requireChat(result.chatId).pendingForkUserPrompt).toBe(true)
  }))

for (const action of ["edit", "fork"] as const)
  test(`failed Codex preparation for ${action} preserves source and creates no visible fork`, () =>
    fixture(async ({ store, coordinator, chatId, prompts, fail }) => {
      fail.preparation = true
      const original = store.getMessages(chatId)
      const operation =
        action === "edit"
          ? coordinator.editUserPrompt({
              type: "chat.editUserPrompt",
              chatId,
              messageId: prompts[1]!._id,
              content: "Edited",
            })
          : coordinator.forkChat({
              type: "chat.fork",
              chatId,
              messageId: prompts[1]!._id,
            })
      await expect(operation).rejects.toThrow("native preparation failed")
      expect(store.getMessages(chatId)).toEqual(original)
      expect(store.requireChat(chatId).sessionToken).toBe("source")
      expect(
        store.listChatsByProject(store.requireChat(chatId).projectId).length,
      ).toBe(1)
    }))

for (const action of ["edit", "fork"] as const)
  test(`Codex ${action} of an earlier prompt in a pending fork uses the prepared source thread`, () =>
    fixture(
      async ({ store, coordinator, chatId, prompts, cuts }) => {
        const operation =
          action === "edit"
            ? coordinator.editUserPrompt({
                type: "chat.editUserPrompt",
                chatId,
                messageId: prompts[1]!._id,
                content: "Edited",
              })
            : coordinator.forkChat({
                type: "chat.fork",
                chatId,
                messageId: prompts[1]!._id,
              })
        const result = await operation
        expect(cuts).toMatchObject([
          { threadId: "pending-source", beforeTurnId: "native-2" },
        ])
        expect(
          store
            .getMessages(result.chatId)
            .filter((e) => e.kind === "user_prompt")
            .map((e) => e.content),
        ).toEqual(["Task 1", action === "edit" ? "Edited" : "Task 2"])
      },
      3,
      true,
    ))

for (const target of [0, 2])
  test(`Codex pending fork remains intact when editing prompt ${target + 1} fails at startup`, () =>
    fixture(
      async ({ store, coordinator, chatId, prompts, fail }) => {
        fail.startup = true
        const original = store.getMessages(chatId)
        await expect(
          coordinator.editUserPrompt({
            type: "chat.editUserPrompt",
            chatId,
            messageId: prompts[target]!._id,
            content: "Edited",
          }),
        ).rejects.toThrow("provider startup failed")
        expect(store.getMessages(chatId)).toEqual(original)
        expect(store.requireChat(chatId)).toMatchObject({
          sessionToken: null,
          pendingForkSessionToken: "pending-source",
          pendingForkUserPrompt: true,
        })
      },
      3,
      true,
    ))

test("forking an unsent Codex draft keeps the prepared prefix without another rollback", () =>
  fixture(
    async ({ store, coordinator, chatId, prompts, cuts }) => {
      const original = store.getMessages(chatId)
      const result = await coordinator.forkChat({
        type: "chat.fork",
        chatId,
        messageId: prompts[2]!._id,
      })
      expect(cuts).toEqual([])
      expect(store.getMessages(chatId)).toEqual(original)
      expect(
        store
          .getMessages(result.chatId)
          .filter((e) => e.kind === "user_prompt")
          .map((e) => e.content),
      ).toEqual(prompts.map((e) => e.content))
      expect(store.requireChat(result.chatId).pendingForkSessionToken).toBe(
        "pending-source",
      )
    },
    3,
    true,
  ))
