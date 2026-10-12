import { toMessagePreview } from "./message-preview"
import { getUserMessageDisplayText } from "./user-message-content"
import type { TranscriptEntry, TranscriptOutlineEntry } from "./types"

/**
 * How much of a transcript a client holds at once.
 *
 * Opening a long chat used to mount every row. The cost of that scales
 * with rows (layout, paint, DOM size, the teardown on leave), and an
 * 800-row chat took over a second on the main thread before it drew. So a
 * client now opens on a window counted in assistant messages, and loads
 * older windows on request.
 *
 * Counted in assistant messages rather than bytes or entries because rows
 * follow them: each assistant text is a row, and the tool calls between two
 * of them collapse into one group row. "50 assistant messages" is close to
 * the same number of rows every time; 100 KB was 20 rows of prose or 100
 * rows of tool headers. Cutting right before an assistant message also
 * never splits a tool group, since a group ends where the next assistant
 * text begins.
 *
 * Shared between server (which sizes the window it sends) and client (which
 * trims its own cached window to the same size before it paints).
 */

export const DEFAULT_TRANSCRIPT_WINDOW_ASSISTANT_MESSAGES = 50
export const MIN_TRANSCRIPT_WINDOW_ASSISTANT_MESSAGES = 5
export const MAX_TRANSCRIPT_WINDOW_ASSISTANT_MESSAGES = 1000

/**
 * A window never exceeds this many header bytes, whatever the message
 * count says. A guard against one stretch of huge tool groups, not a
 * target; it almost never binds.
 */
export const MAX_TRANSCRIPT_WINDOW_BYTES = 512 * 1024

/** Preview length on an outline entry; the sidebar uses the same cut. */
const OUTLINE_PREVIEW_MAX_LENGTH = 160

function isToolEntry(entry: TranscriptEntry) {
  return entry.kind === "tool_call" || entry.kind === "tool_result"
}

/**
 * Pull a cut back to the start of the row it lands in.
 *
 * A cut inside a run of tool entries would show half a group; a cut right
 * after a user prompt would open the window on a reply with its question
 * one load away. Both move back one step at a time until the entry before
 * the cut belongs to a different row.
 */
export function snapToRowStart(entries: readonly TranscriptEntry[], start: number): number {
  let cut = Math.max(0, Math.min(start, entries.length))
  while (cut > 0) {
    const previous = entries[cut - 1]!
    const current = entries[cut]
    // A subagent's entries render inside the Agent row that spawned them,
    // so a cut among them would open the window on children with no parent.
    if (current?.parentToolUseId) {
      cut -= 1
      continue
    }
    if (current && isToolEntry(previous) && isToolEntry(current)) {
      cut -= 1
      continue
    }
    if (previous.kind === "user_prompt") {
      cut -= 1
      continue
    }
    break
  }
  return cut
}

export interface TranscriptWindowOptions {
  /** The window ends here (exclusive); the transcript length on a first open. */
  endExclusive: number
  /** How many assistant messages the window should hold. */
  assistantMessages: number
  /** An entry the window must reach, whatever the count says (a read anchor, a jump target). */
  mustIncludeIndex?: number
  /** Header-bytes ceiling. Defaults to `MAX_TRANSCRIPT_WINDOW_BYTES`. */
  byteCap?: number
  /** Header bytes of an entry. Defaults to its JSON length. */
  measure?: (entry: TranscriptEntry) => number
}

/**
 * The absolute index a window should start at, walking back from
 * `endExclusive` until it holds `assistantMessages` assistant texts, then
 * snapping to a row start. Returns 0 when the transcript runs out first.
 */
export function findTranscriptWindowStart(entries: readonly TranscriptEntry[], options: TranscriptWindowOptions): number {
  const end = Math.max(0, Math.min(options.endExclusive, entries.length))
  const wanted = Math.max(1, Math.floor(options.assistantMessages))
  const byteCap = options.byteCap ?? MAX_TRANSCRIPT_WINDOW_BYTES
  const measure = options.measure ?? ((entry: TranscriptEntry) => JSON.stringify(entry).length)

  let start = 0
  let seen = 0
  let bytes = 0
  // Where the last counted assistant message sits; the byte cap falls back
  // to it so a cap never lands mid-row.
  let lastAssistantIndex = end
  for (let index = end - 1; index >= 0; index -= 1) {
    const entry = entries[index]!
    bytes += measure(entry)
    // Subagent text is not a row of its own (it folds under its Agent row),
    // so it does not count toward the window.
    if (entry.kind === "assistant_text" && !entry.parentToolUseId) {
      seen += 1
      lastAssistantIndex = index
      if (seen >= wanted) {
        start = index
        break
      }
    }
    if (bytes > byteCap && seen > 0) {
      start = lastAssistantIndex
      break
    }
  }

  if (options.mustIncludeIndex !== undefined && options.mustIncludeIndex >= 0 && options.mustIncludeIndex < start) {
    start = options.mustIncludeIndex
  }
  return snapToRowStart(entries, start)
}

/**
 * One line per user prompt for the whole transcript, so the minimap and
 * jump targets know every turn even when most rows are not loaded. A few
 * hundred bytes per turn; a chat's worth is a few KB.
 */
export function buildTranscriptOutline(entries: readonly TranscriptEntry[]): TranscriptOutlineEntry[] {
  const outline: TranscriptOutlineEntry[] = []
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!
    if (entry.kind !== "user_prompt" || entry.hidden) continue
    const preview = toMessagePreview(getUserMessageDisplayText(entry.content))
    outline.push({
      id: entry._id,
      index,
      preview: preview.length > OUTLINE_PREVIEW_MAX_LENGTH ? `${preview.slice(0, OUTLINE_PREVIEW_MAX_LENGTH)}…` : preview,
      createdAt: entry.createdAt,
    })
  }
  return outline
}

/**
 * Cut a held window (a client's cache, say) down to the size a fresh open
 * would get, so a chat cached whole does not paint whole.
 */
export function trimTranscriptWindow<T extends { messages: TranscriptEntry[]; startIndex: number }>(
  window: T,
  assistantMessages: number
): T {
  const start = findTranscriptWindowStart(window.messages, {
    endExclusive: window.messages.length,
    assistantMessages,
  })
  if (start === 0) return window
  return { ...window, messages: window.messages.slice(start), startIndex: window.startIndex + start }
}
