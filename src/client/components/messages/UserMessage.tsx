import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent } from "react"
import type { ChatAttachment } from "../../../shared/types"
import Markdown from "react-markdown"
import remarkGfm from "remark-gfm"
import { Check, CornerUpLeft, GitFork, Pencil, X } from "lucide-react"
import { createMarkdownComponents } from "./shared"
import { classifyAttachmentPreview } from "./attachmentPreview"
import { AttachmentFileCard, AttachmentImageCard } from "./AttachmentCard"
import { AttachmentPreviewModal } from "./AttachmentPreviewModal"
import { useTranscriptRenderOptions } from "./render-context"
import { Button } from "../ui/button"
import { Textarea } from "../ui/textarea"

interface Props {
  messageId?: string
  content: string
  attachments?: ChatAttachment[]
  steered?: boolean
  editDisabled?: boolean
  forkDisabled?: boolean
  onEdit?: (messageId: string, content: string) => void | Promise<void>
  onFork?: (messageId: string) => void | Promise<void>
}

const MIN_EDIT_TEXTAREA_ROWS = 1
const MIN_EDIT_TEXTAREA_MAX_HEIGHT = 96
const EDIT_TEXTAREA_VIEWPORT_MARGIN = 32

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

export function UserMessage({
  messageId,
  content,
  attachments = [],
  steered = false,
  editDisabled = false,
  forkDisabled = false,
  onEdit,
  onFork,
}: Props) {
  const [selectedAttachmentId, setSelectedAttachmentId] = useState<string | null>(null)
  const [isEditing, setIsEditing] = useState(false)
  const parsedContent = useMemo(() => parseUserMessageContent(content), [content])
  const [draftContent, setDraftContent] = useState(parsedContent.body)
  const [isSaving, setIsSaving] = useState(false)
  const editTextareaRef = useRef<HTMLTextAreaElement>(null)
  const renderOptions = useTranscriptRenderOptions()
  const editTextareaRows = useMemo(
    () => getUserMessageEditTextareaRows(parsedContent.body),
    [parsedContent.body],
  )
  const canEdit = Boolean(messageId && onEdit && !renderOptions.readonly)
  const canFork = Boolean(messageId && onFork && !renderOptions.readonly)
  const canSaveEdit = draftContent.trim().length > 0 && !isSaving
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
  const selectedAttachment = attachments.find((attachment) => attachment.id === selectedAttachmentId) ?? null
  const shouldRenderContentBubble = Boolean(
    isEditing
    || parsedContent.body
    || (!parsedContent.body && attachments.length === 0 && content && !parsedContent.systemMessage)
  )
  const actionControls = (canEdit || canFork) && !isEditing ? (
    <div className="flex shrink-0 items-center gap-1">
      {canEdit ? (
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Edit message"
          title="Edit message"
          className="opacity-70 transition-opacity hover:opacity-100 focus-visible:opacity-100"
          disabled={editDisabled}
          onClick={handleStartEdit}
        >
          <Pencil className="h-4 w-4" />
        </Button>
      ) : null}
      {canFork ? (
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Fork message"
          title="Fork message"
          className="opacity-70 transition-opacity hover:opacity-100 focus-visible:opacity-100"
          disabled={forkDisabled}
          onClick={() => messageId && void onFork?.(messageId)}
        >
          <GitFork className="h-4 w-4" />
        </Button>
      ) : null}
    </div>
  ) : null

  useEffect(() => {
    if (!isEditing) {
      setDraftContent(parsedContent.body)
    }
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
    if (isEditing) {
      resizeEditTextarea()
    }
  }, [draftContent, isEditing, resizeEditTextarea])

  useEffect(() => {
    if (!isEditing) return

    window.addEventListener("resize", resizeEditTextarea)
    return () => window.removeEventListener("resize", resizeEditTextarea)
  }, [isEditing, resizeEditTextarea])

  function handleAttachmentClick(attachment: ChatAttachment) {
    if (!canInteractWithAttachments || !attachment.contentUrl) {
      return
    }

    const target = classifyAttachmentPreview(attachment)
    if (target.openInNewTab) {
      if (typeof window !== "undefined") {
        window.open(new URL(attachment.contentUrl, document.baseURI || window.location.href).toString(), "_blank", "noopener,noreferrer")
      }
      return
    }

    setSelectedAttachmentId(attachment.id)
  }

  async function handleEditSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!messageId || !onEdit || !canSaveEdit) return

    try {
      setIsSaving(true)
      await onEdit(messageId, buildUserMessageEditContent(content, draftContent))
      setIsEditing(false)
    } finally {
      setIsSaving(false)
    }
  }

  function handleCancelEdit() {
    setDraftContent(parsedContent.body)
    setIsEditing(false)
  }

  function handleStartEdit() {
    setDraftContent(parsedContent.body)
    setIsEditing(true)
  }

  return (
    <>
      <div className="group flex flex-col items-end gap-2">
        {imageAttachments.length > 0 ? (
          <div className="flex max-w-[85%] sm:max-w-[80%] flex-wrap justify-end gap-3">
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
          <div className="flex max-w-[85%] sm:max-w-[80%] flex-wrap justify-end gap-2">
            {fileAttachments.map((attachment) => (
              <AttachmentFileCard
                key={attachment.id}
                attachment={attachment}
                onClick={canInteractWithAttachments ? () => handleAttachmentClick(attachment) : undefined}
              />
            ))}
          </div>
        ) : null}
        {shouldRenderContentBubble ? (
          <div className={`flex max-w-[85%] items-center gap-2 sm:max-w-[80%] ${isEditing ? "w-[85%] sm:w-[80%]" : ""}`}>
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
            <div className="min-w-0 flex-1 rounded-[20px] border border-border bg-muted px-3.5 py-1.5 text-primary prose prose-sm prose-invert [&_p]:whitespace-pre-line">
              {isEditing ? (
                <form className="not-prose flex min-w-0 gap-2" onSubmit={handleEditSubmit}>
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
              ) : (
                <Markdown remarkPlugins={[remarkGfm]} components={createMarkdownComponents()}>{parsedContent.body}</Markdown>
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
      <AttachmentPreviewModal attachment={selectedAttachment} onOpenChange={(open) => !open && setSelectedAttachmentId(null)} />
    </>
  )
}
