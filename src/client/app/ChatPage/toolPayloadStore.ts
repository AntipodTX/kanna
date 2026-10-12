import type { TranscriptEntry } from "../../../shared/types"

/**
 * Cache of tool payloads fetched on demand.
 *
 * Transcripts arrive with tool inputs and results left behind on the server —
 * a collapsed row draws none of them. This holds the ones we have since asked
 * for, so hovering a row can warm it before the click and expanding twice
 * costs one request.
 *
 * Requests made in the same tick are coalesced into a single batch, and an id
 * already cached or already in flight is never asked for twice. A failed batch
 * forgets itself so opening the row can try again.
 */

export interface ToolPayloadStore {
  /** Warm these ids. Safe to call on every hover; duplicates cost nothing. */
  prefetch(entryIds: ReadonlyArray<string | undefined>): void
  /** Fetch these payloads and return them in request order. */
  load(entryIds: ReadonlyArray<string>): Promise<TranscriptEntry[]>
  get(entryId: string | undefined): TranscriptEntry | undefined
  subscribe(entryId: string | undefined, onChange: () => void): () => void
}

export function createToolPayloadStore(
  fetchEntries: (entryIds: string[]) => Promise<TranscriptEntry[]>,
  maxBatchSize = 256,
): ToolPayloadStore {
  const cache = new Map<string, TranscriptEntry>()
  const pending = new Map<string, {
    promise: Promise<void>
    resolve: () => void
    reject: (error: unknown) => void
  }>()
  const listeners = new Map<string, Set<() => void>>()
  let queued: Set<string> | null = null

  function notify(entryId: string) {
    for (const listener of listeners.get(entryId) ?? []) listener()
  }

  async function flush(batch: Set<string>) {
    const entryIds = [...batch]
    try {
      for (let start = 0; start < entryIds.length; start += maxBatchSize) {
        const ids = entryIds.slice(start, start + maxBatchSize)
        for (const entry of await fetchEntries(ids)) cache.set(entry._id, entry)
      }
      for (const entryId of entryIds) pending.get(entryId)?.resolve()
    } catch (error) {
      for (const entryId of entryIds) pending.get(entryId)?.reject(error)
    } finally {
      for (const entryId of entryIds) {
        pending.delete(entryId)
        notify(entryId)
      }
    }
  }

  function request(entryIds: ReadonlyArray<string | undefined>): Promise<void>[] {
    const promises: Promise<void>[] = []
    for (const entryId of entryIds) {
      if (!entryId || cache.has(entryId)) continue
      const existing = pending.get(entryId)
      if (existing) {
        promises.push(existing.promise)
        continue
      }

      let resolve!: () => void
      let reject!: (error: unknown) => void
      const promise = new Promise<void>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise
        reject = rejectPromise
      })
      pending.set(entryId, { promise, resolve, reject })
      promises.push(promise)

      if (!queued) {
        queued = new Set()
        // One logical batch per tick. Large callers (full-chat search) are
        // split at the wire limit by flush; ordinary tool groups remain one
        // request.
        queueMicrotask(() => {
          const batch = queued
          queued = null
          if (batch) void flush(batch)
        })
      }
      queued.add(entryId)
    }
    return promises
  }

  return {
    prefetch(entryIds) {
      // A row that fails to warm simply stays in its loading state. Clearing
      // pending in flush lets the next hover/open retry.
      void Promise.all(request(entryIds)).catch(() => {})
    },

    async load(entryIds) {
      await Promise.all(request(entryIds))
      return entryIds
        .map((entryId) => cache.get(entryId))
        .filter((entry): entry is TranscriptEntry => entry !== undefined)
    },

    get(entryId) {
      return entryId ? cache.get(entryId) : undefined
    },

    subscribe(entryId, onChange) {
      if (!entryId) return () => {}
      let forId = listeners.get(entryId)
      if (!forId) {
        forId = new Set()
        listeners.set(entryId, forId)
      }
      forId.add(onChange)
      return () => {
        forId.delete(onChange)
        if (forId.size === 0) listeners.delete(entryId)
      }
    },
  }
}
