import { expect, test } from "bun:test"
import type { ProjectChatSearchCommandResult } from "../../shared/chatSearch"
import { appendProjectSearchPage } from "./projectSearch"

test("appends a server page while preserving its next-page state", () => {
  const current: ProjectChatSearchCommandResult = {
    query: "needle",
    projectId: "project-1",
    matches: [{
      chatId: "chat-1",
      chatTitle: "First",
      isArchived: false,
      entryId: "entry-1",
      revealEntryId: "entry-1",
      targetEntryId: "entry-1",
      kind: "assistant_text",
      createdAt: 1,
      matchCount: 1,
      preview: "first needle",
    }],
    nextCursor: "0:1",
    hasMore: true,
  }
  const next: ProjectChatSearchCommandResult = {
    query: "needle",
    projectId: "project-1",
    matches: [{
      chatId: "chat-2",
      chatTitle: "Second",
      isArchived: true,
      entryId: "entry-2",
      revealEntryId: "entry-2",
      targetEntryId: "entry-2",
      kind: "user_prompt",
      createdAt: 2,
      matchCount: 2,
      preview: "second needle",
    }],
    hasMore: false,
  }

  expect(appendProjectSearchPage(current, next)).toEqual({
    ...next,
    matches: [...current.matches, ...next.matches],
  })
})
