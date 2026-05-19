import { describe, expect, test } from "bun:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { ProjectChatSearchPopover } from "./ProjectChatSearchPopover"

describe("ProjectChatSearchPopover", () => {
  test("renders a floating project search dialog with a close control", () => {
    const html = renderToStaticMarkup(createElement(ProjectChatSearchPopover, {
      open: true,
      projectTitle: "Project A",
      disabled: false,
      onClose: () => undefined,
      onSearch: async (query: string) => ({ query, projectId: "project-a", matches: [], hasMore: false }),
      onSelectResult: async () => undefined,
    }))

    expect(html).toContain("Search Project A")
    expect(html).toContain("Search all chats in this project")
    expect(html).toContain("Include archived chats")
    expect(html).toContain("Close Project Search")
    expect(html).toContain("absolute inset-0")
    expect(html).toContain("w-full")
    expect(html).toContain("max-w-3xl")
    expect(html).not.toContain("fixed inset-0")
    expect(html).not.toContain("w-[min(520px,calc(100%-1rem))]")
  })

  test("marks results from archived chats", () => {
    const html = renderToStaticMarkup(createElement(ProjectChatSearchPopover, {
      open: true,
      projectTitle: "Project A",
      disabled: false,
      initialResult: {
        query: "needle",
        projectId: "project-a",
        hasMore: false,
        matches: [{
          chatId: "archived-chat",
          chatTitle: "Archived Chat",
          isArchived: true,
          entryId: "entry-1",
          targetEntryId: "entry-1",
          kind: "assistant_text",
          createdAt: 1,
          matchCount: 1,
          preview: "needle in an archived chat",
        }],
      },
      onClose: () => undefined,
      onSearch: async (query: string) => ({ query, projectId: "project-a", matches: [], hasMore: false }),
      onSelectResult: async () => undefined,
    }))

    expect(html).toContain("Archived Chat")
    expect(html).toContain("Archived")
  })

  test("renders nothing when closed", () => {
    const html = renderToStaticMarkup(createElement(ProjectChatSearchPopover, {
      open: false,
      projectTitle: "Project A",
      disabled: false,
      onClose: () => undefined,
      onSearch: async (query: string) => ({ query, projectId: "project-a", matches: [], hasMore: false }),
      onSelectResult: async () => undefined,
    }))

    expect(html).toBe("")
  })
})
