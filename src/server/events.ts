import type { AgentProvider, ModelOptions, ProjectSummary, QueuedChatMessage, TranscriptEntry } from "../shared/types"

export interface ProjectRecord extends ProjectSummary {
  sidebarTitle?: string
  deletedAt?: number
}

export interface ChatReadAnchor {
  messageId: string
  atEnd: boolean
  updatedAt: number
  /**
   * Width of the transcript column when this was recorded.
   *
   * `offsetFromMessage` is only meaningful at the same width — a narrower
   * column rewraps text, so the same scroll position sits at a different
   * distance into the message. Absent on anchors written before this existed.
   */
  transcriptWidth?: number
  /**
   * How far below the anchored message's own top the reader was, in pixels.
   *
   * Deliberately relative rather than an absolute scroll position: rows that
   * have never been on screen stand in at an estimated height, so the absolute
   * coordinate space shifts as they render and an absolute offset restores to
   * the wrong place. A distance from the message survives that, and carries the
   * within-message position that pinning the message alone would lose.
   */
  offsetFromMessage?: number
}

/** Required local context not yet confirmed delivered to the destination. */
export interface ContextRestoration {
  id: string
  provider: AgentProvider
  fromProvider: AgentProvider
  reason: "provider_switch" | "session_restore" | "explicit_reset"
  /** Prefix before the input that first requested restoration; excludes retries. */
  endExclusive: number
  /** Durable lower bound for an explicit reset even before its boundary row commits. */
  startInclusive?: number
}

export interface CodexHistoryIntegrity {
  /** Matches the user-history revision, native session, and context boundary. */
  key: string
  gap?: { messageId: string; error: string }
  messages?: Record<string, "missing" | "unknown">
  invalidated?: boolean
  segments?: Record<string, {
    ids: string[]; gap?: { messageId: string; error: string };
    messages?: Record<string, "missing" | "unknown">; invalidated?: boolean
  }>
  repair?: import("../shared/types").HistoryRepairStatus
}

export interface ChatRecord {
  id: string
  projectId: string
  title: string
  createdAt: number
  updatedAt: number
  deletedAt?: number
  archivedAt?: number
  pinnedAt?: number
  /** Set when the user marks the chat done (e.g. drags it to the board's Done column). Cleared when a new turn starts. */
  doneAt?: number
  unread: boolean
  /**
   * Where the user last left off reading, anchored to a transcript entry `_id`
   * so it survives history paging and re-renders. `atEnd` means they were
   * parked at the bottom following the stream — restore should keep following
   * rather than pin to a message.
   */
  readAnchor?: ChatReadAnchor | null
  provider: AgentProvider | null
  model?: string | null
  modelOptions?: ModelOptions | null
  planMode: boolean
  /** "Auto Plan": the harness keeps its EnterPlanMode tool. Claude only. */
  autoPlan: boolean
  sessionToken: string | null
  pendingForkSessionToken?: string | null
  pendingForkResumeAt?: string | null
  pendingForkUserPrompt?: boolean
  contextRestoration?: ContextRestoration | null
  promptHistoryRevision?: string
  /** Integrity timestamp; local-only inputs may still advance sidebar recency. */
  promptHistoryLastMessageAt?: number | null
  codexHistoryIntegrity?: CodexHistoryIntegrity
  hasMessages?: boolean
  lastMessageAt?: number
  /**
   * When the most recent turn *started*. With `lastTurnEndedAt` this is how
   * long the last turn took; while a turn is running it's how long it has been
   * going. Absent on chats whose turns all predate the field.
   */
  lastTurnStartedAt?: number
  /**
   * Model id the most recent turn ran with (e.g. "opus", "gpt-5.3-codex").
   * Recorded per turn rather than per chat because the model is picked at send
   * time and can differ turn to turn — this is the one that actually ran, not
   * whatever the composer happens to be set to now.
   */
  lastModel?: string
  /** When the last turn ended (finished/failed/cancelled) — i.e. when the last agent response was received. */
  lastTurnEndedAt?: number
  /**
   * How many turns this chat has run, counted from `turn_started`.
   *
   * A running total rather than something derived on demand: the sidebar
   * snapshot is built from `StoreState` alone and never opens a transcript, and
   * counting prompts per chat per broadcast would mean reading every one.
   *
   * Safe to accumulate here precisely because these are *store* events —
   * compaction writes the total into the snapshot and truncates the log, so
   * replay only re-applies what came after it. The same counter kept in
   * `applyMessageMetadata` would double-count, since boot re-runs that over
   * each transcript's tail on top of an already-loaded snapshot.
   *
   * Absent on chats whose turns all predate the field — the card says nothing
   * rather than claiming zero.
   */
  turnCount?: number
  /**
   * When the agent last wrote to the transcript (assistant text, tool call, or
   * tool result). Advances mid-turn, unlike `lastTurnEndedAt` — the timestamp
   * a chat waiting on a plan or a permission prompt sorts by.
   */
  lastAgentMessageAt?: number
  lastUserMessagePreview?: string
  lastAgentMessagePreview?: string
  /**
   * When `lastAgentMessagePreview`'s entry was written — i.e. how old the
   * agent's last *words* are, as opposed to `lastAgentMessageAt`, which any
   * tool call advances. Compared against `lastMessageAt` to tell a reply to the
   * current prompt from one left over from the previous turn.
   */
  lastAgentMessagePreviewAt?: number
  lastTurnOutcome: "success" | "failed" | "cancelled" | null
  /**
   * Set when a turn was cut short because Kanna itself went down, and cleared
   * by the next boot's resume pass. A turn the *user* stopped never gets this,
   * which is the whole point: it's how the next process tells "this chat was
   * mid-task when we exited" from "this chat was stopped on purpose".
   *
   * Persisted rather than derived from `lastTurnStartedAt > lastTurnEndedAt`:
   * shutdown cancels the turn like any other cancel, so the timestamps alone
   * can't distinguish the two, and inferring it would make every chat killed
   * by an old `kill -9` resume out of nowhere on upgrade.
   */
  resumePending?: boolean
  /**
   * Files this chat has changed, unioned across its turns and measured by
   * diffing worktree snapshots at each turn boundary (see `TurnFileTracker`).
   * Intersected with the currently-dirty paths to decide whether a chat is
   * relevant to your uncommitted work.
   *
   * Last write wins per path: a later turn's base blob replaces an earlier
   * one's, so a chat that edits a file, has it committed, then edits it again
   * is measured against the newer commit rather than the one it started from.
   */
  touchedFiles?: TouchedFile[]
  /**
   * Legacy shape — paths with no base blob, written before commits could expire
   * a claim. Normalized into `touchedFiles` when an old snapshot loads and
   * never written again.
   */
  touchedPaths?: string[]
  /** Whether the user explicitly renamed this chat after it was imported. */
  hasLocalTitleOverride?: boolean
  /** Last modification time observed in the provider-owned session. */
  externalUpdatedAt?: number
}

/** One file a chat changed, and the committed content it changed it from. */
export interface TouchedFile {
  /** Repo-root-relative. */
  path: string
  /**
   * Blob sha this path held in `HEAD` when the touching turn started, or `null`
   * when it wasn't committed at all. The chat's claim on the path lives exactly
   * as long as `HEAD` still holds this blob: committing the path — by anyone,
   * including the chat itself — replaces it and retires the claim, so a chat
   * whose work has landed can't be dragged back into Relevant by someone else
   * dirtying the same file later.
   *
   * Absent means *unknown* (recorded before base blobs, or the lookup failed),
   * which keeps the old behaviour of flagging on a dirty-path match alone.
   */
  baseBlob?: string | null
  /**
   * Lines this chat wrote to this path, summed over every turn that changed it
   * — how much of the file is the chat's doing, not what the file currently
   * differs from `HEAD` by. A chat that added ten lines and then deleted them
   * reads as `+10 -10` rather than as nothing, which is the honest answer to
   * "what did this chat do here".
   *
   * Absent for binary files (numstat has no count for them) and for anything
   * recorded before turn-level counts existed.
   */
  additions?: number
  deletions?: number
}

export interface HiddenProviderSessionRecord {
  provider: AgentProvider
  sessionToken: string
  hiddenAt: number
}

export interface StoreState {
  projectsById: Map<string, ProjectRecord>
  projectIdsByPath: Map<string, string>
  chatsById: Map<string, ChatRecord>
  queuedMessagesByChatId: Map<string, QueuedChatMessage[]>
  hiddenProviderSessionsByKey: Map<string, HiddenProviderSessionRecord>
}

export interface SnapshotFile {
  v: 2
  generatedAt: number
  projects: ProjectRecord[]
  chats: ChatRecord[]
  sidebarProjectOrder?: string[]
  queuedMessages?: Array<{ chatId: string; entries: QueuedChatMessage[] }>
  messages?: Array<{ chatId: string; entries: TranscriptEntry[] }>
  hiddenProviderSessions?: HiddenProviderSessionRecord[]
}

export type ProjectEvent = {
  v: 2
  type: "project_opened"
  timestamp: number
  projectId: string
  localPath: string
  title: string
} | {
  v: 2
  type: "project_sidebar_renamed"
  timestamp: number
  projectId: string
  title: string | null
} | {
  v: 2
  type: "project_removed"
  timestamp: number
  projectId: string
}

export type ChatEvent =
  | {
      v: 2
      type: "chat_created"
      timestamp: number
      chatId: string
      projectId: string
      title: string
      /**
       * Forks only: the source chat's `lastTurnEndedAt`, carried over so the
       * fork inherits the conversation's recency in the sidebar. A fork has no
       * turn events of its own, so without this it would sort by creation time
       * as though the copied conversation never happened. Optional — absent on
       * every plain chat_created, including old logs.
       */
      lastTurnEndedAt?: number
    }
  | {
      v: 2
      type: "chat_pin_set"
      timestamp: number
      chatId: string
      pinned: boolean
    }
  | {
      v: 2
      type: "chat_renamed"
      timestamp: number
      chatId: string
      title: string
      markTitleOverride?: boolean
    }
  | {
      v: 2
      type: "chat_deleted"
      timestamp: number
      chatId: string
    }
  | {
      v: 2
      type: "chat_archived"
      timestamp: number
      chatId: string
    }
  | {
      v: 2
      type: "chat_unarchived"
      timestamp: number
      chatId: string
    }
  | {
      v: 2
      type: "chat_provider_set"
      timestamp: number
      chatId: string
      provider: AgentProvider
    }
  | {
      v: 2
      type: "chat_plan_mode_set"
      timestamp: number
      chatId: string
      planMode: boolean
    }
  | {
      v: 2
      type: "chat_auto_plan_set"
      timestamp: number
      chatId: string
      autoPlan: boolean
    }
  | {
      v: 2
      type: "chat_model_settings_set"
      timestamp: number
      chatId: string
      model: string | null
      modelOptions: ModelOptions | null
    }
  | {
      v: 2
      type: "chat_read_state_set"
      timestamp: number
      chatId: string
      unread: boolean
    }
  | {
      v: 2
      type: "chat_done_state_set"
      timestamp: number
      chatId: string
      done: boolean
    }
  | {
      v: 2
      type: "chat_read_anchor_set"
      timestamp: number
      chatId: string
      messageId: string
      atEnd: boolean
      /** See `ChatReadAnchor`. Optional — absent on pre-existing log lines. */
      transcriptWidth?: number
      offsetFromMessage?: number
    }
  | {
      v: 2
      type: "chat_last_message_at_set"
      timestamp: number
      chatId: string
      /**
       * When the user's newest message landed — `ChatRecord.lastMessageAt`.
       *
       * Logged rather than left to be re-derived from the transcript on boot:
       * the rehydration only reads each transcript's tail, so a chat whose last
       * prompt sits behind megabytes of tool output came back with no
       * timestamp at all and fell out of every recency-driven sidebar section.
       * One line per prompt, not per entry.
       */
      at: number
      promptHistoryRevision?: string
      /** Hidden and subagent inputs do not change the visible prompt sequence. */
      promptHistoryUnchanged?: true
    }
  | {
      v: 2
      type: "codex_history_integrity_set"
      timestamp: number
      chatId: string
      integrity: CodexHistoryIntegrity
    }
  | {
      v: 2
      type: "chat_files_touched"
      timestamp: number
      chatId: string
      /** Files one turn changed; replay unions them into `ChatRecord.touchedFiles`. */
      files?: TouchedFile[]
      /** Legacy shape: paths with no base blob. Read on replay, never written. */
      paths?: string[]
    }
  | {
      v: 2
      type: "chat_transcript_metadata_set"
      timestamp: number
      chatId: string
      hasMessages: boolean
      promptHistoryRevision?: string
      lastMessageAt: number | null
      lastUserMessagePreview: string | null
      lastAgentMessagePreview: string | null
      /** Optional for compatibility with transcript-rewrite events from older releases. */
      lastAgentMessagePreviewAt?: number | null
      /** Optional for compatibility with transcript-rewrite events from older releases. */
      lastAgentMessageAt?: number | null
    }
  | {
      v: 2
      type: "chat_synced"
      timestamp: number
      chatId: string
      provider: AgentProvider
      sessionToken: string
      externalUpdatedAt: number
      title?: string | null
    }
  | {
      v: 2
      type: "provider_session_hidden"
      timestamp: number
      provider: AgentProvider
      sessionToken: string
    }

export type MessageEvent = {
  v: 2
  type: "message_appended"
  timestamp: number
  chatId: string
  entry: TranscriptEntry
}

export type QueuedMessageEvent =
  | {
      v: 2
      type: "queued_message_enqueued"
      timestamp: number
      chatId: string
      message: QueuedChatMessage
    }
  | {
      v: 2
      type: "queued_message_removed"
      timestamp: number
      chatId: string
      queuedMessageId: string
    }

export type TurnEvent =
  | {
      v: 2
      type: "turn_count_restored"
      timestamp: number
      chatId: string
      /** Exact pre-edit count; null restores an absent count. */
      turnCount: number | null
    }
  | {
      v: 2
      type: "turn_started"
      timestamp: number
      chatId: string
      /** Model this turn runs with. Optional — absent on every pre-existing log line. */
      model?: string
      /**
       * Exact count after a transcript rewrite. Ordinary starts omit this and
       * increment the existing count.
       */
      turnCount?: number
    }
  | {
      v: 2
      type: "turn_finished"
      timestamp: number
      chatId: string
    }
  | {
      v: 2
      type: "turn_failed"
      timestamp: number
      chatId: string
      error: string
    }
  | {
      v: 2
      type: "turn_cancelled"
      timestamp: number
      chatId: string
    }
  | {
      v: 2
      type: "turn_resume_pending_set"
      timestamp: number
      chatId: string
      pending: boolean
    }
  | {
      v: 2
      type: "session_token_set"
      timestamp: number
      chatId: string
      sessionToken: string | null
    }
  | {
      v: 2
      type: "pending_fork_session_token_set"
      timestamp: number
      chatId: string
      pendingForkSessionToken: string | null
    }
  | {
      v: 2
      type: "pending_fork_resume_at_set"
      timestamp: number
      chatId: string
      pendingForkResumeAt: string | null
    }
  | {
      v: 2
      type: "pending_fork_user_prompt_set"
      timestamp: number
      chatId: string
      pendingForkUserPrompt: boolean
    }
  | {
      v: 2
      type: "context_restoration_set"
      timestamp: number
      chatId: string
      restoration: ContextRestoration | null
    }
  | {
      v: 2
      type: "context_restoration_acknowledged"
      timestamp: number
      chatId: string
      restorationId: string
    }

export type StoreEvent = ProjectEvent | ChatEvent | MessageEvent | QueuedMessageEvent | TurnEvent

export function createEmptyState(): StoreState {
  return {
    projectsById: new Map(),
    projectIdsByPath: new Map(),
    chatsById: new Map(),
    queuedMessagesByChatId: new Map(),
    hiddenProviderSessionsByKey: new Map(),
  }
}

export function cloneTranscriptEntries(entries: TranscriptEntry[]): TranscriptEntry[] {
  return entries.map((entry) => ({ ...entry }))
}

/** Tool kinds whose rendered result comes from `tool_use_result`, not `content`. */
export const STRUCTURED_RESULT_TOOL_KINDS: ReadonlySet<string> = new Set(["ask_user_question", "exit_plan_mode"])

/**
 * Tool kinds that render inline and interactively, so their payloads have to
 * travel with the transcript rather than being fetched when a row is opened —
 * there is no row to open. Superset of the structured-result kinds.
 */
export const INLINE_TOOL_KINDS: ReadonlySet<string> = new Set([...STRUCTURED_RESULT_TOOL_KINDS, "todo_write", "display"])

/**
 * Tool call input fields that can grow without bound, by kind. The other
 * kinds are already header-sized (a path, a pattern, a query) and travel
 * whole.
 */
export const UNBOUNDED_TOOL_INPUT_FIELDS: Readonly<Record<string, readonly string[]>> = {
  write_file: ["content"],
  delete_file: ["content"],
  edit_file: ["oldString", "newString"],
  subagent_task: ["prompt"],
  mcp_generic: ["payload"],
  unknown_tool: ["payload"],
}

/** Strip the raw provider payload; it duplicates `content` and dwarfs it. */
function withoutDebugRaw<TEntry extends TranscriptEntry>(entry: TEntry) {
  const { debugRaw, ...rest } = entry
  return rest as TEntry
}

/**
 * Drop a tool call's unbounded input fields, keeping everything a collapsed
 * row draws. Returns the entry unchanged when there was nothing to drop, so
 * the `trimmed` marker always means "fetching will reveal more".
 */
export function trimToolCallEntry(entry: Extract<TranscriptEntry, { kind: "tool_call" }>) {
  const { rawInput, ...tool } = entry.tool
  let input = tool.input as Record<string, unknown>
  let dropped = rawInput !== undefined

  for (const field of UNBOUNDED_TOOL_INPUT_FIELDS[tool.toolKind] ?? []) {
    if (input[field] === undefined) continue
    if (!dropped || input === tool.input) input = { ...input }
    delete input[field]
    dropped = true
  }

  if (!dropped) return entry
  return { ...entry, tool: { ...tool, input }, trimmed: true } as TranscriptEntry
}

/**
 * Clone entries for the wire, leaving the bulky parts on the server.
 *
 * A transcript is mostly tool traffic, and a collapsed tool row draws none of
 * it — a group of a dozen calls renders as one line reading "3 reads, 1
 * command". Sending the payloads anyway is how a 6,000-entry chat became 24MB
 * on the wire to paint a few hundred headers. Dropped here, the same chat is
 * under 2MB, and the payloads are fetched by id if a row is actually opened.
 *
 * Two things are deliberately never dropped:
 *
 * - `ask_user_question` / `exit_plan_mode` / `todo_write` render inline, so
 *   there is no expansion to fetch on. The first two additionally get
 *   `tool_use_result` lifted out of `debugRaw` into `structuredResult`.
 * - `isError` and the entry ids, which is everything a collapsed row and its
 *   group label need to describe a finished call.
 *
 * This is the only place the reduction happens. Full-fidelity consumers —
 * export, handoff, fork — read through `getMessages` and never pass here.
 */
export function cloneTranscriptEntriesForClient(
  entries: TranscriptEntry[],
  getToolKind?: (toolId: string) => string | undefined,
): TranscriptEntry[] {
  const toolKinds = new Map<string, string>()
  for (const entry of entries) {
    if (entry.kind !== "tool_call") continue
    toolKinds.set(entry.tool.toolId, entry.tool.toolKind)
  }

  return entries.map((entry) => {
    if (entry.kind === "tool_call") {
      const stripped = withoutDebugRaw(entry)
      return INLINE_TOOL_KINDS.has(stripped.tool.toolKind) ? stripped : trimToolCallEntry(stripped)
    }

    if (entry.kind === "tool_result") {
      // A streamed result can arrive in a later slice than its call.
      const toolKind = toolKinds.get(entry.toolId) ?? getToolKind?.(entry.toolId) ?? ""
      const structured = STRUCTURED_RESULT_TOOL_KINDS.has(toolKind)
        ? entry.structuredResult ?? readStructuredResult(entry.debugRaw)
        : undefined
      const stripped = withoutDebugRaw(entry)
      if (INLINE_TOOL_KINDS.has(toolKind)) {
        return structured === undefined ? stripped : { ...stripped, structuredResult: structured }
      }
      // An orphan result — no call in this transcript — is trimmed too: the
      // client only renders results attached to a call it saw.
      const { content, ...rest } = stripped
      return { ...rest, trimmed: true } as TranscriptEntry
    }

    return withoutDebugRaw(entry)
  })
}

/**
 * `tool_use_result` from a raw provider message. Only transcripts written
 * before `structuredResult` was persisted still need this; new tool results
 * carry the field directly and no `debugRaw` at all.
 */
export function readStructuredResult(debugRaw: string | undefined): unknown {
  if (debugRaw === undefined) return undefined
  try {
    return (JSON.parse(debugRaw) as { tool_use_result?: unknown }).tool_use_result
  } catch {
    // Corrupt debugRaw is not worth failing a transcript render over.
    return undefined
  }
}
