import { afterEach, describe, expect, test } from "bun:test"
import {
  SERVER_PROVIDERS,
  applyClaudeSdkModels,
  codexServiceTierFromModelOptions,
  normalizeClaudeModelOptions,
  normalizeCodexModelOptions,
  normalizeServerModel,
  resetServerProvidersForTests,
} from "./provider-catalog"
import { resolveClaudeApiModelId } from "../shared/types"

describe("provider catalog normalization", () => {
  afterEach(() => {
    resetServerProvidersForTests()
  })

  test("maps legacy Claude effort into shared model options", () => {
    expect(normalizeClaudeModelOptions("claude-opus-4-8", undefined, "max")).toEqual({
      reasoningEffort: "max",
      contextWindow: "200k",
    })
  })

  test("maps legacy Claude Ultracode effort into shared model options", () => {
    expect(normalizeClaudeModelOptions("fable", undefined, "ultracode")).toEqual({
      reasoningEffort: "ultracode",
      contextWindow: "200k",
    })
  })

  test("normalizes unsupported Claude efforts to the default", () => {
    expect(normalizeClaudeModelOptions("claude-haiku-4-5-20251001", {
      claude: {
        reasoningEffort: "max",
      },
    })).toEqual({
      reasoningEffort: "high",
      contextWindow: "200k",
    })
  })

  test("normalizes Claude context window only for supported models", () => {
    expect(normalizeClaudeModelOptions("claude-sonnet-4-6", {
      claude: {
        reasoningEffort: "medium",
        contextWindow: "1m",
      },
    })).toEqual({
      reasoningEffort: "medium",
      contextWindow: "1m",
    })

    expect(normalizeClaudeModelOptions("claude-haiku-4-5-20251001", {
      claude: {
        reasoningEffort: "medium",
        contextWindow: "1m",
      },
    })).toMatchObject({
      reasoningEffort: "medium",
    })
  })

  test("normalizes Codex model options and fast mode defaults", () => {
    expect(normalizeCodexModelOptions(undefined)).toEqual({
      reasoningEffort: "high",
      fastMode: false,
    })

    const normalized = normalizeCodexModelOptions({
      codex: {
        reasoningEffort: "xhigh",
        fastMode: true,
      },
    })

    expect(normalized).toEqual({
      reasoningEffort: "xhigh",
      fastMode: true,
    })
    expect(codexServiceTierFromModelOptions(normalized)).toBe("fast")
  })

  test("normalizes server model ids through the shared alias catalog", () => {
    expect(normalizeServerModel("codex")).toBe("gpt-5.5")
    expect(normalizeServerModel("claude", "fable")).toBe("fable")
    expect(normalizeServerModel("claude", "opus")).toBe("claude-opus-4-8")
    expect(normalizeServerModel("codex", "gpt-5-codex")).toBe("gpt-5.3-codex")
  })

  test("resolves Claude API model ids for 1m context window", () => {
    expect(resolveClaudeApiModelId("claude-opus-4-8", "1m")).toBe("claude-opus-4-8[1m]")
    expect(resolveClaudeApiModelId("fable", "200k")).toBe("fable")
    expect(resolveClaudeApiModelId("claude-sonnet-4-6", "200k")).toBe("claude-sonnet-4-6")
  })

  test("overlays Claude model labels from the Agent SDK model catalog", () => {
    expect(applyClaudeSdkModels([
      { value: "claude-fable-5[1m]", displayName: "Fable from SDK", supportsEffort: true, supportedEffortLevels: ["low", "medium", "high", "max"] },
      { value: "claude-opus-4-7", displayName: "Opus 4.7", supportsEffort: true },
      { value: "claude-opus-4-8", displayName: "Opus from SDK", supportsEffort: true },
    ])).toBe(true)

    const claude = SERVER_PROVIDERS.find((provider) => provider.id === "claude")
    const fable = claude?.models.find((model) => model.id === "fable") as { label?: string; supportedEffortLevels?: readonly string[] } | undefined
    expect(fable?.label).toBe("Fable from SDK")
    expect(fable?.supportedEffortLevels).toEqual(["low", "medium", "high", "max"])
    expect(claude?.models.find((model) => model.id === "claude-opus-4-8")?.label).toBe("Opus from SDK")
  })

  test("maps SDK xhigh effort support to XHigh and Ultracode UI options", () => {
    expect(applyClaudeSdkModels([
      { value: "fable", displayName: "Fable", supportsEffort: true, supportedEffortLevels: ["low", "xhigh"] },
    ])).toBe(true)

    const claude = SERVER_PROVIDERS.find((provider) => provider.id === "claude")
    const fable = claude?.models.find((model) => model.id === "fable") as { supportedEffortLevels?: readonly string[] } | undefined
    expect(fable?.supportedEffortLevels).toEqual(["low", "xhigh", "ultracode"])
  })

  test("sorts SDK effort metadata by the shared Claude UI order", () => {
    expect(applyClaudeSdkModels([
      { value: "fable", displayName: "Fable", supportsEffort: true, supportedEffortLevels: ["low", "xhigh", "max"] },
    ])).toBe(true)

    const claude = SERVER_PROVIDERS.find((provider) => provider.id === "claude")
    const fable = claude?.models.find((model) => model.id === "fable") as { supportedEffortLevels?: readonly string[] } | undefined
    expect(fable?.supportedEffortLevels).toEqual(["low", "xhigh", "max", "ultracode"])
  })

  test("normalizes Claude model options against SDK-updated effort metadata", () => {
    expect(applyClaudeSdkModels([
      { value: "claude-sonnet-4-6", displayName: "Sonnet", supportsEffort: true, supportedEffortLevels: ["low", "medium", "high", "xhigh"] },
    ])).toBe(true)

    expect(normalizeClaudeModelOptions("claude-sonnet-4-6", {
      claude: {
        reasoningEffort: "xhigh",
      },
    })).toEqual({
      reasoningEffort: "xhigh",
      contextWindow: "200k",
    })
  })
})
