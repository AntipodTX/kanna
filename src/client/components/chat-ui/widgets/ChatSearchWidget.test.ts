import { describe, expect, test } from "bun:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { ChatSearchWidget } from "./ChatSearchWidget"

describe("ChatSearchWidget", () => {
  test("offers tool payload search as an unchecked option", () => {
    const html = renderToStaticMarkup(createElement(ChatSearchWidget, {
      chatId: "chat-1",
      entries: [],
      ready: true,
      hasOlderMessages: false,
      onLoadOlderMessages: async () => true,
      onJumpToEntry: () => undefined,
    }))

    expect(html).toContain("Search Chat")
    expect(html).toContain("Include tool calls and results")
    expect(html).toContain("type=\"checkbox\"")
    expect(html).not.toContain("checked=\"\"")
  })

  test("stays disabled until the active chat snapshot is ready", () => {
    const html = renderToStaticMarkup(createElement(ChatSearchWidget, {
      chatId: "chat-2",
      entries: [],
      ready: false,
      hasOlderMessages: false,
      onLoadOlderMessages: async () => true,
      onJumpToEntry: () => undefined,
    }))

    expect(html).toContain("aria-busy=\"true\"")
    expect(html).toContain("Loading chat…")
    expect(html.match(/disabled=\"\"/g)).toHaveLength(3)
  })
})
