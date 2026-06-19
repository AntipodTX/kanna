import type { StartupSyncSnapshot } from "../shared/types"

type StartupSyncListener = (snapshot: StartupSyncSnapshot) => void

const IDLE_STARTUP_SYNC_SNAPSHOT: StartupSyncSnapshot = {
  enabled: false,
  mode: "session-sync",
  status: "idle",
  messages: [],
  startedAt: null,
  completedAt: null,
  error: null,
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

export class StartupSyncProgress {
  private snapshot: StartupSyncSnapshot = IDLE_STARTUP_SYNC_SNAPSHOT
  private readonly listeners = new Set<StartupSyncListener>()

  getSnapshot(): StartupSyncSnapshot {
    return {
      ...this.snapshot,
      messages: [...this.snapshot.messages],
    }
  }

  onChange(listener: StartupSyncListener) {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  begin(mode: StartupSyncSnapshot["mode"] = "session-sync") {
    this.snapshot = {
      enabled: true,
      mode,
      status: "running",
      messages: [],
      startedAt: Date.now(),
      completedAt: null,
      error: null,
    }
    this.emit()
  }

  append(message: string) {
    this.snapshot = {
      ...this.snapshot,
      enabled: true,
      messages: [...this.snapshot.messages, message],
    }
    this.emit()
  }

  complete() {
    this.snapshot = {
      ...this.snapshot,
      enabled: true,
      status: "completed",
      completedAt: Date.now(),
      error: null,
    }
    this.emit()
  }

  fail(error: unknown) {
    this.snapshot = {
      ...this.snapshot,
      enabled: true,
      status: "failed",
      completedAt: Date.now(),
      error: errorMessage(error),
    }
    this.emit()
  }

  private emit() {
    const snapshot = this.getSnapshot()
    for (const listener of this.listeners) {
      listener(snapshot)
    }
  }
}
