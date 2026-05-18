import { Check, ShieldQuestion, X } from "lucide-react"
import type { CodexApprovalDecision } from "../../../shared/types"
import type { ProcessedToolCall } from "./types"
import { Button } from "../ui/button"
import { cn } from "../../lib/utils"
import { useTranscriptRenderOptions } from "./render-context"

interface Props {
  message: Extract<ProcessedToolCall, { toolKind: "codex_approval" }>
  onDecision: (toolUseId: string, decision: CodexApprovalDecision) => void
  isLatest: boolean
}

function DecisionLabel({ decision }: { decision: CodexApprovalDecision }) {
  if (decision === "accept") return <>Approved</>
  if (decision === "acceptForSession") return <>Approved for session</>
  if (decision === "cancel") return <>Cancelled</>
  return <>Declined</>
}

export function CodexApprovalMessage({ message, onDecision, isLatest }: Props) {
  const renderOptions = useTranscriptRenderOptions()
  const input = message.input
  const result = message.result
  const isComplete = !!result
  const isCommand = input.approvalKind === "command_execution"
  const title = isCommand ? "Approve command" : "Approve file access"
  const detail = isCommand ? input.command : input.grantRoot

  return (
    <div className="rounded-2xl border border-border bg-muted dark:bg-card overflow-hidden">
      <div className="flex items-start gap-3 border-b border-border px-4 py-3">
        <ShieldQuestion className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-foreground">{title}</div>
          {input.reason ? <div className="mt-1 text-xs text-muted-foreground">{input.reason}</div> : null}
        </div>
      </div>

      <div className="space-y-2 px-4 py-3">
        {detail ? (
          <pre className={cn(
            "max-h-44 overflow-auto rounded-lg border border-border bg-background px-3 py-2 text-xs",
            isCommand ? "font-mono whitespace-pre-wrap break-words" : "font-mono break-all"
          )}>
            {detail}
          </pre>
        ) : null}
        {isCommand && input.cwd ? (
          <div className="break-all text-xs text-muted-foreground">{input.cwd}</div>
        ) : null}
      </div>

      {isComplete ? (
        <div className="flex justify-end border-t border-border px-4 py-3">
          <span className="text-sm italic text-muted-foreground">
            <DecisionLabel decision={result.decision} />
          </span>
        </div>
      ) : !isLatest ? (
        <div className="flex justify-end border-t border-border px-4 py-3">
          <span className="text-sm italic text-muted-foreground">Approval pending in an older turn</span>
        </div>
      ) : renderOptions.readonly ? (
        <div className="flex justify-end border-t border-border px-4 py-3">
          <span className="text-sm italic text-muted-foreground">Approval pending in original session</span>
        </div>
      ) : (
        <div className="flex flex-col gap-2 border-t border-border px-4 py-3 sm:flex-row sm:justify-end">
          <Button
            size="sm"
            variant="outline"
            className="rounded-full border-border"
            onClick={() => onDecision(message.toolId, "decline")}
          >
            <X className="mr-1.5 h-4 w-4" />
            Decline
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="rounded-full border-border"
            onClick={() => onDecision(message.toolId, "acceptForSession")}
          >
            <Check className="mr-1.5 h-4 w-4" />
            Approve for session
          </Button>
          <Button
            size="sm"
            className="rounded-full bg-primary text-background"
            onClick={() => onDecision(message.toolId, "accept")}
          >
            <Check className="mr-1.5 h-4 w-4" />
            Approve
          </Button>
        </div>
      )}
    </div>
  )
}
