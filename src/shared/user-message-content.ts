import { formatCodexQuestionReply } from "./codex-questions"

/** Keep legacy steering instructions hidden while preserving them for edits. */
export function parseUserMessageContent(content: string) {
  const match = content.match(/^(<system-message>\s*[\s\S]*?\s*<\/system-message>\s*)([\s\S]*)$/)
  if (!match) {
    return { systemPrefix: null, systemMessage: null, body: content }
  }

  const systemPrefix = match[1] ?? ""
  const systemMessage = systemPrefix
    .replace(/^<system-message>\s*/, "")
    .replace(/\s*<\/system-message>\s*$/, "")
    .trim()

  return { systemPrefix, systemMessage: systemMessage || null, body: match[2] ?? "" }
}

/** The user bubble's text, before markdown rendering or preview truncation. */
export function getUserMessageDisplayText(content: unknown): string {
  if (typeof content !== "string") return ""
  return formatCodexQuestionReply(parseUserMessageContent(content).body)
}
