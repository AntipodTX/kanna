import {
  QuickResponseAdapter,
  type StructuredQuickResponseAttempt,
  type StructuredQuickResponseFailure,
} from "./quick-response"

const TITLE_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string" },
  },
  required: ["title"],
  additionalProperties: false,
} as const

function normalizeGeneratedTitle(value: unknown): string | null {
  if (typeof value !== "string") return null
  const normalized = value.replace(/\s+/g, " ").trim().slice(0, 80)
  if (!normalized || normalized === "New Chat") return null
  return normalized
}

export function fallbackTitleFromMessage(messageContent: string): string | null {
  const normalized = messageContent.replace(/\s+/g, " ").trim()
  if (!normalized) return null
  if (normalized.length <= 35) return normalized
  return `${normalized.slice(0, 35)}...`
}

export interface GenerateChatTitleResult {
  title: string | null
  usedFallback: boolean
  failureMessage: string | null
  provider?: StructuredQuickResponseAttempt["provider"] | null
  attempts?: StructuredQuickResponseAttempt[]
}

function summarizeFailures(failures: StructuredQuickResponseFailure[]) {
  if (failures.length === 0) return null
  return failures.map((failure) => failure.reason).join("; ")
}

export async function generateTitleForChat(
  messageContent: string,
  cwd: string,
  adapter = new QuickResponseAdapter(),
  options: { preferredProvider?: "claude" | "codex"; useConfiguredProvider?: boolean } = {}
): Promise<string | null> {
  const result = await generateTitleForChatDetailed(messageContent, cwd, adapter, options)
  return result.title
}

export async function generateTitleForChatDetailed(
  messageContent: string,
  cwd: string,
  adapter = new QuickResponseAdapter(),
  options: { preferredProvider?: "claude" | "codex"; useConfiguredProvider?: boolean } = {}
): Promise<GenerateChatTitleResult> {
  const result = await adapter.generateStructuredWithDiagnostics<string>({
    cwd,
    task: "conversation title generation",
    prompt: `Generate a short, descriptive title (under 30 chars) for a conversation that starts with this message.\n\n${messageContent}`,
    schema: TITLE_SCHEMA,
    parse: (value) => {
      const output = value && typeof value === "object" ? value as { title?: unknown } : {}
      return normalizeGeneratedTitle(output.title)
    },
    preferredProvider: options.preferredProvider,
    useConfiguredProvider: options.useConfiguredProvider,
    preferSmallestCodexModel: true,
  })

  if (result.value) {
    return {
      title: result.value,
      usedFallback: false,
      failureMessage: null,
      provider: result.provider,
      attempts: result.attempts,
    }
  }

  const fallbackTitle = fallbackTitleFromMessage(messageContent)
  return {
    title: fallbackTitle,
    usedFallback: true,
    failureMessage: summarizeFailures(result.failures),
    provider: result.provider,
    attempts: result.attempts,
  }
}
