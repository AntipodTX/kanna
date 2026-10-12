import type { TranscriptEntry } from "../shared/types"
import { normalizeClaudeStreamMessage as normalizeUpstreamClaudeMessage } from "./agent"

const CLAUDE_RESUME_BANNER_PREFIX = "This session is being continued"

/** Keep historical imports on the same transcript model as live Claude turns. */
export function normalizeClaudeStreamMessage(
  message: any,
  options?: { structuredToolIds?: ReadonlySet<string> },
): TranscriptEntry[] {
  const entries = normalizeUpstreamClaudeMessage(message, options)
  if (message.type === "user" && Array.isArray(message.message?.content)) {
    const claudeSessionToken = typeof message.session_id === "string" && message.session_id
      ? message.session_id
      : typeof message.sessionId === "string" && message.sessionId ? message.sessionId : undefined
    for (const content of message.message.content) {
      if (content.type === "text" && typeof content.text === "string" && content.text.startsWith(CLAUDE_RESUME_BANNER_PREFIX)) {
        entries.push({
          _id: crypto.randomUUID(), createdAt: Date.now(), kind: "compact_summary", summary: content.text,
          ...(typeof message.uuid === "string" ? { messageId: message.uuid } : {}),
          ...(typeof message.parent_tool_use_id === "string" && message.parent_tool_use_id ? { parentToolUseId: message.parent_tool_use_id } : {}),
          ...(claudeSessionToken ? { claudeSessionToken } : {}),
          ...(message.isSidechain === true || (typeof message.subagent_type === "string" && message.subagent_type) ? { claudeSidechain: true } : {}),
        })
      }
    }
  }
  return entries
}
