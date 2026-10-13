import { expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { codexAsyncQuestionTool, encodeCodexQuestionReplies } from "../../../shared/codex-questions"
import type { TranscriptEntry } from "../../../shared/types"
import { processTranscriptMessages } from "../../lib/parseTranscript"
import { AskUserQuestionMessage } from "./AskUserQuestionMessage"
import { TranscriptRenderOptionsProvider } from "./render-context"

function renderAnswer(options: { missing?: boolean; queued?: boolean; unknown?: boolean; readonly?: boolean } = {}) {
  const tool = codexAsyncQuestionTool({ id: "q", delivery: "async", questions: [{ title: "Cleanup?" }] }, "thread")!
  const entries: TranscriptEntry[] = [
    { _id: "question", createdAt: 1, kind: "tool_call", tool },
    { _id: "answer", createdAt: 2, kind: "user_prompt", content: encodeCodexQuestionReplies([
      { questionItemId: tool.input.questions[0]!.id!, question: "Cleanup?", answer: "All" },
    ]) },
  ]
  const message = processTranscriptMessages(entries)[0]!
  if (message.kind !== "tool" || message.toolKind !== "ask_user_question") throw new Error("Question missing")
  return renderToStaticMarkup(
    <TranscriptRenderOptionsProvider value={{ historyMessages: options.missing ? { answer: "missing" } : {},
      historyActions: options.unknown ? { answer: "recover" } : {},
      queuedMessageIds: options.queued ? ["answer"] : [], readonly: options.readonly }}>
      <AskUserQuestionMessage message={message} isLatest={false} onSubmit={async () => {}} />
    </TranscriptRenderOptionsProvider>,
  )
}

test("a retained answer absent from Codex offers explicit redelivery", () => {
  const html = renderAnswer({ missing: true })
  expect(html).toContain("All")
  expect(html).toContain("Answer delivery is not confirmed")
  expect(html).toContain("Resend answer")
})

test("a queued rejected answer offers redelivery before reconciliation", () => {
  expect(renderAnswer({ queued: true })).toContain("Resend answer")
})

test("a confirmed answer has no redelivery action", () => {
  expect(renderAnswer()).not.toContain("Resend answer")
})

test("an answer with unknown receipt offers a retry that can check its binding", () => {
  expect(renderAnswer({ unknown: true })).toContain("Resend answer")
})

test("a readonly question cannot redeliver an answer", () => {
  expect(renderAnswer({ missing: true, readonly: true })).not.toContain("Resend answer")
})
