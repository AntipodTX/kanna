import {
  query,
  type BackgroundTaskSummary,
  type CanUseTool,
  type EffortLevel,
  type HookCallback,
  type HookCallbackMatcher,
  type HookEvent,
  type PermissionResult,
  type Query,
  type SDKUserMessage,
  type Settings,
  type SlashCommand,
  type StopHookInput,
} from "@anthropic-ai/claude-agent-sdk"
import { homedir } from "node:os"
import type {
  AgentProvider,
  AskUserQuestionItem,
  ChatAttachment,
  ChatSkillsSnapshot,
  ClaudeReasoningEffort,
  CodexReasoningEffort,
  ContextWindowUsageSnapshot,
  HarnessSkill,
  ModelOptions,
  NormalizedToolCall,
  PendingToolSnapshot,
  KannaStatus,
  QueuedChatMessage,
  SubagentActivity,
  TranscriptEntry,
} from "../shared/types"
import { normalizeToolCall } from "../shared/tools"
import type { ClientCommand } from "../shared/protocol"
import { AsyncQueue } from "./async-queue"
import { resolveClaudeExecutable } from "./claude-executable"
import { KannaToolRuntime, KannaToolEventFilter, type KannaToolHost } from "./kanna-tools"
import { createClaudeKannaTools } from "./kanna-tool-adapters"
import { EventStore } from "./event-store"
import { STRUCTURED_RESULT_TOOL_KINDS, type ContextRestoration } from "./events"
import type { AnalyticsReporter } from "./analytics"
import { NoopAnalyticsReporter } from "./analytics"
import { CodexAppServerManager } from "./codex-app-server"
import { CursorCliManager } from "./cursor-cli"
import { fetchGrokAccountUsage, GrokCliManager } from "./grok-cli"
import { PiAgentManager, resolvePiConnection } from "./pi-agent"
import { type GenerateChatTitleResult, generateTitleForChatDetailed } from "./generate-title"
import type { ClaudeRateLimitInfoRaw, ClaudeUsageRaw } from "./usage-limits"
import type { HarnessEvent, HarnessStartupOutcome, HarnessToolRequest, HarnessTurn } from "./harness-types"
import {
  appendSystemMessageBlock,
  buildSkillSystemMessage,
  findSkillMentions,
  resolveSkillMentions,
  scanClaudeSkills,
  scanCodexSkills,
  scanCursorSkills,
  scanGrokSkills,
  type SkillReference,
} from "./harness-skills"
import {
  applyClaudeSdkModels,
  applyCodexModels,
  applyCursorModels,
  applyGrokModels,
  type ClaudeSdkModelInfo,
  cursorModelIdForOptions,
  getServerProviderCatalog,
  normalizeClaudeModelOptions,
  getServerClaudeRuntimeEffort,
  normalizeCodexModelOptions,
  normalizeCursorModelOptions,
  normalizeGrokModelOptions,
  normalizePiModelOptions,
  normalizeServerModel,
  serviceTierFromModelOptions,
} from "./provider-catalog"
import { CODEX_SLASH_COMMANDS, resolveClaudeApiModelId, CLAUDE_REASONING_OPTIONS } from "../shared/types"
import { fallbackTitleFromMessage } from "./generate-title"
import { asNumber, asRecord } from "../shared/json"
import { buildHandoffContext, buildHandoffMessageContent } from "./handoff"
import { checkSessionArtifact, type SessionArtifactStatus } from "./session-artifacts"
import { timestamped } from "./transcript"
import {
  findWorkflowOf,
  finishActivity,
  linkWorkflowAgents,
  normalizeClaudeTaskMessage,
  pruneTaskLog,
  type SubagentActivityUpdate,
  type TaskStart,
} from "./background-tasks"

export type { SubagentActivityUpdate } from "./background-tasks"

export function resolveClaudeRuntimeOptions(effort?: string): {
  effort?: EffortLevel
  settings?: Settings
} {
  if (effort === "ultracode") {
    return {
      effort: "xhigh",
      settings: { ultracode: true },
    }
  }

  const sdkEffort = CLAUDE_REASONING_OPTIONS
    .map((option) => option.id)
    .find((candidate): candidate is Exclude<ClaudeReasoningEffort, "ultracode"> => (
      candidate === effort && candidate !== "ultracode"
    ))
  return {
    effort: sdkEffort,
    settings: undefined,
  }
}

/**
 * Tools every Claude session gets. `EnterPlanMode` is deliberately absent — it
 * is added only in "Auto Plan" (see {@link claudeToolset}); without it Claude
 * cannot put itself into plan mode unprompted.
 *
 * `ExitPlanMode` stays in the base set even in Full Access: the user can flip a
 * live session into plan mode via `setPermissionMode` without a restart, and
 * without the exit tool they would be stranded there.
 */
const CLAUDE_BASE_TOOLSET = [
  "Skill",
  "WebFetch",
  "WebSearch",
  "Task",
  "TaskOutput",
  "Bash",
  "Glob",
  "Grep",
  "Read",
  "Edit",
  "Write",
  "TodoWrite",
  "KillShell",
  "Workflow",
  "CronCreate",
  "CronDelete",
  "CronList",
  "ScheduleWakeup",
  "RemoteTrigger",
  "Monitor",
  "PushNotification",
  "AskUserQuestion",
  "ExitPlanMode",
] as const

/**
 * The SDK's `tools` allowlist is fixed at `query()` time (there is no runtime
 * tool-swap), so a change to `autoPlan` forces a session restart — see the
 * restart condition in {@link AgentCoordinator.startClaudeTurn}.
 */
export function claudeToolset(autoPlan: boolean): string[] {
  return autoPlan ? [...CLAUDE_BASE_TOOLSET, "EnterPlanMode"] : [...CLAUDE_BASE_TOOLSET]
}

export type ClaudeBackgroundWorkState = "unknown" | "active" | "inactive"

export function classifyClaudeBackgroundWorkState(
  input: Pick<StopHookInput, "background_tasks" | "session_crons">
): ClaudeBackgroundWorkState {
  if (!Array.isArray(input.background_tasks) || !Array.isArray(input.session_crons)) {
    return "unknown"
  }

  return input.background_tasks.length > 0 || input.session_crons.length > 0
    ? "active"
    : "inactive"
}

export function createClaudeStopHook(
  onStateChange: (state: ClaudeBackgroundWorkState) => void
): HookCallback {
  return async (input) => {
    try {
      onStateChange(
        input.hook_event_name === "Stop"
          ? classifyClaudeBackgroundWorkState(input)
          : "unknown"
      )
    } catch {
      try {
        onStateChange("unknown")
      } catch {
        // Observing background work must never interfere with Claude's Stop lifecycle.
      }
    }

    return {}
  }
}

interface PendingToolRequest {
  toolUseId: string
  tool: NormalizedToolCall & { toolKind: "ask_user_question" | "exit_plan_mode" | "codex_approval" }
  resolve: (result: unknown) => void
  resultOwner?: "tool"
  validateResult?: (result: unknown) => void
}

function normalizePreviewText(text: string) {
  return text.replace(/\s+/g, " ").trim()
}

/**
 * One line of what the chat is waiting on, for the sidebar row and the system
 * notification that quotes it: the questions asked, or the plan's summary.
 */
function getToolRequestPreview(tool: PendingToolRequest["tool"]) {
  if (tool.toolKind === "ask_user_question") {
    const questions = tool.input.questions
      .map((question) => normalizePreviewText(question.question))
      .filter(Boolean)
    if (questions.length > 0) return questions.join(" ")
  }

  if (tool.toolKind === "exit_plan_mode") {
    const summary = normalizePreviewText(tool.input.summary ?? "")
    if (summary) return summary
    const plan = normalizePreviewText(tool.input.plan ?? "")
    if (plan) return plan
  }

  if (tool.toolKind === "codex_approval") {
    if (tool.input.approvalKind === "mcp_tool_call") {
      const message = normalizePreviewText(tool.input.message)
      if (message) return message
    } else {
      const reason = normalizePreviewText(tool.input.reason ?? "")
      if (reason) return reason
      const rawDetail = tool.input.approvalKind === "command_execution"
        ? tool.input.command ?? ""
        : tool.input.approvalKind === "file_change"
          ? tool.input.grantRoot ?? ""
          : tool.input.cwd ?? ""
      const detail = normalizePreviewText(
        rawDetail,
      )
      if (detail) return detail
    }
  }

  return "Waiting for your response."
}

interface ActiveTurn {
  customTools?: KannaToolRuntime
  chatId: string
  provider: AgentProvider
  turn: HarnessTurn | null
  claudePromptSeq?: number
  model: string
  effort?: string
  serviceTier?: "fast"
  planMode: boolean
  autoPlan: boolean
  status: KannaStatus
  pendingTool: PendingToolRequest | null
  postToolFollowUp: { content: string; planMode: boolean } | null
  hasFinalResult: boolean
  contextRestorationId?: string
  startupPending?: boolean
  startupAbort?: AbortController
  toolsReady?: Promise<void>
  cancelRequested: boolean
  cancelRecorded: boolean
}

interface ClaudeSessionHandle {
  startupOutcome?: HarnessStartupOutcome
  waitForStartupOutcome?: () => Promise<HarnessStartupOutcome>
  waitUntilReady?: () => Promise<void>
  provider: "claude"
  stream: AsyncIterable<HarnessEvent>
  getAccountInfo?: () => Promise<any>
  getUsage?: () => Promise<ClaudeUsageRaw | null>
  interrupt: () => Promise<void>
  /** Stops one background task; the CLI then reports it ended as `stopped`. */
  stopTask?: (taskId: string) => Promise<void>
  close: () => void
  /** `promptId` rides on the message and comes back on the result that answers it. */
  sendPrompt: (content: string, promptId?: string) => Promise<void>
  /** Whether results are known to echo prompt ids before any has arrived. */
  echoesPromptIds?: boolean
  setModel: (model: string) => Promise<void>
  setPermissionMode: (planMode: boolean) => Promise<void>
  setFastMode?: (fastMode: boolean) => Promise<void>
  supportedModels?: () => Promise<ClaudeSdkModelInfo[]>
  supportedCommands?: () => Promise<SlashCommand[]>
}

interface ClaudeSessionState {
  id: string
  chatId: string
  session: ClaudeSessionHandle
  backgroundWorkState: ClaudeBackgroundWorkState
  localPath: string
  model: string
  effort?: string
  serviceTier?: "fast"
  planMode: boolean
  autoPlan: boolean
  sessionToken: string | null
  accountInfoLoaded: boolean
  forceClosed: boolean
  nextPromptSeq: number
  /** Prompts sent and not yet answered, oldest first. */
  pendingPrompts: Array<{ seq: number; id: string }>
  /** Results carry the ids of the prompts they answer (see takeAnsweredClaudePrompts). */
  echoesPromptIds: boolean
  /**
   * Set while a cancel is settling so in-flight stream entries (emitted
   * between cancel() and the interrupt landing) don't re-register an
   * active turn via resumeBackgroundTurn. Cleared on the next result or
   * interrupted entry, and whenever a new prompt is sent.
   */
  suppressResume: boolean
  /**
   * Prompt seqs whose turn was cancelled by the user (escape or steer).
   * The SDK reports an interrupt as an error result (subtype
   * error_during_execution, usually no text); results attributed to these
   * seqs are dropped instead of persisted, since cancel already appended an
   * "interrupted" entry. Unlike suppressResume, this survives a new prompt
   * being sent immediately after the cancel (the steer path).
   */
  cancelledPromptSeqs: Set<number>
}

type TitleGenerationProvider = Extract<AgentProvider, "claude" | "codex">

interface AgentCoordinatorArgs {
  store: EventStore
  onStateChange: (chatId?: string, options?: { immediate?: boolean }) => void
  analytics?: AnalyticsReporter
  codexManager?: CodexAppServerManager
  cursorManager?: CursorCliManager
  grokManager?: GrokCliManager
  piManager?: PiAgentManager
  resolvePiConnection?: () => Promise<import("./pi-agent").PiConnection | null>
  generateTitle?: (
    messageContent: string,
    cwd: string,
    preferredProvider?: TitleGenerationProvider
  ) => Promise<GenerateChatTitleResult>
  startClaudeSession?: (args: {
    localPath: string
    model: string
    effort?: string
    serviceTier?: "fast"
    planMode: boolean
    autoPlan: boolean
    sessionToken: string | null
    forkSession: boolean
    customTools?: KannaToolHost
    onToolRequest: (request: HarnessToolRequest) => Promise<unknown>
    onRateLimitEvent?: (info: ClaudeRateLimitInfoRaw) => void
    onSubagentActivity?: (update: SubagentActivityUpdate) => void
    onBackgroundWorkStateChange: (state: ClaudeBackgroundWorkState) => void
  }) => Promise<ClaudeSessionHandle>
  /**
   * Probe whether a provider's native session artifact still exists on disk.
   * Injectable so tests can force a "missing" session without touching the
   * filesystem. Defaults to the real {@link checkSessionArtifact}.
   */
  checkSessionArtifact?: (
    provider: AgentProvider,
    query: { cwd: string; sessionToken: string | null | undefined }
  ) => SessionArtifactStatus
}


function isClaudeSteerLoggingEnabled() {
  return process.env.KANNA_LOG_CLAUDE_STEER === "1"
}

function logClaudeSteer(stage: string, details?: Record<string, unknown>) {
  if (!isClaudeSteerLoggingEnabled()) return
  console.log("[kanna/claude-steer]", JSON.stringify({
    stage,
    ...details,
  }))
}

const STEERED_MESSAGE_PREFIX = `<system-message>
The user would like to inform you of something while you continue to work. Acknowledge receipt immediately with a text response, then continue with the task at hand, incorporating the user's feedback if needed.
</system-message>`

/**
 * Wire-only prompt that restarts a turn Kanna killed by shutting down (see
 * `AgentCoordinator.resumeInterruptedTurn`). The harness session carries the
 * original prompt and the work already done, so this only has to say what
 * happened and warn that the last thing it was doing may be half-finished —
 * the process died mid-tool-call as often as not.
 */
export const RESUME_AFTER_RESTART_MESSAGE = `<system-message>
Kanna restarted while you were working on this, so your process was stopped mid-task and is now back up. Continue the task you were on from where it left off.
Whatever you were doing last may not have completed — re-check the state of any file you were editing and any command you had running before assuming it finished.
</system-message>`

function parseCodexSlashCommand(content: string): typeof CODEX_SLASH_COMMANDS[number] | null {
  const command = content.trim()
  return CODEX_SLASH_COMMANDS.includes(command as typeof CODEX_SLASH_COMMANDS[number])
    ? command as typeof CODEX_SLASH_COMMANDS[number]
    : null
}

interface SendMessageOptions {
  provider?: AgentProvider
  model?: string
  modelOptions?: ModelOptions
  effort?: string
  planMode?: boolean
  autoPlan?: boolean
}

function stringFromUnknown(value: unknown) {
  if (typeof value === "string") return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

export function buildSteeredMessageContent(content: string) {
  const trimmed = content.trim()
  if (trimmed.length === 0) {
    return STEERED_MESSAGE_PREFIX
  }
  // Slash invocations must stay at the very start of the message — claude
  // checks trim().startsWith("/") and pi checks startsWith("/") before
  // expanding — so the steer block trails instead of leading for them.
  if (trimmed.startsWith("/")) {
    return `${content}\n\n${STEERED_MESSAGE_PREFIX}`
  }
  return `${STEERED_MESSAGE_PREFIX}\n\n${content}`
}

export interface ConcurrentProjectChat {
  title: string
  transcriptPath: string
}

/**
 * Wire-only notice (never stored in the transcript — same pattern as the
 * codex/cursor skill failsafe) appended to the harness-bound prompt when
 * other chats have active turns in the same project directory.
 */
export function buildConcurrentAgentsNotice(chats: ConcurrentProjectChat[]): string | null {
  if (chats.length === 0) return null
  const lines = chats.map((chat) => `${chat.title}: ${chat.transcriptPath}`)
  return [
    "<system-message>there are other agents working in the current directory. Don't overwrite their work if builds fail, don't fix broken tests (as they may be stale while the other agent works) and expect changes between reads.",
    "",
    "Active chats & their transcripts can be found here:",
    ...lines,
    "</system-message>",
  ].join("\n")
}

function escapeXmlAttribute(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("\"", "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
}




export function buildAttachmentHintText(attachments: ChatAttachment[]) {
  if (attachments.length === 0) return ""

  const lines = attachments.map((attachment) => (
    `<attachment kind="${escapeXmlAttribute(attachment.kind)}" mime_type="${escapeXmlAttribute(attachment.mimeType)}" path="${escapeXmlAttribute(attachment.absolutePath)}" project_path="${escapeXmlAttribute(attachment.relativePath)}" size_bytes="${attachment.size}" display_name="${escapeXmlAttribute(attachment.displayName)}" />`
  ))

  return [
    "<kanna-attachments>",
    ...lines,
    "</kanna-attachments>",
  ].join("\n")
}

export function buildPromptText(content: string, attachments: ChatAttachment[]) {
  const attachmentHint = buildAttachmentHintText(attachments)
  if (!attachmentHint) {
    return content.trim()
  }

  const trimmed = content.trim()
  return [
    trimmed || "Please inspect the attached files.",
    attachmentHint,
  ].join("\n\n").trim()
}

/**
 * The user's answers to an AskUserQuestion, as the prompt of a follow-up
 * turn for harnesses that cannot take the answer mid-turn. Answers are keyed
 * by question id when the question has one, else by its text.
 */
export function formatQuestionAnswersFollowUp(questions: AskUserQuestionItem[], result: unknown) {
  const answers = asRecord(asRecord(result)?.answers) ?? {}
  const lines = questions.map((question) => {
    const raw = (question.id ? answers[question.id] : undefined) ?? answers[question.question]
    const picked = (Array.isArray(raw) ? raw : raw == null ? [] : [raw]).map(String).filter(Boolean)
    return `- ${question.question}\n  ${picked.length > 0 ? picked.join(", ") : "(no answer)"}`
  })
  return `Here are my answers to your questions:\n\n${lines.join("\n")}`
}

function discardedToolResult(
  tool: NormalizedToolCall & { toolKind: "ask_user_question" | "exit_plan_mode" | "codex_approval" }
) {
  if (tool.toolKind === "ask_user_question") {
    return {
      discarded: true,
      answers: {},
    }
  }

  if (tool.toolKind === "codex_approval") {
    return {
      decision: "decline",
      discarded: true,
    }
  }

  return {
    discarded: true,
  }
}

export function normalizeClaudeUsageSnapshot(
  value: unknown,
  maxTokens?: number,
): ContextWindowUsageSnapshot | null {
  const usage = asRecord(value)
  if (!usage) return null

  const directInputTokens = asNumber(usage.input_tokens) ?? asNumber(usage.inputTokens) ?? 0
  const cacheCreationInputTokens =
    asNumber(usage.cache_creation_input_tokens) ?? asNumber(usage.cacheCreationInputTokens) ?? 0
  const cacheReadInputTokens =
    asNumber(usage.cache_read_input_tokens) ?? asNumber(usage.cacheReadInputTokens) ?? 0
  const outputTokens = asNumber(usage.output_tokens) ?? asNumber(usage.outputTokens) ?? 0
  const reasoningOutputTokens =
    asNumber(usage.reasoning_output_tokens) ?? asNumber(usage.reasoningOutputTokens)
  const toolUses = asNumber(usage.tool_uses) ?? asNumber(usage.toolUses)
  const durationMs = asNumber(usage.duration_ms) ?? asNumber(usage.durationMs)

  const inputTokens = directInputTokens + cacheCreationInputTokens + cacheReadInputTokens
  const usedTokens = inputTokens + outputTokens
  if (usedTokens <= 0) {
    return null
  }

  return {
    usedTokens,
    inputTokens,
    ...(cacheReadInputTokens > 0 ? { cachedInputTokens: cacheReadInputTokens } : {}),
    ...(outputTokens > 0 ? { outputTokens } : {}),
    ...(reasoningOutputTokens !== undefined ? { reasoningOutputTokens } : {}),
    lastUsedTokens: usedTokens,
    lastInputTokens: inputTokens,
    ...(cacheReadInputTokens > 0 ? { lastCachedInputTokens: cacheReadInputTokens } : {}),
    ...(outputTokens > 0 ? { lastOutputTokens: outputTokens } : {}),
    ...(reasoningOutputTokens !== undefined ? { lastReasoningOutputTokens: reasoningOutputTokens } : {}),
    ...(toolUses !== undefined ? { toolUses } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(typeof maxTokens === "number" && maxTokens > 0 ? { maxTokens } : {}),
    compactsAutomatically: false,
  }
}

export function maxClaudeContextWindowFromModelUsage(modelUsage: unknown): number | undefined {
  const record = asRecord(modelUsage)
  if (!record) return undefined

  let maxContextWindow: number | undefined
  for (const value of Object.values(record)) {
    const usage = asRecord(value)
    const contextWindow = asNumber(usage?.contextWindow) ?? asNumber(usage?.context_window)
    if (contextWindow === undefined) continue
    maxContextWindow = Math.max(maxContextWindow ?? 0, contextWindow)
  }
  return maxContextWindow
}

export function normalizeClaudeContextUsage(value: unknown): { usedTokens: number; maxTokens?: number } | null {
  const record = asRecord(value)
  if (!record) return null

  const usedTokens = asNumber(record.totalTokens)
  if (usedTokens === undefined || usedTokens <= 0) return null

  const maxTokens = asNumber(record.maxTokens)
  return {
    usedTokens,
    ...(maxTokens !== undefined && maxTokens > 0 ? { maxTokens } : {}),
  }
}

function getClaudeAssistantMessageUsageId(message: any): string | null {
  if (typeof message?.message?.id === "string" && message.message.id) {
    return message.message.id
  }
  if (typeof message?.uuid === "string" && message.uuid) {
    return message.uuid
  }
  return null
}

export function normalizeClaudeStreamMessage(
  message: any,
  options?: {
    /**
     * Ids of earlier tool calls whose kind renders `tool_use_result`
     * (`STRUCTURED_RESULT_TOOL_KINDS`). Only their results keep that field;
     * for every other tool it duplicates `content`.
     */
    structuredToolIds?: ReadonlySet<string>
  }
): TranscriptEntry[] {
  const entries = normalizeClaudeStreamMessageEntries(message, options)
  // Subagent (sidechain) messages arrive on the same iterator as the main
  // thread, told apart only by this id. Stamp it on everything the message
  // produced so readers can fold the subagent's work under its Agent row.
  const parentToolUseId = typeof message?.parent_tool_use_id === "string" && message.parent_tool_use_id
    ? message.parent_tool_use_id
    : undefined
  if (!parentToolUseId) return entries
  return entries.map((entry) => ({ ...entry, parentToolUseId }))
}

function normalizeClaudeStreamMessageEntries(
  message: any,
  options?: { structuredToolIds?: ReadonlySet<string> }
): TranscriptEntry[] {
  // Raw SDK JSON is kept only on system_init, for the raw JSON view. Tool
  // results used to carry it too, so `tool_use_result` could be lifted out
  // later; that copy held every screenshot twice and grew chats past 100 MB
  // on disk. Now the one field is stored on its own, and only where read.
  const messageId = typeof message.uuid === "string" ? message.uuid : undefined

  if (message.type === "system" && message.subtype === "init") {
    return [
      timestamped({
        kind: "system_init",
        messageId,
        provider: "claude",
        model: typeof message.model === "string" ? message.model : "unknown",
        tools: Array.isArray(message.tools) ? message.tools : [],
        agents: Array.isArray(message.agents) ? message.agents : [],
        slashCommands: Array.isArray(message.slash_commands)
          ? message.slash_commands.filter((entry: string) => !entry.startsWith("._"))
          : [],
        mcpServers: Array.isArray(message.mcp_servers) ? message.mcp_servers : [],
        debugRaw: JSON.stringify(message),
      }),
    ]
  }

  if (message.type === "assistant" && Array.isArray(message.message?.content)) {
    const entries: TranscriptEntry[] = []
    for (const content of message.message.content) {
      if (content.type === "text" && typeof content.text === "string") {
        entries.push(timestamped({
          kind: "assistant_text",
          messageId,
          text: content.text,
        }))
      }
      if (content.type === "tool_use" && typeof content.name === "string" && typeof content.id === "string") {
        entries.push(timestamped({
          kind: "tool_call",
          messageId,
          tool: normalizeToolCall({
            toolName: content.name,
            toolId: content.id,
            input: (content.input ?? {}) as Record<string, unknown>,
          }),
        }))
      }
    }
    return entries
  }

  if (message.type === "user" && Array.isArray(message.message?.content)) {
    const entries: TranscriptEntry[] = []
    for (const content of message.message.content) {
      if (content.type === "tool_result" && typeof content.tool_use_id === "string") {
        const structured = options?.structuredToolIds?.has(content.tool_use_id)
          ? message.tool_use_result
          : undefined
        entries.push(timestamped({
          kind: "tool_result",
          messageId,
          toolId: content.tool_use_id,
          content: content.content,
          isError: Boolean(content.is_error),
          ...(structured !== undefined ? { structuredResult: structured } : {}),
        }))
      }
      if (message.message.role === "user" && typeof message.message.content === "string") {
        entries.push(timestamped({
          kind: "compact_summary",
          messageId,
          summary: message.message.content,
        }))
      }
    }
    return entries
  }

  if (message.type === "result") {
    if (message.subtype === "cancelled") {
      return [timestamped({ kind: "interrupted", messageId })]
    }
    return [
      timestamped({
        kind: "result",
        messageId,
        subtype: message.is_error ? "error" : "success",
        isError: Boolean(message.is_error),
        durationMs: typeof message.duration_ms === "number" ? message.duration_ms : 0,
        result: typeof message.result === "string" ? message.result : stringFromUnknown(message.result),
        costUsd: typeof message.total_cost_usd === "number" ? message.total_cost_usd : undefined,
      }),
    ]
  }

  if (message.type === "system" && message.subtype === "status" && typeof message.status === "string") {
    return [timestamped({ kind: "status", messageId, status: message.status })]
  }

  if (message.type === "system" && message.subtype === "compact_boundary") {
    return [timestamped({ kind: "compact_boundary", messageId })]
  }

  if (message.type === "system" && message.subtype === "context_cleared") {
    return [timestamped({ kind: "context_cleared", messageId })]
  }

  if (
    message.type === "user" &&
    message.message?.role === "user" &&
    typeof message.message.content === "string" &&
    message.message.content.startsWith("This session is being continued")
  ) {
    return [timestamped({ kind: "compact_summary", messageId, summary: message.message.content })]
  }

  return []
}

function claudeResultPromptIds(message: any): string[] | undefined {
  if (Array.isArray(message.user_message_uuids)) {
    const ids = message.user_message_uuids.filter((id: unknown): id is string => typeof id === "string")
    if (ids.length > 0) return ids
  }
  return typeof message.user_message_uuid === "string" && message.user_message_uuid
    ? [message.user_message_uuid]
    : undefined
}

async function* createClaudeHarnessStream(
  q: Query,
  hooks?: {
    onCommandsChanged?: (commands: SlashCommand[]) => void
    onRateLimitEvent?: (info: ClaudeRateLimitInfoRaw) => void
    /** A background task started, reported progress, or ended. */
    onTaskActivity?: (update: SubagentActivityUpdate) => void
  }
): AsyncGenerator<HarnessEvent> {
  let seenAssistantUsageIds = new Set<string>()
  let latestUsageSnapshot: ContextWindowUsageSnapshot | null = null
  let lastKnownContextWindow: number | undefined
  // The call always streams before its result, so by the time the result
  // arrives this says whether its `tool_use_result` is worth keeping.
  const structuredToolIds = new Set<string>()

  for await (const sdkMessage of q as AsyncIterable<any>) {
    const sessionToken = typeof sdkMessage.session_id === "string" ? sdkMessage.session_id : null
    if (sessionToken) {
      yield { type: "session_token", sessionToken }
    }

    // Mid-session command/skill list changes are pushed by the SDK; per its
    // docs the payload must REPLACE any cached list (a supportedCommands()
    // re-fetch would return the stale initialize-time list).
    if (sdkMessage?.type === "system" && sdkMessage.subtype === "commands_changed" && Array.isArray(sdkMessage.commands)) {
      hooks?.onCommandsChanged?.(sdkMessage.commands as SlashCommand[])
    }

    // Subscription rate-limit utilization pushed on turns (claude.ai plans).
    if (sdkMessage?.type === "rate_limit_event" && sdkMessage.rate_limit_info) {
      hooks?.onRateLimitEvent?.(sdkMessage.rate_limit_info as ClaudeRateLimitInfoRaw)
    }

    // Task reports are live state, not conversation: they go to the chat's
    // task registry and never into the transcript. A workflow reports every
    // few seconds for as long as it runs.
    if (hooks?.onTaskActivity) {
      const task = normalizeClaudeTaskMessage(sdkMessage)
      if (task) hooks.onTaskActivity(task)
    }

    // Per-step usage lives on the nested API message (`sdkMessage.message.usage`);
    // SDKAssistantMessage has no top-level `usage`. Skip sidechain/subagent
    // messages (`parent_tool_use_id` set) — their usage reflects the subagent's
    // own context window, not the main thread's.
    if (sdkMessage?.type === "assistant" && sdkMessage.parent_tool_use_id == null) {
      const usageId = getClaudeAssistantMessageUsageId(sdkMessage)
      const usageSnapshot = normalizeClaudeUsageSnapshot(
        sdkMessage.message?.usage ?? sdkMessage.usage,
        lastKnownContextWindow,
      )
      if (usageId && usageSnapshot && !seenAssistantUsageIds.has(usageId)) {
        seenAssistantUsageIds.add(usageId)
        latestUsageSnapshot = usageSnapshot
        yield {
          type: "transcript",
          entry: timestamped({
            kind: "context_window_updated",
            usage: usageSnapshot,
          }),
        }
      }
    }

    if (sdkMessage?.type === "result") {
      const resultContextWindow = maxClaudeContextWindowFromModelUsage(sdkMessage.modelUsage)
      if (resultContextWindow !== undefined) {
        lastKnownContextWindow = resultContextWindow
      }

      // The result message's `usage` is *cumulative* across every step of the
      // query() call (each step re-counts the whole cached context), so it is
      // never the current context length. Only surface it as
      // `totalProcessedTokens`.
      const accumulatedUsage = normalizeClaudeUsageSnapshot(
        sdkMessage.usage,
        resultContextWindow ?? lastKnownContextWindow,
      )

      // Exact /context parity: ask the CLI for the authoritative breakdown of
      // the current context window. Falls back to the last main-thread
      // per-step snapshot when the control request is unavailable (old CLI,
      // closed transport, timeout).
      const contextUsage = normalizeClaudeContextUsage(
        await Promise.race([
          q.getContextUsage().catch(() => null),
          new Promise<null>((resolve) => setTimeout(() => resolve(null), 5_000)),
        ]),
      )

      const baseUsage: ContextWindowUsageSnapshot | null = contextUsage
        ? {
            ...(latestUsageSnapshot ?? { compactsAutomatically: false }),
            usedTokens: contextUsage.usedTokens,
            ...(contextUsage.maxTokens !== undefined ? { maxTokens: contextUsage.maxTokens } : {}),
          }
        : latestUsageSnapshot

      const finalUsage = baseUsage
        ? {
            ...baseUsage,
            ...(baseUsage.maxTokens === undefined
              && typeof (resultContextWindow ?? lastKnownContextWindow) === "number"
              ? { maxTokens: resultContextWindow ?? lastKnownContextWindow }
              : {}),
            ...(accumulatedUsage && accumulatedUsage.usedTokens > baseUsage.usedTokens
              ? { totalProcessedTokens: accumulatedUsage.usedTokens }
              : {}),
          }
        : null

      if (finalUsage) {
        yield {
          type: "transcript",
          entry: timestamped({
            kind: "context_window_updated",
            usage: finalUsage,
          }),
        }
      }

      seenAssistantUsageIds = new Set<string>()
      latestUsageSnapshot = null
    }

    const promptIds = sdkMessage?.type === "result" ? claudeResultPromptIds(sdkMessage) : undefined
    for (const entry of normalizeClaudeStreamMessage(sdkMessage, { structuredToolIds })) {
      if (entry.kind === "tool_call" && STRUCTURED_RESULT_TOOL_KINDS.has(entry.tool.toolKind)) {
        structuredToolIds.add(entry.tool.toolId)
      }
      yield promptIds ? { type: "transcript", entry, promptIds } : { type: "transcript", entry }
    }
  }
}

/**
 * SDK hooks that back up the task stream (see background-tasks.ts).
 *
 * The stream announces every task as it starts and ends. The hooks are the
 * safety net for an end that never lands. `SubagentStop` closes a Task
 * subagent. `Stop` fires when the main agent stops and carries
 * `background_tasks`, the work still registered on the session. That is the
 * sweep: whatever it doesn't name has ended, however it ended.
 *
 * There is no `SubagentStart`: `task_started` announces the same agent under
 * the same id, with its tool call. The hook also fires for every agent a
 * workflow runs, which belong on the workflow's card, not as rows of their own.
 *
 * Every hook returns `{}`: these observe, they never block or steer the model.
 */
function subagentHooks(
  onActivity: (update: SubagentActivityUpdate) => void
): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
  const one = (hook: HookCallback): HookCallbackMatcher[] => [{ hooks: [hook] }]

  const sweep = (input: { background_tasks?: BackgroundTaskSummary[] }) => {
    onActivity({
      kind: "inFlight",
      ids: (input.background_tasks ?? []).map((task) => ({
        id: task.id,
        type: task.type,
        label: task.agent_type || task.name || task.command || task.description || task.type,
      })),
    })
  }

  return {
    SubagentStop: one(async (input) => {
      if (input.hook_event_name !== "SubagentStop") return {}
      onActivity({ kind: "stopped", id: input.agent_id, failed: false })
      return {}
    }),
    Stop: one(async (input) => {
      if (input.hook_event_name !== "Stop") return {}
      sweep(input)
      return {}
    }),
  }
}

export async function startClaudeSession(args: {
  localPath: string
  model: string
  effort?: string
  serviceTier?: "fast"
  planMode: boolean
  autoPlan: boolean
  sessionToken: string | null
  forkSession: boolean
  customTools?: KannaToolHost
  onToolRequest: (request: HarnessToolRequest) => Promise<unknown>
  onRateLimitEvent?: (info: ClaudeRateLimitInfoRaw) => void
  /**
   * Delegated work starting, progressing, finishing, or — on Stop — the
   * authoritative list of what is still in flight. Driven by the task stream
   * (background-tasks.ts) and SDK hooks (`subagentHooks`).
  */
  onSubagentActivity?: (update: SubagentActivityUpdate) => void

  onBackgroundWorkStateChange?: (state: ClaudeBackgroundWorkState) => void

}, deps = { query, resolveExecutable: resolveClaudeExecutable }): Promise<ClaudeSessionHandle> {
  const canUseTool: CanUseTool = async (toolName, input, options) => {
    if (toolName !== "AskUserQuestion" && toolName !== "ExitPlanMode") {
      return {
        behavior: "allow",
        updatedInput: input,
      }
    }

    const tool = normalizeToolCall({
      toolName,
      toolId: options.toolUseID,
      input: (input ?? {}) as Record<string, unknown>,
    })

    if (tool.toolKind !== "ask_user_question" && tool.toolKind !== "exit_plan_mode") {
      return {
        behavior: "deny",
        message: "Unsupported tool request",
      }
    }

    const result = await args.onToolRequest({ tool })

    if (tool.toolKind === "ask_user_question") {
      const record = result && typeof result === "object" ? result as Record<string, unknown> : {}
      return {
        behavior: "allow",
        updatedInput: {
          ...(tool.rawInput ?? {}),
          questions: record.questions ?? tool.input.questions,
          answers: record.answers ?? result,
        },
      } satisfies PermissionResult
    }

    const record = result && typeof result === "object" ? result as Record<string, unknown> : {}
    const confirmed = Boolean(record.confirmed)
    if (confirmed) {
      return {
        behavior: "allow",
        updatedInput: {
          ...(tool.rawInput ?? {}),
          ...record,
        },
      } satisfies PermissionResult
    }

    return {
      behavior: "deny",
      message: typeof record.message === "string"
        ? `User wants to suggest edits to the plan: ${record.message}`
        : "User wants to suggest edits to the plan before approving.",
    } satisfies PermissionResult
  }

  // The user's own `claude`, never the SDK's pinned copy (claude-executable.ts).
  const claudeExecutable = await deps.resolveExecutable()
  if (!claudeExecutable.ok) throw new Error(claudeExecutable.message)
  const promptQueue = new AsyncQueue<SDKUserMessage>()
  let promptQueueClosed = false
  const runtimeOptions = resolveClaudeRuntimeOptions(args.effort)

  const q = deps.query({
    prompt: promptQueue,
    options: {
      cwd: args.localPath,
      model: args.model,
      effort: getServerClaudeRuntimeEffort(args.model, args.effort),
      resume: args.sessionToken ?? undefined,
      forkSession: args.forkSession,
      permissionMode: args.planMode ? "plan" : "acceptEdits",
      canUseTool,
      ...(args.customTools ? {
        mcpServers: { kanna: createClaudeKannaTools(args.customTools) },
      } : {}),
      tools: claudeToolset(args.autoPlan),
      hooks: claudeSessionHooks(args),
      // By default the SDK forwards only a subagent's tool calls. Its text
      // (what it is doing, and its final report) completes the nested view
      // under the Agent row; the normalizer stamps it with parent_tool_use_id
      // like the rest.
      forwardSubagentText: true,
      settingSources: ["user", "project", "local"],
      systemPrompt: {
        type: "preset",
        preset: "claude_code",
      },
      // fastMode must go through the flag-settings layer: the CLI only allows
      // fast mode in Agent SDK sessions when flagSettings.fastMode is true,
      // and an explicit false keeps a user-level settings.json from silently
      // enabling it while the UI shows "Standard".
      settings: {
        enableWorkflows: true,
        fastMode: args.serviceTier === "fast",
        ...runtimeOptions.settings,
      },
      pathToClaudeCodeExecutable: claudeExecutable.path,
      env: (() => { const { CLAUDECODE: _, ...env } = process.env; return env })(),
    },
  })

  // Latest command list pushed via system/commands_changed; null until the
  // first push. supportedCommands() below prefers this over a q re-fetch.
  const commandsRef: { current: SlashCommand[] | null } = { current: null }
  // The first initialize response follows native resume/fork loading and
  // native session validation in the supported headless CLI (2.1.284 source
  // audited). Missing explicit resume exits before this response. Its payload
  // alone is not lineage proof, and a later reinitialize is not this barrier.
  const nativeStartup = q.initializationResult().then((): HarnessStartupOutcome => ({
    ...(args.sessionToken && claudeExecutable.version !== "2.1.284"
      ? { kind: "unknown" as const, reason: "Claude executable version has no verified pre-input native load contract" }
      : { kind: args.sessionToken ? args.forkSession ? "forked" : "resumed" : "fresh" }),
  }))
  void nativeStartup.catch(() => undefined)

  return {
    provider: "claude",
    waitForStartupOutcome: () => nativeStartup,
    // A readable version passed the minimum-version gate, and every CLI from
    // that version on echoes prompt ids. An override wrapper reports none.
    echoesPromptIds: claudeExecutable.version !== null,
    stream: createClaudeHarnessStream(q, {
      onCommandsChanged: (commands) => {
        commandsRef.current = commands
      },
      onRateLimitEvent: args.onRateLimitEvent,
      onTaskActivity: args.onSubagentActivity,
    }),
    getAccountInfo: async () => {
      try {
        return await q.accountInfo()
      } catch {
        return null
      }
    },
    getUsage: async () => {
      try {
        const anyQ = q as unknown as {
          usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET?: () => Promise<ClaudeUsageRaw>
        }
        if (typeof anyQ.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET !== "function") {
          return null
        }
        return await Promise.race([
          anyQ.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET(),
          new Promise<null>((resolve) => setTimeout(() => resolve(null), 10_000)),
        ])
      } catch {
        return null
      }
    },
    interrupt: async () => {
      await q.interrupt()
    },
    stopTask: async (taskId: string) => {
      await q.stopTask(taskId)
    },
    sendPrompt: async (content: string, promptId?: string) => {
      if (promptQueueClosed) {
        throw new Error("Cannot push to a closed queue")
      }
      promptQueue.push({
        type: "user",
        message: {
          role: "user",
          content,
        },
        parent_tool_use_id: null,
        session_id: args.sessionToken ?? "",
        ...(promptId ? { uuid: promptId as SDKUserMessage["uuid"] } : {}),
      })
    },
    setModel: async (model: string) => {
      await q.setModel(model)
    },
    setPermissionMode: async (planMode: boolean) => {
      await q.setPermissionMode(planMode ? "plan" : "acceptEdits")
    },
    setFastMode: async (fastMode: boolean) => {
      await q.applyFlagSettings({ fastMode })
    },
    supportedModels: async () => await q.supportedModels(),
    supportedCommands: async () => commandsRef.current ?? await q.supportedCommands(),
    close: () => {
      promptQueueClosed = true
      promptQueue.finish()
      q.close()
    },
  }
}

export class AgentCoordinator {
  private readonly store: EventStore
  private readonly onStateChange: (chatId?: string, options?: { immediate?: boolean }) => void
  private readonly analytics: AnalyticsReporter
  private readonly codexManager: CodexAppServerManager
  private readonly cursorManager: CursorCliManager
  private readonly grokManager: GrokCliManager
  private readonly piManager: PiAgentManager
  private readonly resolvePiConnection: () => Promise<import("./pi-agent").PiConnection | null>
  private readonly generateTitle: (
    messageContent: string,
    cwd: string,
    preferredProvider?: TitleGenerationProvider
  ) => Promise<GenerateChatTitleResult>
  private readonly startClaudeSessionFn: NonNullable<AgentCoordinatorArgs["startClaudeSession"]>
  private readonly checkSessionArtifactFn: NonNullable<AgentCoordinatorArgs["checkSessionArtifact"]>
  private reportBackgroundError: ((message: string) => void) | null = null
  private onClaudeRateLimit: ((info: ClaudeRateLimitInfoRaw) => void) | null = null
  private cursorModelCatalogApplied = false
  private grokModelCatalogApplied = false
  private codexModelCatalogRefresh: Promise<void> | null = null
  private readonly startingClaudeTurns = new Map<string, symbol>()
  private readonly claudeReadinessCommits = new Map<string, Promise<void>>()
  readonly activeTurns = new Map<string, ActiveTurn>()
  readonly drainingStreams = new Map<string, { turn: HarnessTurn }>()
  /**
   * Delegated work per chat, keyed by the provider's agent id: a log that
   * runs across turns. Finished entries stay, so the widgets can say what ran
   * whether its turn is going or over, until newer ones push them out
   * (`pruneTaskLog`). In memory only: a restart starts it empty.
   */
  private readonly subagents = new Map<string, Map<string, SubagentActivity>>()
  /**
   * Tasks the CLI called housekeeping when they started, per chat. The Stop
   * sweep lists them with everything else and can't say which they are, so
   * without this it would surface them as work.
   */
  private readonly ambientTaskIds = new Map<string, Set<string>>()
  /**
   * Foreground shells per chat, held back from the log with the time they
   * started, so one moved to the background gets its row from its real start.
   * Each leaves at its end, or at the Stop sweep, when no foreground step can
   * still be running.
   */
  private readonly foregroundTasks = new Map<string, Map<string, { task: TaskStart; startedAt: number }>>()
  readonly claudeSessions = new Map<string, ClaudeSessionState>()
  private readonly idleSessionTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private idleSessionTimeoutMs: number | null = null
  private readonly codexSteerCompletions = new Map<string, Promise<string | undefined>>()
  private readonly pendingCodexSteers = new Map<string, Set<string>>()
  private readonly cancelingChats = new Set<string>()

  constructor(args: AgentCoordinatorArgs) {
    this.store = args.store
    this.onStateChange = args.onStateChange
    this.analytics = args.analytics ?? NoopAnalyticsReporter
    this.codexManager = args.codexManager ?? new CodexAppServerManager()
    this.cursorManager = args.cursorManager ?? new CursorCliManager()
    this.grokManager = args.grokManager ?? new GrokCliManager()
    this.piManager = args.piManager ?? new PiAgentManager()
    this.resolvePiConnection = args.resolvePiConnection ?? resolvePiConnection
    this.generateTitle = args.generateTitle ?? ((messageContent, cwd, preferredProvider) =>
      generateTitleForChatDetailed(messageContent, cwd, undefined, {
        preferredProvider,
        useConfiguredProvider: false,
      }))
    this.startClaudeSessionFn = args.startClaudeSession ?? startClaudeSession
    this.checkSessionArtifactFn = args.checkSessionArtifact ?? checkSessionArtifact
  }

  setBackgroundErrorReporter(report: ((message: string) => void) | null) {
    this.reportBackgroundError = report
  }

  /** Register a sink for pushed Claude rate-limit events (usage page). */
  setClaudeRateLimitListener(listener: ((info: ClaudeRateLimitInfoRaw) => void) | null) {
    this.onClaudeRateLimit = listener
  }

  /**
   * Read Claude subscription usage on demand. Reuses a live session's query
   * when one exists; otherwise spawns a short-lived probe. Returns null when
   * unavailable (no method / timeout / not a subscription session).
   */
  async fetchClaudeUsage(): Promise<ClaudeUsageRaw | null> {
    for (const state of this.claudeSessions.values()) {
      if (state.session.getUsage) {
        const usage = await state.session.getUsage()
        if (usage) return usage
      }
    }
    let probe: ClaudeSessionHandle | null = null
    try {
      probe = await this.startClaudeSessionFn({
        localPath: homedir(),
        // Model choice is irrelevant for the usage read; use the catalog default.
        model: "sonnet",
        planMode: false,
        autoPlan: false,
        sessionToken: null,
        forkSession: false,
        onToolRequest: async () => ({}),
        onBackgroundWorkStateChange: () => {},
      })
      return (await probe.getUsage?.()) ?? null
    } catch {
      return null
    } finally {
      probe?.close()
    }
  }

  /** Read Codex account rate limits on demand (reuses a live app-server or probes). */
  async fetchCodexRateLimits() {
    return await this.codexManager.readAccountRateLimits(homedir())
  }

  async fetchGrokUsage() {
    return await fetchGrokAccountUsage()
  }

  async refreshGrokModelCatalog() {
    if (this.grokModelCatalogApplied) return
    try {
      const models = await this.grokManager.listModels()
      this.grokModelCatalogApplied = true
      if (applyGrokModels(models)) {
        this.emitStateChange(undefined, { immediate: true })
      }
    } catch {
      // grok missing or signed out — keep the static catalog.
    }
  }

  getCodexManager() {
    return this.codexManager
  }

  getResourceCounts() {
    return {
      activeTurns: this.activeTurns.size,
      drainingStreams: this.drainingStreams.size,
      claudeSessions: this.claudeSessions.size,
      ...this.codexManager.getResourceCounts(),
      ...this.piManager.getResourceCounts(),
    }
  }

  dispose() {
    this.startingClaudeTurns.clear()
    for (const active of this.activeTurns.values()) if (active.provider === "codex") {
      active.cancelRequested = true
      active.customTools?.abort()
      this.activeTurns.delete(active.chatId)
    }
    for (const session of this.claudeSessions.values()) {
      session.forceClosed = true
      session.session.close()
    }
    for (const stream of this.drainingStreams.values()) stream.turn.close()
    this.claudeSessions.clear()
    for (const chatId of [...this.idleSessionTimers.keys()]) {
      this.clearIdleSessionTimer(chatId)
    }
    for (const [chatId, active] of this.activeTurns) {
      if (!active.startupPending && !active.contextRestorationId) continue
      active.cancelRequested = true
      active.startupAbort?.abort()
      active.customTools?.abort()
      this.activeTurns.delete(chatId)
    }
    this.drainingStreams.clear()
    this.codexManager.stopAll()
    this.piManager.dispose()
  }

  setIdleSessionTimeoutMs(timeoutMs: number | null) {
    this.idleSessionTimeoutMs = typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0
      ? timeoutMs
      : null

    for (const chatId of [...this.idleSessionTimers.keys()]) {
      this.clearIdleSessionTimer(chatId)
    }

    if (this.idleSessionTimeoutMs === null) return

    for (const chatId of new Set([
      ...this.claudeSessions.keys(),
      ...this.codexManager.getSessionChatIds(),
    ])) {
      this.scheduleIdleSessionClose(chatId)
    }
  }

  getActiveStatuses() {
    const statuses = new Map<string, KannaStatus>()
    for (const [chatId, turn] of this.activeTurns.entries()) {
      statuses.set(chatId, turn.status)
    }
    return statuses
  }

  getPendingTool(chatId: string): PendingToolSnapshot | null {
    const pending = this.activeTurns.get(chatId)?.pendingTool
    if (!pending) return null
    return {
      toolUseId: pending.toolUseId,
      toolKind: pending.tool.toolKind,
      preview: getToolRequestPreview(pending.tool),
    }
  }

  getDrainingChatIds(): Set<string> {
    return new Set(this.drainingStreams.keys())
  }

  /** Delegated work for a chat, oldest first. Empty when it has spawned none. */
  getSubagents(chatId: string): SubagentActivity[] {
    const byId = this.subagents.get(chatId)
    if (!byId) return []
    return [...byId.values()].sort((a, b) => a.startedAt - b.startedAt)
  }

  /**
   * Fold one hook report into the registry.
   *
   * `inFlight` is a sweep, not an increment: anything running that the sweep
   * does not name has ended without its stop hook landing, so it is closed
   * here. That is what keeps a crashed or killed agent from pinning the chat
   * in "waiting" forever.
   */
  applySubagentActivity(chatId: string, update: SubagentActivityUpdate, now = Date.now()) {
    if (update.kind === "ambient") {
      let ambient = this.ambientTaskIds.get(chatId)
      if (!ambient) {
        ambient = new Set()
        this.ambientTaskIds.set(chatId, ambient)
      }
      ambient.add(update.id)
      return
    }
    if (update.kind === "foreground") {
      let held = this.foregroundTasks.get(chatId)
      if (!held) {
        held = new Map()
        this.foregroundTasks.set(chatId, held)
      }
      held.set(update.task.id, { task: update.task, startedAt: now })
      return
    }
    if (update.kind === "backgrounded") {
      const held = this.foregroundTasks.get(chatId)?.get(update.id)
      if (!held) return
      this.foregroundTasks.get(chatId)?.delete(update.id)
      this.applySubagentActivity(chatId, { kind: "started", ...held.task }, held.startedAt)
      return
    }
    if (update.kind === "stopped") this.foregroundTasks.get(chatId)?.delete(update.id)
    if (update.kind === "inFlight") this.foregroundTasks.delete(chatId)

    let byId = this.subagents.get(chatId)
    if (!byId) {
      byId = new Map()
      this.subagents.set(chatId, byId)
    }

    if (update.kind === "started") {
      const existing = byId.get(update.id)
      const next: SubagentActivity = {
        id: update.id,
        type: update.type,
        label: update.label,
        status: "running",
        // The Stop sweep can list a task before its start event lands, and
        // it started when the sweep first saw it, not now.
        startedAt: existing?.status === "running" ? existing.startedAt : now,
        ...(update.toolUseId ? { toolUseId: update.toolUseId } : {}),
        ...(update.description ? { description: update.description } : {}),
        ...(update.stoppable ? { stoppable: true } : {}),
        ...(update.type === "workflow"
          ? { workflow: { ...(update.workflowName ? { name: update.workflowName } : {}), phases: [], agents: [] } }
          : {}),
      }
      const workflowId = findWorkflowOf(byId, update.id)
      if (workflowId) next.workflowId = workflowId
      byId.set(update.id, next)
    } else if (update.kind === "progress") {
      let existing = byId.get(update.id)
      // A workflow already running when the session (re)attached reports
      // progress with no start before it. Its progress says what it is.
      if (!existing && update.workflow) {
        existing = { id: update.id, type: "workflow", label: "Workflow", status: "running", startedAt: now, stoppable: true }
      }
      if (!existing || existing.status !== "running") return
      const next: SubagentActivity = { ...existing }
      if (update.usage) next.usage = update.usage
      if (update.summary) next.summary = update.summary
      if (update.workflow) {
        next.workflow = { ...(existing.workflow?.name ? { name: existing.workflow.name } : {}), ...update.workflow }
        linkWorkflowAgents(byId, update.id, update.workflow.agents)
      }
      byId.set(update.id, next)
    } else if (update.kind === "stopped") {
      const existing = byId.get(update.id)
      if (!existing) return
      const reported = {
        ...(update.usage ? { usage: update.usage } : {}),
        ...(update.summary ? { summary: update.summary } : {}),
      }
      if (existing.status !== "running") {
        // Two reports can end one task (task_updated, then the notification
        // with its totals), or the sweep can close it first. The outcome and
        // time already stand; the totals are still worth having.
        if (!update.usage && !update.summary) return
        byId.set(update.id, { ...existing, ...reported })
      } else {
        const status = update.stopped ? "stopped" : update.failed ? "failed" : "completed"
        byId.set(update.id, finishActivity({ ...existing, ...reported }, status, now))
      }
    } else {
      const named = new Set(update.ids.map((task) => task.id))
      const ambient = this.ambientTaskIds.get(chatId)
      for (const task of update.ids) {
        if (ambient?.has(task.id)) continue
        const existing = byId.get(task.id)
        // The sweep also *discovers* work whose start event never reached
        // us, so Stop is the first we hear of it.
        if (!existing) {
          byId.set(task.id, { id: task.id, type: task.type, label: task.label, status: "running", startedAt: now })
        } else if (existing.status !== "running") {
          byId.set(task.id, { ...existing, status: "running", endedAt: undefined })
        }
      }
      for (const [id, activity] of byId) {
        if (activity.status === "running" && !named.has(id)) {
          byId.set(id, finishActivity(activity, "completed", now))
        }
      }
    }

    pruneTaskLog(byId)
    this.emitStateChange(chatId)
  }

  /**
   * Stops one background task without cancelling the turn: the Stop in a
   * Tasks row's menu, or on a workflow's card. The CLI answers with the
   * task's end, reported as `stopped`, which is what updates the row.
   */
  async stopBackgroundTask(chatId: string, taskId: string) {
    const task = this.subagents.get(chatId)?.get(taskId)
    if (!task || task.status !== "running") return
    const stopTask = this.claudeSessions.get(chatId)?.session.stopTask
    if (!task.stoppable || !stopTask) {
      throw new Error("This task can't be stopped on its own. Stop the chat to end it.")
    }
    await stopTask(taskId)
  }

  /**
   * Derive delegated work from the transcript, for providers with no hook
   * equivalent (Codex, Grok — both normalize their spawn call to
   * `subagent_task`). Weaker than Claude's hooks: a subagent is "running" from
   * its tool call until its tool result, which is all these providers report.
   *
   * Claude is deliberately excluded. Its hooks key on `agent_id` while the tool
   * call keys on `toolId`, so running both would list every agent twice.
   */
  private trackSubagentFromEntry(chatId: string, entry: TranscriptEntry) {
    if (this.activeTurns.get(chatId)?.provider === "claude") return
    if (entry.kind === "tool_call" && entry.tool.toolKind === "subagent_task") {
      const input = entry.tool.input as { subagentType?: unknown; description?: unknown }
      const label = typeof input.subagentType === "string" && input.subagentType
        ? input.subagentType
        : typeof input.description === "string" && input.description
          ? input.description
          : "Agent"
      this.applySubagentActivity(chatId, { kind: "started", id: entry.tool.toolId, type: "subagent", label })
      return
    }
    if (entry.kind === "tool_result" && this.subagents.get(chatId)?.has(entry.toolId)) {
      this.applySubagentActivity(chatId, { kind: "stopped", id: entry.toolId, failed: Boolean(entry.isError) })
    }
  }

  /**
   * Close everything still marked running, as failed: it was cut off, not
   * finished. For when the turn ends without the Stop hook's sweep — an
   * interrupt, or a Claude session that died — which would otherwise leave
   * the chat showing agents running forever.
   */
  private closeRunningSubagents(chatId: string, now = Date.now()) {
    const byId = this.subagents.get(chatId)
    if (!byId) return
    let changed = false
    for (const [id, activity] of byId) {
      if (activity.status !== "running") continue
      byId.set(id, finishActivity(activity, "failed", now))
      changed = true
    }
    if (changed) this.emitStateChange(chatId)
  }

  getPendingCodexSteerIds(chatId: string): Set<string> {
    return new Set(this.pendingCodexSteers.get(chatId) ?? [])
  }

  private emitStateChange(chatId?: string, options?: { immediate?: boolean }) {
    this.onStateChange(chatId, options)
  }

  private refreshClaudeModelCatalog(session: ClaudeSessionHandle) {
    if (!session.supportedModels) return
    void session.supportedModels()
      .then((models) => {
        if (applyClaudeSdkModels(models)) {
          this.emitStateChange(undefined, { immediate: true })
        }
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error)
        this.reportBackgroundError?.(`[claude-models] failed to refresh Claude model catalog: ${message}`)
      })
  }

  /**
   * Overlay the account's live Cursor model list (`cursor-agent --list-models`)
   * on the catalog — the Cursor analog of refreshClaudeModelCatalog. Runs at
   * server startup and retries on cursor turns until one fetch succeeds (e.g.
   * the user logs in to cursor-agent while the server is running). Failure is
   * expected — cursor-agent missing or logged out — so it stays quiet and the
   * static catalog remains in place.
   */
  async refreshCursorModelCatalog() {
    if (this.cursorModelCatalogApplied) return
    try {
      const models = await this.cursorManager.listModels()
      this.cursorModelCatalogApplied = true
      if (applyCursorModels(models)) {
        this.emitStateChange(undefined, { immediate: true })
      }
    } catch {
      // Keep the static fallback catalog; the next cursor turn retries.
    }
  }

  /**
   * Overlay the account's live Codex model list (app-server `model/list`) on
   * the catalog — the Codex analog of refreshCursorModelCatalog. Unlike the
   * Cursor one this runs on every codex turn, not once: OpenAI adds models to
   * an account without a codex upgrade, and the turn's own app-server process
   * answers the request, so the repeat costs no extra spawn. Startup and
   * sign-in go through a short-lived probe. Failure is expected — codex
   * missing, signed out, or too old for model/list — so it stays quiet and
   * the static catalog remains in place. Concurrent callers share one fetch.
   */
  refreshCodexModelCatalog(): Promise<void> {
    if (this.codexModelCatalogRefresh) return this.codexModelCatalogRefresh
    this.codexModelCatalogRefresh = (async () => {
      try {
        const models = await this.codexManager.listModels(homedir())
        if (models && applyCodexModels(models)) {
          this.emitStateChange(undefined, { immediate: true })
        }
      } catch {
        // Keep the static fallback catalog; the next codex turn retries.
      } finally {
        this.codexModelCatalogRefresh = null
      }
    })()
    return this.codexModelCatalogRefresh
  }


  async stopDraining(chatId: string) {
    const draining = this.drainingStreams.get(chatId)
    if (!draining) return
    draining.turn.close()
    this.drainingStreams.delete(chatId)
    this.emitStateChange(chatId)
  }

  async closeChat(chatId: string) {
    this.clearIdleSessionTimer(chatId)
    this.startingClaudeTurns.delete(chatId)
    const startup = this.activeTurns.get(chatId)
    if (startup && (startup.startupPending || startup.contextRestorationId)) {
      startup.cancelRequested = true
      startup.startupAbort?.abort()
      startup.customTools?.abort()
      this.activeTurns.delete(chatId)
    }
    const steerOwner = this.activeTurns.get(chatId)
    if (steerOwner?.provider === "codex") {
      steerOwner.cancelRequested = true
      steerOwner.customTools?.abort()
      this.activeTurns.delete(chatId)
    }
    await this.stopDraining(chatId)
    const claudeSession = this.claudeSessions.get(chatId)
    if (claudeSession) {
      claudeSession.forceClosed = true
      claudeSession.session.close()
      this.claudeSessions.delete(chatId)
    }
    this.piManager.closeChat(chatId)
    this.codexManager.stopSession(chatId)
    this.emitStateChange(chatId)
  }

  private clearIdleSessionTimer(chatId: string) {
    const timer = this.idleSessionTimers.get(chatId)
    if (!timer) return
    clearTimeout(timer)
    this.idleSessionTimers.delete(chatId)
  }

  private isIdleSessionCloseEligible(chatId: string) {
    if (this.activeTurns.has(chatId) || this.startingClaudeTurns.has(chatId)
      || this.claudeReadinessCommits.has(chatId) || this.drainingStreams.has(chatId)) return false

    const claudeSession = this.claudeSessions.get(chatId)
    if (claudeSession) {
      return claudeSession.backgroundWorkState === "inactive"
    }

    return this.codexManager.hasSession(chatId)
  }

  private updateClaudeBackgroundWorkState(
    chatId: string,
    sessionInstanceId: string,
    state: ClaudeBackgroundWorkState
  ) {
    const session = this.claudeSessions.get(chatId)
    if (!session || session.id !== sessionInstanceId) return

    session.backgroundWorkState = state
    this.scheduleIdleSessionClose(chatId)
  }

  private scheduleIdleSessionClose(chatId: string) {
    this.clearIdleSessionTimer(chatId)
    if (this.idleSessionTimeoutMs === null) return
    if (!this.isIdleSessionCloseEligible(chatId)) return

    const timer = setTimeout(() => {
      this.idleSessionTimers.delete(chatId)
      if (!this.isIdleSessionCloseEligible(chatId)) return
      void this.closeChat(chatId)
    }, this.idleSessionTimeoutMs)
    this.idleSessionTimers.set(chatId, timer)
  }

  /**
   * An explicit provider on the message wins — sending with a different
   * provider than the chat's current one performs a mid-conversation harness
   * switch (fresh session + handoff context, see prepareProviderHandoff).
   */
  private resolveProvider(options: SendMessageOptions, currentProvider: AgentProvider | null) {
    return options.provider ?? currentProvider ?? "claude"
  }

  private getProviderSettings(provider: AgentProvider, options: SendMessageOptions) {
    const catalog = getServerProviderCatalog(provider)
    if (provider === "claude") {
      const model = normalizeServerModel(provider, options.model)
      const modelOptions = normalizeClaudeModelOptions(model, options.modelOptions, options.effort)
      return {
        model: resolveClaudeApiModelId(model, modelOptions.contextWindow),
        effort: modelOptions.reasoningEffort,
        serviceTier: serviceTierFromModelOptions(modelOptions),
        planMode: catalog.supportsPlanMode ? Boolean(options.planMode) : false,
        autoPlan: catalog.supportsAutoPlanMode ? Boolean(options.autoPlan) : false,
      }
    }

    if (provider === "cursor") {
      const modelOptions = normalizeCursorModelOptions(options.modelOptions)
      return {
        model: cursorModelIdForOptions(normalizeServerModel(provider, options.model), modelOptions),
        effort: undefined,
        serviceTier: undefined,
        planMode: false,
        autoPlan: false,
      }
    }

    if (provider === "grok") {
      const modelOptions = normalizeGrokModelOptions(options.modelOptions, options.effort)
      return {
        model: normalizeServerModel(provider, options.model),
        effort: modelOptions.reasoningEffort,
        serviceTier: undefined,
        planMode: catalog.supportsPlanMode ? Boolean(options.planMode) : false,
        autoPlan: false,
      }
    }

    if (provider === "pi") {
      const modelOptions = normalizePiModelOptions(options.modelOptions, options.effort)
      return {
        model: normalizeServerModel(provider, options.model),
        effort: modelOptions.reasoningEffort,
        serviceTier: undefined,
        planMode: false,
        autoPlan: false,
      }
    }

    const model = normalizeServerModel(provider, options.model)
    const modelOptions = normalizeCodexModelOptions(model, options.modelOptions, options.effort)
    return {
      model,
      effort: modelOptions.reasoningEffort,
      serviceTier: serviceTierFromModelOptions(modelOptions),
      planMode: catalog.supportsPlanMode ? Boolean(options.planMode) : false,
      autoPlan: catalog.supportsAutoPlanMode ? Boolean(options.autoPlan) : false,
    }
  }

  private async enqueueMessage(chatId: string, content: string, attachments: ChatAttachment[], options?: SendMessageOptions) {
    const queued = await this.store.enqueueMessage(chatId, {
      content,
      attachments,
      provider: options?.provider,
      model: options?.model,
      modelOptions: options?.modelOptions,
      planMode: options?.planMode,
      autoPlan: options?.autoPlan,
    })
    this.emitStateChange(chatId)
    return queued
  }

  private hasPendingCodexSteer(chatId: string, queuedMessageId?: string) {
    const pending = this.pendingCodexSteers.get(chatId)
    return queuedMessageId ? Boolean(pending?.has(queuedMessageId)) : Boolean(pending?.size)
  }

  private beginCodexSteer(chatId: string, queuedMessageId: string) {
    let pending = this.pendingCodexSteers.get(chatId)
    if (!pending) {
      pending = new Set()
      this.pendingCodexSteers.set(chatId, pending)
    }
    if (pending.has(queuedMessageId)) {
      throw new Error("Queued message is already being steered")
    }
    pending.add(queuedMessageId)
    let complete!: (error?: string) => void
    const completion = new Promise<string | undefined>((resolve) => { complete = resolve })
    this.codexSteerCompletions.set(chatId, completion)
    this.emitStateChange(chatId)

    let ended = false
    return (error?: string) => {
      if (ended) return
      ended = true
      pending?.delete(queuedMessageId)
      if (pending?.size === 0) {
        this.pendingCodexSteers.delete(chatId)
      }
      if (this.codexSteerCompletions.get(chatId) === completion) this.codexSteerCompletions.delete(chatId)
      complete(error)
      this.emitStateChange(chatId)
    }
  }

  private async dequeueAndStartQueuedMessage(chatId: string, queuedMessage: QueuedChatMessage, options?: { steered?: boolean }) {
    const chat = this.store.requireChat(chatId)
    const provider = this.resolveProvider(queuedMessage, chat.provider)
    const start = async (startupReservation?: symbol) => {
      if (startupReservation && this.startingClaudeTurns.get(chatId) !== startupReservation) return
      const alreadyPersisted = this.store.getMessages(chatId).some((entry) => (
        entry.kind === "user_prompt" && entry._id === queuedMessage.id
      ))
      await this.store.removeQueuedMessage(chatId, queuedMessage.id)
      if (alreadyPersisted) {
        this.emitStateChange(chatId)
        return
      }
      const settings = this.getProviderSettings(provider, queuedMessage)
      await this.startTurnForChat({
        chatId,
        provider,
        content: queuedMessage.content,
        attachments: queuedMessage.attachments,
        model: settings.model,
        effort: settings.effort,
        serviceTier: settings.serviceTier,
        planMode: settings.planMode,
        autoPlan: settings.autoPlan,
        appendUserPrompt: true,
        steered: options?.steered,
        startupReservation,
      })
    }
    if (provider === "claude") await this.withClaudeStartupReservation(chatId, start)
    else await start()
  }

  private async maybeStartNextQueuedMessage(chatId: string) {
    if (this.activeTurns.has(chatId) || this.hasPendingCodexSteer(chatId) || this.startingClaudeTurns.has(chatId)) return false
    const nextQueuedMessage = typeof this.store.getQueuedMessages === "function"
      ? this.store.getQueuedMessages(chatId)[0]
      : undefined
    if (!nextQueuedMessage) return false
    await this.dequeueAndStartQueuedMessage(chatId, nextQueuedMessage)
    return true
  }

  /**
   * Other chats with an active turn in the same project directory as
   * `localPath` (matched by path, not project id, so two Kanna projects
   * pointing at the same directory still see each other). Draining streams
   * are excluded — those turns are winding down, not doing new work.
   */
  private collectConcurrentProjectChats(chatId: string, localPath: string): ConcurrentProjectChat[] {
    const chats: ConcurrentProjectChat[] = []
    for (const activeChatId of this.activeTurns.keys()) {
      if (activeChatId === chatId) continue
      const chat = this.store.getChat(activeChatId)
      if (!chat) continue
      const project = this.store.getProject(chat.projectId)
      if (!project || project.localPath !== localPath) continue
      chats.push({ title: chat.title, transcriptPath: this.store.getTranscriptPath(activeChatId) })
    }
    return chats
  }

  /** Retire every cached provider owner before intentionally starting fresh. */
  private async retireProviderContext(chatId: string, clearTokens: boolean, writeOwned: <T>(operation: () => Promise<T>) => Promise<T>) {
    const claudeSession = this.claudeSessions.get(chatId)
    if (claudeSession) {
      claudeSession.session.close()
      this.claudeSessions.delete(chatId)
    }
    this.codexManager.stopSession(chatId)
    this.piManager.closeChat(chatId)
    if (clearTokens) {
      await writeOwned(() => this.store.setSessionToken(chatId, null))
      await writeOwned(() => this.store.setPendingForkSessionToken(chatId, null))
    }
  }

  /**
   * A missing artifact is sufficient loss evidence only when the next turn
   * really requires a cold native load. A usable warm Claude handle does not
   * depend on its file. Artifact presence is never used as resume proof;
   * Codex and Pi report their actual load outcome before the first input.
   */
  private async hasMissingProviderArtifact(args: {
    chatId: string
    provider: AgentProvider
    cwd: string
    model: string
    serviceTier?: "fast"
    effort?: string
    autoPlan: boolean
    forkSession: boolean
    resetSession?: boolean
    sessionToken: string | null | undefined
    pendingForkSessionToken: string | null | undefined
  }): Promise<boolean> {
    switch (args.provider) {
      case "claude": {
        const warm = this.claudeSessions.get(args.chatId)
        if (warm && warm.localPath === args.cwd && warm.effort === args.effort
          && warm.autoPlan === args.autoPlan && !args.forkSession && !args.resetSession) return false
        const token = args.pendingForkSessionToken ?? args.sessionToken
        return this.checkSessionArtifactFn("claude", { cwd: args.cwd, sessionToken: token }) === "missing"
      }
      case "cursor":
        return this.checkSessionArtifactFn("cursor", { cwd: args.cwd, sessionToken: args.sessionToken }) === "missing"
      case "grok":
        return this.checkSessionArtifactFn("grok", {
          cwd: args.cwd,
          sessionToken: args.pendingForkSessionToken ?? args.sessionToken,
        }) === "missing"
      default:
        return false
    }
  }

  private async interruptAndCloseTurn(turn: HarnessTurn | null) {
    if (!turn) return
    try {
      await Promise.race([
        turn.interrupt(),
        new Promise((resolve) => setTimeout(resolve, 5_000)),
      ])
    } catch {
      // interrupt() failed; close below is the best-effort cleanup path.
    }
    turn.close()
  }


  private async withClaudeStartupReservation<TResult>(chatId: string, start: (reservation: symbol) => Promise<TResult>): Promise<TResult> {
    if (this.startingClaudeTurns.has(chatId)) throw new Error("Chat is already starting")
    const reservation = Symbol(chatId)
    this.startingClaudeTurns.set(chatId, reservation)
    try {
      const pendingCommit = this.claudeReadinessCommits.get(chatId)
      if (pendingCommit) await pendingCommit
      return await start(reservation)
    } finally {
      if (this.startingClaudeTurns.get(chatId) === reservation) this.startingClaudeTurns.delete(chatId)
    }
  }

  private async prepareProviderContext(args: {
    previousProvider: AgentProvider | null
    chatId: string
    provider: AgentProvider
    cwd: string
    model: string
    serviceTier?: "fast"
    effort?: string
    autoPlan: boolean
    sessionToken?: string | null
    pendingForkSessionToken?: string | null
    forkSession?: boolean
    resetSession?: boolean
    initialEndExclusive: number
    restorationEntries?: readonly TranscriptEntry[]
    clearTokens?: boolean
    awaitOwned: <T>(operation: () => Promise<T>) => Promise<T>
    writeOwned: <T>(operation: () => Promise<T>) => Promise<T>
    appendBoundary?: (entry: TranscriptEntry) => Promise<void>
  }) {
    const chat = this.store.requireChat(args.chatId)
    const initialBounds = this.store.getContextBounds(args.chatId, args.initialEndExclusive)
    const endExclusive = args.restorationEntries?.length ?? args.initialEndExclusive
    const hasConversation = args.restorationEntries
      ? args.restorationEntries.some(entry => ["user_prompt", "assistant_text", "tool_call", "tool_result"].includes(entry.kind))
      : initialBounds.hasConversation
    let restoration = chat.contextRestoration ?? null
    if (restoration) {
      restoration = { ...restoration, id: crypto.randomUUID(), provider: args.provider,
        reason: restoration.provider !== args.provider
          ? restoration.fromProvider === args.provider ? "session_restore" : "provider_switch" : restoration.reason,
        endExclusive }
      await args.writeOwned(() => this.store.setContextRestoration(args.chatId, restoration))
    }
    const ensureRestoration = async (reason: ContextRestoration["reason"], fromProvider: AgentProvider) => {
      if (!hasConversation) return
      if (!restoration || restoration.provider !== args.provider) {
        restoration = { id: crypto.randomUUID(), provider: args.provider, fromProvider, reason, endExclusive }
        await args.writeOwned(() => this.store.setContextRestoration(args.chatId, restoration))
      }
    }
    const switchingProvider = args.previousProvider !== null && args.previousProvider !== args.provider
    if (switchingProvider) await ensureRestoration("provider_switch", args.previousProvider!)
    let forceFreshContext = switchingProvider || restoration?.provider === args.provider
    const prepareStartup = async () => {
      const missingArtifact = !switchingProvider && args.previousProvider !== null && await args.awaitOwned(() => this.hasMissingProviderArtifact({
        chatId: args.chatId, provider: args.provider, cwd: args.cwd, model: args.model,
        serviceTier: args.serviceTier, effort: args.effort, autoPlan: args.autoPlan,
        forkSession: args.forkSession ?? Boolean(chat.pendingForkSessionToken), resetSession: args.resetSession,
        sessionToken: args.sessionToken !== undefined ? args.sessionToken : chat.pendingForkSessionToken ?? chat.sessionToken,
        pendingForkSessionToken: null,
      }))
      if (missingArtifact) await ensureRestoration("session_restore", args.provider)
      forceFreshContext = switchingProvider || missingArtifact || restoration?.provider === args.provider
      if (forceFreshContext) await this.retireProviderContext(args.chatId, args.clearTokens ?? true, args.writeOwned)
    }
    let existingMessagesCache: ReturnType<typeof this.store.getMessages> | null = null
    return {
      get forceFreshContext() { return forceFreshContext },
      prepareStartup,
      restorationId: (): string | undefined => restoration?.id,
      prepareContent: async (content: string, outcome: HarnessStartupOutcome) => {
        if (outcome.kind === "fresh"
          || (args.provider === "cursor" && (forceFreshContext || !chat.sessionToken))
          || (args.provider === "grok" && (forceFreshContext || !(chat.pendingForkSessionToken ?? chat.sessionToken)))) {
          await ensureRestoration("session_restore", args.provider)
        }
        const appendBoundary = args.appendBoundary ?? ((entry: TranscriptEntry) => args.writeOwned(() => this.store.appendMessage(args.chatId, entry)))
        if (restoration) {
          const entries = args.restorationEntries ?? (hasConversation
            ? (existingMessagesCache ??= this.store.getMessages(args.chatId)).slice(0, restoration.endExclusive) : [])
          let contextStart = args.restorationEntries && (restoration.startInclusive ?? 0) > entries.length
            ? 0 : restoration.startInclusive ?? 0
          entries.forEach((entry, index) => { if (entry.kind === "context_cleared") contextStart = Math.max(contextStart, index + 1) })
          const context = buildHandoffContext({ entries: entries.slice(contextStart), fromProvider: restoration.fromProvider,
            toProvider: args.provider, reason: restoration.reason === "session_restore" ? "session_restore" : undefined,
            transcriptPath: contextStart === 0 && !args.restorationEntries ? this.store.getTranscriptPath(args.chatId) : undefined })
          if (context || restoration.reason !== "explicit_reset") await appendBoundary(
            timestamped(restoration.reason === "provider_switch"
              ? { kind: "handoff_boundary", fromProvider: restoration.fromProvider, toProvider: args.provider, ...(context ? { stats: context.stats } : {}) }
              : { kind: "session_restored", provider: args.provider, ...(context ? { stats: context.stats } : {}) }))
          return { content: context ? buildHandoffMessageContent(context.text, content) : content, restored: Boolean(context) }
        }
        if (switchingProvider) await appendBoundary(timestamped({ kind: "handoff_boundary", fromProvider: args.previousProvider!, toProvider: args.provider }))
        return { content, restored: false }
      },
    }
  }

  private async startTurnForChat(args: {
    chatId: string
    provider: AgentProvider
    content: string
    attachments: ChatAttachment[]
    model: string
    effort?: string
    serviceTier?: "fast"
    planMode: boolean
    autoPlan: boolean
    appendUserPrompt: boolean
    steered?: boolean
    sessionToken?: string | null
    pendingForkSessionToken?: string | null
    forkSession?: boolean
    resetSession?: boolean
    /** A caller may restrict restoration to an admissible local prefix. */
    restorationEntries?: readonly TranscriptEntry[]
    onProviderReady?: (isCurrentTurn: () => boolean, outcome: HarnessStartupOutcome) => Promise<void>
    startupReservation?: symbol
  }) {
    if (args.startupReservation) {
      if (this.startingClaudeTurns.get(args.chatId) !== args.startupReservation) throw new Error("Chat startup reservation was replaced")
      return await this.startReservedTurnForChat(args)
    }
    if (this.startingClaudeTurns.has(args.chatId)) throw new Error("Chat is already starting")
    return await this.withClaudeStartupReservation(args.chatId, reservation =>
      this.startReservedTurnForChat({ ...args, startupReservation: reservation }))
  }

  private async startReservedTurnForChat(args: Parameters<AgentCoordinator["startTurnForChat"]>[0]) {
    this.clearIdleSessionTimer(args.chatId)
    if (args.startupReservation && this.startingClaudeTurns.get(args.chatId) !== args.startupReservation) return
    const chat = this.store.requireChat(args.chatId)
    if (this.activeTurns.has(args.chatId)) throw new Error("Chat is already running")
    const draining = this.drainingStreams.get(args.chatId)
    if (draining) {
      draining.turn.close()
      this.drainingStreams.delete(args.chatId)
    }
    const active: ActiveTurn = {
      chatId: args.chatId, provider: args.provider, turn: null,
      model: args.model, effort: args.effort, serviceTier: args.serviceTier,
      planMode: args.planMode, autoPlan: args.autoPlan, status: "starting",
      pendingTool: null, postToolFollowUp: null, hasFinalResult: false,
      cancelRequested: false, cancelRecorded: false, startupPending: true, startupAbort: new AbortController(),
    }
    this.activeTurns.set(args.chatId, active)
    this.startingClaudeTurns.delete(args.chatId)
    this.emitStateChange(args.chatId, { immediate: true })
    const isCurrentTurn = () => !active.cancelRequested && this.activeTurns.get(args.chatId) === active
    const staleStartup = new Error("Chat startup was cancelled or replaced")
    const assertCurrent = () => { if (!isCurrentTurn()) throw staleStartup }
    const awaitOwned = async <T>(operation: () => Promise<T>): Promise<T> => {
      assertCurrent()
      const result = await operation()
      assertCurrent()
      return result
    }
    // Native loading does not hold this drain. Only writes already in flight
    // must finish before a successor can read or change the durable state.
    const writeOwned = async <T>(operation: () => Promise<T>): Promise<T> => {
      assertCurrent()
      let release!: () => void
      const commit = new Promise<void>(resolve => { release = resolve })
      const ownsDrain = !this.claudeReadinessCommits.has(args.chatId)
      if (ownsDrain) this.claudeReadinessCommits.set(args.chatId, commit)
      try { return await awaitOwned(operation) } finally {
        if (ownsDrain && this.claudeReadinessCommits.get(args.chatId) === commit) this.claudeReadinessCommits.delete(args.chatId)
        release()
      }
    }
    let markToolsReady!: () => void
    const toolsReady = new Promise<void>(resolve => { markToolsReady = resolve })
    active.toolsReady = toolsReady
    let turn: HarnessTurn | undefined
    let createdClaudeSession = false
    let contentPrepared = false

    const previousProvider = chat.provider

    let userPromptEntry: TranscriptEntry | null = null
    let userPromptWritten = false
    let turnStartedRecorded = false
    const writeUserPrompt = async () => {
      if (!args.appendUserPrompt || userPromptWritten) return
      userPromptEntry ??= timestamped({ kind: "user_prompt", content: args.content,
        attachments: args.attachments, steered: args.steered }, Date.now())
      await writeOwned(() => this.store.appendMessage(args.chatId, userPromptEntry!))
      userPromptWritten = true
    }
    const recordTurnStarted = async () => {
      if (turnStartedRecorded) return
      await writeOwned(() => this.store.recordTurnStarted(args.chatId, args.model))
      turnStartedRecorded = true
    }

    try {
      const previousProvider = chat.provider
      const initialBounds = this.store.getContextBounds(args.chatId)
      const project = this.store.getProject(chat.projectId)
      if (!project) throw new Error("Project not found")
      const context = await awaitOwned(() => this.prepareProviderContext({
        previousProvider, chatId: args.chatId, provider: args.provider, cwd: project.localPath,
        model: args.model, serviceTier: args.serviceTier, effort: args.effort, autoPlan: args.autoPlan,
        sessionToken: args.sessionToken, pendingForkSessionToken: args.pendingForkSessionToken,
        forkSession: args.forkSession, resetSession: args.resetSession,
        initialEndExclusive: initialBounds.endExclusive, restorationEntries: args.restorationEntries,
        awaitOwned, writeOwned,
      }))
      active.contextRestorationId = context.restorationId()
      if (chat.provider !== args.provider) await writeOwned(() => this.store.setChatProvider(args.chatId, args.provider))
      await writeOwned(() => this.store.setPlanMode(args.chatId, args.planMode))
      await writeOwned(() => this.store.setAutoPlan(args.chatId, args.autoPlan))
      const shouldGenerateTitle = args.appendUserPrompt && chat.title === "New Chat" && initialBounds.endExclusive === 0
      const optimisticTitle = shouldGenerateTitle ? fallbackTitleFromMessage(args.content) : null
      if (optimisticTitle) await writeOwned(() => this.store.renameChat(args.chatId, optimisticTitle, { markTitleOverride: false }))
      await awaitOwned(context.prepareStartup)
      active.contextRestorationId = context.restorationId()
      const forceFreshContext = context.forceFreshContext
      assertCurrent()
    if (shouldGenerateTitle) {
      void this.generateTitleInBackground(
        args.chatId,
        args.content,
        project.localPath,
        optimisticTitle ?? "New Chat",
        args.provider
      )
    }

      let claudeNativeSessionId: string | undefined
      const ownsNativeToolSession = () => args.provider !== "claude"
      || (claudeNativeSessionId ? this.claudeSessions.get(args.chatId)?.id === claudeNativeSessionId : isCurrentTurn())
      const ownsToolRequest = (owner: ActiveTurn) => !owner.cancelRequested
      && owner.provider === args.provider && this.activeTurns.get(args.chatId) === owner && ownsNativeToolSession()
      const onToolRequest = async (request: HarnessToolRequest) => {
      // Claude's native query retains its callbacks across user turns.
      const owner = args.provider === "claude" ? this.activeTurns.get(args.chatId) : active
      if (!owner || !ownsToolRequest(owner)) throw staleStartup
      await owner.toolsReady
      if (!ownsToolRequest(owner)) throw staleStartup
      return this.requestToolInput(args.chatId, request)
    }
      const customTools: KannaToolHost = {
        execute: async (name, input, signal) => {
          await toolsReady
          const owner = this.activeTurns.get(args.chatId)
          if (!owner || !ownsToolRequest(owner)) return { content: [{ type: "text", text: "Chat turn ended" }], isError: true }
          await owner.toolsReady
          if (!ownsToolRequest(owner)) return { content: [{ type: "text", text: "Chat turn ended" }], isError: true }
          owner.customTools ??= new KannaToolRuntime({
            chatId: args.chatId, cwd: project.localPath, dataDir: this.store.dataDir,
            emit: async entry => {
              if (!ownsToolRequest(owner)) throw staleStartup
              await this.store.appendMessage(args.chatId, entry)
              if (ownsToolRequest(owner)) this.emitStateChange(args.chatId)
            },
            requestInput: (request, callSignal) => {
              if (!ownsToolRequest(owner)) throw staleStartup
              return this.requestToolInput(args.chatId, request, callSignal)
            },
          })
          return owner.customTools.execute(name, input, signal)
        },
      }
      const skills = await awaitOwned(() => this.resolvePromptSkills(args.provider, args.chatId, args.content))
      let wireContent = args.steered ? buildSteeredMessageContent(args.content) : args.content
      if (args.provider !== "codex" && skills.length > 0) wireContent = appendSystemMessageBlock(wireContent, buildSkillSystemMessage(skills))
      const concurrentAgentsNotice = buildConcurrentAgentsNotice(this.collectConcurrentProjectChats(args.chatId, project.localPath))
      if (concurrentAgentsNotice) wireContent = appendSystemMessageBlock(wireContent, concurrentAgentsNotice)
      const actualStartup: { outcome: HarnessStartupOutcome } = { outcome: { kind: "unknown", reason: "provider did not prepare an input" } }
      const prepareWireContent = async (outcome: HarnessStartupOutcome) => {
        assertCurrent()
        if (contentPrepared) return wireContent
        actualStartup.outcome = outcome
        const prepared = await awaitOwned(() => context.prepareContent(wireContent, outcome))
        wireContent = prepared.content
        active.contextRestorationId = context.restorationId()
        contentPrepared = true
        await writeUserPrompt()
        await recordTurnStarted()
        return wireContent
      }
      let shouldClearPendingForkSessionToken = false
      if (args.provider === "claude") {
        const startedTurn = await this.startClaudeTurn({ chatId: args.chatId, localPath: project.localPath,
          model: args.model, effort: args.effort, serviceTier: args.serviceTier, planMode: args.planMode, autoPlan: args.autoPlan,
          sessionToken: forceFreshContext ? null : args.sessionToken !== undefined ? args.sessionToken : chat.pendingForkSessionToken ?? chat.sessionToken,
          forkSession: forceFreshContext ? false : args.forkSession ?? Boolean(chat.pendingForkSessionToken),
          resetSession: forceFreshContext || args.resetSession, onToolRequest, customTools, isCurrentTurn })
        if (!startedTurn) return
        turn = startedTurn
        createdClaudeSession = startedTurn.createdSession
        claudeNativeSessionId = this.claudeSessions.get(args.chatId)?.id
        active.turn = turn
        assertCurrent()
        await prepareWireContent(turn.startupOutcome ?? { kind: "unknown", reason: "Claude SDK has no pre-input resume acknowledgement" })
      } else if (args.provider === "cursor") {
        await prepareWireContent({ kind: "unknown", reason: "Cursor print CLI has no pre-input load acknowledgement" })
        void this.refreshCursorModelCatalog()
        turn = await this.cursorManager.startTurn({ cwd: project.localPath, customTools, content: buildPromptText(wireContent, args.attachments),
          model: args.model, sessionToken: forceFreshContext ? null : chat.sessionToken })
        active.turn = turn
        assertCurrent()
      } else if (args.provider === "grok") {
        await prepareWireContent({ kind: "unknown", reason: "Grok print CLI has no pre-input load acknowledgement" })
        void this.refreshGrokModelCatalog()
        turn = await this.grokManager.startTurn({ cwd: project.localPath, content: buildPromptText(wireContent, args.attachments), model: args.model,
          effort: args.effort, planMode: args.planMode, sessionToken: forceFreshContext ? null : chat.pendingForkSessionToken ?? chat.sessionToken,
          forkSession: forceFreshContext ? false : Boolean(chat.pendingForkSessionToken), onToolRequest })
        active.turn = turn
        assertCurrent()
      } else if (args.provider === "pi") {
        const connection = await awaitOwned(() => this.resolvePiConnection())
        turn = await this.piManager.startTurn({ chatId: args.chatId, cwd: project.localPath, customTools,
          content: buildPromptText(wireContent, args.attachments),
          prepareContent: async outcome => buildPromptText(await prepareWireContent(outcome), args.attachments),
          isCurrentTurn, model: args.model, effort: normalizePiModelOptions(undefined, args.effort).reasoningEffort,
          sessionToken: forceFreshContext ? null : chat.pendingForkSessionToken ?? chat.sessionToken,
          forkSession: forceFreshContext ? false : Boolean(chat.pendingForkSessionToken), connection })
        active.turn = turn
        assertCurrent()
      } else {
        const pendingForkSessionToken = forceFreshContext ? null : args.pendingForkSessionToken !== undefined ? args.pendingForkSessionToken : chat.pendingForkSessionToken
        const started = await this.codexManager.startSession({ chatId: args.chatId, cwd: project.localPath, customTools,
          model: args.model, serviceTier: args.serviceTier,
          sessionToken: forceFreshContext ? null : args.sessionToken !== undefined ? args.sessionToken : chat.sessionToken,
          pendingForkSessionToken, isCurrentTurn, signal: active.startupAbort?.signal })
        assertCurrent()
        await prepareWireContent(started?.startupOutcome ?? (started?.resumeFellBack ? { kind: "fresh" } : { kind: "unknown", reason: "adapter did not report actual startup" }))
        shouldClearPendingForkSessionToken = Boolean(pendingForkSessionToken && started?.sessionToken)
        void this.refreshCodexModelCatalog()
        turn = await this.codexManager.startTurn({ chatId: args.chatId, content: buildPromptText(wireContent, args.attachments),
          isCurrentTurn, signal: active.startupAbort?.signal,
          skills: skills.flatMap(skill => skill.path ? [{ name: skill.name, path: skill.path }] : []), model: args.model,
          effort: args.effort as CodexReasoningEffort | undefined, serviceTier: args.serviceTier, planMode: args.planMode, onToolRequest })
        active.turn = turn
        assertCurrent()
      }
      if (!contentPrepared) await prepareWireContent(turn.startupOutcome ?? { kind: "unknown", reason: "provider did not prepare an input" })
      if (shouldClearPendingForkSessionToken) await writeOwned(() => this.store.setPendingForkSessionToken(args.chatId, null))
      await awaitOwned(async () => { await args.onProviderReady?.(isCurrentTurn, actualStartup.outcome) })
      active.startupPending = false
      active.startupAbort = undefined
      markToolsReady()
      if (turn.getAccountInfo) void turn.getAccountInfo().then(async accountInfo => {
        if (!accountInfo || !isCurrentTurn()) return
        if (args.provider === "claude") {
          const session = this.claudeSessions.get(args.chatId)
          if (!session || session.accountInfoLoaded) return
          session.accountInfoLoaded = true
        }
        await writeOwned(() => this.store.appendMessage(args.chatId, timestamped({ kind: "account_info", accountInfo })))
        this.emitStateChange(args.chatId)
      }).catch(() => undefined)
      if (args.provider === "claude") {
        assertCurrent()
        const session = this.claudeSessions.get(args.chatId)
        if (!session) throw new Error("Claude session was not initialized")
        session.suppressResume = false
        const promptSeq = session.nextPromptSeq + 1
        const promptId = crypto.randomUUID()
        session.nextPromptSeq = promptSeq
        session.pendingPrompts.push({ seq: promptSeq, id: promptId })
        active.claudePromptSeq = promptSeq
        active.status = "running"
        this.emitStateChange(args.chatId)
      await session.session.sendPrompt(
        buildPromptText(wireContent, args.attachments),
        promptId,
      )
        return
      }
      void this.runTurn(active as ActiveTurn & { turn: HarnessTurn })
    } catch (error) {
      const stillCurrent = isCurrentTurn()
      markToolsReady()
      try {
        if (stillCurrent && !contentPrepared) { await writeUserPrompt(); await recordTurnStarted() }
      } finally {
        if (this.activeTurns.get(args.chatId) === active) {
          active.customTools?.abort()
          this.activeTurns.delete(args.chatId)
          this.emitStateChange(args.chatId)
        }
        if (turn && (args.provider !== "claude" || createdClaudeSession)) await this.interruptAndCloseTurn(turn)
      }
      if (!stillCurrent || error === staleStartup) return
      throw error
    }
  }

  private async startClaudeTurn(args: {
    chatId: string
    localPath: string
    model: string
    effort?: string
    serviceTier?: "fast"
    planMode: boolean
    autoPlan: boolean
    sessionToken: string | null
    forkSession: boolean
    resetSession?: boolean
    isCurrentTurn: () => boolean
    customTools?: KannaToolHost
    onToolRequest: (request: HarnessToolRequest) => Promise<unknown>
  }): Promise<(HarnessTurn & { createdSession: boolean }) | null> {
    let session = this.claudeSessions.get(args.chatId)
    let startupOutcome: HarnessStartupOutcome = { kind: "reused" }
    let createdSession = false

    // autoPlan changes the SDK's `tools` allowlist, which is fixed at query()
    // time — unlike planMode (setPermissionMode) it can only be applied by
    // restarting the session. The restart resumes by sessionToken, so the
    // conversation carries over.
    if (
      !session
      || session.localPath !== args.localPath
      || session.effort !== args.effort
      || session.autoPlan !== args.autoPlan
      || args.forkSession
      || args.resetSession
    ) {
      if (session) {
        session.forceClosed = true
        session.session.close()
        this.claudeSessions.delete(args.chatId)
      }

      const sessionInstanceId = crypto.randomUUID()
      let reportedBackgroundWorkState: ClaudeBackgroundWorkState = "unknown"
      const started = await this.startClaudeSessionFn({
        localPath: args.localPath,
        model: args.model,
        effort: args.effort,
        serviceTier: args.serviceTier,
        planMode: args.planMode,
        autoPlan: args.autoPlan,
        sessionToken: args.sessionToken,
        forkSession: args.forkSession,
        onToolRequest: args.onToolRequest,
        customTools: args.customTools,
        onRateLimitEvent: (info) => this.onClaudeRateLimit?.(info),
        onSubagentActivity: (update) => this.applySubagentActivity(args.chatId, update),
        onBackgroundWorkStateChange: (state) => {
          reportedBackgroundWorkState = state
          this.updateClaudeBackgroundWorkState(args.chatId, sessionInstanceId, state)
        },
      })
      if (!args.isCurrentTurn()) { started.close(); return null }
      try {
        startupOutcome = started.waitForStartupOutcome
          ? await started.waitForStartupOutcome()
          : (await started.waitUntilReady?.(), started.startupOutcome ?? { kind: "unknown", reason: "Claude adapter did not report native startup" })
      } catch (error) {
        started.close()
        throw error
      }
      if (!args.isCurrentTurn()) { started.close(); return null }
      this.refreshClaudeModelCatalog(started)

      session = {
        id: sessionInstanceId,
        chatId: args.chatId,
        session: started,
        backgroundWorkState: reportedBackgroundWorkState,
        localPath: args.localPath,
        model: args.model,
        effort: args.effort,
        serviceTier: args.serviceTier,
        planMode: args.planMode,
        autoPlan: args.autoPlan,
        sessionToken: args.sessionToken,
        accountInfoLoaded: false,
        forceClosed: false,
        nextPromptSeq: 0,
        pendingPrompts: [],
        echoesPromptIds: started.echoesPromptIds ?? false,
        suppressResume: false,
        cancelledPromptSeqs: new Set(),
      }
      this.claudeSessions.set(args.chatId, session)
      createdSession = true
      void this.runClaudeSession(session)
    } else {
      if (session.model !== args.model) {
        await session.session.setModel(args.model)
        session.model = args.model
      }
      if (session.planMode !== args.planMode) {
        await session.session.setPermissionMode(args.planMode)
        session.planMode = args.planMode
      }
      if (session.serviceTier !== args.serviceTier) {
        await session.session.setFastMode?.(args.serviceTier === "fast")
        session.serviceTier = args.serviceTier
      }
    }

    if (!args.isCurrentTurn()) return null
    return {
      provider: "claude",
      createdSession,
      startupOutcome,
      stream: {
        async *[Symbol.asyncIterator]() {},
      },
      getAccountInfo: session.session.getAccountInfo,
      interrupt: session.session.interrupt,
      close: () => {
        if (!createdSession || session.nextPromptSeq !== 0) return
        if (this.claudeSessions.get(args.chatId) === session) this.claudeSessions.delete(args.chatId)
        session.session.close()
      },
    }
  }

  async send(command: Extract<ClientCommand, { type: "chat.send" }>) {
    let chatId = command.chatId

    const requestedNewChatCommand = command.provider === "codex"
      ? parseCodexSlashCommand(command.content)
      : null
    if (!chatId && requestedNewChatCommand) {
      throw new Error(`${requestedNewChatCommand} requires an existing Codex chat`)
    }

    if (!chatId) {
      if (!command.projectId) {
        throw new Error("Missing projectId for new chat")
      }
      const created = await this.store.createChat(command.projectId)
      chatId = created.id
      this.analytics.track("chat_created")
    }

    const chat = this.store.requireChat(chatId)
    // Sending a message to an archived chat resurrects it (viewing alone
    // never unarchives).
    if (chat.archivedAt) {
      await this.store.unarchiveChat(chatId)
    }
    const provider = this.resolveProvider(command, chat.provider)
    const slashCommand = provider === "codex" ? parseCodexSlashCommand(command.content) : null
    if (slashCommand) {
      if (command.attachments?.length) throw new Error(`${slashCommand} cannot be used with attachments`)
      if (this.activeTurns.has(chatId)) throw new Error(`${slashCommand} cannot run while a turn is active`)
      if (!chat.sessionToken) throw new Error(`${slashCommand} requires an existing Codex thread`)
      const project = this.store.getProject(chat.projectId)
      if (!project) throw new Error("Project not found")
      await this.codexManager.runSlashCommand({
        chatId,
        cwd: project.localPath,
        threadId: chat.sessionToken,
        command: slashCommand,
      })
      await this.store.appendMessage(chatId, timestamped({ kind: "compact_boundary" }))
      this.emitStateChange(chatId)
      return { chatId }
    }
    if (this.activeTurns.has(chatId) || this.hasPendingCodexSteer(chatId) || this.startingClaudeTurns.has(chatId)) {
      this.analytics.track("message_sent")
      const queuedMessage = await this.enqueueMessage(chatId, command.content, command.attachments ?? [], {
        provider: command.provider,
        model: command.model,
        modelOptions: command.modelOptions,
        effort: command.effort,
        planMode: command.planMode,
        autoPlan: command.autoPlan,
      })
      return { chatId, queuedMessageId: queuedMessage.id, queued: true as const }
    }

    const settings = this.getProviderSettings(provider, command)
    this.analytics.track("message_sent")
    await this.startTurnForChat({
      chatId,
      provider,
      content: command.content,
      attachments: command.attachments ?? [],
      model: settings.model,
      effort: settings.effort,
      serviceTier: settings.serviceTier,
      planMode: settings.planMode,
      autoPlan: settings.autoPlan,
      appendUserPrompt: true,
    })


    return { chatId }
  }

  async enqueue(command: Extract<ClientCommand, { type: "message.enqueue" }>) {
    this.analytics.track("message_sent")
    const queuedMessage = await this.enqueueMessage(command.chatId, command.content, command.attachments ?? [], {
      provider: command.provider,
      model: command.model,
      modelOptions: command.modelOptions,
      planMode: command.planMode,
      autoPlan: command.autoPlan,
    })
    if (command.steer) {
      // The same path as "Send now" on a queued message, so the two can't
      // drift. One thing it has to absorb: the turn can end while the message
      // was being queued, in which case the drain has already started it —
      // the outcome steering wanted, just not by this call.
      try {
        await this.steer({ type: "message.steer", chatId: command.chatId, queuedMessageId: queuedMessage.id })
      } catch (error) {
        const drained = !this.store.getQueuedMessage(command.chatId, queuedMessage.id)
          && this.activeTurns.has(command.chatId)
        if (!drained) throw error
      }
    }
    return { queuedMessageId: queuedMessage.id }
  }

  async steer(command: Extract<ClientCommand, { type: "message.steer" }>): Promise<void> {
    const preceding = this.codexSteerCompletions.get(command.chatId)
    if (preceding) {
      const error = await preceding
      if (error) throw new Error(error)
      return this.steer(command)
    }
    const queuedMessage = this.store.getQueuedMessage(command.chatId, command.queuedMessageId)
    if (!queuedMessage) {
      throw new Error("Queued message not found")
    }
    // Before native startup registers an active turn there is no turn to
    // interrupt. Keep the queued message for the owning turn's normal drain.
    if (this.startingClaudeTurns.has(command.chatId) && !this.activeTurns.has(command.chatId)) return

    logClaudeSteer("steer_requested", {
      chatId: command.chatId,
      queuedMessageId: command.queuedMessageId,
      activeTurn: this.activeTurns.has(command.chatId),
      queuedMessagePreview: queuedMessage.content.slice(0, 160),
    })

    const active = this.activeTurns.get(command.chatId)
    const expectedTurnId = active?.turn?.providerTurnId
    if (active?.provider === "codex" && expectedTurnId && !active.pendingTool) {
      const chat = this.store.requireChat(command.chatId)
      const provider = this.resolveProvider(queuedMessage, chat.provider)
      if (provider === "codex") {
        const endSteer = this.beginCodexSteer(command.chatId, queuedMessage.id)
        let settlementStarted = false
        let lifecycleFinished = false
        const finishSteerLifecycle = async () => {
          if (lifecycleFinished) return
          lifecycleFinished = true
          const cancellationInProgress = this.cancelingChats.has(command.chatId) || active.cancelRequested
          endSteer(cancellationInProgress ? "Codex turn was cancelled" : undefined)
          if (cancellationInProgress) {
            if (!this.hasPendingCodexSteer(command.chatId)) {
              this.cancelingChats.delete(command.chatId)
            }
            return
          }
          await this.maybeStartNextQueuedMessage(command.chatId)
        }

        try {
          const content = buildSteeredMessageContent(queuedMessage.content)
          const selectedSkills = await this.resolvePromptSkills("codex", command.chatId, queuedMessage.content)
          if (
            this.activeTurns.get(command.chatId) !== active
            || !this.store.getQueuedMessage(command.chatId, queuedMessage.id)
          ) {
            return
          }
          const transcriptEntry = {
            ...timestamped({
              kind: "user_prompt",
              content,
              attachments: queuedMessage.attachments,
              steered: true,
            }),
            // Reusing the durable queue id makes recovery idempotent if Kanna
            // exits after transcript persistence but before queue removal.
            _id: queuedMessage.id,
          } as Extract<TranscriptEntry, { kind: "user_prompt" }>
          let steer: ReturnType<CodexAppServerManager["startSteerTurn"]>
          try {
            steer = this.codexManager.startSteerTurn({
              chatId: command.chatId,
              expectedTurnId,
              content: buildPromptText(content, queuedMessage.attachments),
              selectedSkills: selectedSkills.flatMap((skill) => (
                skill.path ? [{ name: skill.name, path: skill.path }] : []
              )),
              clientUserMessageId: queuedMessage.id,
              transcriptEntry,
            })
          } catch (error) {
            // If the original turn ended while the native request was in flight,
            // leave the durable queue intact and promote it once the gate closes.
            if (this.activeTurns.get(command.chatId) === active) {
              throw error
            }
            return
          }
          settlementStarted = true
          void (async () => {
            try {
              try {
                await steer.settled
              } catch (error) {
                // If the original turn ended while the native request was in
                // flight, leave the durable queue intact for promotion.
                if (this.activeTurns.get(command.chatId) === active) {
                  const message = error instanceof Error ? error.message : String(error)
                  this.reportBackgroundError?.(
                    `[codex-steer] chat ${command.chatId} failed to settle message ${queuedMessage.id}: ${message}`
                  )
                }
                return
              }
              if (this.store.getQueuedMessage(command.chatId, queuedMessage.id)) {
                await this.store.removeQueuedMessage(command.chatId, queuedMessage.id)
                this.emitStateChange(command.chatId)
              }
            } finally {
              await finishSteerLifecycle()
            }
          })().catch((error) => {
            const message = error instanceof Error ? error.message : String(error)
            this.reportBackgroundError?.(
              `[codex-steer] chat ${command.chatId} failed to finalize message ${queuedMessage.id}: ${message}`
            )
          })
        } finally {
          if (!settlementStarted) {
            await finishSteerLifecycle()
          }
        }
        return
      }
    }

    // A different native Codex steer may still be waiting for its echoed
    // userMessage. Keep this message durable and let the last settling steer
    // promote the queue instead of interrupting or replacing the active turn.
    if (this.hasPendingCodexSteer(command.chatId)) return

    if (this.activeTurns.has(command.chatId)) {
      await this.cancel(command.chatId, { hideInterrupted: true })
    }

    logClaudeSteer("steer_after_cancel", {
      chatId: command.chatId,
      stillActive: this.activeTurns.has(command.chatId),
    })

    if (this.activeTurns.has(command.chatId)) {
      throw new Error("Chat is still running")
    }

    await this.dequeueAndStartQueuedMessage(command.chatId, queuedMessage, { steered: true })
  }

  async dequeue(command: Extract<ClientCommand, { type: "message.dequeue" }>) {
    const queuedMessage = this.store.getQueuedMessage(command.chatId, command.queuedMessageId)
    if (!queuedMessage) {
      throw new Error("Queued message not found")
    }
    if (this.hasPendingCodexSteer(command.chatId, command.queuedMessageId)) {
      throw new Error("Queued message is being steered")
    }

    await this.store.removeQueuedMessage(command.chatId, command.queuedMessageId)
  }

  /**
   * Enumerate the skills/commands the selected harness can invoke, for the
   * composer's "/" menu. Prefers the live harness (authoritative — includes
   * built-ins, plugins, and enabled flags) and degrades to Kanna's filesystem
   * scan of the same discovery roots when no session is running yet.
   *
   * Adding a harness = one branch here (list) plus, if its wire protocol needs
   * more than leading-"/name" text, one translation in startTurnForChat.
   */
  async listSkills(
    command: Extract<ClientCommand, { type: "chat.listSkills" }>
  ): Promise<ChatSkillsSnapshot> {
    const cwd = this.resolveSkillScanCwd(command)
    if (!cwd) {
      return { provider: command.provider, skills: [], origin: "filesystem" }
    }

    switch (command.provider) {
      case "claude": {
        const handle = command.chatId ? this.claudeSessions.get(command.chatId)?.session : undefined
        if (handle?.supportedCommands) {
          try {
            const commands = await handle.supportedCommands()
            const skills: HarnessSkill[] = commands
              .filter((entry) => !entry.name.startsWith("._"))
              .map((entry) => ({
                name: entry.name,
                description: entry.description ?? "",
                ...(entry.argumentHint ? { argumentHint: entry.argumentHint } : {}),
                source: "command" as const,
              }))
            return { provider: "claude", skills, origin: "live" }
          } catch {
            // Session mid-shutdown or old CLI — fall through to the scan.
          }
        }
        return { provider: "claude", skills: scanClaudeSkills({ cwd }), origin: "filesystem" }
      }
      case "codex": {
        const commands: HarnessSkill[] = CODEX_SLASH_COMMANDS.map((slashCommand) => ({
          name: slashCommand.slice(1),
          description: "Compact the current Codex thread",
          source: "command",
        }))
        const live = command.chatId
          ? await this.codexManager.listSkills({ chatId: command.chatId, cwd })
          : null
        if (live) {
          const skills: HarnessSkill[] = live.map((skill) => ({
            name: skill.name,
            description: skill.shortDescription || skill.description || "",
            source: "skill" as const,
            path: skill.path,
          }))
          return { provider: "codex", skills: [...commands, ...skills], origin: "live" }
        }
        return { provider: "codex", skills: [...commands, ...scanCodexSkills({ cwd })], origin: "filesystem" }
      }
      case "cursor":
        // Cursor has no enumeration protocol; the scan mirrors the CLI's own
        // skill discovery roots, and invocation is failsafe-only by design.
        return { provider: "cursor", skills: scanCursorSkills({ cwd }), origin: "filesystem" }
      case "grok": {
        const live = await this.grokManager.listSkills({ cwd })
        if (live.length > 0) {
          return { provider: "grok", skills: live, origin: "live" }
        }
        return { provider: "grok", skills: scanGrokSkills({ cwd }), origin: "filesystem" }
      }
      case "pi": {
        const skills = await this.piManager.listSkills({ chatId: command.chatId, cwd })
        return { provider: "pi", skills, origin: "live" }
      }
    }
  }

  private resolveSkillScanCwd(args: { chatId?: string; projectId?: string }): string | null {
    if (args.chatId) {
      const chat = this.store.getChat(args.chatId)
      const project = chat ? this.store.getProject(chat.projectId) : undefined
      if (project) return project.localPath
    }
    if (args.projectId) {
      const project = this.store.getProject(args.projectId)
      if (project) return project.localPath
    }
    return null
  }

  /**
   * The skills a prompt names that the harness won't expand by itself,
   * resolved against the same list the "/" menu shows (for codex, live
   * skills/list paths are what its structured item must exact-match).
   * Unresolved names stay plain text. The list is only fetched when some
   * mention needs it, so an ordinary leading "/name" on claude/grok/pi costs
   * nothing extra.
   */
  private async resolvePromptSkills(provider: AgentProvider, chatId: string, content: string): Promise<SkillReference[]> {
    const expandsLeading = provider === "claude" || provider === "grok" || provider === "pi"
    const mentions = findSkillMentions(content, provider === "codex" ? "$" : "/")
      .filter((mention) => !(expandsLeading && mention.leading))
    if (mentions.length === 0) return []
    const { skills } = await this.listSkills({ type: "chat.listSkills", provider, chatId })
    return resolveSkillMentions(mentions, skills)
  }

  /**
   * Cancel every in-flight turn because Kanna itself is going down, marking
   * each chat so the next boot picks the work back up (`resumeInterruptedTurn`).
   *
   * Everything a user-initiated cancel does still happens — the harness is
   * interrupted, the pending tool call is discarded, the transcript gets its
   * `interrupted` entry — so a chat that never gets resumed reads exactly as it
   * does today. The marker is written first: a shutdown that dies partway
   * through leaves a chat resumable-but-not-cancelled, which the resume pass
   * handles, rather than cancelled-but-forgotten, which it can't.
   *
   * A turn parked on a tool request (AskUserQuestion, plan approval) is not
   * marked. Cancelling it feeds the harness a discarded result, and a resume
   * would then tell the model to "continue" past a question nobody answered or
   * a plan nobody approved. Those chats stay interrupted so the user re-asks.
   */
  async interruptForShutdown() {
    for (const [chatId, active] of [...this.activeTurns.entries()]) {
      if (!active.pendingTool) {
        try {
          await this.store.setTurnResumePending(chatId, true)
        } catch {
          // Best effort — a chat we can't mark still gets cancelled cleanly.
        }
      }
      await this.cancel(chatId)
    }
  }

  /**
   * Restart a turn that the previous process cut short by shutting down.
   *
   * The prompt is wire-only (`appendUserPrompt: false`), so the transcript
   * shows the interrupted turn picking back up rather than a user message
   * nobody typed. Resuming leans on the harness session having survived: it
   * holds the original prompt and everything the turn did before it died, so
   * "carry on" is all that has to be said. When the session is gone,
   * `startTurnForChat`'s actual startup classifier rebuilds from the
   * admissible local transcript before sending this hidden continuation.
   *
   * Returns whether a turn was actually started.
   */
  async resumeInterruptedTurn(chatId: string) {
    const chat = this.store.getChat(chatId)
    if (!chat || chat.deletedAt) return false
    if (!chat.provider) return false
    if (this.activeTurns.has(chatId)) return false
    // No session to resume into means the harness never got far enough to have
    // context worth continuing; a bare "carry on" would be sent into an empty
    // session, so leave the chat interrupted instead.
    if (!chat.sessionToken && !chat.pendingForkSessionToken && !chat.contextRestoration) return false

    // Everything the chat record remembers about how the turn was running:
    // the model it actually ran with plus the two persisted modes. Reasoning
    // effort and fast mode are picked in the composer and never stored server
    // side, so the resumed turn falls back to the provider defaults for those.
    const settings = this.getProviderSettings(chat.provider, {
      model: chat.lastModel,
      planMode: chat.planMode,
      autoPlan: chat.autoPlan,
    })
    await this.startTurnForChat({
      chatId,
      provider: chat.provider,
      content: RESUME_AFTER_RESTART_MESSAGE,
      attachments: [],
      model: settings.model,
      effort: settings.effort,
      serviceTier: settings.serviceTier,
      planMode: settings.planMode,
      autoPlan: settings.autoPlan,
      appendUserPrompt: false,
    })
    return true
  }

  async forkChat(chatId: string) {
    const chat = this.store.requireChat(chatId)
    if (!chat.provider) {
      throw new Error("Chat must have a provider before forking")
    }
    if (!chat.sessionToken && !chat.pendingForkSessionToken) {
      throw new Error("Chat has no session to fork")
    }

    // A running chat is forkable: the fork branches from the last completed
    // turn, leaving the turn in flight out of the copy so it never inherits
    // tool calls whose results have not arrived. Nothing here touches the
    // source's turn — it keeps running.
    const running = this.activeTurns.has(chatId) || this.drainingStreams.has(chatId)
    const forked = await this.store.forkChat(chatId, { atLastCompletedTurn: running })
    this.analytics.track("chat_created")
    return { chatId: forked.id }
  }

  /**
   * Removes and returns the seqs of the prompts a turn-ending entry answers.
   *
   * The CLI also runs turns nobody sent. A task notification starts one, and
   * a resumed session opens with one about background commands the previous
   * process left running. Such a turn can end while the user's prompt waits
   * behind it in the CLI's queue. Crediting its result to the oldest pending
   * prompt ended the user's turn before the CLI had started it: "turn done"
   * with no reply. So each prompt carries an id, and the CLI echoes the ids a
   * turn consumed on its result.
   *
   * A result without ids answers none of ours, unless this CLI has never
   * echoed (a CLAUDE_EXECUTABLE wrapper), where oldest-first is all there
   * is. Error and interrupt results can come back without ids too (an
   * interrupted or failed turn), and they still go oldest-first so a failed
   * turn can't leave the chat spinning.
   */
  private takeAnsweredClaudePrompts(
    session: ClaudeSessionState,
    promptIds: string[] | undefined,
    endedEarly: boolean,
  ): number[] {
    if (promptIds?.length) {
      session.echoesPromptIds = true
      const answered = session.pendingPrompts.filter((prompt) => promptIds.includes(prompt.id))
      session.pendingPrompts = session.pendingPrompts.filter((prompt) => !promptIds.includes(prompt.id))
      return answered.map((prompt) => prompt.seq)
    }
    const head = session.pendingPrompts[0]
    if (!head) return []
    if (session.echoesPromptIds && !endedEarly) return []
    session.pendingPrompts.shift()
    return [head.seq]
  }

  /**
   * Re-registers an active turn for a Claude session that produced new
   * activity after its previous turn finished (e.g. a Monitor or Cron
   * wakeup continued the session). The resumed turn has no prompt seq, so
   * the next result that answers none of our prompts closes it through the
   * normal completion path in runClaudeSession.
   */
  private async resumeBackgroundTurn(session: ClaudeSessionState) {
    if (this.claudeSessions.get(session.chatId) !== session
      || this.activeTurns.has(session.chatId)) return
    if (this.startingClaudeTurns.has(session.chatId)) return
    const active: ActiveTurn = {
      chatId: session.chatId,
      provider: "claude",
      turn: {
        provider: "claude",
        stream: {
          async *[Symbol.asyncIterator]() {},
        },
        getAccountInfo: session.session.getAccountInfo,
        interrupt: session.session.interrupt,
        close: () => {},
      },
      model: session.model,
      effort: session.effort,
      planMode: session.planMode,
      autoPlan: session.autoPlan,
      status: "running",
      pendingTool: null,
      postToolFollowUp: null,
      hasFinalResult: false,
      cancelRequested: false,
      cancelRecorded: false,
    }
    this.activeTurns.set(session.chatId, active)
    await this.store.recordTurnStarted(session.chatId, session.model)
    this.emitStateChange(session.chatId)
  }

  private async runClaudeSession(session: ClaudeSessionState) {
    const customToolEvents = new KannaToolEventFilter()
    const isCurrentClaudeSession = () => this.claudeSessions.get(session.chatId) === session
      && (!this.activeTurns.has(session.chatId) || this.activeTurns.get(session.chatId)?.provider === "claude")
    try {
      for await (const event of session.session.stream) {
        if (!isCurrentClaudeSession()) break
        if (event.type === "session_token" && event.sessionToken) {
          session.sessionToken = event.sessionToken
          await this.store.setSessionToken(session.chatId, event.sessionToken)
          if (!isCurrentClaudeSession()) break
          this.emitStateChange(session.chatId)
          continue
        }

        if (!event.entry || customToolEvents.skip(event.entry)) continue

        const terminalOwner = this.activeTurns.get(session.chatId)
        const isTerminalEntry = event.entry.kind === "result" || event.entry.kind === "interrupted"
        const completedPromptSeqs = isTerminalEntry
          ? this.takeAnsweredClaudePrompts(session, event.promptIds, event.entry.kind === "interrupted" || (event.entry.kind === "result" && event.entry.isError))
          : []
        // UUIDs may answer several prompts, including an interrupted prompt
        // and the steered follow-up. Keep that result when it answers the
        // current turn; drop terminals that only belong to cancelled/stale turns.
        const onlyCancelledPrompts = completedPromptSeqs.length > 0
          && completedPromptSeqs.every((seq) => session.cancelledPromptSeqs.has(seq))
        const isCancelSettlingErrorResult =
          session.suppressResume && event.entry.kind === "result" && event.entry.isError
        const shouldAppendEntry = !isTerminalEntry
          || (
            !isCancelSettlingErrorResult
            && !onlyCancelledPrompts
            && (
              completedPromptSeqs.length === 0
              || (
                terminalOwner !== undefined
                && terminalOwner.claudePromptSeq !== undefined
                && completedPromptSeqs.includes(terminalOwner.claudePromptSeq)
                && !terminalOwner.cancelRequested
              )
            )
          )
        if (shouldAppendEntry) {
          await this.store.appendMessage(session.chatId, event.entry)
        } else {
          logClaudeSteer("claude_stale_terminal_event_suppressed", {
            chatId: session.chatId,
            sessionId: session.id,
            entryKind: event.entry.kind,
            activePromptSeq: terminalOwner?.claudePromptSeq ?? null,
            activeCancelRequested: terminalOwner?.cancelRequested ?? null,
            completedPromptSeqs,
            pendingPromptSeqs: session.pendingPrompts.map((prompt) => prompt.seq),
          })
        }

        if (!isCurrentClaudeSession()) break

        // Background wakeups (Monitor, Cron*, ScheduleWakeup, RemoteTrigger)
        // emit new activity after the previous turn completed. Re-register an
        // active turn so the chat reads as in-progress instead of idle.
        if (
          !this.activeTurns.has(session.chatId)
          && !session.suppressResume
          && (
            event.entry.kind === "assistant_text"
            || event.entry.kind === "tool_call"
            || event.entry.kind === "tool_result"
          )
        ) {
          await this.resumeBackgroundTurn(session)
        }

        if (event.entry.kind === "result" || event.entry.kind === "interrupted") {
          session.suppressResume = false
        }

        const active = this.activeTurns.get(session.chatId)
        if (event.entry.kind === "system_init" && active?.provider === "claude") {
          active.status = "running"
          const chat = this.store.getChat(session.chatId)
          if (
            chat?.pendingForkSessionToken
            && session.sessionToken
            && session.sessionToken !== chat.pendingForkSessionToken
          ) {
            await this.store.setPendingForkSessionToken(session.chatId, null)
          }
          logClaudeSteer("claude_event_system_init", {
            chatId: session.chatId,
            sessionId: session.id,
            activePromptSeq: active.claudePromptSeq ?? null,
            pendingPromptSeqs: session.pendingPrompts.map((prompt) => prompt.seq),
          })
        }

        for (const seq of completedPromptSeqs) {
          session.cancelledPromptSeqs.delete(seq)
        }

        logClaudeSteer("claude_event", {
          chatId: session.chatId,
          sessionId: session.id,
          entryKind: event.entry.kind,
          activePromptSeq: active?.claudePromptSeq ?? null,
          completedPromptSeqs,
          activeStatus: active?.status ?? null,
          pendingPromptSeqs: session.pendingPrompts.map((prompt) => prompt.seq),
        })

        // A turn resumed by background activity has no prompt, so any result
        // that answers none of ours ends it.
        const completesActive = active?.claudePromptSeq == null
          ? completedPromptSeqs.length === 0
          : completedPromptSeqs.includes(active.claudePromptSeq)
        if (event.entry.kind === "result" && active?.provider === "claude" && completesActive) {
          active.hasFinalResult = true
          if (event.entry.isError) {
            await this.store.recordTurnFailed(session.chatId, event.entry.result || "Turn failed")
          } else if (!active.cancelRequested) {
            if (active.contextRestorationId && this.activeTurns.get(session.chatId) === active) await this.store.acknowledgeContextRestoration(session.chatId, active.contextRestorationId)
            if (!active.cancelRequested && this.activeTurns.get(session.chatId) === active) await this.store.recordTurnFinished(session.chatId)
          }
          active.customTools?.abort()
          if (!active.cancelRequested) {
            if (event.entry.isError) {
              await this.store.recordTurnFailed(session.chatId, event.entry.result || "Turn failed")
            } else {
              await this.store.recordTurnFinished(session.chatId)
            }
            if (this.activeTurns.get(session.chatId) === active) {
              this.activeTurns.delete(session.chatId)
              this.scheduleIdleSessionClose(session.chatId)
              await this.maybeStartNextQueuedMessage(session.chatId)
            }
          } else if (this.activeTurns.get(session.chatId) === active) {
            this.activeTurns.delete(session.chatId)
          }
        }

        this.scheduleIdleSessionClose(session.chatId)
        this.emitStateChange(session.chatId)
      }
    } catch (error) {
      const active = this.claudeSessions.get(session.chatId) === session
        ? this.activeTurns.get(session.chatId) : undefined
      if (active?.provider === "claude" && !active.cancelRequested) {
        const message = error instanceof Error ? error.message : String(error)
        await this.store.appendMessage(
          session.chatId,
          timestamped({
            kind: "result",
            subtype: "error",
            isError: true,
            durationMs: 0,
            result: message,
          })
        )
        if (this.activeTurns.get(session.chatId) === active && isCurrentClaudeSession() && !active.cancelRequested) {
          await this.store.recordTurnFailed(session.chatId, message)
        }
      }
    } finally {
      // Only evict if this session is still the chat's current one — a restart
      // (localPath/effort/autoPlan change, or a fork) closes the old session
      // and immediately registers a replacement, and the old stream's cleanup
      // lands afterwards. Deleting by chatId alone would drop the new session.
      const isCurrentSession = this.claudeSessions.get(session.chatId) === session
      if (isCurrentSession) {
        this.claudeSessions.delete(session.chatId)
        this.clearIdleSessionTimer(session.chatId)
        const active = this.activeTurns.get(session.chatId)
        if (active?.provider === "claude") {
          active.customTools?.abort()
          if (active.cancelRequested && !active.cancelRecorded) {
            await this.store.recordTurnCancelled(session.chatId)
          }
          if (this.activeTurns.get(session.chatId) === active) {
            this.activeTurns.delete(session.chatId)
          }
        }
      }
      // The session is gone, so nothing it spawned can report back. Only when
      // it is still the chat's session: a restart's replacement owns them now.
      if (!this.claudeSessions.has(session.chatId)) {
        this.closeRunningSubagents(session.chatId)
        this.ambientTaskIds.delete(session.chatId)
        this.foregroundTasks.delete(session.chatId)
      }
      if (!session.forceClosed) {
        session.session.close()
      }
      this.emitStateChange(session.chatId)
    }
  }

  private async generateTitleInBackground(
    chatId: string,
    messageContent: string,
    cwd: string,
    expectedCurrentTitle: string,
    preferredProvider: AgentProvider
  ) {
    try {
      const titleProvider = preferredProvider === "claude" || preferredProvider === "codex"
        ? preferredProvider
        : undefined
      const result = await this.generateTitle(messageContent, cwd, titleProvider)
      if (result.failureMessage) {
        this.reportBackgroundError?.(
          `[title-generation] chat ${chatId} failed provider title generation: ${result.failureMessage}`
        )
      }
      if (!result.title || result.usedFallback) return

      const chat = this.store.requireChat(chatId)
      if (chat.title !== expectedCurrentTitle) return

      await this.store.renameChat(chatId, result.title, { markTitleOverride: false })
      this.emitStateChange(chatId)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.reportBackgroundError?.(
        `[title-generation] chat ${chatId} failed background title generation: ${message}`
      )
    }
  }

  private async runTurn(active: ActiveTurn & { turn: HarnessTurn }) {
    const customToolEvents = new KannaToolEventFilter()
    try {
      for await (const event of active.turn.stream) {
        // Once cancelled, stop processing further stream events.
        // cancel() already removed us from activeTurns and notified the UI.
        if (active.cancelRequested) break

        if (event.type === "session_token" && event.sessionToken) {
          await this.store.setSessionToken(active.chatId, event.sessionToken)
          const chat = this.store.getChat(active.chatId)
          if (
            chat?.pendingForkSessionToken
            && event.sessionToken !== chat.pendingForkSessionToken
          ) {
            await this.store.setPendingForkSessionToken(active.chatId, null)
          }
          this.emitStateChange(active.chatId)
          continue
        }

        if (!event.entry || customToolEvents.skip(event.entry)) continue
        try {
          await this.store.appendMessage(active.chatId, event.entry)
        } catch (error) {
          const failure = error instanceof Error ? error : new Error(String(error))
          try {
            event.onPersisted?.(failure)
          } catch {
            // Persistence observers must not replace the storage failure.
          }
          throw error
        }
        try {
          event.onPersisted?.()
        } catch {
          // The transcript is already durable; observer failures are isolated.
        }
        this.trackSubagentFromEntry(active.chatId, event.entry)

        if (event.entry.kind === "system_init") {
          active.status = active.pendingTool ? "waiting_for_user" : "running"
        }

        if (event.entry.kind === "result") {
          active.hasFinalResult = true
          if (event.entry.isError) {
            await this.store.recordTurnFailed(active.chatId, event.entry.result || "Turn failed")
          } else if (!active.cancelRequested && this.activeTurns.get(active.chatId) === active) {
            if (active.contextRestorationId) await this.store.acknowledgeContextRestoration(active.chatId, active.contextRestorationId)
            if (active.cancelRequested || this.activeTurns.get(active.chatId) !== active) break
            await this.store.recordTurnFinished(active.chatId)
          }
          if (active.cancelRequested || this.activeTurns.get(active.chatId) !== active) break
          // Remove from activeTurns as soon as the result arrives so the UI
          // transitions to idle immediately. The stream may still be open
          // (e.g. background tasks), but the user should be able to send
          // new messages without having to hit stop first.
          this.activeTurns.delete(active.chatId)
          // Track the still-open stream so the UI can show a draining
          // indicator and the user can stop background tasks.
          this.drainingStreams.set(active.chatId, { turn: active.turn })
        }

        this.emitStateChange(active.chatId)
      }
    } catch (error) {
      if (!active.cancelRequested) {
        const message = error instanceof Error ? error.message : String(error)
        await this.store.appendMessage(
          active.chatId,
          timestamped({
            kind: "result",
            subtype: "error",
            isError: true,
            durationMs: 0,
            result: message,
          })
        )
        await this.store.recordTurnFailed(active.chatId, message)
      }
    } finally {
      if (active.cancelRequested && !active.cancelRecorded) {
        await this.store.recordTurnCancelled(active.chatId)
      }
      active.customTools?.abort()
      active.turn.close()
      // Only remove if we're still the active turn for this chat.
      // We may have already been removed by result handling or cancel(),
      // and a new turn may have started for the same chatId.
      if (this.activeTurns.get(active.chatId) === active) {
        this.activeTurns.delete(active.chatId)
      }
      // Stream has fully ended — no longer draining.
      if (this.drainingStreams.get(active.chatId)?.turn === active.turn) this.drainingStreams.delete(active.chatId)
      this.scheduleIdleSessionClose(active.chatId)
      this.emitStateChange(active.chatId)

      if (active.postToolFollowUp && !active.cancelRequested) {
        try {
          await this.startTurnForChat({
            chatId: active.chatId,
            provider: active.provider,
            content: active.postToolFollowUp.content,
            attachments: [],
            model: active.model,
            effort: active.effort,
            serviceTier: active.serviceTier,
            planMode: active.postToolFollowUp.planMode,
            // Codex-only path; carry the turn's mode through unchanged.
            autoPlan: active.autoPlan,
            appendUserPrompt: false,
          })
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          await this.store.appendMessage(
            active.chatId,
            timestamped({
              kind: "result",
              subtype: "error",
              isError: true,
              durationMs: 0,
              result: message,
            })
          )
          await this.store.recordTurnFailed(active.chatId, message)
          this.emitStateChange(active.chatId)
        }
      } else if (!active.cancelRequested) {
        try {
          await this.maybeStartNextQueuedMessage(active.chatId)
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          await this.store.appendMessage(
            active.chatId,
            timestamped({
              kind: "result",
              subtype: "error",
              isError: true,
              durationMs: 0,
              result: message,
            })
          )
          await this.store.recordTurnFailed(active.chatId, message)
          this.emitStateChange(active.chatId)
        }
      }
    }
  }

  async cancel(chatId: string, options?: { hideInterrupted?: boolean }) {
    this.startingClaudeTurns.delete(chatId)
    this.cancelingChats.add(chatId)
    try {
      // Also clean up any draining stream for this chat.
      const draining = this.drainingStreams.get(chatId)
      if (draining) {
        draining.turn.close()
        this.drainingStreams.delete(chatId)
      }

      const active = this.activeTurns.get(chatId)
      if (!active) return

      logClaudeSteer("cancel_requested", {
        chatId,
        provider: active.provider,
        activePromptSeq: active.claudePromptSeq ?? null,
      })

      // Guard against concurrent cancel() calls — only the first one does work.
      if (active.cancelRequested) return
      active.cancelRequested = true

      // Keep in-flight stream entries (emitted before the interrupt lands)
      // from re-registering an active turn via resumeBackgroundTurn, and mark
      // the cancelled prompt so its interrupt error result gets dropped.
      if (active.provider === "claude") {
        const session = this.claudeSessions.get(chatId)
        if (session) {
          session.suppressResume = true
          if (active.claudePromptSeq != null) {
            session.cancelledPromptSeqs.add(active.claudePromptSeq)
          }
        }
      }

      const pendingTool = active.pendingTool
      active.pendingTool = null
      active.customTools?.abort()

      if (pendingTool && pendingTool.resultOwner !== "tool") {
        const result = discardedToolResult(pendingTool.tool)
        await this.store.appendMessage(
          chatId,
          timestamped({
            kind: "tool_result",
            toolId: pendingTool.toolUseId,
            content: result,
          })
        )
        // These adapters hold their stream open until the request resolves.
        if (
          (active.provider === "codex" && pendingTool.tool.toolKind === "exit_plan_mode")
          || active.provider === "grok"
        ) {
          pendingTool.resolve(result)
        }
      }

      await this.store.appendMessage(chatId, timestamped({ kind: "interrupted", hidden: options?.hideInterrupted }))
      await this.store.recordTurnCancelled(chatId)
      active.cancelRecorded = true
      active.hasFinalResult = true

      // Remove from activeTurns immediately so the UI reflects the cancellation
      // right away, rather than waiting for interrupt() which may hang.
      this.activeTurns.delete(chatId)
      this.closeRunningSubagents(chatId)
      this.emitStateChange(chatId)
      logClaudeSteer("cancel_active_turn_deleted", {
        chatId,
        provider: active.provider,
        activePromptSeq: active.claudePromptSeq ?? null,
      })

      await this.interruptAndCloseTurn(active.turn)
    } finally {
      if (!this.hasPendingCodexSteer(chatId)) {
        this.cancelingChats.delete(chatId)
      }
    }
  }

  private async requestToolInput(chatId: string, request: HarnessToolRequest, signal?: AbortSignal): Promise<unknown> {
    const active = this.activeTurns.get(chatId)
    if (!active || active.cancelRequested) throw new Error("Chat turn ended")
    signal?.throwIfAborted()
    if (active.pendingTool) throw new Error("Another tool is waiting for user input")
    return new Promise<unknown>((resolve) => {
      const pending: PendingToolRequest = {
        toolUseId: request.tool.toolId,
        tool: request.tool,
        resultOwner: request.resultOwner,
        validateResult: request.validateResult,
        resolve: (result) => {
          signal?.removeEventListener("abort", abort)
          resolve(result)
        },
      }
      const abort = () => {
        if (active.pendingTool === pending) {
          active.pendingTool = null
          active.status = "running"
          this.emitStateChange(chatId)
        }
        pending.resolve(discardedToolResult(pending.tool))
      }
      signal?.addEventListener("abort", abort, { once: true })
      active.pendingTool = pending
      active.status = "waiting_for_user"
      this.emitStateChange(chatId)
    })
  }

  async respondTool(command: Extract<ClientCommand, { type: "chat.respondTool" }>) {
    const active = this.activeTurns.get(command.chatId)
    if (!active || !active.pendingTool) {
      throw new Error("No pending tool request")
    }

    const pending = active.pendingTool
    if (pending.toolUseId !== command.toolUseId) {
      throw new Error("Tool response does not match active request")
    }
    pending.validateResult?.(command.result)

    if (pending.resultOwner !== "tool") {
      await this.store.appendMessage(
        command.chatId,
        timestamped({
          kind: "tool_result",
          toolId: command.toolUseId,
          content: command.result,
        })
      )
    }

    active.pendingTool = null
    active.status = "running"

    if (pending.tool.toolKind === "exit_plan_mode") {
      const result = (command.result ?? {}) as {
        confirmed?: boolean
        clearContext?: boolean
        message?: string
      }
      if (result.confirmed && result.clearContext) {
        if (active.cancelRequested || this.activeTurns.get(command.chatId) !== active) return
        // Commit reset intent before the boundary. A failed/cancelled boundary
        // write must never make a later fresh retry restore the preceding epoch.
        const startInclusive = this.store.getTranscriptLength(command.chatId)
        let release!: () => void
        const commit = new Promise<void>(resolve => { release = resolve })
        this.claudeReadinessCommits.set(command.chatId, commit)
        const stillOwned = () => !active.cancelRequested && this.activeTurns.get(command.chatId) === active
        try {
          await this.store.setContextRestoration(command.chatId, {
            id: crypto.randomUUID(), provider: active.provider, fromProvider: active.provider,
            reason: "explicit_reset", startInclusive, endExclusive: startInclusive,
          })
          if (!stillOwned()) return
          await this.store.appendMessage(command.chatId, timestamped({ kind: "context_cleared" }))
          if (!stillOwned()) return
          await this.store.setSessionToken(command.chatId, null)
          if (!stillOwned()) return
        } finally {
          if (this.claudeReadinessCommits.get(command.chatId) === commit) this.claudeReadinessCommits.delete(command.chatId)
          release()
        }
      }

      // Neither can hand the answer back to the running agent, so it goes in
      // a follow-up turn on the same session (see grok-cli startTurn).
      if (active.provider === "codex" || active.provider === "grok") {
        active.postToolFollowUp = result.confirmed
          ? {
              content: result.message
                ? `Proceed with the approved plan. Additional guidance: ${result.message}`
                : "Proceed with the approved plan.",
              planMode: false,
            }
          : {
              content: result.message
                ? `Revise the plan using this feedback: ${result.message}`
                : "Revise the plan using this feedback.",
              planMode: true,
            }
      }
    } else if (pending.tool.toolKind === "ask_user_question" && active.provider === "grok") {
      active.postToolFollowUp = {
        content: formatQuestionAnswersFollowUp(pending.tool.input.questions, command.result),
        planMode: active.planMode,
      }
    }

    pending.resolve(command.result)

    this.emitStateChange(command.chatId)
  }
}

function claudeSessionHooks(args: {
  onSubagentActivity?: (update: SubagentActivityUpdate) => void
  onBackgroundWorkStateChange?: (state: ClaudeBackgroundWorkState) => void
}): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
  const hooks = args.onSubagentActivity ? subagentHooks(args.onSubagentActivity) : {}
  if (args.onBackgroundWorkStateChange) {
    hooks.Stop = [
      ...(hooks.Stop ?? []),
      { hooks: [createClaudeStopHook(args.onBackgroundWorkStateChange)] },
    ]
  }
  return hooks
}
