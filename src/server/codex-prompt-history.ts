import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import path from "node:path"
import { createHash, randomUUID } from "node:crypto"
import type { ChatAttachment, TranscriptEntry } from "../shared/types"
import { buildHandoffContext } from "./handoff"
export const LEGACY_KANNA_CHAT_LINK_NOTICE = [
  "<system-message>",
  "Kanna chat links:",
  "- When referring to another Kanna chat, use a Markdown link: [Chat title](/chat/<chatId>). Clicking it opens that chat in the current Kanna page.",
  "- Use the actual Kanna chat ID returned by Kanna tools or stored in Kanna data. For transcripts/<chatId>.jsonl, the filename without .jsonl is the chat ID. Do not substitute a provider session/thread ID or invent an ID.",
  "- Link to the chat route rather than its transcript file on disk. Keep using absolute-path Markdown links for workspace files.",
  "</system-message>",
].join("\n")

export interface CodexPromptBinding {
  sessionToken: string
  turnId: string
  mergeTurn: boolean
  /** The last local entry before this native turn started. Null means chat start. */
  boundaryEntryId?: string | null
}
export interface CodexNativeInput {
  turnId: string
  userIndex: number
  promptId?: string
  text: string
}
export interface CodexHistoryRecords {
  prompts: Record<string, CodexPromptBinding>
  turns: Record<string, { boundaryEntryId: string | null }>
  redeliveries?: Record<string, { sessionToken: string; boundaryEntryId: string | null }>
}
export interface CodexPromptRecovery {
  bindings: Record<string, CodexPromptBinding>
  gap?: { messageId: string; error: string }
}
const emptyRecords = (): CodexHistoryRecords => ({ prompts: {}, turns: {} })

/** Provenance is separate from transcript payloads, so an ordinary send never reads history. */
export class CodexPromptHistory {
  private readonly tails = new Map<string, Promise<void>>()
  constructor(
    private readonly dataDir: string,
    private readonly preparePromptCommit?: (chatId: string, binding: CodexPromptBinding, promptId: string) => () => Promise<void>,
  ) {}
  private file(chatId: string) {
    const key = createHash("sha256").update(chatId).digest("hex")
    return path.join(this.dataDir, "codex-prompt-history", `${key}.json`)
  }
  async read(chatId: string): Promise<CodexHistoryRecords> {
    await this.tails.get(chatId)
    try {
      const value = JSON.parse(await readFile(this.file(chatId), "utf8"))
      if (!value || value.v !== 1 || !value.prompts || !value.turns)
        throw new Error("Invalid Codex prompt history")
      return { prompts: value.prompts, turns: value.turns, ...(value.redeliveries ? { redeliveries: value.redeliveries } : {}) }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return emptyRecords()
      throw error
    }
  }
  private async update(
    chatId: string,
    change: (records: CodexHistoryRecords) => void,
  ) {
    const previous = this.tails.get(chatId) ?? Promise.resolve()
    const next = previous.then(async () => {
      let records = emptyRecords()
      try {
        records = JSON.parse(await readFile(this.file(chatId), "utf8"))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      }
      change(records)
      const file = this.file(chatId)
      await mkdir(path.dirname(file), { recursive: true })
      const temp = `${file}.${randomUUID()}.tmp`
      await writeFile(temp, JSON.stringify({ v: 1, ...records }), "utf8")
      await rename(temp, file)
    })
    this.tails.set(chatId, next)
    try {
      await next
    } finally {
      if (this.tails.get(chatId) === next) this.tails.delete(chatId)
    }
  }
  recordTurn(
    chatId: string,
    sessionToken: string,
    turnId: string,
    boundaryEntryId: string | null,
  ) {
    return this.update(chatId, (records) => {
      records.turns[`${sessionToken}:${turnId}`] = { boundaryEntryId }
    })
  }
  async recordPrompt(chatId: string, promptId: string, binding: CodexPromptBinding) {
    // Capture the caller's generation before asynchronous persistence, then
    // publish its checkpoint only after the binding has reached disk.
    const commit = this.preparePromptCommit?.(chatId, binding, promptId)
    await this.update(chatId, (records) => {
      records.prompts[promptId] = binding
    })
    await commit?.()
  }
  beginRedelivery(chatId: string, promptId: string, sessionToken: string, boundaryEntryId: string | null) {
    return this.update(chatId, records => {
      records.redeliveries ??= {}
      records.redeliveries[promptId] = { sessionToken, boundaryEntryId }
    })
  }
  finishRedelivery(chatId: string, promptId: string) {
    return this.update(chatId, records => { delete records.redeliveries?.[promptId] })
  }
  remember(chatId: string, bindings: Record<string, CodexPromptBinding>, replacePromptIds?: readonly string[]) {
    return this.update(chatId, (records) => {
      for (const id of replacePromptIds ?? []) delete records.prompts[id]
      Object.assign(records.prompts, bindings)
    })
  }
  rebindSession(chatId: string, sourceSessionToken: string, sessionToken: string) {
    return this.update(chatId, (records) => {
      for (const binding of Object.values(records.prompts))
        if (binding.sessionToken === sourceSessionToken) binding.sessionToken = sessionToken
      for (const [key, boundary] of Object.entries(records.turns))
        if (key.startsWith(`${sourceSessionToken}:`))
          records.turns[`${sessionToken}${key.slice(sourceSessionToken.length)}`] = boundary
    })
  }
}

/** Remove only the known steering wrapper, leaving arbitrary user XML intact. */
export function codexUserText(text: string) {
  const wrapper =
    "<system-message>\nThe user would like to inform you of something while you continue to work. Acknowledge receipt immediately with a text response, then continue with the task at hand, incorporating the user's feedback if needed.\n</system-message>"
  let result = text.trim()
  if (result.endsWith(`\n${LEGACY_KANNA_CHAT_LINK_NOTICE}`))
    result = result.slice(0, -LEGACY_KANNA_CHAT_LINK_NOTICE.length).trimEnd()
  if (result.startsWith(`${wrapper}\n`))
    result = result.slice(wrapper.length).trimStart()
  if (result.endsWith(`\n${wrapper}`))
    result = result.slice(0, -wrapper.length).trimEnd()
  return result
}

export function nativePromptMatches(
  text: string,
  prompt: Extract<TranscriptEntry, { kind: "user_prompt" }>,
  replayPreamble?: string,
) {
  if (text.trim() === prompt.content.trim()) return true
  let value = text.trim()
  value = value.replace(
    /\n\n<system-message>the user would like to use (?:the skill available at [^\n]+|the \/[^\s]+ skill)(?:\nthe user would like to use (?:the skill available at [^\n]+|the \/[^\s]+ skill))*<\/system-message>$/,
    "",
  )
  if (prompt.attachments?.length) {
    const escape = (value: string) =>
      value
        .replaceAll("&", "&amp;")
        .replaceAll('"', "&quot;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
    const hint = [
      "<kanna-attachments>",
      ...prompt.attachments.map(
        (a) =>
          `<attachment kind="${escape(a.kind)}" mime_type="${escape(a.mimeType)}" path="${escape(a.absolutePath)}" project_path="${escape(a.relativePath)}" size_bytes="${a.size}" display_name="${escape(a.displayName)}" />`,
      ),
      "</kanna-attachments>",
    ].join("\n")
    if (value.endsWith(hint)) value = value.slice(0, -hint.length).trimEnd()
  }
  if (replayPreamble) {
    const footer = "\n</handoff_transcript>\n</system-message>"
    // Only the first native input after a saved restoration/handoff marker
    // may contain this generated context. Compare the remaining prompt using
    // the same exact wire-notice rules; arbitrary user XML stays significant.
    if (value.startsWith(replayPreamble) && value.includes("\n<handoff_transcript>\n")) {
      const end = value.indexOf(footer, replayPreamble.length)
      if (end >= 0 && value.indexOf(footer, end + footer.length) < 0
        && nativePromptMatches(value.slice(end + footer.length), prompt)) return true
    } else if (prompt.content.trimStart().startsWith("/") && value.endsWith(footer)) {
      const start = value.lastIndexOf("\n\n" + replayPreamble)
      if (start >= 0 && value.indexOf(footer) === value.length - footer.length
        && nativePromptMatches(value.slice(0, start), prompt)) return true
    }
  }
  const concurrency =
    "<system-message>there are other agents working in the current directory. Don't overwrite their work if builds fail, don't fix broken tests (as they may be stale while the other agent works) and expect changes between reads.\n\nActive chats & their transcripts can be found here:\n"
  const concurrentIndex = value.lastIndexOf("\n\n" + concurrency)
  if (concurrentIndex >= 0 && value.endsWith("\n</system-message>"))
    value = value.slice(0, concurrentIndex)
  return (
    codexUserText(value) ===
    codexUserText(prompt.content)
  )
}

function legacyReplayPreamble(entries: TranscriptEntry[]) {
  const first = entries.findIndex((entry) => entry.kind === "user_prompt" && !entry.hidden && !entry.parentToolUseId)
  if (first < 0) return undefined
  const marker = entries.slice(0, first).reverse().find((entry) => ["session_restored", "handoff_boundary", "context_cleared"].includes(entry.kind))
  if (marker?.kind === "session_restored") {
    if (marker.provider !== "codex") return undefined
  } else if (marker?.kind === "handoff_boundary") {
    if (marker.toProvider !== "codex") return undefined
  } else return undefined
  const context = buildHandoffContext({ entries: [entries[first]!],
    fromProvider: marker.kind === "session_restored" ? marker.provider : marker.fromProvider,
    toProvider: "codex", reason: marker.kind === "session_restored" ? "session_restore" : "provider_switch" })
  return context ? context.text.split("\n\nSome older tool inputs/results")[0] + "\n\n" : undefined
}

/** Full ordered alignment, with client IDs taking precedence over text. */
export function reconcileCodexPrompts(
  entries: TranscriptEntry[],
  sessionToken: string,
  inputs: CodexNativeInput[],
  known: Record<string, CodexPromptBinding> = {},
  knownTurns: CodexHistoryRecords["turns"] = {},
  reservedPromptIds?: ReadonlySet<string>,
  absentPromptIds?: ReadonlySet<string>,
) {
  const prompts = entries.filter(
    (entry): entry is Extract<TranscriptEntry, { kind: "user_prompt" }> =>
      entry.kind === "user_prompt" && !entry.hidden && !entry.parentToolUseId && !absentPromptIds?.has(entry._id),
  )
  const replayPreamble = legacyReplayPreamble(entries)
  const candidates = prompts.map((prompt, promptIndex) => {
    const ids = inputs.flatMap((input, index) =>
      input.promptId === prompt._id ? [index] : [],
    )
    if (ids.length) return ids
    const anchor = known[prompt._id]
    const localIds = reservedPromptIds ?? new Set(prompts.map((entry) => entry._id))
    return inputs.flatMap((input, index) =>
      (!input.promptId || !localIds.has(input.promptId)) &&
      nativePromptMatches(input.text, prompt, promptIndex === 0 && input.userIndex === 0 ? replayPreamble : undefined) &&
      (!anchor ||
        anchor.sessionToken !== sessionToken ||
        anchor.turnId === input.turnId)
        ? [index]
        : [],
    )
  })
  const earliest: number[] = []
  let previous = -1
  for (const options of candidates) {
    const value = options.find((index) => index > previous)
    if (value === undefined)
      throw new Error(
        "Cannot recover Codex prompt boundary: native history does not contain the complete visible sequence",
      )
    earliest.push(value)
    previous = value
  }
  const latest: number[] = new Array(prompts.length)
  previous = inputs.length
  for (let i = prompts.length - 1; i >= 0; i--) {
    const value = candidates[i]!.slice()
      .reverse()
      .find((index) => index < previous)
    if (value === undefined)
      throw new Error(
        "Cannot recover Codex prompt boundary: inconsistent native sequence",
      )
    latest[i] = value
    previous = value
  }
  if (earliest.some((value, index) => value !== latest[index]))
    throw new Error(
      "Cannot recover Codex prompt boundary: ambiguous native sequence",
    )
  const result: Record<string, CodexPromptBinding> = {}
  for (let i = 0; i < prompts.length; i++) {
    const input = inputs[earliest[i]!]!
    const old = known[prompts[i]!._id]
    result[prompts[i]!._id] = {
      sessionToken,
      turnId: input.turnId,
      mergeTurn: input.userIndex > 0,
      ...(old?.sessionToken === sessionToken &&
      old.turnId === input.turnId &&
      old.boundaryEntryId !== undefined
        ? { boundaryEntryId: old.boundaryEntryId }
        : {}),
    }
  }
  const firstByTurn = new Map<string, (typeof prompts)[number]>()
  for (const prompt of prompts) {
    const binding = result[prompt._id]!
    const first = firstByTurn.get(binding.turnId)
    if (first) {
      binding.boundaryEntryId = result[first._id]!.boundaryEntryId
      continue
    }
    firstByTurn.set(binding.turnId, prompt)
    const savedTurn = knownTurns[`${sessionToken}:${binding.turnId}`]
    if (savedTurn) binding.boundaryEntryId = savedTurn.boundaryEntryId
    if (binding.boundaryEntryId !== undefined) continue
    const index = entries.findIndex((entry) => entry._id === prompt._id)
    let start = index
    if (binding.mergeTurn) {
      let found = false
      for (let j = index - 1; j >= 0; j--) {
        const entry = entries[j]!
        if (
          entry.kind === "user_prompt" &&
          !entry.hidden &&
          !entry.parentToolUseId
        )
          break
        if (
          entry.kind === "system_init" &&
          entry.provider === "codex" &&
          !entry.parentToolUseId
        ) {
          start = j
          found = true
          break
        }
      }
      if (!found)
        throw new Error(
          "Cannot recover Codex prompt boundary: hidden turn start is missing from local history",
        )
    }
    binding.boundaryEntryId = entries[start - 1]?._id ?? null
  }
  return result
}

/** Recover a consecutive prefix. A later ID never authorizes skipping a gap. */
export function recoverCodexPromptPrefix(
  entries: TranscriptEntry[],
  sessionToken: string,
  inputs: CodexNativeInput[],
  known: Record<string, CodexPromptBinding> = {},
  knownTurns: CodexHistoryRecords["turns"] = {},
): CodexPromptRecovery {
  const prompts = entries.filter((entry): entry is Extract<TranscriptEntry, { kind: "user_prompt" }> =>
    entry.kind === "user_prompt" && !entry.hidden && !entry.parentToolUseId)
  const localIds = new Set(prompts.map((entry) => entry._id))
  const replayPreamble = legacyReplayPreamble(entries)
  let previous = -1, count = 0
  // Determine the longest possible ordered prefix before checking uniqueness.
  // Looking at the whole feasible prefix also preserves old repeated-text
  // histories whose order makes their alignment unambiguous.
  for (const prompt of prompts) {
    const ids = inputs.flatMap((input, index) => input.promptId === prompt._id ? [index] : [])
    const anchor = known[prompt._id]
    const candidates = ids.length ? ids : inputs.flatMap((input, index) =>
      (!input.promptId || !localIds.has(input.promptId)) && nativePromptMatches(input.text, prompt,
        count === 0 && input.userIndex === 0 ? replayPreamble : undefined)
      && (!anchor || anchor.sessionToken !== sessionToken || anchor.turnId === input.turnId) ? [index] : [])
    const next = candidates.find((index) => index > previous)
    if (next === undefined) break
    previous = next
    count++
  }
  let bindings: Record<string, CodexPromptBinding> = {}
  while (count > 0) {
    try {
      bindings = reconcileCodexPrompts(entries.slice(0, entries.indexOf(prompts[count - 1]!) + 1),
        sessionToken, inputs, known, knownTurns, localIds)
      break
    } catch { count-- }
  }
  const missing = prompts[count]
  if (!missing) return { bindings }
  let error = "Cannot recover Codex prompt boundary: native history does not contain the complete visible sequence"
  try {
    reconcileCodexPrompts(entries.slice(0, entries.indexOf(missing) + 1), sessionToken, inputs, known, knownTurns, localIds)
  } catch (cause) { error = cause instanceof Error ? cause.message : String(cause) }
  return { bindings, gap: { messageId: missing._id, error } }
}

/** Classify local inputs without changing transcript payloads. Later matches
 * never authorize crossing a gap; uncertain identity is not proof of absence. */
export function classifyCodexPromptHistory(
  entries: TranscriptEntry[], sessionToken: string, inputs: CodexNativeInput[],
  known: Record<string, CodexPromptBinding> = {},
  knownTurns: CodexHistoryRecords["turns"] = {},
): CodexPromptRecovery & { messages: Record<string, "missing" | "unknown"> } {
  const prompts = entries.filter((entry): entry is Extract<TranscriptEntry, { kind: "user_prompt" }> =>
    entry.kind === "user_prompt" && !entry.hidden && !entry.parentToolUseId)
  const ids = new Set(prompts.map(prompt => prompt._id))
  const nativeTurns = new Set(inputs.map(input => input.turnId))
  known = Object.fromEntries(Object.entries(known).filter(([, binding]) => binding.sessionToken !== sessionToken || nativeTurns.has(binding.turnId)))
  const nativeIds = new Set<string>(), turnPositions = new Map<string, number>()
  for (const input of inputs) {
    if (!input.turnId || !Number.isInteger(input.userIndex) || input.userIndex < 0
      || (turnPositions.get(input.turnId) ?? -1) >= input.userIndex
      || (input.promptId && nativeIds.has(input.promptId)))
      throw new Error("Invalid Codex input history; no message absence can be established")
    turnPositions.set(input.turnId, input.userIndex)
    if (input.promptId) nativeIds.add(input.promptId)
  }
  const preamble = legacyReplayPreamble(entries)
  const candidates = prompts.map((prompt, i) => {
    const exact = inputs.flatMap((input, j) => input.promptId === prompt._id ? [j] : [])
    if (exact.length) return new Set(exact)
    const anchor = known[prompt._id]
    return new Set(inputs.flatMap((input, j) =>
      (!input.promptId || !ids.has(input.promptId))
      && (!anchor || anchor.sessionToken !== sessionToken || (anchor.turnId === input.turnId && anchor.mergeTurn === (input.userIndex > 0)))
      && nativePromptMatches(input.text, prompt, i === 0 && input.userIndex === 0 ? preamble : undefined) ? [j] : []))
  })
  // A previously saved unique turn is stronger evidence than another
  // message's identical text. Reserve that input before resolving ambiguity.
  const owners = new Map<number, number[]>()
  candidates.forEach((options, i) => {
    const anchor = known[prompts[i]!._id]
    if (anchor?.sessionToken !== sessionToken || options.size !== 1) return
    const j = [...options][0]!
    owners.set(j, [...(owners.get(j) ?? []), i])
  })
  for (const [j, own] of owners) if (own.length === 1)
    candidates.forEach((options, i) => { if (i !== own[0]) options.delete(j) })
  // Maximum ordered alignment with gaps. A prompt is confirmed only when
  // every optimal alignment assigns it the same input and none skips it.
  const n = prompts.length, m = inputs.length
  const left = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
  const right = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
  for (let i = 0; i < n; i++) for (let j = 0; j < m; j++)
    left[i + 1]![j + 1] = Math.max(left[i]![j + 1]!, left[i + 1]![j]!,
      candidates[i]!.has(j) ? left[i]![j]! + 1 : 0)
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--)
    right[i]![j] = Math.max(right[i + 1]![j]!, right[i]![j + 1]!,
      candidates[i]!.has(j) ? right[i + 1]![j + 1]! + 1 : 0)
  const total = left[n]![m]!, messages: Record<string, "missing" | "unknown"> = {}
  const usable: typeof prompts = []
  let prefix = true
  for (let i = 0; i < n; i++) {
    const possible = [...candidates[i]!].filter(j => left[i]![j]! + 1 + right[i + 1]![j + 1]! === total)
    let skippable = false
    for (let j = 0; j <= m; j++) if (left[i]![j]! + right[i + 1]![j]! === total) { skippable = true; break }
    const confirmed = possible.length === 1 && !skippable
    if (!candidates[i]!.size) messages[prompts[i]!._id] = "missing"
    else if (!confirmed) messages[prompts[i]!._id] = "unknown"
    if (prefix && confirmed) usable.push(prompts[i]!)
    // Proven absence does not invalidate a later native identity. Ambiguity
    // still stops sequential recovery because its position is unknown.
    else if (messages[prompts[i]!._id] !== "missing") prefix = false
  }
  let bindings: Record<string, CodexPromptBinding> = {}
  while (usable.length > 0) {
    try {
      const confirmedEntries = entries.slice(0, entries.indexOf(usable.at(-1)!) + 1)
      bindings = reconcileCodexPrompts(confirmedEntries,
        sessionToken, inputs, known, knownTurns, ids,
        new Set(Object.keys(messages).filter(id => messages[id] === "missing")))
      break
    } catch { messages[usable.pop()!._id] = "unknown" }
  }
  const gapPrompt = prompts.find(prompt => !bindings[prompt._id])
  if (!gapPrompt) return { bindings, messages }
  if (!messages[gapPrompt._id]) messages[gapPrompt._id] = "unknown"
  return { bindings, messages, gap: { messageId: gapPrompt._id, error:
    messages[gapPrompt._id] === "missing"
      ? "Cannot recover Codex prompt boundary: native history does not contain this message. Edit and resend the first unsynchronized message."
      : "Cannot recover Codex prompt boundary: ambiguous native sequence or turn boundary. Edit and resend the first unresolved message." } }
}

/** Explicitly replay only the first gap; this does not invent its provenance. */
export function planCodexGapReplay(
  entries: TranscriptEntry[],
  targetId: string,
  sessionToken: string,
  recovered: CodexPromptRecovery,
  replacement?: string,
  freshPrefixEnd?: number,
) {
  if (recovered.gap?.messageId !== targetId)
    throw new Error("Only the first unresolved Codex message can be replayed")
  const targetIndex = entries.findIndex((entry) => entry._id === targetId)
  const target = entries[targetIndex]
  if (!target || target.kind !== "user_prompt") throw new Error("User message not found")
  let segmentStart = 0
  for (let i = 0; i < targetIndex; i++)
    if (["handoff_boundary", "session_restored", "context_cleared"].includes(entries[i]!.kind)) segmentStart = i + 1
  const previous = entries.slice(segmentStart, targetIndex).reverse().find((entry) =>
    entry.kind === "user_prompt" && !entry.hidden && !entry.parentToolUseId
    && recovered.bindings[entry._id]?.sessionToken === sessionToken)
  const confirmedFreshPrefix = freshPrefixEnd !== undefined && freshPrefixEnd >= 0
    && freshPrefixEnd <= targetIndex && !entries.slice(freshPrefixEnd, targetIndex).some((entry) =>
      entry.kind === "user_prompt" && !entry.hidden && !entry.parentToolUseId)
  if (!previous && !confirmedFreshPrefix && entries.slice(0, targetIndex).some((entry) =>
    entry.kind === "user_prompt" && !entry.hidden && !entry.parentToolUseId))
    throw new Error("Cannot replay Codex message: the preceding native context boundary is unconfirmed")
  if (target.steered && previous) {
    const binding = recovered.bindings[previous._id]!
    if (entries.slice(entries.indexOf(previous) + 1, targetIndex).some((entry) =>
      entry.kind === "system_init" && entry.provider === "codex" && !entry.parentToolUseId))
      throw new Error("Cannot replay Codex message: the intervening hidden turn boundary is unconfirmed")
    const plan = planCodexPromptHistory(entries, targetId, {
      ...recovered.bindings, [targetId]: { ...binding, mergeTurn: true },
    }, replacement)
    return { ...plan, afterTurnId: undefined as string | undefined }
  }
  if (target.steered && !previous)
    throw new Error("Cannot replay Codex message: the steering turn start is unconfirmed")
  return {
    sessionToken, prefix: entries.slice(0, targetIndex),
    content: target.steered ? codexUserText(replacement ?? target.content) : replacement ?? target.content,
    attachments: target.attachments ?? [], merged: false,
    beforeTurnId: undefined as string | undefined,
    afterTurnId: previous ? recovered.bindings[previous._id]!.turnId : undefined,
  }
}

export function planCodexPromptHistory(
  entries: TranscriptEntry[],
  targetId: string,
  bindings: Record<string, CodexPromptBinding>,
  replacement?: string,
) {
  const targetIndex = entries.findIndex((entry) => entry._id === targetId)
  const target = entries[targetIndex]
  if (!target || target.kind !== "user_prompt")
    throw new Error("User message not found")
  const binding = bindings[targetId]
  if (!binding)
    throw new Error(
      "Cannot determine Codex prompt boundary: missing native provenance",
    )
  const included = entries
    .slice(0, targetIndex + 1)
    .filter(
      (entry): entry is Extract<TranscriptEntry, { kind: "user_prompt" }> =>
        entry.kind === "user_prompt" &&
        !entry.hidden &&
        bindings[entry._id]?.sessionToken === binding.sessionToken &&
        bindings[entry._id]?.turnId === binding.turnId,
    )
  const first = included[0]
  if (!first)
    throw new Error(
      "Cannot determine Codex prompt boundary: missing turn start",
    )
  let start = entries.findIndex((entry) => entry._id === first._id)
  if (binding.boundaryEntryId !== undefined) {
    start =
      binding.boundaryEntryId === null
        ? 0
        : entries.findIndex((entry) => entry._id === binding.boundaryEntryId) +
          1
    if (binding.boundaryEntryId !== null && start === 0)
      throw new Error(
        "Cannot determine Codex prompt boundary: local turn start is missing",
      )
  }
  if (start > targetIndex)
    throw new Error(
      "Cannot determine Codex prompt boundary: invalid local turn start",
    )
  const merged = binding.mergeTurn || included.length > 1
  const visibleContent = (entry: typeof target, text: string) =>
    entry.steered ? codexUserText(text) : text
  const content = merged
    ? included
        .map((entry) =>
          visibleContent(
            entry,
            entry._id === targetId && replacement !== undefined
              ? replacement
              : entry.content,
          ),
        )
        .join("\n")
    : visibleContent(target, replacement ?? target.content)
  const attachments: ChatAttachment[] = []
  const ids = new Set<string>()
  for (const entry of included)
    for (const attachment of entry.attachments ?? [])
      if (!ids.has(attachment.id)) {
        ids.add(attachment.id)
        attachments.push(attachment)
      }
  return {
    beforeTurnId: binding.turnId,
    sessionToken: binding.sessionToken,
    prefix: entries.slice(0, start),
    content,
    attachments,
    merged,
  }
}
