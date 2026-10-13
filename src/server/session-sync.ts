import { createHash } from "node:crypto"
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { getDataRootDir, LOG_PREFIX } from "../shared/branding"
import type { TranscriptEntry, ToolCallEntry } from "../shared/types"
import { resolveLocalPath } from "./paths"
import { STRUCTURED_RESULT_TOOL_KINDS } from "./events"
import type { DiscoveredProject } from "./discovery"
import { resolveEncodedClaudePath } from "./discovery"
import { normalizeClaudeStreamMessage } from "./claude-transcript"
import { CodexAppServerManager, codexThreadItemToTranscriptEntries } from "./codex-app-server"
import type { Thread } from "./codex-app-server-protocol"
import { fallbackTitleFromMessage, generateTitleForChatDetailed, type GenerateChatTitleResult } from "./generate-title"
import {
  EventStore,
  type TranscriptSyncProviderRecord,
  type TranscriptSyncState,
} from "./event-store"

const KANNA_ATTACHMENTS_BLOCK_PATTERN = /\s*<kanna-attachments>[\s\S]*?<\/kanna-attachments>\s*$/i
const KANNA_ATTACHMENT_ONLY_PLACEHOLDER = "Please inspect the attached files."
const CLAUDE_RESUME_BANNER_PREFIX = "This session is being continued"
const CLAUDE_LOCAL_COMMAND_TAGS = new Set([
  "command-name",
  "command-message",
  "command-args",
  "local-command-caveat",
  "local-command-stdout",
  "local-command-stderr",
])
const CLAUDE_XMLISH_TAG_BLOCK_PATTERN = /^<([a-z-]+)>[\s\S]*?<\/\1>\s*/

interface CanonicalProviderEntry {
  providerKey: string
  providerHash: string
  matchKey: string
  entry: TranscriptEntry
}

interface ExternalSessionSnapshot {
  provider: "claude" | "codex"
  sessionToken: string
  localPath: string
  updatedAt: number
  canonicalEntries: CanonicalProviderEntry[]
  canonicalHash: string
}

interface PreservedOverlayEntry {
  entry: TranscriptEntry
  afterProviderKey?: string
  beforeProviderKey?: string
}

interface GeneratedSyncTitle {
  title: string | null
  source: "generated" | "fallback" | "skipped_no_user_prompt"
  provider: NonNullable<GenerateChatTitleResult["provider"]> | null
  attempts: GenerateChatTitleResult["attempts"]
}

export interface CodexSessionSyncClient {
  listThreads(args: { cwd: string }): Promise<Thread[]>
  readThread(args: { cwd: string; threadId: string }): Promise<Thread | null>
}

function formatDurationMs(startedAt: number) {
  return `${Date.now() - startedAt}ms`
}

function formatProgressError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/\s+/g, " ").trim() || "Unknown error"
}

function formatTitleAttempts(attempts: GenerateChatTitleResult["attempts"]) {
  if (!attempts || attempts.length === 0) return ""
  return attempts.map((attempt) => (
    `${attempt.provider}:${attempt.outcome}:${attempt.durationMs}ms${attempt.reason ? `:${attempt.reason}` : ""}`
  )).join(",")
}

function isInternalKannaProjectPath(localPath: string, homeDir: string) {
  return resolveLocalPath(localPath) === resolveLocalPath(getDataRootDir(homeDir))
}

export async function syncExternalSessions(args: {
  store: EventStore
  discoveredProjects: DiscoveredProject[]
  homeDir?: string
  codexClient?: CodexSessionSyncClient
  generateTitle?: (
    messageContent: string,
    cwd: string,
    preferredProvider?: "claude" | "codex"
  ) => Promise<GenerateChatTitleResult>
  onProgress?: (message: string) => void
}) {
  const homeDir = args.homeDir ?? homedir()
  const codexClient = args.codexClient ?? new CodexAppServerManager()
  const generateTitle = args.generateTitle ?? ((messageContent, cwd, preferredProvider) =>
    generateTitleForChatDetailed(messageContent, cwd, undefined, {
      preferredProvider,
      useConfiguredProvider: false,
    }))
  const onProgress = args.onProgress
  const syncStartedAt = Date.now()
  const projectTitles = new Map<string, string>()

  for (const project of args.discoveredProjects) {
    const normalizedPath = resolveLocalPath(project.localPath)
    if (isInternalKannaProjectPath(normalizedPath, homeDir)) {
      continue
    }
    projectTitles.set(normalizedPath, project.title)
  }

  for (const project of args.store.listProjects()) {
    if (isInternalKannaProjectPath(project.localPath, homeDir)) {
      continue
    }
    projectTitles.set(project.localPath, project.title)
  }

  const projectPaths = [...projectTitles.keys()]
  if (projectPaths.length === 0) {
    onProgress?.(`${LOG_PREFIX} session sync: skipped (no projects to scan)`)
    return
  }

  onProgress?.(`${LOG_PREFIX} session sync: starting for ${projectPaths.length} projects`)
  onProgress?.(`${LOG_PREFIX} session sync: scanning Claude sessions`)
  const claudeScanStartedAt = Date.now()
  const claudeSessions = await collectClaudeSessions(homeDir, projectPaths, onProgress)
  onProgress?.(`${LOG_PREFIX} session sync: Claude scan complete in ${formatDurationMs(claudeScanStartedAt)}; ${claudeSessions.length} sessions`)
  onProgress?.(`${LOG_PREFIX} session sync: scanning Codex sessions`)
  const codexScanStartedAt = Date.now()
  const codexSessions = await collectCodexSessions(codexClient, projectPaths, onProgress)
  onProgress?.(`${LOG_PREFIX} session sync: Codex scan complete in ${formatDurationMs(codexScanStartedAt)}; ${codexSessions.length} sessions`)
  const externalSessions = [...claudeSessions, ...codexSessions]
  onProgress?.(
    `${LOG_PREFIX} session sync: found ${externalSessions.length} external sessions (${claudeSessions.length} Claude, ${codexSessions.length} Codex)`
  )

  const stats = {
    processed: 0,
    created: 0,
    appended: 0,
    reconciled: 0,
    unchanged: 0,
    hidden: 0,
    emptySkipped: 0,
    titleSkipped: 0,
  }

  const orderedSessions = externalSessions.sort((a, b) => a.updatedAt - b.updatedAt)
  for (const [index, session] of orderedSessions.entries()) {
    const sessionStartedAt = Date.now()
    const sessionLabel =
      `provider=${session.provider} session=${session.sessionToken} project=${session.localPath}`
    onProgress?.(`${LOG_PREFIX} session sync: processing ${index + 1}/${orderedSessions.length} ${sessionLabel}`)

    const existing = args.store.findChatByProviderSession(session.provider, session.sessionToken, { includeDeleted: true })
    if (existing?.deletedAt) {
      stats.processed += 1
      stats.hidden += 1
      onProgress?.(
        `${LOG_PREFIX} session sync: processed ${index + 1}/${orderedSessions.length} action=hidden duration=${formatDurationMs(sessionStartedAt)} ${sessionLabel}`
      )
      continue
    }
    if (!existing && args.store.isProviderSessionHidden(session.provider, session.sessionToken)) {
      stats.processed += 1
      stats.hidden += 1
      onProgress?.(
        `${LOG_PREFIX} session sync: processed ${index + 1}/${orderedSessions.length} action=hidden duration=${formatDurationMs(sessionStartedAt)} ${sessionLabel}`
      )
      continue
    }

    if (!hasImportableTranscriptContent(session.canonicalEntries)) {
      stats.processed += 1
      stats.emptySkipped += 1
      onProgress?.(
        `${LOG_PREFIX} session sync: processed ${index + 1}/${orderedSessions.length} action=empty_skipped duration=${formatDurationMs(sessionStartedAt)} ${sessionLabel}`
      )
      continue
    }

    let chat = existing
    let created = false
    let titleLogSuffix = ""
    if (!chat) {
      const titleStartedAt = Date.now()
      const generatedTitle = await generateInitialSyncedChatTitle(session, session.localPath, generateTitle)
      titleLogSuffix = ` title=${generatedTitle.source}`
      if (generatedTitle.provider) {
        titleLogSuffix += ` titleProvider=${generatedTitle.provider}`
      }
      const attemptsSummary = formatTitleAttempts(generatedTitle.attempts)
      if (attemptsSummary) {
        titleLogSuffix += ` titleAttempts=${attemptsSummary}`
      }
      titleLogSuffix += ` titleMs=${formatDurationMs(titleStartedAt)}`
      if (generatedTitle.source === "fallback") {
        stats.processed += 1
        stats.titleSkipped += 1
        onProgress?.(
          `${LOG_PREFIX} session sync: processed ${index + 1}/${orderedSessions.length} action=title_skipped duration=${formatDurationMs(sessionStartedAt)} ${sessionLabel}${titleLogSuffix}`
        )
        continue
      }
      const project = await args.store.openProject(
        session.localPath,
        projectTitles.get(session.localPath) ?? path.basename(session.localPath) ?? session.localPath
      )
      chat = await args.store.createChat(project.id, generatedTitle.title ? { title: generatedTitle.title } : {})
      created = true
      stats.created += 1
    }

    await args.store.syncChat({
      chatId: chat.id,
      provider: session.provider,
      sessionToken: session.sessionToken,
      externalUpdatedAt: session.updatedAt,
    })
    // Session sync establishes the provider transcript as the source of truth.
    // Do not let a stale shutdown marker immediately start the imported or
    // reconciled session on this same boot; the user can continue it normally.
    await args.store.setTurnResumePending(chat.id, false)

    const currentEntries = args.store.getMessages(chat.id)
    const syncState = args.store.getTranscriptSyncState(chat.id)
    const stateUsable = isTranscriptSyncStateUsable(syncState, session, currentEntries)
    const usableSyncState = stateUsable ? syncState : null
    const nextProviderSequence = toProviderSequence(session.canonicalEntries)

    if (usableSyncState && usableSyncState.canonicalHash === session.canonicalHash) {
      stats.processed += 1
      stats.unchanged += 1
      onProgress?.(
        `${LOG_PREFIX} session sync: processed ${index + 1}/${orderedSessions.length} action=unchanged duration=${formatDurationMs(sessionStartedAt)} ${sessionLabel}${titleLogSuffix}`
      )
      continue
    }

    if (currentEntries.length === 0) {
      await appendCanonicalEntries(args.store, chat.id, session.canonicalEntries)
      await writeTranscriptSyncState(args.store, chat.id, session, nextProviderSequence)
      stats.processed += 1
      stats.appended += 1
      onProgress?.(
        `${LOG_PREFIX} session sync: processed ${index + 1}/${orderedSessions.length} action=${created ? "created+appended" : "appended"} duration=${formatDurationMs(sessionStartedAt)} ${sessionLabel}${titleLogSuffix}`
      )
      continue
    }

    if (usableSyncState && isProviderSequencePrefix(usableSyncState.providerSequence, nextProviderSequence)
      && !hasInteractiveProviderOverlap(currentEntries, session.canonicalEntries.slice(usableSyncState.providerSequence.length))) {
      await appendCanonicalEntries(
        args.store,
        chat.id,
        session.canonicalEntries.slice(usableSyncState.providerSequence.length)
      )
      await writeTranscriptSyncState(args.store, chat.id, session, nextProviderSequence)
      stats.processed += 1
      stats.appended += 1
      onProgress?.(
        `${LOG_PREFIX} session sync: processed ${index + 1}/${orderedSessions.length} action=appended duration=${formatDurationMs(sessionStartedAt)} ${sessionLabel}${titleLogSuffix}`
      )
      continue
    }

    const previousProviderSequence = syncState?.v === 1 && syncState.provider === session.provider && syncState.sessionToken === session.sessionToken
      ? syncState.providerSequence
      : []
    const reconciledEntries = reconcileTranscript(session.provider, currentEntries, session.canonicalEntries, previousProviderSequence, session.sessionToken)
    await args.store.replaceTranscript(chat.id, reconciledEntries)
    await writeTranscriptSyncState(args.store, chat.id, session, nextProviderSequence)
    stats.processed += 1
    stats.reconciled += 1
    onProgress?.(
      `${LOG_PREFIX} session sync: processed ${index + 1}/${orderedSessions.length} action=reconciled duration=${formatDurationMs(sessionStartedAt)} ${sessionLabel}${titleLogSuffix}`
    )
  }

  onProgress?.(
    `${LOG_PREFIX} session sync: complete in ${formatDurationMs(syncStartedAt)}; ${stats.processed} processed, ${stats.created} created, ${stats.appended} appended, ${stats.reconciled} reconciled, ${stats.unchanged} unchanged, ${stats.hidden} hidden, ${stats.emptySkipped} empty skipped, ${stats.titleSkipped} title skipped`
  )
}

async function generateInitialSyncedChatTitle(
  session: ExternalSessionSnapshot,
  cwd: string,
  generateTitle: (
    messageContent: string,
    cwd: string,
    preferredProvider?: "claude" | "codex"
  ) => Promise<GenerateChatTitleResult>
): Promise<GeneratedSyncTitle> {
  const firstUserPrompt = firstImportedUserPromptContent(session.canonicalEntries)
  if (!firstUserPrompt) {
    return { title: null, source: "skipped_no_user_prompt", provider: null, attempts: [] }
  }

  try {
    const generated = await generateTitle(firstUserPrompt, cwd, session.provider)
    const title = generated.title?.trim() ?? null
    if (generated.usedFallback) {
      return {
        title,
        source: "fallback",
        provider: generated.provider ?? null,
        attempts: generated.attempts ?? [],
      }
    }
    if (title) {
      return { title, source: "generated", provider: generated.provider ?? null, attempts: generated.attempts ?? [] }
    }
    return {
      title: fallbackTitleFromMessage(firstUserPrompt),
      source: "fallback",
      provider: generated.provider ?? null,
      attempts: generated.attempts ?? [],
    }
  } catch {
    return {
      title: fallbackTitleFromMessage(firstUserPrompt),
      source: "fallback",
      provider: null,
      attempts: [],
    }
  }
}

function firstImportedUserPromptContent(canonicalEntries: CanonicalProviderEntry[]) {
  for (const canonicalEntry of canonicalEntries) {
    if (canonicalEntry.entry.kind !== "user_prompt") {
      continue
    }

    const content = canonicalEntry.entry.content.trim()
    if (content) {
      return content
    }
  }

  return null
}

function hasImportableTranscriptContent(canonicalEntries: CanonicalProviderEntry[]) {
  return canonicalEntries.some((canonicalEntry) => {
    const entry = canonicalEntry.entry
    if (entry.kind === "user_prompt") {
      return entry.content.trim().length > 0 || Boolean(entry.attachments?.length)
    }
    return entry.kind === "assistant_text"
      || entry.kind === "tool_call"
      || entry.kind === "tool_result"
  })
}

async function collectClaudeSessions(
  homeDir: string,
  projectPaths: string[],
  onProgress?: (message: string) => void
): Promise<ExternalSessionSnapshot[]> {
  const projectsDir = path.join(homeDir, ".claude", "projects")
  if (!existsSync(projectsDir)) {
    return []
  }

  const targetPaths = new Set(projectPaths.map((projectPath) => resolveLocalPath(projectPath)))
  const sessions: ExternalSessionSnapshot[] = []

  for (const entry of readdirSync(projectsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue
    }

    const resolvedProjectPath = resolveLocalPath(await resolveEncodedClaudePath(entry.name))
    if (!targetPaths.has(resolvedProjectPath)) {
      continue
    }

    const sessionDir = path.join(projectsDir, entry.name)
    const sessionDirEntries = (() => {
      try {
        return readdirSync(sessionDir, { withFileTypes: true })
      } catch (error) {
        onProgress?.(
          `${LOG_PREFIX} session sync: Claude project dir read failed path=${resolvedProjectPath} dir=${sessionDir} error=${formatProgressError(error)}`
        )
        return null
      }
    })()
    if (!sessionDirEntries) {
      continue
    }

    for (const sessionEntry of sessionDirEntries) {
      if (!sessionEntry.isFile() || !sessionEntry.name.endsWith(".jsonl")) {
        continue
      }

      const sessionPath = path.join(sessionDir, sessionEntry.name)
      const sessionToken = path.basename(sessionPath, ".jsonl")
      let snapshot: ExternalSessionSnapshot | null
      try {
        snapshot = readClaudeSessionFile(sessionPath, resolvedProjectPath)
      } catch (error) {
        onProgress?.(
          `${LOG_PREFIX} session sync: Claude session read failed path=${resolvedProjectPath} session=${sessionToken} file=${sessionPath} error=${formatProgressError(error)}`
        )
        continue
      }
      if (snapshot) {
        sessions.push(snapshot)
      }
    }
  }

  return sessions
}

function readClaudeSessionFile(sessionPath: string, localPath: string): ExternalSessionSnapshot | null {
  const fileStat = statSync(sessionPath)
  const sessionToken = path.basename(sessionPath, ".jsonl")
  const canonicalEntries: CanonicalProviderEntry[] = []
  let updatedAt = fileStat.mtimeMs
  let lineIndex = 0
  const structuredToolIds = new Set<string>()

  for (const rawLine of readFileSync(sessionPath, "utf8").split("\n")) {
    const line = rawLine.trim()
    if (!line) {
      lineIndex += 1
      continue
    }

    let record: any
    try {
      record = JSON.parse(line)
    } catch {
      lineIndex += 1
      continue
    }

    const recordTimestamp = typeof record?.timestamp === "string" ? Date.parse(record.timestamp) : Number.NaN
    const createdAt = Number.isNaN(recordTimestamp) ? updatedAt : recordTimestamp
    updatedAt = Math.max(updatedAt, createdAt)

    const recordBase = `claude:${sessionToken}:record:${typeof record?.uuid === "string" ? record.uuid : lineIndex}`
    const userPrompt = claudeUserPromptEntry(record, createdAt)
    if (userPrompt) {
      canonicalEntries.push(canonicalizeProviderEntry(`${recordBase}:user_prompt`, withClaudeImportMetadata(userPrompt, record, sessionToken)))
    }

    const normalized = normalizeClaudeStreamMessage(record, { structuredToolIds })
    normalized.forEach((entry, index) => {
      if (entry.kind === "tool_call" && STRUCTURED_RESULT_TOOL_KINDS.has(entry.tool.toolKind)) structuredToolIds.add(entry.tool.toolId)
      const normalizedEntry = withClaudeImportMetadata(reidentifyEntry(entry, createdAt), record, sessionToken)
      canonicalEntries.push(
        canonicalizeProviderEntry(
          claudeProviderKey(recordBase, normalizedEntry, index),
          normalizedEntry
        )
      )
    })

    lineIndex += 1
  }
  return {
    provider: "claude",
    sessionToken,
    localPath,
    updatedAt,
    canonicalEntries,
    canonicalHash: canonicalHash(canonicalEntries),
  }
}

function withClaudeImportMetadata(entry: TranscriptEntry, record: any, sessionToken: string): TranscriptEntry {
  // The file owns these native rows even when the SDK record has no session
  // field. Keep the original record untouched so debugRaw remains accurate.
  return {
    ...entry,
    claudeSessionToken: sessionToken,
    ...(typeof record?.uuid === "string" && record.uuid ? { messageId: record.uuid } : {}),
    ...(typeof record?.parent_tool_use_id === "string" && record.parent_tool_use_id ? { parentToolUseId: record.parent_tool_use_id } : {}),
    ...(record?.isSidechain === true || (typeof record?.subagent_type === "string" && record.subagent_type) ? { claudeSidechain: true } : {}),
  }
}

function claudeUserPromptEntry(
  record: any,
  createdAt: number
): Extract<TranscriptEntry, { kind: "user_prompt" }> | null {
  if (record?.type !== "user" || record?.isMeta) {
    return null
  }

  const nativeContent = record?.message?.content
  const content = typeof nativeContent === "string"
    ? nativeContent
    : Array.isArray(nativeContent)
      ? nativeContent.flatMap((block: any) => (
        block?.type === "text" && typeof block.text === "string" ? [block.text] : []
      )).join("\n")
      : null
  if (!content) {
    return null
  }

  if (content.startsWith(CLAUDE_RESUME_BANNER_PREFIX)) {
    return null
  }

  if (isClaudeLocalCommandPrompt(content)) {
    return null
  }

  const sanitizedContent = sanitizeImportedPrompt(content)
  if (!sanitizedContent) {
    return null
  }

  return {
    _id: crypto.randomUUID(),
    createdAt,
    kind: "user_prompt",
    content: sanitizedContent,
  }
}

function claudeProviderKey(recordBase: string, entry: TranscriptEntry, index: number) {
  switch (entry.kind) {
    case "assistant_text":
      return `${recordBase}:assistant_text:${index}`
    case "tool_call":
      return `${recordBase}:tool_call:${entry.tool.toolId}`
    case "tool_result":
      return `${recordBase}:tool_result:${entry.toolId}`
    case "system_init":
      return `${recordBase}:system_init`
    case "compact_boundary":
      return `${recordBase}:compact_boundary`
    case "compact_summary":
      return `${recordBase}:compact_summary`
    case "context_cleared":
      return `${recordBase}:context_cleared`
    case "status":
      return `${recordBase}:status:${entry.status}`
    case "result":
      return `${recordBase}:result:${entry.subtype}`
    case "interrupted":
      return `${recordBase}:interrupted`
    default:
      return `${recordBase}:${entry.kind}:${index}`
  }
}

async function collectCodexSessions(
  codexClient: CodexSessionSyncClient,
  projectPaths: string[],
  onProgress?: (message: string) => void
): Promise<ExternalSessionSnapshot[]> {
  const sessions: ExternalSessionSnapshot[] = []

  for (const [index, projectPath] of projectPaths.entries()) {
    let threads: Thread[]
    const listThreadsStartedAt = Date.now()
    try {
      threads = await codexClient.listThreads({ cwd: projectPath })
    } catch (error) {
      onProgress?.(
        `${LOG_PREFIX} session sync: Codex project ${index + 1}/${projectPaths.length} listThreads failed in ${formatDurationMs(listThreadsStartedAt)} path=${projectPath} error=${formatProgressError(error)}`
      )
      continue
    }
    onProgress?.(
      `${LOG_PREFIX} session sync: Codex project ${index + 1}/${projectPaths.length} listThreads complete in ${formatDurationMs(listThreadsStartedAt)} (${threads.length} threads) path=${projectPath}`
    )

    const readThreadsStartedAt = Date.now()
    for (const thread of threads) {
      let fullThread: Thread
      try {
        fullThread = await codexClient.readThread({ cwd: projectPath, threadId: thread.id }) ?? thread
      } catch (error) {
        onProgress?.(
          `${LOG_PREFIX} session sync: Codex project ${index + 1}/${projectPaths.length} readThread failed in ${formatDurationMs(readThreadsStartedAt)} path=${projectPath} thread=${thread.id} error=${formatProgressError(error)}`
        )
        continue
      }
      const canonicalEntries = codexThreadEntries(fullThread)
      sessions.push({
        provider: "codex",
        sessionToken: fullThread.id,
        localPath: resolveLocalPath(fullThread.cwd),
        updatedAt: fullThread.updatedAt * 1000,
        canonicalEntries,
        canonicalHash: canonicalHash(canonicalEntries),
      })
    }
    onProgress?.(
      `${LOG_PREFIX} session sync: Codex project ${index + 1}/${projectPaths.length} readThread complete in ${formatDurationMs(readThreadsStartedAt)} (${threads.length} threads) path=${projectPath}`
    )
  }

  return sessions
}
function codexThreadEntries(thread: Thread) {
  const canonicalEntries: CanonicalProviderEntry[] = []
  let sequence = 0
  const asyncQuestions = new Map<string, string>()

  for (const turn of thread.turns) {
    for (const item of turn.items) {
      const createdAt = Math.max(0, thread.updatedAt * 1000 + sequence)
      const normalizedEntries = importedCodexItemEntries(item, thread.id, asyncQuestions)
      normalizedEntries.forEach((entry, index) => {
        const normalizedEntry = reidentifyEntry(entry, createdAt + index)
        canonicalEntries.push(
          canonicalizeProviderEntry(
            codexProviderKey(thread.id, turn.id, item.id, normalizedEntry, index),
            normalizedEntry
          )
        )
      })
      sequence += Math.max(normalizedEntries.length, 1)
    }
  }

  return canonicalEntries
}

// Historical decoding stays local to session import so native live-question
// support can be composed independently of this optional startup feature.
function importedCodexItemEntries(
  item: Thread["turns"][number]["items"][number],
  threadId: string,
  asyncQuestions: Map<string, string>,
): TranscriptEntry[] {
  if (item.type === "agentMessage") {
    const historical = item as typeof item & {
      delivery?: string | null
      questions?: { title: string; options?: string[] | null }[] | null
    }
    if (historical.delivery === "async" && historical.questions?.length) {
      const input = {
        codexAsync: { threadId },
        questions: historical.questions.map((question, index) => {
          const id = JSON.stringify(["request_user_input_async", item.id, index])
          asyncQuestions.set(id, item.id)
          return { id, question: question.title,
            ...(question.options?.length ? { options: question.options.map(label => ({ label })) } : {}),
          }
        }),
      }
      return [{ _id: crypto.randomUUID(), createdAt: Date.now(), kind: "tool_call", tool: {
        kind: "tool", toolKind: "ask_user_question", toolName: "AskUserQuestion", toolId: item.id, input,
      } }]
    }
  }
  if (item.type === "userMessage") {
    const text = item.content.filter(block => block.type === "text").map(block => block.text).join("\n").trim()
    const open = "<send_user_message_question_reply>"
    const close = "</send_user_message_question_reply>"
    if (text.startsWith(open) && text.endsWith(close)) {
      try {
        const decoded: unknown = JSON.parse(text.slice(open.length, -close.length))
        const replies: unknown[] = Array.isArray(decoded) ? decoded : [decoded]
        const results = new Map<string, Record<string, string[]>>()
        if (replies.length && replies.every(reply => {
          if (!reply || typeof reply !== "object") return false
          const value = reply as Record<string, unknown>
          return ["questionItemId", "question", "answer"].every(key => typeof value[key] === "string" && value[key].trim())
        })) {
          for (const reply of replies as { questionItemId: string; answer: string }[]) {
            const toolId = asyncQuestions.get(reply.questionItemId)
            if (!toolId) continue
            const answers = results.get(toolId) ?? {}
            answers[reply.questionItemId] = [reply.answer]
            results.set(toolId, answers)
          }
          if (results.size) return [...results].map(([toolId, answers]) => ({
            _id: crypto.randomUUID(), createdAt: Date.now(), kind: "tool_result", toolId, content: { answers },
          }))
        }
      } catch { /* Preserve malformed native envelopes as user text. */ }
    }
  }
  return codexThreadItemToTranscriptEntries(item)
}

function codexProviderKey(
  threadId: string,
  turnId: string,
  itemId: string,
  entry: TranscriptEntry,
  index: number
) {
  switch (entry.kind) {
    case "user_prompt":
      return `codex:${threadId}:turn:${turnId}:item:${itemId}:user_prompt`
    case "assistant_text":
      return `codex:${threadId}:turn:${turnId}:item:${itemId}:assistant_text`
    case "tool_call":
      return `codex:${threadId}:turn:${turnId}:item:${itemId}:tool_call:${entry.tool.toolId}`
    case "tool_result":
      return `codex:${threadId}:turn:${turnId}:item:${itemId}:tool_result:${entry.toolId}`
    default:
      return `codex:${threadId}:turn:${turnId}:item:${itemId}:${entry.kind}:${index}`
  }
}

function canonicalizeProviderEntry(providerKey: string, entry: TranscriptEntry): CanonicalProviderEntry {
  return {
    providerKey,
    providerHash: hashValue(stripTranscriptIdentity(entry)),
    matchKey: transcriptEntryMatchKey(entry) ?? `${entry.kind}:${providerKey}`,
    entry,
  }
}

function reidentifyEntry(entry: TranscriptEntry, createdAt: number): TranscriptEntry {
  return {
    ...entry,
    _id: crypto.randomUUID(),
    createdAt,
  }
}

function sanitizeImportedPrompt(content: string) {
  const hadAttachmentBlock = KANNA_ATTACHMENTS_BLOCK_PATTERN.test(content)
  const stripped = content.replace(KANNA_ATTACHMENTS_BLOCK_PATTERN, "").trim()
  if (!hadAttachmentBlock) {
    return stripped
  }
  if (stripped === KANNA_ATTACHMENT_ONLY_PLACEHOLDER) {
    return ""
  }
  return stripped
}

function isClaudeLocalCommandPrompt(content: string) {
  let remaining = content.trim()
  if (!remaining) {
    return false
  }

  let sawTag = false
  while (remaining) {
    const match = CLAUDE_XMLISH_TAG_BLOCK_PATTERN.exec(remaining)
    if (!match) {
      return false
    }

    const tagName = match[1]
    if (!tagName || !CLAUDE_LOCAL_COMMAND_TAGS.has(tagName)) {
      return false
    }

    sawTag = true
    remaining = remaining.slice(match[0].length).trimStart()
  }

  return sawTag
}

function reconcileTranscript(
  provider: "claude" | "codex",
  currentEntries: TranscriptEntry[],
  canonicalEntries: CanonicalProviderEntry[],
  previousProviderSequence: TranscriptSyncProviderRecord[],
  sessionToken: string
) {
  const toolCallsById = buildToolCallIndex(currentEntries)
  const nativeToolIds = new Set(canonicalEntries.flatMap(({ entry }) => entry.kind === "tool_call" ? [entry.tool.toolId] : []))
  const nativeResultIds = new Set(canonicalEntries.flatMap(({ entry }) => entry.kind === "tool_result" ? [entry.toolId] : []))
  // Local answers/status rows invalidate the transcript hash, but not the
  // provider provenance of prior rows. Keep it to identify deleted native tools.
  const previousMatchKeys = new Set(previousProviderSequence.map(record => record.matchKey))
  const previousProviderKeys = new Set(previousProviderSequence.map(record => record.providerKey))
  const previousNativeResults = new Set<TranscriptEntry>()
  for (const entry of currentEntries) {
    const previouslyNative = previousMatchKeys.has(transcriptEntryMatchKey(entry)!)
      || hasPreviousNativeToolIdentity(provider, sessionToken, entry, previousProviderKeys)
    if (entry.kind === "tool_call" && previouslyNative) {
      nativeToolIds.add(entry.tool.toolId)
    } else if (entry.kind === "tool_result" && previouslyNative) {
      // Prior ownership belongs to this row. Another Kanna-only answer to the
      // same tool can remain local when there is no current native result.
      previousNativeResults.add(entry)
    }
  }
  const matches = matchCurrentEntriesToCanonical(provider, currentEntries, canonicalEntries, toolCallsById, nativeToolIds, nativeResultIds, previousNativeResults)
  const preservedOverlays = collectPreservedOverlays(
    provider,
    currentEntries,
    canonicalEntries,
    matches.currentToCanonical,
    toolCallsById,
    nativeToolIds,
    nativeResultIds,
    previousNativeResults
  )

  const beforeByProviderKey = new Map<string, TranscriptEntry[]>()
  const afterByProviderKey = new Map<string, TranscriptEntry[]>()

  for (const overlay of preservedOverlays) {
    if (overlay.afterProviderKey) {
      const existing = afterByProviderKey.get(overlay.afterProviderKey) ?? []
      existing.push(overlay.entry)
      afterByProviderKey.set(overlay.afterProviderKey, existing)
      continue
    }

    if (overlay.beforeProviderKey) {
      const existing = beforeByProviderKey.get(overlay.beforeProviderKey) ?? []
      existing.push(overlay.entry)
      beforeByProviderKey.set(overlay.beforeProviderKey, existing)
    }
  }

  const rebuilt: TranscriptEntry[] = []
  for (let canonicalIndex = 0; canonicalIndex < canonicalEntries.length; canonicalIndex += 1) {
    const canonicalEntry = canonicalEntries[canonicalIndex]!
    const beforeEntries = beforeByProviderKey.get(canonicalEntry.providerKey)
    if (beforeEntries) {
      rebuilt.push(...beforeEntries)
    }

    const matchedCurrentIndex = matches.canonicalToCurrent.get(canonicalIndex)
    if (matchedCurrentIndex !== undefined) {
      const current = currentEntries[matchedCurrentIndex]!
      // Native history owns payload and provider metadata, including removal
      // of obsolete fields. Keep only Kanna identity and local UI annotations.
      const refreshed: TranscriptEntry = {
        ...canonicalEntry.entry,
        _id: current._id,
        createdAt: current.createdAt,
        ...(current.hidden !== undefined ? { hidden: current.hidden } : {}),
      }
      if (current.kind === "user_prompt" && refreshed.kind === "user_prompt") {
        if (current.attachments !== undefined) refreshed.attachments = current.attachments
        if (current.steered !== undefined) refreshed.steered = current.steered
      }
      rebuilt.push(refreshed)
    } else {
      rebuilt.push(canonicalEntry.entry)
    }

    const afterEntries = afterByProviderKey.get(canonicalEntry.providerKey)
    if (afterEntries) {
      rebuilt.push(...afterEntries)
    }
  }

  return rebuilt
}

function hasPreviousNativeToolIdentity(
  provider: "claude" | "codex",
  sessionToken: string,
  entry: TranscriptEntry,
  providerKeys: ReadonlySet<string>
) {
  if (!entry.messageId || (entry.kind !== "tool_call" && entry.kind !== "tool_result")) return false
  const toolId = entry.kind === "tool_call" ? entry.tool.toolId : entry.toolId
  if (provider === "claude") {
    return providerKeys.has(`claude:${sessionToken}:record:${entry.messageId}:${entry.kind}:${toolId}`)
  }
  const suffix = `:item:${entry.messageId}:${entry.kind}:${toolId}`
  return [...providerKeys].some(key => key.startsWith(`codex:${sessionToken}:turn:`) && key.endsWith(suffix))
}

function buildToolCallIndex(entries: TranscriptEntry[]) {
  const toolCallsById = new Map<string, ToolCallEntry>()
  for (const entry of entries) {
    if (entry.kind === "tool_call") {
      toolCallsById.set(entry.tool.toolId, entry)
    }
  }
  return toolCallsById
}

function matchCurrentEntriesToCanonical(
  provider: "claude" | "codex",
  currentEntries: TranscriptEntry[],
  canonicalEntries: CanonicalProviderEntry[],
  toolCallsById: Map<string, ToolCallEntry>,
  nativeToolIds: ReadonlySet<string>,
  nativeResultIds: ReadonlySet<string>,
  previousNativeResults: ReadonlySet<TranscriptEntry>
) {
  const currentToCanonical = new Map<number, number>()
  const canonicalToCurrent = new Map<number, number>()
  let cursor = 0

  for (let currentIndex = 0; currentIndex < currentEntries.length; currentIndex += 1) {
    const currentEntry = currentEntries[currentIndex]!
    if (isPreservableOverlay(provider, currentEntry, toolCallsById, nativeToolIds, nativeResultIds, previousNativeResults)) {
      continue
    }

    const matchKey = transcriptEntryMatchKey(currentEntry)
    if (!matchKey) {
      continue
    }

    const currentTool = currentEntry.kind === "tool_call" ? currentEntry
      : currentEntry.kind === "tool_result" ? toolCallsById.get(currentEntry.toolId) : undefined
    const interactive = currentTool && isInteractiveToolCall(currentTool)
    let canonicalIndex = -1
    for (let index = cursor; index < canonicalEntries.length; index += 1) {
      const candidate = canonicalEntries[index]!
      const sameNativeCall = interactive && currentEntry.kind === "tool_call" && candidate.entry.kind === "tool_call"
        && nativeToolIds.has(currentEntry.tool.toolId) && currentEntry.tool.toolId === candidate.entry.tool.toolId
      const sameNativeResult = interactive && currentEntry.kind === "tool_result" && candidate.entry.kind === "tool_result"
        && nativeResultIds.has(currentEntry.toolId) && currentEntry.toolId === candidate.entry.toolId
        && currentEntry.messageId !== undefined && currentEntry.messageId === candidate.entry.messageId
      if (candidate.matchKey === matchKey || sameNativeCall || sameNativeResult) {
        canonicalIndex = index
        break
      }
    }

    if (canonicalIndex === -1) {
      continue
    }

    currentToCanonical.set(currentIndex, canonicalIndex)
    canonicalToCurrent.set(canonicalIndex, currentIndex)
    cursor = canonicalIndex + 1
  }

  return { currentToCanonical, canonicalToCurrent }
}

function collectPreservedOverlays(
  provider: "claude" | "codex",
  currentEntries: TranscriptEntry[],
  canonicalEntries: CanonicalProviderEntry[],
  currentToCanonical: Map<number, number>,
  toolCallsById: Map<string, ToolCallEntry>,
  nativeToolIds: ReadonlySet<string>,
  nativeResultIds: ReadonlySet<string>,
  previousNativeResults: ReadonlySet<TranscriptEntry>
) {
  const overlays: PreservedOverlayEntry[] = []

  for (let currentIndex = 0; currentIndex < currentEntries.length; currentIndex += 1) {
    const currentEntry = currentEntries[currentIndex]!
    if (currentToCanonical.has(currentIndex)) {
      continue
    }

    if (!isPreservableOverlay(provider, currentEntry, toolCallsById, nativeToolIds, nativeResultIds, previousNativeResults)) {
      continue
    }

    const afterProviderKey = nearestProviderKeyBefore(currentIndex, currentToCanonical, canonicalEntries)
    const beforeProviderKey = nearestProviderKeyAfter(currentIndex, currentEntries.length, currentToCanonical, canonicalEntries)
    if (!afterProviderKey && !beforeProviderKey) {
      continue
    }

    overlays.push({
      entry: currentEntry,
      afterProviderKey,
      beforeProviderKey,
    })
  }

  return overlays
}

function nearestProviderKeyBefore(
  startIndex: number,
  currentToCanonical: Map<number, number>,
  canonicalEntries: CanonicalProviderEntry[]
) {
  for (let index = startIndex - 1; index >= 0; index -= 1) {
    const canonicalIndex = currentToCanonical.get(index)
    if (canonicalIndex === undefined) continue
    return canonicalEntries[canonicalIndex]?.providerKey
  }
  return undefined
}

function nearestProviderKeyAfter(
  startIndex: number,
  entryCount: number,
  currentToCanonical: Map<number, number>,
  canonicalEntries: CanonicalProviderEntry[]
) {
  for (let index = startIndex + 1; index < entryCount; index += 1) {
    const canonicalIndex = currentToCanonical.get(index)
    if (canonicalIndex === undefined) continue
    return canonicalEntries[canonicalIndex]?.providerKey
  }
  return undefined
}

function isPreservableOverlay(
  provider: "claude" | "codex",
  entry: TranscriptEntry,
  toolCallsById: Map<string, ToolCallEntry>,
  nativeToolIds: ReadonlySet<string>,
  nativeResultIds: ReadonlySet<string>,
  previousNativeResults: ReadonlySet<TranscriptEntry>
) {
  if (
    entry.kind === "account_info"
    || entry.kind === "result"
    || entry.kind === "system_init"
    || entry.kind === "compact_boundary"
    || entry.kind === "compact_summary"
    || entry.kind === "context_cleared"
    || entry.kind === "interrupted"
    || entry.kind === "status"
  ) {
    return true
  }

  if (entry.kind === "tool_call") {
    return !nativeToolIds.has(entry.tool.toolId) && isKannaSpecificToolCall(entry)
  }

  if (entry.kind === "tool_result") {
    const toolCall = toolCallsById.get(entry.toolId)
    // A local answer may exist before the native session records a result.
    // Owning the call alone does not make the provider own that answer.
    return toolCall ? !nativeResultIds.has(entry.toolId) && !previousNativeResults.has(entry) && isKannaSpecificToolCall(toolCall) : false
  }

  if (
    provider === "claude"
    && entry.kind === "user_prompt"
    && isClaudeLocalCommandPrompt(entry.content)
  ) {
    return true
  }

  return false
}

function hasInteractiveProviderOverlap(currentEntries: TranscriptEntry[], appended: CanonicalProviderEntry[]) {
  const toolCallsById = buildToolCallIndex(currentEntries)
  const existingInteractiveRows = new Set(currentEntries.flatMap(entry => {
    const call = entry.kind === "tool_call" ? entry : entry.kind === "tool_result" ? toolCallsById.get(entry.toolId) : undefined
    if (!call || !isInteractiveToolCall(call)) return []
    return [`${entry.kind}:${call.tool.toolId}`]
  }))
  // An answer recorded by Kanna may precede its native counterpart. Reconcile
  // that ownership transition instead of appending a duplicate native answer.
  return appended.some(({ entry }) => entry.kind === "tool_call"
    ? existingInteractiveRows.has(`tool_call:${entry.tool.toolId}`)
    : entry.kind === "tool_result" && existingInteractiveRows.has(`tool_result:${entry.toolId}`))
}

function isKannaSpecificToolCall(entry: ToolCallEntry) {
  // Native async cards belong to the provider snapshot, even though they
  // render through the same question tool as Kanna-specific overlays.
  if (entry.tool.toolKind === "ask_user_question" && "codexAsync" in entry.tool.input) return false
  return isInteractiveToolCall(entry)
}

function isInteractiveToolCall(entry: ToolCallEntry) {
  return entry.tool.toolKind === "ask_user_question"
    || entry.tool.toolKind === "exit_plan_mode"
    || entry.tool.toolKind === "todo_write"
}

function isTranscriptSyncStateUsable(
  state: TranscriptSyncState | null,
  session: ExternalSessionSnapshot,
  currentEntries: TranscriptEntry[]
) {
  if (!state) {
    return false
  }

  return state.v === 1
    && state.canonicalMetadataVersion === 1
    && state.provider === session.provider
    && state.sessionToken === session.sessionToken
    && state.transcriptHash === transcriptHash(currentEntries)
}

function isProviderSequencePrefix(
  currentSequence: TranscriptSyncProviderRecord[],
  nextSequence: TranscriptSyncProviderRecord[]
) {
  if (currentSequence.length > nextSequence.length) {
    return false
  }

  for (let index = 0; index < currentSequence.length; index += 1) {
    const current = currentSequence[index]
    const next = nextSequence[index]
    if (
      !current
      || !next
      || current.providerKey !== next.providerKey
      || current.providerHash !== next.providerHash
      || current.matchKey !== next.matchKey
    ) {
      return false
    }
  }

  return true
}

async function appendCanonicalEntries(
  store: EventStore,
  chatId: string,
  canonicalEntries: CanonicalProviderEntry[]
) {
  for (const canonicalEntry of canonicalEntries) {
    await store.appendMessage(chatId, canonicalEntry.entry)
  }
}

async function writeTranscriptSyncState(
  store: EventStore,
  chatId: string,
  session: ExternalSessionSnapshot,
  providerSequence: TranscriptSyncProviderRecord[]
) {
  const entries = store.getMessages(chatId)
  await store.setTranscriptSyncState(chatId, {
    v: 1,
    canonicalMetadataVersion: 1,
    provider: session.provider,
    sessionToken: session.sessionToken,
    transcriptHash: transcriptHash(entries),
    canonicalHash: session.canonicalHash,
    providerSequence,
  })
}

function toProviderSequence(canonicalEntries: CanonicalProviderEntry[]): TranscriptSyncProviderRecord[] {
  return canonicalEntries.map((entry) => ({
    providerKey: entry.providerKey,
    providerHash: entry.providerHash,
    matchKey: entry.matchKey,
  }))
}

function canonicalHash(canonicalEntries: CanonicalProviderEntry[]) {
  return hashValue(canonicalEntries.map((entry) => ({
    providerKey: entry.providerKey,
    providerHash: entry.providerHash,
  })))
}

function transcriptHash(entries: TranscriptEntry[]) {
  return hashValue(entries.map((entry) => stableSerialize(entry)))
}

function stripTranscriptIdentity(entry: TranscriptEntry) {
  const { _id: _ignoredId, createdAt: _ignoredCreatedAt, ...rest } = entry
  return rest
}

function transcriptEntryMatchKey(entry: TranscriptEntry): string | null {
  switch (entry.kind) {
    case "user_prompt":
      return `user_prompt:${entry.content}`
    case "assistant_text":
      return `assistant_text:${entry.text}`
    case "tool_call":
      return `tool_call:${entry.tool.toolName}:${entry.tool.toolId}:${stableSerialize(entry.tool.input)}`
    case "tool_result":
      return `tool_result:${entry.toolId}:${entry.isError ? "1" : "0"}:${stableSerialize(entry.content)}`
    case "compact_summary":
      return `compact_summary:${entry.summary}`
    case "compact_boundary":
      return "compact_boundary"
    case "context_cleared":
      return "context_cleared"
    case "interrupted":
      return "interrupted"
    case "status":
      return `status:${entry.status}`
    case "result":
      return `result:${entry.subtype}:${entry.result}`
    case "system_init":
      return `system_init:${entry.provider}:${entry.model}`
    case "account_info":
      return `account_info:${stableSerialize(entry.accountInfo)}`
    default:
      return null
  }
}

function hashValue(value: unknown) {
  return createHash("sha256").update(stableSerialize(value)).digest("hex")
}

function stableSerialize(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value)
  }

  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableSerialize(entry)).join(",")}]`
  }

  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entryValue]) => `${JSON.stringify(key)}:${stableSerialize(entryValue)}`)

  return `{${entries.join(",")}}`
}
