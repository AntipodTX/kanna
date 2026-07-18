import { describe, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import type { ChatAttachment } from "../../../shared/types"
import {
  buildUserMessageEditContent,
  getUserMessageEditTextareaMaxHeight,
  getUserMessageEditTextareaRows,
  parseUserMessageContent,
  UserMessage,
} from "./UserMessage"

describe("getUserMessageEditTextareaRows", () => {
  test("sizes edit textareas from the full message line count", () => {
    expect(getUserMessageEditTextareaRows("Short prompt")).toBe(1)
    expect(getUserMessageEditTextareaRows("Line one\nLine two\nLine three")).toBe(3)
    expect(getUserMessageEditTextareaRows(Array.from({ length: 40 }, (_, index) => `Line ${index + 1}`).join("\n"))).toBe(40)
  })
})

describe("getUserMessageEditTextareaMaxHeight", () => {
  test("limits edit textareas to the viewport instead of the remaining space below the message", () => {
    expect(getUserMessageEditTextareaMaxHeight({ viewportHeight: 933, textareaTop: 79 })).toBe(869)
    expect(getUserMessageEditTextareaMaxHeight({ viewportHeight: 933, textareaTop: 860 })).toBe(869)
    expect(getUserMessageEditTextareaMaxHeight({ viewportHeight: 120, textareaTop: 20 })).toBe(96)
  })
})

describe("parseUserMessageContent", () => {
  test("separates hidden system-message text from the editable body", () => {
    const content = `<system-message>
The user would like to inform you of something.
</system-message>

Never run the browser.`

    expect(parseUserMessageContent(content)).toEqual({
      systemPrefix: `<system-message>
The user would like to inform you of something.
</system-message>

`,
      systemMessage: "The user would like to inform you of something.",
      body: "Never run the browser.",
    })
  })
})

describe("buildUserMessageEditContent", () => {
  test("preserves a hidden system-message prefix when saving an edited body", () => {
    const content = `<system-message>
Keep this hidden.
</system-message>

Original body.`

    expect(buildUserMessageEditContent(content, " Edited body. ")).toBe(`<system-message>
Keep this hidden.
</system-message>

Edited body.`)
  })

  test("trims regular user message edits", () => {
    expect(buildUserMessageEditContent("Original body.", " Edited body. ")).toBe("Edited body.")
  })
})

describe("UserMessage", () => {
  test("renders fork controls for attachment-only messages", () => {
    const attachments: ChatAttachment[] = [{
      id: "attachment-1",
      kind: "file",
      displayName: "notes.txt",
      absolutePath: "/tmp/project/notes.txt",
      relativePath: "notes.txt",
      contentUrl: "",
      mimeType: "text/plain",
      size: 12,
    }]

    const html = renderToStaticMarkup(
      <UserMessage
        messageId="message-1"
        content=""
        attachments={attachments}
        onFork={() => undefined}
      />
    )

    expect(html).toContain("notes.txt")
    expect(html).toContain("Fork message")
  })
})
