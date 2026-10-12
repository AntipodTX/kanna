import { describe, expect, test } from "bun:test"
import type { TranscriptEntry } from "./types"
import {
  buildTranscriptOutline,
  findTranscriptWindowStart,
  snapToRowStart,
  trimTranscriptWindow,
} from "./transcript-window"

let counter = 0
function entry(kind: string, extra: Record<string, unknown> = {}): TranscriptEntry {
  counter += 1
  return { _id: `e${counter}`, createdAt: counter, kind, ...extra } as unknown as TranscriptEntry
}
const prompt = (content = "hi") => entry("user_prompt", { content })
const text = (t = "answer") => entry("assistant_text", { text: t })
const call = () => entry("tool_call", { tool: { kind: "tool", toolKind: "bash", toolName: "Bash", toolId: "t", input: {} } })
const result = () => entry("tool_result", { toolId: "t", content: "out" })

/** prompt, text, call, result, call, result, text  (one turn, 7 entries) */
function turn() {
  return [prompt(), text(), call(), result(), call(), result(), text()]
}

describe("findTranscriptWindowStart", () => {
  test("counts assistant messages back from the end and snaps to the row start", () => {
    const entries = [...turn(), ...turn(), ...turn()] // 21 entries, 6 assistant texts
    // Two assistant messages back from the end: the last turn's two texts.
    // The cut lands on the last turn's first text (index 15), then snaps
    // back over the prompt before it (index 14).
    expect(findTranscriptWindowStart(entries, { endExclusive: entries.length, assistantMessages: 2 })).toBe(14)
    // Three reaches into the middle turn's last text (index 13), which
    // follows a tool result, so it stays there.
    expect(findTranscriptWindowStart(entries, { endExclusive: entries.length, assistantMessages: 3 })).toBe(13)
  })

  test("returns 0 when the transcript has fewer assistant messages than asked", () => {
    const entries = turn()
    expect(findTranscriptWindowStart(entries, { endExclusive: entries.length, assistantMessages: 50 })).toBe(0)
  })

  test("widens to include a required index, snapping into a whole row", () => {
    const entries = [...turn(), ...turn()]
    // Index 3 is a tool result mid-group in the first turn; the window
    // must start at that group's first call (index 2).
    expect(findTranscriptWindowStart(entries, { endExclusive: entries.length, assistantMessages: 1, mustIncludeIndex: 3 })).toBe(2)
  })

  test("the byte cap cuts early, but only at an assistant message", () => {
    const entries = [...turn(), ...turn(), ...turn()]
    const start = findTranscriptWindowStart(entries, {
      endExclusive: entries.length,
      assistantMessages: 50,
      byteCap: 3,
      measure: () => 1,
    })
    // After three entries the cap trips; the last counted assistant text is
    // the final one (index 20), and the cut snaps no further back since a
    // tool result precedes it.
    expect(start).toBe(20)
  })

  test("a window before an existing one counts from that one's start", () => {
    const entries = [...turn(), ...turn()]
    const first = findTranscriptWindowStart(entries, { endExclusive: entries.length, assistantMessages: 2 })
    expect(first).toBe(7)
    expect(findTranscriptWindowStart(entries, { endExclusive: first, assistantMessages: 2 })).toBe(0)
  })
})

describe("snapToRowStart", () => {
  test("moves back over a tool run and a preceding prompt, and no further", () => {
    const entries = [text(), prompt(), text(), call(), result(), call(), result()]
    expect(snapToRowStart(entries, 6)).toBe(3)
    expect(snapToRowStart(entries, 2)).toBe(1)
    expect(snapToRowStart(entries, 1)).toBe(1)
    expect(snapToRowStart(entries, 0)).toBe(0)
    expect(snapToRowStart(entries, 99)).toBe(7)
  })

  test("never opens a window on a subagent's entries without their Agent row", () => {
    const agent = () => entry("tool_call", { tool: { kind: "tool", toolKind: "subagent_task", toolName: "Agent", toolId: "a", input: {} } })
    const child = (kind: string) => entry(kind, { parentToolUseId: "a", text: "", toolId: "t", content: "" })
    // text, agent, [child text, child call, child result, child text], text
    const entries = [text(), agent(), child("assistant_text"), child("tool_call"), child("tool_result"), child("assistant_text"), text()]
    expect(snapToRowStart(entries, 5)).toBe(1)
    expect(snapToRowStart(entries, 2)).toBe(1)
    expect(snapToRowStart(entries, 6)).toBe(6)
  })
})

describe("subagent entries in the window count", () => {
  test("a subagent's text does not count as an assistant message", () => {
    const agent = entry("tool_call", { tool: { kind: "tool", toolKind: "subagent_task", toolName: "Agent", toolId: "a", input: {} } })
    const childText = entry("assistant_text", { text: "findings", parentToolUseId: "a" })
    const entries = [prompt(), text(), agent, childText, childText, text()]
    // Two assistant messages back: both main-thread texts, so the window
    // reaches the first one (index 1) and snaps over the prompt to 0.
    expect(findTranscriptWindowStart(entries, { endExclusive: entries.length, assistantMessages: 2 })).toBe(0)
    // One: the last main-thread text alone (index 5); the subagent texts
    // before it are not rows and do not stop the walk early.
    expect(findTranscriptWindowStart(entries, { endExclusive: entries.length, assistantMessages: 1 })).toBe(5)
  })
})

describe("buildTranscriptOutline", () => {
  test("removes hidden instructions before shortening the unloaded prompt preview", () => {
    const source = prompt(`<system-message>${"hidden ".repeat(100)}</system-message>\n**Visible** request`)
    const outline = buildTranscriptOutline([source])
    expect(outline).toEqual([{ id: source._id, index: 0, preview: "Visible request", createdAt: source.createdAt }])
    expect(source.kind === "user_prompt" && source.content).toContain("<system-message>")
  })

  test("decodes all native answers before flattening an unloaded preview", () => {
    const content = '<send_user_message_question_reply>[{"questionItemId":"q1","question":"Which version?","answer":"Version B"},{"questionItemId":"q2","question":"Import sessions?","answer":"Yes"}]</send_user_message_question_reply>'
    const outline = buildTranscriptOutline([prompt(content)])
    expect(outline[0]?.preview).toBe("Which version? Version B Import sessions? Yes")
  })

  test("lists visible user prompts with their absolute index and a preview", () => {
    const hidden = prompt("secret")
    ;(hidden as { hidden?: boolean }).hidden = true
    const entries = [prompt("**first** question"), text(), hidden, prompt("x".repeat(400))]
    const outline = buildTranscriptOutline(entries)
    expect(outline).toHaveLength(2)
    expect(outline[0]).toMatchObject({ id: entries[0]!._id, index: 0, preview: "first question" })
    expect(outline[1]!.index).toBe(3)
    expect(outline[1]!.preview.length).toBe(161)
    expect(outline[1]!.preview.endsWith("…")).toBe(true)
  })
})

describe("trimTranscriptWindow", () => {
  test("cuts a held window to the size a fresh open would get, keeping absolute indexes", () => {
    const entries = [...turn(), ...turn()]
    const trimmed = trimTranscriptWindow({ messages: entries, startIndex: 100 }, 2)
    expect(trimmed.startIndex).toBe(107)
    expect(trimmed.messages).toHaveLength(7)
    expect(trimmed.messages[0]!.kind).toBe("user_prompt")
    // Already small enough: the same object comes back.
    const small = { messages: turn(), startIndex: 0 }
    expect(trimTranscriptWindow(small, 50)).toBe(small)
  })
})
