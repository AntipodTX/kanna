import type { HydratedTranscriptMessage } from "../../../shared/types"
import type { ProcessedToolCall } from "./types"
import { TextMessage } from "./TextMessage"
import { ToolCallMessage } from "./ToolCallMessage"
import { cn } from "../../lib/utils"
import { containsTranscriptEntry } from "./transcript-tree"

interface Props {
  messages: HydratedTranscriptMessage[]
  isLoading: boolean
  localPath?: string | null
  revealEntryId?: string | null
  flashEntryId?: string | null
}

/**
 * What a subagent did, shown inside its Agent row.
 *
 * The same rows the main transcript uses, minus grouping and the special
 * tool views: a subagent's work is read after the fact, so a flat list in
 * order is enough. Anything that is not text or a tool call (a status, a
 * context update) has nothing to show here.
 */
export function SubagentTranscript({ messages, isLoading, localPath, revealEntryId, flashEntryId }: Props) {
  return (
    <div className="flex flex-col gap-3">
      {messages.map((message) => {
        if (message.kind === "assistant_text") {
          return (
            <div
              key={message.id}
              id={`msg-${message.id}`}
              className={cn("w-full", (message.id === revealEntryId || message.id === flashEntryId) && "kanna-jump-flash")}
            >
              <TextMessage message={message} />
            </div>
          )
        }
        if (message.kind === "tool") {
          return (
            <div
              key={message.id}
              id={`msg-${message.id}`}
              className={cn("w-full", (message.id === revealEntryId || message.id === flashEntryId) && "kanna-jump-flash")}
            >
              <ToolCallMessage
                message={message as ProcessedToolCall}
                isLoading={isLoading}
                localPath={localPath}
                forceExpanded={containsTranscriptEntry(message, revealEntryId)}
                revealEntryId={revealEntryId}
                flashEntryId={flashEntryId}
              />
            </div>
          )
        }
        return null
      })}
    </div>
  )
}
