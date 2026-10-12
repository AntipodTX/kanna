import {
  deleteSession,
  forkSession,
  importSessionToStore,
  type SessionStore,
  type SessionStoreEntry,
} from "@anthropic-ai/claude-agent-sdk"
import { isDeepStrictEqual } from "node:util"
import type { TranscriptEntry } from "../shared/types"

export interface PreparedClaudeTranscriptFork {
  sessionToken: string
  transcriptPrefix: TranscriptEntry[]
}

interface NativeIdentity { sessionId: string; messageUuid: string }
interface NativeEntry extends SessionStoreEntry {
  uuid: string
  sessionId?: string
  parentUuid?: string | null
  logicalParentUuid?: string | null
  isSidechain?: boolean
}

interface ClaudeForkReader {
  read(sessionId: string, dir: string): Promise<SessionStoreEntry[]>
  fork(sessionId: string, dir: string, upToMessageId?: string): Promise<string>
  remove(sessionId: string, dir: string): Promise<void>
}

const sdkReader: ClaudeForkReader = {
  async read(sessionId, dir) {
    const entries: SessionStoreEntry[] = []
    // The SDK resolves the native file (including worktrees and relocated
    // projects). Import into a read collector, not a new storage backend.
    const collector: SessionStore = {
      async append(key, batch) {
        if (key.sessionId !== sessionId || key.subpath) throw new Error("Unexpected Claude session import")
        entries.push(...batch)
      },
      async load() { throw new Error("Claude import collector cannot resume sessions") },
    }
    await importSessionToStore(sessionId, collector, { dir, includeSubagents: false })
    return entries
  },
  async fork(sessionId, dir, upToMessageId) {
    return (await forkSession(sessionId, { dir, upToMessageId })).sessionId
  },
  async remove(sessionId, dir) { await deleteSession(sessionId, { dir }) },
}

function provenance(value: unknown): NativeIdentity | null {
  if (!value || typeof value !== "object") return null
  const raw = value as Record<string, unknown>
  return typeof raw.sessionId === "string" && typeof raw.messageUuid === "string"
    ? { sessionId: raw.sessionId, messageUuid: raw.messageUuid }
    : null
}

function records(entries: SessionStoreEntry[]) {
  const byId = new Map<string, NativeEntry>()
  for (const entry of entries) {
    if (typeof entry.uuid !== "string") continue
    if (!["user", "assistant", "system", "attachment", "progress"].includes(entry.type)) continue
    const previous = byId.get(entry.uuid)
    if (previous && !isDeepStrictEqual(previous, entry)) throw new Error("Conflicting Claude native message UUID")
    byId.set(entry.uuid, entry as NativeEntry)
  }
  return byId
}

function entrySession(entry: TranscriptEntry): string | undefined {
  if (entry.claudeSessionToken) return entry.claudeSessionToken
  try {
    const raw = JSON.parse(entry.debugRaw ?? "null")
    if (typeof raw?.session_id === "string") return raw.session_id
    if (typeof raw?.sessionId === "string") return raw.sessionId
  } catch { /* Old raw metadata is optional. UUID validation remains required. */ }
  return undefined
}

function isChild(entry: TranscriptEntry) {
  if (entry.parentToolUseId || entry.claudeSidechain) return true
  try {
    const raw = JSON.parse(entry.debugRaw ?? "null")
    return Boolean(raw?.parent_tool_use_id || raw?.isSidechain || raw?.subagent_type)
  } catch { return false }
}

/**
 * Fork native history and translate its retained Kanna rows using the SDK's
 * explicit forkedFrom identities. Positions and equal prompt text cannot
 * identify a native message. Missing evidence refuses the operation.
 */
export async function prepareClaudeTranscriptFork(args: {
  localPath: string
  sessionToken: string
  resumeSessionAt?: string
  boundarySessionToken?: string | null
  transcriptPrefix: TranscriptEntry[]
}, reader: ClaudeForkReader = sdkReader): Promise<PreparedClaudeTranscriptFork> {
  const sessions = new Map<string, Map<string, NativeEntry>>()
  const load = async (sessionId: string) => {
    let found = sessions.get(sessionId)
    if (!found) {
      found = records(await reader.read(sessionId, args.localPath))
      if (!found.size) throw new Error("Claude native history is unavailable")
      if ([...found.values()].some((entry) => entry.sessionId && entry.sessionId !== sessionId)) {
        throw new Error("Claude native history belongs to another session")
      }
      sessions.set(sessionId, found)
    }
    return found
  }
  const source = await load(args.sessionToken)
  const resolve = async (messageId: string, sessionId?: string | null) => {
    const direct = source.get(messageId)
    if (direct && !direct.isSidechain && direct.type !== "progress"
      && (!sessionId || sessionId === args.sessionToken)) return direct.uuid
    const immediate = [...source.values()].filter((entry) => {
      const origin = provenance(entry.forkedFrom)
      return !entry.isSidechain && origin?.messageUuid === messageId && (!sessionId || origin.sessionId === sessionId)
    })
    if (immediate.length > 1) throw new Error("Ambiguous Claude native message identity")
    if (immediate.length === 1) return immediate[0]!.uuid
    const matches: string[] = []
    for (const entry of source.values()) {
      if (entry.isSidechain || entry.type === "progress") continue
      let identity: NativeIdentity = { sessionId: args.sessionToken, messageUuid: entry.uuid }
      let current = entry
      const seen = new Set<string>()
      for (;;) {
        if (identity.messageUuid === messageId && (!sessionId || identity.sessionId === sessionId)) {
          matches.push(entry.uuid)
          break
        }
        const origin = provenance(current.forkedFrom)
        if (!origin) break
        const key = `${origin.sessionId}:${origin.messageUuid}`
        if (seen.has(key)) throw new Error("Cyclic Claude fork ancestry")
        seen.add(key)
        // A direct fork link proves this identity without requiring the old
        // session file. Earlier generations are read only when needed.
        if (origin.messageUuid === messageId && (!sessionId || origin.sessionId === sessionId)) {
          matches.push(entry.uuid)
          break
        }
        const ancestor = (await load(origin.sessionId)).get(origin.messageUuid)
        if (!ancestor) throw new Error("Claude fork ancestry is incomplete")
        if (ancestor.type !== current.type || !isDeepStrictEqual(ancestor.message, current.message)) {
          throw new Error("Claude fork ancestry content does not match")
        }
        identity = origin
        current = ancestor
      }
    }
    if (matches.length > 1) throw new Error("Ambiguous Claude native message identity")
    return matches[0]
  }
  const boundary = args.resumeSessionAt
    ? await resolve(args.resumeSessionAt, args.boundarySessionToken)
    : undefined
  if (args.resumeSessionAt && !boundary) throw new Error("Claude resume point is missing from native history")

  const sourceIds = new Map<TranscriptEntry, string>()
  // A provider handoff or missing-session restore imported earlier history as
  // context, rather than as native messages in this session. Keep those rows.
  let nativeStart = 0
  for (let index = args.transcriptPrefix.length - 1; index >= 0; index--) {
    const entry = args.transcriptPrefix[index]
    if ((entry.kind === "handoff_boundary" && entry.toProvider === "claude")
      || (entry.kind === "session_restored" && entry.provider === "claude")) {
      nativeStart = index + 1
      break
    }
  }
  for (const entry of args.transcriptPrefix.slice(nativeStart)) {
    if (!entry.messageId || isChild(entry)) continue
    // Runtime-only init and result UUIDs are not native chain entries.
    if (["system_init", "result", "interrupted", "account_info"].includes(entry.kind)) continue
    const resolved = await resolve(entry.messageId, entrySession(entry))
    if (resolved) sourceIds.set(entry, resolved)
    else if (["assistant_text", "tool_call", "tool_result", "user_prompt", "compact_summary"].includes(entry.kind)) {
      throw new Error("Claude transcript prefix has no verified native message mapping")
    }
  }

  const forkedSession = await reader.fork(args.sessionToken, args.localPath, boundary)
  if (!forkedSession || forkedSession === args.sessionToken) throw new Error("Claude did not create a distinct fork")
  try {
    const forked = records(await reader.read(forkedSession, args.localPath))
    const mapping = new Map<string, string>()
    for (const entry of forked.values()) {
      const origin = provenance(entry.forkedFrom)
      if (!origin) throw new Error("Claude fork lacks exact UUID provenance")
      const original = source.get(origin.messageUuid)
      if (origin.sessionId !== args.sessionToken || !original || original.isSidechain
        || entry.sessionId !== forkedSession || entry.type !== original.type
        || !isDeepStrictEqual(entry.message, original.message) || mapping.has(original.uuid)) {
        throw new Error("Claude fork UUID provenance does not match its source")
      }
      mapping.set(original.uuid, entry.uuid)
    }
    const translatedParent = (original: NativeEntry) => {
      let parent = original.parentUuid
      const seen = new Set<string>()
      while (parent) {
        if (seen.has(parent)) throw new Error("Cyclic Claude native parent chain")
        seen.add(parent)
        const parentEntry = source.get(parent)
        if (!parentEntry) throw new Error("Claude native parent chain is incomplete")
        if (parentEntry.type !== "progress") {
          const mapped = mapping.get(parent)
          if (!mapped) throw new Error("Claude fork dropped a native parent")
          return mapped
        }
        parent = parentEntry.parentUuid
      }
      return null
    }
    for (const entry of forked.values()) {
      const original = source.get(provenance(entry.forkedFrom)!.messageUuid)!
      const logicalParent = original.logicalParentUuid == null
        ? original.logicalParentUuid
        : mapping.get(original.logicalParentUuid) ?? null
      if ((entry.parentUuid ?? null) !== translatedParent(original)
        || entry.logicalParentUuid !== logicalParent) throw new Error("Claude fork parent chain does not match its source")
    }
    if (boundary && !mapping.has(boundary)) throw new Error("Claude fork did not preserve the selected boundary")
    const transcriptPrefix = args.transcriptPrefix.map((entry) => {
      const sourceId = sourceIds.get(entry)
      if (!sourceId) return entry
      const messageId = mapping.get(sourceId)
      if (!messageId) throw new Error("Claude fork did not preserve the transcript prefix")
      return { ...entry, messageId, claudeSessionToken: forkedSession }
    })
    return { sessionToken: forkedSession, transcriptPrefix }
  } catch (error) {
    // Delete only the newly created artifact; the source and Kanna state have
    // not been modified. An invalid orphan must not be imported as a new chat.
    try { await reader.remove(forkedSession, args.localPath) }
    catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "Claude fork validation and new artifact cleanup failed")
    }
    throw error
  }
}
