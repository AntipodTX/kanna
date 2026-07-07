import type {
  AgentProvider,
  ClaudeReasoningEffort,
  ClaudeModelOptions,
  CodexModelOptions,
  ClaudeContextWindow,
  ModelOptions,
  ProviderCatalogEntry,
  ProviderModelOption,
  ServiceTier,
} from "../shared/types"
import {
  CLAUDE_REASONING_OPTIONS,
  DEFAULT_CLAUDE_MODEL_OPTIONS,
  DEFAULT_CODEX_MODEL_OPTIONS,
  PROVIDERS,
  normalizeClaudeContextWindow,
  normalizeProviderModelId,
  isClaudeReasoningEffort,
  isClaudeReasoningEffortSupported,
  isCodexReasoningEffort,
} from "../shared/types"

const HARD_CODED_CODEX_MODELS: ProviderModelOption[] = [
  { id: "gpt-5.5", label: "GPT-5.5", supportsEffort: false },
  { id: "gpt-5.4", label: "GPT-5.4", supportsEffort: false },
  { id: "gpt-5.3-codex", label: "GPT-5.3 Codex", supportsEffort: false },
  { id: "gpt-5.3-codex-spark", label: "GPT-5.3 Codex Spark", supportsEffort: false },
]

export interface ClaudeSdkModelInfo {
  value: string
  displayName?: string
  description?: string
  supportsEffort?: boolean
  supportedEffortLevels?: readonly string[]
  supportsAdaptiveThinking?: boolean
}

function createServerProviders(): ProviderCatalogEntry[] {
  return PROVIDERS.map((provider) =>
    provider.id === "codex"
      ? {
          ...provider,
          defaultModel: "gpt-5.5",
          models: HARD_CODED_CODEX_MODELS,
        }
      : provider
  )
}

export const SERVER_PROVIDERS: ProviderCatalogEntry[] = createServerProviders()

export function resetServerProvidersForTests() {
  SERVER_PROVIDERS.splice(0, SERVER_PROVIDERS.length, ...createServerProviders())
}

function modelFamily(value: string) {
  const match = value.match(/^(?:claude-)?([a-z]+)(?:-|$)/i)
  return match?.[1]?.toLowerCase() ?? value.toLowerCase()
}

function sdkModelMatchScore(model: ClaudeSdkModelInfo, option: ProviderModelOption) {
  const modelValue = model.value.toLowerCase()
  if (modelValue === option.id.toLowerCase()) return 3
  if (option.aliases?.some((alias) => alias.toLowerCase() === modelValue)) return 2
  const optionKeys = [option.id, ...(option.aliases ?? [])].map(modelFamily)
  return optionKeys.includes(modelFamily(model.value)) ? 1 : 0
}

function findSdkModelForOption(models: readonly ClaudeSdkModelInfo[], option: ProviderModelOption) {
  let bestModel: ClaudeSdkModelInfo | undefined
  let bestScore = 0
  for (const model of models) {
    const score = sdkModelMatchScore(model, option)
    if (score > bestScore) {
      bestModel = model
      bestScore = score
    }
  }
  return bestModel
}

function normalizeClaudeSdkEffortLevel(level: string): readonly ClaudeReasoningEffort[] {
  if (level === "xhigh") return ["xhigh", "ultracode"]
  return isClaudeReasoningEffort(level) ? [level] : []
}

function normalizeClaudeSdkEffortLevels(levels?: readonly string[]): readonly ClaudeReasoningEffort[] | undefined {
  if (!levels) return undefined

  const normalized = new Set(levels.flatMap(normalizeClaudeSdkEffortLevel))
  return normalized.size > 0
    ? CLAUDE_REASONING_OPTIONS.map((option) => option.id).filter((effort) => normalized.has(effort))
    : undefined
}

export function applyClaudeSdkModels(models: readonly ClaudeSdkModelInfo[]) {
  const claudeIndex = SERVER_PROVIDERS.findIndex((provider) => provider.id === "claude")
  const claudeProvider = SERVER_PROVIDERS[claudeIndex]
  if (!claudeProvider) return false

  const nextModels = claudeProvider.models.map((option) => {
    const sdkModel = findSdkModelForOption(models, option)
    if (!sdkModel) return option
    return {
      ...option,
      label: sdkModel.displayName?.trim() || option.label,
      supportsEffort: sdkModel.supportsEffort ?? option.supportsEffort,
      supportedEffortLevels: normalizeClaudeSdkEffortLevels(sdkModel.supportedEffortLevels) ?? option.supportedEffortLevels,
    }
  })

  if (JSON.stringify(nextModels) === JSON.stringify(claudeProvider.models)) {
    return false
  }

  SERVER_PROVIDERS.splice(claudeIndex, 1, {
    ...claudeProvider,
    models: nextModels,
  })
  return true
}

export function getServerProviderCatalog(provider: AgentProvider): ProviderCatalogEntry {
  const entry = SERVER_PROVIDERS.find((candidate) => candidate.id === provider)
  if (!entry) {
    throw new Error(`Unknown provider: ${provider}`)
  }
  return entry
}

export function normalizeServerModel(provider: AgentProvider, model?: string): string {
  const catalog = getServerProviderCatalog(provider)
  const normalizedModel = normalizeProviderModelId(provider, model, catalog.defaultModel)
  if (catalog.models.some((candidate) => candidate.id === normalizedModel)) {
    return normalizedModel
  }
  return catalog.defaultModel
}

export function getServerProviderModelOption(provider: AgentProvider, modelId: string): ProviderModelOption | undefined {
  const normalizedModelId = normalizeServerModel(provider, modelId)
  return getServerProviderCatalog(provider).models.find((candidate) => candidate.id === normalizedModelId)
}

export function normalizeServerClaudeReasoningEffort(modelId: string, effort?: unknown): ClaudeReasoningEffort {
  const normalizedEffort = isClaudeReasoningEffort(effort)
    ? effort
    : DEFAULT_CLAUDE_MODEL_OPTIONS.reasoningEffort
  return isClaudeReasoningEffortSupported(getServerProviderModelOption("claude", modelId), normalizedEffort)
    ? normalizedEffort
    : DEFAULT_CLAUDE_MODEL_OPTIONS.reasoningEffort
}

export function normalizeClaudeModelOptions(
  model: string,
  modelOptions?: ModelOptions,
  legacyEffort?: string
): ClaudeModelOptions {
  const reasoningEffort = modelOptions?.claude?.reasoningEffort
  const normalizedEffort = isClaudeReasoningEffort(reasoningEffort)
    ? reasoningEffort
    : isClaudeReasoningEffort(legacyEffort)
      ? legacyEffort
      : DEFAULT_CLAUDE_MODEL_OPTIONS.reasoningEffort
  return {
    reasoningEffort: normalizeServerClaudeReasoningEffort(model, normalizedEffort),
    contextWindow: normalizeClaudeContextWindow(model, modelOptions?.claude?.contextWindow as ClaudeContextWindow | undefined),
  }
}

export function normalizeCodexModelOptions(modelOptions?: ModelOptions, legacyEffort?: string): CodexModelOptions {
  const reasoningEffort = modelOptions?.codex?.reasoningEffort
  return {
    reasoningEffort: isCodexReasoningEffort(reasoningEffort)
      ? reasoningEffort
      : isCodexReasoningEffort(legacyEffort)
        ? legacyEffort
        : DEFAULT_CODEX_MODEL_OPTIONS.reasoningEffort,
    fastMode: typeof modelOptions?.codex?.fastMode === "boolean"
      ? modelOptions.codex.fastMode
      : DEFAULT_CODEX_MODEL_OPTIONS.fastMode,
  }
}

export function codexServiceTierFromModelOptions(modelOptions: CodexModelOptions): ServiceTier | undefined {
  return modelOptions.fastMode ? "fast" : undefined
}
