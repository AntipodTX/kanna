import type { HydratedTranscriptMessage } from "../../../shared/types"

/** Whether a rendered transcript message contains the requested nested entry. */
export function containsTranscriptEntry(
  message: HydratedTranscriptMessage,
  entryId: string | null | undefined,
): boolean {
  if (!entryId) return false
  if (message.id === entryId) return true
  return message.kind === "tool"
    && message.children?.some((child) => containsTranscriptEntry(child, entryId)) === true
}
