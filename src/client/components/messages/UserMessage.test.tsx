import { TranscriptRenderOptionsProvider } from "./render-context"
import { describe, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import type { ChatAttachment } from "../../../shared/types"
import {
  buildUserMessageEditContent,
  getUserMessageEditTextareaMaxHeight,
  getUserMessageEditTextareaRows,
  parseUserMessageContent,
  runUserMessageAction,
  UserMessage,
} from "./UserMessage"

describe("runUserMessageAction", () => {
  test("contains a rejected history edit and preserves failure for the editor", async () => {
    await expect(runUserMessageAction(async () => { throw new Error("History edit rejected") }))
      .resolves.toBe(false)
  })

  test("contains a synchronous fork callback failure", async () => {
    await expect(runUserMessageAction(() => { throw new Error("Fork rejected") })).resolves.toBe(false)
  })

  test("lets the editor close only after a successful retry", async () => {
    let completed = false
    expect(await runUserMessageAction(async () => { throw new Error("offline") })).toBe(false)
    expect(await runUserMessageAction(async () => { completed = true })).toBe(true)
    expect(completed).toBe(true)
  })
})

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


test("mid-turn merge edit and fork disclose distinct behavior", () => {
 const html=renderToStaticMarkup(<TranscriptRenderOptionsProvider value={{historyActions:{p:"merge-turn"}}}><UserMessage messageId="p" content="Search" onEdit={()=>{}} onFork={()=>{}} /></TranscriptRenderOptionsProvider>)
 expect(html).toContain('aria-label="Edit and combine turn messages"')
 expect(html).toContain('aria-label="Fork and combine turn messages"')
 expect(html).toContain('data-history-action="merge-turn"')
})
test("a restarted native turn retains ordinary actions despite its steered decoration", () => {
 const html=renderToStaticMarkup(<TranscriptRenderOptionsProvider value={{historyActions:{p:"ordinary"}}}><UserMessage messageId="p" content="Search" steered onEdit={()=>{}} onFork={()=>{}} /></TranscriptRenderOptionsProvider>)
 expect(html).toContain('aria-label="Edit message"')
 expect(html).toContain('aria-label="Fork message"')
 expect(html).not.toContain('combine turn messages')
})

test("a provenance gap leaves confirmed actions enabled and blocks only later messages", () => {
 const render = (id: string) => renderToStaticMarkup(<TranscriptRenderOptionsProvider value={{
  historyActions:{a:"ordinary",b:"ordinary"}, historyActionsRequired:true,
  historyActionsError:"Resolve B before continuing", historyActionGapId:"b",
 }}><UserMessage messageId={id} content={id} onEdit={()=>{}} onFork={()=>{}} /></TranscriptRenderOptionsProvider>)
 expect(render("a")).not.toContain('disabled=""')
 expect(render("b")).not.toContain('disabled=""')
 expect(render("b")).toContain('Edit and resend message')
 expect(render("c")).toContain('disabled=""')
})

test("unknown provenance offers explicit recovery instead of disabled edit and fork", () => {
  const html = renderToStaticMarkup(<TranscriptRenderOptionsProvider value={{
    historyActions: { p: "recover" }, historyActionsRequired: true,
    resolveHistoryAction: async () => true,
  }}><UserMessage messageId="p" content="Search" onEdit={() => {}} onFork={() => {}} /></TranscriptRenderOptionsProvider>)
  expect(html).toContain('aria-label="Edit message"')
  expect(html).toContain('aria-label="Recover history to fork"')
  expect(html).not.toContain('disabled=""')
})

for (const status of ["missing", "unknown"] as const)
  test(`shows a persistent ${status} correspondence marker without hiding the message`, () => {
    const markup = renderToStaticMarkup(
      <TranscriptRenderOptionsProvider value={{ historyMessages: { test: status } } as any}>
        <UserMessage messageId="test" content="Keep this message" />
      </TranscriptRenderOptionsProvider>,
    )
    expect(markup).toContain("Keep this message")
    expect(markup).toContain(status === "missing" ? "Not sent to Codex" : "Codex correspondence is unknown")
  })


test("a missing history action does not disable opening the local message editor", () => {
  const html = renderToStaticMarkup(<TranscriptRenderOptionsProvider value={{ historyActionsRequired: true, historyActions: {} }}>
    <UserMessage messageId="unresolved" content="Draft" onEdit={() => {}} onFork={() => {}} />
  </TranscriptRenderOptionsProvider>)
  const button = html.match(/<button[^>]*aria-label="Edit message"[^>]*>/)?.[0]
  expect(button).toBeDefined()
  expect(button).not.toContain('disabled=""')
})
