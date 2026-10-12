import type { AskUserQuestionToolCall } from "./types"

export interface CodexAsyncQuestion {
  title: string
  options?: string[] | null
}

export interface CodexQuestionReply {
  questionItemId: string
  question: string
  answer: string
}

export function codexAsyncQuestionTool(
  item: { id: string; delivery?: string | null; questions?: CodexAsyncQuestion[] | null },
  threadId: string,
): AskUserQuestionToolCall | null {
  if (item.delivery !== "async" || !item.questions?.length) return null
  return {
    kind: "tool", toolKind: "ask_user_question", toolName: "AskUserQuestion", toolId: item.id,
    input: {
      codexAsync: { threadId },
      questions: item.questions.map((question, index) => ({
        id: JSON.stringify(["request_user_input_async", item.id, index]),
        question: question.title,
        ...(question.options?.length ? { options: question.options.map(label => ({ label })) } : {}),
      })),
    },
  }
}

const OPEN = "<send_user_message_question_reply>"
const CLOSE = "</send_user_message_question_reply>"

export function encodeCodexQuestionReplies(replies: CodexQuestionReply[]): string {
  return `${OPEN}${JSON.stringify(replies)}${CLOSE}`
}

/** Interpret only complete native envelopes, never arbitrary assistant/user prose. */
export function parseCodexQuestionReplies(content: string): CodexQuestionReply[] {
  const text = content.trim()
  if (!text.startsWith(OPEN) || !text.endsWith(CLOSE)) return []
  try {
    const decoded = JSON.parse(text.slice(OPEN.length, -CLOSE.length))
    const replies: unknown[] = Array.isArray(decoded) ? decoded : [decoded]
    if (!replies.length || !replies.every(reply => {
      if (!reply || typeof reply !== "object") return false
      const value = reply as Record<string, unknown>
      return ["questionItemId", "question", "answer"].every(key => typeof value[key] === "string" && value[key].trim())
    })) return []
    return replies as CodexQuestionReply[]
  } catch {
    return []
  }
}

export function formatCodexQuestionReply(content: string): string {
  const replies = parseCodexQuestionReplies(content)
  return replies.length ? replies.map(reply => `> ${reply.question}\n\n${reply.answer}`).join("\n\n") : content
}
