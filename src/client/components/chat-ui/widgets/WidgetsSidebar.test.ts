import { expect, test } from "bun:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { PROVIDERS } from "../../../../shared/types"
import { WidgetsSidebar } from "./WidgetsSidebar"

test("the chat widgets keep chat search but not the independent project search", () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window")
  Object.defineProperty(globalThis, "window", { configurable: true, value: { location: { hostname: "localhost" } } })
  try {
    const html = renderToStaticMarkup(createElement(WidgetsSidebar, {
      projectId: "project-1",
      chatId: "chat-1",
      activeProvider: "codex",
      availableProviders: PROVIDERS,
      socket: {} as never,
      active: true,
      entries: [],
      searchReady: true,
      hasOlderMessages: false,
      onLoadOlderMessages: async () => true,
      subagents: [],
      onRunQuickAction: () => undefined,
      onJumpToToolCall: () => undefined,
      onJumpToEntry: () => undefined,
      gitWidgets: null,
      isNewChat: false,
    }))
    expect(html).toContain("Search current chat")
    expect(html).not.toContain("Search Project")
  } finally {
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow)
    else Reflect.deleteProperty(globalThis, "window")
  }
})
