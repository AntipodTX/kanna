import { describe, expect, test } from "bun:test"
import type { ComponentProps } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import type { QueuedChatMessage, TranscriptEntry } from "../../../shared/types"
import { processTranscriptMessages } from "../../lib/parseTranscript"
import { ChatTranscriptViewport } from "./ChatTranscriptViewport"

const content = "Follow-up while Codex is working"
const queued: QueuedChatMessage = {
  id: "queued-input", content, attachments: [], createdAt: 1, provider: "codex", steering: true,
}
const prompt = (id = queued.id, text = content): TranscriptEntry => ({
  _id: id, kind: "user_prompt", content: text, attachments: [], createdAt: 1, steered: true,
})

function render(entries: TranscriptEntry[], queue: QueuedChatMessage[]) {
  const props: ComponentProps<typeof ChatTranscriptViewport> = {
    activeChatId: "chat", listRef: { current: null }, messages: processTranscriptMessages(entries),
    queuedMessages: queue, transcriptPaddingBottom: 0, localPath: "/tmp/project",
    latestToolIds: { AskUserQuestion: null, ExitPlanMode: null, CodexApproval: null, TodoWrite: null },
    isProcessing: true, runtimeStatus: "running", isDraining: false, commandError: null,
    onStopDraining: () => {}, onSteerQueuedMessage: async () => {}, onRemoveQueuedMessage: async () => {},
    onOpenLocalLink: async () => {}, onAskUserQuestionSubmit: async () => {}, onExitPlanModeConfirm: async () => {},
    ...{ onCodexApprovalDecision: async () => {} },
    showScrollButton: false, onIsAtEndChange: () => {},
    scrollToBottom: () => {}, typedEmptyStateText: "", isEmptyStateTypingComplete: true,
    isPageFileDragActive: false, showEmptyState: false,
  }
  return renderToStaticMarkup(<ChatTranscriptViewport {...props} />)
}

function occurrences(html: string) { return html.split(content).length - 1 }

describe("Codex steering messages in the transcript viewport", () => {
  test("renders one bubble while the durable prompt and steering queue row coexist", () => {
    expect(occurrences(render([prompt()], [queued]))).toBe(1)
  })

  test("keeps one bubble before publication, during confirmation and after queue removal", () => {
    expect(occurrences(render([], [queued]))).toBe(1)
    expect(occurrences(render([prompt()], [queued]))).toBe(1)
    expect(occurrences(render([prompt()], []))).toBe(1)
  })

  test("keeps distinct messages with identical contents", () => {
    const second = { ...queued, id: "another-input" }
    expect(occurrences(render([prompt()], [queued, second]))).toBe(2)
  })

  test("keeps the steering bubble when its prompt is outside the displayed window", () => {
    expect(occurrences(render([prompt("older-prompt", "Earlier request")], [queued]))).toBe(1)
  })

  test("does not mistake a non-user entry with the same ID for a displayed prompt", () => {
    const entry: TranscriptEntry = { _id: queued.id, kind: "assistant_text", text: "Agent output", createdAt: 1 }
    expect(occurrences(render([entry], [queued]))).toBe(1)
  })

  test("keeps the steering bubble when its transcript prompt is hidden", () => {
    expect(occurrences(render([{ ...prompt(), hidden: true }], [queued]))).toBe(1)
  })

  test("preserves queued retry controls after native steering fails", () => {
    const html = render([prompt()], [{ ...queued, steering: false }])
    expect(occurrences(html)).toBe(2)
    expect(html).toContain("border-dashed")
  })

  test("deduplicates an attachment-only steering message by ID", () => {
    const attachments: QueuedChatMessage["attachments"] = [{
      id: "file", kind: "file", displayName: "attachment-only.txt", absolutePath: "/tmp/attachment-only.txt",
      relativePath: "attachment-only.txt", contentUrl: "", mimeType: "text/plain", size: 1,
    }]
    const entry = { ...prompt(), content: "", attachments }
    const message = { ...queued, content: "", attachments }
    const html = render([entry], [message])
    expect(html.split("attachment-only.txt").length - 1).toBe(1)
  })
})
