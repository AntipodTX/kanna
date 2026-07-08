import { query } from "@anthropic-ai/claude-agent-sdk"
import { homedir } from "node:os"
import OpenAI from "openai"
import { getDataRootDir } from "../shared/branding"
import type { CodexReasoningEffort, LlmProviderSnapshot } from "../shared/types"
import { CodexAppServerManager } from "./codex-app-server"
import type { CodexModel } from "./codex-app-server-protocol"
import { readLlmProviderSnapshot } from "./llm-provider"

const CLAUDE_STRUCTURED_TIMEOUT_MS = 15_000

type JsonSchema = {
  type: "object"
  properties: Record<string, unknown>
  required?: readonly string[]
  additionalProperties?: boolean
}

export function buildClaudeStructuredOptions(args: Omit<StructuredQuickResponseArgs<unknown>, "parse">) {
  return {
    cwd: args.cwd,
    model: "haiku" as const,
    tools: [] as string[],
    systemPrompt: "",
    effort: "low" as const,
    maxTurns: 1,
    permissionMode: "plan" as const,
    outputFormat: {
      type: "json_schema" as const,
      schema: args.schema,
    },
    env: { ...process.env },
  }
}

export interface StructuredQuickResponseArgs<T> {
  cwd: string
  task: string
  prompt: string
  schema: JsonSchema
  parse: (value: unknown) => T | null
  preferredProvider?: "claude" | "codex"
  useConfiguredProvider?: boolean
  codexModel?: string
  codexEffort?: CodexReasoningEffort
  preferSmallestCodexModel?: boolean
}

interface QuickResponseAdapterArgs {
  codexManager?: CodexAppServerManager
  readLlmProvider?: () => Promise<LlmProviderSnapshot>
  runOpenAIStructured?: (
    config: LlmProviderSnapshot,
    args: Omit<StructuredQuickResponseArgs<unknown>, "parse">
  ) => Promise<unknown | null>
  runClaudeStructured?: (args: Omit<StructuredQuickResponseArgs<unknown>, "parse">) => Promise<unknown | null>
  runCodexStructured?: (args: Omit<StructuredQuickResponseArgs<unknown>, "parse">) => Promise<unknown | null>
}

export interface StructuredQuickResponseFailure {
  provider: "openai" | "claude" | "codex"
  reason: string
}

export interface StructuredQuickResponseAttempt {
  provider: "openai" | "claude" | "codex"
  outcome: "success" | "no_result" | "invalid" | "error"
  durationMs: number
  reason?: string
}

export interface StructuredQuickResponseResult<T> {
  value: T | null
  provider: "openai" | "claude" | "codex" | null
  attempts: StructuredQuickResponseAttempt[]
  failures: StructuredQuickResponseFailure[]
}

function getProviderOrder(preferredProvider?: "claude" | "codex") {
  if (preferredProvider === "codex") {
    return ["codex", "claude"] as const
  }
  return ["claude", "codex"] as const
}

const CODEX_SMALL_MODEL_PATTERNS = [
  { pattern: /(^|[^a-z0-9])(nano|micro|tiny)([^a-z0-9]|$)/i, score: 0 },
  { pattern: /(^|[^a-z0-9])mini([^a-z0-9]|$)/i, score: 1 },
  { pattern: /(^|[^a-z0-9])(small|lite|spark)([^a-z0-9]|$)/i, score: 2 },
] as const

const CODEX_EFFORT_ORDER: CodexReasoningEffort[] = ["minimal", "low", "medium", "high", "xhigh"]

function codexModelSearchText(model: CodexModel) {
  return [
    model.id,
    model.model,
    model.displayName,
    model.description,
  ].filter(Boolean).join(" ")
}

function getSmallCodexModelScore(model: CodexModel): number | null {
  if (model.hidden) return null
  if (model.inputModalities.length > 0 && !model.inputModalities.includes("text")) return null

  const text = codexModelSearchText(model)
  for (const candidate of CODEX_SMALL_MODEL_PATTERNS) {
    if (candidate.pattern.test(text)) {
      return candidate.score
    }
  }
  return null
}

function selectSmallestCodexTextModel(models: CodexModel[]): CodexModel | null {
  return models
    .map((model, index) => ({ model, index, score: getSmallCodexModelScore(model) }))
    .filter((candidate): candidate is { model: CodexModel; index: number; score: number } => candidate.score !== null)
    .sort((left, right) => left.score - right.score || left.index - right.index)[0]?.model ?? null
}

function selectLowestCodexEffort(model: CodexModel): CodexReasoningEffort | undefined {
  const supported = new Set(model.supportedReasoningEfforts.map((effort) => effort.reasoningEffort))
  return CODEX_EFFORT_ORDER.find((effort) => supported.has(effort))
}

export function getQuickResponseWorkspace(env: Record<string, string | undefined> = process.env) {
  return getDataRootDir(homedir(), env)
}

function parseJsonText(value: string): unknown | null {
  const trimmed = value.trim()
  if (!trimmed) return null

  const candidates = [trimmed]
  const fencedMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)
  if (fencedMatch?.[1]) {
    candidates.unshift(fencedMatch[1].trim())
  }

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate)
    } catch {
      continue
    }
  }

  return null
}

function formatClaudeResultPreview(value: unknown): string {
  const raw = typeof value === "string" ? value : JSON.stringify(value)
  if (!raw) return "<empty>"
  const normalized = raw.replace(/\s+/g, " ").trim()
  if (normalized.length <= 300) return normalized
  return `${normalized.slice(0, 300)}...`
}

export function extractClaudeStructuredResult(message: unknown): unknown | null {
  if (!message || typeof message !== "object") return null

  const record = message as Record<string, unknown>
  if ("structured_output" in record) {
    return record.structured_output ?? null
  }

  const assistantMessage = record.message
  if (!assistantMessage || typeof assistantMessage !== "object") return null
  const content = (assistantMessage as { content?: unknown }).content
  if (!Array.isArray(content)) return null

  for (const item of content) {
    if (!item || typeof item !== "object") continue
    const toolUse = item as Record<string, unknown>
    if (toolUse.type === "tool_use" && toolUse.name === "StructuredOutput") {
      return toolUse.input ?? null
    }
  }

  return null
}

export async function runClaudeStructured(args: Omit<StructuredQuickResponseArgs<unknown>, "parse">): Promise<unknown | null> {
  const q = query({
    prompt: args.prompt,
    options: buildClaudeStructuredOptions(args),
  })

  try {
    const result = await Promise.race<unknown | null>([
      (async () => {
        for await (const message of q) {
          const structuredResult = extractClaudeStructuredResult(message)
          if (structuredResult !== null) {
            return structuredResult
          }

          if (message && typeof message === "object" && "result" in message) {
            const resultMessage = message as Record<string, unknown>
            throw new Error(
              `Claude returned result without structured_output for conversation title generation: ${formatClaudeResultPreview(resultMessage.result)}`
            )
          }
        }
        return null
      })(),
      new Promise<null>((_, reject) => {
        setTimeout(() => {
          reject(new Error(`Claude structured response timed out after ${CLAUDE_STRUCTURED_TIMEOUT_MS}ms`))
        }, CLAUDE_STRUCTURED_TIMEOUT_MS)
      }),
    ])

    return result
  } finally {
    try {
      q.close()
    } catch {
      // Ignore close failures on timed-out or failed quick responses.
    }
  }
}

export async function runOpenAIStructured(
  config: LlmProviderSnapshot,
  args: Omit<StructuredQuickResponseArgs<unknown>, "parse">
): Promise<unknown | null> {
  const client = new OpenAI({
    apiKey: config.apiKey,
    baseURL: config.resolvedBaseUrl,
  })

  const response = await client.responses.create({
    model: config.model,
    input: args.prompt,
    text: {
      format: {
        type: "json_schema",
        name: "quick_response",
        schema: args.schema,
        strict: true,
      },
    },
  })

  return parseJsonText(response.output_text)
}

export async function runCodexStructured(
  codexManager: CodexAppServerManager,
  args: Omit<StructuredQuickResponseArgs<unknown>, "parse">
): Promise<unknown | null> {
  const response = await codexManager.generateStructured({
    cwd: args.cwd,
    prompt: `${args.prompt}\n\nReturn JSON only that matches this schema:\n${JSON.stringify(args.schema, null, 2)}`,
    model: args.codexModel,
    effort: args.codexEffort,
    outputSchema: args.schema,
  })
  if (typeof response !== "string") return null
  return parseJsonText(response)
}

export class QuickResponseAdapter {
  private readonly codexManager: CodexAppServerManager
  private readonly readLlmProvider: () => Promise<LlmProviderSnapshot>
  private readonly runOpenAIStructured: (
    config: LlmProviderSnapshot,
    args: Omit<StructuredQuickResponseArgs<unknown>, "parse">
  ) => Promise<unknown | null>
  private readonly runClaudeStructured: (args: Omit<StructuredQuickResponseArgs<unknown>, "parse">) => Promise<unknown | null>
  private readonly runCodexStructured: (args: Omit<StructuredQuickResponseArgs<unknown>, "parse">) => Promise<unknown | null>

  constructor(args: QuickResponseAdapterArgs = {}) {
    this.codexManager = args.codexManager ?? new CodexAppServerManager()
    this.readLlmProvider = args.readLlmProvider ?? (() => readLlmProviderSnapshot())
    this.runOpenAIStructured = args.runOpenAIStructured ?? runOpenAIStructured
    this.runClaudeStructured = args.runClaudeStructured ?? runClaudeStructured
    this.runCodexStructured = args.runCodexStructured ?? ((structuredArgs) =>
      runCodexStructured(this.codexManager, structuredArgs))
  }
  async generateStructured<T>(args: StructuredQuickResponseArgs<T>): Promise<T | null> {
    const result = await this.generateStructuredWithDiagnostics(args)
    return result.value
  }

  async generateStructuredWithDiagnostics<T>(args: StructuredQuickResponseArgs<T>): Promise<StructuredQuickResponseResult<T>> {
    const request: Omit<StructuredQuickResponseArgs<unknown>, "parse"> = {
      cwd: getQuickResponseWorkspace(),
      task: args.task,
      prompt: args.prompt,
      schema: args.schema,
      codexModel: args.codexModel,
      codexEffort: args.codexEffort,
    }

    const failures: StructuredQuickResponseFailure[] = []
    const attempts: StructuredQuickResponseAttempt[] = []
    const llmProvider = args.useConfiguredProvider === false ? null : await this.readLlmProvider()
    if (llmProvider?.enabled) {
      const openAIResult = await this.tryProvider("openai", args.task, args.parse, () => this.runOpenAIStructured(llmProvider, request))
      attempts.push(openAIResult.attempt)
      if (openAIResult.value !== null) {
        return {
          value: openAIResult.value,
          provider: "openai",
          attempts,
          failures,
        }
      }
      if (openAIResult.failure) {
        failures.push(openAIResult.failure)
      }
    }

    for (const provider of getProviderOrder(args.preferredProvider)) {
      const providerResult = await this.tryProvider(
        provider,
        args.task,
        args.parse,
        async () => provider === "claude"
          ? this.runClaudeStructured(request)
          : this.runCodexStructured(await this.resolveCodexRequest(args, request))
      )
      attempts.push(providerResult.attempt)
      if (providerResult.value !== null) {
        return {
          value: providerResult.value,
          provider,
          attempts,
          failures,
        }
      }
      if (providerResult.failure) {
        failures.push(providerResult.failure)
      }
    }

    return {
      value: null,
      provider: null,
      attempts,
      failures,
    }
  }

  private async resolveCodexRequest<T>(
    args: StructuredQuickResponseArgs<T>,
    request: Omit<StructuredQuickResponseArgs<unknown>, "parse">
  ): Promise<Omit<StructuredQuickResponseArgs<unknown>, "parse">> {
    if (!args.preferSmallestCodexModel || request.codexModel) {
      return request
    }

    try {
      const model = selectSmallestCodexTextModel(await this.codexManager.listModels({ cwd: request.cwd }))
      if (!model) {
        return request
      }
      return {
        ...request,
        codexModel: model.model || model.id,
        codexEffort: selectLowestCodexEffort(model),
      }
    } catch {
      return request
    }
  }

  private async tryProvider<T>(
    provider: "openai" | "claude" | "codex",
    task: string,
    parse: (value: unknown) => T | null,
    run: () => Promise<unknown | null>
  ): Promise<{
    value: T | null
    failure: StructuredQuickResponseFailure | null
    attempt: StructuredQuickResponseAttempt
  }> {
    const startedAt = Date.now()
    try {
      const result = await run()
      if (result === null) {
        const reason = `${provider} returned no result for ${task}`
        return {
          value: null,
          failure: {
            provider,
            reason,
          },
          attempt: {
            provider,
            outcome: "no_result",
            durationMs: Date.now() - startedAt,
            reason,
          },
        }
      }

      const parsed = parse(result)
      if (parsed === null) {
        const reason = `${provider} returned invalid structured output for ${task}`
        return {
          value: null,
          failure: {
            provider,
            reason,
          },
          attempt: {
            provider,
            outcome: "invalid",
            durationMs: Date.now() - startedAt,
            reason,
          },
        }
      }

      return {
        value: parsed,
        failure: null,
        attempt: {
          provider,
          outcome: "success",
          durationMs: Date.now() - startedAt,
        },
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const reason = `${provider} failed ${task}: ${message}`
      return {
        value: null,
        failure: {
          provider,
          reason,
        },
        attempt: {
          provider,
          outcome: "error",
          durationMs: Date.now() - startedAt,
          reason,
        },
      }
    }
  }
}
