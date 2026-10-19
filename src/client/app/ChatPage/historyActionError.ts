import type { CodexHistoryActionsSnapshot } from "../../../shared/protocol"

export function getHistoryActionError(result: CodexHistoryActionsSnapshot, messageId?: string): string | null {
  const permitted = !messageId || Boolean(result.actions[messageId] && result.actions[messageId] !== "recover")
  if (!permitted) return result.gap?.error ?? "The selected message's Codex boundary could not be established"
  if (result.gap && result.messages?.[result.gap.messageId] !== "missing") return result.gap.error
  return null
}

export function getHistoryRepairNotice(repair: { phase: string; message: string } | null | undefined, error: string | null, recovering: boolean): string | null {
  if (recovering) return "Checking message correspondence with Codex…"
  if (repair?.phase === "running") return repair.message
  return error ?? repair?.message ?? null
}
