import type { NormalizedToolCall, TranscriptEntry } from "./types"

const SPECIAL_TOOL_NAMES = new Set(["AskUserQuestion", "ExitPlanMode", "CodexApproval", "TodoWrite"])

export interface ChatSearchEntryResult {
  chatId: string
  entryId: string
  targetEntryId: string
  messageId?: string
  kind: TranscriptEntry["kind"]
  createdAt: number
  matchCount: number
  preview: string
}

export interface ChatSearchCommandResult {
  query: string
  matches: ChatSearchEntryResult[]
}

interface ChatSearchOptions {
  chatId: string
  localPath?: string | null
  includeToolEntries?: boolean
}

const PREVIEW_RADIUS = 56

export function searchTranscriptEntries(entries: TranscriptEntry[], query: string, options: ChatSearchOptions): ChatSearchEntryResult[] {
  const normalizedQuery = query.trim().toLocaleLowerCase()
  if (!normalizedQuery) return []

  const results: ChatSearchEntryResult[] = []
  const toolCallEntryIdsByToolId = new Map<string, string>()
  const searchableToolResultsByToolId = new Set<string>()
  const visibility = buildTranscriptEntrySearchVisibility(entries)

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!
    if (!visibility[index]) continue
    if (!options.includeToolEntries && !isDefaultSearchEntry(entry)) continue

    if (entry.kind === "tool_call") {
      toolCallEntryIdsByToolId.set(entry.tool.toolId, entry._id)
      if (!SPECIAL_TOOL_NAMES.has(entry.tool.toolName)) {
        searchableToolResultsByToolId.add(entry.tool.toolId)
      }
    }
    if (entry.kind === "tool_result" && !searchableToolResultsByToolId.has(entry.toolId)) continue

    const searchableText = getTranscriptEntrySearchText(entry, options)
    if (!searchableText) continue

    const matchCount = countMatches(searchableText, normalizedQuery)
    if (matchCount === 0) continue

    results.push({
      chatId: options.chatId,
      entryId: entry._id,
      targetEntryId: getTranscriptEntrySearchTargetId(entry, toolCallEntryIdsByToolId),
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

function buildTranscriptEntrySearchVisibility(entries: TranscriptEntry[]) {
  const firstSystemIndex = entries.findIndex((entry) => entry.kind === "system_init")
  const firstAccountIndex = entries.findIndex((entry) => entry.kind === "account_info")
  const latestTodoWriteEntryId = findLatestTodoWriteEntryId(entries)

  return entries.map((entry, index) => {
    if (entry.hidden) return false

    switch (entry.kind) {
      case "system_init":
        return firstSystemIndex === index
      case "account_info":
        return firstAccountIndex === index
      case "tool_call":
        return entry.tool.toolKind !== "todo_write" || entry._id === latestTodoWriteEntryId
      case "result": {
        const previousEntry = entries[index - 1]
        const nextEntry = entries[index + 1]
        const hideResult = previousEntry?.kind === "context_cleared" || nextEntry?.kind === "context_cleared"
        return !hideResult && (entry.isError || entry.durationMs > 60000)
      }
      case "context_window_updated":
        return false
      case "status":
        return index === entries.length - 1
      default:
        return true
    }
  })
}

function findLatestTodoWriteEntryId(entries: TranscriptEntry[]) {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]!
    if (entry.kind === "tool_call" && entry.tool.toolKind === "todo_write") {
      return entry._id
    }
  }
  return null
}

function getTranscriptEntrySearchTargetId(entry: TranscriptEntry, toolCallEntryIdsByToolId: Map<string, string>) {
  if (entry.kind === "tool_result") {
    return toolCallEntryIdsByToolId.get(entry.toolId) ?? entry._id
  }
  return entry._id
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
    case "interrupted":
      return ""
  }
}

function getVisibleUserPromptText(content: string) {
  const match = content.match(/^(<system-message>\s*[\s\S]*?\s*<\/system-message>\s*)([\s\S]*)$/)
  return match ? match[2] ?? "" : content
}

function getVisibleToolCallSearchText(tool: NormalizedToolCall, options: ChatSearchOptions) {
  const title = getVisibleToolCallTitle(tool, options)
  const expandedText = getVisibleToolCallExpandedText(tool)
  return [title, expandedText].filter(Boolean).join("\n")
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
