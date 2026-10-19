import { expect, test } from "bun:test"
import * as history from "./codex-prompt-history"
import { timestamped } from "./transcript"

const prompt = (id: string, content = id) => ({ ...timestamped({ kind: "user_prompt", content }), _id: id })
const native = (promptId: string, text = promptId) => ({ promptId, text, turnId: `turn-${promptId}`, userIndex: 0 })
const classify = (...args: any[]) => (history as any).classifyCodexPromptHistory(...args)

test("all absent messages are classified after the confirmed prefix", () => {
  const result = classify([prompt("P"), prompt("A"), prompt("B"), prompt("C")], "source", [native("P")])
  expect(Object.keys(result.bindings)).toEqual(["P"])
  expect(result.messages).toEqual({ A: "missing", B: "missing", C: "missing" })
  expect(result.gap.messageId).toBe("A")
})

test("one legacy input cannot identify two identical local prompts", () => {
  const result = classify([prompt("a", "Continue"), prompt("b", "Continue")], "source", [
    { turnId: "turn", text: "Continue", userIndex: 0 },
  ])
  expect(result.bindings).toEqual({})
  expect(result.messages).toEqual({ a: "unknown", b: "unknown" })
  expect(result.gap.messageId).toBe("a")
})

test("complete repeated-text sequence is safe when order identifies both inputs", () => {
  const result = classify([prompt("a", "Continue"), prompt("b", "Continue")], "source", [
    { turnId: "one", text: "Continue", userIndex: 0 }, { turnId: "two", text: "Continue", userIndex: 0 },
  ])
  expect(Object.keys(result.bindings)).toEqual(["a", "b"])
  expect(result.messages).toEqual({})
  expect(result.gap).toBeUndefined()
})

test("a confirmed native identity remains usable after a proven absent message", () => {
  const result = classify([prompt("a"), prompt("b"), prompt("c")], "source", [native("a"), native("c")])
  expect(Object.keys(result.bindings)).toEqual(["a", "c"])
  expect(result.messages).toEqual({ b: "missing" })
  expect(result.gap.messageId).toBe("b")
  expect(result.bindings.c.boundaryEntryId).toBe("b")
})

test("a missing prompt remains a barrier to borrowing an older hidden turn start", () => {
  const entries = [prompt("a"), { ...timestamped({ kind: "system_init", provider: "codex", model: "test" }), _id: "init-a" },
    { ...timestamped({ kind: "assistant_text", text: "Answer A" }), _id: "answer-a" }, prompt("b"),
    { ...prompt("c"), steered: true }]
  const result = classify(entries, "source", [native("a"),
    { promptId: "hidden", text: "Hidden start", turnId: "turn-x", userIndex: 0 },
    { promptId: "c", text: "c", turnId: "turn-x", userIndex: 1 }])
  expect(result.bindings.c).toBeUndefined()
  expect(result.messages).toEqual({ b: "missing", c: "unknown" })
})

test("native IDs prevent identical text from being stolen by another message", () => {
  const result = classify([prompt("a", "Continue"), prompt("b", "Continue")], "source", [native("b", "Continue")])
  expect(Object.keys(result.bindings)).toEqual(["b"])
  expect(result.messages).toEqual({ a: "missing" })
  expect(result.gap.messageId).toBe("a")
})

test("invalid native snapshot is not evidence of absence", () => {
  expect(() => classify([prompt("a")], "source", [native("a"), native("a")])).toThrow("Invalid Codex")
})

test("a saved unique legacy turn preserves the confirmed prefix despite a later duplicate", () => {
  const result = classify([prompt("a", "Continue"), prompt("b", "Continue")], "source", [
    { turnId: "one", text: "Continue", userIndex: 0 },
  ], { a: { sessionToken: "source", turnId: "one", mergeTurn: false, boundaryEntryId: null } })
  expect(Object.keys(result.bindings)).toEqual(["a"])
  expect(result.messages).toEqual({ b: "missing" })
})

test("an obsolete saved turn ID does not prove that uniquely matched text is absent", () => {
  const result = classify([prompt("a", "A")], "source", [{ turnId: "new-turn", text: "A", userIndex: 0 }],
    { a: { sessionToken: "source", turnId: "obsolete", mergeTurn: false, boundaryEntryId: null } })
  expect(result.bindings.a?.turnId).toBe("new-turn")
  expect(result.messages).toEqual({})
})
