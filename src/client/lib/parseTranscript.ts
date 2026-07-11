import { hydrateToolResult } from "../../shared/tools"
import type { HydratedToolCall, HydratedTranscriptMessage, NormalizedToolCall, TranscriptEntry } from "../../shared/types"

function createTimestamp(createdAt: number): string {
  return new Date(createdAt).toISOString()
}

function createBaseMessage(entry: TranscriptEntry) {
  return {
    id: entry._id,
    messageId: entry.messageId,
    timestamp: createTimestamp(entry.createdAt),
    hidden: entry.hidden,
  }
}

function hydrateToolCall(entry: Extract<TranscriptEntry, { kind: "tool_call" }>): HydratedToolCall {
  return {
    id: entry._id,
    messageId: entry.messageId,
    hidden: entry.hidden,
    kind: "tool",
    toolKind: entry.tool.toolKind,
    toolName: entry.tool.toolName,
    toolId: entry.tool.toolId,
    input: entry.tool.input as HydratedToolCall["input"],
    timestamp: createTimestamp(entry.createdAt),
  } as HydratedToolCall
}

const CLAUDE_PLAN_ADJUSTMENT_PREFIX = "User wants to suggest edits to the plan:"

function getStructuredToolResultFromDebug(
  entry: Extract<TranscriptEntry, { kind: "tool_result" }>,
  toolKind: NormalizedToolCall["toolKind"],
): unknown {
  if (!entry.debugRaw) return undefined

  try {
    const parsed = JSON.parse(entry.debugRaw) as { tool_use_result?: unknown }
    const result = parsed.tool_use_result
    if (toolKind === "exit_plan_mode" && typeof result === "string") {
      const message = result.replace(/^Error:\s*/, "")
      if (message.startsWith(CLAUDE_PLAN_ADJUSTMENT_PREFIX)) {
        return {
          confirmed: false,
          message: message.slice(CLAUDE_PLAN_ADJUSTMENT_PREFIX.length).trim(),
        }
      }
    }
    return result
  } catch {
    return undefined
  }
}

function isClaudePlanFilePath(value: unknown): value is string {
  if (typeof value !== "string") return false
  const normalized = value.replaceAll("\\", "/")
  return normalized.includes("/.claude/plans/") && normalized.endsWith(".md")
}

type ClaudePlanFileOperation = Extract<
  NormalizedToolCall,
  { toolKind: "write_file" | "edit_file" }
>

function recoverClaudeExitPlans(entries: TranscriptEntry[]): Map<string, string> {
  const pendingFileOperations = new Map<string, ClaudePlanFileOperation>()
  const appliedFileOperations = new Set<string>()
  const planFiles = new Map<string, string>()
  const recoveredPlans = new Map<string, string>()
  let latestPlanFilePath: string | null = null

  for (const entry of entries) {
    if (entry.kind === "tool_call") {
      const { tool } = entry
      if (
        (tool.toolKind === "write_file" || tool.toolKind === "edit_file")
        && isClaudePlanFilePath(tool.input.filePath)
      ) {
        pendingFileOperations.set(tool.toolId, tool)
      }

      if (tool.toolKind === "exit_plan_mode") {
        if (!(typeof tool.input.plan === "string" && tool.input.plan.length > 0)) {
          const recoveredPlan = latestPlanFilePath ? planFiles.get(latestPlanFilePath) : undefined
          if (recoveredPlan) {
            recoveredPlans.set(tool.toolId, recoveredPlan)
          }
        }
        latestPlanFilePath = null
      }
      continue
    }

    if (
      entry.kind !== "tool_result"
      || entry.isError
      || appliedFileOperations.has(entry.toolId)
    ) {
      continue
    }

    const operation = pendingFileOperations.get(entry.toolId)
    if (!operation) continue

    const filePath = operation.input.filePath
    if (operation.toolKind === "write_file") {
      planFiles.set(filePath, operation.input.content)
      latestPlanFilePath = filePath
      appliedFileOperations.add(entry.toolId)
      continue
    }

    const currentPlan = planFiles.get(filePath)
    if (currentPlan === undefined || !currentPlan.includes(operation.input.oldString)) {
      continue
    }

    const replaceAll = operation.rawInput?.replace_all === true
    planFiles.set(
      filePath,
      replaceAll
        ? currentPlan.replaceAll(operation.input.oldString, operation.input.newString)
        : currentPlan.replace(operation.input.oldString, operation.input.newString),
    )
    latestPlanFilePath = filePath
    appliedFileOperations.add(entry.toolId)
  }

  return recoveredPlans
}

export function processTranscriptMessages(entries: TranscriptEntry[]): HydratedTranscriptMessage[] {
  const pendingToolCalls = new Map<string, { hydrated: HydratedToolCall; normalized: NormalizedToolCall }>()
  const messages: HydratedTranscriptMessage[] = []
  let recoveredExitPlans: Map<string, string> | undefined

  for (const entry of entries) {
    switch (entry.kind) {
      case "user_prompt":
        messages.push({
          ...createBaseMessage(entry),
          kind: "user_prompt",
          content: entry.content,
          attachments: entry.attachments ?? [],
          steered: entry.steered,
        })
        break
      case "system_init":
        messages.push({
          ...createBaseMessage(entry),
          kind: "system_init",
          provider: entry.provider,
          model: entry.model,
          tools: entry.tools,
          agents: entry.agents,
          slashCommands: entry.slashCommands,
          mcpServers: entry.mcpServers,
          debugRaw: entry.debugRaw,
        })
        break
      case "account_info":
        messages.push({
          ...createBaseMessage(entry),
          kind: "account_info",
          accountInfo: entry.accountInfo,
        })
        break
      case "assistant_text":
        messages.push({
          ...createBaseMessage(entry),
          kind: "assistant_text",
          text: entry.text,
        })
        break
      case "tool_call": {
        const toolCall = hydrateToolCall(entry)
        if (toolCall.toolKind === "exit_plan_mode" && !toolCall.input.plan) {
          recoveredExitPlans ??= recoverClaudeExitPlans(entries)
          const recoveredPlan = recoveredExitPlans.get(toolCall.toolId)
          if (recoveredPlan !== undefined) {
            toolCall.input = { ...toolCall.input, plan: recoveredPlan }
          }
        }
        pendingToolCalls.set(entry.tool.toolId, { hydrated: toolCall, normalized: entry.tool })
        messages.push(toolCall)
        break
      }
      case "tool_result": {
        const pendingCall = pendingToolCalls.get(entry.toolId)
        if (pendingCall) {
          const rawResult = (
            pendingCall.normalized.toolKind === "ask_user_question" ||
            pendingCall.normalized.toolKind === "exit_plan_mode"
          )
            ? getStructuredToolResultFromDebug(entry, pendingCall.normalized.toolKind) ?? entry.content
            : entry.content

          pendingCall.hydrated.result = hydrateToolResult(pendingCall.normalized, rawResult) as never
          pendingCall.hydrated.rawResult = rawResult
          pendingCall.hydrated.isError = entry.isError
        }
        break
      }
      case "result":
        messages.push({
          ...createBaseMessage(entry),
          kind: "result",
          success: !entry.isError,
          cancelled: entry.subtype === "cancelled",
          result: entry.result,
          durationMs: entry.durationMs,
          costUsd: entry.costUsd,
        })
        break
      case "status":
        messages.push({
          ...createBaseMessage(entry),
          kind: "status",
          status: entry.status,
        })
        break
      case "context_window_updated":
        messages.push({
          ...createBaseMessage(entry),
          kind: "context_window_updated",
          usage: entry.usage,
        })
        break
      case "compact_boundary":
        messages.push({
          ...createBaseMessage(entry),
          kind: "compact_boundary",
        })
        break
      case "compact_summary":
        messages.push({
          ...createBaseMessage(entry),
          kind: "compact_summary",
          summary: entry.summary,
        })
        break
      case "context_cleared":
        messages.push({
          ...createBaseMessage(entry),
          kind: "context_cleared",
        })
        break
      case "interrupted":
        messages.push({
          ...createBaseMessage(entry),
          kind: "interrupted",
        })
        break
      default:
        messages.push({
          ...createBaseMessage(entry),
          kind: "unknown",
          json: JSON.stringify(entry, null, 2),
        })
        break
    }
  }

  return messages
}
