import { createContext, useCallback, useContext, useSyncExternalStore, type ReactNode } from "react"
import type { TranscriptEntry } from "../../../shared/types"
import type { ToolPayloadStore } from "../../app/ChatPage/toolPayloadStore"

/**
 * Access to tool payloads the transcript did not ship inline.
 *
 * Null — the default — means payloads are already inline and nothing needs
 * fetching. That is the export viewer and any transcript bundle, which carry
 * full entries; they render unchanged without knowing this exists.
 */
const ToolPayloadContext = createContext<ToolPayloadStore | null>(null)

export function ToolPayloadProvider({ store, children }: { store: ToolPayloadStore; children: ReactNode }) {
  return <ToolPayloadContext.Provider value={store}>{children}</ToolPayloadContext.Provider>
}

/**
 * The fetched entry for an id, requesting it on first use.
 *
 * Returns undefined while loading, and stays undefined where there is no store
 * — callers fall back to whatever the message already carries.
 */
export function useToolPayload(entryId: string | undefined): TranscriptEntry | undefined {
  const store = useContext(ToolPayloadContext)

  const subscribe = useCallback((onChange: () => void) => {
    if (!store || !entryId) return () => {}
    // Asking here rather than in an effect means the request is in flight
    // before paint, so a hover-warmed row is usually already resolved.
    store.prefetch([entryId])
    return store.subscribe(entryId, onChange)
  }, [store, entryId])

  const getSnapshot = useCallback(() => store?.get(entryId), [store, entryId])

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

/**
 * Warm payloads ahead of a click. No-op without a store, so callers can wire
 * it to a hover handler unconditionally.
 */
export function useToolPayloadPrefetch() {
  const store = useContext(ToolPayloadContext)
  return useCallback((entryIds: ReadonlyArray<string | undefined>) => {
    store?.prefetch(entryIds)
  }, [store])
}

/** Load payload-bearing entries for consumers that need to inspect their text. */
export function useToolPayloadLoader() {
  const store = useContext(ToolPayloadContext)
  return useCallback(async (entryIds: ReadonlyArray<string>) => {
    if (!store || entryIds.length === 0) return []
    return await store.load(entryIds)
  }, [store])
}
