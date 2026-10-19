import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react"
import type { ChatAttachment } from "../../../shared/types"
import { Check, CornerUpLeft, GitFork, GitMerge, Pencil, Combine, X } from "lucide-react"
import { TranscriptMarkdown } from "./shared"
import { classifyAttachmentPreview } from "./attachmentPreview"
import { AttachmentFileCard, AttachmentImageCard } from "./AttachmentCard"
import { openViewer, viewerAttachmentFromChat } from "../../stores/viewerStore"
import { useTranscriptRenderOptions } from "./render-context"
import { Button } from "../ui/button"
import { Textarea } from "../ui/textarea"
import { cn } from "../../lib/utils"

interface Props {
  messageId?: string
  content: string
  attachments?: ChatAttachment[]
  steered?: boolean
  /** Light the bubble when a jump lands on this message. */
  flash?: boolean
  editDisabled?: boolean
  forkDisabled?: boolean
  onEdit?: (messageId: string, content: string) => void | Promise<void>
  onFork?: (messageId: string) => void | Promise<void>
}

const MIN_EDIT_TEXTAREA_ROWS = 1
const MIN_EDIT_TEXTAREA_MAX_HEIGHT = 96
const EDIT_TEXTAREA_VIEWPORT_MARGIN = 32

export async function runUserMessageAction(action: () => void | Promise<void>): Promise<boolean> {
  try {
    await action()
    return true
  } catch {
    // The chat action reports its command error. Consume the rejection at
    // the event boundary while keeping an unsuccessful edit open for retry.
    return false
  }
}

export function getUserMessageEditTextareaRows(content: string) {
  return Math.max(MIN_EDIT_TEXTAREA_ROWS, content.split(/\r\n|\r|\n/).length)
}

export function getUserMessageEditTextareaMaxHeight({
  viewportHeight,
  textareaTop: _textareaTop,
}: {
  viewportHeight: number
  textareaTop: number
}) {
  return Math.max(MIN_EDIT_TEXTAREA_MAX_HEIGHT, viewportHeight - EDIT_TEXTAREA_VIEWPORT_MARGIN * 2)
}

/**
 * Legacy compatibility: steered prompts used to persist the injected
 * <system-message> block inside transcript content. The prefix stays hidden
 * while rendering and is preserved when that old prompt is edited.
 */
export function parseUserMessageContent(content: string) {
  const match = content.match(/^(<system-message>\s*[\s\S]*?\s*<\/system-message>\s*)([\s\S]*)$/)
  if (!match) {
    return { systemPrefix: null, systemMessage: null, body: content }
  }

  const systemPrefix = match[1] ?? ""
  const systemMessage = systemPrefix
    .replace(/^<system-message>\s*/, "")
    .replace(/\s*<\/system-message>\s*$/, "")
    .trim()

  return {
    systemPrefix,
    systemMessage: systemMessage || null,
    body: match[2] ?? "",
  }
}

export function buildUserMessageEditContent(content: string, editedBody: string) {
  const parsedContent = parseUserMessageContent(content)
  const trimmedBody = editedBody.trim()
  return parsedContent.systemPrefix ? `${parsedContent.systemPrefix}${trimmedBody}` : trimmedBody
}

/**
 * A prompt's attachments: images as previews, everything else as file cards.
 * Shared with QueuedUserMessage so a queued prompt shows its attachments the
 * way they will look once it is sent.
 */
export function UserMessageAttachments({ attachments }: { attachments: ChatAttachment[] }) {
  const renderOptions = useTranscriptRenderOptions()
  const shouldShowImagePlaceholders = renderOptions.attachmentMode === "metadata"
  const canInteractWithAttachments = !renderOptions.readonly || renderOptions.attachmentMode === "bundle"
  const imageAttachments = useMemo(
    () => attachments.filter((attachment) => attachment.kind === "image" && (attachment.contentUrl || shouldShowImagePlaceholders)),
    [attachments, shouldShowImagePlaceholders],
  )
  const fileAttachments = useMemo(
    () => attachments.filter((attachment) => attachment.kind !== "image" || (!attachment.contentUrl && !shouldShowImagePlaceholders)),
    [attachments, shouldShowImagePlaceholders],
  )

  function handleAttachmentClick(attachment: ChatAttachment) {
    if (!canInteractWithAttachments || !attachment.contentUrl) return

    const target = classifyAttachmentPreview(attachment)
    if (target.openInNewTab) {
      if (typeof window !== "undefined") {
        window.open(new URL(attachment.contentUrl, document.baseURI || window.location.href).toString(), "_blank", "noopener,noreferrer")
      }
      return
    }

    openViewer({ kind: "attachment", attachment: viewerAttachmentFromChat(attachment) })
  }

  return (
    <>
      {imageAttachments.length > 0 ? (
        <div className="flex max-w-[85%] flex-wrap justify-end gap-3 sm:max-w-[80%]">
          {imageAttachments.map((attachment) => (
            <AttachmentImageCard
              key={attachment.id}
              attachment={attachment}
              onClick={canInteractWithAttachments ? () => handleAttachmentClick(attachment) : undefined}
            />
          ))}
        </div>
      ) : null}
      {fileAttachments.length > 0 ? (
        <div className="flex max-w-[85%] flex-wrap justify-end gap-2 sm:max-w-[80%]">
          {fileAttachments.map((attachment) => (
            <AttachmentFileCard
              key={attachment.id}
              attachment={attachment}
              onClick={canInteractWithAttachments ? () => handleAttachmentClick(attachment) : undefined}
            />
          ))}
        </div>
      ) : null}
    </>
  )
}

export function UserMessage({
  messageId,
  content,
  attachments = [],
  steered = false,
  flash = false,
  editDisabled = false,
  forkDisabled = false,
  onEdit,
  onFork,
}: Props) {
  const [isEditing, setIsEditing] = useState(false)
  const parsedContent = useMemo(() => parseUserMessageContent(content), [content])
  const [draftContent, setDraftContent] = useState(parsedContent.body)
  const [isSaving, setIsSaving] = useState(false)
  const [isResolvingHistory, setIsResolvingHistory] = useState(false)
  const editTextareaRef = useRef<HTMLTextAreaElement>(null)
  const renderOptions = useTranscriptRenderOptions()
  const mergeTurn = Boolean(messageId && renderOptions.historyActions[messageId] === "merge-turn")
  const correspondence = messageId ? renderOptions.historyMessages[messageId] : undefined
  const replay = messageId === renderOptions.historyActionGapId || Boolean(correspondence && messageId && renderOptions.historyActions[messageId] && renderOptions.historyActions[messageId] !== "recover")
  const needsRecovery = Boolean(messageId && renderOptions.historyActions[messageId] === "recover")
  const editLabel = mergeTurn ? "Edit and combine turn messages" : replay ? "Edit and resend message" : "Edit message"
  const forkLabel = needsRecovery ? "Recover history to fork" : mergeTurn ? "Fork and combine turn messages" : replay ? "Fork and prepare message" : "Fork message"
  const actionBlocked = renderOptions.historyActionsLoading || (renderOptions.historyActionsRequired
    && (!messageId || !renderOptions.historyActions[messageId]))

  const editTextareaRows = useMemo(
    () => getUserMessageEditTextareaRows(parsedContent.body),
    [parsedContent.body],
  )
  const canEdit = Boolean(messageId && onEdit && !renderOptions.readonly)
  const canFork = Boolean(messageId && onFork && !renderOptions.readonly)
  const canSaveEdit = draftContent.trim().length > 0 && !isSaving
  const shouldRenderContentBubble = Boolean(
    isEditing
    || parsedContent.body
    || (!parsedContent.body && attachments.length === 0 && content && !parsedContent.systemMessage)
  )

  useEffect(() => {
    if (!isEditing) setDraftContent(parsedContent.body)
  }, [isEditing, parsedContent.body])

  const resizeEditTextarea = useCallback(() => {
    const element = editTextareaRef.current
    if (!element) return

    element.style.height = "auto"
    const resolvedMaxHeight = getUserMessageEditTextareaMaxHeight({
      viewportHeight: window.innerHeight,
      textareaTop: element.getBoundingClientRect().top,
    })
    element.style.maxHeight = `${resolvedMaxHeight}px`
    const nextHeight = Math.min(element.scrollHeight, resolvedMaxHeight)
    element.style.height = `${nextHeight}px`
    element.style.overflowY = element.scrollHeight > resolvedMaxHeight ? "auto" : "hidden"
  }, [])

  useLayoutEffect(() => {
    if (isEditing) resizeEditTextarea()
  }, [draftContent, isEditing, resizeEditTextarea])

  useEffect(() => {
    if (!isEditing) return
    window.addEventListener("resize", resizeEditTextarea)
    return () => window.removeEventListener("resize", resizeEditTextarea)
  }, [isEditing, resizeEditTextarea])

  async function handleEditSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!messageId || !onEdit || !canSaveEdit) return

    try {
      setIsSaving(true)
      const saved = await runUserMessageAction(() => onEdit(messageId, buildUserMessageEditContent(content, draftContent)))
      if (saved) setIsEditing(false)
    } finally {
      setIsSaving(false)
    }
  }

  function handleCancelEdit() {
    setDraftContent(parsedContent.body)
    setIsEditing(false)
  }

  async function resolveHistoryAction() {
    if (!needsRecovery) return true
    if (!messageId || !renderOptions.resolveHistoryAction) return false
    setIsResolvingHistory(true)
    try { return await renderOptions.resolveHistoryAction(messageId) }
    finally { setIsResolvingHistory(false) }
  }

  async function handleStartEdit() {
    setDraftContent(parsedContent.body)
    setIsEditing(true)
  }

  const actionControls = (canEdit || canFork) && !isEditing ? (
    <div className="flex shrink-0 items-center gap-1">
      {canEdit ? (
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={editLabel}
          title={actionBlocked ? renderOptions.historyActionsError ?? editLabel : editLabel}
          data-history-action={needsRecovery ? "recover" : mergeTurn ? "merge-turn" : "ordinary"}
          className="opacity-70 transition-opacity hover:opacity-100 focus-visible:opacity-100"
          disabled={editDisabled || isResolvingHistory}
          onClick={() => { void handleStartEdit() }}
        >
          {mergeTurn ? <Combine className="size-4" /> : <Pencil className="size-4" />}
        </Button>
      ) : null}
      {canFork ? (
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={forkLabel}
          title={actionBlocked ? renderOptions.historyActionsError ?? forkLabel : forkLabel}
          data-history-action={needsRecovery ? "recover" : mergeTurn ? "merge-turn" : "ordinary"}
          className="opacity-70 transition-opacity hover:opacity-100 focus-visible:opacity-100"
          disabled={forkDisabled || actionBlocked || isResolvingHistory}
          onClick={() => {
            void runUserMessageAction(async () => {
              if (messageId && onFork && await resolveHistoryAction()) await onFork(messageId)
            })
          }}
        >
          {mergeTurn ? <GitMerge className="size-4" /> : <GitFork className="size-4" />}
        </Button>
      ) : null}
    </div>
  ) : null

  return (
    <div className="group flex flex-col items-end gap-2">
      <UserMessageAttachments attachments={attachments} />
      {correspondence ? (
        <p role="status" className="max-w-[85%] text-xs text-amber-500">
          {correspondence === "missing" ? "Not sent to Codex" : "Codex correspondence is unknown"}
          {replay ? ". You can edit and resend this message." : ". Retained in Kanna."}
        </p>
      ) : null}
      {shouldRenderContentBubble ? (
        <div className={cn(
          "flex max-w-[85%] items-center gap-2 sm:max-w-[80%]",
          isEditing && "w-[85%] sm:w-[80%]",
        )}>
          {steered ? (
            <span
              aria-label="Sent mid-turn"
              role="img"
              title="Sent mid-turn"
              className="shrink-0 text-muted-foreground"
            >
              <CornerUpLeft className="h-4 w-4" />
            </span>
          ) : null}
          <div className={cn(
            "min-w-0 flex-1 rounded-2xl border border-border bg-muted px-3.5 py-1.5 text-primary prose prose-sm prose-invert [&_p]:whitespace-pre-line",
            flash && "kanna-jump-flash",
          )}>
            {isEditing ? (
              <div className="not-prose flex min-w-0 flex-col gap-2">
                {replay ? <p className="text-xs text-muted-foreground">Saving resends this message. Later messages will be removed only after Codex accepts it.</p> : null}
                {mergeTurn ? <p className="text-xs text-muted-foreground">Saving combines this message with earlier user messages in this turn and restarts the turn.</p> : null}
              <form className="flex min-w-0 gap-2" onSubmit={handleEditSubmit}>
                <Textarea
                  ref={editTextareaRef}
                  value={draftContent}
                  onChange={(event) => setDraftContent(event.currentTarget.value)}
                  rows={editTextareaRows}
                  className="resize-none bg-background text-primary"
                  autoFocus
                  disabled={isSaving}
                />
                <div className="flex shrink-0 flex-col gap-1">
                  <Button
                    type="submit"
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Save edit"
                    title="Save edit"
                    disabled={!canSaveEdit}
                  >
                    <Check className="h-4 w-4" />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Cancel edit"
                    title="Cancel edit"
                    onClick={handleCancelEdit}
                    disabled={isSaving}
                  >
                    <X className="h-4 w-4" />
                  </Button>
                </div>
              </form>
              </div>
            ) : (
              <TranscriptMarkdown text={parsedContent.body} />
            )}
          </div>
          {actionControls}
        </div>
      ) : null}
      {!shouldRenderContentBubble && actionControls ? (
        <div className="flex max-w-[85%] justify-end sm:max-w-[80%]">
          {actionControls}
        </div>
      ) : null}
    </div>
  )
}
