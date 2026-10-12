import { describe, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import type { QueuedChatMessage } from "../../../shared/types"
import { QueuedUserMessage } from "./QueuedUserMessage"

describe("QueuedUserMessage", () => {
  test("renders queued message content left aligned inside the bubble", () => {
    const message: QueuedChatMessage = {
      id: "queued-1",
      content: "Queued follow-up",
      attachments: [],
      createdAt: Date.now(),
    }

    const html = renderToStaticMarkup(
      <QueuedUserMessage
        message={message}
        onRemove={() => undefined}
        onSendNow={() => undefined}
      />
    )

    expect(html).toContain("Queued follow-up")
    expect(html).toContain("text-left")
    expect(html).not.toContain("text-right")
  })

  test("an attachment-only message still gets the Send now and Remove controls", () => {
    const message: QueuedChatMessage = {
      id: "queued-2",
      content: "",
      attachments: [{
        id: "attachment-1",
        kind: "image",
        displayName: "screenshot.png",
        absolutePath: "/tmp/screenshot.png",
        relativePath: "screenshot.png",
        contentUrl: "/media/screenshot.png",
        mimeType: "image/png",
        size: 1024,
      }],
      createdAt: Date.now(),
    }

    const html = renderToStaticMarkup(
      <QueuedUserMessage
        message={message}
        onRemove={() => undefined}
        onSendNow={() => undefined}
      />
    )

    expect(html).toContain("Queued")
    expect(html.match(/<button/g)?.length ?? 0).toBeGreaterThanOrEqual(2)
  })

  test("renders a settling steer as a non-actionable sent-mid-turn message", () => {
    const message: QueuedChatMessage = {
      id: "queued-steering",
      content: "Already sent follow-up",
      attachments: [],
      createdAt: Date.now(),
      steering: true,
    }

    const html = renderToStaticMarkup(
      <QueuedUserMessage
        message={message}
        onRemove={() => undefined}
        onSendNow={() => undefined}
      />
    )

    expect(html).toContain("Already sent follow-up")
    expect(html).toContain('aria-label="Sent mid-turn"')
    expect(html).not.toContain("border-dashed")
    expect(html).not.toContain("<button")
  })
})
