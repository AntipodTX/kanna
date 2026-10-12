const CODEX_APPROVAL_POLICY = "never" as const
import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { createInterface } from "node:readline"
import type { Readable, Writable } from "node:stream"
import type {
  AskUserQuestionItem,
  CodexReasoningEffort,
  ContextWindowUsageSnapshot,
  ServiceTier,
  TodoItem,
  TranscriptEntry,
} from "../shared/types"
import type { HarnessEvent, HarnessStartupOutcome, HarnessToolRequest, HarnessTurn } from "./harness-types"
import { appendSystemMessageBlock, buildSkillSystemMessage } from "./harness-skills"
import { buildKannaAgentId } from "./attribution"
import { buildKannaSystemInstructions } from "./harness-instructions"
import { AsyncQueue } from "./async-queue"
import type { KannaToolHost } from "./kanna-tools"
import { createKannaMcpServer } from "./kanna-mcp"
import { asNumber, asRecord } from "../shared/json"
import { timestamped } from "./transcript"
import type { CodexNativeInput } from "./codex-prompt-history"
import {
  type AccountRateLimitsUpdatedNotification,
  type CollabAgentToolCallItem,
  type ContextCompactedNotification,
  type CodexError,
  type CodexModelSummary,
  type CodexRateLimitSnapshot,
  type CodexRequestId,
  type GetAccountRateLimitsResponse,
  type CodexSkillMetadata,
  type CodexUserInput,
  type CommandExecutionApprovalDecision,
  type CommandExecutionRequestApprovalParams,
  type CommandExecutionRequestApprovalResponse,
  type DynamicToolCallOutputContentItem,
  type DynamicToolCallResponse,
  type ErrorNotification,
  type FileChangeApprovalDecision,
  type FileChangeRequestApprovalParams,
  type FileChangeRequestApprovalResponse,
  type InitializeParams,
  type ItemCompletedNotification,
  type ItemStartedNotification,
  type JsonRpcResponse,
  type McpToolCallItem,
  type PlanDeltaNotification,
  type ServerNotification,
  type ServerRequest,
  type ModelListParams,
  type ModelListResponse,
  type SkillsListParams,
  type SkillsListResponse,
  type Thread,
  type ThreadItem,
  type ThreadRollbackParams,
  type ThreadRollbackResponse,
  type ThreadTurnsListParams,
  type ThreadTurnsListResponse,
  type ThreadRevertParams,
  type ThreadRevertResponse,
  type ThreadResumeParams,
  type ThreadResumeResponse,
  type ThreadForkParams,
  type ThreadForkResponse,
  type ThreadStartParams,
  type ThreadStartResponse,
  type ThreadTokenUsageUpdatedNotification,
  type ToolRequestUserInputParams,
  type ToolRequestUserInputQuestion,
  type ToolRequestUserInputResponse,
  type TurnPlanStep,
  type TurnPlanUpdatedNotification,
  type TurnCompletedNotification,
  type TurnInterruptParams,
  type TurnStartParams,
  type TurnStartResponse,
  type TurnSteerParams,
  type TurnSteerResponse,
  isJsonRpcResponse,
  isServerNotification,
  isServerRequest,
} from "./codex-app-server-protocol"

interface CodexAppServerProcess {
  stdin: Writable
  stdout: Readable
  stderr: Readable
  killed?: boolean
  kill(signal?: NodeJS.Signals | number): void
  on(event: "close", listener: (code: number | null) => void): this
  on(event: "error", listener: (error: Error) => void): this
  once(event: "close", listener: (code: number | null) => void): this
  once(event: "error", listener: (error: Error) => void): this
}

type SpawnCodexAppServer = (cwd: string) => CodexAppServerProcess

interface PendingRequest<TResult> {
  method: string
  resolve: (value: TResult) => void
  reject: (error: Error) => void
}

type UserPromptTranscriptEntry = Extract<TranscriptEntry, { kind: "user_prompt" }>

interface PendingSteeredEntry {
  entry: UserPromptTranscriptEntry
  echoReceived: boolean
  settled: boolean
  persisted: Promise<void>
  resolvePersisted: () => void
  rejectPersisted: (error: Error) => void
}

interface PendingTurn {
  turnId: string | null
  model: string
  planMode: boolean
  queue: AsyncQueue<HarnessEvent>
  startedToolIds: Set<string>
  handledDynamicToolIds: Set<string>
  latestPlanExplanation: string | null
  latestPlanSteps: TurnPlanStep[]
  latestPlanText: string | null
  planTextByItemId: Map<string, string>
  todoSequence: number
  pendingWebSearchResultToolId: string | null
  /**
   * Most informative error from this turn's retry sequence, if it had one.
   * Kept so a turn that ends up failing can still name the problem — codex
   * reports the cause once, somewhere in the sequence, and the terminal
   * notification that follows can be empty.
   */
  retryCause: CodexError | null
  pendingSteeredEntries: Map<string, PendingSteeredEntry>
  resolved: boolean
  onToolRequest: (request: HarnessToolRequest) => Promise<unknown>
  onApprovalRequest?: (
    request:
      | {
          requestId: CodexRequestId
          kind: "command_execution"
          params: CommandExecutionRequestApprovalParams
        }
      | {
          requestId: CodexRequestId
          kind: "file_change"
          params: FileChangeRequestApprovalParams
        }
  ) => Promise<CommandExecutionApprovalDecision | FileChangeApprovalDecision>
}

interface SessionContext {
  customTools?: ReturnType<typeof createKannaMcpServer>
  chatId: string
  cwd: string
  child: CodexAppServerProcess
  pendingRequests: Map<CodexRequestId, PendingRequest<unknown>>
  pendingTurn: PendingTurn | null
  sessionToken: string | null
  stderrLines: string[]
  closed: boolean
}

interface NativePromptHistoryThread {
  id: string
  path?: string
  historyMode?: string
  turns?: Array<{id:string;status:string;completedAt?:number|null;items:Array<{type:string;clientId?:string;content?:Array<{type:string;text?:string}>}>}>
}

export interface StartCodexSessionArgs {
  isCurrentTurn?: () => boolean
  signal?: AbortSignal
  customTools?: KannaToolHost
  chatId: string
  cwd: string
  model: string
  serviceTier?: ServiceTier
  sessionToken: string | null
  pendingForkSessionToken?: string | null
}

export interface StartCodexTurnArgs {
  isCurrentTurn?: () => boolean
  signal?: AbortSignal
  clientUserMessageId?: string
  chatId: string
  model: string
  effort?: CodexReasoningEffort
  serviceTier?: ServiceTier
  content: string
  /**
   * Skills the prompt names, resolved. Each one adds a structured
   * `{type:"skill", name, path}` item to the turn input (deterministic
   * server-side injection), and one `<system-message>` failsafe listing them
   * is appended to the text item — codex silently skips skill items whose
   * path no longer matches a discovered skill, so the failsafe keeps the
   * intent visible to the model regardless.
   */
  skills?: { name: string; path: string }[]
  planMode: boolean
  onToolRequest: (request: HarnessToolRequest) => Promise<unknown>
  onApprovalRequest?: PendingTurn["onApprovalRequest"]
}

export interface SteerCodexTurnArgs {
  chatId: string
  expectedTurnId: string
  content: string
  selectedSkills?: { name: string; path: string }[]
  clientUserMessageId: string
  transcriptEntry: UserPromptTranscriptEntry
}

export interface CodexSteerHandle {
  /** Resolves when Codex accepts the turn/steer request. */
  accepted: Promise<void>
  /** Resolves only after the correlated userMessage has been persisted. */
  settled: Promise<void>
}

export interface GenerateStructuredArgs {
  cwd: string
  prompt: string
  model?: string
  effort?: CodexReasoningEffort
  serviceTier?: ServiceTier
}

function codexSystemInitEntry(model: string): TranscriptEntry {
  return timestamped({
    kind: "system_init",
    provider: "codex",
    model,
    tools: ["Bash", "Write", "Edit", "WebSearch", "TodoWrite", "AskUserQuestion", "ExitPlanMode"],
    agents: ["spawnAgent", "sendInput", "resumeAgent", "wait", "closeAgent"],
    slashCommands: [],
    mcpServers: [],
  })
}

function errorMessage(value: unknown): string {
  if (value instanceof Error) return value.message
  return String(value)
}

export class CodexRequestError extends Error {
  constructor(readonly method: string, readonly code: number | undefined, message: string) {
    super(`${method} failed: ${message}`)
  }
}

/** Only an actual provider rejection of a selected turn proves a stale
 * boundary. Socket/auth failures and unsupported methods do not. */
export function isMissingCodexHistoryBoundary(error: unknown): boolean {
  if (!(error instanceof CodexRequestError) || error.method !== "thread/fork") return false
  if (/\b(?:auth\w*|unauthorized|forbidden|unsupported|schema)\b|unknown field|unknown parameter|unrecognized field|invalid type/i.test(error.message)) return false
  return /\b(?:beforeTurnId|lastTurnId|turn|boundary)\b.*?(?:not found|does not exist|missing|unknown)|\b(?:missing|unknown|no such)\b.*?\b(?:turn|boundary)\b/i.test(error.message)
}

/**
 * The cause as one readable token. String variants pass through; object
 * variants name their single key and, when the upstream sent one, the HTTP
 * status ("responseStreamDisconnected (HTTP 502)"). Without this the exact
 * errors a retry sequence is about would read as having no cause at all.
 */
function errorDetail(error: CodexError): string {
  const info = error.codexErrorInfo
  if (typeof info === "string") return info.trim()
  if (!info || typeof info !== "object") return ""
  const [kind, data] = Object.entries(info)[0] ?? []
  if (!kind) return ""
  const status = data?.httpStatusCode
  return typeof status === "number" ? `${kind} (HTTP ${status})` : kind
}

/**
 * codex splits an error across `message` and `codexErrorInfo`, and the message
 * on its own is often just a summary. Keep both when the detail adds anything,
 * so a failed turn names the cause rather than the category.
 */
function formatCodexError(error: CodexError | null | undefined): string {
  if (!error) return ""
  const message = error.message?.trim() ?? ""
  const detail = errorDetail(error)
  if (!detail || message.includes(detail)) return message
  return message ? `${message}: ${detail}` : detail
}

/**
 * Of the errors in one retry sequence, keep the one that explains the most.
 * codex mixes a cause ("stream disconnected: unexpected EOF") in with bare
 * progress notices ("Reconnecting... 2/5") and the order isn't guaranteed —
 * the sequences in the wild open with a counter — so neither "first wins" nor
 * "last wins" reliably holds the cause. Prefer whichever carries
 * `codexErrorInfo`, and otherwise keep the first: letting a counter overwrite
 * a real cause is the exact failure this fallback exists to prevent.
 */
function preferredRetryCause(current: CodexError | null, next: CodexError): CodexError {
  if (!current) return next
  if (errorDetail(next) && !errorDetail(current)) return next
  return current
}

function parseJsonLine(line: string): unknown | null {
  try {
    return JSON.parse(line)
  } catch {
    return null
  }
}

function isRecoverableResumeError(error: unknown): boolean {
  const message = errorMessage(error).toLowerCase()
  if (!message.includes("thread/resume")) return false
  return ["not found", "missing thread", "no such thread", "unknown thread", "does not exist"].some((snippet) =>
    message.includes(snippet)
  )
}

const MULTI_SELECT_HINT_PATTERN = /\b(all that apply|select all|choose all|pick all|select multiple|choose multiple|pick multiple|multiple selections?|multiple choice|more than one|one or more)\b/i

function inferQuestionAllowsMultiple(question: ToolRequestUserInputQuestion): boolean {
  const combinedText = [question.header, question.question].filter(Boolean).join(" ")
  return MULTI_SELECT_HINT_PATTERN.test(combinedText)
}

function toAskUserQuestionItems(params: ToolRequestUserInputParams): AskUserQuestionItem[] {
  return params.questions.map((question) => ({
    id: question.id,
    question: question.question,
    header: question.header || undefined,
    options: question.options?.map((option) => ({
      label: option.label,
      description: option.description ?? undefined,
    })),
    multiSelect: inferQuestionAllowsMultiple(question),
  }))
}

function toToolRequestUserInputResponse(raw: unknown, questions: ToolRequestUserInputParams["questions"]): ToolRequestUserInputResponse {
  const record = raw && typeof raw === "object" ? raw as Record<string, unknown> : {}
  const answersValue = record.answers
  const value = answersValue && typeof answersValue === "object" && !Array.isArray(answersValue)
    ? answersValue as Record<string, unknown>
    : record
  const answers = Object.fromEntries(
    questions.map((question) => {
      const rawAnswer = value[question.id] ?? value[question.question]
      if (Array.isArray(rawAnswer)) {
        return [question.id, { answers: rawAnswer.map((entry) => String(entry)) }]
      }
      if (typeof rawAnswer === "string") {
        return [question.id, { answers: [rawAnswer] }]
      }
      if (rawAnswer && typeof rawAnswer === "object" && Array.isArray((rawAnswer as { answers?: unknown }).answers)) {
        return [question.id, { answers: ((rawAnswer as { answers: unknown[] }).answers).map((entry) => String(entry)) }]
      }
      return [question.id, { answers: [] }]
    })
  )
  return { answers }
}

function contentFromMcpResult(item: McpToolCallItem): unknown {
  if (item.error?.message) {
    return { error: item.error.message }
  }
  return item.result?.structuredContent ?? item.result?.content ?? null
}

function normalizeCodexTokenUsage(
  notification: ThreadTokenUsageUpdatedNotification,
): ContextWindowUsageSnapshot | null {
  const usage = notification.tokenUsage
  const totalUsage = usage.total_token_usage ?? usage.total
  const lastUsage = usage.last_token_usage ?? usage.last

  const totalProcessedTokens = asNumber(totalUsage?.total_tokens) ?? asNumber(totalUsage?.totalTokens)
  const usedTokens = asNumber(lastUsage?.total_tokens) ?? asNumber(lastUsage?.totalTokens) ?? totalProcessedTokens
  if (usedTokens === undefined || usedTokens <= 0) {
    return null
  }

  const inputTokens = asNumber(lastUsage?.input_tokens) ?? asNumber(lastUsage?.inputTokens)
  const cachedInputTokens = asNumber(lastUsage?.cached_input_tokens) ?? asNumber(lastUsage?.cachedInputTokens)
  const outputTokens = asNumber(lastUsage?.output_tokens) ?? asNumber(lastUsage?.outputTokens)
  const reasoningOutputTokens =
    asNumber(lastUsage?.reasoning_output_tokens) ?? asNumber(lastUsage?.reasoningOutputTokens)
  const maxTokens = asNumber(usage.model_context_window) ?? asNumber(usage.modelContextWindow)

  return {
    usedTokens,
    ...(totalProcessedTokens !== undefined && totalProcessedTokens > usedTokens ? { totalProcessedTokens } : {}),
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(reasoningOutputTokens !== undefined ? { reasoningOutputTokens } : {}),
    ...(inputTokens !== undefined ? { lastInputTokens: inputTokens } : {}),
    ...(cachedInputTokens !== undefined ? { lastCachedInputTokens: cachedInputTokens } : {}),
    ...(outputTokens !== undefined ? { lastOutputTokens: outputTokens } : {}),
    ...(reasoningOutputTokens !== undefined ? { lastReasoningOutputTokens: reasoningOutputTokens } : {}),
    lastUsedTokens: usedTokens,
    compactsAutomatically: true,
  }
}

function todoStatus(status: TurnPlanStep["status"]): TodoItem["status"] {
  if (status === "completed") return "completed"
  if (status === "inProgress") return "in_progress"
  return "pending"
}

function planStepsToTodos(steps: TurnPlanStep[]): TodoItem[] {
  return steps.map((step) => ({
    content: step.step,
    status: todoStatus(step.status),
    activeForm: step.step,
  }))
}

function renderPlanMarkdownFromSteps(steps: TurnPlanStep[]): string {
  return steps.map((step) => {
    const checkbox = step.status === "completed" ? "[x]" : "[ ]"
    return `- ${checkbox} ${step.step}`
  }).join("\n")
}

function dynamicContentToText(contentItems: DynamicToolCallOutputContentItem[] | null | undefined): string {
  if (!contentItems?.length) return ""
  return contentItems
    .map((item) => item.type === "inputText" ? item.text ?? "" : item.imageUrl ?? "")
    .filter(Boolean)
    .join("\n")
}

function dynamicToolPayload(value: Record<string, unknown> | unknown[] | string | number | boolean | null | undefined): Record<string, unknown> {
  const record = asRecord(value)
  if (record) return record
  return { value }
}

function webSearchQuery(item: Extract<ThreadItem, { type: "webSearch" }>): string {
  return item.query || item.action?.query || item.action?.queries?.find((query) => typeof query === "string") || ""
}

function genericDynamicToolCall(toolId: string, toolName: string, input: Record<string, unknown>): TranscriptEntry {
  return timestamped({
    kind: "tool_call",
    tool: {
      kind: "tool",
      toolKind: "unknown_tool",
      toolName,
      toolId,
      input: {
        payload: input,
      },
      rawInput: input,
    },
  })
}

function collabToolCall(item: CollabAgentToolCallItem): TranscriptEntry {
  return timestamped({
    kind: "tool_call",
    tool: {
      kind: "tool",
      toolKind: "subagent_task",
      toolName: "Task",
      toolId: item.id,
      input: {
        subagentType: item.tool,
        ...(typeof item.prompt === "string" ? { prompt: item.prompt } : {}),
      },
      rawInput: item as unknown as Record<string, unknown>,
    },
  })
}

function todoToolCall(toolId: string, steps: TurnPlanStep[]): TranscriptEntry {
  return timestamped({
    kind: "tool_call",
    tool: {
      kind: "tool",
      toolKind: "todo_write",
      toolName: "TodoWrite",
      toolId,
      input: {
        todos: planStepsToTodos(steps),
      },
      rawInput: {
        plan: steps,
      },
    },
  })
}

function fileChangeKind(
  kind: "add" | "delete" | "update" | { type: "add" | "delete" | "update"; move_path?: string | null }
): { type: "add" | "delete" | "update"; movePath?: string | null } {
  if (typeof kind === "string") {
    return { type: kind }
  }
  return {
    type: kind.type,
    movePath: kind.move_path ?? null,
  }
}

function fileChangeToolId(itemId: string, index: number, totalChanges: number): string {
  if (totalChanges === 1) {
    return itemId
  }
  return `${itemId}:change:${index}`
}

function fileChangePayload(
  item: Extract<ThreadItem, { type: "fileChange" }>,
  change: Extract<ThreadItem, { type: "fileChange" }>["changes"][number]
): Record<string, unknown> {
  return {
    ...item,
    changes: [change],
  } as unknown as Record<string, unknown>
}

function parseUnifiedDiff(diff: string): { oldString: string; newString: string } {
  const oldLines: string[] = []
  const newLines: string[] = []

  for (const line of diff.split(/\r?\n/)) {
    if (!line) continue
    if (line.startsWith("@@") || line.startsWith("---") || line.startsWith("+++")) continue
    if (line === "\\ No newline at end of file") continue

    const prefix = line[0]
    const content = line.slice(1)

    if (prefix === " ") {
      oldLines.push(content)
      newLines.push(content)
      continue
    }
    if (prefix === "-") {
      oldLines.push(content)
      continue
    }
    if (prefix === "+") {
      newLines.push(content)
    }
  }

  return {
    oldString: oldLines.join("\n"),
    newString: newLines.join("\n"),
  }
}

function isUnifiedDiff(diff: string) {
  return diff.includes("@@")
    || diff.startsWith("---")
    || diff.startsWith("+++")
    || diff.split(/\r?\n/).some((line) => (
      line.startsWith("+")
      || line.startsWith("-")
      || line.startsWith(" ")
      || line === "\\ No newline at end of file"
    ))
}

function fileChangeToToolCalls(item: Extract<ThreadItem, { type: "fileChange" }>): TranscriptEntry[] {
  return item.changes.map((change, index) => {
    const payload = fileChangePayload(item, change)
    const toolId = fileChangeToolId(item.id, index, item.changes.length)
    const normalizedKind = fileChangeKind(change.kind)

    if (normalizedKind.movePath) {
      return timestamped({
        kind: "tool_call",
        tool: {
          kind: "tool",
          toolKind: "unknown_tool",
          toolName: "FileChange",
          toolId,
          input: {
            payload,
          },
          rawInput: payload,
        },
      })
    }

    if (typeof change.diff === "string") {
      const diffIsUnified = isUnifiedDiff(change.diff)
      const { oldString, newString } = diffIsUnified
        ? parseUnifiedDiff(change.diff)
        : { oldString: change.diff, newString: change.diff }

      if (normalizedKind.type === "add") {
        return timestamped({
          kind: "tool_call",
          tool: {
            kind: "tool",
            toolKind: "write_file",
            toolName: "Write",
            toolId,
            input: {
              filePath: change.path,
              content: newString,
            },
            rawInput: payload,
          },
        })
      }

      if (normalizedKind.type === "update") {
        if (!diffIsUnified) {
          return timestamped({
            kind: "tool_call",
            tool: {
              kind: "tool",
              toolKind: "unknown_tool",
              toolName: "FileChange",
              toolId,
              input: {
                payload,
              },
              rawInput: payload,
            },
          })
        }

        return timestamped({
          kind: "tool_call",
          tool: {
            kind: "tool",
            toolKind: "edit_file",
            toolName: "Edit",
            toolId,
            input: {
              filePath: change.path,
              oldString,
              newString,
            },
            rawInput: payload,
          },
        })
      }

      if (normalizedKind.type === "delete") {
        return timestamped({
          kind: "tool_call",
          tool: {
            kind: "tool",
            toolKind: "delete_file",
            toolName: "Delete",
            toolId,
            input: {
              filePath: change.path,
              content: oldString,
            },
            rawInput: payload,
          },
        })
      }
    }

    return timestamped({
      kind: "tool_call",
      tool: {
        kind: "tool",
        toolKind: "unknown_tool",
        toolName: "FileChange",
        toolId,
        input: {
          payload,
        },
        rawInput: payload,
      },
    })
  })
}

function fileChangeToToolResults(item: Extract<ThreadItem, { type: "fileChange" }>): TranscriptEntry[] {
  return item.changes.map((change, index) => timestamped({
    kind: "tool_result",
    toolId: fileChangeToolId(item.id, index, item.changes.length),
    content: fileChangePayload(item, change),
    isError: item.status === "failed" || item.status === "declined",
  }))
}

function itemToToolCalls(item: ThreadItem): TranscriptEntry[] {
  switch (item.type) {
    case "dynamicToolCall":
      return [genericDynamicToolCall(item.id, item.tool, dynamicToolPayload(item.arguments))]
    case "collabAgentToolCall":
      return [collabToolCall(item)]
    case "commandExecution":
      return [timestamped({
        kind: "tool_call",
        tool: {
          kind: "tool",
          toolKind: "bash",
          toolName: "Bash",
          toolId: item.id,
          input: {
            command: item.command,
          },
          rawInput: item,
        },
      })]
    case "webSearch":
      return [timestamped({
        kind: "tool_call",
        tool: {
          kind: "tool",
          toolKind: "web_search",
          toolName: "WebSearch",
          toolId: item.id,
          input: {
            query: webSearchQuery(item),
          },
          rawInput: item,
        },
      })]
    case "mcpToolCall":
      return [timestamped({
        kind: "tool_call",
        tool: {
          kind: "tool",
          toolKind: "mcp_generic",
          toolName: `mcp__${item.server}__${item.tool}`,
          toolId: item.id,
          input: {
            server: item.server,
            tool: item.tool,
            payload: item.arguments ?? {},
          },
          rawInput: item.arguments ?? {},
        },
      })]
    case "fileChange":
      return fileChangeToToolCalls(item)
    case "plan":
      return []
    case "error":
      return [timestamped({
        kind: "tool_call",
        tool: {
          kind: "tool",
          toolKind: "unknown_tool",
          toolName: "Error",
          toolId: item.id,
          input: {
            payload: item as unknown as Record<string, unknown>,
          },
          rawInput: item as unknown as Record<string, unknown>,
        },
      })]
    default:
      return []
  }
}

function itemToToolResults(item: ThreadItem): TranscriptEntry[] {
  switch (item.type) {
    case "dynamicToolCall":
      return [timestamped({
        kind: "tool_result",
        toolId: item.id,
        content: dynamicContentToText(item.contentItems) || item,
        isError: item.status === "failed" || item.success === false,
      })]
    case "collabAgentToolCall":
      return [timestamped({
        kind: "tool_result",
        toolId: item.id,
        content: item,
        isError: item.status === "failed",
      })]
    case "commandExecution":
      return [timestamped({
        kind: "tool_result",
        toolId: item.id,
        content: item.aggregatedOutput ?? item,
        isError: (typeof item.exitCode === "number" && item.exitCode !== 0) || item.status === "failed" || item.status === "declined",
      })]
    case "webSearch":
      return [timestamped({
        kind: "tool_result",
        toolId: item.id,
        content: item,
      })]
    case "mcpToolCall":
      return [timestamped({
        kind: "tool_result",
        toolId: item.id,
        content: contentFromMcpResult(item),
        isError: item.status === "failed",
      })]
    case "fileChange":
      return fileChangeToToolResults(item)
    case "plan":
      return []
    case "error":
      return [timestamped({
        kind: "tool_result",
        toolId: item.id,
        content: item.message,
        isError: true,
      })]
    default:
      return []
  }
}

export class CodexAppServerManager {
  private readonly sessions = new Map<string, SessionContext>()
  private readonly sessionStarts = new Map<
    string,
    Promise<{ sessionToken: string; resumeFellBack: boolean; startupOutcome: HarnessStartupOutcome }>
  >()
  private readonly spawnProcess: SpawnCodexAppServer
  private onRateLimits: ((snapshot: CodexRateLimitSnapshot) => void) | null = null

  constructor(args: { spawnProcess?: SpawnCodexAppServer } = {}) {
    this.spawnProcess = args.spawnProcess ?? ((cwd) =>
      spawn("codex", ["app-server"], {
        cwd,
        stdio: ["pipe", "pipe", "pipe"],
        env: process.env,
      }) as unknown as CodexAppServerProcess)
  }

  /** Register a sink for pushed `account/rateLimits/updated` notifications. */
  setRateLimitsListener(listener: ((snapshot: CodexRateLimitSnapshot) => void) | null) {
    this.onRateLimits = listener
  }

  /**
   * Read account rate limits on demand. Reuses a live session's app-server
   * process when one exists; otherwise spawns a short-lived probe process and
   * tears it down. Returns null only when Codex is unusable (binary missing).
   * Throws on protocol errors (e.g. API-key auth → "chatgpt auth required").
   */
  async readAccountRateLimits(probeCwd: string): Promise<GetAccountRateLimitsResponse | null> {
    for (const context of this.sessions.values()) {
      if (context.closed) continue
      return await this.sendRequest<GetAccountRateLimitsResponse>(
        context,
        "account/rateLimits/read",
        {},
      )
    }
    return await this.probeAccountRateLimits(probeCwd)
  }

  private async probeAccountRateLimits(cwd: string): Promise<GetAccountRateLimitsResponse | null> {
    return await this.withProbe(cwd, (context) =>
      this.sendRequest<GetAccountRateLimitsResponse>(context, "account/rateLimits/read", {}))
  }

  
  async listModels(probeCwd: string): Promise<CodexModelSummary[] | null> {
    for (const context of this.sessions.values()) {
      if (context.closed) continue
      return await this.requestModelList(context)
    }
    return await this.withProbe(probeCwd, (context) => this.requestModelList(context))
  }

  private async requestModelList(context: SessionContext): Promise<CodexModelSummary[]> {
    const models: CodexModelSummary[] = []
    let cursor: string | null | undefined
    do {
      const response = await this.sendRequest<ModelListResponse>(
        context,
        "model/list",
        (cursor ? { cursor } : {}) satisfies ModelListParams,
      )
      models.push(...(response.data ?? []).filter((model) => !model.hidden))
      cursor = response.nextCursor
    } while (cursor)
    return models
  }

  /**
   * Run one request against a throwaway app-server process: spawn,
   * handshake, `run`, then kill. Account-level reads (rate limits, the model
   * list) use this when no chat has a live process to piggyback on.
   */
  private async withProbe<T>(cwd: string, run: (context: SessionContext) => Promise<T>): Promise<T | null> {
    let child: CodexAppServerProcess
    try {
      child = this.spawnProcess(cwd)
    } catch {
      return null
    }
    const context: SessionContext = {
      chatId: `probe-${randomUUID()}`,
      cwd,
      child,
      pendingRequests: new Map(),
      pendingTurn: null,
      sessionToken: null,
      stderrLines: [],
      closed: false,
    }
    this.attachListeners(context)
    try {
      await this.sendRequest(context, "initialize", {
        clientInfo: { name: "kanna_desktop", title: "Kanna", version: "0.1.0" },
        capabilities: { experimentalApi: true },
      } satisfies InitializeParams)
      this.writeMessage(context, { method: "initialized" })
      return await run(context)
    } finally {
      context.closed = true
      try {
        child.kill("SIGKILL")
      } catch {
        // ignore
      }
    }
  }

  /** Read full native user history for an explicit history action, never for ordinary send. */
  async readPromptHistory(args: {
    cwd: string
    threadId: string
  }): Promise<{ inputs: CodexNativeInput[]; path?: string; historyMode?: "paginated" }> {
    return this.withUtilityContext(args.cwd, (context) =>
      this.readPromptHistoryInContext(context, args.threadId),
    )
  }

  private async readPromptHistoryInContext(
    context: SessionContext,
    threadId: string,
  ) {
    const response = await this.sendRequest<{
      thread: NativePromptHistoryThread
    }>(context, "thread/read", { threadId, includeTurns: true })
    const thread = response.thread
    if (thread?.id !== threadId)
      throw new Error("Codex returned a different thread history")
    const inputs: CodexNativeInput[] = []
    const historyTurns: Array<{ id: string; items: unknown[] }> = []
    const orderedItems: Array<{ turnId: string; item: unknown; startedAtMs?: number }> = []
    const completedAtUpperBounds = new Map<string, number>()
    const addItems = (
      turnId: string,
      items: Array<{
        type: string
        clientId?: string
        content?: Array<{ type: string; text?: string }>
      }>,
    ) => {
      historyTurns.push({
        id: turnId,
        items: items.map((item) => {
          const { id: _id, ...content } = item as typeof item & { id?: string }
          return content
        }),
      })
      let userIndex = 0
      for (const item of items) {
        if (item.type !== "userMessage") continue
        if (!Array.isArray(item.content))
          throw new Error("Incomplete Codex user history")
        inputs.push({
          turnId,
          userIndex: userIndex++,
          text: item.content
            .filter((block) => block.type === "text")
            .map((block) => block.text ?? "")
            .join("\n"),
          ...(item.clientId ? { promptId: item.clientId } : {}),
        })
      }
    }
    const validateTurn = (turn: { id: string; status: string; completedAt?: number | null }) => {
      if (
        !turn.id ||
        !["completed", "failed", "interrupted"].includes(turn.status)
      )
        throw new Error(
          "Cannot read stable Codex history while a turn is running or invalid",
        )
      // Turn timestamps have second precision; item timestamps have millisecond
      // precision. Only the next whole second proves an item was created later.
      if (typeof turn.completedAt === "number" && turn.completedAt >= 0 &&
        Number.isSafeInteger(turn.completedAt) && Number.isSafeInteger((turn.completedAt + 1) * 1000))
        completedAtUpperBounds.set(turn.id, (turn.completedAt + 1) * 1000)
    }
    if (thread.historyMode !== "paginated") {
      if (!Array.isArray(thread.turns))
        throw new Error("Incomplete Codex thread history")
      const seen = new Set<string>()
      for (const turn of thread.turns) {
        validateTurn(turn)
        if (seen.has(turn.id) || !Array.isArray(turn.items))
          throw new Error("Invalid Codex turn history")
        seen.add(turn.id)
        addItems(turn.id, turn.items)
      }
    } else {
      const turns: Array<{ id: string; status: string; completedAt?: number | null }> = []
      const seen = new Set<string>()
      const cursors = new Set<string>()
      let cursor: string | undefined
      do {
        const page = await this.sendRequest<{
          data: Array<{ id: string; status: string; completedAt?: number | null }>
          nextCursor?: string | null
        }>(context, "thread/turns/list", {
          threadId,
          cursor,
          limit: 100,
          sortDirection: "asc",
          itemsView: "summary",
        })
        if (!Array.isArray(page.data))
          throw new Error("Incomplete Codex turn page")
        for (const turn of page.data) {
          validateTurn(turn)
          if (seen.has(turn.id)) throw new Error("Repeated Codex turn history")
          seen.add(turn.id)
          turns.push(turn)
        }
        cursor = page.nextCursor ?? undefined
        if (cursor) {
          if (cursors.has(cursor) || !page.data.length)
            throw new Error("Repeated or empty Codex turn page")
          cursors.add(cursor)
        }
      } while (cursor)
      // Page across the thread to retain persistence order. A background result
      // can belong to an earlier turn while being first recorded in a later one.
      type Item = {
        type: string
        clientId?: string
        content?: Array<{ type: string; text?: string }>
      }
      const byTurn = new Map(turns.map((turn) => [turn.id, [] as Item[]]))
      const itemCursors = new Set<string>()
      type ItemPage = {
        data: Array<{ turnId: string; item: Item; startedAtMs?: number | null }>
        nextCursor?: string | null
      }
      cursor = undefined
      do {
        const page: ItemPage = await this.sendRequest<ItemPage>(context, "thread/items/list", {
          threadId,
          cursor,
          limit: 100,
          sortDirection: "asc",
        })
        if (
          !Array.isArray(page.data) ||
          page.data.some((entry) => !byTurn.has(entry.turnId) || !entry.item)
        )
          throw new Error("Incomplete Codex item page")
        for (const entry of page.data) {
          byTurn.get(entry.turnId)!.push(entry.item)
          const { id: _id, ...item } = entry.item as Item & { id?: string }
          orderedItems.push({ turnId: entry.turnId, item,
            ...(typeof entry.startedAtMs === "number" && entry.startedAtMs >= 0 && Number.isSafeInteger(entry.startedAtMs)
              ? { startedAtMs: entry.startedAtMs } : {}),
          })
        }
        cursor = page.nextCursor ?? undefined
        if (cursor) {
          if (itemCursors.has(cursor) || !page.data.length)
            throw new Error("Repeated or empty Codex item page")
          itemCursors.add(cursor)
        }
      } while (cursor)
      for (const turn of turns) addItems(turn.id, byTurn.get(turn.id)!)
    }
    return {
      inputs,
      turns: historyTurns,
      completedAtUpperBounds,
      ...(thread.historyMode === "paginated" ? { historyMode: "paginated" as const, orderedItems } : {}),
      ...(typeof thread.path === "string" ? { path: thread.path } : {}),
    }
  }

  /** Prepare an isolated replacement at a saved canonical turn boundary. */
  async forkBeforeTurn(args: {
    cwd: string
    threadId: string
    beforeTurnId: string
    model: string
    serviceTier?: ServiceTier
  }) {
    return this.forkAtTurnBoundary(args)
  }

  async forkAfterTurn(args: {
    cwd: string
    threadId: string
    afterTurnId: string
    model: string
    serviceTier?: ServiceTier
  }) {
    return this.forkAtTurnBoundary(args)
  }

  private async forkAtTurnBoundary(args: {
    cwd: string
    threadId: string
    beforeTurnId?: string
    afterTurnId?: string
    model: string
    serviceTier?: ServiceTier
  }) {
    return this.withUtilityContext(args.cwd, async (context) => {
      const boundary: Pick<ThreadForkParams, "beforeTurnId" | "lastTurnId"> =
        args.afterTurnId ? { lastTurnId: args.afterTurnId } : { beforeTurnId: args.beforeTurnId }
      // Codex validates and applies the saved turn boundary. Loading both
      // histories here would defeat the purpose of durable prompt bindings.
      const response = await this.sendRequest<ThreadForkResponse>(context, "thread/fork", {
        threadId: args.threadId, ...boundary, includeTurns: false,
        model: args.model, cwd: args.cwd, serviceTier: args.serviceTier,
        approvalPolicy: CODEX_APPROVAL_POLICY, sandbox: "danger-full-access",
        persistExtendedHistory: true,
      } satisfies ThreadForkParams)
      const threadId = response.thread?.id
      if (!threadId || threadId === args.threadId)
        throw new Error("Codex did not return an isolated forked session")
      return threadId
    })
  }

  async rollbackThread(args: { chatId?: string; cwd: string; threadId: string; numTurns: number }): Promise<Thread> {
    if (!Number.isSafeInteger(args.numTurns) || args.numTurns < 1) {
      throw new Error("Codex history rollback requires a positive integer number of turns")
    }
    const activeContext = args.chatId ? this.sessions.get(args.chatId) : null
    if (activeContext && !activeContext.closed && activeContext.cwd === args.cwd && activeContext.sessionToken === args.threadId) {
      if (activeContext.pendingTurn) {
        throw new Error("Cannot rollback Codex thread while a turn is running")
      }
      return await this.rollbackThreadInContext(activeContext, args.threadId, args.numTurns)
    }

    return await this.withUtilityContext(args.cwd, async (context) => {
      await this.sendRequest<ThreadResumeResponse>(context, "thread/resume", {
        threadId: args.threadId,
        cwd: args.cwd,
        approvalPolicy: "never",
        sandbox: "danger-full-access",
        persistExtendedHistory: true,
      } satisfies ThreadResumeParams)
      return await this.rollbackThreadInContext(context, args.threadId, args.numTurns)
    })
  }

  private async rollbackThreadInContext(context: SessionContext, threadId: string, numTurns: number): Promise<Thread> {
    try {
      const beforeTurnId = await this.findRevertBoundary(context, threadId, numTurns)
      if (context.pendingTurn) {
        throw new Error("Cannot rollback Codex thread while a turn is running")
      }
      const response = await this.sendRequest<ThreadRevertResponse>(context, "thread/revert", {
        threadId,
        beforeTurnId,
      } satisfies ThreadRevertParams)
      return response.thread
    } catch (error) {
      // Only an explicit unsupported method permits a legacy fallback. An
      // ordinary revert failure may have already changed the durable history.
      const unsupported = error instanceof CodexRequestError
        && (error.method === "thread/turns/list" || error.method === "thread/revert")
        && (error.code === -32601 || (error.code === -32600
          && error.message.includes(`unknown variant \`${error.method}\``)))
      if (!unsupported) throw error
    }
    if (context.pendingTurn) {
      throw new Error("Cannot rollback Codex thread while a turn is running")
    }
    const response = await this.sendRequest<ThreadRollbackResponse>(context, "thread/rollback", {
      threadId,
      numTurns,
    } satisfies ThreadRollbackParams)
    return response.thread
  }

  private async findRevertBoundary(context: SessionContext, threadId: string, numTurns: number) {
    // New Codex versions use an exclusive turn-id boundary instead of a count.
    // Kanna counts user prompts, but native history also contains standalone
    // compaction/service turns. Summary includes the first user item without
    // loading tool payloads; only user-bearing turns advance the prompt count.
    // Refuse ambiguous history instead of guessing a destructive boundary.
    const turnIds = new Set<string>()
    const cursors = new Set<string>()
    let userTurnCount = 0
    let cursor: string | undefined
    let beforeTurnId: string | undefined
    while (!beforeTurnId) {
      const page = await this.sendRequest<ThreadTurnsListResponse>(context, "thread/turns/list", {
        threadId,
        ...(cursor === undefined ? {} : { cursor }),
        limit: Math.min(100, numTurns - userTurnCount),
        sortDirection: "desc",
        itemsView: "summary",
      } satisfies ThreadTurnsListParams)
      if (!Array.isArray(page?.data) || page.data.length === 0) {
        throw new Error("Cannot determine Codex rollback boundary: missing turn history")
      }
      for (const turn of page.data) {
        if (typeof turn?.id !== "string" || !turn.id.trim() || turnIds.has(turn.id)) {
          throw new Error("Cannot determine Codex rollback boundary: invalid or duplicate turn ID")
        }
        if (turn.status === "inProgress") {
          throw new Error("Cannot rollback Codex thread while a turn is running")
        }
        if (turn.status !== "completed" && turn.status !== "interrupted" && turn.status !== "failed") {
          throw new Error("Cannot determine Codex rollback boundary: invalid turn status")
        }
        if ((turn.itemsView !== undefined && turn.itemsView !== "summary" && turn.itemsView !== "full")
          || !Array.isArray(turn.items)
          || turn.items.some((item) => typeof item?.type !== "string" || !item.type)) {
          throw new Error("Cannot determine Codex rollback boundary: missing turn items")
        }
        turnIds.add(turn.id)
        if (turn.items.some((item) => item.type === "userMessage")) userTurnCount += 1
        if (userTurnCount === numTurns) {
          beforeTurnId = turn.id
          break
        }
      }
      if (beforeTurnId) break
      if (typeof page.nextCursor !== "string" || !page.nextCursor || cursors.has(page.nextCursor)) {
        throw new Error("Cannot determine Codex rollback boundary: incomplete or repeated history page")
      }
      cursor = page.nextCursor
      cursors.add(cursor)
    }
    return beforeTurnId
  }

  async startSession(args: StartCodexSessionArgs) {
    args.signal?.throwIfAborted()
    const existing = this.sessions.get(args.chatId)
    if (existing && !existing.closed && existing.cwd === args.cwd && !args.pendingForkSessionToken
      && (!existing.sessionToken || !args.sessionToken || existing.sessionToken === args.sessionToken)) {
      if (existing.sessionToken) {
        return { sessionToken: existing.sessionToken, resumeFellBack: false, startupOutcome: { kind: "reused" as const } }
      }
      const sessionStart = this.sessionStarts.get(args.chatId)
      if (sessionStart) {
        return await sessionStart
      }
      this.stopSession(args.chatId)
    } else if (existing) {
      this.stopSession(args.chatId)
    }

    const child = this.spawnProcess(args.cwd)
    const customTools = args.customTools ? createKannaMcpServer(args.customTools) : undefined
    const context: SessionContext = {
      customTools,
      chatId: args.chatId,
      cwd: args.cwd,
      child,
      pendingRequests: new Map(),
      pendingTurn: null,
      sessionToken: null,
      stderrLines: [],
      closed: false,
    }
    this.sessions.set(args.chatId, context)
    this.attachListeners(context)

    const assertCurrent = () => {
      if (context.closed || this.sessions.get(args.chatId) !== context || (args.isCurrentTurn && !args.isCurrentTurn())) {
        throw new Error("Codex startup was cancelled or replaced")
      }
    }
    const onStartupAbort = () => {
      if (this.sessions.get(args.chatId) === context) this.stopSession(args.chatId)
    }
    args.signal?.addEventListener("abort", onStartupAbort, { once: true })
    if (args.signal?.aborted) onStartupAbort()
    const sessionStart = (async () => {
      try {
      await this.sendRequest(context, "initialize", {
        clientInfo: {
          name: "kanna_desktop",
          title: "Kanna",
          version: "0.1.0",
        },
        capabilities: {
          experimentalApi: true,
        },
      } satisfies InitializeParams)
      assertCurrent()
      this.writeMessage(context, {
          method: "initialized",
        })

      // Resume and fork accept MCP config, but this CLI only accepts dynamic tools on thread/start.
      const toolConfig = customTools ? {
        config: {
          "mcp_servers.kanna": {
            url: customTools.url,
            http_headers: customTools.headers,
            tool_timeout_sec: 86400,
          },
        },
      } : {}
      const threadParams = {
        model: args.model,
        cwd: args.cwd,
        serviceTier: args.serviceTier,
        approvalPolicy: "never",
        sandbox: "danger-full-access",
        experimentalRawEvents: false,
        persistExtendedHistory: true,
        ...toolConfig,
      } satisfies ThreadStartParams

      let response: ThreadStartResponse | ThreadResumeResponse | ThreadForkResponse
      // Set when a requested resume failed recoverably and we started a fresh
      // thread instead — the caller surfaces this as a "Conversation Restored"
      // boundary so the silent context loss becomes visible.
      let resumeFellBack = false
      if (args.pendingForkSessionToken) {
        response = await this.sendRequest<ThreadForkResponse>(context, "thread/fork", {
          threadId: args.pendingForkSessionToken,
          model: args.model,
          cwd: args.cwd,
          serviceTier: args.serviceTier,
          approvalPolicy: "never",
          sandbox: "danger-full-access",
          persistExtendedHistory: true,
          ...toolConfig,
        } satisfies ThreadForkParams)
      } else if (args.sessionToken) {
        try {
          response = await this.sendRequest<ThreadResumeResponse>(context, "thread/resume", {
            threadId: args.sessionToken,
            model: args.model,
            cwd: args.cwd,
            serviceTier: args.serviceTier,
            approvalPolicy: "never",
            sandbox: "danger-full-access",
            persistExtendedHistory: true,
            ...toolConfig,
          } satisfies ThreadResumeParams)
        } catch (error) {
          if (!isRecoverableResumeError(error)) {
            if (this.sessions.get(args.chatId) === context) this.stopSession(args.chatId)
            throw error
          }
          assertCurrent()
          response = await this.sendRequest<ThreadStartResponse>(context, "thread/start", threadParams)
          resumeFellBack = true
        }
      } else {
        response = await this.sendRequest<ThreadStartResponse>(context, "thread/start", threadParams)
      }

      assertCurrent()
      context.sessionToken = response.thread.id
      return { sessionToken: context.sessionToken, resumeFellBack, startupOutcome: {
          kind: args.pendingForkSessionToken ? "forked" as const : resumeFellBack || !args.sessionToken ? "fresh" as const : "resumed" as const,
        } }
      } catch (error) {
        if (this.sessions.get(args.chatId) === context) this.stopSession(args.chatId)
        throw error
      }
    })()
    this.sessionStarts.set(args.chatId, sessionStart)
    try { return await sessionStart } finally {
      args.signal?.removeEventListener("abort", onStartupAbort)
      if (this.sessionStarts.get(args.chatId) === sessionStart) {
        this.sessionStarts.delete(args.chatId)
      }
    }
  }

  async startTurn(args: StartCodexTurnArgs): Promise<HarnessTurn> {
    const context = this.requireSession(args.chatId)
    const assertOwner = () => {
      if (args.signal?.aborted || (args.isCurrentTurn && !args.isCurrentTurn())) {
        throw new Error("Codex turn startup was cancelled or replaced")
      }
    }
    const assertCurrent = () => {
      assertOwner()
      if (context.closed || this.sessions.get(args.chatId) !== context) {
        throw new Error("Codex turn startup was cancelled or replaced")
      }
    }
    assertCurrent()
    if (context.pendingTurn) {
      throw new Error("Codex turn is already running")
    }

    const queue = new AsyncQueue<HarnessEvent>()
    if (context.sessionToken) {
      queue.push({ type: "session_token", sessionToken: context.sessionToken })
    }
    queue.push({ type: "transcript", entry: codexSystemInitEntry(args.model) })

    const pendingTurn: PendingTurn = {
      turnId: null,
      model: args.model,
      planMode: args.planMode,
      queue,
      startedToolIds: new Set(),
      handledDynamicToolIds: new Set(),
      latestPlanExplanation: null,
      latestPlanSteps: [],
      latestPlanText: null,
      planTextByItemId: new Map(),
      todoSequence: 0,
      pendingWebSearchResultToolId: null,
      retryCause: null,
      pendingSteeredEntries: new Map(),
      resolved: false,
      onToolRequest: args.onToolRequest,
      onApprovalRequest: args.onApprovalRequest,
    }
    context.pendingTurn = pendingTurn
    const onStartupAbort = () => {
      if (this.sessions.get(args.chatId) === context && context.pendingTurn === pendingTurn) {
        this.stopSession(args.chatId)
      }
    }
    args.signal?.addEventListener("abort", onStartupAbort, { once: true })

    try {
      assertCurrent()
      const input: CodexUserInput[] = [
        {
          type: "text",
          text: args.skills?.length
            ? appendSystemMessageBlock(args.content, buildSkillSystemMessage(args.skills))
            : args.content,
          text_elements: [],
        },
      ]
      for (const skill of args.skills ?? []) {
        input.push({ type: "skill", name: skill.name, path: skill.path })
      }
      const response = await this.sendRequest<TurnStartResponse>(context, "turn/start", {
        threadId: context.sessionToken ?? "",
        clientUserMessageId: args.clientUserMessageId,
        input,
        approvalPolicy: "never",
        model: args.model,
        effort: args.effort,
        serviceTier: args.serviceTier,
        collaborationMode: {
          mode: args.planMode ? "plan" : "default",
          settings: {
            model: args.model,
            reasoning_effort: args.effort ?? null,
            // Codex's instruction channel is per-turn, not per-session: this is
            // re-sent every turn by design. It appends to the built-in
            // developer message rather than replacing it.
            developer_instructions: buildKannaSystemInstructions(buildKannaAgentId("codex", args.model)),
          },
        },
      } satisfies TurnStartParams)
      // A native error can close context immediately after ACK; keep its
      // queued result observable when this caller still owns the turn.
      assertOwner()
      pendingTurn.turnId = response.turn.id
    } catch (error) {
      if (context.pendingTurn === pendingTurn) context.pendingTurn = null
      queue.finish()
      throw error
    } finally {
      args.signal?.removeEventListener("abort", onStartupAbort)
    }

    return {
      provider: "codex",
      providerTurnId: pendingTurn.turnId ?? undefined,
      stream: queue,
      interrupt: async () => {
        if (context.pendingTurn !== pendingTurn) return

        context.pendingTurn = null
        pendingTurn.resolved = true
        this.failPendingSteers(pendingTurn, "Codex turn was interrupted", { includeEchoed: true })
        pendingTurn.queue.finish()

        if (!pendingTurn.turnId || !context.sessionToken) return

        await this.sendRequest(context, "turn/interrupt", {
          threadId: context.sessionToken,
          turnId: pendingTurn.turnId,
        } satisfies TurnInterruptParams)
      },
      close: () => {},
    }
  }

  /**
   * Enumerate agent skills via `skills/list` on the chat's live app-server
   * process. Returns null when there is no running process for the chat or the
   * codex binary predates skills/list (< 0.73, "method not found") — callers
   * fall back to Kanna's filesystem scan of the same discovery roots.
   */
  async listSkills(args: { chatId: string; cwd: string }): Promise<CodexSkillMetadata[] | null> {
    const context = this.sessions.get(args.chatId)
    if (!context || context.closed) return null
    try {
      const response = await this.sendRequest<SkillsListResponse>(context, "skills/list", {
        cwds: [args.cwd],
      } satisfies SkillsListParams)
      const skills = (response.data ?? []).flatMap((entry) => entry.skills ?? [])
      // Disabled skills fail structured resolution server-side (silently), so
      // they never belong in the invocation menu.
      return skills.filter((skill) => skill.enabled)
    } catch {
      return null
    }
  }

  startSteerTurn(args: SteerCodexTurnArgs): CodexSteerHandle {
    const context = this.requireSession(args.chatId)
    const pendingTurn = context.pendingTurn
    if (!pendingTurn || pendingTurn.resolved || !pendingTurn.turnId || !context.sessionToken) {
      throw new Error("Codex turn is not ready for steering")
    }
    if (pendingTurn.turnId !== args.expectedTurnId) {
      throw new Error("Codex turn changed before steering")
    }
    if (pendingTurn.pendingSteeredEntries.has(args.clientUserMessageId)) {
      throw new Error("Codex queued message is already being steered")
    }

    const expectedTurnId = args.expectedTurnId
    let resolvePersisted!: () => void
    let rejectPersisted!: (error: Error) => void
    const persisted = new Promise<void>((resolve, reject) => {
      resolvePersisted = resolve
      rejectPersisted = reject
    })
    // A turn notification can reject the record before the settlement consumer
    // attaches. Keep that short handoff window handled.
    void persisted.catch(() => undefined)
    const pendingEntry: PendingSteeredEntry = {
      entry: args.transcriptEntry,
      echoReceived: false,
      settled: false,
      persisted,
      resolvePersisted,
      rejectPersisted,
    }
    pendingTurn.pendingSteeredEntries.set(args.clientUserMessageId, pendingEntry)

    const accepted = this.sendRequest<TurnSteerResponse>(context, "turn/steer", {
      threadId: context.sessionToken,
      input: [{
        type: "text",
        text: args.selectedSkills?.length
          ? appendSystemMessageBlock(args.content, buildSkillSystemMessage(args.selectedSkills))
          : args.content,
        text_elements: [],
      }, ...(args.selectedSkills ?? []).map((skill) => ({
        type: "skill" as const,
        name: skill.name,
        path: skill.path,
      }))],
      expectedTurnId,
      clientUserMessageId: args.clientUserMessageId,
    } satisfies TurnSteerParams).then((response) => {
      if (response.turnId !== expectedTurnId) {
        throw new Error(`Codex steered unexpected turn ${response.turnId}`)
      }
    }).catch((error) => {
      const failure = error instanceof Error ? error : new Error(String(error))
      this.rejectPendingSteeredEntry(
        pendingTurn,
        args.clientUserMessageId,
        pendingEntry,
        failure,
      )
      throw error
    })
    void accepted.catch(() => undefined)

    const settled = Promise.all([accepted, pendingEntry.persisted]).then(() => {
      if (!pendingEntry.echoReceived || !pendingEntry.settled) {
        throw new Error("Codex turn ended before steering was acknowledged")
      }
    })
    // A turn notification may reject persistence before the caller attaches
    // its lifecycle handler. Keep that short handoff window handled.
    void settled.catch(() => undefined)
    return { accepted, settled }
  }

  async steerTurn(args: SteerCodexTurnArgs): Promise<void> {
    const steer = this.startSteerTurn(args)
    await steer.settled
  }

  async generateStructured(args: GenerateStructuredArgs): Promise<string | null> {
    const chatId = `quick-${randomUUID()}`
    let turn: HarnessTurn | null = null
    let assistantText = ""
    let resultText = ""

    try {
      await this.startSession({
        chatId,
        cwd: args.cwd,
        model: args.model ?? "gpt-5.5",
        serviceTier: args.serviceTier ?? "fast",
        sessionToken: null,
      })

      turn = await this.startTurn({
        chatId,
        model: args.model ?? "gpt-5.5",
        effort: args.effort,
        serviceTier: args.serviceTier ?? "fast",
        content: args.prompt,
        planMode: false,
        onToolRequest: async () => ({}),
      })

      for await (const event of turn.stream) {
        if (event.type !== "transcript" || !event.entry) continue
        if (event.entry.kind === "assistant_text") {
          assistantText += assistantText ? `\n${event.entry.text}` : event.entry.text
        }
        if (event.entry.kind === "result" && !event.entry.isError && event.entry.result.trim()) {
          resultText = event.entry.result
        }
      }

      const candidate = assistantText.trim() || resultText.trim()
      return candidate || null
    } finally {
      turn?.close()
      this.stopSession(chatId)
    }
  }

  stopSession(chatId: string) {
    const context = this.sessions.get(chatId)
    if (!context) return
    this.failContext(context, "Codex session closed")
    context.pendingTurn?.queue.finish()
    this.sessions.delete(chatId)
    try {
      context.child.kill("SIGKILL")
    } catch {
      // ignore kill failures
    }
  }

  stopAll() {
    for (const chatId of this.sessions.keys()) {
      this.stopSession(chatId)
    }
  }

  private async withUtilityContext<TResult>(cwd: string, callback: (context: SessionContext) => Promise<TResult>) {
    const child = this.spawnProcess(cwd)
    const context: SessionContext = {
      chatId: `utility-${randomUUID()}`,
      cwd,
      child,
      pendingRequests: new Map(),
      pendingTurn: null,
      sessionToken: null,
      stderrLines: [],
      closed: false,
    }
    this.attachListeners(context)

    try {
      await this.sendRequest(context, "initialize", {
        clientInfo: {
          name: "kanna_desktop",
          title: "Kanna",
          version: "0.1.0",
        },
        capabilities: {
          experimentalApi: true,
          requestAttestation: false,
        },
      } satisfies InitializeParams)
      this.writeMessage(context, {
        method: "initialized",
      })
      return await callback(context)
    } finally {
      context.closed = true
      context.pendingTurn?.queue.finish()
      try {
        context.child.kill("SIGKILL")
      } catch {
        // ignore kill failures
      }
    }
  }

  private requireSession(chatId: string) {
    const context = this.sessions.get(chatId)
    if (!context || context.closed) {
      throw new Error("Codex session not started")
    }
    return context
  }

  private attachListeners(context: SessionContext) {
    const lines = createInterface({ input: context.child.stdout })
    void (async () => {
      for await (const line of lines) {
        const parsed = parseJsonLine(line)
        if (!parsed) continue

        if (isJsonRpcResponse(parsed)) {
          this.handleResponse(context, parsed)
          continue
        }

        if (isServerRequest(parsed)) {
          void this.handleServerRequest(context, parsed)
          continue
        }

        if (isServerNotification(parsed)) {
          void this.handleNotification(context, parsed)
        }
      }
    })()

    const stderr = createInterface({ input: context.child.stderr })
    void (async () => {
      for await (const line of stderr) {
        if (line.trim()) {
          context.stderrLines = [line.trim().slice(-8192)]
        }
      }
    })()

    context.child.on("error", (error) => {
      this.failContext(context, error.message)
    })

    context.child.on("close", (code) => {
      if (context.closed) return
      queueMicrotask(() => {
        if (context.closed) return
        const message = context.stderrLines.at(-1) || `Codex app-server exited with code ${code ?? 1}`
        this.failContext(context, message)
      })
    })
  }

  private handleResponse(context: SessionContext, response: JsonRpcResponse) {
    const pending = context.pendingRequests.get(response.id)
    if (!pending) return
    context.pendingRequests.delete(response.id)
    if (response.error) {
      pending.reject(new CodexRequestError(pending.method, response.error.code, response.error.message ?? "Unknown error"))
      return
    }
    pending.resolve(response.result)
  }

  private async handleServerRequest(context: SessionContext, request: ServerRequest) {
    const pendingTurn = context.pendingTurn
    if (!pendingTurn) {
      this.writeMessage(context, {
        id: request.id,
        error: {
          message: "No active turn",
        },
      })
      return
    }

    if (request.method === "item/tool/requestUserInput") {
      const questions = toAskUserQuestionItems(request.params)
      const toolId = request.params.itemId
      const toolRequest: HarnessToolRequest = {
        tool: {
          kind: "tool",
          toolKind: "ask_user_question",
          toolName: "AskUserQuestion",
          toolId,
          input: { questions },
          rawInput: {
            questions: request.params.questions,
          },
        },
      }
      pendingTurn.queue.push({
        type: "transcript",
        entry: timestamped({
          kind: "tool_call",
          tool: toolRequest.tool,
        }),
      })

      const result = await pendingTurn.onToolRequest(toolRequest)
      this.writeMessage(context, {
        id: request.id,
        result: toToolRequestUserInputResponse(result, request.params.questions),
      })
      return
    }

    if (request.method === "item/tool/call") {
      pendingTurn.handledDynamicToolIds.add(request.params.callId)
      if (request.params.tool === "update_plan") {
        const args = asRecord(request.params.arguments)
        const plan = Array.isArray(args?.plan) ? args.plan : []
        const steps: TurnPlanStep[] = plan
          .map((entry) => asRecord(entry))
          .filter((entry): entry is Record<string, unknown> => Boolean(entry))
          .map((entry) => {
            const status: TurnPlanStep["status"] =
              entry.status === "completed"
                ? "completed"
                : entry.status === "inProgress" || entry.status === "in_progress"
                  ? "inProgress"
                  : "pending"
            return {
              step: typeof entry.step === "string" ? entry.step : "",
              status,
            }
          })
          .filter((step) => step.step.length > 0)

        if (steps.length > 0) {
          pendingTurn.latestPlanSteps = steps
          pendingTurn.latestPlanExplanation = typeof args?.explanation === "string" ? args.explanation : pendingTurn.latestPlanExplanation
          pendingTurn.queue.push({
            type: "transcript",
            entry: todoToolCall(request.params.callId, steps),
          })
          pendingTurn.queue.push({
            type: "transcript",
            entry: timestamped({
              kind: "tool_result",
              toolId: request.params.callId,
              content: "",
            }),
          })
        }

        this.writeMessage(context, {
          id: request.id,
          result: {
            contentItems: [],
            success: true,
          } satisfies DynamicToolCallResponse,
        })
        return
      }

      const payload = dynamicToolPayload(request.params.arguments)
      pendingTurn.queue.push({
        type: "transcript",
        entry: genericDynamicToolCall(request.params.callId, request.params.tool, payload),
      })
      const errorMessage = `Unsupported dynamic tool call: ${request.params.tool}`
      pendingTurn.queue.push({
        type: "transcript",
        entry: timestamped({
          kind: "tool_result",
          toolId: request.params.callId,
          content: errorMessage,
          isError: true,
        }),
      })
      this.writeMessage(context, {
        id: request.id,
        result: {
          contentItems: [{ type: "inputText", text: errorMessage }],
          success: false,
        } satisfies DynamicToolCallResponse,
      })
      return
    }

    if (request.method === "item/commandExecution/requestApproval") {
      const decision = await pendingTurn.onApprovalRequest?.({
        requestId: request.id,
        kind: "command_execution",
        params: request.params,
      }) ?? "decline"
      this.writeMessage(context, {
        id: request.id,
        result: {
          decision,
        } satisfies CommandExecutionRequestApprovalResponse,
      })
      return
    }

    const decision = await pendingTurn.onApprovalRequest?.({
      requestId: request.id,
      kind: "file_change",
      params: request.params,
    }) ?? "decline"
    this.writeMessage(context, {
      id: request.id,
      result: {
        decision,
      } satisfies FileChangeRequestApprovalResponse,
    })
  }

  private async handleNotification(context: SessionContext, notification: ServerNotification) {
    if (notification.method === "thread/started") {
      context.sessionToken = notification.params.thread.id
      if (context.pendingTurn) {
        context.pendingTurn.queue.push({
          type: "session_token",
          sessionToken: notification.params.thread.id,
        })
      }
      return
    }

    // Account rate limits arrive independent of any active turn.
    if (notification.method === "account/rateLimits/updated") {
      const params = notification.params as AccountRateLimitsUpdatedNotification
      if (params?.rateLimits) this.onRateLimits?.(params.rateLimits)
      return
    }

    const pendingTurn = context.pendingTurn
    if (!pendingTurn) return

    switch (notification.method) {
      case "thread/tokenUsage/updated":
        this.handleTokenUsageUpdated(pendingTurn, notification.params)
        return
      case "turn/plan/updated":
        this.handlePlanUpdated(pendingTurn, notification.params)
        return
      case "item/started":
        this.handleItemStarted(
          pendingTurn,
          notification.params,
          (!context.sessionToken || notification.params.threadId === context.sessionToken)
            && (!pendingTurn.turnId || notification.params.turnId === pendingTurn.turnId)
        )
        return
      case "item/completed":
        this.handleItemCompleted(
          pendingTurn,
          notification.params,
          (!context.sessionToken || notification.params.threadId === context.sessionToken)
            && (!pendingTurn.turnId || notification.params.turnId === pendingTurn.turnId)
        )
        return
      case "item/plan/delta":
        this.handlePlanDelta(pendingTurn, notification.params)
        return
      case "turn/completed":
        await this.handleTurnCompleted(context, notification.params)
        return
      case "thread/compacted":
        this.handleContextCompacted(pendingTurn, notification.params)
        return
      case "error":
        this.handleErrorNotification(context, notification.params)
        return
      default:
        return
    }
  }

  private handleItemStarted(
    pendingTurn: PendingTurn,
    notification: ItemStartedNotification,
    isActiveTurn: boolean
  ) {
    if (notification.item.type === "userMessage") {
      this.handleSteeredUserMessage(pendingTurn, notification.item.clientId, isActiveTurn)
      return
    }

    if (notification.item.type === "plan") {
      pendingTurn.planTextByItemId.set(notification.item.id, notification.item.text)
      pendingTurn.latestPlanText = notification.item.text
      return
    }

    if (
      notification.item.type === "commandExecution"
      || notification.item.type === "webSearch"
      || notification.item.type === "mcpToolCall"
      || notification.item.type === "dynamicToolCall"
      || notification.item.type === "collabAgentToolCall"
      || notification.item.type === "fileChange"
      || notification.item.type === "error"
    ) {
      if (pendingTurn.handledDynamicToolIds.has(notification.item.id)) {
        return
      }
      if (notification.item.type === "webSearch" && !webSearchQuery(notification.item)) {
        return
      }
    }

    const entries = itemToToolCalls(notification.item)
    for (const entry of entries) {
      if (entry.kind === "tool_call") {
        pendingTurn.startedToolIds.add(entry.tool.toolId)
      }
      pendingTurn.queue.push({ type: "transcript", entry })
    }
  }

  private handleItemCompleted(
    pendingTurn: PendingTurn,
    notification: ItemCompletedNotification,
    isActiveTurn: boolean
  ) {
    if (notification.item.type === "userMessage") {
      this.handleSteeredUserMessage(pendingTurn, notification.item.clientId, isActiveTurn)
      return
    }

    if (notification.item.type === "agentMessage") {
      pendingTurn.queue.push({
        type: "transcript",
        entry: timestamped({
          kind: "assistant_text",
          text: notification.item.text,
        }),
      })
      if (pendingTurn.pendingWebSearchResultToolId && notification.item.text.trim()) {
        pendingTurn.queue.push({
          type: "transcript",
          entry: timestamped({
            kind: "tool_result",
            toolId: pendingTurn.pendingWebSearchResultToolId,
            content: notification.item.text,
          }),
        })
        pendingTurn.pendingWebSearchResultToolId = null
      }
      return
    }

    if (notification.item.type === "plan") {
      pendingTurn.planTextByItemId.set(notification.item.id, notification.item.text)
      pendingTurn.latestPlanText = notification.item.text
      return
    }

    if (pendingTurn.handledDynamicToolIds.has(notification.item.id)) {
      return
    }

    const startedEntries = itemToToolCalls(notification.item)
    for (const entry of startedEntries) {
      if (entry.kind !== "tool_call") {
        continue
      }
      if (pendingTurn.startedToolIds.has(entry.tool.toolId)) {
        continue
      }
      pendingTurn.startedToolIds.add(entry.tool.toolId)
      pendingTurn.queue.push({ type: "transcript", entry })
    }

    const resultEntries = itemToToolResults(notification.item)
    for (const entry of resultEntries) {
      pendingTurn.queue.push({ type: "transcript", entry })
      if (notification.item.type === "webSearch" && entry.kind === "tool_result" && !entry.isError) {
        pendingTurn.pendingWebSearchResultToolId = notification.item.id
      }
    }
  }

  private handleSteeredUserMessage(
    pendingTurn: PendingTurn,
    clientId: string | null | undefined,
    isActiveTurn: boolean
  ) {
    if (!isActiveTurn || !clientId) return
    const pendingEntry = pendingTurn.pendingSteeredEntries.get(clientId)
    if (!pendingEntry || pendingEntry.echoReceived) return
    pendingEntry.echoReceived = true
    pendingTurn.queue.push({
      type: "transcript",
      entry: pendingEntry.entry,
      onPersisted: (error) => {
        if (error) {
          this.rejectPendingSteeredEntry(pendingTurn, clientId, pendingEntry, error)
          return
        }
        if (pendingEntry.settled) return
        pendingEntry.settled = true
        if (pendingTurn.pendingSteeredEntries.get(clientId) === pendingEntry) {
          pendingTurn.pendingSteeredEntries.delete(clientId)
        }
        pendingEntry.resolvePersisted()
      },
    })
  }

  private rejectPendingSteeredEntry(
    pendingTurn: PendingTurn,
    clientId: string,
    pendingEntry: PendingSteeredEntry,
    error: Error,
  ) {
    if (pendingEntry.settled) return
    pendingEntry.settled = true
    if (pendingTurn.pendingSteeredEntries.get(clientId) === pendingEntry) {
      pendingTurn.pendingSteeredEntries.delete(clientId)
    }
    pendingEntry.rejectPersisted(error)
  }

  private failPendingSteers(
    pendingTurn: PendingTurn,
    message: string,
    options?: { includeEchoed?: boolean },
  ) {
    for (const [clientId, pendingEntry] of pendingTurn.pendingSteeredEntries) {
      if (pendingEntry.echoReceived && !options?.includeEchoed) continue
      this.rejectPendingSteeredEntry(
        pendingTurn,
        clientId,
        pendingEntry,
        new Error(message),
      )
    }
  }

  private handlePlanUpdated(pendingTurn: PendingTurn, notification: TurnPlanUpdatedNotification) {
    pendingTurn.latestPlanExplanation = notification.explanation ?? null
    pendingTurn.latestPlanSteps = notification.plan
    if (notification.plan.length === 0) {
      return
    }
    pendingTurn.todoSequence += 1
    pendingTurn.queue.push({
      type: "transcript",
      entry: todoToolCall(
        `${notification.turnId}:todo-${pendingTurn.todoSequence}`,
        notification.plan
      ),
    })
  }

  private handlePlanDelta(pendingTurn: PendingTurn, notification: PlanDeltaNotification) {
    const current = pendingTurn.planTextByItemId.get(notification.itemId) ?? ""
    const next = `${current}${notification.delta}`
    pendingTurn.planTextByItemId.set(notification.itemId, next)
    pendingTurn.latestPlanText = next
  }

  private handleContextCompacted(pendingTurn: PendingTurn, _notification: ContextCompactedNotification) {
    pendingTurn.queue.push({
      type: "transcript",
      entry: timestamped({ kind: "compact_boundary" }),
    })
  }

  private handleTokenUsageUpdated(
    pendingTurn: PendingTurn,
    notification: ThreadTokenUsageUpdatedNotification,
  ) {
    const usage = normalizeCodexTokenUsage(notification)
    if (!usage) {
      return
    }

    pendingTurn.queue.push({
      type: "transcript",
      entry: timestamped({
        kind: "context_window_updated",
        usage,
      }),
    })
  }

  private async handleTurnCompleted(context: SessionContext, notification: TurnCompletedNotification) {
    const pendingTurn = context.pendingTurn
    if (!pendingTurn) return
    const status = notification.turn.status
    const isCancelled = status === "interrupted"
    const isError = status === "failed"
    pendingTurn.pendingWebSearchResultToolId = null
    this.failPendingSteers(pendingTurn, "Codex turn ended before steering was acknowledged")

    if (!isCancelled && !isError && pendingTurn.planMode) {
      const planText = pendingTurn.latestPlanText?.trim()
        || renderPlanMarkdownFromSteps(pendingTurn.latestPlanSteps).trim()

      if (planText) {
        pendingTurn.turnId = null
        const tool = {
          kind: "tool" as const,
          toolKind: "exit_plan_mode" as const,
          toolName: "ExitPlanMode",
          toolId: `${notification.turn.id}:exit-plan`,
          input: {
            plan: planText,
            summary: pendingTurn.latestPlanExplanation ?? undefined,
          },
          rawInput: {
            plan: planText,
            summary: pendingTurn.latestPlanExplanation ?? undefined,
          },
        }
        pendingTurn.queue.push({
          type: "transcript",
          entry: timestamped({
            kind: "tool_call",
            tool,
          }),
        })
        await pendingTurn.onToolRequest({ tool })
        pendingTurn.resolved = true
        pendingTurn.queue.finish()
        context.pendingTurn = null
        return
      }
    }

    pendingTurn.resolved = true
    pendingTurn.queue.push({
      type: "transcript",
      entry: timestamped({
        kind: "result",
        subtype: isCancelled ? "cancelled" : isError ? "error" : "success",
        isError,
        durationMs: 0,
        result: isError
          ? formatCodexError(notification.turn.error)
            || formatCodexError(pendingTurn.retryCause)
            || "Codex turn failed"
          : formatCodexError(notification.turn.error),
      }),
    })
    pendingTurn.queue.finish()
    context.pendingTurn = null
  }

  /**
   * codex reports two different things through `error`. A dropped model stream
   * arrives with `willRetry: true` and a message that is only a progress
   * counter ("Reconnecting... 2/5") — the turn is still alive and codex retries
   * on its own. Failing here killed turns that would have recovered a second
   * later, and reported the counter as the outcome, which says nothing about
   * what went wrong. Show it as a status line instead (the transcript renders
   * only the last one, so it clears itself when the stream comes back) and let
   * the turn run. Only `willRetry: false` is terminal.
   */
  private handleErrorNotification(context: SessionContext, notification: ErrorNotification) {
    const message = formatCodexError(notification.error) || "Codex reported an error"
    if (!notification.willRetry) {
      this.failContext(context, message)
      return
    }

    const pendingTurn = context.pendingTurn
    if (!pendingTurn || pendingTurn.resolved) return
    pendingTurn.retryCause = preferredRetryCause(pendingTurn.retryCause, notification.error)
    pendingTurn.queue.push({
      type: "transcript",
      entry: timestamped({ kind: "status", status: message }),
    })
  }

  private failContext(context: SessionContext, message: string) {
    context.customTools?.close()
    const pendingTurn = context.pendingTurn
    if (pendingTurn && !pendingTurn.resolved) {
      this.failPendingSteers(pendingTurn, message, { includeEchoed: true })
      pendingTurn.queue.push({
        type: "transcript",
        entry: timestamped({
          kind: "result",
          subtype: "error",
          isError: true,
          durationMs: 0,
          result: message,
        }),
      })
      pendingTurn.queue.finish()
      context.pendingTurn = null
    }

    for (const pending of context.pendingRequests.values()) {
      pending.reject(new Error(message))
    }
    context.pendingRequests.clear()
    context.closed = true
    if (this.sessions.get(context.chatId) === context) this.sessions.delete(context.chatId)
    // A non-retryable protocol error (e.g. a usage-limit hit) leaves the
    // subprocess itself running — only the child.on("close") path had
    // actually exited already. Without this, the process survives orphaned,
    // still holding its thread's write lock, until the whole Kanna process
    // is killed. A later resume then spawns a second process for the same
    // thread and collides with the still-alive first one.
    try {
      context.child.kill("SIGKILL")
    } catch {
      // ignore kill failures
    }
  }

  getResourceCounts() {
    return {
      codexSessions: this.sessions.size,
      codexPendingRequests: [...this.sessions.values()].reduce((sum, session) => sum + session.pendingRequests.size, 0),
      codexStderrChars: [...this.sessions.values()].reduce((sum, session) => sum + session.stderrLines.reduce((total, line) => total + line.length, 0), 0),
    }
  }

  private async sendRequest<TResult>(context: SessionContext, method: string, params: unknown): Promise<TResult> {
    const id = randomUUID()
    const promise = new Promise<TResult>((resolve, reject) => {
      context.pendingRequests.set(id, {
        method,
        resolve: resolve as (value: unknown) => void,
        reject,
      })
    })
    this.writeMessage(context, {
      id,
      method,
      params,
    })
    return await promise
  }

  private writeMessage(context: SessionContext, message: Record<string, unknown>) {
    context.child.stdin.write(`${JSON.stringify(message)}\n`)
  }
}
