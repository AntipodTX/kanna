import { describe, test, expect } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  CodexPromptHistory,
  codexUserText,
  reconcileCodexPrompts,
  planCodexPromptHistory,
} from "./codex-prompt-history"
import { timestamped } from "./transcript"
import type { TranscriptEntry } from "../shared/types"
import {
  buildPromptText,
  buildSteeredMessageContent,
  buildConcurrentAgentsNotice,
} from "./agent"
import { LEGACY_KANNA_CHAT_LINK_NOTICE as KANNA_CHAT_LINK_NOTICE } from "./codex-prompt-history"

const prompt = (content: string, id: string) =>
  ({ ...timestamped({ kind: "user_prompt", content }), _id: id }) as Extract<
    TranscriptEntry,
    { kind: "user_prompt" }
  >
const inputs = [
  { turnId: "t1", promptId: "p1", text: "First", userIndex: 0 },
  { turnId: "hidden", text: "Continue after interruption", userIndex: 0 },
  { turnId: "t2", promptId: "p2", text: "Catalogue", userIndex: 0 },
  { turnId: "t2", promptId: "p3", text: "Search", userIndex: 1 },
  { turnId: "t3", promptId: "p4", text: "Later", userIndex: 0 },
]

describe("exact Codex prompt history", () => {
  test("combines stored steering text without its generated service wrapper", () => {
    const entries = [
      prompt("Catalogue", "start"),
      {
        ...prompt(buildSteeredMessageContent("Search"), "target"),
        steered: true,
      },
    ]
    const inputs = [
      { turnId: "turn", userIndex: 0, text: "Catalogue", promptId: "start" },
      {
        turnId: "turn",
        userIndex: 1,
        text:
          buildSteeredMessageContent("Search") + "\n" + KANNA_CHAT_LINK_NOTICE,
        promptId: "target",
      },
    ]
    const bindings = reconcileCodexPrompts(entries, "source", inputs)
    expect(planCodexPromptHistory(entries, "target", bindings).content).toBe(
      "Catalogue\nSearch",
    )
    expect(
      planCodexPromptHistory(
        entries,
        "target",
        bindings,
        buildSteeredMessageContent("Find"),
      ).content,
    ).toBe("Catalogue\nFind")
    expect(
      reconcileCodexPrompts(
        entries,
        "source",
        inputs.map(({ promptId, ...input }) => input),
      ).target?.mergeTurn,
    ).toBe(true)
  })
  test("recovers legacy prompts with attachments and exact generated wire notices", () => {
    const attachment = {
      id: "a",
      kind: "file",
      displayName: 'a&"b.txt',
      absolutePath: '/a&"b.txt',
      relativePath: 'a&"b.txt',
      contentUrl: "",
      mimeType: "text/plain",
      size: 1,
    } as const
    const entry = { ...prompt("Find", "local"), attachments: [attachment] }
    const notice = buildConcurrentAgentsNotice([
      { title: "Other", transcriptPath: "/data/transcripts/other.jsonl" },
    ])
    const text = buildPromptText(
      buildSteeredMessageContent("Find") +
        "\n\n" +
        KANNA_CHAT_LINK_NOTICE +
        "\n\n" +
        notice,
      [attachment],
    )
    const bindings = reconcileCodexPrompts([entry], "source", [
      { turnId: "turn", userIndex: 0, text },
    ])
    expect(bindings.local.turnId).toBe("turn")
  })
  test("recovers uniquely ordered imported prompts with foreign client ids", () => {
    expect(
      reconcileCodexPrompts([prompt("Imported", "local-imported")], "source", [
        {
          turnId: "native",
          promptId: "original-client-id",
          text: "Imported",
          userIndex: 0,
        },
      ])["local-imported"].turnId,
    ).toBe("native")
  })
  test("preserves custom requirements inside user-authored system messages", () => {
    const text =
      "<system-message>\nThe user would like to inform you of something while you continue to work.\nUse blue buttons.\n</system-message>"
    expect(codexUserText(text)).toBe(text)
    const entries = [prompt(text, "p1"), prompt("Search", "p2")]
    const bindings = reconcileCodexPrompts(entries, "source", [
      { turnId: "turn", promptId: "p1", text, userIndex: 0 },
      { turnId: "turn", promptId: "p2", text: "Search", userIndex: 1 },
    ])
    expect(planCodexPromptHistory(entries, "p2", bindings).content).toBe(
      `${text}\nSearch`,
    )
  })
  test("binds hidden native continuations without shifting visible boundaries", () => {
    const entries = [
      prompt("First", "p1"),
      prompt("Catalogue", "p2"),
      prompt("Search", "p3"),
      prompt("Later", "p4"),
    ]
    const bindings = reconcileCodexPrompts(entries, "source", inputs)
    expect(bindings.p2.turnId).toBe("t2")
    expect(bindings.p3.mergeTurn).toBe(true)
    const plan = planCodexPromptHistory(entries, "p3", bindings, "Find by name")
    expect(plan.beforeTurnId).toBe("t2")
    expect(plan.content).toBe("Catalogue\nFind by name")
    expect(plan.prefix.map((e) => e._id)).toEqual(["p1"])
    expect(entries.map((e) => e._id)).toEqual(["p1", "p2", "p3", "p4"])
  })
  test("preserves prior completed context and all included attachments", () => {
    const attachment = {
      id: "a",
      kind: "file",
      displayName: "a.txt",
      absolutePath: "/p/a.txt",
      relativePath: "a.txt",
      contentUrl: "",
      mimeType: "text/plain",
      size: 1,
    } as const
    const entries: TranscriptEntry[] = [
      prompt("First", "p1"),
      timestamped({ kind: "assistant_text", text: "answer" }),
      prompt("Catalogue", "p2"),
      timestamped({ kind: "assistant_text", text: "old progress" }),
      { ...prompt("Search", "p3"), attachments: [attachment] },
      prompt("Later", "p4"),
    ]
    entries[2] = {
      ...entries[2],
      attachments: [{ ...attachment, id: "b" }],
    } as TranscriptEntry
    const bindings = reconcileCodexPrompts(entries, "source", inputs)
    const plan = planCodexPromptHistory(entries, "p3", bindings)
    expect(plan.prefix).toEqual(entries.slice(0, 2))
    expect(plan.content).toBe("Catalogue\nSearch")
    expect(plan.attachments.map((a) => a.id)).toEqual(["b", "a"])
  })
  test("distinguishes identical prompts with durable client ids", () => {
    const entries = [prompt("Continue", "p1"), prompt("Continue", "p2")]
    const bindings = reconcileCodexPrompts(entries, "source", [
      { turnId: "hidden", text: "Continue", userIndex: 0 },
      { turnId: "first", promptId: "p1", text: "Continue", userIndex: 0 },
      { turnId: "second", promptId: "p2", text: "Continue", userIndex: 0 },
    ])
    expect(bindings.p2.turnId).toBe("second")
  })
  test("recovers a complete old ordered history, rejecting multiple valid alignments", () => {
    const entries = [prompt("First", "p1"), prompt("Search", "p2")]
    expect(
      reconcileCodexPrompts(entries, "source", [
        { turnId: "one", text: "First", userIndex: 0 },
        {
          turnId: "service",
          text: "Continue after interruption",
          userIndex: 0,
        },
        { turnId: "two", text: "Search", userIndex: 0 },
      ]).p2.turnId,
    ).toBe("two")
    expect(() =>
      reconcileCodexPrompts([prompt("Continue", "p1")], "source", [
        { turnId: "one", text: "Continue", userIndex: 0 },
        { turnId: "two", text: "Continue", userIndex: 0 },
      ]),
    ).toThrow("ambiguous")
  })
  test("remembers a hidden turn's exact local start through restart", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "kanna-prompt-history-"))
    try {
      const history = new CodexPromptHistory(root)
      await history.recordTurn("chat", "source", "hidden", "before")
      await history.recordPrompt("chat", "steer", {
        sessionToken: "source",
        turnId: "hidden",
        mergeTurn: true,
        boundaryEntryId: "before",
      })
      const reopened = new CodexPromptHistory(root)
      const records = await reopened.read("chat")
      const entries = [
        prompt("Earlier", "p1"),
        {
          ...timestamped({ kind: "assistant_text", text: "prior result" }),
          _id: "before",
        },
        timestamped({ kind: "assistant_text", text: "hidden turn progress" }),
        prompt("Search", "steer"),
      ]
      const plan = planCodexPromptHistory(entries, "steer", records.prompts)
      expect(plan.prefix).toEqual(entries.slice(0, 2))
      expect(plan.content).toBe("Search")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
  test("recovers an old hidden continuation from its local Codex start marker", () => {
    const before = {
      ...timestamped({
        kind: "result",
        subtype: "success",
        isError: false,
        durationMs: 0,
        result: "done",
      }),
      _id: "before",
    }
    const entries: TranscriptEntry[] = [
      prompt("Earlier", "p1"),
      before,
      timestamped({
        kind: "system_init",
        provider: "codex",
        model: "gpt",
        tools: [],
        agents: [],
        slashCommands: [],
        mcpServers: [],
      }),
      timestamped({ kind: "assistant_text", text: "hidden progress" }),
      prompt("Search", "p2"),
    ]
    const bindings = reconcileCodexPrompts(entries, "source", [
      { turnId: "earlier", promptId: "p1", text: "Earlier", userIndex: 0 },
      { turnId: "hidden", text: "Resume after restart", userIndex: 0 },
      { turnId: "hidden", promptId: "p2", text: "Search", userIndex: 1 },
    ])
    expect(planCodexPromptHistory(entries, "p2", bindings).prefix).toEqual(
      entries.slice(0, 2),
    )
  })
})
