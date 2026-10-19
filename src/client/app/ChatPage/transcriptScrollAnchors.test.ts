import { describe, expect, test } from "bun:test"
import type { ResolvedTranscriptRow } from "../KannaTranscript"
import {
  buildRowIndexByMessageId,
  findLatestUserPromptRowIndex,
  getLatestUserPrompt,
  getRowAnchorMessageId,
  isOptimisticMessageId,
  resolveJumpTarget,
  resolveRestoreTarget,
  shouldPinForNewPrompt,
} from "./transcriptScrollAnchors"

function promptRow(id: string, content: string): ResolvedTranscriptRow {
  return {
    kind: "single",
    id,
    index: 0,
    isLoading: false,
    isFirstSystem: false,
    isModelChange: false,
    isFirstAccount: false,
    isLatestAskUserQuestion: false,
    isLatestExitPlanMode: false,
    isLatestTodoWrite: false,
    hideResult: false,
    isFinalStatus: false,
    message: {
      id,
      timestamp: new Date(0).toISOString(),
      kind: "user_prompt",
      content,
      attachments: [],
    },
  } as unknown as ResolvedTranscriptRow
}

function textRow(id: string, text: string): ResolvedTranscriptRow {
  return {
    kind: "single",
    id,
    index: 0,
    isLoading: false,
    isFirstSystem: false,
    isModelChange: false,
    isFirstAccount: false,
    isLatestAskUserQuestion: false,
    isLatestExitPlanMode: false,
    isLatestTodoWrite: false,
    hideResult: false,
    isFinalStatus: false,
    message: {
      id,
      timestamp: new Date(0).toISOString(),
      kind: "assistant_text",
      text,
    },
  } as unknown as ResolvedTranscriptRow
}

function toolGroupRow(memberIds: string[]): ResolvedTranscriptRow {
  return {
    kind: "tool-group",
    id: `tool-group:${memberIds[0]}`,
    startIndex: 0,
    isLoading: false,
    messages: memberIds.map((id) => ({
      id,
      timestamp: new Date(0).toISOString(),
      kind: "tool",
      toolName: "Bash",
    })),
  } as unknown as ResolvedTranscriptRow
}

describe("isOptimisticMessageId", () => {
  test("recognises the optimistic prefix", () => {
    expect(isOptimisticMessageId("optimistic:abc")).toBe(true)
    expect(isOptimisticMessageId("abc")).toBe(false)
  })
})

describe("resolveJumpTarget", () => {
  const rows = [promptRow("m1", "hi"), toolGroupRow(["t1", "t2"]), textRow("a1", "done")]

  test("resolves each role against the transcript, not against an id it was handed", () => {
    // The sidebar names a role because it only has preview strings; the rows
    // are the only thing that knows which message is which.
    expect(resolveJumpTarget(rows, "prompt")).toEqual({ kind: "pin", rowId: rows[0]!.id })
    expect(resolveJumpTarget(rows, "reply")).toEqual({ kind: "pin", rowId: rows[2]!.id })
  })

  test("takes the latest of each, not the first", () => {
    const longer = [
      promptRow("m1", "hi"),
      textRow("a1", "first answer"),
      promptRow("m2", "again"),
      textRow("a2", "second answer"),
    ]

    expect(resolveJumpTarget(longer, "prompt")).toEqual({ kind: "pin", rowId: longer[2]!.id })
    expect(resolveJumpTarget(longer, "reply")).toEqual({ kind: "pin", rowId: longer[3]!.id })
  })

  test("gives up when the transcript has no such message", () => {
    // The caller falls back to the stored read position rather than guessing.
    expect(resolveJumpTarget([promptRow("m1", "hi")], "reply")).toBeNull()
    expect(resolveJumpTarget([], "prompt")).toBeNull()
  })

  test("a tool call lands on the tool group it was swept into", () => {
    const withIds = [promptRow("m1", "hi"), {
      ...toolGroupRow(["t1", "t2"]),
      messages: [
        { id: "t1", timestamp: new Date(0).toISOString(), kind: "tool", toolName: "Bash", toolId: "call-1" },
        { id: "t2", timestamp: new Date(0).toISOString(), kind: "tool", toolName: "Agent", toolId: "call-2" },
      ],
    } as unknown as ResolvedTranscriptRow]
    expect(resolveJumpTarget(withIds, { toolId: "call-2" })).toEqual({ kind: "pin", rowId: withIds[1]!.id })
    expect(resolveJumpTarget(withIds, { toolId: "missing" })).toBeNull()
  })

  test("a named transcript entry lands on its row, including inside a tool group", () => {
    expect(resolveJumpTarget(rows, { entryId: "m1" })).toEqual({ kind: "pin", rowId: rows[0]!.id })
    expect(resolveJumpTarget(rows, { entryId: "t2" })).toEqual({ kind: "pin", rowId: rows[1]!.id })
    expect(resolveJumpTarget(rows, { entryId: "missing" })).toBeNull()
  })
})

describe("getRowAnchorMessageId", () => {
  test("uses the message id for a single row", () => {
    expect(getRowAnchorMessageId(promptRow("m1", "hi"))).toBe("m1")
  })

  test("uses the first member for a tool group", () => {
    expect(getRowAnchorMessageId(toolGroupRow(["t1", "t2", "t3"]))).toBe("t1")
  })
})

describe("buildRowIndexByMessageId", () => {
  test("maps every tool-group member to the group row", () => {
    const rows = [promptRow("m1", "hi"), toolGroupRow(["t1", "t2", "t3"]), textRow("m2", "done")]
    const map = buildRowIndexByMessageId(rows)

    expect(map.get("m1")).toBe(0)
    expect(map.get("t1")).toBe(1)
    expect(map.get("t2")).toBe(1)
    expect(map.get("t3")).toBe(1)
    expect(map.get("m2")).toBe(2)
  })

  test("returns an empty map for no rows", () => {
    expect(buildRowIndexByMessageId([]).size).toBe(0)
  })
})

describe("findLatestUserPromptRowIndex", () => {
  test("finds the last prompt, ignoring later assistant rows", () => {
    const rows = [promptRow("m1", "first"), textRow("a1", "reply"), promptRow("m2", "second"), textRow("a2", "reply")]
    expect(findLatestUserPromptRowIndex(rows)).toBe(2)
  })

  test("returns null when there are no prompts", () => {
    expect(findLatestUserPromptRowIndex([textRow("a1", "reply")])).toBeNull()
    expect(findLatestUserPromptRowIndex([])).toBeNull()
  })
})

describe("shouldPinForNewPrompt", () => {
  const rowsWithPrompt = (id: string, content: string) => [textRow("a0", "x"), promptRow(id, content)]

  test("does not pin while streaming (latest prompt unchanged)", () => {
    const previous = getLatestUserPrompt(rowsWithPrompt("m1", "hello"))
    const next = getLatestUserPrompt([...rowsWithPrompt("m1", "hello"), textRow("a1", "streaming...")])
    expect(shouldPinForNewPrompt(previous, next)).toBe(false)
  })

  test("does not pin when an optimistic prompt is reconciled to its server id", () => {
    const previous = getLatestUserPrompt(rowsWithPrompt("optimistic:uuid", "hello"))
    const next = getLatestUserPrompt(rowsWithPrompt("server-id", "hello"))
    expect(shouldPinForNewPrompt(previous, next)).toBe(false)
  })

  test("pins when the same text is sent a second time", () => {
    const previous = getLatestUserPrompt(rowsWithPrompt("server-id", "continue"))
    const next = getLatestUserPrompt([
      ...rowsWithPrompt("server-id", "continue"),
      promptRow("optimistic:uuid", "continue"),
    ])
    expect(shouldPinForNewPrompt(previous, next)).toBe(true)
  })

  test("pins for a genuinely new prompt", () => {
    const previous = getLatestUserPrompt(rowsWithPrompt("m1", "hello"))
    const next = getLatestUserPrompt([...rowsWithPrompt("m1", "hello"), promptRow("m2", "goodbye")])
    expect(shouldPinForNewPrompt(previous, next)).toBe(true)
  })

  test("does not pin when older history is prepended", () => {
    const current = rowsWithPrompt("m2", "latest")
    const previous = getLatestUserPrompt(current)
    const next = getLatestUserPrompt([promptRow("old1", "ancient"), promptRow("old2", "older"), ...current])
    expect(shouldPinForNewPrompt(previous, next)).toBe(false)
  })

  test("does not pin on the first observation (chat open owns that)", () => {
    expect(shouldPinForNewPrompt(null, getLatestUserPrompt(rowsWithPrompt("m1", "hi")))).toBe(false)
  })

  test("does not pin when there is no prompt at all", () => {
    expect(shouldPinForNewPrompt(getLatestUserPrompt(rowsWithPrompt("m1", "hi")), null)).toBe(false)
  })
})

describe("resolveRestoreTarget", () => {
  const rows = [promptRow("m1", "first"), textRow("a1", "reply"), promptRow("m2", "second"), textRow("a2", "reply")]
  const map = buildRowIndexByMessageId(rows)

  test("follows the stream for an atEnd anchor", () => {
    expect(resolveRestoreTarget(rows, { messageId: "m1", atEnd: true }, map))
      .toEqual({ kind: "end" })
  })

  test("pins the row holding a message anchor", () => {
    expect(resolveRestoreTarget(rows, { messageId: "a1", atEnd: false }, map))
      .toEqual({ kind: "pin", rowId: rows[1]!.id })
  })

  test("resolves an anchor inside a collapsed tool group to the group row", () => {
    const groupRows = [promptRow("m1", "hi"), toolGroupRow(["t1", "t2"]), textRow("a1", "done")]
    const groupMap = buildRowIndexByMessageId(groupRows)
    expect(resolveRestoreTarget(groupRows, { messageId: "t2", atEnd: false }, groupMap))
      .toEqual({ kind: "pin", rowId: groupRows[1]!.id })
  })

  test("falls back to the latest prompt when the anchored message is gone", () => {
    expect(resolveRestoreTarget(rows, { messageId: "gone", atEnd: false }, map))
      .toEqual({ kind: "pin", rowId: rows[2]!.id })
  })

  test("falls back to the latest prompt when there is no anchor", () => {
    expect(resolveRestoreTarget(rows, null, map)).toEqual({ kind: "pin", rowId: rows[2]!.id })
  })

  test("falls back to the end when there is no prompt to pin", () => {
    const noPrompts = [textRow("a1", "reply")]
    expect(resolveRestoreTarget(noPrompts, null, buildRowIndexByMessageId(noPrompts)))
      .toEqual({ kind: "end" })
  })

  test("returns the end for an empty transcript", () => {
    expect(resolveRestoreTarget([], null, new Map())).toEqual({ kind: "end" })
  })
})

describe("resolveRestoreTarget with a recorded layout", () => {
  const rows = [promptRow("m1", "first"), textRow("a1", "a long answer"), promptRow("m2", "second")]
  const map = buildRowIndexByMessageId(rows)
  const anchor = { messageId: "a1", atEnd: false, transcriptWidth: 800, offsetFromMessage: 1224 }

  test("restores the exact position within the message at the same width", () => {
    expect(resolveRestoreTarget(rows, anchor, map, 800))
      .toEqual({ kind: "pin", rowId: rows[1]!.id, offsetFromMessage: 1224 })
  })

  test("drops the offset at a different width, since the message rewraps", () => {
    // A narrower column makes the message a different shape, so a distance into
    // it means nothing — putting its top back at the top is the honest answer.
    expect(resolveRestoreTarget(rows, anchor, map, 640))
      .toEqual({ kind: "pin", rowId: rows[1]!.id })
  })

  test("drops the offset when the current width is unknown", () => {
    expect(resolveRestoreTarget(rows, anchor, map, undefined))
      .toEqual({ kind: "pin", rowId: rows[1]!.id })
  })

  test("pins without an offset for anchors recorded before layout was stored", () => {
    expect(resolveRestoreTarget(rows, { messageId: "a1", atEnd: false }, map, 800))
      .toEqual({ kind: "pin", rowId: rows[1]!.id })
  })

  test("still follows the stream for an atEnd anchor regardless of layout", () => {
    expect(resolveRestoreTarget(rows, { ...anchor, atEnd: true }, map, 800))
      .toEqual({ kind: "end" })
  })

  test("falls back to the latest prompt when the anchored message is gone, offset and all", () => {
    expect(resolveRestoreTarget(rows, { ...anchor, messageId: "gone" }, map, 800))
      .toEqual({ kind: "pin", rowId: rows[2]!.id })
  })
})
