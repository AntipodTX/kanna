import { describe, expect, test } from "bun:test"
import type { ResolvedTranscriptRow } from "../KannaTranscript"
import {
  buildTranscriptTurns,
  getMagnifyFalloff,
  getMinimapCapacity,
  getTranscriptGutterWidth,
  isTurnInView,
  selectVisibleTurns,
  type TranscriptTurn,
} from "./transcriptTurns"

const TIMESTAMP = "2026-07-26T00:00:00.000Z"

function singleRow(id: string, message: Record<string, unknown>): ResolvedTranscriptRow {
  return {
    kind: "single",
    id,
    index: 0,
    isLoading: false,
    message: { id, timestamp: TIMESTAMP, ...message },
  } as unknown as ResolvedTranscriptRow
}

function toolGroupRow(id: string, memberCount = 1): ResolvedTranscriptRow {
  return {
    kind: "tool-group",
    id: `tool-group:${id}`,
    startIndex: 0,
    isLoading: false,
    messages: Array.from({ length: memberCount }, (_, index) => (
      { id: `${id}-${index}`, kind: "tool", timestamp: TIMESTAMP }
    )),
  } as unknown as ResolvedTranscriptRow
}

const tool = (id: string) => singleRow(id, { kind: "tool" })

const prompt = (id: string, content: string) => singleRow(id, { kind: "user_prompt", content })
const assistant = (id: string, text: string) => singleRow(id, { kind: "assistant_text", text })
const okResult = (id: string) => singleRow(id, { kind: "result", success: true, result: "" })
const errorResult = (id: string, result: string) =>
  singleRow(id, { kind: "result", success: false, result })
const cancelledResult = (id: string) =>
  singleRow(id, { kind: "result", success: false, cancelled: true, result: "" })

describe("buildTranscriptTurns", () => {
  test("uses the visible user body without the hidden steering prefix", () => {
    const rows = [prompt("p1", "<system-message>Internal steering instructions</system-message>\nVisible request"), assistant("a1", "done")]
    expect(buildTranscriptTurns(rows)[0]).toMatchObject({
      id: "p1", rowIndex: 0, endRowIndex: 1, prompt: "Visible request", replyRowId: "a1",
    })
    expect(rows[0]?.kind === "single" && rows[0].message.kind === "user_prompt" && rows[0].message.content)
      .toContain("Internal steering instructions")
  })

  test("previews a native question reply as the question and answer shown in chat", () => {
    const content = '<system-message>Hidden instructions</system-message>\n<send_user_message_question_reply>{"questionItemId":"q1","question":"Which version?","answer":"Version B"}</send_user_message_question_reply>'
    expect(buildTranscriptTurns([prompt("reply", content)])[0]).toMatchObject({
      id: "reply", rowIndex: 0, prompt: "> Which version?\n\nVersion B",
    })
  })

  test("keeps literal tags and malformed reply text that the chat does not interpret", () => {
    const literal = "Explain <system-message>examples</system-message> and <send_user_message_question_reply> tags"
    const malformed = "<send_user_message_question_reply>{broken}</send_user_message_question_reply>"
    expect(buildTranscriptTurns([prompt("literal", literal), prompt("malformed", malformed)]).map(turn => turn.prompt))
      .toEqual([literal, malformed])
  })

  test("opens a turn per user prompt and closes it at the next one", () => {
    const turns = buildTranscriptTurns([
      prompt("p1", "first question"),
      assistant("a1", "first answer"),
      toolGroupRow("t1"),
      prompt("p2", "second question"),
      assistant("a2", "second answer"),
    ])

    expect(turns).toEqual([
      { id: "p1", rowIndex: 0, endRowIndex: 2, replyRowId: "a1", prompt: "first question", response: "first answer", agentMessageCount: 2, error: null, timestamp: TIMESTAMP, durationMs: null },
      { id: "p2", rowIndex: 3, endRowIndex: 4, replyRowId: "a2", prompt: "second question", response: "second answer", agentMessageCount: 1, error: null, timestamp: TIMESTAMP, durationMs: null },
    ])
  })

  // The jump pins its target to the top of the viewport, so the reply target
  // has to be the message the preview came from — anything later would push
  // that text off the top of the screen.
  test("points the reply at the message the response was taken from", () => {
    const turns = buildTranscriptTurns([
      prompt("p1", "q"),
      assistant("a1", "thinking out loud"),
      assistant("a2", "final word"),
      toolGroupRow("t1"),
      okResult("r1"),
    ])

    expect(turns[0]).toMatchObject({ response: "final word", replyRowId: "a2" })
  })

  test("a turn with nothing back yet has no reply to aim at", () => {
    const turns = buildTranscriptTurns([prompt("p1", "q"), toolGroupRow("t1")])

    expect(turns[0]?.replyRowId).toBeNull()
  })

  test("an error takes the reply target with it, onto the result row", () => {
    // The card shows the failure in the reply's slot, so the click follows it.
    const turns = buildTranscriptTurns([
      prompt("p1", "q"),
      assistant("a1", "starting on it"),
      errorResult("r1", "provider crashed"),
    ])

    expect(turns[0]).toMatchObject({ error: "provider crashed", replyRowId: "r1" })
  })

  test("a cancelled turn keeps aiming at the text it managed to produce", () => {
    const turns = buildTranscriptTurns([
      prompt("p1", "q"),
      assistant("a1", "partial work"),
      cancelledResult("r1"),
    ])

    expect(turns[0]?.replyRowId).toBe("a1")
  })

  test("keeps the turn's last assistant message, not its first", () => {
    const turns = buildTranscriptTurns([
      prompt("p1", "q"),
      assistant("a1", "thinking out loud"),
      assistant("a2", "final word"),
    ])

    expect(turns[0]?.response).toBe("final word")
  })

  test("drops rows before the first prompt", () => {
    const turns = buildTranscriptTurns([
      singleRow("s1", { kind: "system_init", model: "m", tools: [], agents: [], slashCommands: [], mcpServers: [], provider: "claude" }),
      assistant("a0", "orphan tail from a restored session"),
      prompt("p1", "q"),
    ])

    expect(turns).toHaveLength(1)
    expect(turns[0]).toMatchObject({ id: "p1", rowIndex: 2, endRowIndex: 2 })
  })

  test("an in-flight turn has no response yet", () => {
    const turns = buildTranscriptTurns([prompt("p1", "q"), toolGroupRow("t1")])

    expect(turns[0]).toMatchObject({ response: null, endRowIndex: 1 })
  })

  test("returns nothing for an empty transcript", () => {
    expect(buildTranscriptTurns([])).toEqual([])
  })
})

describe("buildTranscriptTurns — timing", () => {
  test("takes the timestamp from the prompt that opened the turn", () => {
    const asked = "2026-07-26T09:15:00.000Z"
    const turns = buildTranscriptTurns([
      singleRow("p1", { kind: "user_prompt", content: "go", timestamp: asked }),
      singleRow("a1", { kind: "assistant_text", text: "done", timestamp: "2026-07-26T09:16:00.000Z" }),
    ])

    expect(turns[0]?.timestamp).toBe(asked)
  })

  test("takes the duration from the result", () => {
    const turns = buildTranscriptTurns([
      prompt("p1", "go"),
      singleRow("r1", { kind: "result", success: true, result: "", durationMs: 12_000 }),
    ])

    expect(turns[0]?.durationMs).toBe(12_000)
  })

  // How long a turn ran before dying is worth as much as how long a good one took.
  test("keeps the duration of a failed turn", () => {
    const turns = buildTranscriptTurns([
      prompt("p1", "go"),
      singleRow("r1", { kind: "result", success: false, result: "boom", durationMs: 400 }),
    ])

    expect(turns[0]).toMatchObject({ durationMs: 400, error: "boom" })
  })

  test("a running turn has no duration yet", () => {
    expect(buildTranscriptTurns([prompt("p1", "go")])[0]?.durationMs).toBeNull()
  })

  test("rejects a timestamp that is not a usable date", () => {
    const rows = [
      singleRow("p1", { kind: "user_prompt", content: "a", timestamp: "not a date" }),
      singleRow("p2", { kind: "user_prompt", content: "b", timestamp: undefined }),
    ]

    expect(buildTranscriptTurns(rows).map((turn) => turn.timestamp)).toEqual([null, null])
  })

  test("ignores a non-numeric duration", () => {
    const turns = buildTranscriptTurns([
      prompt("p1", "go"),
      singleRow("r1", { kind: "result", success: true, result: "", durationMs: undefined }),
    ])

    expect(turns[0]?.durationMs).toBeNull()
  })
})

describe("buildTranscriptTurns — errored turns", () => {
  // A provider that dies on startup emits no assistant text at all, so without
  // capturing the result the turn would read as blank in the hover card.
  test("uses the error result as the turn's outcome", () => {
    const message = "Authentication required. Please run 'agent login' first."
    const turns = buildTranscriptTurns([prompt("p1", "go"), errorResult("r1", message)])

    expect(turns).toHaveLength(1)
    expect(turns[0]).toMatchObject({ rowIndex: 0, endRowIndex: 1, response: null, error: message })
  })

  test("keeps partial assistant text alongside the error", () => {
    const turns = buildTranscriptTurns([
      prompt("p1", "go"),
      assistant("a1", "starting on it"),
      errorResult("r1", "provider crashed"),
    ])

    expect(turns[0]).toMatchObject({ response: "starting on it", error: "provider crashed" })
  })

  test("falls back to a label when the error carries no text", () => {
    const turns = buildTranscriptTurns([prompt("p1", "go"), errorResult("r1", "   ")])

    expect(turns[0]?.error).toBe("Turn failed")
  })

  test("does not mark a cancelled turn as failed", () => {
    const turns = buildTranscriptTurns([
      prompt("p1", "go"),
      assistant("a1", "partial work"),
      cancelledResult("r1"),
    ])

    expect(turns[0]).toMatchObject({ error: null, response: "partial work" })
  })

  test("leaves a successful turn unmarked", () => {
    const turns = buildTranscriptTurns([prompt("p1", "go"), assistant("a1", "done"), okResult("r1")])

    expect(turns[0]).toMatchObject({ error: null, response: "done" })
  })

  // Two failure modes leave a turn with no rows but its own prompt: the server
  // throwing after the prompt was persisted (the error only reaches the
  // footer), and a steered turn whose `interrupted` entry is written hidden.
  test("a turn with no content rows spans only its prompt", () => {
    const turns = buildTranscriptTurns([
      prompt("p1", "first"),
      prompt("p2", "second"),
      assistant("a1", "answer"),
    ])

    expect(turns[0]).toMatchObject({ rowIndex: 0, endRowIndex: 0, response: null, error: null })
    expect(turns[1]).toMatchObject({ rowIndex: 1, endRowIndex: 2, response: "answer" })
  })

  test("a content-less turn still highlights while its prompt is on screen", () => {
    const [orphan] = buildTranscriptTurns([prompt("p1", "first"), prompt("p2", "second")])

    expect(orphan).toBeDefined()
    expect(isTurnInView(orphan!, 0, 0)).toBe(true)
    expect(isTurnInView(orphan!, 1, 1)).toBe(false)
  })

  // The transcript log is append-only and replays entries from older versions,
  // so these fields can be missing at runtime despite being typed as required.
  test("survives entries missing the text fields the types promise", () => {
    const rows = [
      singleRow("p1", { kind: "user_prompt" }),
      singleRow("a1", { kind: "assistant_text" }),
      singleRow("r1", { kind: "result", success: false }),
    ]

    expect(() => buildTranscriptTurns(rows)).not.toThrow()
    expect(buildTranscriptTurns(rows)[0]).toMatchObject({
      prompt: "",
      response: null,
      error: "Turn failed",
    })
  })

  test("blank assistant text does not wipe an existing summary", () => {
    const turns = buildTranscriptTurns([
      prompt("p1", "go"),
      assistant("a1", "real summary"),
      assistant("a2", "   "),
    ])

    expect(turns[0]?.response).toBe("real summary")
  })

  test("an errored turn mid-transcript does not swallow the next turn", () => {
    const turns = buildTranscriptTurns([
      prompt("p1", "first"),
      errorResult("r1", "boom"),
      prompt("p2", "second"),
      assistant("a2", "recovered"),
      okResult("r2"),
    ])

    expect(turns.map((turn) => [turn.rowIndex, turn.endRowIndex])).toEqual([[0, 1], [2, 4]])
    expect(turns[1]?.error).toBeNull()
  })
})

describe("agentMessageCount", () => {
  test("counts the agent's text and its tool calls, grouped or not", () => {
    // A prompt and a closing sentence look the same whether the agent answered
    // in one breath or ran a dozen tools to get there; this is the number that
    // says which happened.
    const turns = buildTranscriptTurns([
      prompt("p1", "go"),
      tool("standalone"),
      toolGroupRow("run", 4),
      assistant("a1", "done"),
      okResult("r1"),
    ])

    expect(turns[0]?.agentMessageCount).toBe(6)
  })

  test("does not count the prompt, the result, or text that hasn't arrived", () => {
    // Blank assistant entries lead a streaming turn; counting them would tick
    // the number up while nothing had been said.
    const turns = buildTranscriptTurns([
      prompt("p1", "go"),
      assistant("a1", "   "),
      okResult("r1"),
    ])

    expect(turns[0]?.agentMessageCount).toBe(0)
  })

  test("attributes each turn's work to that turn", () => {
    const turns = buildTranscriptTurns([
      prompt("p1", "first"),
      toolGroupRow("run", 3),
      assistant("a1", "first answer"),
      prompt("p2", "second"),
      assistant("a2", "second answer"),
    ])

    expect(turns.map((turn) => turn.agentMessageCount)).toEqual([4, 1])
  })
})

describe("isTurnInView", () => {
  const turn = (rowIndex: number, endRowIndex: number) =>
    ({ id: "t", rowIndex, endRowIndex, replyRowId: null, prompt: "", response: null, agentMessageCount: 0, error: null, timestamp: null, durationMs: null }) satisfies TranscriptTurn

  test("counts a turn that merely overlaps the window", () => {
    // Turn spans the whole viewport with neither edge inside it.
    expect(isTurnInView(turn(0, 100), 40, 50)).toBe(true)
    expect(isTurnInView(turn(45, 60), 40, 50)).toBe(true)
    expect(isTurnInView(turn(30, 45), 40, 50)).toBe(true)
  })

  test("excludes turns entirely above or below", () => {
    expect(isTurnInView(turn(0, 39), 40, 50)).toBe(false)
    expect(isTurnInView(turn(51, 80), 40, 50)).toBe(false)
  })

  test("includes turns touching the window edges", () => {
    expect(isTurnInView(turn(0, 40), 40, 50)).toBe(true)
    expect(isTurnInView(turn(50, 80), 40, 50)).toBe(true)
  })
})

describe("getMinimapCapacity", () => {
  test("fits as many ticks as the height allows", () => {
    expect(getMinimapCapacity(140, 14, 40)).toBe(10)
    expect(getMinimapCapacity(145, 14, 40)).toBe(10)
  })

  test("caps at the tick maximum on a tall window", () => {
    expect(getMinimapCapacity(2000, 14, 40)).toBe(40)
  })

  test("returns zero before measurement lands", () => {
    expect(getMinimapCapacity(0, 14, 40)).toBe(0)
    expect(getMinimapCapacity(-20, 14, 40)).toBe(0)
    expect(getMinimapCapacity(Number.NaN, 14, 40)).toBe(0)
  })
})

describe("selectVisibleTurns", () => {
  const turns = Array.from({ length: 5 }, (_, index) => (
    { id: `t${index}`, rowIndex: index, endRowIndex: index, replyRowId: null, prompt: "", response: null, agentMessageCount: 0, error: null, timestamp: null, durationMs: null }
  ))

  test("keeps the most recent turns when over capacity", () => {
    expect(selectVisibleTurns(turns, 2).map((turn) => turn.id)).toEqual(["t3", "t4"])
  })

  test("passes everything through when under capacity", () => {
    expect(selectVisibleTurns(turns, 10)).toEqual(turns)
  })

  test("shows nothing at zero capacity", () => {
    expect(selectVisibleTurns(turns, 0)).toEqual([])
  })
})

describe("getMagnifyFalloff", () => {
  test("peaks under the cursor and dies at the radius", () => {
    expect(getMagnifyFalloff(0, 56)).toBe(1)
    expect(getMagnifyFalloff(56, 56)).toBe(0)
    expect(getMagnifyFalloff(200, 56)).toBe(0)
  })

  test("is symmetric and monotonic between", () => {
    const near = getMagnifyFalloff(14, 56)
    const far = getMagnifyFalloff(42, 56)
    expect(near).toBeGreaterThan(far)
    expect(far).toBeGreaterThan(0)
    expect(getMagnifyFalloff(-14, 56)).toBeCloseTo(near)
  })

  test("degrades safely with no radius", () => {
    expect(getMagnifyFalloff(10, 0)).toBe(0)
  })
})

describe("getTranscriptGutterWidth", () => {
  test("splits the leftover width either side of the column", () => {
    expect(getTranscriptGutterWidth(1224, 800, 24)).toBe(200)
  })

  test("is zero once the column fills the pane", () => {
    expect(getTranscriptGutterWidth(800, 800, 24)).toBe(0)
    expect(getTranscriptGutterWidth(390, 800, 24)).toBe(0)
  })

  test("is zero before measurement lands", () => {
    expect(getTranscriptGutterWidth(0, 800, 24)).toBe(0)
  })
})
