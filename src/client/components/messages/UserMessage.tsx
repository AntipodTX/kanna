import { useEffect, useMemo, useState, type FormEvent } from "react"
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

function parseSystemMessage(content: string) {
  const match = content.match(/^<system-message>\s*([\s\S]*?)\s*<\/system-message>\s*([\s\S]*)$/)
  if (!match) {
    return { systemMessage: null, body: content }
  }

  return {
    systemMessage: match[1]?.trim() || null,
    body: match[2] ?? "",
  }
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
  const [draftContent, setDraftContent] = useState(content)
  const [isSaving, setIsSaving] = useState(false)
  const renderOptions = useTranscriptRenderOptions()
  const parsedContent = useMemo(() => parseSystemMessage(content), [content])
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

  useEffect(() => {
    if (!isEditing) {
      setDraftContent(content)
    }
  }, [content, isEditing])

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
      await onEdit(messageId, draftContent.trim())
      setIsEditing(false)
    } finally {
      setIsSaving(false)
    }
  }

  function handleCancelEdit() {
    setDraftContent(content)
    setIsEditing(false)
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
        {(isEditing || parsedContent.body || (!parsedContent.body && attachments.length === 0 && content && !parsedContent.systemMessage)) ? (
          <div className="flex max-w-[85%] items-center gap-2 sm:max-w-[80%]">
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
                    value={draftContent}
                    onChange={(event) => setDraftContent(event.currentTarget.value)}
                    className="min-h-24 resize-y bg-background text-primary"
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
            {(canEdit || canFork) && !isEditing ? (
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
                    onClick={() => setIsEditing(true)}
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
            ) : null}
          </div>
        ) : null}
      </div>
      <AttachmentPreviewModal attachment={selectedAttachment} onOpenChange={(open) => !open && setSelectedAttachmentId(null)} />
    </>
  )
}
