import { describe, expect, test } from "bun:test"
import {
  CLAUDE_REASONING_OPTIONS,
  deriveClaudeModelLabel,
  getClaudeModelOption,
  isClaudeReasoningEffort,
  isClaudeReasoningEffortSupported,
  normalizeClaudeModelId,
  normalizeCodexModelId,
  supportsClaudeMaxReasoningEffort,
} from "./types"

describe("shared model normalization", () => {
  test("derives fallback Claude model labels from model ids", () => {
    expect(deriveClaudeModelLabel("fable")).toBe("Fable")
    expect(deriveClaudeModelLabel("claude-opus-4-8")).toBe("Opus")
    expect(deriveClaudeModelLabel("claude-haiku-4-5-20251001")).toBe("Haiku")
  })

  test("normalizes Claude aliases via the provider catalog", () => {
    expect(normalizeClaudeModelId("fable")).toBe("fable")
    expect(normalizeClaudeModelId("opus")).toBe("claude-opus-4-8")
    expect(normalizeClaudeModelId("sonnet")).toBe("claude-sonnet-4-6")
    expect(normalizeClaudeModelId("haiku")).toBe("claude-haiku-4-5-20251001")
  })

  test("normalizes legacy Codex aliases and defaults to the latest catalog model", () => {
    expect(normalizeCodexModelId()).toBe("gpt-5.5")
    expect(normalizeCodexModelId("gpt-5-codex")).toBe("gpt-5.3-codex")
  })

  test("uses declarative metadata for Claude max-effort support", () => {
    expect(supportsClaudeMaxReasoningEffort("claude-opus-4-8")).toBe(true)
    expect(supportsClaudeMaxReasoningEffort("opus")).toBe(true)
    expect(supportsClaudeMaxReasoningEffort("fable")).toBe(true)
    expect(supportsClaudeMaxReasoningEffort("claude-sonnet-4-6")).toBe(true)
    expect(supportsClaudeMaxReasoningEffort("claude-haiku-4-5-20251001")).toBe(false)
  })

  test("uses conservative Claude effort support before SDK metadata loads", () => {
    const fable = getClaudeModelOption("fable")
    expect(isClaudeReasoningEffortSupported(fable, "xhigh")).toBe(true)
    expect(isClaudeReasoningEffortSupported(fable, "ultracode")).toBe(true)

    const sonnet = getClaudeModelOption("claude-sonnet-4-6")
    expect(isClaudeReasoningEffortSupported(sonnet, "max")).toBe(true)
    expect(isClaudeReasoningEffortSupported(sonnet, "xhigh")).toBe(false)
    expect(isClaudeReasoningEffortSupported(sonnet, "ultracode")).toBe(false)

    const unknownEffortModel = { id: "future", label: "Future", supportsEffort: true }
    expect(isClaudeReasoningEffortSupported(unknownEffortModel, "high")).toBe(true)
    expect(isClaudeReasoningEffortSupported(unknownEffortModel, "max")).toBe(false)
  })

  test("recognizes Claude XHigh and Ultracode efforts", () => {
    expect(CLAUDE_REASONING_OPTIONS.map((option) => option.id)).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
      "ultracode",
    ])
    expect(isClaudeReasoningEffort("xhigh")).toBe(true)
    expect(isClaudeReasoningEffort("ultracode")).toBe(true)
  })
})
