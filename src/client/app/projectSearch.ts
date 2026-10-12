import type { ProjectChatSearchCommandResult, ProjectChatSearchEntryResult } from "../../shared/chatSearch"
import { buildChatJumpLocationState } from "../lib/chat-navigation"

export function appendProjectSearchPage(
  current: ProjectChatSearchCommandResult,
  next: ProjectChatSearchCommandResult,
): ProjectChatSearchCommandResult {
  return { ...next, matches: [...current.matches, ...next.matches] }
}

/** Navigation starts only after a result is selected, never on opening search. */
export function getProjectSearchResultNavigation(result: ProjectChatSearchEntryResult) {
  return {
    pathname: `/chat/${result.chatId}`,
    state: buildChatJumpLocationState({
      entryId: result.targetEntryId,
      revealEntryId: result.revealEntryId,
    }),
  }
}
