import { useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent } from "react"
import { AlertTriangle, CheckCircle2, LoaderCircle } from "lucide-react"
import type { StartupSyncSnapshot } from "../../shared/types"
import { Button } from "../components/ui/button"

interface StartupSyncProgressDialogProps {
  snapshot: StartupSyncSnapshot | null
  onDismiss: () => void
}

export function isStartupSyncDialogBlocking(snapshot: StartupSyncSnapshot | null) {
  return Boolean(snapshot?.enabled && snapshot.status !== "idle")
}

function getFocusableDialogElements(dialog: HTMLDivElement) {
  return [...dialog.querySelectorAll<HTMLElement>(
    'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
  )].filter((element) => !element.hasAttribute("disabled") && element.getAttribute("aria-hidden") !== "true")
}

export function StartupSyncProgressDialog({ snapshot, onDismiss }: StartupSyncProgressDialogProps) {
  const dialogRef = useRef<HTMLDivElement | null>(null)
  const logRef = useRef<HTMLDivElement | null>(null)
  const isRunning = snapshot?.status === "running"
  const isBlocking = isStartupSyncDialogBlocking(snapshot)

  useEffect(() => {
    const element = logRef.current
    if (!element) return
    element.scrollTop = element.scrollHeight
  }, [snapshot?.messages.length])

  useEffect(() => {
    if (!isBlocking) return
    dialogRef.current?.focus({ preventScroll: true })
  }, [isBlocking, snapshot?.startedAt])

  useEffect(() => {
    if (!isBlocking) return

    function handleDocumentKeyDown(event: KeyboardEvent) {
      const dialog = dialogRef.current
      if (!dialog) return

      if (dialog.contains(event.target as Node | null)) {
        if (event.key === "Escape") {
          event.preventDefault()
          event.stopPropagation()
          dialog.focus({ preventScroll: true })
        }
        if (event.key === "Tab") {
          event.preventDefault()
          event.stopPropagation()
          const focusableElements = getFocusableDialogElements(dialog)
          if (focusableElements.length === 0) {
            dialog.focus({ preventScroll: true })
            return
          }
          const currentIndex = focusableElements.indexOf(document.activeElement as HTMLElement)
          let nextIndex = currentIndex + 1
          if (event.shiftKey) {
            nextIndex = currentIndex <= 0 ? focusableElements.length - 1 : currentIndex - 1
          } else if (currentIndex === -1 || currentIndex === focusableElements.length - 1) {
            nextIndex = 0
          }
          focusableElements[nextIndex]?.focus({ preventScroll: true })
        }
        return
      }

      event.preventDefault()
      event.stopPropagation()
      dialog.focus({ preventScroll: true })
    }

    document.addEventListener("keydown", handleDocumentKeyDown, true)
    return () => document.removeEventListener("keydown", handleDocumentKeyDown, true)
  }, [isBlocking])

  if (!snapshot?.enabled || snapshot.status === "idle") {
    return null
  }

  const isFailed = snapshot.status === "failed"
  const isStorageRecovery = snapshot.mode === "storage-recovery"
  const title = isStorageRecovery
    ? "Storage Recovery Mode"
    : isRunning
      ? "Synchronizing Sessions"
      : isFailed
        ? "Session Sync Failed"
        : "Session Sync Complete"
  const description = isStorageRecovery
    ? "Kanna detected corrupt local storage during startup, backed up the affected files, and continued from the remaining recoverable history. Review the messages before continuing."
    : isRunning
      ? "Native Claude and Codex sessions are being imported. You can keep this page open and watch the same progress messages that are printed in the server log."
      : isFailed
        ? "Startup session sync stopped with an error. The server log contains the same messages."
        : "Startup session sync finished. The imported chats are available in the sidebar."

  function handleDialogKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (!isBlocking) return
    event.stopPropagation()
  }

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label={title}
      tabIndex={-1}
      onKeyDownCapture={handleDialogKeyDown}
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/55 px-4 py-6 backdrop-blur-sm dark:bg-black/70"
    >
      <section className="flex max-h-[min(720px,88dvh)] w-full max-w-3xl flex-col overflow-hidden rounded-3xl border border-border bg-card shadow-2xl">
        <header className="flex items-start gap-3 border-b border-border px-5 py-4">
          <div className="mt-0.5 rounded-2xl border border-border bg-muted p-2">
            {isRunning ? (
              <LoaderCircle className="size-5 animate-spin text-muted-foreground" />
            ) : isFailed ? (
              <AlertTriangle className="size-5 text-destructive" />
            ) : (
              <CheckCircle2 className="size-5 text-emerald-600" />
            )}
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-semibold text-foreground">{title}</h2>
            <p className="mt-1 text-sm leading-6 text-muted-foreground">{description}</p>
          </div>
        </header>

        <div className="min-h-0 flex-1 bg-muted/20 p-4">
          <div
            ref={logRef}
            className="max-h-[min(460px,52dvh)] overflow-auto rounded-2xl border border-border bg-background p-4 font-mono text-xs leading-5 text-foreground"
          >
            {snapshot.messages.length > 0 ? (
              snapshot.messages.map((message, index) => (
                <div key={`${index}:${message}`} className="whitespace-pre-wrap break-words">
                  {message}
                </div>
              ))
            ) : (
              <div className="text-muted-foreground">
                {isStorageRecovery ? "Waiting for recovery output..." : "Waiting for session sync output..."}
              </div>
            )}
            {snapshot.error ? (
              <div className="mt-3 whitespace-pre-wrap break-words text-destructive">
                {snapshot.error}
              </div>
            ) : null}
          </div>
        </div>

        {!isRunning ? (
          <footer className="flex justify-end border-t border-border px-5 py-4">
            <Button type="button" onClick={onDismiss}>
              Close
            </Button>
          </footer>
        ) : null}
      </section>
    </div>
  )
}
