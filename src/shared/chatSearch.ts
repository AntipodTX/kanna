import type { NormalizedToolCall, TranscriptEntry } from "./types"

const SPECIAL_TOOL_NAMES = new Set(["AskUserQuestion", "ExitPlanMode", "CodexApproval", "TodoWrite"])
const PREVIEW_RADIUS = 56

export interface ChatSearchEntryResult {
  chatId: string
  /** Original entry whose searchable text matched. */
  entryId: string
  /** Exact rendered entry to reveal and highlight (a result uses its call). */
  revealEntryId: string
  /** Outermost transcript row that contains the exact rendered entry. */
  targetEntryId: string
  messageId?: string
  kind: TranscriptEntry["kind"]
  createdAt: number
  matchCount: number
  preview: string
}

interface ChatSearchOptions {
  chatId: string
  localPath?: string | null
  includeToolEntries?: boolean
}

/** Payloads omitted from a snapshot and needed only for tool-inclusive search. */
export function getTrimmedToolEntryIds(entries: readonly TranscriptEntry[]): string[] {
  return entries
    .filter((entry) => entry.trimmed && (entry.kind === "tool_call" || entry.kind === "tool_result"))
    .map((entry) => entry._id)
}

/** Replace snapshot headers with payload-bearing entries without disturbing transcript order. */
export function mergeTranscriptSearchPayloads(
  entries: readonly TranscriptEntry[],
  payloads: readonly TranscriptEntry[],
): TranscriptEntry[] {
  if (payloads.length === 0) return [...entries]
  const payloadById = new Map(payloads.map((entry) => [entry._id, entry]))
  return entries.map((entry) => payloadById.get(entry._id) ?? entry)
}

export function searchTranscriptEntries(
  entries: readonly TranscriptEntry[],
  query: string,
  options: ChatSearchOptions,
): ChatSearchEntryResult[] {
  const normalizedQuery = query.trim().toLocaleLowerCase()
  if (!normalizedQuery) return []

  const results: ChatSearchEntryResult[] = []
  const toolCallsByToolId = new Map<string, Extract<TranscriptEntry, { kind: "tool_call" }>>()
  const searchableToolResultsByToolId = new Set<string>()
  const visibility = buildTranscriptEntrySearchVisibility(entries)

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!
    // Match hydration: only an owner already encountered in the transcript
    // can contain this entry. A later owner leaves an out-of-order child as
    // an ordinary top-level row.
    if (entry.kind === "tool_call") toolCallsByToolId.set(entry.tool.toolId, entry)
    if (!visibility[index]) continue
    if (!options.includeToolEntries && !isDefaultSearchEntry(entry)) continue

    if (entry.kind === "tool_call" && !SPECIAL_TOOL_NAMES.has(entry.tool.toolName)) {
      searchableToolResultsByToolId.add(entry.tool.toolId)
    }
    if (entry.kind === "tool_result" && !searchableToolResultsByToolId.has(entry.toolId)) continue

    const searchableText = getTranscriptEntrySearchText(entry, options)
    if (!searchableText) continue

    const matchCount = countMatches(searchableText, normalizedQuery)
    if (matchCount === 0) continue

    const navigationTarget = getTranscriptEntrySearchTarget(entry, toolCallsByToolId)
    results.push({
      chatId: options.chatId,
      entryId: entry._id,
      revealEntryId: navigationTarget.revealEntryId,
      targetEntryId: navigationTarget.targetEntryId,
      messageId: entry.messageId,
      kind: entry.kind,
      createdAt: entry.createdAt,
      matchCount,
      preview: buildMatchPreview(searchableText, normalizedQuery),
    })
  }

  return results
}

function isDefaultSearchEntry(entry: TranscriptEntry) {
  return entry.kind === "user_prompt"
    || entry.kind === "assistant_text"
    || entry.kind === "compact_summary"
}

/** Mirrors the transcript's rules for rows that are absent or redundant. */
function buildTranscriptEntrySearchVisibility(entries: readonly TranscriptEntry[]) {
  const firstSystemIndex = entries.findIndex((entry) => entry.kind === "system_init")
  const firstAccountIndex = entries.findIndex((entry) => entry.kind === "account_info")
  const latestTodoWriteEntryId = findLatestTodoWriteEntryId(entries)

  const modelChanges = new Array<boolean>(entries.length).fill(false)
  let previousModel: string | undefined
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!
    if (entry.kind !== "system_init") continue
    modelChanges[index] = previousModel !== undefined && entry.model !== previousModel
    previousModel = entry.model
  }

  const boundarySystemIndexes = new Set<number>()
  let hasPendingBoundary = false
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!
    if (entry.kind === "handoff_boundary" || entry.kind === "session_restored") {
      hasPendingBoundary = true
    } else if (entry.kind === "system_init" && hasPendingBoundary) {
      boundarySystemIndexes.add(index)
      hasPendingBoundary = false
    }
  }

  const emptyTurnResults = new Array<boolean>(entries.length).fill(false)
  let turnHasContent = false
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!
    if (entry.kind === "user_prompt") {
      turnHasContent = false
    } else if ((entry.kind === "assistant_text" || entry.kind === "tool_call") && !entry.hidden) {
      turnHasContent = true
    } else if (entry.kind === "result") {
      emptyTurnResults[index] = !entry.isError && !turnHasContent
      turnHasContent = false
    }
  }

  const baseVisibility = entries.map((entry, index) => {
    if (entry.hidden) return false

    switch (entry.kind) {
      case "system_init":
        return firstSystemIndex === index || modelChanges[index] === true || boundarySystemIndexes.has(index)
      case "account_info":
        return firstAccountIndex === index
      case "tool_call":
        return entry.tool.toolKind !== "todo_write" || entry._id === latestTodoWriteEntryId
      case "result": {
        const previousEntry = entries[index - 1]
        const nextEntry = entries[index + 1]
        return !emptyTurnResults[index]
          && previousEntry?.kind !== "context_cleared"
          && nextEntry?.kind !== "context_cleared"
      }
      case "context_window_updated":
      case "handoff_boundary":
      case "session_restored":
        return false
      case "status":
        return index === entries.length - 1
      default:
        return true
    }
  })

  // Entries owned by an Agent are rendered inside that Agent's expanded row.
  // Match hydration's single forward pass: only an owner already encountered
  // can contain a child. A missing or later owner leaves the child visible as
  // a top-level row; a hidden owner removes all of its later descendants.
  const resolvedVisibility = new Array<boolean>(entries.length).fill(false)
  const toolCallIndexByToolId = new Map<string, number>()
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!
    const ownerToolId = entry.kind === "tool_result" ? entry.toolId : entry.parentToolUseId
    const ownerIndex = ownerToolId ? toolCallIndexByToolId.get(ownerToolId) : undefined
    resolvedVisibility[index] = baseVisibility[index] === true
      && (ownerIndex === undefined || resolvedVisibility[ownerIndex] === true)
    if (entry.kind === "tool_call") toolCallIndexByToolId.set(entry.tool.toolId, index)
  }

  return resolvedVisibility
}

function findLatestTodoWriteEntryId(entries: readonly TranscriptEntry[]) {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]!
    if (entry.kind === "tool_call" && entry.tool.toolKind === "todo_write") return entry._id
  }
  return null
}

function getTranscriptEntrySearchTarget(
  entry: TranscriptEntry,
  toolCallsByToolId: Map<string, Extract<TranscriptEntry, { kind: "tool_call" }>>,
): { revealEntryId: string; targetEntryId: string } {
  let target = entry.kind === "tool_result"
    ? toolCallsByToolId.get(entry.toolId) ?? entry
    : entry
  const revealEntryId = target._id

  // Subagent entries are rendered inside the Agent call that owns them. Walk
  // through nested ownership when the transcript supplies it, so a result
  // never points at a row that does not exist.
  const visited = new Set<string>()
  while (target.parentToolUseId && !visited.has(target._id)) {
    visited.add(target._id)
    const parent = toolCallsByToolId.get(target.parentToolUseId)
    if (!parent) break
    target = parent
  }
  return { revealEntryId, targetEntryId: target._id }
}

function getTranscriptEntrySearchText(entry: TranscriptEntry, options: ChatSearchOptions): string {
  switch (entry.kind) {
    case "user_prompt":
      return getVisibleUserPromptText(entry.content)
    case "assistant_text":
      return entry.text
    case "tool_call":
      return getVisibleToolCallSearchText(entry.tool, options)
    case "tool_result":
      return stringifySearchValue(entry.content)
    case "result":
      return entry.result
    case "status":
      return entry.status
    case "compact_summary":
      return entry.summary
    case "system_init":
      return [
        entry.provider,
        entry.model,
        ...entry.tools,
        ...entry.agents,
        ...entry.slashCommands,
        ...entry.mcpServers.map((server) => server.name),
      ].join("\n")
    case "account_info":
      return stringifySearchValue(entry.accountInfo)
    case "context_window_updated":
      return stringifySearchValue(entry.usage)
    case "compact_boundary":
    case "context_cleared":
    case "handoff_boundary":
    case "session_restored":
    case "interrupted":
      return ""
  }
}

function getVisibleUserPromptText(content: string) {
  const match = content.match(/^(<system-message>\s*[\s\S]*?\s*<\/system-message>\s*)([\s\S]*)$/)
  return match ? match[2] ?? "" : content
}

function getVisibleToolCallSearchText(tool: NormalizedToolCall, options: ChatSearchOptions) {
  return [getVisibleToolCallTitle(tool, options), getVisibleToolCallExpandedText(tool)]
    .filter(Boolean)
    .join("\n")
}

function getVisibleToolCallTitle(tool: NormalizedToolCall, options: ChatSearchOptions) {
  switch (tool.toolKind) {
    case "skill":
      return tool.input.skill
    case "glob":
      return `Search files ${tool.input.pattern === "**/*" ? "in all directories" : `matching ${tool.input.pattern}`}`
    case "grep": {
      const pattern = tool.input.pattern
      if (tool.input.outputMode === "count") return `Count \`${pattern}\` occurrences`
      if (tool.input.outputMode === "content") return `Find \`${pattern}\` in text`
      return `Find \`${pattern}\` in files`
    }
    case "bash":
      return tool.input.description || (tool.input.command ? formatBashCommandTitle(tool.input.command) : "Bash")
    case "web_search":
      return tool.input.query || "Web Search"
    case "read_file":
      return `Read ${stripWorkspacePath(tool.input.filePath, options.localPath)}`
    case "write_file":
      return `Write ${stripWorkspacePath(tool.input.filePath, options.localPath)}`
    case "edit_file":
      return `Edit ${stripWorkspacePath(tool.input.filePath, options.localPath)}`
    case "delete_file":
      return `Delete ${stripWorkspacePath(tool.input.filePath, options.localPath)}`
    case "mcp_generic":
      return `${toTitleCase(tool.input.tool)} from ${toTitleCase(tool.input.server)}`
    case "subagent_task":
      return tool.input.subagentType || tool.toolName
    default:
      return tool.toolName
  }
}

function getVisibleToolCallExpandedText(tool: NormalizedToolCall) {
  switch (tool.toolKind) {
    case "bash":
      return tool.input.command
    case "write_file":
    case "delete_file":
      return tool.input.content
    case "edit_file":
      return [tool.input.oldString, tool.input.newString].join("\n")
    case "read_file":
      return ""
    case "todo_write":
      return tool.input.todos
        .map((todo) => todo.status === "in_progress" ? todo.activeForm : todo.content)
        .join("\n")
    default:
      return ""
  }
}

function formatBashCommandTitle(command: string) {
  const trimmed = command.trim()
  for (const pattern of SHELL_WRAPPER_PATTERNS) {
    const match = trimmed.match(pattern)
    if (!match) continue
    const candidate = (match[2] ?? match[1] ?? "").trim()
    if (candidate) return candidate
  }
  return trimmed || "Bash"
}

function stripWorkspacePath(filePath: string | undefined, localPath: string | null | undefined) {
  if (!filePath) return ""
  if (localPath) {
    const withSlash = localPath.endsWith("/") ? localPath : `${localPath}/`
    if (filePath.startsWith(withSlash)) return filePath.slice(withSlash.length)
    if (filePath === localPath) return ""
  }
  return filePath.replace(/^\/home\/user\/workspace\//, "")
}

function toTitleCase(value: string) {
  return value
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ")
}

const SHELL_WRAPPER_PATTERNS = [
  /^(?:\/usr\/bin\/env\s+)?(?:\/bin\/)?(?:bash|zsh|sh)\s+(?:-[a-zA-Z]*c|-c)\s+(['"])([\s\S]*)\1$/,
  /^(?:\/usr\/bin\/env\s+)?(?:\/bin\/)?(?:bash|zsh|sh)\s+(?:-[a-zA-Z]*c|-c)\s+(.+)$/,
  /^(?:\/usr\/bin\/env\s+)?(?:cmd(?:\.exe)?)\s+\/c\s+(['"])([\s\S]*)\1$/i,
  /^(?:\/usr\/bin\/env\s+)?(?:cmd(?:\.exe)?)\s+\/c\s+(.+)$/i,
  /^(?:\/usr\/bin\/env\s+)?(?:powershell(?:\.exe)?|pwsh)\s+(?:-NoProfile\s+)?-Command\s+(['"])([\s\S]*)\1$/i,
  /^(?:\/usr\/bin\/env\s+)?(?:powershell(?:\.exe)?|pwsh)\s+(?:-NoProfile\s+)?-Command\s+(.+)$/i,
] as const

function stringifySearchValue(value: unknown): string {
  if (typeof value === "string") return value
  if (value === null || value === undefined) return ""
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function countMatches(text: string, normalizedQuery: string) {
  const normalizedText = text.toLocaleLowerCase()
  let count = 0
  let index = normalizedText.indexOf(normalizedQuery)
  while (index !== -1) {
    count += 1
    index = normalizedText.indexOf(normalizedQuery, index + normalizedQuery.length)
  }
  return count
}

function buildMatchPreview(text: string, normalizedQuery: string) {
  const normalizedText = text.toLocaleLowerCase()
  const matchIndex = normalizedText.indexOf(normalizedQuery)
  if (matchIndex === -1) return collapseWhitespace(text).slice(0, PREVIEW_RADIUS * 2)

  const start = Math.max(0, matchIndex - PREVIEW_RADIUS)
  const end = Math.min(text.length, matchIndex + normalizedQuery.length + PREVIEW_RADIUS)
  const prefix = start > 0 ? "..." : ""
  const suffix = end < text.length ? "..." : ""
  return `${prefix}${collapseWhitespace(text.slice(start, end))}${suffix}`
}

function collapseWhitespace(value: string) {
  return value.replace(/\s+/g, " ").trim()
}
