import { useMemo, useState } from "react"
import { ChevronRight } from "lucide-react"
import type { ProcessedToolCall } from "./types"
import type { NormalizedToolCall, TranscriptEntry } from "../../../shared/types"
import { hydrateToolResult } from "../../../shared/tools"
import { MetaCodeBlock, TranscriptMarkdown, VerticalLineContainer } from "./shared"
import { FileContentView } from "./FileContentView"
import { SubagentTranscript } from "./SubagentTranscript"
import { useToolPayload } from "./tool-payload-context"

/**
 * The body of an expanded tool call.
 *
 * Split out from `ToolCallMessage` so none of it runs while the row is
 * collapsed — which is almost always. Deriving it eagerly meant every tool call
 * in the transcript stringified its whole result on mount just to keep it ready
 * for an expansion that mostly never comes. `ExpandableRow` only mounts this
 * subtree once expanded, so the cost now follows the click.
 */

/** Inline base64 (`data`) or a server-stored file (`url`); one of the two. */
type ReadImageBlock = {
  type: "image"
  data?: string
  url?: string
  mimeType?: string
}

function extractReadImageBlocks(value: unknown): ReadImageBlock[] {
  const blocks = (
    value
    && typeof value === "object"
    && "content" in value
    && Array.isArray((value as { content?: unknown }).content)
  )
    ? (value as { content: unknown[] }).content
    : Array.isArray(value)
      ? value
      : []

  return blocks.flatMap((block): ReadImageBlock[] => {
    if (!block || typeof block !== "object" || !("type" in block) || block.type !== "image") {
      return []
    }

    if ("url" in block && typeof block.url === "string" && block.url) {
      return [{
        type: "image",
        url: block.url,
        mimeType: typeof block.mimeType === "string" ? block.mimeType : undefined,
      } satisfies ReadImageBlock]
    }

    if ("data" in block && typeof block.data === "string") {
      return [{
        type: "image",
        data: block.data,
        mimeType: typeof block.mimeType === "string" ? block.mimeType : undefined,
      } satisfies ReadImageBlock]
    }

    if (
      "source" in block
      && block.source
      && typeof block.source === "object"
      && "type" in block.source
      && block.source.type === "base64"
      && "data" in block.source
      && typeof block.source.data === "string"
    ) {
      return [{
        type: "image",
        data: block.source.data,
        mimeType: typeof block.source.media_type === "string" ? block.source.media_type : undefined,
      } satisfies ReadImageBlock]
    }

    return []
  })
}

/**
 * Fold fetched entries back onto the row.
 *
 * The row carries what a collapsed header needs; the fetched entries carry the
 * bodies. Hydration of the result happens here rather than in the transcript
 * parse, because until now there was nothing to hydrate.
 */
function resolveToolCallPayloads(
  row: ProcessedToolCall,
  fetchedCall: TranscriptEntry | undefined,
  fetchedResult: TranscriptEntry | undefined
): ProcessedToolCall {
  const call = fetchedCall?.kind === "tool_call" ? fetchedCall.tool : undefined
  const resultContent = fetchedResult?.kind === "tool_result" ? fetchedResult.content : undefined
  if (!call && resultContent === undefined) return row

  const normalized = (call ?? row) as NormalizedToolCall
  return {
    ...row,
    ...(call ? { input: call.input as ProcessedToolCall["input"] } : {}),
    ...(resultContent !== undefined
      ? {
        result: hydrateToolResult(normalized, resultContent) as ProcessedToolCall["result"],
        rawResult: resultContent,
      }
      : {}),
  } as ProcessedToolCall
}

/**
 * The text of an Agent result. The SDK returns the subagent's final message
 * as content blocks; older entries and other providers hold a plain string.
 */
export function subagentResultText(value: unknown): string {
  if (typeof value === "string") return value
  const blocks = Array.isArray(value)
    ? value
    : value && typeof value === "object" && Array.isArray((value as { content?: unknown }).content)
      ? (value as { content: unknown[] }).content
      : null
  if (!blocks) return value == null ? "" : JSON.stringify(value, null, 2)
  return blocks
    .flatMap((block) => (
      block && typeof block === "object" && (block as { type?: unknown }).type === "text"
        && typeof (block as { text?: unknown }).text === "string"
        ? [(block as { text: string }).text]
        : []
    ))
    .join("\n\n")
}

/**
 * An Agent's input, in words rather than JSON: who ran, what it was told.
 * The prompt is the bulk and comes with the fetched payload.
 */
function SubagentInput({ message }: { message: Extract<ProcessedToolCall, { toolKind: "subagent_task" }> }) {
  const prompt = message.input.prompt
  if (!prompt) return null
  return (
    <div>
      <span className="font-medium text-muted-foreground">Prompt</span>
      <div className="my-1 text-xs whitespace-pre-wrap bg-muted border border-border rounded-lg p-2 max-h-64 overflow-auto w-full">
        {prompt}
      </div>
    </div>
  )
}

/**
 * An Agent's result behind a toggle, rendered as markdown when opened.
 *
 * Closed by default: the result repeats the subagent's last message, which
 * the list above already shows, and a full report would push that list off
 * the screen.
 */
function SubagentResult({ text, isError }: { text: string; isError?: boolean }) {
  const [expanded, setExpanded] = useState(false)
  return (
    <div>
      <button
        onClick={() => setExpanded((value) => !value)}
        className="group/subagent-result cursor-pointer flex items-center gap-1 font-medium text-muted-foreground hover:opacity-60 transition-opacity"
      >
        <span>{isError ? "Error" : "Result"}</span>
        <ChevronRight className={`h-4 w-4 text-muted-icon transition-all duration-200 ${expanded ? "rotate-90" : ""}`} />
      </button>
      {expanded && (
        <div className="my-1 bg-muted border border-border rounded-lg p-3 max-h-[60vh] overflow-auto w-full">
          <div className="text-pretty prose prose-sm dark:prose-invert max-w-full space-y-4">
            <TranscriptMarkdown text={text} />
          </div>
        </div>
      )}
    </div>
  )
}

export function ReadResultImages({ images }: { images: ReadonlyArray<ReadImageBlock> }) {
  return (
    <div className="flex flex-col gap-3">
      {images.map((image, index) => {
        const mimeType = image.mimeType || "image/png"
        return (
          <div key={`${mimeType}:${index}`} className="overflow-hidden rounded-lg border border-border bg-muted/20">
            <img
              src={image.url ?? `data:${mimeType};base64,${image.data ?? ""}`}
              loading="lazy"
              alt={`Read result ${index + 1}`}
              className="max-h-[50vh] w-full object-contain bg-background"
            />
          </div>
        )
      })}
    </div>
  )
}

interface Props {
  message: ProcessedToolCall
  /** Whether the chat is still streaming; a subagent's open calls shimmer on it. */
  isLoading?: boolean
  localPath?: string | null
  revealEntryId?: string | null
  flashEntryId?: string | null
}

export function ToolCallExpandedContent({
  message: row,
  isLoading = false,
  localPath,
  revealEntryId,
  flashEntryId,
}: Props) {
  // Mounting this component is the signal that the payloads are wanted; these
  // request them if the transcript arrived without them.
  const fetchedCall = useToolPayload(row.inputTrimmed ? row.id : undefined)
  const fetchedResult = useToolPayload(row.resultTrimmed ? row.resultEntryId : undefined)
  const message = useMemo(
    () => resolveToolCallPayloads(row, fetchedCall, fetchedResult),
    [row, fetchedCall, fetchedResult]
  )
  const isAwaitingPayload = (row.inputTrimmed && !fetchedCall)
    || (row.resultTrimmed && row.resultEntryId !== undefined && !fetchedResult)

  const hasResult = message.resultEntryId !== undefined
  const isBashTool = message.toolKind === "bash"
  const isWriteTool = message.toolKind === "write_file"
  const isEditTool = message.toolKind === "edit_file"
  const isDeleteTool = message.toolKind === "delete_file"
  const isReadTool = message.toolKind === "read_file"
  const isAgentTool = message.toolKind === "subagent_task"

  const resultText = useMemo(() => {
    if (typeof message.result === "string") return message.result
    if (!message.result) return ""
    if (typeof message.result === "object" && message.result !== null && "content" in message.result) {
      const content = (message.result as { content?: unknown }).content
      if (typeof content === "string") return content
    }
    return JSON.stringify(message.result, null, 2)
  }, [message.result])

  const readImages = useMemo(() => {
    if (!isReadTool) {
      return [] as ReadImageBlock[]
    }

    if (message.result && typeof message.result === "object" && "blocks" in message.result) {
      const blocks = (message.result as { blocks?: unknown }).blocks
      if (Array.isArray(blocks)) {
        const hydratedBlocks = extractReadImageBlocks(blocks)
        if (hydratedBlocks.length > 0) {
          return hydratedBlocks
        }
      }
    }

    return extractReadImageBlocks(message.rawResult)
  }, [isReadTool, message.rawResult, message.result])

  const inputText = useMemo(() => {
    switch (message.toolKind) {
      case "bash":
        return message.input.command
      case "write_file":
      case "delete_file":
        return message.input.content
      default:
        return JSON.stringify(message.input, null, 2)
    }
  }, [message])

  if (isAwaitingPayload) {
    // Reserving the row rather than rendering half a body: the fields are
    // in flight, and flashing empty code blocks first would reflow twice.
    return (
      <VerticalLineContainer className="my-4 text-sm">
        <span className="text-muted-foreground">Loading…</span>
      </VerticalLineContainer>
    )
  }

  return (
    <VerticalLineContainer className="my-4 text-sm">
      <div className="flex flex-col gap-2">
        {isEditTool ? (
          <FileContentView
            content=""
            isDiff
            oldString={message.input.oldString}
            newString={message.input.newString}
          />
        ) : isDeleteTool ? (
          <FileContentView
            content={message.input.content ?? ""}
          />
        ) : message.toolKind === "subagent_task" ? (
          <SubagentInput message={message} />
        ) : !isReadTool && !isWriteTool && (
          <MetaCodeBlock label={
            isBashTool ? (
              <span className="flex items-center gap-2 w-full">
                <span>Command</span>
                {!!message.input.timeoutMs && (
                  <span className="text-muted-foreground">timeout: {String(message.input.timeoutMs)}ms</span>
                )}
                {!!message.input.runInBackground && (
                  <span className="text-muted-foreground">background</span>
                )}
              </span>
            ) : isWriteTool ? "Contents" : "Input"
          } copyText={inputText}>
            {inputText}
          </MetaCodeBlock>
        )}
        {message.toolKind === "subagent_task" && message.children && message.children.length > 0 && (
          <SubagentTranscript
            messages={message.children}
            isLoading={isLoading}
            localPath={localPath}
            revealEntryId={revealEntryId}
            flashEntryId={flashEntryId}
          />
        )}
        {hasResult && isReadTool && !message.isError && (
          readImages.length > 0 ? (
            <div>
              <span className="font-medium text-muted-foreground">Image</span>
              <div className="mt-1">
                <ReadResultImages images={readImages} />
              </div>
            </div>
          ) : (
            <FileContentView
              content={resultText}
            />
          )
        )}
        {isWriteTool && !message.isError && (
          <FileContentView
            content={message.input.content ?? ""}
          />
        )}
        {hasResult && isAgentTool && (
          <SubagentResult text={subagentResultText(message.rawResult ?? message.result)} isError={message.isError} />
        )}
        {hasResult && !isReadTool && !isAgentTool && !(isWriteTool && !message.isError) && !(isEditTool && !message.isError) && !(isDeleteTool && !message.isError) && (
          <MetaCodeBlock label={message.isError ? "Error" : "Result"} copyText={resultText}>
            {resultText}
          </MetaCodeBlock>
        )}
      </div>
    </VerticalLineContainer>
  )
}
