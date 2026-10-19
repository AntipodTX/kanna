import { useCallback, useEffect, useState } from "react"
import type { UpdateInstallResult, UpdateSnapshot } from "../../shared/types"
import { isNightlyVersion } from "../../shared/types"
import type { useAppDialog } from "../components/ui/app-dialog"
import {
  UI_UPDATE_RELOAD_REQUEST_STORAGE_KEY,
  UI_UPDATE_RESTART_STORAGE_KEY,
} from "../lib/storageKeys"
import type { KannaSocket, SocketStatus } from "./socket"

// Update/restart orchestration: subscribes to the update snapshot, tracks the
// sessionStorage-backed restart phase across the server process restart, polls
// for server readiness after a restart, and reloads the page once it is back.

export function getUiUpdateRestartReconnectAction(
  phase: string | null,
  connectionStatus: SocketStatus
): "none" | "awaiting_server_ready" {
  if (phase === "awaiting_disconnect" && connectionStatus === "disconnected") {
    return "awaiting_server_ready"
  }

  return "none"
}

export function shouldHandleUiUpdateReloadRequest(
  reloadRequestedAt: number | null | undefined,
  lastHandledReloadRequest: string | null
) {
  if (!reloadRequestedAt) return false
  return String(reloadRequestedAt) !== lastHandledReloadRequest
}

export function getUiUpdateReadinessPath() {
  return "/auth/status"
}

function getUiUpdateRestartPhase() {
  return window.sessionStorage.getItem(UI_UPDATE_RESTART_STORAGE_KEY)
}

function setUiUpdateRestartPhase(phase: "awaiting_disconnect" | "awaiting_server_ready") {
  window.sessionStorage.setItem(UI_UPDATE_RESTART_STORAGE_KEY, phase)
}

function clearUiUpdateRestartPhase() {
  window.sessionStorage.removeItem(UI_UPDATE_RESTART_STORAGE_KEY)
}

function getLastHandledUiUpdateReloadRequest() {
  return window.sessionStorage.getItem(UI_UPDATE_RELOAD_REQUEST_STORAGE_KEY)
}

function setLastHandledUiUpdateReloadRequest(reloadRequestedAt: number) {
  window.sessionStorage.setItem(UI_UPDATE_RELOAD_REQUEST_STORAGE_KEY, String(reloadRequestedAt))
}

async function isServerReady(fetchImpl: typeof fetch = fetch) {
  const response = await fetchImpl(getUiUpdateReadinessPath(), {
    method: "GET",
    cache: "no-store",
    headers: {
      Accept: "application/json",
    },
  })

  return response.ok
}

export function useUpdateRestart(params: {
  socket: KannaSocket
  connectionStatus: SocketStatus
  dialog: ReturnType<typeof useAppDialog>
  setCommandError: (message: string | null) => void
}) {
  const { socket, connectionStatus, dialog, setCommandError } = params
  const [updateSnapshot, setUpdateSnapshot] = useState<UpdateSnapshot | null>(null)
  const onNightly = isNightlyVersion(updateSnapshot?.currentVersion ?? "")

  useEffect(() => {
    return socket.subscribe<UpdateSnapshot>({ type: "update" }, (snapshot) => {
      setUpdateSnapshot(snapshot)
    })
  }, [setCommandError, socket])

  useEffect(() => {
    if (connectionStatus !== "connected") return
    void socket.command<UpdateSnapshot>({ type: "update.check", force: true }).catch((error) => {
      setCommandError(error instanceof Error ? error.message : String(error))
    })
  }, [connectionStatus, setCommandError, socket])

  useEffect(() => {
    const reloadRequestedAt = updateSnapshot?.reloadRequestedAt
    if (!shouldHandleUiUpdateReloadRequest(reloadRequestedAt, getLastHandledUiUpdateReloadRequest())) {
      return
    }
    if (!reloadRequestedAt) {
      return
    }

    setLastHandledUiUpdateReloadRequest(reloadRequestedAt)
    setUiUpdateRestartPhase("awaiting_disconnect")
  }, [updateSnapshot?.reloadRequestedAt])

  useEffect(() => {
    const phase = getUiUpdateRestartPhase()
    const reconnectAction = getUiUpdateRestartReconnectAction(phase, connectionStatus)
    if (reconnectAction === "awaiting_server_ready") {
      setUiUpdateRestartPhase("awaiting_server_ready")
      return
    }
  }, [connectionStatus])

  useEffect(() => {
    if (getUiUpdateRestartPhase() !== "awaiting_server_ready") {
      return
    }

    let cancelled = false
    let timeoutId: number | null = null

    const pollServerReadiness = async () => {
      try {
        if (await isServerReady()) {
          if (cancelled) return
          clearUiUpdateRestartPhase()
          window.location.reload()
          return
        }
      } catch {
        // Keep polling while the process restarts.
      }

      if (cancelled) return
      timeoutId = window.setTimeout(() => {
        void pollServerReadiness()
      }, 500)
    }

    void pollServerReadiness()

    return () => {
      cancelled = true
      if (timeoutId !== null) {
        window.clearTimeout(timeoutId)
      }
    }
  }, [connectionStatus])

  useEffect(() => {
    if (connectionStatus !== "connected") return
    const checkInterval = (onNightly ? 5 : 60) * 60 * 1000
    function checkIfDue() {
      if (document.visibilityState !== "visible") return
      if (updateSnapshot?.lastCheckedAt && Date.now() - updateSnapshot.lastCheckedAt < checkInterval) return
      void socket.command<UpdateSnapshot>({ type: "update.check" }).catch((error) => {
        setCommandError(error instanceof Error ? error.message : String(error))
      })
    }

    // The sidebar needs fresh nightly status even when Labs is closed.
    const timer = onNightly ? window.setInterval(checkIfDue, checkInterval) : null
    window.addEventListener("focus", checkIfDue)
    document.addEventListener("visibilitychange", checkIfDue)
    return () => {
      if (timer !== null) window.clearInterval(timer)
      window.removeEventListener("focus", checkIfDue)
      document.removeEventListener("visibilitychange", checkIfDue)
    }
  }, [connectionStatus, onNightly, setCommandError, socket, updateSnapshot?.lastCheckedAt])

  const handleCheckForUpdates = useCallback(async (options?: { force?: boolean }) => {
    try {
      await socket.command<UpdateSnapshot>({ type: "update.check", force: options?.force })
      setCommandError(null)
    } catch (error) {
      setCommandError(error instanceof Error ? error.message : String(error))
    }
  }, [setCommandError, socket])

  const runInstallCommand = useCallback(async (
    command: { type: "update.install" | "update.installNightly" | "update.installStable" },
    failureTitle: string,
    failureMessage: string
  ) => {
    try {
      const result = await socket.command<UpdateInstallResult>(command)
      if (!result.ok) {
        clearUiUpdateRestartPhase()
        setCommandError(null)
        await dialog.alert({
          title: result.userTitle ?? failureTitle,
          description: result.userMessage ?? failureMessage,
          closeLabel: "OK",
        })
        return
      }

      if (result.ok && result.action === "reload") {
        window.location.reload()
        return
      }

      if (result.ok && result.action === "restart") {
        setUiUpdateRestartPhase("awaiting_disconnect")
      }
      setCommandError(null)
    } catch (error) {
      clearUiUpdateRestartPhase()
      setCommandError(error instanceof Error ? error.message : String(error))
    }
  }, [dialog, setCommandError, socket])

  const handleInstallUpdate = useCallback(async () => {
    await runInstallCommand(
      { type: "update.install" },
      "Update failed",
      "Kanna could not install the update. Try again later."
    )
  }, [runInstallCommand])

  const handleInstallNightly = useCallback(async () => {
    const confirmed = await dialog.confirm({
      title: "Update to nightly?",
      description: "Kanna will download the latest main branch from GitHub, build it from source on this machine, and restart into it. This takes a few minutes, and nightly builds can be less stable than releases. The next published release brings you back to stable automatically.",
      confirmLabel: "Build nightly",
    })
    if (!confirmed) return
    await runInstallCommand(
      { type: "update.installNightly" },
      "Nightly update failed",
      "Kanna could not build the nightly version. Try again later."
    )
  }, [dialog, runInstallCommand])

  const handleInstallStable = useCallback(async () => {
    const confirmed = await dialog.confirm({
      title: "Back to stable?",
      description: "Kanna will reinstall the latest published release and restart into it.",
      confirmLabel: "Reinstall stable",
    })
    if (!confirmed) return
    await runInstallCommand(
      { type: "update.installStable" },
      "Update failed",
      "Kanna could not reinstall the latest release. Try again later."
    )
  }, [dialog, runInstallCommand])

  return { updateSnapshot, handleCheckForUpdates, handleInstallUpdate, handleInstallNightly, handleInstallStable }
}
