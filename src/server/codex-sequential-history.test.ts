import { expect, test } from "bun:test"
import * as history from "./codex-prompt-history"
import { timestamped } from "./transcript"
import type { TranscriptEntry } from "../shared/types"

const prompt = (content: string, id: string, steered = false) => ({
  ...timestamped({ kind: "user_prompt", content, steered }), _id: id,
}) as Extract<TranscriptEntry, { kind: "user_prompt" }>
const answer = { ...timestamped({ kind: "assistant_text", text: "Answer A" }), _id: "answer-a" }
const entries = [prompt("A", "a"), answer, prompt("B", "b"), prompt("C", "c")]
const inputs = [
  { turnId: "turn-a", userIndex: 0, promptId: "a", text: "A" },
  { turnId: "turn-c", userIndex: 0, promptId: "c", text: "C" },
]
const recover = (...args: Parameters<typeof history.recoverCodexPromptPrefix>) => {
  expect(history.recoverCodexPromptPrefix).toBeDefined()
  return history.recoverCodexPromptPrefix(...args)
}

test("ordered recovery keeps A, identifies B, and never jumps to C", () => {
  const result = recover(entries, "source", inputs)
  expect(Object.keys(result.bindings)).toEqual(["a"])
  expect(result.gap?.messageId).toBe("b")
  expect(result.gap?.error).toContain("native history")
  expect(result.bindings.a).toMatchObject({ turnId: "turn-a", boundaryEntryId: null })
})

test("an ambiguous duplicate stops recovery at B without invalidating A", () => {
  const result = recover(entries, "source", [inputs[0]!,
    { turnId: "b1", userIndex: 0, text: "B" },
    { turnId: "b2", userIndex: 0, text: "B" }, inputs[1]!,
  ])
  expect(Object.keys(result.bindings)).toEqual(["a"])
  expect(result.gap?.messageId).toBe("b")
  expect(result.gap?.error).toContain("ambiguous")
})

test("complete legacy ordered recovery still resolves the whole sequence", () => {
  const result = recover([prompt("Same", "a"), prompt("Same", "b")], "source", [
    { turnId: "a", userIndex: 0, text: "Same" }, { turnId: "b", userIndex: 0, text: "Same" },
  ])
  expect(result.gap).toBeUndefined()
  expect(result.bindings.a?.turnId).toBe("a")
  expect(result.bindings.b?.turnId).toBe("b")
})

test("later local prompt IDs cannot become legacy candidates when recovery stops at a gap", () => {
  const result = recover([prompt("Same", "a"), prompt("Missing", "b"), prompt("Same", "c")], "source", [
    { turnId: "a", userIndex: 0, text: "Same" },
    { turnId: "c", userIndex: 0, promptId: "c", text: "Same" },
  ])
  expect(Object.keys(result.bindings)).toEqual(["a"])
  expect(result.gap?.messageId).toBe("b")
})

test("gap replay retains A's complete local result and cuts after its native turn", () => {
  const result = recover(entries, "source", inputs)
  expect(history.planCodexGapReplay).toBeDefined()
  const plan = history.planCodexGapReplay(entries, "b", "source", result, "Edited B")
  expect(plan.prefix).toEqual([entries[0]!, answer])
  expect(plan.content).toBe("Edited B")
  expect(plan.afterTurnId).toBe("turn-a")
  expect(plan.beforeTurnId).toBeUndefined()
  expect(() => history.planCodexGapReplay(entries, "c", "source", result)).toThrow("first unresolved")
})

test("a first-message gap replays from an empty history", () => {
  const first = [prompt("B", "b")]
  const plan = history.planCodexGapReplay(first, "b", "source", recover(first, "source", []))
  expect(plan.prefix).toEqual([])
  expect(plan.beforeTurnId).toBeUndefined()
  expect(plan.afterTurnId).toBeUndefined()
})

test("a gap after a session boundary cannot silently discard earlier native context", () => {
  const segmented = [prompt("A", "a"), answer,
    timestamped({ kind: "session_restored", provider: "codex" }), prompt("B", "b")]
  expect(() => history.planCodexGapReplay(segmented, "b", "source", {
    bindings: { a: { sessionToken: "source", turnId: "old-a", mergeTurn: false } },
    gap: { messageId: "b", error: "missing" },
  })).toThrow("preceding")
})

test("a steering gap combines the confirmed turn inputs and retains attachments", () => {
  const file = { id: "f", kind: "file", displayName: "f.txt", absolutePath: "/f.txt",
    relativePath: "f.txt", contentUrl: "", mimeType: "text/plain", size: 1 } as const
  const steering = [ { ...prompt("A", "a"), attachments: [file] }, answer, prompt("B", "b", true), prompt("C", "c") ]
  const recovered = recover(steering, "source", inputs)
  const plan = history.planCodexGapReplay(steering, "b", "source", recovered, "Edited B")
  expect(plan.prefix).toEqual([])
  expect(plan.beforeTurnId).toBe("turn-a")
  expect(plan.content).toBe("A\nEdited B")
  expect(plan.attachments).toEqual([file])
  expect(plan.merged).toBe(true)
})
