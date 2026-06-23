import { describe, expect, test } from "bun:test"
import { fallbackTitleFromMessage, generateTitleForChat, generateTitleForChatDetailed } from "./generate-title"
import { buildClaudeStructuredOptions, extractClaudeStructuredResult, getQuickResponseWorkspace, QuickResponseAdapter } from "./quick-response"

describe("QuickResponseAdapter", () => {
  test("returns the SDK structured result when configured and it validates", async () => {
    const adapter = new QuickResponseAdapter({
      readLlmProvider: async () => ({
        provider: "openai",
        apiKey: "test-key",
        model: "gpt-5-mini",
        baseUrl: "",
        resolvedBaseUrl: "https://api.openai.com/v1",
        enabled: true,
        warning: null,
        filePathDisplay: "~/.kanna/llm-provider.json",
      }),
      runOpenAIStructured: async () => ({ title: "SDK title" }),
      runClaudeStructured: async () => ({ title: "Claude title" }),
      runCodexStructured: async () => ({ title: "Codex title" }),
    })

    const result = await adapter.generateStructured({
      cwd: "/tmp/project",
      task: "title generation",
      prompt: "Generate a title",
      schema: {
        type: "object",
        properties: {
          title: { type: "string" },
        },
        required: ["title"],
        additionalProperties: false,
      },
      parse: (value) => {
        const output = value && typeof value === "object" ? value as { title?: unknown } : {}
        return typeof output.title === "string" ? output.title : null
      },
    })

    expect(result).toBe("SDK title")
  })

  test("prefers Codex first when requested", async () => {
    const callOrder: string[] = []
    const adapter = new QuickResponseAdapter({
      readLlmProvider: async () => ({
        provider: "openai",
        apiKey: "",
        model: "",
        baseUrl: "",
        resolvedBaseUrl: "https://api.openai.com/v1",
        enabled: false,
        warning: null,
        filePathDisplay: "~/.kanna/llm-provider.json",
      }),
      runClaudeStructured: async () => {
        callOrder.push("claude")
        return { title: "Claude title" }
      },
      runCodexStructured: async () => {
        callOrder.push("codex")
        return { title: "Codex title" }
      },
    })

    const result = await adapter.generateStructured({
      cwd: "/tmp/project",
      task: "title generation",
      prompt: "Generate a title",
      schema: {
        type: "object",
        properties: {
          title: { type: "string" },
        },
        required: ["title"],
        additionalProperties: false,
      },
      parse: (value) => {
        const output = value && typeof value === "object" ? value as { title?: unknown } : {}
        return typeof output.title === "string" ? output.title : null
      },
      preferredProvider: "codex",
    })

    expect(result).toBe("Codex title")
    expect(callOrder).toEqual(["codex"])
  })

  test("returns the Claude structured result when it validates", async () => {
    const adapter = new QuickResponseAdapter({
      readLlmProvider: async () => ({
        provider: "openai",
        apiKey: "",
        model: "",
        baseUrl: "",
        resolvedBaseUrl: "https://api.openai.com/v1",
        enabled: false,
        warning: null,
        filePathDisplay: "~/.kanna/llm-provider.json",
      }),
      runClaudeStructured: async () => ({ title: "Claude title" }),
      runCodexStructured: async () => ({ title: "Codex title" }),
    })

    const result = await adapter.generateStructured({
      cwd: "/tmp/project",
      task: "title generation",
      prompt: "Generate a title",
      schema: {
        type: "object",
        properties: {
          title: { type: "string" },
        },
        required: ["title"],
        additionalProperties: false,
      },
      parse: (value) => {
        const output = value && typeof value === "object" ? value as { title?: unknown } : {}
        return typeof output.title === "string" ? output.title : null
      },
    })

    expect(result).toBe("Claude title")
  })

  test("falls back to Codex when Claude fails validation", async () => {
    const adapter = new QuickResponseAdapter({
      readLlmProvider: async () => ({
        provider: "openai",
        apiKey: "",
        model: "",
        baseUrl: "",
        resolvedBaseUrl: "https://api.openai.com/v1",
        enabled: false,
        warning: null,
        filePathDisplay: "~/.kanna/llm-provider.json",
      }),
      runClaudeStructured: async () => ({ bad: true }),
      runCodexStructured: async () => ({ title: "Codex title" }),
    })

    const result = await adapter.generateStructured({
      cwd: "/tmp/project",
      task: "title generation",
      prompt: "Generate a title",
      schema: {
        type: "object",
        properties: {
          title: { type: "string" },
        },
        required: ["title"],
        additionalProperties: false,
      },
      parse: (value) => {
        const output = value && typeof value === "object" ? value as { title?: unknown } : {}
        return typeof output.title === "string" ? output.title : null
      },
    })

    expect(result).toBe("Codex title")
  })

  test("falls back to Codex when Claude throws", async () => {
    const adapter = new QuickResponseAdapter({
      readLlmProvider: async () => ({
        provider: "openai",
        apiKey: "",
        model: "",
        baseUrl: "",
        resolvedBaseUrl: "https://api.openai.com/v1",
        enabled: false,
        warning: null,
        filePathDisplay: "~/.kanna/llm-provider.json",
      }),
      runClaudeStructured: async () => {
        throw new Error("Not authenticated")
      },
      runCodexStructured: async () => ({ title: "Codex title" }),
    })

    const result = await adapter.generateStructured({
      cwd: "/tmp/project",
      task: "title generation",
      prompt: "Generate a title",
      schema: {
        type: "object",
        properties: {
          title: { type: "string" },
        },
        required: ["title"],
        additionalProperties: false,
      },
      parse: (value) => {
        const output = value && typeof value === "object" ? value as { title?: unknown } : {}
        return typeof output.title === "string" ? output.title : null
      },
    })

    expect(result).toBe("Codex title")
  })

  test("reports per-provider diagnostics including durations and the winning provider", async () => {
    const adapter = new QuickResponseAdapter({
      runClaudeStructured: async () => {
        await Bun.sleep(5)
        throw new Error("Not authenticated")
      },
      runCodexStructured: async () => {
        await Bun.sleep(5)
        return { title: "Codex title" }
      },
    })

    const result = await adapter.generateStructuredWithDiagnostics({
      cwd: "/tmp/project",
      task: "title generation",
      prompt: "Generate a title",
      schema: {
        type: "object",
        properties: {
          title: { type: "string" },
        },
        required: ["title"],
        additionalProperties: false,
      },
      parse: (value) => {
        const output = value && typeof value === "object" ? value as { title?: unknown } : {}
        return typeof output.title === "string" ? output.title : null
      },
    })

    expect(result.value).toBe("Codex title")
    expect(result.provider).toBe("codex")
    expect(result.attempts).toHaveLength(2)
    expect(result.attempts[0]).toMatchObject({
      provider: "claude",
      outcome: "error",
    })
    expect(result.attempts[1]).toMatchObject({
      provider: "codex",
      outcome: "success",
    })
    expect(result.attempts.every((attempt) => attempt.durationMs >= 0)).toBe(true)
  })

  test("uses the Kanna app data root as the quick-response workspace", async () => {
    const previousProfile = process.env.KANNA_RUNTIME_PROFILE
    process.env.KANNA_RUNTIME_PROFILE = "dev"

    try {
      let claudeCwd = ""
      const adapter = new QuickResponseAdapter({
        readLlmProvider: async () => ({
          provider: "openai",
          apiKey: "",
          model: "",
          baseUrl: "",
          resolvedBaseUrl: "https://api.openai.com/v1",
          enabled: false,
          warning: null,
          filePathDisplay: "~/.kanna-dev/llm-provider.json",
        }),
        runClaudeStructured: async (args) => {
          claudeCwd = args.cwd
          return { title: "Claude title" }
        },
      })

      await adapter.generateStructured({
        cwd: "/tmp/project",
        task: "title generation",
        prompt: "Generate a title",
        schema: {
          type: "object",
          properties: {
            title: { type: "string" },
          },
          required: ["title"],
          additionalProperties: false,
        },
        parse: (value) => {
          const output = value && typeof value === "object" ? value as { title?: unknown } : {}
          return typeof output.title === "string" ? output.title : null
        },
      })

      expect(claudeCwd).toBe(getQuickResponseWorkspace(process.env))
      expect(claudeCwd.endsWith("/.kanna-dev")).toBe(true)
    } finally {
      if (previousProfile === undefined) {
        delete process.env.KANNA_RUNTIME_PROFILE
      } else {
        process.env.KANNA_RUNTIME_PROFILE = previousProfile
      }
    }
  })

  test("passes Codex structured options through to the app-server manager", async () => {
    const schema = {
      type: "object",
      properties: {
        title: { type: "string" },
      },
      required: ["title"],
      additionalProperties: false,
    } as const
    const requests: Array<{ cwd: string; prompt: string; model?: string; effort?: string; outputSchema?: unknown }> = []
    const adapter = new QuickResponseAdapter({
      readLlmProvider: async () => ({
        provider: "openai",
        apiKey: "",
        model: "",
        baseUrl: "",
        resolvedBaseUrl: "https://api.openai.com/v1",
        enabled: false,
        warning: null,
        filePathDisplay: "~/.kanna/llm-provider.json",
      }),
      codexManager: {
        async generateStructured(
          args: { cwd: string; prompt: string; model?: string; effort?: string; outputSchema?: unknown }
        ) {
          requests.push(args)
          return "{\"title\":\"Codex title\"}"
        },
      } as never,
      runClaudeStructured: async () => null,
    })

    const result = await adapter.generateStructured({
      cwd: "/tmp/project",
      task: "title generation",
      prompt: "Generate a title",
      schema,
      parse: (value) => {
        const output = value && typeof value === "object" ? value as { title?: unknown } : {}
        return typeof output.title === "string" ? output.title : null
      },
      codexModel: "gpt-5.3-codex",
      codexEffort: "low",
    })

    expect(result).toBe("Codex title")
    expect(requests).toHaveLength(1)
    expect(requests[0]?.model).toBe("gpt-5.3-codex")
    expect(requests[0]?.effort).toBe("low")
    expect(requests[0]?.outputSchema).toBe(schema)
  })

  test("falls through to Claude when the SDK is not configured", async () => {
    let openAICalls = 0
    const adapter = new QuickResponseAdapter({
      readLlmProvider: async () => ({
        provider: "openai",
        apiKey: "",
        model: "",
        baseUrl: "",
        resolvedBaseUrl: "https://api.openai.com/v1",
        enabled: false,
        warning: null,
        filePathDisplay: "~/.kanna/llm-provider.json",
      }),
      runOpenAIStructured: async () => {
        openAICalls += 1
        return { title: "SDK title" }
      },
      runClaudeStructured: async () => ({ title: "Claude title" }),
    })

    const result = await adapter.generateStructured({
      cwd: "/tmp/project",
      task: "title generation",
      prompt: "Generate a title",
      schema: {
        type: "object",
        properties: {
          title: { type: "string" },
        },
        required: ["title"],
        additionalProperties: false,
      },
      parse: (value) => {
        const output = value && typeof value === "object" ? value as { title?: unknown } : {}
        return typeof output.title === "string" ? output.title : null
      },
    })

    expect(result).toBe("Claude title")
    expect(openAICalls).toBe(0)
  })

  test("can skip the configured SDK provider for native-only generation", async () => {
    let configReads = 0
    let openAICalls = 0
    const adapter = new QuickResponseAdapter({
      readLlmProvider: async () => {
        configReads += 1
        return {
          provider: "openai",
          apiKey: "test-key",
          model: "gpt-5-mini",
          baseUrl: "",
          resolvedBaseUrl: "https://api.openai.com/v1",
          enabled: true,
          warning: null,
          filePathDisplay: "~/.kanna/llm-provider.json",
        }
      },
      runOpenAIStructured: async () => {
        openAICalls += 1
        return { title: "SDK title" }
      },
      runClaudeStructured: async () => ({ title: "Claude title" }),
    })

    const result = await adapter.generateStructured({
      cwd: "/tmp/project",
      task: "title generation",
      prompt: "Generate a title",
      schema: {
        type: "object",
        properties: {
          title: { type: "string" },
        },
        required: ["title"],
        additionalProperties: false,
      },
      parse: (value) => {
        const output = value && typeof value === "object" ? value as { title?: unknown } : {}
        return typeof output.title === "string" ? output.title : null
      },
      useConfiguredProvider: false,
    })

    expect(result).toBe("Claude title")
    expect(configReads).toBe(0)
    expect(openAICalls).toBe(0)
  })

  test("builds Claude structured requests as single-turn no-tools plan-mode queries", () => {
    const schema = {
      type: "object",
      properties: {
        title: { type: "string" },
      },
      required: ["title"],
      additionalProperties: false,
    } as const

    const options = buildClaudeStructuredOptions({
      cwd: "/tmp/project",
      task: "title generation",
      prompt: "Generate a title",
      schema,
    })

    expect(options.cwd).toBe("/tmp/project")
    expect(options.model).toBe("haiku")
    expect(options.tools).toEqual([])
    expect(options.effort).toBe("low")
    expect(options.maxTurns).toBe(1)
    expect(options.permissionMode).toBe("plan")
    expect(options.outputFormat).toEqual({
      type: "json_schema",
      schema,
    })
  })

  test("extracts Claude structured output from structured_output when present", () => {
    expect(extractClaudeStructuredResult({
      result: "{\"title\":\"ignored\"}",
      structured_output: { title: "Structured title" },
    })).toEqual({ title: "Structured title" })
  })

  test("extracts Claude structured output from StructuredOutput tool use", () => {
    expect(extractClaudeStructuredResult({
      message: {
        content: [
          {
            type: "tool_use",
            name: "StructuredOutput",
            input: { title: "Tool title" },
          },
        ],
      },
    })).toEqual({ title: "Tool title" })
  })

  test("ignores Claude result text when structured_output is missing", () => {
    expect(extractClaudeStructuredResult({
      result: "{\"title\":\"Parsed title\"}",
    })).toBeNull()
  })
})

describe("generateTitleForChat", () => {
  test("sanitizes generated titles", async () => {
    const title = await generateTitleForChat(
      "hello",
      "/tmp/project",
      new QuickResponseAdapter({
        readLlmProvider: async () => ({
          provider: "openai",
          apiKey: "",
          model: "",
          baseUrl: "",
          resolvedBaseUrl: "https://api.openai.com/v1",
          enabled: false,
          warning: null,
          filePathDisplay: "~/.kanna/llm-provider.json",
        }),
        runClaudeStructured: async () => ({ title: "   Example\nTitle   " }),
      })
    )

    expect(title).toBe("Example Title")
  })

  test("rejects invalid generated titles", async () => {
    const title = await generateTitleForChat(
      "hello",
      "/tmp/project",
      new QuickResponseAdapter({
        readLlmProvider: async () => ({
          provider: "openai",
          apiKey: "",
          model: "",
          baseUrl: "",
          resolvedBaseUrl: "https://api.openai.com/v1",
          enabled: false,
          warning: null,
          filePathDisplay: "~/.kanna/llm-provider.json",
        }),
        runClaudeStructured: async () => ({ title: "   " }),
        runCodexStructured: async () => ({ title: "New Chat" }),
      })
    )

    expect(title).toBe("hello")
  })

  test("falls back to the first 35 characters of the message with ellipsis", async () => {
    const title = await generateTitleForChat(
      "This message is definitely longer than thirty five characters",
      "/tmp/project",
      new QuickResponseAdapter({
        readLlmProvider: async () => ({
          provider: "openai",
          apiKey: "",
          model: "",
          baseUrl: "",
          resolvedBaseUrl: "https://api.openai.com/v1",
          enabled: false,
          warning: null,
          filePathDisplay: "~/.kanna/llm-provider.json",
        }),
        runClaudeStructured: async () => {
          throw new Error("Not authenticated")
        },
        runCodexStructured: async () => null,
      })
    )

    expect(title).toBe("This message is definitely longer t...")
  })

  test("returns fallback metadata when providers fail", async () => {
    const result = await generateTitleForChatDetailed(
      "hello there",
      "/tmp/project",
      new QuickResponseAdapter({
        readLlmProvider: async () => ({
          provider: "openai",
          apiKey: "",
          model: "",
          baseUrl: "",
          resolvedBaseUrl: "https://api.openai.com/v1",
          enabled: false,
          warning: null,
          filePathDisplay: "~/.kanna/llm-provider.json",
        }),
        runClaudeStructured: async () => {
          throw new Error("Not authenticated")
        },
        runCodexStructured: async () => {
          throw new Error("Codex unavailable")
        },
      })
    )

    expect(result).toEqual({
      title: "hello there",
      usedFallback: true,
      failureMessage: "claude failed conversation title generation: Not authenticated; codex failed conversation title generation: Codex unavailable",
      provider: null,
      attempts: [
        {
          provider: "claude",
          outcome: "error",
          reason: "claude failed conversation title generation: Not authenticated",
          durationMs: expect.any(Number),
        },
        {
          provider: "codex",
          outcome: "error",
          reason: "codex failed conversation title generation: Codex unavailable",
          durationMs: expect.any(Number),
        },
      ],
    })
  })

  test("includes SDK failure details before Claude and Codex", async () => {
    const result = await generateTitleForChatDetailed(
      "hello there",
      "/tmp/project",
      new QuickResponseAdapter({
        readLlmProvider: async () => ({
          provider: "openai",
          apiKey: "test-key",
          model: "gpt-5-mini",
          baseUrl: "",
          resolvedBaseUrl: "https://api.openai.com/v1",
          enabled: true,
          warning: null,
          filePathDisplay: "~/.kanna/llm-provider.json",
        }),
        runOpenAIStructured: async () => {
          throw new Error("SDK unavailable")
        },
        runClaudeStructured: async () => {
          throw new Error("Not authenticated")
        },
        runCodexStructured: async () => {
          throw new Error("Codex unavailable")
        },
      })
    )

    expect(result.failureMessage).toBe(
      "openai failed conversation title generation: SDK unavailable; claude failed conversation title generation: Not authenticated; codex failed conversation title generation: Codex unavailable"
    )
  })

  test("uses the smallest listed Codex text model for title generation", async () => {
    let codexModel: string | undefined
    let codexEffort: string | undefined

    const result = await generateTitleForChatDetailed(
      "hello there",
      "/tmp/project",
      new QuickResponseAdapter({
        readLlmProvider: async () => ({
          provider: "openai",
          apiKey: "",
          model: "",
          baseUrl: "",
          resolvedBaseUrl: "https://api.openai.com/v1",
          enabled: false,
          warning: null,
          filePathDisplay: "~/.kanna/llm-provider.json",
        }),
        runClaudeStructured: async () => {
          throw new Error("Not authenticated")
        },
        codexManager: {
          async listModels() {
            return [
              {
                id: "gpt-5.5",
                model: "gpt-5.5",
                displayName: "GPT-5.5",
                description: "Frontier model for complex coding, research, and real-world work.",
                hidden: false,
                supportedReasoningEfforts: [
                  { reasoningEffort: "low" },
                  { reasoningEffort: "medium" },
                ],
                defaultReasoningEffort: "medium",
                inputModalities: ["text", "image"],
                serviceTiers: [],
                defaultServiceTier: null,
                isDefault: true,
              },
              {
                id: "gpt-5.4-mini",
                model: "gpt-5.4-mini",
                displayName: "GPT-5.4-Mini",
                description: "Small, fast, and cost-efficient model for simpler coding tasks.",
                hidden: false,
                supportedReasoningEfforts: [
                  { reasoningEffort: "low" },
                  { reasoningEffort: "medium" },
                ],
                defaultReasoningEffort: "medium",
                inputModalities: ["text"],
                serviceTiers: [],
                defaultServiceTier: null,
                isDefault: false,
              },
            ]
          },
          async generateStructured(args: { model?: string; effort?: string }) {
            codexModel = args.model
            codexEffort = args.effort
            return "{\"title\":\"Codex title\"}"
          },
        } as never,
      }),
      { preferredProvider: "codex" }
    )

    expect(result.title).toBe("Codex title")
    expect(result.provider).toBe("codex")
    expect(codexModel).toBe("gpt-5.4-mini")
    expect(codexEffort).toBe("low")
  })

  test("falls back to the Codex app-server default when model listing fails", async () => {
    let codexModel: string | undefined
    let codexEffort: string | undefined

    const result = await generateTitleForChatDetailed(
      "hello there",
      "/tmp/project",
      new QuickResponseAdapter({
        readLlmProvider: async () => ({
          provider: "openai",
          apiKey: "",
          model: "",
          baseUrl: "",
          resolvedBaseUrl: "https://api.openai.com/v1",
          enabled: false,
          warning: null,
          filePathDisplay: "~/.kanna/llm-provider.json",
        }),
        runClaudeStructured: async () => {
          throw new Error("Not authenticated")
        },
        codexManager: {
          async listModels() {
            throw new Error("model/list unavailable")
          },
          async generateStructured(args: { model?: string; effort?: string }) {
            codexModel = args.model
            codexEffort = args.effort
            return "{\"title\":\"Codex title\"}"
          },
        } as never,
      }),
      { preferredProvider: "codex" }
    )

    expect(result.title).toBe("Codex title")
    expect(result.provider).toBe("codex")
    expect(codexModel).toBeUndefined()
    expect(codexEffort).toBeUndefined()
  })

  test("falls back to the Codex app-server default when no small model is listed", async () => {
    let codexModel: string | undefined
    let codexEffort: string | undefined

    const result = await generateTitleForChatDetailed(
      "hello there",
      "/tmp/project",
      new QuickResponseAdapter({
        readLlmProvider: async () => ({
          provider: "openai",
          apiKey: "",
          model: "",
          baseUrl: "",
          resolvedBaseUrl: "https://api.openai.com/v1",
          enabled: false,
          warning: null,
          filePathDisplay: "~/.kanna/llm-provider.json",
        }),
        runClaudeStructured: async () => {
          throw new Error("Not authenticated")
        },
        codexManager: {
          async listModels() {
            return [
              {
                id: "gpt-5.5",
                model: "gpt-5.5",
                displayName: "GPT-5.5",
                description: "Frontier model for complex coding, research, and real-world work.",
                hidden: false,
                supportedReasoningEfforts: [
                  { reasoningEffort: "low" },
                  { reasoningEffort: "medium" },
                ],
                defaultReasoningEffort: "medium",
                inputModalities: ["text"],
                serviceTiers: [],
                defaultServiceTier: null,
                isDefault: true,
              },
            ]
          },
          async generateStructured(args: { model?: string; effort?: string }) {
            codexModel = args.model
            codexEffort = args.effort
            return "{\"title\":\"Codex title\"}"
          },
        } as never,
      }),
      { preferredProvider: "codex" }
    )

    expect(result.title).toBe("Codex title")
    expect(result.provider).toBe("codex")
    expect(codexModel).toBeUndefined()
    expect(codexEffort).toBeUndefined()
  })
})

describe("fallbackTitleFromMessage", () => {
  test("normalizes whitespace", () => {
    expect(fallbackTitleFromMessage("  hello\n   world  ")).toBe("hello world")
  })

  test("returns null for blank input", () => {
    expect(fallbackTitleFromMessage("   \n  ")).toBeNull()
  })
})
