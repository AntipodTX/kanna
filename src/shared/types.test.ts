import { describe, expect, test } from "bun:test"
import {
  CODEX_REASONING_OPTIONS,
  deriveClaudeModelLabel,
  getCodexModelOption,
  isCodexReasoningEffort,
  isCodexReasoningEffortSupported,
  normalizeClaudeModelId,
  normalizeCodexModelId,
  normalizeCodexReasoningEffort,
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
    expect(normalizeCodexModelId()).toBe("gpt-5.6-sol")
    expect(normalizeCodexModelId("gpt-5.6-terra")).toBe("gpt-5.6-terra")
    expect(normalizeCodexModelId("gpt-5-codex")).toBe("gpt-5.3-codex")
  })

  test("uses declarative metadata for Claude max-effort support", () => {
    expect(supportsClaudeMaxReasoningEffort("claude-opus-4-8")).toBe(true)
    expect(supportsClaudeMaxReasoningEffort("opus")).toBe(true)
    expect(supportsClaudeMaxReasoningEffort("fable")).toBe(false)
    expect(supportsClaudeMaxReasoningEffort("claude-sonnet-4-6")).toBe(false)
  })

  test("recognizes Codex CLI reasoning efforts", () => {
    expect(CODEX_REASONING_OPTIONS.map((option) => option.id)).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
      "ultra",
    ])
    expect(isCodexReasoningEffort("max")).toBe(true)
    expect(isCodexReasoningEffort("ultra")).toBe(true)
    expect(isCodexReasoningEffort("minimal")).toBe(false)
  })

  test("uses Codex CLI effort metadata per model", () => {
    expect(getCodexModelOption("gpt-5.6-sol")?.defaultEffort).toBe("low")
    expect(getCodexModelOption("gpt-5.6-sol")?.supportedEffortLevels).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
      "ultra",
    ])
    expect(getCodexModelOption("gpt-5.6-terra")?.defaultEffort).toBe("medium")
    expect(getCodexModelOption("gpt-5.6-terra")?.supportedEffortLevels).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
      "ultra",
    ])
    expect(getCodexModelOption("gpt-5.6-luna")?.defaultEffort).toBe("medium")
    expect(getCodexModelOption("gpt-5.6-luna")?.supportedEffortLevels).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ])
    expect(getCodexModelOption("gpt-5.5")?.supportedEffortLevels).toEqual(["low", "medium", "high", "xhigh"])
    expect(getCodexModelOption("gpt-5.4")?.supportedEffortLevels).toEqual(["low", "medium", "high", "xhigh"])
    expect(getCodexModelOption("gpt-5.3-codex")?.supportedEffortLevels).toEqual(["low", "medium", "high", "xhigh"])
  })

  test("normalizes unsupported Codex efforts to the selected model default", () => {
    expect(isCodexReasoningEffortSupported(getCodexModelOption("gpt-5.6-sol"), "ultra")).toBe(true)
    expect(isCodexReasoningEffortSupported(getCodexModelOption("gpt-5.6-luna"), "ultra")).toBe(false)
    expect(isCodexReasoningEffortSupported(getCodexModelOption("gpt-5.5"), "max")).toBe(false)
    expect(normalizeCodexReasoningEffort("gpt-5.6-sol", "ultra")).toBe("ultra")
    expect(normalizeCodexReasoningEffort("gpt-5.6-luna", "ultra")).toBe("medium")
    expect(normalizeCodexReasoningEffort("gpt-5.5", "max")).toBe("medium")
    expect(normalizeCodexReasoningEffort("gpt-5.3-codex", "minimal")).toBe("medium")
  })
})
